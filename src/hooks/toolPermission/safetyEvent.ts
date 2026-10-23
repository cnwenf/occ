/**
 * CC 2.1.307 A2 — the OTel `claude_code.safety_event` emitter.
 *
 * Official changelog: "Added the claude_code.safety_event OpenTelemetry event
 * for each tool call a permission rule, auto mode, a safety check, a hook or
 * the sandbox stopped, prompted or sent back".
 *
 * EVERY constant and control-flow branch below was strings-recovered verbatim
 * from the official v307 linux-x64 ELF (/tmp/cc-diff-308/v307/package/claude —
 * never executed; `grep -aboF` offsets into /tmp/cc-diff-308/new307.txt +
 * bounded `dd`). Official symbol → OCC name map:
 *
 *   TYr (@36238906 region)  → SAFETY_CATEGORIES (category priority order)
 *   EYr                     → SAFETY_DECISION_SOURCES
 *   _Yr (@36238161 region)  → SAFETY_ATTR_VALUE_RE
 *   kYr                     → SAFETY_REASON_CODE_EXCEPTIONS ({"hook:tool.check"})
 *   UMn (@36242337)         → SAFETY_TOOL_NAME_ALLOWLIST (= [] in v307 — dormant)
 *   RPs (@36238307)         → SAFETY_TOOL_CLASSES
 *   wYr                     → SAFETY_EVENT_SKIPPED_TOOLS ({AskUserQuestion,ExitPlanMode})
 *   vYr/DMn (@36238620)     → BASH_MISS_CATEGORY_MAP
 *   Pd (@31202776) + i8e    → HOOK_EVENT_ALLOWLIST (yYr=[...Pd,"tool.check"])
 *   Ytt (@28640914)         → CIRCUIT_BREAKER_KEYS (9 keys)
 *   hYr                     → CLASSIFIER_NAME_ALLOWLIST (["auto-mode"])
 *   ast                     → SUBCOMMANDS_PREFIX ("subcommands:")
 *   r8 (@21280493)          → SKILL_TOOL_NAME_PREFIX ("skill__")
 *   PMn/Xne/EMn (@36235574) → buildSafetyReasonCode
 *   HMn (@36242400 region)  → deriveSafetyCategoryFromCode
 *   CYr (@36239601 region)  → deriveSafetyCategory
 *   MMn                     → sanitizeSafetyReasonCode
 *   rAe                     → expandSubcommandCodes
 *   OMn                     → allowlistOr
 *   tt                      → takeFirstSegment
 *   I5 (@34256176)          → findSubcommandRule
 *   MOn (@39258391)         → findRuleSource
 *   IOn (@39257818)         → findCircuitBreaker
 *   bU/j6r (@39256400/39257086) → buildSafetyRecord/buildSafetyOutcome
 *   jMn (@36243228 region)  → deriveToolClass
 *   WCr                     → classifyToolName
 *   $Mn (@36241792 region)  → buildSafetyToolName
 *   FMn (k(bYr,!0))         → isSafetyEventEnabled ("tengu_snoopy_creek", default TRUE)
 *   LMn (@36240106) + BMn (@36242117 region) → logSafetyEvent
 *
 * Documented OCC deviations (no invented behavior — each is a missing-surface
 * note):
 *  1. sandboxViolations: official LMn receives the tool result's
 *     `sandboxViolations` (EDn flatMap at the call site @13362555). OCC has no
 *     sandbox-violation surface → always []; sandbox_violation_count is
 *     therefore always String(0) and the sandbox_network/sandbox_other
 *     categories are structurally present but dormant.
 *  2. agentContext (LMn's 3rd emit param): OCC's logOTelEvent has no such
 *     parameter → not passed.
 *  3. Analytics twin `tengu_safety_event` (BMn's `i(...)` leg): OCC analytics
 *     is stubbed → only the OTel leg (`Si("safety_event",...)`) is ported.
 *  4. c/de/In/b attribute wrappers: identity in OCC (logOTelEvent takes plain
 *     strings). Evidence the regex is NOT applied to every field: the official
 *     hook_event value "pre_tool_use" contains an underscore and would fail
 *     _Yr — the sanitizer (MMn) applies to reason_code ONLY.
 *  5. bU's record triple {outcome, recorded, shown}: OCC's
 *     logPermissionDecision receives the RECORDED decision directly
 *     (decision + source + decisionReason), so j6r's branch-1 (shown ask) and
 *     branch-3 (deny outcome) collapse onto args.decisionReason. Net records
 *     are byte-equivalent for every OCC call flow (see buildSafetyOutcome).
 *     matchedAskRule (RAe) has no OCC surface → always undefined; the PMn
 *     matchedAskRule arm is structurally present but dormant.
 *  6. grant_scope: OCC sources carry no `scope` field (official
 *     `n.scope??(permanent?"always":"once")`) → permanent?'always':'once'.
 *  7. tool_name resolution ($Mn): official walks
 *     toolCatalog.getAllBaseTools() via sAe (find by Ct=toolMatchesName) with
 *     an Nee() dynamic-registry fallback, then Dn (Eu alias map +
 *     builtinToolsServedByMcp resolver vT). OCC: catalog =
 *     toolUseContext.options.tools; no Eu aliases and no vT surface → mcp
 *     class always resolves to "mcp_tool" (Gzr→Dn net result), catalog-miss
 *     names classify via WCr, and with NO catalog surface plain base-tool
 *     names are taken as canonical while dynamic (mcp__/skill__/__-containing)
 *     names still classify.
 *  8. classifier_category: official q=_D(reason.category) (built-in 79-set)
 *     re-gated by kc() (OTEL_LOG_TOOL_DETAILS) in BMn. OCC reuses the 2.1.301
 *     DRY seam buildClassifierToolDecisionFields (which applies the same
 *     built-in set + gate internally — classifierDecisionTelemetry.ts); the
 *     kc() gate is re-applied at emit time (idempotent).
 *  9. svo/NMn hook-pushback emission ("hook_review"/"sent_back" categories on
 *     PostToolUse hook blocking errors) is a SEPARATE optional emission site —
 *     deliberately NOT ported here (second phase; OCC's hook-attachment
 *     surface differs).
 * 10. Official emits safety_event at most ONCE per tool call (Ge flag at the
 *     LMn call site). OCC emits once per logPermissionDecision call — OCC
 *     records exactly one decision per tool call on every live flow, so the
 *     observable cardinality matches; no dedupe flag is added.
 * 11. Official decision_source for UNCORDED paths (Est/U6r/OOn/DOn: session or
 *     user-scoped rule auto-decisions mapping to user_temporary/user_reject/
 *     user_permanent without a prompt) does not apply: OCC routes every
 *     decision through logPermissionDecision, whose sourceString IS the
 *     official recorded.source (`we=K==="config"?"config":pYr(K)` @36234800
 *     region) — the same string tool_decision emits.
 */
