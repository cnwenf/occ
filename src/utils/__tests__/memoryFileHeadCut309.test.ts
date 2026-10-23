import { describe, expect, test, mock, afterAll } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.309 (item 12) — nested CLAUDE.md over the per-file size limit loads
 * only its start, with a model-facing banner pointing at Read offset/limit.
 *
 * Official 309 `Sxn` @252512900 (BIN309; rename of 308 `NEn`, which had NO
 * cut logic — banner + `nested_file_cut` have zero hits in BIN308):
 *
 *   H = Pje(n.options.mainLoopModel)                    // per-file budget
 *   Q = q.content.trim()
 *   be = !Se && q.type !== "Managed" && Q.length > H    // cut?
 *   We = Q.lastIndexOf("\n", H)
 *   Ge = re(Q, We > 0 ? We : H)                         // surrogate-safe head
 *   Je = We > 0 ? Ft(Ge, "\n") + 2 : 1                  // Read offset hint
 *   we = `${Ge}\n\n> Only the start of this file is shown. For the rest,
 *          call ${qe} on ${q.path} with offset=${Je} and a limit.`
 *   push {type:"nested_memory", ..., content: be ? {...q, content:we,
 *          rawContent:void 0} : q}
 *   if (be) f("context_claude_md_load","nested_file_cut")
 *   readFileState.set(q.path, {..., isPartialView: be||q.contentDiffersFromDisk,
 *          seededFromContext:!0, keepContent:!0})
 *
 * where `qe = "Read"` @242571236, `Pje` @250288561 ≡ OCC
 * getMemoryCharThreshold(getContextWindowForModel(model)), `re` ≡ safeSlice,
 * `Ft` @239558666 ≡ countCharInString.
 */

// --- Mock seams (OCC-97: mock.module leaks across files in the same worker —
// spread the real module, override narrowly, restore in afterAll). ---
const actualHooks = await import('../hooks.js')
mock.module('../hooks.js', () => ({
  ...actualHooks,
  hasInstructionsLoadedHook: () => false,
  executeInstructionsLoadedHooks: async () => {},
}))

const actualDiagLogs = await import('../diagLogs.js')
const diagCalls: [string, string][] = []
mock.module('../diagLogs.js', () => ({
  ...actualDiagLogs,
  logForDiagnosticsNoPII: (level: string, event: string) => {
    diagCalls.push([level, event])
  },
}))

afterAll(() => {
  mock.module('../hooks.js', () => ({ ...actualHooks }))
  mock.module('../diagLogs.js', () => ({ ...actualDiagLogs }))
})

const { memoryFilesToAttachments } = await import('../attachments.js')

import type { ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../fileStateCache.js'
import type { MemoryFileInfo } from '../claudemd.js'
import { getMemoryCharThreshold } from '../memoryThreshold.js'
import { getContextWindowForModel } from '../context.js'
import { countCharInString } from '../stringUtils.js'

const NESTED_FILE_PATH = '/proj/sub/CLAUDE.md'

// Same budget composition the implementation uses (official Pje(model)).
const BUDGET = getMemoryCharThreshold(
  getContextWindowForModel('claude-sonnet-4-5'),
)

function makeContext(): ToolUseContext {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    loadedNestedMemoryPaths: new Set<string>(),
    options: { mainLoopModel: 'claude-sonnet-4-5' },
  } as unknown as ToolUseContext
}

function makeMemoryFile(
  content: string,
  overrides: Partial<MemoryFileInfo> = {},
): MemoryFileInfo {
  return {
    path: NESTED_FILE_PATH,
    type: 'Project',
    content,
    ...overrides,
  } as MemoryFileInfo
}

// Lines of ~11 chars so the over-budget file has many newlines.
function makeOverBudgetContent(marker: string): string {
  const lineCount = Math.ceil((BUDGET + 100) / 11) + 1
  const lines = Array.from({ length: lineCount }, (_, i) => `line ${i} end`)
  return [...lines, marker].join('\n')
}

