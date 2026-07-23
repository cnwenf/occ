import { describe, expect, test } from 'bun:test'
import {
  guiEditorModeDisableSeq,
  guiEditorModeRestoreSeq,
} from './guiEditorHandoff.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
} from './csi.js'
import {
  DFE,
  DISABLE_MOUSE_TRACKING,
  EFE,
  ENABLE_MOUSE_TRACKING,
} from './dec.js'

// 2.1.216 #16: while a GUI editor (code, subl, ...) is open and the TUI is
// paused (blocking on the editor), mouse tracking + focus reporting must be
// disabled so SGR mouse sequences and focus events don't accumulate as
// garbage in the terminal input buffer. This mirrors the mode toggling in
// enterAlternateScreen/exitAlternateScreen, minus the alt-screen switch
// (GUI editors open in their own window, so we keep the alt buffer intact).
describe('guiEditorModeDisableSeq', () => {
  test('disables kitty keyboard, modify-other-keys, mouse tracking, and focus reporting when mouse tracking is on', () => {
    // Arrange
    const mouseTrackingOn = true

    // Act
    const seq = guiEditorModeDisableSeq(mouseTrackingOn)

    // Assert — every mode that causes garbage while paused must be disabled
    expect(seq).toContain(DISABLE_KITTY_KEYBOARD)
    expect(seq).toContain(DISABLE_MODIFY_OTHER_KEYS)
    expect(seq).toContain(DISABLE_MOUSE_TRACKING)
    expect(seq).toContain(DFE) // disable focus reporting (?1004l)
  })

  test('omits mouse-tracking disable when mouse tracking is off (non-fullscreen)', () => {
    // Arrange
    const mouseTrackingOn = false

    // Act
    const seq = guiEditorModeDisableSeq(mouseTrackingOn)

    // Assert — still kills kitty + modifyOtherKeys + focus, but not mouse
    expect(seq).toContain(DISABLE_KITTY_KEYBOARD)
    expect(seq).toContain(DISABLE_MODIFY_OTHER_KEYS)
    expect(seq).toContain(DFE)
    expect(seq).not.toContain(ENABLE_MOUSE_TRACKING)
    // DISABLE_MOUSE_TRACKING is a no-op if off, but we omit it to keep the
    // emitted sequence minimal and avoid unnecessary terminal round-trips.
    expect(seq).not.toContain(DISABLE_MOUSE_TRACKING)
  })
})

describe('guiEditorModeRestoreSeq', () => {
  test('re-enables mouse tracking, focus reporting, and re-asserts kitty keyboard when mouse tracking was on', () => {
    // Arrange
    const mouseTrackingOn = true

    // Act
    const seq = guiEditorModeRestoreSeq(mouseTrackingOn)

    // Assert
    expect(seq).toContain(ENABLE_MOUSE_TRACKING)
    expect(seq).toContain(EFE) // re-enable focus reporting (?1004h)
    // Kitty stack: pop (disable) then push (enable) to keep depth balanced.
    expect(seq).toContain(DISABLE_KITTY_KEYBOARD)
    expect(seq).toContain(ENABLE_KITTY_KEYBOARD)
    expect(seq).toContain(ENABLE_MODIFY_OTHER_KEYS)
  })

  test('omits mouse-tracking re-enable when mouse tracking was off', () => {
    // Arrange
    const mouseTrackingOn = false

    // Act
    const seq = guiEditorModeRestoreSeq(mouseTrackingOn)

    // Assert
    expect(seq).not.toContain(ENABLE_MOUSE_TRACKING)
    expect(seq).toContain(EFE)
    expect(seq).toContain(ENABLE_KITTY_KEYBOARD)
    expect(seq).toContain(ENABLE_MODIFY_OTHER_KEYS)
  })
})
