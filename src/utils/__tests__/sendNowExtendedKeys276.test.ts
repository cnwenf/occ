import { describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.276 acceptance df-03: `hasExtendedKeyboardSupport()` (sendNow.ts,
 * official xHe @202522884) must track the terminal's extended-key capability
 * so the footer shows `ctrl+enter` on terminals that negotiate the kitty
 * keyboard protocol (ghostty/kitty/WezTerm/iTerm/tmux/windows-terminal) and
 * `ctrl+x ctrl+s` elsewhere — instead of the old hardcoded `false`.
 *
 * `env.terminal` is FROZEN at module load (src/utils/env.ts
 * `terminal: detectTerminal()`), so env flips inside a test cannot move
 * `supportsExtendedKeys()`. Both branches are covered by mocking the
 * capability module itself BEFORE importing sendNow (mock.module path
 * specifiers resolve relative to this file).
 */

let supportsFlag = false
const realTerminal = await import('../../ink/terminal.js')
mock.module('../../ink/terminal.js', () => ({
  ...realTerminal,
  supportsExtendedKeys: () => supportsFlag,
}))

const { hasExtendedKeyboardSupport } = await import('../sendNow.js')

describe('hasExtendedKeyboardSupport (df-03 wiring, both branches)', () => {
  test('capability present → true (footer can offer ctrl+enter)', () => {
    supportsFlag = true
    expect(hasExtendedKeyboardSupport()).toBe(true)
  })

  test('capability absent → false (footer falls back to ctrl+x ctrl+s)', () => {
    supportsFlag = false
    expect(hasExtendedKeyboardSupport()).toBe(false)
  })
})
