/**
 * CC 2.1.310 changelog item 5 — "Fixed file read permission prompts not
 * showing where a symbolic link leads."
 *
 * Official evidence (byte-verified with grep -aboF / dd on the READ-ONLY
 * binaries /tmp/cc-diff-310/bin310/package/claude and bin309 — never executed):
 *
 * Resolver — BIN310 @270881164 region (BIN309 @272958140 had the read-skip
 * `if(r==="read"||n)return null`, 1 hit in 309 / 0 in 310):
 *   function St(e,r,n){if(r)return{target:null,unchecked:!1};
 *     if(n!==void 0)return{target:n,unchecked:!1};
 *     try{let s=Ui(ut(e));if(s.unresolved)return{target:null,unchecked:!0};
 *         return{target:Qjt(s),unchecked:!1}}catch{return{target:null,unchecked:!0}}}
 *   (`r` = remoteWorkspace flag — no OCC counterpart; `n` = blockedPath)
 *
 * Landing pick — BIN310 `Qjt` @243336917:
 *   function Qjt(e){if(e.unresolved)return null;
 *     return yl(e.landing)===yl(e.requested)?null:e.landing}
 *   → target is the landing ONLY when landing ≠ requested (a real symlink
 *   redirect); plain paths get target null, unchecked false.
 *
 * Producer — BIN310 @270886868:
 *   S=St(e.filePath,s,e.permissionResult.blockedPath) ...
 *   operationType:y,symlinkTarget:S.target,...S.unchecked&&{symlinkUnchecked:!0}
 *
 * UI — BIN310 `Xo` @274085299 (the ONE `This will ${` occurrence in 310;
 * "This will modify" = 0 hits in 310, 2 in 309):
 *   Xo=h.symlinkTarget?e(s,{paddingX:Ce,marginBottom:1,children:e(n,
 *     {color:"warning",children:!Q3(...)?`This will ${h.operationType==="read"
 *     ?"read":"modify"} ${o7(h.symlinkTarget)} (outside working directory)
 *     via a symlink`:`Symlink target: ${o7(h.symlinkTarget)}`})})
 *     :h.symlinkUnchecked?e(s,{paddingX:1,marginBottom:1,children:e(n,
 *     {color:"warning",children:"Could not check where this path leads on
 *     disk"})}):null
 *   Literal counts: `symlinkUnchecked` 310=3 / 309=0; "Could not check where
 *   this path leads on disk" 310=2 / 309=0.
 *   The unified official dialog renders Xo as children[0] EVEN when
 *   h.showingDiffInIDE (the `In` title swap lives in the same component), so
 *   the OCC-split ShowInIDEPrompt copy is held to the same shape.
 *
 * Test strategy: real temp dirs + real symlinkSync (live/dangling/dir links),
 * setCwdState() to pin getCwd(), isolated first-frame render via the
 * renderIsolated280 harness (exitPlanModeScreenReader288 pattern). Select,
 * useDiffInIDE and usePermissionRequestLogging are mocked out — the
 * assertions are on the symlink-warning text only. The memo's
 * {target,unchecked} descriptor semantics are asserted through the rendered
 * branches (target-branch vs unchecked-branch vs no-warning), mirroring the
 * official producer's `symlinkTarget` / `...unchecked&&{symlinkUnchecked:!0}`.
 */
import * as React from 'react'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE importing the module under test
// (OCC-97/129 convention). Spread the actual module so unrelated exports
// (computeEditsFromContents, etc.) keep working; restore in afterAll.
// ---------------------------------------------------------------------------

// 1) Select — the option list is irrelevant here; render nothing so the
//    first frame contains only the dialog chrome + symlink warning.
// Eager spread copies BEFORE mocking (OCC-97/132): bun patches the captured
// namespace IN PLACE and mock.restore() does NOT undo mock.module overrides —
// a lazy spread would re-pin the mock and leak `Select: () => null` into every
// later file (OCC-132 A/B: recentDenialsTab307 +6 / confirmSafety281 +3).
const actualSelectModule = await import('../../../CustomSelect/index.js')
const actualSelectExports = { ...actualSelectModule }
mock.module('../../../CustomSelect/index.js', () => ({
  ...actualSelectExports,
  Select: () => null,
}))

