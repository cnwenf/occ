/**
 * Screen reader mode toggle — faithful port of the official claude-code 2.1.206
 * screen-reader subsystem (binary identifiers: class `jhc`, singleton `JBn`,
 * accessors `K2`/`Ghc`/`QXe`, argv helper `f5l`/value-flag set `p5l`).
 *
 * Changelog: "2.1.208 #1 Added screen reader mode" was a user-facing
 * announcement of a 2.1.206 subsystem that OCC had stripped during
 * reconstruction. 206 and 210 binaries are byte-identical for this subsystem
 * (axScreenReader 3/3, CLAUDE_AX_SCREEN_READER 8/8, --ax-screen-reader 6/6).
 *
 * Resolution order (mirrors `jhc.isEnabled()` exactly):
 *   1. `--ax-screen-reader` CLI flag  → source "flag"
 *   2. `CLAUDE_AX_SCREEN_READER` env var → source "env"
 *   3. `axScreenReader` setting        → source "settings"
 *   4. feature gate `tengu_ax_screen_reader` (defaults on) — the SHIPPING
 *      gate. When the gate passes, SR is enabled per the source above; when
 *      it would fail, SR is off regardless.
 *
 * 2.1.307 (since 2.1.305) settings-source gating — changelog: "Changed the
 * axScreenReader setting and CLAUDE_AX_SCREEN_READER in a settings env block
 * to apply only from user, managed or --settings settings":
 *   - settings branch (binary @241429201):
 *       `e=Y8("axScreenReader").find((l)=>Qt(l.source))?.value===!0`
 *     with accessor (binary @240100650):
 *       `var gmi=["policySettings","flagSettings","userSettings"];
 *        function Y8(e){let n=[];for(let r of gmi){let s=pe(r)?.[e];
 *        if(s!==void 0)n.push({source:r,value:s})}return n}`
 *     → first-defined-wins over the three privileged sources, filtered by
 *     enabled sources (`Qt(e){return Io().includes(e)}` @239248799).
 *     projectSettings/localSettings axScreenReader is IGNORED.
 *   - env branch: OCC materializes settings `env` blocks into process.env
 *     (`applyConfigEnvironmentVariables` — full apply for -p mode / post-trust
 *     interactive / mid-session settings change), so a raw process.env read
 *     would let project/local env blocks inject CLAUDE_AX_SCREEN_READER. The
 *     official avoids this by evaluation ordering + early caching (its env
 *     scrubber `ne` @243114612 DOES allow CLAUDE_AX_* keys from settings env
 *     blocks). OCC ports the intent deterministically: the env value resolves
 *     from enabled privileged source env blocks (policy > flag > user — the
 *     official Object.assign materialization order user→flag→policy,
 *     later-wins), else the REAL launch env (pre-settings snapshot; live
 *     process.env only before the snapshot exists).
 *   - warning builder `getScreenReaderProjectSettingsWarning` ports binary
 *     `U()` @241430678 verbatim; the startup caller ports `S7s` @241431432
 *     (announcement wins; warning via console.log — call site @258318961:
 *     `S7s(!St&&process.stdout.isTTY===!0,(s)=>{console.log(s)})`).
 *
 * The feature gate subtlety: official `feature(name, default)` returns
 * `true | undefined`; `?? true` defaults ON when unregistered. OCC's `feature()`
 * returns `true | false`. Adding `'tengu_ax_screen_reader'` to FEATURE_ALLOWLIST
 * makes `feature('tengu_ax_screen_reader')` return `true`, so
 * `feature('tengu_ax_screen_reader') ?? true` = `true` (matches official).
 * Without the allowlist entry, `false ?? true` = `false` (false is not
 * nullish) → SR permanently off even with env/flag/setting set.
 */
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { feature } from './featureFlags.js'
import { isEnvTruthy } from './envUtils.js'
import { peekPreSettingsEnvSnapshot } from './managedEnv.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from './settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * Value-consuming CLI flags (binary: `p5l`). A boolean flag like
 * `--ax-screen-reader` is NOT in this set, but `--settings <path>` IS — its
 * next argv token is a value, not a flag, so the argv scan must skip it.
 *
 * Ported verbatim from the 206 binary's `p5l` Set initializer.
 */
const VALUE_CONSUMING_FLAGS: Set<string> = new Set([
  '--prefill',
  '--prefill-b64',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--deep-link-cwd-b64',
  '--handle-uri',
  '--settings',
  '--managed-settings',
  '--setting-sources',
  '--team-name',
  '--agent-id',
  '--agent-name',
  '--agent-color',
  '--parent-session-id',
  '--agent-type',
  '--model',
  '--agent',
  '--routine',
  '--effort',
  '--permission-mode',
  '--session-id',
])

