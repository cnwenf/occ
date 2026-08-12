import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { getFileModificationTime } from 'src/utils/file.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import {
  editWouldApplyToTelemetry,
  getModelBucket,
  isFullReadOfFileState,
  isNotebookPathForGuard,
  isOldModel,
  normalizeForComparison,
  stripBom,
} from 'src/utils/permissions/fileStateGuard.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { checkEditWouldApply } from 'src/tools/FileEditTool/utils.js'

// The read-permission check reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx for runtime
// execution). Mirror that polyfill so the permission path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * claude-code 2.1.208 #13 (wouldHaveResult classifier) and its 2.1.228
 * rework: Edit's read gate and stale-read recovery now key on the official
 * Mwt predicate ("would a hypothetical Read of this path have been
 * auto-allowed?") instead of the old "Read tool present + no deny rule"
 * guard. Tests cover the classifier, the shared fileStateGuard helpers, and
 * the end-to-end validateInput stale-read branch under each permission mode.
 */

describe('2.1.208 #13 checkEditWouldApply (wouldHaveResult classifier)', () => {
  test('returns "applies" when old_string is uniquely present', () => {
    // Arrange
    const content = 'alpha\nTARGET\nbeta'
    // Act
    const result = checkEditWouldApply(content, 'TARGET', false)
    // Assert
    expect(result).toBe('applies')
  })

  test('returns "no_match" when old_string is empty', () => {
    expect(checkEditWouldApply('some content', '', false)).toBe('no_match')
  })

  test('returns "no_match" when old_string is absent', () => {
    expect(checkEditWouldApply('alpha\nbeta', 'TARGET', false)).toBe('no_match')
  })

  test('returns "ambiguous" when multiple matches and replace_all is false', () => {
    // Arrange
    const content = 'TARGET\nother\nTARGET'
    // Act
    const result = checkEditWouldApply(content, 'TARGET', false)
    // Assert
    expect(result).toBe('ambiguous')
  })

  test('returns "applies" for multiple matches when replace_all is true', () => {
    const content = 'TARGET\nother\nTARGET'
    expect(checkEditWouldApply(content, 'TARGET', true)).toBe('applies')
  })
})

describe('2.1.228 fileStateGuard helpers', () => {
  test('isOldModel flags the zGy table verbatim (incl. [1m] suffix)', () => {
    expect(isOldModel('claude-opus-4-1')).toBe(true)
    expect(isOldModel('claude-sonnet-4-5')).toBe(true)
    expect(isOldModel('claude-3-7-sonnet')).toBe(true)
    expect(isOldModel('claude-sonnet-4-5[1m]')).toBe(true)
  })

  test('isOldModel bridges OCC canonical names to the zGy -0 keys', () => {
    // OCC getCanonicalName returns bare 'claude-opus-4'/'claude-sonnet-4';
    // the official table keys them with the '-0' suffix.
    expect(isOldModel('claude-opus-4')).toBe(true)
    expect(isOldModel('claude-sonnet-4')).toBe(true)
  })

  test('isOldModel is false for newer models', () => {
    expect(isOldModel('claude-opus-5')).toBe(false)
    expect(isOldModel('claude-opus-4-8')).toBe(false)
    expect(isOldModel('claude-sonnet-5')).toBe(false)
  })

  test('getModelBucket strips claude- prefix, dashes to underscores', () => {
    expect(getModelBucket('claude-opus-5')).toBe('opus_5')
    expect(getModelBucket('claude-sonnet-4-5[1m]')).toBe('sonnet_4_5')
  })

  test('getModelBucket reports nonconforming for out-of-pattern names', () => {
    expect(getModelBucket('Unknown-Model')).toBe('nonconforming')
    expect(getModelBucket('')).toBe('nonconforming')
  })

  test('isNotebookPathForGuard strips trailing dots/spaces before the ext check', () => {
    expect(isNotebookPathForGuard('/a/b.ipynb')).toBe(true)
    expect(isNotebookPathForGuard('/a/b.ipynb.')).toBe(true)
    expect(isNotebookPathForGuard('/a/b.ipynb ')).toBe(true)
    expect(isNotebookPathForGuard('/a/b.txt')).toBe(false)
  })

  test('normalizeForComparison strips BOM and normalizes CRLF to LF', () => {
    expect(normalizeForComparison('\uFEFFa\r\nb\r\n')).toBe('a\nb\n')
    expect(normalizeForComparison('a\nb')).toBe('a\nb')
    expect(stripBom('\uFEFFx')).toBe('x')
    expect(stripBom('x')).toBe('x')
  })

  test('isFullReadOfFileState: offset/partial-view/limit semantics', () => {
    const base = { content: 'a\nb\nc', timestamp: 1 }
    // No offset/limit → full read.
    expect(
      isFullReadOfFileState({ ...base, offset: undefined, limit: undefined }),
    ).toBe(true)
    // Offset read (2nd line onwards) → not full.
    expect(
      isFullReadOfFileState({ ...base, offset: 2, limit: undefined }),
    ).toBe(false)
    // Partial view → not full.
    expect(
      isFullReadOfFileState({
        ...base,
        offset: undefined,
        limit: undefined,
        isPartialView: true,
      }),
    ).toBe(false)
    // Limit larger than the actual line count → full.
    expect(
      isFullReadOfFileState({ ...base, offset: undefined, limit: 100 }),
    ).toBe(true)
    // Limit <= line count → the read stopped early → not full.
    expect(
      isFullReadOfFileState({ ...base, offset: undefined, limit: 2 }),
    ).toBe(false)
  })

  test('editWouldApplyToTelemetry maps the classifier to telemetry codes', () => {
    expect(editWouldApplyToTelemetry('applies')).toBe('success')
    expect(editWouldApplyToTelemetry('no_match')).toBe('errorCode8')
    expect(editWouldApplyToTelemetry('ambiguous')).toBe('errorCode9')
  })
})

describe('2.1.228 FileEditTool.validateInput stale-read recovery (Mwt semantics)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-edit-stale-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function makePermissionContext(
    opts: {
      mode?: ToolPermissionContext['mode']
      allow?: string[]
      deny?: string[]
    } = {},
  ): ToolPermissionContext {
    return {
      mode: opts.mode ?? 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
      alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: opts.mode === 'bypassPermissions',
    } as ToolPermissionContext
  }

  function makeContext(permContext: ToolPermissionContext): ToolUseContext {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const appState = {
      ...getDefaultAppState(),
      toolPermissionContext: permContext,
    }
    return {
      options: {
        mainLoopModel: 'claude-opus-5',
        tools: [{ name: FILE_EDIT_TOOL_NAME }, { name: FILE_READ_TOOL_NAME }],
      },
      readFileState,
      getAppState: () => appState,
    } as unknown as ToolUseContext
  }

  async function arrangeStaleFile(name: string) {
    const filePath = join(tmpDir, name)
    const oldContent = 'header line\nTARGET_UNIQUE_TOKEN\nfooter line'
    await writeFile(filePath, oldContent)
    const readAt = getFileModificationTime(filePath)
    // Externally modify a DIFFERENT region after the recorded read
    // (target stays present and unique unless a test overwrites again).
    await new Promise(r => setTimeout(r, 20))
    return { filePath, oldContent, readAt }
  }

  function seedRead(ctx: ToolUseContext, filePath: string, content: string, timestamp: number) {
    ctx.readFileState.set(filePath, {
      content,
      timestamp,
      offset: undefined,
      limit: undefined,
    })
  }

  test('default mode: still fails stale even when target unique (Read not auto-allowed outside cwd)', async () => {
    // Arrange: tmpdir is outside the working directories, so a hypothetical
    // Read would be 'ask' — Mwt is false in default mode.
    const { filePath, oldContent, readAt } = await arrangeStaleFile('a.txt')
    const ctx = makeContext(makePermissionContext())
    seedRead(ctx, filePath, oldContent, readAt)
    await writeFile(
      filePath,
      'header line CHANGED\nTARGET_UNIQUE_TOKEN\nfooter line',
    )

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert: not recovered (2.1.228 Mwt: read would not be auto-allowed).
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
  })

  test('bypassPermissions mode: recovers when file modified after read but target still unique', async () => {
    // Arrange: in bypassPermissions an 'ask' decision auto-allows (no
    // explicit ask rule produced it), so Mwt is true.
    const { filePath, oldContent, readAt } = await arrangeStaleFile('b.txt')
    const ctx = makeContext(makePermissionContext({ mode: 'bypassPermissions' }))
    seedRead(ctx, filePath, oldContent, readAt)
    await writeFile(
      filePath,
      'header line CHANGED\nTARGET_UNIQUE_TOKEN\nfooter line',
    )

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert: recovered (not stale-failed).
    expect(result.result).toBe(true)
  })

  test('Read allow rule covering the path: recovers in default mode', async () => {
    // Arrange: an explicit Read(/<tmpDir>/**) allow rule (rule content
    // `//tmp/...` — the `//` prefix anchors the pattern at `/`) makes the
    // hypothetical read auto-allowed even in default mode. tmpDir already
    // starts with `/`, so the single extra slash yields the `//` prefix.
    const { filePath, oldContent, readAt } = await arrangeStaleFile('c.txt')
    const ctx = makeContext(
      makePermissionContext({ allow: [`Read(/${tmpDir}/**)`] }),
    )
    seedRead(ctx, filePath, oldContent, readAt)
    await writeFile(
      filePath,
      'header line CHANGED\nTARGET_UNIQUE_TOKEN\nfooter line',
    )

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert
    expect(result.result).toBe(true)
  })

  test('bypassPermissions mode: fails stale (errorCode 7) when the target was removed after read', async () => {
    // Arrange
    const { filePath, oldContent, readAt } = await arrangeStaleFile('d.txt')
    const ctx = makeContext(makePermissionContext({ mode: 'bypassPermissions' }))
    seedRead(ctx, filePath, oldContent, readAt)
    // Externally modify so the target is gone.
    await writeFile(filePath, 'header\nNO_TARGET_HERE\nfooter')

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert: not recovered (target absent) → stale-read error.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
  })

  test('a bare Read deny rule blocks the edit outright (cVt, errorCode 13)', async () => {
    // Arrange
    const { filePath, oldContent, readAt } = await arrangeStaleFile('e.txt')
    const ctx = makeContext(makePermissionContext({ deny: ['Read'] }))
    seedRead(ctx, filePath, oldContent, readAt)

    // Act
    const result = await FileEditTool.validateInput(
      {
        file_path: filePath,
        old_string: 'TARGET_UNIQUE_TOKEN',
        new_string: 'REPLACED',
      },
      ctx,
    )

    // Assert: Read-deny-covered paths cannot be edited.
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(13)
  })
})