import type { Tool as ToolType, Tools, ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isToolDetailsLoggingEnabled } from '../../services/analytics/metadata.js'
import type {
  PermissionDecisionReason,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
} from '../../types/permissions.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
  CLASSIFIER_UNAVAILABLE_REASON,
} from '../../utils/messages.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/MonitorTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import {
  buildClassifierToolDecisionFields,
  permissionModeToExternal,
} from './classifierDecisionTelemetry.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from './PermissionContext.js'
// Circular by design: permissionLogging imports logSafetyEvent; this module
// reuses its 2.1.302 w0r port (Fgn) at CALL time only — no module-init cycle.
import { buildToolSourceAttribute } from './permissionLogging.js'

// ---------------------------------------------------------------------------
// Verbatim official constants
// ---------------------------------------------------------------------------

/** Official TYr — safety categories in priority order (subcommands collapse). */
export const SAFETY_CATEGORIES = [
  'safety_check',
  'managed_policy',
  'permission_rule',
  'static_analysis',
  'hook',
  'auto_mode_block',
  'auto_mode_no_verdict',
  'permission_mode',
  'sandbox_override',
] as const

export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number]

/** Categories reachable only through CYr's fallback arms (outside TYr). */
export type SafetyEventCategory =
  | SafetyCategory
  | 'user_rejected'
  | 'other'
  | 'sandbox_network'
  | 'sandbox_other'

/** Official EYr — the closed decision_source allowlist (else "other"). */
export const SAFETY_DECISION_SOURCES = [
  'config',
  'classifier',
  'hook',
  'user_temporary',
  'user_permanent',
  'user_reject',
  'user_abort',
] as const

/** Official _Yr — reason_code attribute shape bound. */
export const SAFETY_ATTR_VALUE_RE = /^[A-Za-z][A-Za-z+:-]{0,199}$/

/** Official kYr — the single regex exception (i8e="tool.check" @34255560). */
export const SAFETY_REASON_CODE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'hook:tool.check',
])

/** Official UMn (@36242337) — EMPTY in v307; the other_tool override is dormant. */
export const SAFETY_TOOL_NAME_ALLOWLIST: readonly string[] = []