/**
 * Scan `argv` for a boolean flag, stopping at `--`. Skips the next token when
 * the current token is a value-consuming flag (binary: `f5l`).
 *
 * For a plain boolean flag like `--ax-screen-reader` this is behaviorally
 * equivalent to "appears in argv before `--`"; the value-skip matters only to
 * avoid false matches when a value happens to equal a flag name.
 */
export function hasArgvFlag(
  name: string,
  argv: string[] = process.argv,
): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') break
    if (token === name) return true
    if (token !== undefined && VALUE_CONSUMING_FLAGS.has(token)) i++
  }
  return false
}

type ActivationSource = 'flag' | 'env' | 'settings' | undefined

/**
 * Privileged settings sources for axScreenReader / CLAUDE_AX_SCREEN_READER
 * (binary: `gmi=["policySettings","flagSettings","userSettings"]` @240100650).
 * Order matters — first-defined-wins when resolving the setting value, and
 * policy > flag > user when resolving env blocks (matching the official
 * Object.assign materialization order user→flag→policy, later-wins).
 */
const PRIVILEGED_AX_SETTING_SOURCES = [
  'policySettings',
  'flagSettings',
  'userSettings',
] as const satisfies readonly SettingSource[]

interface PrivilegedAxSettingEntry {
  source: SettingSource
  value: unknown
}

/**
 * Collect every privileged source that DEFINES `axScreenReader`, in
 * policy→flag→user order (binary: `Y8("axScreenReader")` @240100650 —
 * `let s=pe(r)?.[e];if(s!==void 0)n.push({source:r,value:s})`). NOT filtered
 * by enabled sources here; callers filter via `isSettingSourceEnabled`
 * (binary: `Qt`), exactly like the official `.find((l)=>Qt(l.source))` /
 * `.some((i)=>Qt(i.source))` call sites.
 */
function getPrivilegedAxScreenReaderEntries(): PrivilegedAxSettingEntry[] {
  const entries: PrivilegedAxSettingEntry[] = []
  for (const source of PRIVILEGED_AX_SETTING_SOURCES) {
    const value = getSettingsForSource(source)?.axScreenReader
    if (value !== undefined) entries.push({ source, value })
  }
  return entries
}

/**
 * Resolve the effective CLAUDE_AX_SCREEN_READER value for the env branch
 * (see file header — 2.1.307 env-block gating):
 *   1. enabled privileged source env blocks (policy > flag > user),
 *   2. else the REAL launch env (pre-settings snapshot),
 *   3. else live process.env (snapshot not yet captured — e.g. very early
 *      startup or unit tests).
 * Project/local env blocks materialized into process.env by
 * `applyConfigEnvironmentVariables` are therefore NOT honored.
 */
function resolveAxScreenReaderEnvValue(): string | undefined {
  for (const source of PRIVILEGED_AX_SETTING_SOURCES) {
    if (!isSettingSourceEnabled(source)) continue
    const value = getSettingsForSource(source)?.env?.CLAUDE_AX_SCREEN_READER
    if (value !== undefined) return String(value)
  }
  const snapshot = peekPreSettingsEnvSnapshot()
  if (snapshot !== undefined) return snapshot.CLAUDE_AX_SCREEN_READER
  return process.env.CLAUDE_AX_SCREEN_READER
}

/**
 * Path sanitizer for the warning message (binary: `hd` @239641041 —
 * `BE(Ab(e)).replace(/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,"")` where
 * `BE`=stripVTControlCharacters; identical regex to OCC's private
 * `sanitizeMessageText` in settings/allowedProvidersEnforcement.ts).
 */
function sanitizeAxPathText(path: string): string {
  return stripVTControlCharacters(path).replace(
    /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    '',
  )
}

/**
 * Screen reader toggle (binary: `class jhc`). Caches the enabled decision and
 * the activation source. `#e` (binary) = enabled cache, `#t` = source.
 */
class ScreenReaderToggle {
  private enabled?: boolean
  private source?: ActivationSource

