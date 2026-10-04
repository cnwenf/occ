/**
 * CC 2.1.289 changelog #3 (SECURITY) — byte-verified port test.
 *
 * "Fixed `Read` deny rules not applying to files @-mentioned, changed, or
 * selected in the IDE through a symlink"
 *
 * Research doc: docs/gap-research-289/cluster-b-read-symlink-ide.md
 * Official v289 gates (minified names, see doc §1e):
 *   - aje(ctx)      — only resolve spellings when a read-deny rule exists
 *   - Sge(path,sig) — build the spelling set (original + each symlink target
 *                     + canonical landing); OCC analogue:
 *                     getPathsForPermissionCheck (src/utils/fsOperations.ts)
 *   - bge(spellings,ctx) — deny if ANY spelling matches a read-deny rule
 *   - wge(path,ctx,sig)  — aje && Sge && bge combined; undefined ⇒ drop the
 *                          attachment (fail-closed)
 * OCC fix site: isFileReadDenied (src/utils/attachments.ts) — the single gate
 * all six IDE-context auto-read call sites funnel through (doc §3b:
 * getSelectedLinesFromIDE / getOpenedFileFromIDE / processAtMentionedFiles /
 * getChangedFiles / generateFileAttachment / readTruncatedFile).
 *
 * Exploit under test (doc §2/§5): deny rule Read(<root>/secret/**) + symlink
 * <root>/link -> secret/x. Surface-only matching (v288-equivalent, pre-fix
 * OCC) lets `link` through and the secret content lands in model context.
 *
 * STAGED (documented follow-up, NOT implemented here, per doc §4 fidelity
 * note): directory-branch parity — official `hpr(spellings,ctx)` (directory
 * landing deny) for the processAtMentionedFiles DIRECTORY branch
 * (attachments.ts readdir gate). This file covers the file/content surfaces
 * the changelog names (A: ide_selection, B: @-mention file read).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import {
  generateFileAttachment,
  getSelectedLinesFromIDE,
} from '../attachments.js'
import { _clearMatcherCacheForTesting } from '../permissions/filesystem.js'
import { _clearPhysicalTwinsForTesting } from '../permissions/symlinkEquivalences.js'

// Some permission/skill probes read MACRO.VERSION; mirror the cli.tsx polyfill
// (same as symlinkTwins268.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const SECRET_CONTENT = 'TOP-SECRET-KEY'
const PUBLIC_CONTENT = 'PUBLIC-CONTENT'

/** Minimal ToolPermissionContext with deny/ask/allow rule strings. */
function makePermissionContext(
  opts: { deny?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

/**
 * Minimal ToolUseContext for the attachment pipeline:
 * - options.mcpClients carries a connected 'ide' client so
 *   getConnectedIdeName() returns a name (getSelectedLinesFromIDE gate 1).
 * - No toolUseId: mirrors the real attachment path, where the 2.1.251 TOCTOU
 *   stash gate falls back to fresh resolution (doc §3c).
 */
function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    options: {
      mcpClients: [
        {
          type: 'connected',
          name: 'ide',
          config: { type: 'sse-ide', ideName: 'VS Code' },
        },
      ],
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

// Fixture farm (built once, canonical realpath spelling everywhere):
//   <farm>/secret/x        real file with the secret (deny landing target)
//   <farm>/secret/direct.txt  real file under the deny area (no symlink)
//   <farm>/link       -> secret/x   (THE exploit symlink)
//   <farm>/ok.txt          real file outside the deny area
//   <farm>/oklink     -> ok.txt     (symlink landing OUTSIDE the deny area)
let farm: string
let farmReal: string
let linkPath: string
let okPath: string
let okLinkPath: string
let directDeniedPath: string

/** Deny context mirroring doc §5: Read(<root>/secret/**), absolute spelling. */
function makeDenySecretContext(): ToolPermissionContext {
  return makePermissionContext({
    deny: [`Read(/${farmReal}/secret/**)`],
  })
}

function makeIdeSelection(filePath: string, text: string): IDESelection {
  return { filePath, text, lineStart: 1, lineCount: 1 }
}

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-289-'))
  farmReal = realpathSync(farm)
  mkdirSync(join(farmReal, 'secret'))
  writeFileSync(join(farmReal, 'secret', 'x'), SECRET_CONTENT)
  writeFileSync(join(farmReal, 'secret', 'direct.txt'), SECRET_CONTENT)
  symlinkSync(join('secret', 'x'), join(farmReal, 'link'))
  writeFileSync(join(farmReal, 'ok.txt'), PUBLIC_CONTENT)
  symlinkSync('ok.txt', join(farmReal, 'oklink'))
  linkPath = join(farmReal, 'link')
  okPath = join(farmReal, 'ok.txt')
  okLinkPath = join(farmReal, 'oklink')
  directDeniedPath = join(farmReal, 'secret', 'direct.txt')
})

afterAll(() => {
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  _clearMatcherCacheForTesting()
  _clearPhysicalTwinsForTesting()
})

describe('A — getSelectedLinesFromIDE (ide_selection surface, CC 2.1.289 #3)', () => {
  test('SECURITY: symlink whose landing is under Read(secret/**) is DENIED (returns [])', async () => {
    // Arrange — IDE supplies the secret text directly; the ONLY deny gate is
    // isFileReadDenied on the surface filePath (doc §1b: never re-read).
    const context = makeToolUseContext(makeDenySecretContext())

    // Act
    const attachments = await getSelectedLinesFromIDE(
      makeIdeSelection(linkPath, SECRET_CONTENT),
      context,
    )

    // Assert — fail-closed: the attachment must be dropped. Pre-fix (v288
    // behaviour) this returned a selected_lines_in_ide carrying the secret.
    expect(attachments).toEqual([])
  })

  test('control: non-symlink file outside the deny area still attaches', async () => {
    const context = makeToolUseContext(makeDenySecretContext())

    const attachments = await getSelectedLinesFromIDE(
      makeIdeSelection(okPath, PUBLIC_CONTENT),
      context,
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.type).toBe('selected_lines_in_ide')
    if (attachments[0]?.type === 'selected_lines_in_ide') {
      expect(attachments[0].content).toBe(PUBLIC_CONTENT)
    }
  })

  test('control: direct (non-symlink) file under the deny area is still denied', async () => {
    const context = makeToolUseContext(makeDenySecretContext())

    const attachments = await getSelectedLinesFromIDE(
      makeIdeSelection(directDeniedPath, SECRET_CONTENT),
      context,
    )

    expect(attachments).toEqual([])
  })

  test('control: symlink landing OUTSIDE the deny area still attaches', async () => {
    const context = makeToolUseContext(makeDenySecretContext())

    const attachments = await getSelectedLinesFromIDE(
      makeIdeSelection(okLinkPath, PUBLIC_CONTENT),
      context,
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.type).toBe('selected_lines_in_ide')
  })

  test('aje short-circuit: zero read-deny rules → surface result, symlink attaches', async () => {
    // Official aje(ctx) gate: with no read-deny rule in the context the
    // surface match result is returned directly (no spelling resolution).
    const context = makeToolUseContext(makePermissionContext())

    const attachments = await getSelectedLinesFromIDE(
      makeIdeSelection(linkPath, SECRET_CONTENT),
      context,
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.type).toBe('selected_lines_in_ide')
  })
})

describe('B — generateFileAttachment (@-mention surface, CC 2.1.289 #3)', () => {
  test('SECURITY: @-mention of a symlink landing under Read(secret/**) is DENIED at landing (null)', async () => {
    // Arrange
    const context = makeToolUseContext(makeDenySecretContext())

    // Act — the @-mention read path (processAtMentionedFiles →
    // generateFileAttachment); pre-fix this read through the symlink and
    // attached the secret content (doc §5 case B).
    const attachment = await generateFileAttachment(
      linkPath,
      context,
      'tengu_test_at_mention_success',
      'tengu_test_at_mention_error',
      'at-mention',
    )

    // Assert — fail-closed: denied at landing, nothing attached.
    expect(attachment).toBeNull()
  })

  test('control: direct (non-symlink) denied file is still denied (null)', async () => {
    const context = makeToolUseContext(makeDenySecretContext())

    const attachment = await generateFileAttachment(
      directDeniedPath,
      context,
      'tengu_test_at_mention_success',
      'tengu_test_at_mention_error',
      'at-mention',
    )

    expect(attachment).toBeNull()
  })

  test('control: non-symlink file outside the deny area still attaches', async () => {
    const context = makeToolUseContext(makeDenySecretContext())

    const attachment = await generateFileAttachment(
      okPath,
      context,
      'tengu_test_at_mention_success',
      'tengu_test_at_mention_error',
      'at-mention',
    )

    expect(attachment).not.toBeNull()
    expect(attachment?.type).toBe('file')
  })
})