/** Official RPs (@36238307) — the WCr tool-name classification set. */
export const SAFETY_TOOL_CLASSES = [
  'mcp_tool',
  'skill_tool',
  'dynamic_tool',
  'other_tool',
] as const

export type SafetyToolClass = (typeof SAFETY_TOOL_CLASSES)[number]

/** Official wYr = new Set([Qo, vc]) — "other"-class tools skipped entirely. */
export const SAFETY_EVENT_SKIPPED_TOOLS: ReadonlySet<string> = new Set([
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
])

/** Official ast. */
const SUBCOMMANDS_PREFIX = 'subcommands:'

/** Official r8 (@21280493). */
const SKILL_TOOL_NAME_PREFIX = 'skill__'

/** Official yYr = [...Pd, i8e]; Pd verbatim @31202776, i8e="tool.check". */
const HOOK_EVENT_ALLOWLIST: readonly string[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
  'tool.check',
]

/** Official Ytt (@28640914) keys — the circuit-breaker membership check. */
const CIRCUIT_BREAKER_KEYS: ReadonlySet<string> = new Set([
  'dangerousRemoval',
  'backgroundOperator',
  'suspiciousWindowsPath',
  'isolatePeerMachines',
  'restrictedMode',
  'outsideReadsBlocked',
  'claudeSettingsFile',
  'internalHardDeny',
  'unfinishedCheck',
])

/** Official hYr. */
const CLASSIFIER_NAME_ALLOWLIST: readonly string[] = ['auto-mode']

/**
 * Official vYr (@36238620), byte-verbatim including the explicit
 * no-category tags (no-rule-match/other-untagged → undefined). DMn =
 * new Map(Object.entries(vYr)). bashMissKind has no OCC surface yet (the
 * parser-side kind set Kzt @980502 lives in the bash AST layer) — the branch
 * is structurally present and dormant.
 */
const BASH_MISS_CATEGORY_MAP: ReadonlyMap<string, SafetyCategory | undefined> =
  new Map<string, SafetyCategory | undefined>(Object.entries({
    'too-complex': 'static_analysis',
    semantics: 'static_analysis',
    'multi-cd': 'static_analysis',
    'cd-git-compound': 'static_analysis',
    'cd-compound-write': 'static_analysis',
    'cd-compound-read': 'static_analysis',
    'cd-compound-redirect': 'static_analysis',
    'dangerous-path': 'static_analysis',
    'flag-validation': 'static_analysis',
    'cd-multi-positional': 'static_analysis',
    'process-substitution': 'static_analysis',
    'shell-expansion': 'static_analysis',
    'net-redirect': 'static_analysis',
    'shell-operators': 'static_analysis',
    'sed-dangerous': 'static_analysis',
    'working-dir': 'safety_check',
    'safety-check': 'safety_check',
    'ask-rule': 'permission_rule',
    'no-rule-match': undefined,
    'other-untagged': undefined,
  }))

/** Official jMn class sets: AYr=new Set([je,ri]), xYr=new Set([Xe,ct,qt,Ji,ro,Cr,...UMn]). */
const BASH_CLASS_TOOLS: ReadonlySet<string> = new Set([
  BASH_TOOL_NAME,
  MONITOR_TOOL_NAME,
])
const FILE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  ...SAFETY_TOOL_NAME_ALLOWLIST,
])

// Official reason-string constants (@28643016-28647924 region), byte-verbatim.
// OCC produces these exact strings inline (bashPermissions.ts readOnly/sandbox
// literals; permissionDecisionMapper.ts canUseTool literals; messages.ts
// exports the two classifier strings) — no shared exported constants exist, so
// they are re-declared here with their official symbol names in comments.
const REASON_SANDBOX_AUTO_ALLOW =
  'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)' // Xtt
const REASON_READ_ONLY_COMMAND = 'Read-only command is allowed' // b_e
const REASON_RESTRICTED_MODE =
  '--restricted: path outside the working directory' // nbn
const REASON_OUTSIDE_READS_BLOCKED =
  'Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.' // BH
const REASON_NO_PROJECT_DIRECTORY =
  'permission check needs a working directory; the session has none' // Xnr
const REASON_TOOLS_HELD = 'tools_held_until_a_person_types' // Nen
const REASON_NO_CONFIG_HOME =
  'permission check needs a config or temp path; the session has none' // Jtt
const REASON_PERMISSION_STREAM_CLOSED =
  'tool permission stream closed before response received' // ent
const REASON_CAN_USE_TOOL_INVALID_RESULT =
  'canUseTool returned a schema-invalid permission result' // ZKe
