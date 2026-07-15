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

// workflow_keyword_request reminder (verbatim from the 2.1.206 binary's
// workflow_keyword_request builder): injected on the keyword-trigger turn,
// alongside ultra_effort_enter("full"), to tell the model the user opted this
// turn into multi-agent orchestration and it should use the Workflow tool.
export const ULTRACODE_WORKFLOW_KEYWORD_REQUEST =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.'

// ultra_effort_exit reminder (verbatim from the 2.1.206 binary's
// ultra_effort_exit builder): injected on the turn ultracode is turned off,
// telling the model the standing opt-in has ended and the Workflow tool's
// standard opt-in rule applies again.
export const ULTRACODE_EXIT_REMINDER =
  "Ultracode is off — the Workflow tool's standard opt-in rule applies again."

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
 *
 * Mirrors the 2.1.210 binary's `WFn()`:
 *   function WFn(){return IP()?.settings.workflowKeywordTriggerEnabled ?? !0}
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

// Turn-state flags consumed by getUltracodeTurnReminders(). `ultracodeJustEnabled`
// is set by enableUltracodeForSession() (keyword trigger or /effort ultracode) and
// cleared on the first turn's reminder read — so the keyword-trigger turn emits both
// the workflow_keyword_request reminder and the ultra_effort_enter("full") reminder,
// matching the 2.1.206 binary. `ultracodeJustDisabled` is set by
// disableUltracodeForSession() and cleared on the next turn — emitting the
// ultra_effort_exit reminder for one turn, then nothing.
let ultracodeJustEnabled = false
let ultracodeJustDisabled = false

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
 * effort/workflow modules. Sets `ultracodeJustEnabled` so the keyword-trigger
 * turn (or /effort ultracode turn) emits the workflow_keyword_request +
 * ultra_effort_enter("full") reminders via getUltracodeTurnReminders().
 */
export function enableUltracodeForSession(): void {
  ultracodeActive = true
  ultracodeJustEnabled = true
  ultracodeJustDisabled = false
}

/**
 * Disable ultracode for the session. Sets `ultracodeJustDisabled` so the next
 * turn emits the ultra_effort_exit reminder via getUltracodeTurnReminders(),
 * matching the 2.1.206 binary's ultra_effort_exit builder.
 */
export function disableUltracodeForSession(): void {
  if (ultracodeActive || readEnvUltracode()) {
    ultracodeJustDisabled = true
  }
  ultracodeActive = false
  ultracodeJustEnabled = false
}

/** Reset ultracode (tests / session restart). */
export function resetUltracode(): void {
  ultracodeActive = false
  ultracodeJustEnabled = false
  ultracodeJustDisabled = false
}

/**
 * The per-turn ultracode reminders to inject into the API request, matching
 * the 2.1.206 binary's per-turn reminder dispatch:
 *
 * - keyword-trigger turn (ultracodeJustEnabled): [workflow_keyword_request, ultra_effort_enter("full")]
 * - subsequent ultracode turns:                [ultra_effort_enter("still")]
 * - the turn ultracode is turned off:          [ultra_effort_exit]
 * - otherwise (ultracode never on):            []
 *
 * Consumes (clears) the `ultracodeJustEnabled` / `ultracodeJustDisabled` flags
 * so the keyword-request and exit reminders fire for exactly one turn. The
 * query loop (src/query.ts) calls this once per turn and maps each returned
 * reminder into a user-role isMeta message via buildHarnessReminderMessage().
 */
export function getUltracodeTurnReminders(): UltracodeReminder[] {
  const reminders: UltracodeReminder[] = []
  if (ultracodeJustDisabled) {
    reminders.push({ content: ULTRACODE_EXIT_REMINDER, isMeta: true })
    ultracodeJustDisabled = false
    return reminders
  }
  if (!isUltracodeEnabled()) return reminders
  if (ultracodeJustEnabled) {
    reminders.push({
      content: ULTRACODE_WORKFLOW_KEYWORD_REQUEST,
      isMeta: true,
    })
    reminders.push(getUltracodeReminderObject('full'))
    ultracodeJustEnabled = false
  } else {
    reminders.push(getUltracodeReminderObject('still'))
  }
  return reminders
}

// -- CC 2.1.210 #4: human-origin guard ---------------------------------------
//
// 2.1.210 fixed the ultracode keyword opt-in firing on non-human-originated
// input such as webhook payloads and relayed PR comments. The binary gates the
// workflow_keyword_request (ultracode keyword) opt-in behind `isHumanTypedPrompt`:
//
//   function UVn(e){return e?.kind==="human"}                 // origin check
//   let X = (mode === "prompt") && !skip                       // isRegularUserPrompt
//   let J = X && UVn(b)                                        // isHumanTypedPrompt
//   {isRegularUserPrompt:X, isHumanTypedPrompt:J, ...}        // attachment opts `s`
//   workflow_keyword_request fires iff
//     s?.isHumanTypedPrompt && !s.suppressWorkflowKeyword && WFn() && keyword
//
// `origin` is a `{ kind }` object. `kind:"human"` is asserted only for
// claude_code_cli / claude_code_vscode platforms (interactive REPL, `occ -p`,
// SDK); programmatic / relayed input (webhook payloads, relayed PR comments,
// auto-continuations, task notifications, peer messages) carries a different
// kind or no origin, so `UVn` returns false and the opt-in does not fire.

export type PromptOriginKind =
  | 'human'
  | 'webhook'
  | 'relay'
  | 'auto-continuation'
  | 'task-notification'
  | 'peer'
  // (string & {}) keeps the union open to arbitrary literal kinds without
  // widening to `string`, mirroring the binary's permissive `{ kind }` shape.
  | (string & {})

export interface PromptOrigin {
  kind: PromptOriginKind
}

/** The origin carried by human-typed prompts (interactive REPL, `occ -p`, SDK). */
export const HUMAN_PROMPT_ORIGIN: PromptOrigin = { kind: 'human' }

/**
 * Mirrors the 2.1.210 binary's `UVn(e){return e?.kind==="human"}`: returns true
 * only when the prompt origin is explicitly human-typed. Non-human origins
 * (webhook payloads, relayed PR comments, auto-continuations, task
 * notifications, peer/relayed messages) return false, so the ultracode keyword
 * opt-in does not fire on them (CC 2.1.210 #4).
 */
export function isHumanTypedPrompt(origin?: PromptOrigin | null): boolean {
  return origin?.kind === 'human'
}

/**
 * Decide whether the keyword trigger should fire for a given prompt: the
 * keyword is present AND the trigger setting is enabled AND ultracode isn't
 * already active AND the prompt is human-originated. The human-origin guard is
 * CC 2.1.210 #4 — the opt-in must not fire on webhook payloads / relayed PR
 * comments / other non-human input. `origin` defaults to human for
 * human-typed callers (interactive REPL, `occ -p`, SDK); programmatic /
 * relayed callers pass a non-human origin so the trigger is suppressed.
 */
export function shouldTriggerUltracodeFromPrompt(
  input: string,
  origin: PromptOrigin = HUMAN_PROMPT_ORIGIN,
): boolean {
  if (isUltracodeEnabled()) return false
  if (!isUltracodeKeywordTriggerEnabled()) return false
  if (!isHumanTypedPrompt(origin)) return false
  return detectUltracodeKeyword(input)
}
