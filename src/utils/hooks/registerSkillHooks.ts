import { createHash } from 'crypto'
import { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook, removeSessionHook } from './sessionHooks.js'

/**
 * CC 2.1.304 #60 — skill hooks bounds. Official module (new_strings 19240584;
 * s304 24873529; constants `var Kt=64,...,uIr=1024,pIr=16384`): the skills of
 * ONE source (plugin id ?? source kind) hold at most 1024 hooks and 16384
 * matcher characters per session. A skill whose hooks would exceed the draw
 * registers NOTHING, grants no allowed-tools (caller-side, #61), and gets a
 * capped warn + `tengu_skill_hooks_bounds_checked` telemetry.
 *
 * Official checks a third reason `'matcher'` via the cloud host's
 * `testsSkillMatchers` and notifies the plugin host (`skillHooksDoNotFit` /
 * `skillHooksRegistered`); OCC has no cloud/plugin-host callback API, so both
 * are skipped per the port recipe. The official ledger lives on the host
 * registry keyed by session (`e.skillDraws(n)`); OCC keeps it module-local
 * per source (one CLI process = one foreground session lifecycle).
 */
export type SkillHooksUnfitReason = 'characters' | 'count'

/** Official `uIr` — max hooks one source's skills may hold per session. */
export const SKILL_HOOKS_BOUND = 1024
/** Official `pIr` — max matcher characters one source's skills may hold. */
export const SKILL_MATCHER_CHARS_BOUND = 16384
/** Official `Kt` — warn-text cap per source; at cap, refuse silently. */
const SKILL_HOOKS_UNFIT_TEXT_CAP = 64

/**
 * Official `kt` (new_strings 31464425 region, byte-verified in
 * research-R4-skills-hooks.md #60) — the model-facing notice appended as an
 * isMeta user message when a skill's hooks were kept out (bounds-unfit per
 * #60, or org plugins-only policy per #61). VERBATIM — do not reword; the
 * "a matcher that cannot be tested here" clause stays even though OCC never
 * returns the 'matcher' reason (no cloud host), matching the official text.
 */
export const SKILL_HOOKS_KEPT_OUT_NOTICE =
  "This skill declares hooks, and they were not registered in this session: a limit on hooks, a matcher that cannot be tested here, or the organization's policy kept them out. The tools that its allowed-tools would grant were not granted either. If the skill relies on its hooks to check or block tool calls, nothing checks them now: tell the user."

/** Per-source draw ledger — official `{hooks,characters,texts,unfitTexts}`. */
type SkillHooksLedgerEntry = {
  hooks: number
  characters: number
  /** Memoized verdicts per sha256([skillName, hooksJson]) — official `texts`. */
  texts: Map<string, SkillHooksUnfitReason | undefined>
  unfitTexts: number
}

const skillHooksLedger = new Map<string, SkillHooksLedgerEntry>()

/**
 * Test-only: clear the module-local bounds ledger so cumulative draws don't
 * leak across tests (the official ledger is per-session on the host registry;
 * OCC's is per-process).
 */
export function resetSkillHooksLedgerForTesting(): void {
  skillHooksLedger.clear()
}

/** Source identity for the ledger, from the launching command (#60 recipe). */
export interface SkillHooksBoundsInfo {
  /** Official `o` — e.g. 'userSettings' / 'projectSettings' / 'plugin'. */
  sourceKind: string
  /** Official `u` — plugin id when the skill comes from a plugin. */
  pluginId?: string
}

/**
 * Official `yt` — bounds check + memo + telemetry + capped warn. Returns the
 * unfit reason ('characters' | 'count') or undefined when the hooks fit (in
 * which case the ask is drawn against the source's ledger).
 */