const REASON_CAN_USE_TOOL_REQUEST_FAILED = 'tool permission request failed' // h0e
const REASON_CAN_USE_TOOL_ABORTED = 'tool permission request aborted' // ibn
const REASON_HOOK_REWRITTEN_INPUT_ASK = 'ask rule on hook-rewritten input' // aqr
const REASON_NO_APPROVAL_SURFACE =
  'no approval surface in this session; permission request denied automatically' // dqr

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Official sandboxViolations element shape as consumed by CYr
 * (`n.some(r=>r.kind==="network")`). Dormant in OCC — no violation surface.
 */
export type SandboxViolation = { kind: string }

/** Official bU return — the LMn `record` input. */
export type SafetyRecord = {
  decision: 'accept' | 'reject'
  source: string
  reasonType?: string
  ruleSource?: PermissionRuleSource
  grantScope?: 'always' | 'once'
  reasonCode?: string
  circuitBreaker?: string
  classifierCategory?: string
}

/** The recorded permission decision, as seen by logPermissionDecision. */
export type SafetyEventArgs = {
  decision: 'accept' | 'reject'
  source: PermissionApprovalSource | PermissionRejectionSource | 'config'
  /** The stringified source (official `we`) — the same value tool_decision emits. */
  sourceString: string
  decisionReason?: PermissionDecisionReason
  permissionMode?: PermissionMode
}

export type SafetyEventCtx = {
  tool: ToolType
  toolUseID: string
  toolUseContext?: ToolUseContext
}

// ---------------------------------------------------------------------------
// Small verbatim helpers (tt / OMn / rAe / MMn)
// ---------------------------------------------------------------------------

/** Official tt(e, sep) — the substring before the first separator. */
function takeFirstSegment(value: string, separator: string): string {
  const idx = value.indexOf(separator)
  return idx === -1 ? value : value.slice(0, idx)
}

/** Official OMn(e,n){return e.includes(n)?n:"other"}. */
function allowlistOr(list: readonly string[], value: string): string {
  return list.includes(value) ? value : 'other'
}

/** Official rAe — expand a (possibly combined) subcommands reason code. */
export function expandSubcommandCodes(code: string): string[] {
  return code.startsWith(SUBCOMMANDS_PREFIX)
    ? code.slice(SUBCOMMANDS_PREFIX.length).split('+')
    : [code]
}

/** Official MMn — the reason_code wire sanitizer (_Yr + kYr exception). */
export function sanitizeSafetyReasonCode(
  code: string | undefined,
): string | undefined {
  return code !== undefined &&
    (SAFETY_ATTR_VALUE_RE.test(code) || SAFETY_REASON_CODE_EXCEPTIONS.has(code))
    ? code
    : undefined
}

// ---------------------------------------------------------------------------
// Reason-code builder (official Xne/PMn/EMn @36235574 region)
// ---------------------------------------------------------------------------

/** Official EMn — classifier reason code. */
function buildClassifierReasonCode(
  reason: Extract<PermissionDecisionReason, { type: 'classifier' }>,
): string {
  const name = allowlistOr(CLASSIFIER_NAME_ALLOWLIST, reason.classifier)
  if (reason.reason === CLASSIFIER_UNAVAILABLE_REASON) {
    return `classifier:${name}:unavailable`
  }
  if (reason.noVerdict) {
    return `classifier:${name}:no-verdict`
  }
  return `classifier:${name}`
}

/**
 * Official PMn, verbatim control flow. `source` and `matchedAskRule` are the
 * official n/s parameters: source is ALWAYS undefined at the bU call site
 * (`Xne(y.behavior,void 0,y.reason,y.matchedAskRule)`), and matchedAskRule has
 * no OCC surface (deviation 5) — both arms are structurally preserved.
 */