describe('CC 2.1.309 (item 12) — nested CLAUDE.md over-budget head cut', () => {
  test('over-budget non-Managed file loads only its start plus the Read-offset banner', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const trimmed = content.trim()
    const lastNl = trimmed.lastIndexOf('\n', BUDGET)
    const head = trimmed.slice(0, lastNl)
    const expectedOffset = countCharInString(head, '\n') + 2
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert — one nested_memory attachment whose content is head + banner.
    expect(attachments).toHaveLength(1)
    const attachmentContent = (attachments[0]!.content as MemoryFileInfo).content
    expect(attachmentContent).toBe(
      `${head}\n\n> Only the start of this file is shown. For the rest, call Read on ${NESTED_FILE_PATH} with offset=${expectedOffset} and a limit.`,
    )
    expect(attachmentContent).not.toContain('TAIL-MARKER')
  })

  test('cut attachment carries a cloned MemoryFileInfo with rawContent cleared', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const original = makeMemoryFile(content, { rawContent: 'raw disk bytes' })
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments([original], ctx)

    // Assert — official `{...q, content: we, rawContent: void 0}`: a NEW
    // object (input not mutated), rawContent dropped.
    const attached = attachments[0]!.content as MemoryFileInfo
    expect(attached).not.toBe(original)
    expect(attached.rawContent).toBeUndefined()
    expect(original.content).toBe(content) // input untouched (immutability)
    expect(attached.path).toBe(NESTED_FILE_PATH)
  })

  test('Managed memory files are exempt from the cut', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments(
      [makeMemoryFile(content, { type: 'Managed' })],
      ctx,
    )

    // Assert — full content passes through, no banner.
    const attached = attachments[0]!.content as MemoryFileInfo
    expect(attached.content).toBe(content)
    expect(attached.content).toContain('TAIL-MARKER')
  })

  test('under-budget files load in full', () => {
    // Arrange
    const content = '# small nested rules\n\nbe kind'
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert
    const attached = attachments[0]!.content as MemoryFileInfo
    expect(attached.content).toBe(content)
    expect(attached).toBe((attachments[0]!.content as MemoryFileInfo))
  })

  test('no-newline content falls back to the hard budget cut with offset=1', () => {
    // Arrange — one giant line, no newlines at all (We === -1 → hard budget,
    // Je = 1).
    const content = 'x'.repeat(BUDGET + 500)
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert
    const attachedContent = (attachments[0]!.content as MemoryFileInfo).content
    expect(attachedContent).toBe(
      `${'x'.repeat(BUDGET)}\n\n> Only the start of this file is shown. For the rest, call Read on ${NESTED_FILE_PATH} with offset=1 and a limit.`,
    )
  })

  test('cut is surrogate-safe — no lone high surrogate at the cut point', () => {
    // Arrange — emoji-only content; an odd budget lands mid surrogate pair.
    const content = '🌍'.repeat(BUDGET) // 2× BUDGET code units, no newlines
    const ctx = makeContext()

    // Act
    const attachments = memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert — the head portion (before the banner) has no trailing lone
    // high surrogate.
    const attachedContent = (attachments[0]!.content as MemoryFileInfo).content
    const head = attachedContent.split('\n\n> Only the start')[0]!
    expect(/[\uD800-\uDBFF]$/.test(head)).toBe(false)
    expect(head.length).toBeLessThanOrEqual(BUDGET)
  })

  test('cut seeds readFileState with isPartialView and caches full disk content', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const ctx = makeContext()

    // Act
    memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert — official seeds isPartialView: be||contentDiffersFromDisk and
    // caches the FULL (uncut) content so mid-session change detection works.
    const state = ctx.readFileState.get(NESTED_FILE_PATH)
    expect(state).toBeDefined()
    expect(state!.isPartialView).toBe(true)
    expect(state!.content).toBe(content)
    expect(state!.content).toContain('TAIL-MARKER')
  })

  test('non-cut loads keep the existing isPartialView semantics', () => {
    // Arrange
    const content = '# small'
    const ctx = makeContext()

    // Act
    memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert — official seeds a strict boolean (be||q.contentDiffersFromDisk).
    expect(ctx.readFileState.get(NESTED_FILE_PATH)!.isPartialView).toBe(false)
  })

  test('cut emits the nested_file_cut diagnostics breadcrumb', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const ctx = makeContext()
    diagCalls.length = 0

    // Act
    memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert — official f("context_claude_md_load","nested_file_cut") →
    // OCC logForDiagnosticsNoPII breadcrumb (rules_walk_failed precedent).
    expect(diagCalls.some(([, event]) => event === 'nested_file_cut')).toBe(true)
  })

  test('under-budget loads emit no nested_file_cut breadcrumb', () => {
    // Arrange
    const ctx = makeContext()
    diagCalls.length = 0

    // Act
    memoryFilesToAttachments([makeMemoryFile('# small')], ctx)

    // Assert
    expect(diagCalls.some(([, event]) => event === 'nested_file_cut')).toBe(false)
  })

  test('already-loaded paths are skipped (dedup preserved)', () => {
    // Arrange
    const content = makeOverBudgetContent('TAIL-MARKER')
    const ctx = makeContext()

    // Act — first call loads + dedups, second call must not re-attach.
    const first = memoryFilesToAttachments([makeMemoryFile(content)], ctx)
    const second = memoryFilesToAttachments([makeMemoryFile(content)], ctx)

    // Assert
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})
