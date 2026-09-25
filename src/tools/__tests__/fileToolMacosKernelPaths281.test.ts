import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// validateInput's permission path reads MACRO.VERSION transitively.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.281 changelog #033 (security) — macOS automount / kernel-resolved
 * prefix denials wired into the four file tools' validateInput, alongside
 * the pre-existing Windows-UNC NTLM guards. Darwin-gated: the platform is
 * mocked to 'macos' here (this test file must NOT be merged with
 * platform-sensitive suites). Deny sentence byte-verified against the v281
 * ELF @97322030; validators UH/iS/O/WW @192900730-192905000.
 */
// Passthrough-flag pattern (OCC-96 leak hunt): this file previously replaced
// platform.js with a frozen 'macos' stub and NEVER restored it — every later
// file in the shared `bun test` process saw darwin (symlinkTwins268's
// getPlatform.cache probe crashed, shortcutDisplayParity251 rendered "opt+p",
// tmpdirBackstop277 took the macOS sandbox array-command path). Snapshot the
// real module, gate the fake on a flag, and restore in afterAll.
const actualPlatformModule = { ...(await import('../../utils/platform.js')) }
let platformMockActive = true
mock.module('../../utils/platform.js', () => ({
  ...actualPlatformModule,
  getPlatform: () =>
    platformMockActive
      ? ('macos' as const)
      : (actualPlatformModule.getPlatform as () => ReturnType<typeof actualPlatformModule.getPlatform>)(),
  getWslVersion: () =>
    platformMockActive
      ? undefined
      : (actualPlatformModule.getWslVersion as () => unknown)(),
  getLinuxDistroInfo: async () =>
    platformMockActive
      ? undefined
      : await (actualPlatformModule.getLinuxDistroInfo as () => Promise<unknown>)(),
  SUPPORTED_PLATFORMS: ['macos', 'wsl'],
  detectVcs: async () =>
    platformMockActive
      ? []
      : await (actualPlatformModule.detectVcs as () => Promise<unknown>)(),
}))

afterAll(() => {
  platformMockActive = false
  mock.module('../../utils/platform.js', () => ({ ...actualPlatformModule }))
})

const { FileEditTool } = await import('../FileEditTool/FileEditTool.js')
const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../FileWriteTool/FileWriteTool.js')
const { NotebookEditTool } = await import(
  '../NotebookEditTool/NotebookEditTool.js'
)
const { macosNetworkMountDenyMessage } = await import(
  '../../utils/macosKernelPaths.js'
)
const { getDefaultAppState } = await import('src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import(
  'src/utils/fileStateCache.js'
)

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
      tools: [],
    },
    readFileState,
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('2.1.281 #033 — file tools deny macOS kernel-resolved/automount prefixes (darwin)', () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('Read: /.vol path → denied with the byte-exact official sentence', async () => {
    // Arrange
    const input = { file_path: '/.vol/deadbeef/secret.txt' }

    // Act
    const result = await FileReadTool.validateInput(input as never, makeContext())

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    if (result.result === false) {
      expect(result.message).toBe(
        macosNetworkMountDenyMessage('/.vol/deadbeef/secret.txt'),
      )
    }
  })

  test('Write: /net automount path → denied before any filesystem operation', async () => {
    // Arrange
    const input = { file_path: '/net/host/share/drop.txt', content: 'x' }

    // Act
    const result = await FileWriteTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    if (result.result === false) {
      expect(result.message).toBe(
        macosNetworkMountDenyMessage('/net/host/share/drop.txt'),
      )
    }
  })

  test('Edit: /.nofollow path → denied with the official sentence', async () => {
    // Arrange
    const input = {
      file_path: '/.nofollow/1/2/target.txt',
      old_string: 'a',
      new_string: 'b',
    }

    // Act
    const result = await FileEditTool.validateInput(input as never, makeContext())

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    if (result.result === false) {
      expect(result.message).toBe(
        macosNetworkMountDenyMessage('/.nofollow/1/2/target.txt'),
      )
    }
  })

  test('NotebookEdit: /Network/Servers path → denied with the official sentence', async () => {
    // Arrange
    const input = {
      notebook_path: '/Network/Servers/host/share/nb.ipynb',
      new_source: 'x',
      edit_mode: 'replace',
    }

    // Act
    const result = await NotebookEditTool.validateInput(
      input as never,
      makeContext(),
    )

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
    if (result.result === false) {
      expect(result.message).toBe(
        macosNetworkMountDenyMessage('/Network/Servers/host/share/nb.ipynb'),
      )
    }
  })

  test('ordinary macOS paths are NOT denied (no false positives)', async () => {
    // Arrange — a real existing file; Read validateInput should pass through
    // the kernel guard untouched.
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-kernel-281-'))
    const ordinary = join(tmpDir, 'ordinary.txt')
    await writeFile(ordinary, 'hello')

    // Act
    const result = await FileReadTool.validateInput(
      { file_path: ordinary } as never,
      makeContext(),
    )

    // Assert
    if (result.result === false) {
      expect(result.message).not.toContain('network mount')
    } else {
      expect(result.result).toBe(true)
    }
  })
})