function buildReasonCode(
  behavior: string,
  source: string | undefined,
  reason: PermissionDecisionReason | undefined,
  matchedAskRule: { source: PermissionRuleSource } | undefined,
): string {
  if (source !== undefined && source !== 'config') {
    if (source === 'hook') return 'hook:PermissionRequest'
    if (source === 'classifier' && reason?.type === 'classifier') {
      return buildClassifierReasonCode(reason)
    }
    return source
  }
  if (reason?.type !== 'rule' && matchedAskRule !== undefined) {
    return `rule:${matchedAskRule.source}`
  }
  if (reason === undefined) return 'unknown'
  switch (reason.type) {
    case 'rule':
      return `rule:${reason.rule.source}`
    case 'mode':
      return `mode:${reason.mode}`
    case 'hook':
      return `hook:${allowlistOr(
        HOOK_EVENT_ALLOWLIST,
        takeFirstSegment(reason.hookName, ':'),
      )}`
    case 'classifier':
      return buildClassifierReasonCode(reason)
    case 'subcommandResults': {
      const codes = new Set<string>()
      for (const result of reason.reasons.values()) {
        if (
          (result.behavior === behavior ||
            (behavior === 'ask' && result.behavior === 'passthrough')) &&
          result.decisionReason !== undefined
        ) {
          const code = buildReasonCode(behavior, undefined, result.decisionReason, undefined)
          for (const part of behavior === 'ask' ? expandSubcommandCodes(code) : [code]) {
            codes.add(part)
          }
        }
      }
      const [single] = codes
      if (codes.size === 1 && single !== undefined) return single
      if (codes.size > 1) {
        const parts =
          behavior === 'ask'
            ? codes
            : new Set([...codes].map(code => takeFirstSegment(code, ':')))
        return `${SUBCOMMANDS_PREFIX}${[...parts].sort().join('+')}`
      }
      return 'subcommandResults'
    }
    case 'other': {
      if (reason.reason === REASON_SANDBOX_AUTO_ALLOW) return 'sandboxAutoAllow'
      if (reason.reason === REASON_READ_ONLY_COMMAND) return 'readOnlyCommand'
      if (reason.reason === REASON_RESTRICTED_MODE) return 'restrictedMode'
      if (reason.reason === REASON_OUTSIDE_READS_BLOCKED) {
        return 'outsideReadsBlocked'
      }
      if (reason.reason === REASON_NO_PROJECT_DIRECTORY) {
        return 'noProjectDirectory'
      }
      if (reason.reason === REASON_TOOLS_HELD) return 'toolsHeld'
      if (reason.reason === REASON_NO_CONFIG_HOME) return 'noConfigHome'
      if (reason.reason === CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON) {
        return 'classifierTranscriptTooLong'
      }
      if (reason.reason === REASON_PERMISSION_STREAM_CLOSED) {
        return 'permissionStreamClosed'
      }
      if (reason.reason === REASON_CAN_USE_TOOL_INVALID_RESULT) {
        return 'canUseToolInvalidResult'
      }
      if (reason.reason === REASON_CAN_USE_TOOL_REQUEST_FAILED) {
        return 'canUseToolRequestFailed'
      }
      if (reason.reason === REASON_CAN_USE_TOOL_ABORTED) {
        return 'canUseToolAborted'
      }
      // Official `r.bashMissKind!==void 0` — OCC's 'other' reason type has no
      // bashMissKind field yet (deviation: dormant, read defensively).
      const bashMissKind = (reason as { bashMissKind?: string }).bashMissKind
      if (bashMissKind !== undefined) return `bashMiss:${bashMissKind}`
      return 'other'
    }
    case 'asyncAgent':
      if (reason.reason === REASON_HOOK_REWRITTEN_INPUT_ASK) {
        return 'hookRewrittenInputAsk'
      }
      if (reason.reason === REASON_NO_APPROVAL_SURFACE) {
        return 'noApprovalSurface'
      }
      return reason.type
    case 'safetyCheck':
      if (reason.reason === REASON_OUTSIDE_READS_BLOCKED) {
        return 'outsideReadsBlocked'
      }
      if (reason.reason === REASON_NO_CONFIG_HOME) return 'noConfigHome'
      return reason.type
    case 'permissionPromptTool':
    case 'sandboxOverride':
    case 'workingDir':
      return reason.type
    default:
      return 'unknown'
  }
}

/**
 * Official Xne at the bU call site: `Xne(y.behavior,void 0,y.reason,
 * y.matchedAskRule)` — source pinned undefined, matchedAskRule absent in OCC.
 */
export function buildSafetyReasonCode(
  behavior: string,
  reason: PermissionDecisionReason | undefined,
): string {
  return buildReasonCode(behavior, undefined, reason, undefined)
}

// ---------------------------------------------------------------------------
// Category derivation (official HMn / CYr)
// ---------------------------------------------------------------------------