function checkSkillHooksBounds(
  skillName: string,
  hooks: HooksSettings,
  boundsInfo: SkillHooksBoundsInfo | undefined,
): SkillHooksUnfitReason | undefined {
  const sourceKind = boundsInfo?.sourceKind ?? 'unknown'
  // Official key: `u??o` — plugin id when present, else source kind.
  const sourceKey = boundsInfo?.pluginId ?? sourceKind

  let entry = skillHooksLedger.get(sourceKey)
  if (!entry) {
    entry = { hooks: 0, characters: 0, texts: new Map(), unfitTexts: 0 }
    skillHooksLedger.set(sourceKey, entry)
  }

  // Official memo `C=_([s,nt(_(T))])` — verdict cached per (skill, hooks).
  const memoKey = createHash('sha256')
    .update(JSON.stringify([skillName, JSON.stringify(hooks)]))
    .digest('hex')
  if (entry.texts.has(memoKey)) {
    return entry.texts.get(memoKey)
  }

  // Official ask computation: per matcher, max(1, hooks.length) hooks and
  // (matcher?.length ?? 0) × that many characters.
  let hooksAsked = 0
  let charactersAsked = 0
  for (const matcher of Object.values(hooks).flatMap(m => m ?? [])) {
    const hookCount = Math.max(1, matcher.hooks.length)
    hooksAsked += hookCount
    charactersAsked += (matcher.matcher?.length ?? 0) * hookCount
  }

  // Official order: characters bound FIRST, then count bound. The third
  // official reason ('matcher', cloud host can't test matchers) is skipped —
  // OCC has no cloud host (recipe step 4).
  let reason: SkillHooksUnfitReason | undefined
  if (entry.characters + charactersAsked > SKILL_MATCHER_CHARS_BOUND) {
    reason = 'characters'
  } else if (entry.hooks + hooksAsked > SKILL_HOOKS_BOUND) {
    reason = 'count'
  }

  if (reason !== undefined) {
    // Official warn cap: at 64 unfit texts for this source, refuse silently
    // (early return — no memo set, no telemetry, no warn).
    if (entry.unfitTexts === SKILL_HOOKS_UNFIT_TEXT_CAP) {
      return reason
    }
    entry.unfitTexts++
  }

  entry.texts.set(memoKey, reason)
  logEvent('tengu_skill_hooks_bounds_checked', {
    outcome: (reason ??
      'fits') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    source_kind:
      sourceKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    hooks_asked: hooksAsked,
    characters_asked: charactersAsked,
    hooks_drawn_before: entry.hooks,
    characters_drawn_before: entry.characters,
    hooks_bound: SKILL_HOOKS_BOUND,
    characters_bound: SKILL_MATCHER_CHARS_BOUND,
  })

  if (reason === undefined) {
    entry.hooks += hooksAsked
    entry.characters += charactersAsked
    return undefined
  }

  // Official warn text, VERBATIM (s304 24873529) — including the cloud-session
  // matcher clause, which stays part of the shared string.
  logForDebugging(
    `Skill '${skillName}' registers none of its hooks and grants no tools (${reason}): the skills of one source hold at most ${SKILL_HOOKS_BOUND} hooks and ${SKILL_MATCHER_CHARS_BOUND} characters of matchers in a session, and a cloud session tests some matchers only`,
    { level: 'warn' },
  )
  // Official then calls the host's `skillHooksDoNotFit(sourceKind)` inside a
  // try/catch — OCC has no plugin-host callback API (recipe step 4), skipped.
  return reason
}

/**
 * Registers hooks from a skill's frontmatter as session hooks.
 *
 * Hooks are registered as session-scoped hooks that persist for the duration
 * of the session. If a hook has `once: true`, it will be automatically removed
 * after its first successful execution — scoped to THIS skill's skillRoot
 * (CC 2.1.304 #39) so an identical hook declared by another skill survives.
 *
 * CC 2.1.304 #60: before registering anything, the skill's ask is checked
 * against the per-source bounds ledger (1024 hooks / 16384 matcher chars).
 * On refusal NOTHING is registered and the reason is returned so the caller
 * can strip allowed-tools and append the model-facing notice (#61).
 *
 * @param setAppState - Function to update the app state
 * @param sessionId - The current session ID
 * @param hooks - The hooks settings from the skill's frontmatter
 * @param skillName - The name of the skill (for logging)
 * @param skillRoot - The base directory of the skill (for CLAUDE_PLUGIN_ROOT env var)
 * @param boundsInfo - Source identity for the #60 bounds ledger (plugin id ?? source kind)
 * @returns The unfit reason when the hooks were kept out by bounds, else undefined
 */
export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  skillName: string,
  skillRoot?: string,
  boundsInfo?: SkillHooksBoundsInfo,
): SkillHooksUnfitReason | undefined {
  const unfitReason = checkSkillHooksBounds(skillName, hooks, boundsInfo)
  if (unfitReason !== undefined) {
    return unfitReason
  }

  let registeredCount = 0

  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    if (!matchers) continue

    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // For once: true hooks, use onHookSuccess callback to remove after
        // execution. CC 2.1.304 #39: pass skillRoot so the removal only
        // unregisters THIS skill's copy (official `e.remove(n,I,D,{skillRoot:s})`).
        const onHookSuccess = hook.once
          ? () => {
              logForDebugging(
                `Removing one-shot hook for event ${eventName} in skill '${skillName}'`,
              )
              removeSessionHook(
                setAppState,
                sessionId,
                eventName,
                hook,
                skillRoot,
              )
            }
          : undefined

        addSessionHook(
          setAppState,
          sessionId,
          eventName,
          matcher.matcher || '',
          hook,
          onHookSuccess,
          skillRoot,
        )
        registeredCount++
      }
    }
  }

  if (registeredCount > 0) {
    logForDebugging(
      `Registered ${registeredCount} hooks from skill '${skillName}'`,
    )
  }

  return undefined
}
