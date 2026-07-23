/**
 * Screen-reader a11y decision helpers — faithful port of the official
 * claude-code 2.1.217/2.1.218 a11y cluster.
 *
 * These are pure decision/emission functions over the SR announce queue, kept
 * separate from the Ink render path so they can be unit-tested with a mock
 * announcement sink (the visual SR flat-render is verified separately / via
 * non-sandbox e2e — OCC-11).
 *
 * Reuses OCC's existing announcement surface (`pushScreenReaderAnnouncement`
 * from `screenReader.js`, binary `cxc`) — no new render primitive is introduced.
 */
import {
  pushScreenReaderAnnouncement,
} from './screenReader.js'

/**
 * 2.1.218 #2: announce the deleted text for word and line deletions
 * (`Option+Delete`, `Ctrl+W`, `Cmd+Backspace`, `Ctrl+U`, `Ctrl+K`) in
 * `--ax-screen-reader` mode. Pushes the killed text to the SR announce queue so
 * the screen reader speaks the deleted word/line aloud. No-op when the killed
 * text is empty (nothing was deleted).
 *
 * Default sink is the global SR announce queue (binary `cxc`); tests inject a
 * mock sink to assert the emitted string contains the deleted text.
 */
export function announceDeletedText(
  deletedText: string,
  sink: (str: string) => void = pushScreenReaderAnnouncement,
): void {
  if (deletedText.length > 0) {
    sink(deletedText)
  }
}

/**
 * 2.1.218 #14: VoiceOver read "new line" instead of echoing a typed space at
 * the end of the input — the SR flat-render trims trailing whitespace, so the
 * space was not spoken and VoiceOver announced the line boundary as "new line".
 * Echo the space explicitly as a single space so it is spoken as a space.
 *
 * Returns `' '` for a space char (the echo to push), or `null` for any other
 * char (no echo — non-space chars are already spoken via the flat-render).
 */
export function srEchoTypedChar(char: string): string | null {
  if (char === ' ') {
    return ' '
  }
  return null
}

/**
 * 2.1.217 #8(a): the startup SR announcement (`[Screen Reader Mode: on …]`)
 * was written to stdout via a standalone `console.log` and immediately cut off
 * by the first prompt render overwriting the line. Route it through the SR
 * announce queue instead so it is emitted by the SR flat-render as part of the
 * render stream — the first prompt render no longer cuts it off.
 *
 * Accepts the already-built announcement string (binary `Ghc()` output) so the
 * format stays single-sourced in `screenReader.js`. `null` (SR off) is a no-op.
 */
export function emitStartupSrAnnouncement(
  announce: string | null,
  sink: (str: string) => void = pushScreenReaderAnnouncement,
): void {
  if (announce !== null && announce.length > 0) {
    sink(announce)
  }
}

/**
 * 2.1.217 #8(b): in SR mode the spinner's 50ms animation clock drove re-renders
 * that updated the elapsed-time timer and token counts every few seconds; each
 * such update re-emitted the SR flat-render and interrupted the screen reader.
 * Force reduced motion in SR mode so the animation clock is disabled and the
 * thinking status row stops re-rendering periodically.
 */
export function computeSpinnerReducedMotion(
  settingsReducedMotion: boolean,
  isSr: boolean,
): boolean {
  return settingsReducedMotion || isSr
}

/**
 * 2.1.217 #8(b): the thinking status row should only update when the DISPLAYED
 * value (rounded seconds or token count) actually changes — not on every
 * animation tick. Returns `true` when the row should re-emit. Used to gate the
 * timer/token text so sub-second drift or unchanged token counts do not trigger
 * an SR flat-render re-emit.
 */
export function shouldThinkingRowUpdate(
  prev: { seconds: number; tokens: number },
  next: { seconds: number; tokens: number },
): boolean {
  return prev.seconds !== next.seconds || prev.tokens !== next.tokens
}
