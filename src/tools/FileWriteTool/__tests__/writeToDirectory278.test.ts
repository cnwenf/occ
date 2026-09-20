import { execFileSync } from 'child_process'
import { rmSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

// validateInput's permission path reads MACRO.VERSION transitively.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-132 P3-8: detect mkfifo ONCE at module load so the FIFO test can use
// test.skipIf — a visible, reported skip — instead of the previous silent
// `catch { return }`, which passed with 0 assertions on hosts without mkfifo
// (false-green). Inside the test itself mkfifo failures now fail loudly.
const HAS_MKFIFO = (() => {
  try {
    const probe = join(tmpdir(), `occ-mkfifo-probe-${process.pid}`)
    execFileSync('mkfifo', [probe], { stdio: 'pipe' })
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
})()

// Mirror the FileEditTool staleReadRecovery.test.ts context shape: a default
// permission mode with no deny rules, so validateInput reaches the fs.stat
// block where the 2.1.278 directory / non-regular-file guards live.
function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeContext(): ToolUseContext {
  const readFileState = createFileStateCacheWithSizeLimit(100)
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: makePermissionContext(),
  }
  return {
    options: {
      mainLoopModel: 'claude-opus-5',
      tools: [{ name: FILE_WRITE_TOOL_NAME }],
    },
    readFileState,
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

/**
 * CC 2.1.278 (B2) — Write to an existing directory silently ended the turn as
 * DECLINED PERMISSION. validateInput now surfaces a clear error before the
 * permission prompt. Messages + errorCodes (17 directory / 18 non-regular) are
 * byte-copied from the v278 ELF; the interpolated path is the RAW input
 * (`${file_path}`), matching the official `${g}`.
 */
describe('2.1.278 B2 — Write to a directory / non-regular file', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-write-dir-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('existing directory → errorCode 17 with the byte-exact message', async () => {
    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: tmpDir, content: 'x' },
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(17)
    expect(result.message).toBe(
      `${tmpDir} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
    )
  })

  test('a nested existing directory is caught the same way', async () => {
    // Arrange
    const nested = join(tmpDir, 'a', 'b')
    await mkdtemp(join(tmpDir, 'a'))
    execFileSync('mkdir', ['-p', nested])

    // Act
    const result = await FileWriteTool.validateInput(
      { file_path: nested, content: 'x' },
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(17)
    expect(result.message).toBe(
      `${nested} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
    )
  })

  // OCC-132 P3-8: explicit visible skip (skipIf) when mkfifo is unavailable —
  // replaces the silent `catch { return }` false-green. When mkfifo IS
  // available (HAS_MKFIFO true), any failure below fails the test loudly.
  test.skipIf(!HAS_MKFIFO)(
    'non-regular file (FIFO) → errorCode 18 with the byte-exact message',
    async () => {
      // Arrange
      const fifo = join(tmpDir, 'pipe.fifo')
      execFileSync('mkfifo', [fifo])

      // Act
      const result = await FileWriteTool.validateInput(
        { file_path: fifo, content: 'x' },
        makeContext(),
      )

      // Assert
      expect(result.result).toBe(false)
      expect(result.errorCode).toBe(18)
      expect(result.message).toBe(
        `${fifo} exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.`,
      )
    },
  )

  test('non-existent path still validates (ENOENT → result true, unchanged)', async () => {
    // Act
    const target = join(tmpDir, 'brand-new-file.txt')
    const result = await FileWriteTool.validateInput(
      { file_path: target, content: 'hello' },
      makeContext(),
    )

    // Assert — the new guards must not false-positive on a missing path
    expect(result.result).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })
})