// 2) useDiffInIDE — force the non-IDE branch deterministically (the real hook
//    reads getGlobalConfig()/mcpClients; showingDiffInIDE must stay false so
//    FilePermissionDialog renders its own warning, not ShowInIDEPrompt).
const actualDiffModule = await import('../../../../hooks/useDiffInIDE.js')
const actualDiffExports = { ...actualDiffModule }
mock.module('../../../../hooks/useDiffInIDE.js', () => ({
  ...actualDiffExports,
  useDiffInIDE: () => ({
    closeTabInIDE: () => {},
    showingDiffInIDE: false,
    ideName: 'IDE',
    hasError: false,
  }),
}))

// 3) usePermissionRequestLogging — analytics/SandboxManager side effects are
//    noise for these assertions.
const actualHooksModule = await import('../../hooks.js')
const actualHooksExports = { ...actualHooksModule }
mock.module('../../hooks.js', () => ({
  ...actualHooksExports,
  usePermissionRequestLogging: () => {},
}))

const { FilePermissionDialog } = await import('../FilePermissionDialog.js')
const { ShowInIDEPrompt } = await import('../../../ShowInIDEPrompt.js')
const { AppStateProvider, getDefaultAppState } = await import('../../../../state/AppState.js')
const { renderToStringIsolated } = await import('../../../CustomSelect/__tests__/renderIsolated280.js')
const { setCwdState, getCwdState } = await import('../../../../bootstrap/state.js')

// ---------------------------------------------------------------------------
// Fixtures — real symlinks on disk under a realpath'd temp root (so
// relative(getCwd(), target) comparisons never cross the /tmp → /private/tmp
// style symlink hop).
// ---------------------------------------------------------------------------

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'occ-symlink310-')))
const cwdDir = join(tmpRoot, 'cwd')
const outsideDir = join(tmpRoot, 'outside')
const outsideTarget = join(outsideDir, 'secret.txt')
const insideTarget = join(cwdDir, 'real.txt')
const linkOut = join(cwdDir, 'link-out') // live link → outside cwd
const linkIn = join(cwdDir, 'link-in') // live link → inside cwd
const linkBroken = join(cwdDir, 'link-broken') // dangling link
const linkDir = join(cwdDir, 'link-dir') // directory link → outsideDir
const absentTailViaLinkDir = join(cwdDir, 'link-dir', 'new.txt')
const plainNewFile = join(cwdDir, 'new.txt')

let savedCwd: string

beforeAll(() => {
  mkdirSync(cwdDir)
  mkdirSync(outsideDir)
  writeFileSync(outsideTarget, 'outside')
  writeFileSync(insideTarget, 'inside')
  symlinkSync(outsideTarget, linkOut)
  symlinkSync(insideTarget, linkIn)
  symlinkSync(join(outsideDir, 'nonexistent.txt'), linkBroken)
  symlinkSync(outsideDir, linkDir)
  savedCwd = getCwdState()
  setCwdState(cwdDir)
})

afterAll(async () => {
  setCwdState(savedCwd)
  rmSync(tmpRoot, { recursive: true, force: true })
  // Explicit re-mock restore from the eager copies — mock.restore() alone does
  // NOT undo mock.module overrides (OCC-132 A/B evidence).
  mock.module('../../../CustomSelect/index.js', () => ({
    ...actualSelectExports,
  }))
  mock.module('../../../../hooks/useDiffInIDE.js', () => ({
    ...actualDiffExports,
  }))
  mock.module('../../hooks.js', () => ({ ...actualHooksExports }))
  mock.restore()
})

function makeToolUseConfirm(filePath: string, blockedPath?: string) {
  return {
    assistantMessage: { message: { id: 'msg_310' } },
    tool: { name: 'Read', isMcp: false },
    description: '',
    input: { file_path: filePath },
    toolUseContext: { options: { mcpClients: [] } },
    toolUseID: 'toolu_310',
    permissionResult: {
      behavior: 'ask',
      suggestions: [],
      ...(blockedPath !== undefined ? { blockedPath } : {}),
    },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => {},
    onAllow: () => {},
    onReject: () => {},
    recheckPermission: async () => {},
  } as never
}