  isEnabled(): boolean {
    if (this.enabled !== undefined) return this.enabled
    let e: boolean | undefined
    let t: ActivationSource
    if (hasArgvFlag('--ax-screen-reader')) {
      e = true
      t = 'flag'
    } else {
      const envVal = resolveAxScreenReaderEnvValue()
      if (envVal !== undefined) {
        e = isEnvTruthy(envVal)
        t = 'env'
      } else {
        // 2.1.307 (binary @241429201): first-defined-wins over the privileged
        // sources [policy, flag, user], filtered by enabled sources.
        // projectSettings/localSettings are IGNORED.
        e =
          getPrivilegedAxScreenReaderEntries().find(l =>
            isSettingSourceEnabled(l.source),
          )?.value === true
        t = 'settings'
      }
    }
    if (!e) {
      this.enabled = false
      return false
    }
    // Feature gate (binary: `t0i?.(rgh, !0) ?? !0`). `t0i` is the lazy
    // `feature` fn; `rgh = "tengu_ax_screen_reader"`. `?.()` because t0i starts
    // null in the official build; OCC's `feature` is always defined. The `?? !0`
    // default means "when the flag is unregistered, SR defaults ON". OCC's
    // `feature()` returns boolean, so the allowlist membership is load-bearing
    // (see file header).
    const gate = feature('tengu_ax_screen_reader') ?? true
    this.source = gate ? t : undefined
    this.enabled = gate
    return gate
  }

  activationSource(): ActivationSource {
    return this.isEnabled() ? this.source : undefined
  }

  reset(): void {
    this.enabled = undefined
    this.source = undefined
  }
}

/** Singleton (binary: `JBn = new jhc(...)`). */
export const screenReader = new ScreenReaderToggle()

/** Whether screen reader mode is enabled (binary: `K2()`). */
export function isScreenReaderEnabled(): boolean {
  return screenReader.isEnabled()
}

/**
 * Startup announcement line (binary: `Ghc()`). Returns the bracketed status
 * line when SR is on, or `null` when off. Caller writes it to stdout once at
 * interactive startup so a screen reader can announce the mode.
 */
export function getScreenReaderAnnouncement(): string | null {
  if (screenReader.isEnabled()) {
    const src = screenReader.activationSource()
    return src
      ? `[Screen Reader Mode: on via ${src}]`
      : '[Screen Reader Mode: on]'
  }
  return null
}

/**
 * Project-settings warning (2.1.307; binary: `U()` @241430678, verbatim):
 *
 *   function U(){{if(o().isEnabled()||rS("--ax-screen-reader")||
 *   a.CLAUDE_AX_SCREEN_READER!==void 0||
 *   Y8("axScreenReader").some((i)=>Qt(i.source)))return null;
 *   if(!["projectSettings","localSettings"].some((i)=>{
 *     let s=Qt(i)?pe(i):null;
 *     return s?.axScreenReader===!0||Object.entries(s?.env??{}).some(
 *       ([u,c])=>u.toUpperCase()==="CLAUDE_AX_SCREEN_READER"&&$e(c))}))
 *     return null;
 *   let n="start Claude Code with --ax-screen-reader";
 *   if(!Qt("userSettings"))return`Screen reader mode is off: project settings
 *     can't turn it on. To turn it on, ${n}.`;
 *   let t=x(),r=hd(sn("userSettings")??C(t,".claude","settings.json"))
 *     .replace(/[\t\n]/g," "),
 *     l=r.startsWith(t+D)?`~${r.slice(t.length)}`:r;
 *   return`Screen reader mode is off: project settings can't turn it on.
 *     To turn it on, ${n}, or add "axScreenReader": true to your own settings
 *     file at ${l} and restart.`}return null}
 *
 * Returns the warning when SR is off but project/local settings attempt to
 * turn it on (via `axScreenReader: true` or an env-block
 * CLAUDE_AX_SCREEN_READER with a truthy value), else `null`. Suppressed when
 * SR is on, the CLI flag is present, CLAUDE_AX_SCREEN_READER is DEFINED in
 * the effective env (even falsy), or any enabled privileged source defines
 * `axScreenReader` (even false). The env guard uses the same gated resolver
 * as `isEnabled()` (see file header). `hd` = `sanitizeAxPathText`; `x()` =
 * homedir; `C` = path.join; `D` = path.sep; `$e` = isEnvTruthy.
 *
 * Startup caller (binary `S7s` @241431432 → call site @258318961
 * `S7s(!St&&process.stdout.isTTY===!0,(s)=>{console.log(s)})`): the
 * announcement wins; when there is no announcement, this warning is written
 * to stdout via console.log (NOT the SR announce queue — the queue only
 * drains when SR is on, and this warning only fires when SR is off).
 */