/** Official HMn — reason-code prefix → category. */
export function deriveSafetyCategoryFromCode(
  code: string,
): SafetyCategory | undefined {
  const idx = code.indexOf(':')
  const prefix = idx === -1 ? code : code.slice(0, idx)
  const rest = idx === -1 ? '' : code.slice(idx + 1)
  switch (prefix) {
    case 'bashMiss':
      return BASH_MISS_CATEGORY_MAP.get(rest)
    case 'subcommands': {
      if (rest === '') return undefined
      const categories = new Set(
        expandSubcommandCodes(code).map(part => deriveSafetyCategoryFromCode(part)),
      )
      return SAFETY_CATEGORIES.find(category => categories.has(category))
    }
    case 'rule':
      return rest === 'policySettings' ? 'managed_policy' : 'permission_rule'
    case 'mode':
      return 'permission_mode'
    case 'hook':
      return 'hook'
    case 'classifier':
      return rest.endsWith(':unavailable') || rest.endsWith(':no-verdict')
        ? 'auto_mode_no_verdict'
        : 'auto_mode_block'
    case 'classifierTranscriptTooLong':
      return 'auto_mode_no_verdict'
    case 'safetyCheck':
    case 'workingDir':
    case 'outsideReadsBlocked':
    case 'restrictedMode':
    case 'noProjectDirectory':
      return 'safety_check'
    case 'sandboxOverride':
      return 'sandbox_override'
    default:
      return undefined
  }
}

/**
 * Official CYr — record + sandbox violations → category, or undefined (skip).
 * NOTE the fallbacks (user_rejected/other/permission_mode) live INSIDE the
 * reasonCode!==undefined block, exactly as in the binary.
 */
export function deriveSafetyCategory(
  record: SafetyRecord,
  violations: readonly SandboxViolation[] = [],
): SafetyEventCategory | undefined {
  if (record.reasonCode !== undefined) {
    const category =
      record.circuitBreaker !== undefined
        ? 'safety_check'
        : deriveSafetyCategoryFromCode(record.reasonCode)
    if (category === 'permission_rule' && record.ruleSource === 'policySettings') {
      return 'managed_policy'
    }
    if (category !== undefined) return category
    if (record.reasonType === 'asyncAgent') return 'permission_mode'
    if (record.decision === 'reject') {
      if (record.source === 'user_reject' || record.source === 'user_abort') {
        return 'user_rejected'
      }
      if (record.reasonType !== undefined) return 'other'
    }
  }
  if (violations.length === 0) return undefined
  return violations.some(violation => violation.kind === 'network')
    ? 'sandbox_network'
    : 'sandbox_other'
}

// ---------------------------------------------------------------------------
// Record builder (official bU + j6r + MOn/I5 + IOn over OCC structures)
// ---------------------------------------------------------------------------

/** Official I5 — first matching rule inside subcommandResults, recursively. */
function findSubcommandRule(
  reason: PermissionDecisionReason | undefined,
  behavior: 'deny' | 'ask',
): PermissionRule | undefined {
  if (reason?.type !== 'subcommandResults') return undefined
  for (const result of reason.reasons.values()) {
    const sub = result.behavior === behavior ? result.decisionReason : undefined
    const rule =
      sub?.type === 'rule' ? sub.rule : findSubcommandRule(sub, behavior)
    if (rule !== undefined) return rule
  }
  return undefined
}

/** Official MOn — the rule source behind a decision reason (if any). */
function findRuleSource(
  reason: PermissionDecisionReason | undefined,
  behavior: string,
): PermissionRuleSource | undefined {
  if (reason?.type === 'rule') return reason.rule.source
  return findSubcommandRule(reason, behavior === 'deny' ? 'deny' : 'ask')
    ?.source
}

/** Official IOn — the circuit-breaker key behind a decision reason (if any). */
function findCircuitBreaker(
  reason: PermissionDecisionReason | undefined,
  behavior: string,
): string | undefined {
  if (reason?.type === 'safetyCheck') {
    const circuitBreaker = reason.circuitBreaker
    return circuitBreaker !== undefined &&
      CIRCUIT_BREAKER_KEYS.has(circuitBreaker)
      ? circuitBreaker
      : undefined
  }
  if (reason?.type === 'subcommandResults') {
    for (const result of reason.reasons.values()) {
      if (result.behavior === behavior) {
        const circuitBreaker = findCircuitBreaker(result.decisionReason, behavior)
        if (circuitBreaker !== undefined) return circuitBreaker
      }
    }
  }
  return undefined
}

type SafetyOutcome = {
  behavior: 'ask' | 'deny'
  reason: PermissionDecisionReason | undefined
}

/**
 * Official j6r collapsed onto OCC's recorded-decision surface (deviation 5).
 * Branch mapping:
 *  - branch 1 (shown ask answered by the user, no hook/classifier deny) →
 *    userAnswered && !hookOrClassifierDeny → {ask, decisionReason}
 *  - branch 2 (asyncAgent .ask) — OCC's asyncAgent reason type has no `ask`
 *    field → dormant/omitted
 *  - branch 3 (non-allow outcome) → reject → {deny, decisionReason}
 *  - branch 4 (allow + h + reason!=='permissionPromptTool') → userAnswered
 *    accept → {ask, decisionReason}
 *  - branch 5 → undefined (bare config/hook/classifier accept → NO record →
 *    reasonCode undefined → CYr skip; the official behaves identically)
 */
