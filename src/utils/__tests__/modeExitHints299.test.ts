import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  bareModeExitHint,
  isBackgroundSessionKind,
  restartHintForFlag,
  safeModeExitHint,
  wasFlagPassedOnCli,
} from '../envUtils.js'

/**
 * Official 2.1.299 (#085): bare/safe-mode exit hints in background sessions
 * name `/stop` + `claude --resume` instead of "restart without <flag>"
 * (a restart re-runs the same command line and keeps the mode).
 * Byte-verified from the v299 ELF @214758800:
 *   `f(e)=process.env.CLAUDE_CODE_SESSION_KIND==="bg"?
 *     "run /stop, then claude --resume from your shell":`restart without ${e}``
 *   `Jg()=i("--safe-mode")?f("--safe-mode"):"unset CLAUDE_CODE_SAFE_MODE"`
 *   `vht()=i("--bare")?f("--bare"):"unset CLAUDE_CODE_SIMPLE"`
 *   `i(e)` = flag in process.argv before any "--" separator.
 */

const BG_HINT = 'run /stop, then claude --resume from your shell'

let savedArgv: string[]
let savedSessionKind: string | undefined

beforeEach(() => {
  savedArgv = process.argv
  savedSessionKind = process.env.CLAUDE_CODE_SESSION_KIND
  process.argv = ['bun', 'cli.js']
  delete process.env.CLAUDE_CODE_SESSION_KIND
})

afterEach(() => {
  process.argv = savedArgv
  if (savedSessionKind === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_KIND
  } else {
    process.env.CLAUDE_CODE_SESSION_KIND = savedSessionKind
  }
})

describe('2.1.299 #085: wasFlagPassedOnCli (official i)', () => {
  test('finds a flag in argv', () => {
    process.argv = ['bun', 'cli.js', '--safe-mode']
    expect(wasFlagPassedOnCli('--safe-mode')).toBe(true)
    expect(wasFlagPassedOnCli('--bare')).toBe(false)
  })

  test('ignores flags after the "--" separator', () => {
    process.argv = ['bun', 'cli.js', '-p', 'run', '--', '--bare']
    expect(wasFlagPassedOnCli('--bare')).toBe(false)
  })

  test('counts flags before the "--" separator', () => {
    process.argv = ['bun', 'cli.js', '--bare', '--', '--safe-mode']
    expect(wasFlagPassedOnCli('--bare')).toBe(true)
  })
})

describe('2.1.299 #085: restartHintForFlag (official f)', () => {
  test('foreground sessions get the restart-without hint', () => {
    expect(restartHintForFlag('--bare')).toBe('restart without --bare')
  })

  test('background sessions get the /stop + --resume hint', () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    expect(isBackgroundSessionKind()).toBe(true)
    expect(restartHintForFlag('--bare')).toBe(BG_HINT)
    expect(restartHintForFlag('--safe-mode')).toBe(BG_HINT)
  })

  test('non-bg session kinds keep the restart hint', () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'teammate'
    expect(restartHintForFlag('--bare')).toBe('restart without --bare')
  })
})

describe('2.1.299 #085: safeModeExitHint / bareModeExitHint (official Jg / vht)', () => {
  test('safe mode via flag: restart hint', () => {
    process.argv = ['bun', 'cli.js', '--safe-mode']
    expect(safeModeExitHint()).toBe('restart without --safe-mode')
  })

  test('safe mode via env only: unset hint', () => {
    expect(safeModeExitHint()).toBe('unset CLAUDE_CODE_SAFE_MODE')
  })

  test('bare mode via flag: restart hint', () => {
    process.argv = ['bun', 'cli.js', '--bare']
    expect(bareModeExitHint()).toBe('restart without --bare')
  })

  test('bare mode via env only: unset hint', () => {
    expect(bareModeExitHint()).toBe('unset CLAUDE_CODE_SIMPLE')
  })

  test('background session + flag: /stop + --resume hint (the #085 fix)', () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    process.argv = ['bun', 'cli.js', '--bare']
    expect(bareModeExitHint()).toBe(BG_HINT)
    process.argv = ['bun', 'cli.js', '--safe-mode']
    expect(safeModeExitHint()).toBe(BG_HINT)
  })

  test('background session + env-only: unset hint unchanged', () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    expect(bareModeExitHint()).toBe('unset CLAUDE_CODE_SIMPLE')
    expect(safeModeExitHint()).toBe('unset CLAUDE_CODE_SAFE_MODE')
  })
})
