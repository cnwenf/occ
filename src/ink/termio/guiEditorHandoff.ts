/**
 * Terminal mode sequences for the GUI-editor handoff.
 *
 * 2.1.216 #16: while a GUI editor (VS Code, Sublime, etc.) is open and the
 * TUI is paused (blocking on the editor process), the terminal must disable
 * mouse tracking, focus reporting, and the Kitty/modifyOtherKeys keyboard
 * protocols. Without this, SGR mouse sequences and focus events accumulate
 * as garbage in the input buffer while stdin is suspended — they surface as
 * garbled keystrokes when the editor exits and stdin resumes.
 *
 * These helpers mirror the mode toggling in
 * {@link Ink.enterAlternateScreen} / {@link Ink.exitAlternateScreen}, minus
 * the alt-screen switch: GUI editors open in their own window, so we keep
 * the alt buffer intact and only toggle the protocols that emit spurious
 * events while paused.
 */
import { printsUnknownSequences } from '../terminal.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
} from './csi.js'
import { DFE, DISABLE_MOUSE_TRACKING, EFE, ENABLE_MOUSE_TRACKING } from './dec.js'

/**
 * CC 2.1.301 (occ160 WP-H): VTE < 0.53 prints unrecognized `CSI >`/`CSI <`
 * private sequences as literal text (`<u`, `>4m`, `>1u`, `>4;2m` land on
 * screen). Official gates every keyboard-protocol emission through
 * `lvt()`/`o0e()`/`dvt()` (@231683280) which return "" when
 * `printsUnknownSequences()` (official `b6()`) is true — extended keys are
 * never enabled on such terminals either (capability resolution reports
 * `settled:!1`, @231674646), so there is nothing to disable or restore.
 */
function extendedKeysSeqs(off: string, on: string): string {
  return printsUnknownSequences() ? '' : off + on
}

/**
 * Build the terminal-mode disable sequence emitted before handing the
 * terminal to a blocking GUI editor launch.
 *
 * @param mouseTrackingOn whether mouse tracking (DECSET 1003/1006) is
 *   currently enabled (i.e. fullscreen/alt-screen active). When false, the
 *   mouse-tracking disable is omitted as a no-op.
 * @returns the escape-sequence string to write to stdout.
 */
export function guiEditorModeDisableSeq(mouseTrackingOn: boolean): string {
  // Disable extended key reporting first — editors that don't speak CSI-u
  // (e.g. nano) would otherwise show "Unknown sequence" for Ctrl-<key>.
  return (
    extendedKeysSeqs(DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS) +
    (mouseTrackingOn ? DISABLE_MOUSE_TRACKING : '') +
    DFE // disable focus reporting (?1004l)
  )
}

/**
 * Build the terminal-mode restore sequence emitted after a blocking GUI
 * editor returns control.
 *
 * @param mouseTrackingOn whether mouse tracking was enabled before the
 *   handoff (must match the value passed to {@link guiEditorModeDisableSeq}).
 * @returns the escape-sequence string to write to stdout.
 */
export function guiEditorModeRestoreSeq(mouseTrackingOn: boolean): string {
  return (
    (mouseTrackingOn ? ENABLE_MOUSE_TRACKING : '') +
    EFE + // re-enable focus reporting (?1004h)
    // Kitty stack: pop (disable) then push (enable) to keep depth balanced.
    // A well-behaved editor restores our entry level, so without the pop we'd
    // accumulate depth on each editor round-trip; pop-on-empty is a no-op.
    extendedKeysSeqs(
      DISABLE_KITTY_KEYBOARD,
      ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS,
    )
  )
}