function buildSafetyOutcome(
  args: SafetyEventArgs,
  userAnswered: boolean,
): SafetyOutcome | undefined {
  const reason = args.decisionReason
  const isDeny = args.decision === 'reject'
  const hookOrClassifierDeny =
    isDeny && (reason?.type === 'hook' || reason?.type === 'classifier')
  if (userAnswered && !hookOrClassifierDeny) {
    return { behavior: 'ask', reason }
  }
  if (isDeny) {
    return { behavior: 'deny', reason }
  }
  if (userAnswered && reason?.type !== 'permissionPromptTool') {
    return { behavior: 'ask', reason }
  }
  return undefined
}

/** Official bU — assemble the LMn record from the recorded decision. */
export function buildSafetyRecord(args: SafetyEventArgs): SafetyRecord {
  // Official h flag: outcome.behavior==="ask" || recorded.source.startsWith("user_")
  // || n==="user_abort" || s?.type==="permissionPromptTool". OCC's decision is
  // only accept/reject, so the ask-outcome term collapses into the user_* check
  // (user_abort included — sourceString "user_abort" starts with "user_").
  const userAnswered = args.sourceString.startsWith('user_')
  const suppressReasonType =
    userAnswered || args.decisionReason?.type === 'permissionPromptTool'
  const outcome = buildSafetyOutcome(args, userAnswered)
  const outcomeBehavior = args.decision === 'reject' ? 'deny' : 'allow'
  const ruleSource =
    findRuleSource(args.decisionReason, outcomeBehavior) ??
    (outcome !== undefined
      ? findRuleSource(outcome.reason, outcome.behavior)
      : undefined)
  // Official ve: accept + non-config source + type "user" →
  // scope??(permanent?"always":"once"); OCC sources carry no scope (deviation 6).
  const grantScope =
    args.decision === 'accept' &&
    args.source !== 'config' &&
    args.source.type === 'user'
      ? args.source.permanent
        ? 'always'
        : 'once'
      : undefined
  const circuitBreaker =
    outcome !== undefined
      ? findCircuitBreaker(outcome.reason, outcome.behavior)
      : undefined
  // Official q=_D(reason.category) — reuse the 2.1.301 DRY seam (deviation 8);
  // buildClassifierToolDecisionFields applies the built-in 79-set + the
  // OTEL_LOG_TOOL_DETAILS gate internally, and only for auto-mode classifiers
  // (the only OCC classifier that stamps `category`).
  const classifierCategory =
    outcome?.reason?.type === 'classifier'
      ? buildClassifierToolDecisionFields('reject', outcome.reason)
          ?.classifier_category
      : undefined
  return {
    decision: args.decision,
    source: args.sourceString,
    ...(args.decisionReason !== undefined &&
      !suppressReasonType && { reasonType: args.decisionReason.type }),
    ...(ruleSource !== undefined && { ruleSource }),
    ...(grantScope !== undefined && { grantScope }),
    ...(outcome !== undefined && {
      reasonCode: buildSafetyReasonCode(outcome.behavior, outcome.reason),
    }),
    ...(circuitBreaker !== undefined && { circuitBreaker }),
    ...(classifierCategory !== undefined && { classifierCategory }),
  }
}

// ---------------------------------------------------------------------------
// Tool class / tool name (official jMn / WCr / $Mn)
// ---------------------------------------------------------------------------

export type SafetyToolClassValue =
  | 'mcp'
  | 'bash'
  | 'powershell'
  | 'file'
  | 'web'
  | 'other'

/** Official jMn. */
export function deriveToolClass(tool: ToolType): SafetyToolClassValue {
  if (tool.mcpInfo !== undefined || tool.isMcp === true) return 'mcp'
  if (BASH_CLASS_TOOLS.has(tool.name)) return 'bash'
  if (tool.name === POWERSHELL_TOOL_NAME) return 'powershell'
  if (FILE_CLASS_TOOLS.has(tool.name)) return 'file'
  if (tool.name === WEB_FETCH_TOOL_NAME || tool.name === WEB_SEARCH_TOOL_NAME) {
    return 'web'
  }
  return 'other'
}

/** Official WCr. */
export function classifyToolName(name: string): SafetyToolClass {
  if (name.startsWith('mcp__')) return 'mcp_tool'
  if (name.startsWith(SKILL_TOOL_NAME_PREFIX)) return 'skill_tool'
  return name.includes('__') ? 'dynamic_tool' : 'other_tool'
}