export function getScreenReaderProjectSettingsWarning(): string | null {
  if (
    screenReader.isEnabled() ||
    hasArgvFlag('--ax-screen-reader') ||
    resolveAxScreenReaderEnvValue() !== undefined ||
    getPrivilegedAxScreenReaderEntries().some(i =>
      isSettingSourceEnabled(i.source),
    )
  )
    return null
  const projectAttempted = (
    ['projectSettings', 'localSettings'] as const
  ).some(i => {
    const s = isSettingSourceEnabled(i) ? getSettingsForSource(i) : null
    return (
      s?.axScreenReader === true ||
      Object.entries(s?.env ?? {}).some(
        ([u, c]) =>
          u.toUpperCase() === 'CLAUDE_AX_SCREEN_READER' && isEnvTruthy(c),
      )
    )
  })
  if (!projectAttempted) return null
  const n = 'start Claude Code with --ax-screen-reader'
  if (!isSettingSourceEnabled('userSettings'))
    return `Screen reader mode is off: project settings can't turn it on. To turn it on, ${n}.`
  const t = homedir()
  const r = sanitizeAxPathText(
    getSettingsFilePathForSource('userSettings') ??
      join(t, '.claude', 'settings.json'),
  ).replace(/[\t\n]/g, ' ')
  const l = r.startsWith(t + sep) ? `~${r.slice(t.length)}` : r
  return `Screen reader mode is off: project settings can't turn it on. To turn it on, ${n}, or add "axScreenReader": true to your own settings file at ${l} and restart.`
}

/**
 * Env vars to propagate to subprocesses when SR is on (binary: `QXe()`).
 * Spreading this into a subprocess env ensures child processes (Bash, MCP,
 * LSP, /tui restart) inherit the SR-on state regardless of how it was
 * activated (flag/setting/env). Returns `{}` when SR is off.
 */
export function getScreenReaderEnv(): Record<string, string> {
  if (screenReader.isEnabled()) {
    return { CLAUDE_AX_SCREEN_READER: '1' }
  }
  return {}
}

// ──────────────── Announce queue (binary: `cxc`/`uxc`, `yAt`, `oxc`) ────────

/**
 * Max announce entries retained (binary: `oxc = 16`). When the queue exceeds
 * this, oldest entries are trimmed to prevent unbounded growth when SR is off
 * (the queue is only drained by `onRenderScreenReader`, which runs solely when
 * SR is on — entries pushed while SR is off are silently dropped on overflow).
 */
const SR_ANNOUNCE_MAX = 16

/**
 * FIFO of pending announce strings (binary: `yAt`). Drained by the SR
 * flat-render path each frame and emitted as flat text lines so the screen
 * reader speaks them. 2.1.210 #30: Shift+Tab permission-mode cycle pushes
 * `[${mode-indicator} on]` here, and the next SR render writes it aloud.
 */
let srAnnounceQueue: string[] = []

/**
 * 2.1.288 #66/#7 — hold-requested flag (binary: `#t` on class `E`). Set by
 * `pushScreenReaderAnnouncement(str, {hold: true})`; consumed exactly once by
 * `consumeScreenReaderAnnouncementHoldMs()` (binary: `takeHoldRequest()`).
 * Also cleared by `endScreenReaderAnnouncementHold()` (binary: `endHold()`
 * sets `#a=0,#t=!1`) and by `resetScreenReaderAnnouncements()`.
 */
let srHoldRequested = false

/**
 * 2.1.288 #66 — absolute hold-window deadline in epoch ms (binary: `#a`).
 * While `Date.now() < srHoldUntilMs`, the SR renderer freezes re-renders so
 * the held announcement stays the last thing on screen (binary:
 * `holdActive(e){return e<this.#a}`). 0 = no active hold.
 */
let srHoldUntilMs = 0

/**
 * Default hold duration in ms (binary: `a.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS??1000`).
 */
const SR_ANNOUNCEMENT_HOLD_DEFAULT_MS = 1000

/**
 * Upper cap for the hold duration (binary: `Math.min(…,1e4)` in `t9o`).
 */
const SR_ANNOUNCEMENT_HOLD_MAX_MS = 10_000

