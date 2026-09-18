import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

// The SDK does not yet have types for advisor blocks.
// TODO(hackyon): Migrate to the real anthropic SDK types when this feature ships publicly
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

function getAdvisorConfig(): AdvisorConfig {
  return getFeatureValue_CACHED_MAY_BE_STALE<AdvisorConfig>(
    'tengu_sage_compass',
    {},
  )
}

// ---------------------------------------------------------------------------
// Official 2.1.276 advisor hotfix — refusal latches.
//
// When ANTHROPIC_BASE_URL points at a proxy or gateway that does not know the
// advisor server tool, the API rejects the request with a 400 (the 2.1.275
// regression message is "tools.N.model: Input tag 'advisor_20260301' found
// using 'type' does not match any tag …"). The retry handler in
// services/api/advisorRetry.ts (official `zHe`) strips the advisor tool from
// the request and latches the refusal here:
//
//   - Official `Vqt` / `Yqt()`: process-wide kill-switch, set when the 400
//     message says the ORGANIZATION lacks advisor access ("not available for
//     this organization" — official `vtt`). Once killed, the infra gate
//     (official `yct`, whose `if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL||Vqt)
//     return!1` branch this mirrors) reports advisor disabled everywhere —
//     beta header, model resolution, and tool schema.
//   - Official `advisorHeld.refused`: session latch — once the advisor entry
//     has been refused, advisorModel resolution returns undefined (official
//     `Qqt` analog gate in claude.ts) so the advisor schema is not re-added
//     for the rest of the session, even when the org-wide kill did not fire.
// ---------------------------------------------------------------------------
let advisorOrgDisabled = false
let advisorEntryRefused = false

/**
 * Latch the advisor-entry refusal for the session (official
 * `Ue.advisorHeld={…,refused:!0}` plus `if(vtt(hr))Yqt()`).
 *
 * @param organizationWide - true when the 400 message matched the official
 *   `vtt` org-wide shape ("not available for this organization") — arms the
 *   process-wide kill-switch (official `Yqt()`).
 */
export function markAdvisorEntryRefused(organizationWide: boolean): void {
  advisorEntryRefused = true
  if (organizationWide) {
    advisorOrgDisabled = true
  }
}

/** Whether the advisor entry was refused this session (official `advisorHeld.refused`). */
export function isAdvisorEntryRefused(): boolean {
  return advisorEntryRefused
}

/** Whether the org-wide kill-switch is armed (official `Vqt`). */
export function isAdvisorOrgDisabled(): boolean {
  return advisorOrgDisabled
}

/** @internal Test-only reset for the module-scope refusal latches. */
export function _resetAdvisorRefusalStateForTesting(): void {
  advisorEntryRefused = false
  advisorOrgDisabled = false
}

export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  // Official 2.1.276 `yct`: the org-wide kill-switch (`Vqt`) disables the
  // advisor everywhere, same as the CLAUDE_CODE_DISABLE_ADVISOR_TOOL env var.
  if (advisorOrgDisabled) {
    return false
  }
  // The advisor beta header is first-party only (Bedrock/Vertex 400 on it).
  if (!shouldIncludeFirstPartyOnlyBetas()) {
    return false
  }
  return getAdvisorConfig().enabled ?? false
}

export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && (getAdvisorConfig().canUserConfigure ?? false)
}

export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  const config = getAdvisorConfig()
  return isAdvisorEnabled() &&
    !canUserConfigureAdvisor() &&
    config.baseModel &&
    config.advisorModel
    ? { baseModel: config.baseModel, advisorModel: config.advisorModel }
    : undefined
}

// @[MODEL LAUNCH]: Add the new model if it supports the advisor tool.
// Checks whether the main loop model supports calling the advisor tool.
// OCC-37 (1g): opus-5 added — binary 2.1.220 model registry entry for
// `claude-opus-5` (recovered via `dd` around offset 177163000) carries
// `advisor_rank:4` verbatim, mirroring opus-4-8. Pre-existing OCC gap:
// opus-4-7/4-8 also carry an advisor_rank but are not yet ported here.
export function modelSupportsAdvisor(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('opus-5') ||
    process.env.USER_TYPE === 'ant'
  )
}

// @[MODEL LAUNCH]: Add the new model if it can serve as an advisor model.
export function isValidAdvisorModel(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    m.includes('opus-5') ||
    process.env.USER_TYPE === 'ant'
  )
}

export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel
}

export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`
