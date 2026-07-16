/**
 * CC 2.1.211 — "Fixed screen reader users losing the audible terminal bell
 * after `/terminal-setup` or onboarding terminal setup."
 *
 * Bug (pre-fix): `enableOptionAsMetaForTerminal` unconditionally called
 * `disableAudioBellForProfile`, which sets `Bell = false` on every Terminal.app
 * profile. Screen-reader users rely on the audible bell; disabling it breaks
 * their workflow.
 *
 * Fix (2.1.211 binary `$Vy`): when `bM()` (SR mode) returns true, the bell-disable
 * PlistBuddy call is skipped (`r ? false : await xBd(c)`) and the success
 * message reads "Left the audible bell setting unchanged (screen-reader mode
 * uses it)" instead of "Disabled the audible bell".
 *
 * These tests exercise the REAL `enableOptionAsMetaForTerminal` decision logic
 * via an injectable `execFile` seam (no `mock.module` — that leaks across test
 * files in this Bun version, see vimInsertModeRemaps.test.ts). SR mode is
 * controlled through the real `screenReader` singleton + `CLAUDE_AX_SCREEN_READER`
 * env var + `reset()` cache clear.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ThemeName } from '../../../utils/theme.js'
import { screenReader } from '../../../utils/screenReader.js'
import { enableOptionAsMetaForTerminal } from '../terminalSetup'

type ExecResult = { stdout: string; stderr: string; code: number; error?: string }
type ExecFileFn = (file: string, args: string[]) => Promise<ExecResult>

const PROFILE_NAME = 'Basic'

/**
 * A tracking mock for `execFileNoThrow`. Returns success for `defaults read`
 * (profile name), PlistBuddy Add/Set (option-as-meta, bell), and `killall`.
 * Records every call so tests can assert on Bell-related PlistBuddy commands.
 */
function makeTrackedExec(): ExecFileFn & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = []
  const fn = async (file: string, args: string[]): Promise<ExecResult> => {
    calls.push({ file, args })
    // `defaults read com.apple.Terminal "Default Window Settings"` → profile name
    if (file === 'defaults' && args[0] === 'read') {
      return { stdout: `${PROFILE_NAME}\n`, stderr: '', code: 0 }
    }
    // PlistBuddy Add/Set → success
    if (file === '/usr/libexec/PlistBuddy') {
      return { stdout: '', stderr: '', code: 0 }
    }
    // killall → success
    if (file === 'killall') {
      return { stdout: '', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
  return Object.assign(fn, { calls })
}

const noopBackup = async (): Promise<string> => '/fake/backup.plist'
const noopRestore = async (): Promise<{ status: 'no_backup' }> => ({ status: 'no_backup' })
const noopMarkComplete = () => {}
const noopGetPlistPath = () => '/fake/com.apple.Terminal.plist'

function makeDeps(exec: ExecFileFn) {
  return {
    execFile: exec,
    backupPrefs: noopBackup as unknown as typeof import('../../../utils/appleTerminalBackup').backupTerminalPreferences,
    restoreBackup: noopRestore as unknown as typeof import('../../../utils/appleTerminalBackup').checkAndRestoreTerminalBackup,
    markComplete: noopMarkComplete as unknown as typeof import('../../../utils/appleTerminalBackup').markTerminalSetupComplete,
    getPlistPath: noopGetPlistPath as unknown as typeof import('../../../utils/appleTerminalBackup').getTerminalPlistPath,
  }
}

describe('CC 2.1.211 — audible terminal bell preserved in SR mode', () => {
  const originalEnv = process.env.CLAUDE_AX_SCREEN_READER

  beforeEach(() => {
    screenReader.reset()
  })

  afterEach(() => {
    screenReader.reset()
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_AX_SCREEN_READER
    } else {
      process.env.CLAUDE_AX_SCREEN_READER = originalEnv
    }
  })

  test('SR OFF → bell is disabled (Bell PlistBuddy calls present)', async () => {
    // Arrange — SR off
    delete process.env.CLAUDE_AX_SCREEN_READER
    screenReader.reset()
    expect(screenReader.isEnabled()).toBe(false)

    const exec = makeTrackedExec()

    // Act
    const result = await enableOptionAsMetaForTerminal('dark' as ThemeName, makeDeps(exec))

    // Assert — Bell PlistBuddy commands were issued
    const bellCalls = exec.calls.filter(
      c => c.file === '/usr/libexec/PlistBuddy' && c.args.some(a => a.includes('Bell')),
    )
    expect(bellCalls.length).toBeGreaterThan(0)
    // Success message mentions the bell was disabled
    expect(result).toContain('audible bell')
  })

  test('SR ON → bell is NOT disabled (no Bell PlistBuddy calls)', async () => {
    // Arrange — SR on via env var
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    screenReader.reset()
    expect(screenReader.isEnabled()).toBe(true)

    const exec = makeTrackedExec()

    // Act
    const result = await enableOptionAsMetaForTerminal('dark' as ThemeName, makeDeps(exec))

    // Assert — NO Bell PlistBuddy commands were issued
    const bellCalls = exec.calls.filter(
      c => c.file === '/usr/libexec/PlistBuddy' && c.args.some(a => a.includes('Bell')),
    )
    expect(bellCalls.length).toBe(0)
    // Success message says the bell was left unchanged
    expect(result).toContain('unchanged')
    expect(result).toContain('screen-reader')
  })
})
