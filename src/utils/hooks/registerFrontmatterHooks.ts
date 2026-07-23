import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import {
  hasFrontmatterHooks,
  isAgentHooksOriginTrusted,
  type AgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { logForDebugging } from '../debug.js'
import { skipFrontmatterHooksForUntrustedOrigin } from '../hooks.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook } from './sessionHooks.js'

/**
 * Register hooks from frontmatter (agent or skill) into session-scoped hooks.
 * These hooks will be active for the duration of the session/agent and cleaned up
 * when the session/agent ends.
 *
 * @param setAppState Function to update app state
 * @param sessionId Session ID to scope the hooks (agent ID for agents, session ID for skills)
 * @param hooks The hooks settings from frontmatter
 * @param sourceName Human-readable source name for logging (e.g., "agent 'my-agent'")
 * @param isAgent If true, converts Stop hooks to SubagentStop (since subagents trigger SubagentStop, not Stop)
 */
export function registerFrontmatterHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  sourceName: string,
  isAgent: boolean = false,
): void {
  if (!hooks || Object.keys(hooks).length === 0) {
    return
  }

  let hookCount = 0

  for (const event of HOOK_EVENTS) {
    const matchers = hooks[event]
    if (!matchers || matchers.length === 0) {
      continue
    }

    // For agents, convert Stop hooks to SubagentStop since that's what fires when an agent completes
    // (executeStopHooks uses SubagentStop when called with an agentId)
    let targetEvent: HookEvent = event
    if (isAgent && event === 'Stop') {
      targetEvent = 'SubagentStop'
      logForDebugging(
        `Converting Stop hook to SubagentStop for ${sourceName} (subagents trigger SubagentStop)`,
      )
    }

    for (const matcherConfig of matchers) {
      const matcher = matcherConfig.matcher ?? ''
      const hooksArray = matcherConfig.hooks

      if (!hooksArray || hooksArray.length === 0) {
        continue
      }

      for (const hook of hooksArray) {
        addSessionHook(setAppState, sessionId, targetEvent, matcher, hook)
        hookCount++
      }
    }
  }

  if (hookCount > 0) {
    logForDebugging(
      `Registered ${hookCount} frontmatter hook(s) from ${sourceName} for session ${sessionId}`,
    )
  }
}

/**
 * CC 2.1.218 #23 (mainThread closure): Register (or skip) frontmatter hooks
 * for a MAIN-THREAD session's agent (e.g. `--agent <custom-agent-with-hooks>`).
 *
 * Mirrors the subagent path (runAgent.ts:636-668) but passes isAgent=false so
 * Stop hooks remain Stop (main-thread sessions trigger Stop, not SubagentStop).
 *
 * Branch alignment to the official's if(t&&r)/if(t&&!r)/else shape, where
 *   t = isAgentHooksOriginTrusted(agentDef)   (trusted-origin)
 *   r = hasFrontmatterHooks(agentDef.hooks) && hooksAllowedByPolicy (registerable)
 *
 * The code evaluates r first (the early `if (!hasHooks) return`), so the
 * official's 3-branch shape is realized as:
 *   !r        → noop (no registerable hooks — trusted OR untrusted, early return)
 *   t && r    → register hooks (isAgent: false — Stop stays Stop)
 *   !t && r   → skipFrontmatterHooksForUntrustedOrigin(_, 'mainThread')
 *
 * This closes the dead `surface:'mainThread'` branch — the 'mainThread'
 * surface is now reachable via this registration path.
 *
 * @param agentDef The main-thread agent definition
 * @param setAppState State setter for registering session hooks
 * @param sessionId The main session ID
 * @param hooksAllowedByPolicy Whether policy allows non-plugin agent hooks
 *  (!isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(source))
 */
export function registerMainThreadAgentHooks(
  agentDef: AgentDefinition,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooksAllowedByPolicy: boolean,
): void {
  const hasHooks =
    !!agentDef.hooks &&
    hasFrontmatterHooks(agentDef.hooks) &&
    hooksAllowedByPolicy
  if (!hasHooks) {
    return
  }

  // if (t && r) → register; if (t && !r) → noop; else → skip
  if (isAgentHooksOriginTrusted(agentDef)) {
    registerFrontmatterHooks(
      setAppState,
      sessionId,
      agentDef.hooks!,
      `main-thread agent '${agentDef.agentType}'`,
      false, // isAgent=false — main-thread Stop hooks stay Stop
    )
  } else {
    // else → skip + telemetry (surface: 'mainThread')
    skipFrontmatterHooksForUntrustedOrigin(agentDef, 'mainThread')
  }
}
