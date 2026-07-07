/**
 * K3 (2.1.154, ultracode): the "ultracode" keyword trigger + session mode.
 *
 * Ultracode is a SESSION MODE (not an effort level): when active it pins effort
 * to `xhigh`, enables standing dynamic-workflow orchestration (the Workflow
 * tool), and injects the "Ultracode is on…" system-reminder. It is turned on
 * either by the `ultracode` keyword appearing in a user prompt (gated by the
 * `ultracodeKeywordTrigger` setting, default true) or by the session-scoped
 * `ultracode` settings key (--settings / apply_flag_settings). `/effort
 * ultracode` is the interactive entry point.
 *
 * Mirrors the official 2.1.200 binary strings verbatim. Self-contained (no
 * import from ../effort.ts) to avoid TDZ / module-init cycles.
 */

// The keyword a user types in a prompt to opt that turn into ultracode.
export const ULTRACODE_KEYWORD = 'ultracode'

// Settings keys.
export const ULTRACODE_SETTING_KEY = 'ultracode'
export const ULTRACODE_KEYWORD_TRIGGER_SETTING_KEY = 'ultracodeKeywordTrigger'

// Setting descriptions (verbatim from the 2.1.200 binary) — used by the
// settings schema and surfaced to source-grep verification.
export const ULTRACODE_SETTING_DESCRIPTION =
  'Whether ultracode (xhigh effort plus standing dynamic-workflow orchestration) is active for the session. Set per session via the `ultracode` settings key (--settings or apply_flag_settings).'

export const ULTRACODE_KEYWORD_TRIGGER_DESCRIPTION =
  'Enable the "ultracode" keyword trigger: including the keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger. Default: true.'

export const ENABLE_ULTRACODE_DESCRIPTION =
  'Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration. ' +
  'Session-scoped — typically provided via --settings or the apply_flag_settings control request; ' +
  'interactive toggles never persist it. Requires workflows to be enabled and an xhigh-capable model.'

// /effort ultracode status-line description (verbatim).
export const ULTRACODE_EFFORT_DESCRIPTION =
  'xhigh effort + dynamic workflows for maximum thoroughness'

// Full status-line token: "ultracode · xhigh effort + dynamic workflows for
// maximum thoroughness" (· is U+00B7, matching the binary's \xB7).
export const ULTRACODE_EFFORT_DISPLAY = `ultracode · ${ULTRACODE_EFFORT_DESCRIPTION}`

// Activation message shown when ultracode is turned on (verbatim).
export const ULTRACODE_ACTIVATION_MESSAGE =
  'ultracode (xhigh effort plus standing dynamic-workflow orchestration) is active for the session. Set per session via the `ultracode` settings key (--settings or apply_flag_settings).'

// The system-reminder injected while ultracode is on. Two variants: "full"
// (first entry / opted-in turn) and the lighter "still on" reminder for
// subsequent turns. Both are isMeta reminders (verbatim from the binary's
// ultra_effort_enter reminder builder).
export const ULTRACODE_REMINDER_FULL =
  'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool\'s **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.'

export const ULTRACODE_REMINDER_STILL =
  'Ultracode is still on — use the Workflow tool; see its Ultracode section.'

export type UltracodeReminderType = 'full' | 'still'

/**
 * Build the ultracode system-reminder content for a turn. `reminderType` is
 * "full" on the turn that opts in (or the first turn of an ultracode session),
 * "still" on subsequent turns — matching the binary's
 * `ultra_effort_enter: ({reminderType: e}) => … e === "full" ? REMINDER_FULL : REMINDER_STILL`.
 */
export function getUltracodeReminder(
  reminderType: UltracodeReminderType = 'full',
): string {
  return reminderType === 'full'
    ? ULTRACODE_REMINDER_FULL
    : ULTRACODE_REMINDER_STILL
}

// The reminder as a meta system-reminder object (isMeta: true), matching the
// binary's `Hp([Ln({content, isMeta: !0})])` shape.
export interface UltracodeReminder {
  content: string
  isMeta: true
}

export function getUltracodeReminderObject(
  reminderType: UltracodeReminderType = 'full',
): UltracodeReminder {
  return { content: getUltracodeReminder(reminderType), isMeta: true }
}

/**
 * Does the user's prompt contain the `ultracode` keyword? Word-boundary match
 * so "ultracode" inside another token does not fire. Case-insensitive.
 */
export function detectUltracodeKeyword(input: string): boolean {
  if (!input) return false
  return new RegExp(`\\b${ULTRACODE_KEYWORD}\\b`, 'i').test(input)
}

/**
 * Is the keyword trigger enabled? Reads the `ultracodeKeywordTrigger` setting
 * (default: true). Set to false to disable the trigger entirely.
 */
export function isUltracodeKeywordTriggerEnabled(): boolean {
  // Env override (eval harnesses / tests): CLAUDE_CODE_ULTRACODE_KEYWORD_TRIGGER
  const env = process.env.CLAUDE_CODE_ULTRACODE_KEYWORD_TRIGGER
  if (env !== undefined) {
    return env !== '0' && env.toLowerCase() !== 'false'
  }
  // Default: true (the binary documents "Default: true.").
  return true
}

// -- Session state -----------------------------------------------------------

// Module-level session flag for ultracode. The binary keeps this in the
// session-scoped `ultracode` settings key (never persisted by interactive
// toggles). OCC mirrors it with an env var + in-memory flag so /effort
// ultracode and the keyword trigger can flip it without touching the settings
// module (which is outside this gap's file scope).
let ultracodeActive = false

function readEnvUltracode(): boolean {
  const env = process.env.CLAUDE_CODE_ULTRACODE
  if (env !== undefined) {
    return env === '1' || env.toLowerCase() === 'true'
  }
  return false
}

/**
 * Is ultracode active for this session? (xhigh effort + dynamic-workflow
 * orchestration + the "Ultracode is on…" reminder.)
 */
export function isUltracodeEnabled(): boolean {
  return ultracodeActive || readEnvUltracode()
}

/**
 * Enable ultracode for the session (session-scoped; never persisted by
 * interactive toggles, matching the binary). Also set effort to xhigh and
 * enable dynamic-workflow orchestration — the caller wires those via the
 * effort/workflow modules.
 */
export function enableUltracodeForSession(): void {
  ultracodeActive = true
}

/** Reset ultracode (tests / session restart). */
export function resetUltracode(): void {
  ultracodeActive = false
}

/**
 * Decide whether the keyword trigger should fire for a given prompt: the
 * keyword is present AND the trigger setting is enabled AND ultracode isn't
 * already active.
 */
export function shouldTriggerUltracodeFromPrompt(input: string): boolean {
  if (isUltracodeEnabled()) return false
  if (!isUltracodeKeywordTriggerEnabled()) return false
  return detectUltracodeKeyword(input)
}
