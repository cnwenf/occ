import { feature } from 'src/utils/featureFlags.js'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { getGlobalConfig, isConfigReadingAllowed } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  type AutoCompactWindowOverride,
  wrapAutoCompactWindowCeiling,
} from '../../utils/autoCompactWindow.js'
import {
  type AgentDefinition,
  type BuiltInAgentDefinition,
  isBuiltInAgent,
} from './loadAgentsDir.js'

/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type` becomes optional on the Agent tool schema
 * - Omitting `subagent_type` triggers an implicit fork: the child inherits
 *   the parent's full conversation context and system prompt
 * - Main-conversation subagents are forced into the background on
 *   terminal-class surfaces (see isSubagentsForcedBackground); in plain
 *   `-p`/SDK with default-on fork the model may still choose via
 *   `run_in_background` and nested Agent calls default to the foreground
 * - `/fork <directive>` slash command is available
 *
 * Mutually exclusive with coordinator mode — coordinator already owns the
 * orchestration role and has its own delegation model.
 */

/**
 * Where the fork-gate decision came from — mirrors the official v302 `qcn`
 * source union ('disabled' | 'env' | 'default').
 */
export type ForkSubagentSource = 'disabled' | 'env' | 'default'

/**
 * Legal runtime values for the config `forkSubagentEnabledSource` override —
 * same union as ForkSubagentSource. Used by the OCC-hardening runtime enum
 * validation in getForkSubagentSource() step 4 (official v302 has no such
 * check — see the divergence note below).
 */
const FORK_SUBAGENT_SOURCES: readonly ForkSubagentSource[] = [
  'disabled',
  'env',
  'default',
]

/**
 * CC 2.1.302 (#31): source-aware fork-gate resolver — port of the official
 * v302 `qcn` (byte-verified; see docs/gap-research-302/triage-T2.md §#31):
 *
 *   function qcn(){let e=Ro();
 *     if(Q3e())return"disabled";                                   // coordinator / mcp-serve
 *     if(Hf().forkSubagentDisabled)return"disabled";               // config kill flag
 *     if(a.CLAUDE_CODE_FORK_SUBAGENT===!1)return"disabled";        // env=0 → off
 *     if(e.forkSubagentEnabledSource!==void 0)return e.forkSubagentEnabledSource;
 *     if(a.CLAUDE_CODE_FORK_SUBAGENT!==!0&&we()&&ir(Qcr,!1))return"disabled";  // remote kill-switch
 *     let n=a.CLAUDE_CODE_FORK_SUBAGENT===!0?"env":"default";      // non-interactive now DEFAULTS ON
 *     return e.forkSubagentEnabledSource=n,...,n}
 *
 * The v301 `if(we())return"disabled"` (non-interactive ⇒ off) is GONE:
 * `claude -p` / Agent SDK now default ON, same as the terminal.
 *
 * Documented OCC divergences:
 * - Remote kill-switch (`tengu_federated_ullman` via GrowthBook `ir(Qcr,!1)`):
 *   N/A — OCC's GrowthBook is an empty stub returning false. The official
 *   default with the kill-switch OFF is enabled, so skipping the check is
 *   byte-equivalent in default behavior.
 * - Base gate: OCC keeps the FORK_SUBAGENT feature-flag term
 *   (`env truthy || feature('FORK_SUBAGENT')`). FORK_SUBAGENT is NOT in
 *   FEATURE_ALLOWLIST, so in live builds fork is reachable only via the env
 *   var — the official v302 has no flag term and defaults ON unconditionally.
 * - `forkSubagentEnabledSource` write-back cache: the official stores the
 *   computed source back into config; OCC honors an explicitly-set config
 *   value only and computes fresh on every call (no config mutation).
 * - Env parsing follows OCC's isEnvTruthy/isEnvDefinedFalsy convention
 *   (official bool-parses the env then compares ===!0 / ===!1): '0'/'false'
 *   ⇒ disabled, unset (or unparseable) ⇒ fall through to the base gate.
 * - OCC HARDENING (beyond official — NOT an alignment fix): the stored
 *   `forkSubagentEnabledSource` is runtime-validated against the
 *   FORK_SUBAGENT_SOURCES enum set before it is honored. Official v302
 *   returns the stored value verbatim with no runtime check; OCC ignores an
 *   illegal value (corrupt or hand-edited config), logs a debug warning, and
 *   falls through to the documented default base-gate resolution below.
 *
 * Precedence (official qcn order):
 *   1. coordinator session                     → 'disabled'
 *   2. config forkSubagentDisabled             → 'disabled'
 *   3. env CLAUDE_CODE_FORK_SUBAGENT=0/false   → 'disabled'
 *   4. config forkSubagentEnabledSource (set + legal enum) → that source
 *      verbatim; illegal value → OCC-hardening fall-through to step 6
 *   5. [remote kill-switch — N/A in OCC]
 *   6. env truthy → 'env'; else feature flag → 'default'; else 'disabled'
 *
 * `claude mcp serve` never offers fork: OCC's mcp entrypoint registers only
 * the /review command (src/entrypoints/mcp.ts MCP_COMMANDS), so the Agent
 * tool — and with it the fork path — is unreachable from mcp serve.
 */
export function getForkSubagentSource(): ForkSubagentSource {
  // 1. Coordinator never offers fork (official Q3e()).
  if (isCoordinatorMode()) return 'disabled'
  // OCC-specific config-availability guard (no official analogue — upstream
  // config is always readable). This resolver is reachable at MODULE-EVAL
  // time: buildTool()'s object spread invokes AgentTool's `get inputSchema()`
  // getter, whose effort-describe (AgentTool.tsx:99) calls
  // isForkSubagentEnabled() while tool modules initialize — and the `-p` path
  // evaluates that graph before enableConfigs() runs, where getGlobalConfig()
  // throws "Config accessed before allowed" (crashed every -p run when #31
  // landed). In the pre-enable window the config terms (2/4) are treated as
  // unset — env/coordinator/flag terms still decide, matching the pre-302
  // module-eval behavior; once configs are enabled the official precedence
  // below applies verbatim.
  const config = isConfigReadingAllowed() ? getGlobalConfig() : undefined
  // 2. Config kill flag (official Hf().forkSubagentDisabled) — beats env=1.
  if (config?.forkSubagentDisabled) return 'disabled'
  // 3. CLAUDE_CODE_FORK_SUBAGENT=0 turns fork off (official env===!1).
  const envVar = process.env.CLAUDE_CODE_FORK_SUBAGENT
  if (isEnvDefinedFalsy(envVar)) return 'disabled'
  // 4. Explicit config source override honored verbatim (official
  //    e.forkSubagentEnabledSource!==void 0).
  //    OCC HARDENING beyond official v302 (official returns the stored value
  //    verbatim with NO runtime check): validate the stored value against
  //    the ForkSubagentSource enum set first. An illegal value (corrupt or
  //    hand-edited config) is ignored — debug-logged here and resolution
  //    falls through to the documented default base gate (step 6) — so an
  //    illegal string can never surface as the fork-gate source.
  if (config?.forkSubagentEnabledSource !== undefined) {
    if (FORK_SUBAGENT_SOURCES.includes(config.forkSubagentEnabledSource)) {
      return config.forkSubagentEnabledSource
    }
    logForDebugging(
      `Ignoring invalid config forkSubagentEnabledSource ${JSON.stringify(
        config.forkSubagentEnabledSource,
      )} — not one of ${FORK_SUBAGENT_SOURCES.join(
        ' | ',
      )}; falling back to default fork-gate resolution`,
      { level: 'warn' },
    )
  }
  // 5. Remote kill-switch — N/A in OCC (GrowthBook stubbed; official default
  //    with the kill-switch OFF is enabled).
  // 6. Base gate: env truthy ⇒ 'env'; else FORK_SUBAGENT flag ⇒ 'default'.
  if (isEnvTruthy(envVar)) return 'env'
  if (feature('FORK_SUBAGENT')) return 'default'
  return 'disabled'
}

/** Fork enabled — official `mse()` = `qcn()!=="disabled"`. */
export function isForkSubagentEnabled(): boolean {
  return getForkSubagentSource() !== 'disabled'
}

/**
 * CC 2.1.302 (#32): forced-background predicate — port of the official v302
 * `vat()` (byte-verified):
 *
 *   function vat(){if(!mse())return!1;return qcn()==="env"||!uL()}
 *
 * where `uL(e=we())` is the non-interactive-surface check EXCLUDING
 * vscode-child sessions. OCC has no vscode-child surface, so `uL` maps
 * directly to getIsNonInteractiveSession() (documented divergence).
 *
 * TRUE ⇒ the Agent tool omits `run_in_background` and every main-conversation
 * subagent is forced async (terminal parity; also anywhere with
 * CLAUDE_CODE_FORK_SUBAGENT=1). FALSE with the gate enabled (plain `-p`/SDK
 * default-on) ⇒ the param stays offered and a subagent's own Agent calls run
 * in the foreground by default.
 *
 * Consumed by AgentTool.tsx's schema-omit gate (official `lgt()||vat()`) and
 * by call()'s forceAsync.
 */
export function isSubagentsForcedBackground(): boolean {
  const source = getForkSubagentSource()
  if (source === 'disabled') return false
  return source === 'env' || !getIsNonInteractiveSession()
}

/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — used only when `!subagent_type` and the
 * experiment is active. `tools: ['*']` with `useExactTools` means the fork
 * child receives the parent's exact tool pool (for cache-identical API
 * prefixes). `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * 2.1.296 PORT #002: per-subagent auto-compact window wiring at spawn time.
 *
 * Official spawn site (byte-verified @223555765):
 *   `autoCompactWindow: e.agentType===Q$&&Xa(e)
 *      ? n.options.autoCompactWindow
 *      : WJn(n.options.autoCompactWindow, e.autoCompactWindow)`
 * with `Q$="fork"` (@211657790) and `Xa=isBuiltInAgent` (resolved via the
 * chunk export alias block @243898894 `Xa as isBuiltInAgent`), `n` = parent
 * toolUseContext, `e` = the spawned agent definition, `WJn` =
 * wrapAutoCompactWindowCeiling.
 *
 * Semantics: the built-in fork agent copies the parent conversation (and the
 * parent's compaction state), so it inherits the parent's override UNWRAPPED
 * — a ceiling applied to a fork would compact the copied context earlier
 * than the parent's own window. Every other agent wraps its own
 * `autoCompactWindow` (if any) as a ceiling around the inherited override.
 */
export function computeSubagentAutoCompactWindow(
  agentDefinition: AgentDefinition,
  inherited: AutoCompactWindowOverride,
): AutoCompactWindowOverride {
  if (
    agentDefinition.agentType === FORK_SUBAGENT_TYPE &&
    isBuiltInAgent(agentDefinition)
  ) {
    return inherited
  }
  return wrapAutoCompactWindowCeiling(
    inherited,
    agentDefinition.autoCompactWindow,
  )
}

/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // Clone the assistant message to avoid mutating the original, keeping all
  // content blocks (thinking, text, and every tool_use)
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...(Array.isArray(assistantMessage.message.content) ? assistantMessage.message.content : [])],
    },
  }

  // Collect all tool_use blocks from the assistant message
  const toolUseBlocks = (Array.isArray(assistantMessage.message.content) ? assistantMessage.message.content : []).filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // Build a single user message: all placeholder tool_results + the per-child directive
  // TODO(smoosh): this text sibling creates a [tool_result, text] pattern on the wire
  // (renders as </function_results>\n\nHuman:<text>). One-off per-child construction,
  // not a repeated teacher, so low-priority. If we ever care, use smooshIntoToolResult
  // from src/utils/messages.ts to fold the directive into the last tool_result.content.
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