async function renderDialog(opts: {
  path: string | null
  operationType?: 'read' | 'write' | 'create'
  blockedPath?: string
}): Promise<string> {
  const toolUseConfirm = makeToolUseConfirm(opts.path ?? '', opts.blockedPath)
  return await renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>
      <FilePermissionDialog
        toolUseConfirm={toolUseConfirm}
        toolUseContext={{ options: { mcpClients: [] } } as never}
        onDone={() => {}}
        onReject={() => {}}
        title="Do you want to proceed?"
        path={opts.path}
        parseInput={(input: unknown) => input as Record<string, unknown>}
        operationType={opts.operationType ?? 'write'}
        workerBadge={undefined}
      />
    </AppStateProvider>,
    300,
  )
}

const UNCHECKED_MESSAGE = 'Could not check where this path leads on disk'

// ---------------------------------------------------------------------------
// 2.1.310 item 5 — reads resolve symlinks; verb follows operationType;
// unresolved walks fall back to the unchecked message.
// ---------------------------------------------------------------------------

describe('2.1.310 #5: read permission prompts resolve and show symlink targets', () => {
  test('read of a symlink pointing OUTSIDE cwd shows the read-verb warning with the resolved target (official Xo @274085299)', async () => {
    // Arrange — live symlink cwd/link-out → outside/secret.txt, operationType read.
    // Act
    const out = await renderDialog({ path: linkOut, operationType: 'read' })

    // Assert — verb is "read" (official: operationType==="read"?"read":"modify"),
    // target is the resolved landing. 309 behavior rendered NO warning for reads.
    expect(out).toContain(
      `This will read ${outsideTarget} (outside working directory) via a symlink`,
    )
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('read of a symlink pointing INSIDE cwd shows `Symlink target: <landing>` (Qjt: landing ≠ requested)', async () => {
    // Arrange — live symlink cwd/link-in → cwd/real.txt.
    // Act
    const out = await renderDialog({ path: linkIn, operationType: 'read' })

    // Assert
    expect(out).toContain(`Symlink target: ${insideTarget}`)
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('write of a symlink outside cwd keeps the modify-verb warning (regression guard)', async () => {
    // Arrange — same link as the read case, operationType write.
    // Act
    const out = await renderDialog({ path: linkOut, operationType: 'write' })

    // Assert
    expect(out).toContain(
      `This will modify ${outsideTarget} (outside working directory) via a symlink`,
    )
    expect(out).not.toContain('This will read')
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('read of a NON-symlink file renders no symlink warning at all (Qjt: landing === requested → null)', async () => {
    // Arrange — plain existing file.
    // Act
    const out = await renderDialog({ path: insideTarget, operationType: 'read' })

    // Assert
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain('Symlink target:')
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('dangling symlink renders exactly the official unchecked message and leaks no target', async () => {
    // Arrange — cwd/link-broken → outside/nonexistent.txt (absent tail past a
    // link = official Ui `unresolved` → {target:null,unchecked:!0}).
    // Act
    const out = await renderDialog({ path: linkBroken, operationType: 'read' })

    // Assert — byte-verbatim official literal (310=2 hits, 309=0).
    expect(out).toContain(UNCHECKED_MESSAGE)
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain('nonexistent.txt')
  })

  test('write of a NEW file (absent tail, no symlink crossed) renders no warning — not unchecked', async () => {
    // Arrange — plainNewFile does not exist; ancestors are symlink-free.
    // Act
    const out = await renderDialog({ path: plainNewFile, operationType: 'write' })

    // Assert — official: absent tail resolves to its landing (=== requested)
    // → {target:null,unchecked:!1}. The dialog must NOT claim "could not
    // check" for every new-file write.
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain('Symlink target:')
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('blockedPath short-circuits the resolver: {target: blockedPath, unchecked: false} (official St 2nd branch)', async () => {
    // Arrange — a plain inside-cwd path (would render nothing on its own) but
    // the permission result carries a blockedPath outside cwd.
    // Act
    const out = await renderDialog({
      path: insideTarget,
      operationType: 'read',
      blockedPath: outsideTarget,
    })

    // Assert — blockedPath wins over resolution, read verb applies, and the
    // unchecked branch must NOT fire.
    expect(out).toContain(
      `This will read ${outsideTarget} (outside working directory) via a symlink`,
    )
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })

  test('absent tail under a symlinked DIRECTORY resolves to the outside landing (ancestor walk)', async () => {
    // Arrange — cwd/link-dir/new.txt: the leaf is absent but the walk crosses
    // link-dir → outsideDir, so landing = outside/new.txt ≠ requested.
    // Act
    const out = await renderDialog({ path: absentTailViaLinkDir, operationType: 'write' })

    // Assert
    expect(out).toContain(
      `This will modify ${join(outsideDir, 'new.txt')} (outside working directory) via a symlink`,
    )
    expect(out).not.toContain(UNCHECKED_MESSAGE)
  })
})

// ---------------------------------------------------------------------------
// ShowInIDEPrompt — the OCC-split second copy of the warning. Official 310
// has ONE site (Xo) inside the unified dialog which renders it even when
// showingDiffInIDE (children[0] next to the `In` title swap @274085420
// region), so the split component is held to the same verb-split +
// symlinkUnchecked shape.
// ---------------------------------------------------------------------------

async function renderIdePrompt(overrides: {
  symlinkTarget?: string | null
  symlinkUnchecked?: boolean
  operationType?: 'read' | 'write' | 'create'
}): Promise<string> {
  return await renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>
      <ShowInIDEPrompt
        onChange={() => {}}
        options={[]}
        input={{}}
        filePath={join(cwdDir, 'file.txt')}
        ideName="VS Code"
        symlinkTarget={overrides.symlinkTarget ?? null}
        {...(overrides.symlinkUnchecked !== undefined
          ? { symlinkUnchecked: overrides.symlinkUnchecked }
          : {})}
        {...(overrides.operationType !== undefined
          ? { operationType: overrides.operationType }
          : {})}
        rejectFeedback=""
        acceptFeedback=""
        setFocusedOption={() => {}}
        onInputModeToggle={() => {}}
        focusedOption="yes"
        yesInputMode={false}
        noInputMode={false}
      />
    </AppStateProvider>,
    300,
  )
}

describe('2.1.310 #5: ShowInIDEPrompt mirrors the unified-dialog Xo warning', () => {
  test('read operationType switches the outside-cwd verb to "read"', async () => {
    // Arrange / Act
    const out = await renderIdePrompt({ symlinkTarget: outsideTarget, operationType: 'read' })

    // Assert
    expect(out).toContain(
      `This will read ${outsideTarget} (outside working directory) via a symlink`,
    )
    expect(out).not.toContain('This will modify')
  })

  test('default (write) operationType keeps the modify verb', async () => {
    // Arrange / Act
    const out = await renderIdePrompt({ symlinkTarget: outsideTarget })

    // Assert
    expect(out).toContain(
      `This will modify ${outsideTarget} (outside working directory) via a symlink`,
    )
  })

  test('inside-cwd target keeps the `Symlink target:` branch', async () => {
    // Arrange / Act
    const out = await renderIdePrompt({ symlinkTarget: insideTarget, operationType: 'read' })

    // Assert
    expect(out).toContain(`Symlink target: ${insideTarget}`)
    expect(out).not.toContain('via a symlink')
  })

  test('symlinkUnchecked with no target renders the official unchecked literal', async () => {
    // Arrange / Act
    const out = await renderIdePrompt({ symlinkTarget: null, symlinkUnchecked: true })

    // Assert
    expect(out).toContain(UNCHECKED_MESSAGE)
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain('Symlink target:')
  })

  test('no target and not unchecked renders no warning', async () => {
    // Arrange / Act
    const out = await renderIdePrompt({ symlinkTarget: null })

    // Assert
    expect(out).not.toContain(UNCHECKED_MESSAGE)
    expect(out).not.toContain('via a symlink')
    expect(out).not.toContain('Symlink target:')
  })
})
