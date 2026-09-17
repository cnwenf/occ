/**
 * OCC-89 / 2.1.274 alignment: CLAUDE_CODE_DEBUG_LOGS_DIR is a DIRECTORY.
 *
 * The official client's debug-log manager recovers a failed append with
 * `resolveDirToFile(dir)` = join(dir, `${sessionId}.txt`) (byte-verified in
 * the 2.1.274 ELF). OCC previously passed the raw env value straight to
 * appendFileSync — pointing the env var at a directory killed the whole
 * process with an unhandled EISDIR on the first logForDebugging call
 * (observed live: `bun dist/cli.js --debug` with
 * CLAUDE_CODE_DEBUG_LOGS_DIR=/tmp/dir crashed to shell).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  appendFileSyncWithDirFallback,
  getDebugLogPath,
  resetDirFallbackLogPathForTesting,
} from 'src/utils/debug.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'

describe('debug log dir EISDIR fallback (2.1.274 resolveDirToFile parity)', () => {
  let dir: string
  let savedEnv: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'occ89-debug-logs-'))
    savedEnv = process.env.CLAUDE_CODE_DEBUG_LOGS_DIR
    resetDirFallbackLogPathForTesting()
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_DEBUG_LOGS_DIR
    else process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = savedEnv
    resetDirFallbackLogPathForTesting()
  })

  test('append to a directory path recovers to <dir>/<sessionId>.txt instead of throwing', () => {
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = dir
    // Pre-fallback, getDebugLogPath resolves to the raw env value (the
    // historical crash trigger).
    expect(getDebugLogPath()).toBe(dir)

    // The first append targets the directory and would throw EISDIR; the
    // fallback must absorb it and land the content in the session file.
    expect(() => appendFileSyncWithDirFallback(dir, 'first line\n')).not.toThrow()

    const expected = join(dir, `${getSessionId()}.txt`)
    expect(getDebugLogPath()).toBe(expected)
    expect(readFileSync(expected, 'utf8')).toBe('first line\n')

    // Subsequent writes follow the memoized fallback path and append.
    appendFileSyncWithDirFallback(getDebugLogPath(), 'second line\n')
    expect(readFileSync(expected, 'utf8')).toBe('first line\nsecond line\n')
  })

  test('regular file appends are untouched by the fallback', () => {
    const file = join(dir, 'explicit.txt')
    writeFileSync(file, '')
    appendFileSyncWithDirFallback(file, 'plain\n')
    expect(readFileSync(file, 'utf8')).toBe('plain\n')
    // No fallback memoized — getDebugLogPath keeps its normal resolution.
    delete process.env.CLAUDE_CODE_DEBUG_LOGS_DIR
    expect(getDebugLogPath()).toBe(
      join(getClaudeConfigHomeDir(), 'debug', `${getSessionId()}.txt`),
    )
  })

  test('non-EISDIR append errors still propagate', () => {
    // ENOENT: parent dir does not exist — must NOT be swallowed by the
    // fallback (only EISDIR triggers resolveDirToFile recovery).
    const missing = join(dir, 'no-such-subdir', 'log.txt')
    expect(() => appendFileSyncWithDirFallback(missing, 'x\n')).toThrow()
  })
})
