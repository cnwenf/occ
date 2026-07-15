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
 * The feature gate subtlety: official `feature(name, default)` returns
 * `true | undefined`; `?? true` defaults ON when unregistered. OCC's `feature()`
 * returns `true | false`. Adding `'tengu_ax_screen_reader'` to FEATURE_ALLOWLIST
 * makes `feature('tengu_ax_screen_reader')` return `true`, so
 * `feature('tengu_ax_screen_reader') ?? true` = `true` (matches official).
 * Without the allowlist entry, `false ?? true` = `false` (false is not
 * nullish) → SR permanently off even with env/flag/setting set.
 */
import { feature } from './featureFlags.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

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
      const envVal = process.env.CLAUDE_AX_SCREEN_READER
      if (envVal !== undefined) {
        e = isEnvTruthy(envVal)
        t = 'env'
      } else {
        e = getInitialSettings().axScreenReader === true
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
 * Push an announce string to the SR queue (binary: `cxc(e)`). The string is
 * emitted verbatim (after sanitization + wrapping) by the next SR flat-render
 * frame. Not gated on SR being enabled — the drain (`drainScreenReaderAnnouncements`)
 * only runs in `onRenderScreenReader`, which is only called when SR is on, so
 * pushes while SR is off are silently dropped on overflow.
 */
export function pushScreenReaderAnnouncement(str: string): void {
  srAnnounceQueue.push(str)
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

/** Clear the announce queue (test isolation / SR reset). */
export function resetScreenReaderAnnouncements(): void {
  srAnnounceQueue = []
}