/** Official BMn UMn override (`UMn.includes(tool_name)?c("other_tool"):name`). */
export function applySafetyToolNameAllowlist(
  name: string | undefined,
): string | undefined {
  return name !== undefined && SAFETY_TOOL_NAME_ALLOWLIST.includes(name)
    ? 'other_tool'
    : name
}

function isDynamicToolName(name: string): boolean {
  return (
    name.startsWith('mcp__') ||
    name.startsWith(SKILL_TOOL_NAME_PREFIX) ||
    name.includes('__')
  )
}

/**
 * Official $Mn tool_name resolution (deviation 7): mcp class → Gzr→Dn net
 * result "mcp_tool" (OCC has no builtinToolsServedByMcp resolver); otherwise
 * sAe catalog find (findToolByName ≡ Ct name-or-alias match) → canonical name
 * (Dn: an mcp__-prefixed canonical name still resolves to "mcp_tool"),
 * catalog miss → WCr classification.
 */
export function buildSafetyToolName(
  tool: ToolType,
  toolClass: SafetyToolClassValue,
  catalog: Tools | undefined,
): string {
  if (toolClass === 'mcp') return 'mcp_tool'
  if (catalog !== undefined) {
    const match = findToolByName(catalog, tool.name)
    if (match !== undefined) {
      return match.name.startsWith('mcp__') ? 'mcp_tool' : match.name
    }
    return classifyToolName(tool.name)
  }
  // No catalog surface: approximate the official Nee() registry fallback —
  // plain base-tool names are registry-known (canonical as-is); dynamic names
  // are not and classify via WCr.
  return isDynamicToolName(tool.name) ? classifyToolName(tool.name) : tool.name
}

// ---------------------------------------------------------------------------
// Gate + emitter (official FMn / LMn / BMn)
// ---------------------------------------------------------------------------

/** Official FMn(){return k(bYr,!0)} — bYr="tengu_snoopy_creek", default TRUE. */
export function isSafetyEventEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_snoopy_creek', true)
}

/**
 * Official LMn + BMn's OTel leg. Returns true iff a safety_event was emitted.
 * Emitted attribute key order IS the official wire order (LMn attrs, then
 * BMn's appends: tool_use_id, sandbox_violation_count, sandbox_enabled —
 * BMn's tool_name/classifier_category overrides rewrite values in place
 * without moving keys, and are folded into the literal below).
 */
export function logSafetyEvent(
  args: SafetyEventArgs,
  ctx: SafetyEventCtx,
): boolean {
  try {
    const record = buildSafetyRecord(args)
    const toolClass = deriveToolClass(ctx.tool)
    // Deviation 1: OCC has no sandbox-violation surface → [] (official: EDn
    // flatMap over the tool result's sandboxViolations).
    const category = deriveSafetyCategory(record, [])
    if (
      category === undefined ||
      (toolClass === 'other' && SAFETY_EVENT_SKIPPED_TOOLS.has(ctx.tool.name)) ||
      !isSafetyEventEnabled()
    ) {
      return false
    }
    const catalog = ctx.toolUseContext?.options?.tools
    const hookEvent =
      category === 'hook' &&
      record.reasonCode !== undefined &&
      expandSubcommandCodes(record.reasonCode).includes('hook:PreToolUse')
        ? 'pre_tool_use'
        : undefined
    void logOTelEvent('safety_event', {
      category,
      decision: record.decision,
      decision_source:
        SAFETY_DECISION_SOURCES.find(source => source === record.source) ??
        'other',
      reason_type: record.reasonType,
      reason_code: sanitizeSafetyReasonCode(record.reasonCode),
      rule_source: record.ruleSource,
      grant_scope: record.grantScope,
      circuit_breaker: record.circuitBreaker,
      classifier_category: isToolDetailsLoggingEnabled()
        ? record.classifierCategory
        : undefined,
      hook_event: hookEvent,
      tool_class: toolClass,
      tool_name: applySafetyToolNameAllowlist(
        buildSafetyToolName(ctx.tool, toolClass, catalog),
      ),
      ...buildToolSourceAttribute(ctx.tool),
      permission_mode: permissionModeToExternal(args.permissionMode),
      tool_use_id: ctx.toolUseID,
      // Official BMn: String(sandboxViolationCount) — always 0 in OCC.
      sandbox_violation_count: '0',
      sandbox_enabled: String(SandboxManager.isSandboxingEnabled()),
    })
    return true
  } catch (error) {
    logForDebugging(
      `[3P telemetry] safety_event emit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { level: 'warn' },
    )
    return false
  }
}