/**
 * Push an announce string to the SR queue (binary: `cxc(e)` / 2.1.288 `QW(e,n)`).
 * The string is emitted verbatim (after sanitization + wrapping) by the next
 * SR flat-render frame. Not gated on SR being enabled — the drain
 * (`drainScreenReaderAnnouncements`) only runs in `onRenderScreenReader`,
 * which is only called when SR is on, so pushes while SR is off are silently
 * dropped on overflow.
 *
 * 2.1.288 #7/#66: `{hold: true}` additionally raises the hold-request flag
 * (binary: `queueAnnouncement(e,n=!1){if(this.#e.push(e),n)this.#t=!0;…}`),
 * which makes the next SR render arm a hold window (render freeze) so the
 * announcement isn't immediately overwritten. Only the permission-mode
 * announcements push with hold in the official binary (`{hold:!0}` occurs
 * exactly twice — the dialog helper `HE` and the REPL initialMessage
 * consumer, both `[${TL(mode)} on]`).
 */
export function pushScreenReaderAnnouncement(
  str: string,
  options?: { hold?: boolean },
): void {
  srAnnounceQueue.push(str)
  if (options?.hold === true) srHoldRequested = true
  if (srAnnounceQueue.length > SR_ANNOUNCE_MAX) {
    srAnnounceQueue.splice(0, srAnnounceQueue.length - SR_ANNOUNCE_MAX)
  }
}

/**
 * Drain and return pending announce strings (binary: `uxc()`). Returns an
 * empty array when nothing is pending. The caller (SR flat-render) sanitizes,
 * wraps, and appends each entry to the flat-text line array, then forces the
 * diff to re-emit from the insertion point so the screen reader speaks them.
 */
export function drainScreenReaderAnnouncements(): string[] {
  if (srAnnounceQueue.length === 0) return []
  const drained = srAnnounceQueue
  srAnnounceQueue = []
  return drained
}

/**
 * Clear the announce queue (test isolation / SR reset). 2.1.288: official
 * class `E.reset()` also clears the hold state (`#e.length=0,#t=!1,#a=0`),
 * so the pending hold request and active hold window are cleared here too.
 */
export function resetScreenReaderAnnouncements(): void {
  srAnnounceQueue = []
  srHoldRequested = false
  srHoldUntilMs = 0
}

// ──────────────── Announcement hold (2.1.288 #66; binary: `t9o`/`n9o`/`zWe`/`r9o`) ────────────────

/**
 * Consume the pending hold request and return the hold duration in ms
 * (binary: `t9o()`):
 *
 *   function t9o(){if(r().takeHoldRequest())
 *     return Math.min(a.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS??1000,1e4);return 0}
 *
 * Returns 0 when no `{hold: true}` push is pending. The flag is one-shot —
 * taking it clears it (binary: `takeHoldRequest(){let e=this.#t;return
 * this.#t=!1,e}`). `CLAUDE_AX_ANNOUNCEMENT_HOLD_MS` overrides the 1000ms
 * default, capped at 10s. Official reads a schema-typed env record (`a.`);
 * OCC parses the raw string — a non-numeric value falls back to the default
 * (official `??1000` covers undefined; NaN coercion is OCC-defined).
 */
export function consumeScreenReaderAnnouncementHoldMs(): number {
  const held = srHoldRequested
  srHoldRequested = false
  if (!held) return 0
  const raw = process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  const ms = Number.isNaN(parsed) ? SR_ANNOUNCEMENT_HOLD_DEFAULT_MS : parsed
  return Math.min(ms, SR_ANNOUNCEMENT_HOLD_MAX_MS)
}

/**
 * Open the hold window for `ms` milliseconds (binary: `n9o(e){r().startHold(
 * Date.now()+e)}`). While active, `isScreenReaderAnnouncementHoldActive()`
 * returns true and the SR renderer skips re-renders (render freeze) so the
 * held announcement stays on screen.
 */
export function startScreenReaderAnnouncementHold(ms: number): void {
  srHoldUntilMs = Date.now() + ms
}

/**
 * Close the hold window and discard any pending hold request (binary:
 * `zWe()` → `endHold(){this.#a=0,this.#t=!1}`). Called on keypress so user
 * input immediately wins over a frozen SR frame.
 */
export function endScreenReaderAnnouncementHold(): void {
  srHoldUntilMs = 0
  srHoldRequested = false
}

/** Whether the hold window is currently active (binary: `r9o(){return
 * r().holdActive(Date.now())}` → `holdActive(e){return e<this.#a}`). */
export function isScreenReaderAnnouncementHoldActive(): boolean {
  return Date.now() < srHoldUntilMs
}

/**
 * Whether held announcements may be rewritten by changed lines above
 * (binary: `Z8o(){return a.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT??!1}`).
 * Default false: when the lines above a held announcement change, the held
 * lines are dropped instead of being re-emitted in a rewritten frame.
 */
export function shouldRewriteHeldScreenReaderAnnouncement(): boolean {
  return isEnvTruthy(process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT)
}
