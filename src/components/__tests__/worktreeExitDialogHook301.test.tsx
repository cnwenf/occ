import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import * as REAL_EXEC_NS from '../../utils/execFileNoThrow.js'
import * as REAL_SESSION_NS from '../../utils/sessionStorage.js'
import * as REAL_WORKTREE_NS from '../../utils/worktree.js'
import { render } from '../../ink.js'

/**
 * CC 2.1.301 #7 — quitting must ASK before removing a WorktreeCreate-hook
 * worktree ("Fixed quitting removing a worktree made by a WorktreeCreate hook
 * without asking when it may hold unpushed commits").
 *
 * Official v301 evidence (0 hits in v300; verified byte-for-byte at
 * @101828806/@250244409 in the 2.1.301 linux-x64 ELF):
 *
 *   loadChanges (Bn @250238500 region):
 *     let xn=to.hookBased&&(yo||Tn)?0:null;
 *     if(to.originalHeadCommit){...rev-list --count...; xn=Pn===0?parseInt(Wn.trim())||0:null}
 *     let fn=to.hookBased&&xn===null;
 *     if(ko.length===0&&(xn===0||fn)&&...&&!Co&&!Ro){if(fn){ye("asking");return} ...silent removal...}
 *
 *   subtitle (kn===null branch @250244409):
 *     hookBased: `${yr?`You have ${fr}. These will be lost if you remove the worktree. `:""}` +
 *       `A WorktreeCreate hook made this worktree, so Claude Code can't tell whether it has unpushed commits.` +
 *       `${Co?` This session was named "${Co}". Keep the worktree to resume it later.`:""}`
 *     normal:    `${yr?`You have ${fr}, and the `:"The "}branch ${ir} may hold ` +
 *       `unpushed commits (commit baseline unavailable)... The branch will be deleted if you remove.`
 *
 *   remove-option description (Os/sr @250245600):
 *     sr = hookBased && count===null && !hasUncommitted →
 *       "Any unpushed commits in the worktree may be lost."
 *
 * Pre-fix OCC ran git rev-list unconditionally; hook worktrees carry no
 * originalHeadCommit so the query failed and `parseInt('')||0` → 0 → clean
 * hook worktrees were removed SILENTLY on quit.
 */

// ---------------------------------------------------------------------------
// Module mocks (load-time snapshots spread in — bun mock.module live bindings)
// ---------------------------------------------------------------------------

type MockSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

let mockSession: MockSession | null = null
let mockSessionTitle: string | undefined
let cleanupCalls = 0
let keepCalls = 0

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_EXEC_SNAPSHOT = { ...REAL_EXEC_NS }
const REAL_WORKTREE_SNAPSHOT = { ...REAL_WORKTREE_NS }
const REAL_SESSION_SNAPSHOT = { ...REAL_SESSION_NS }

/** Per-test git responders. */
let gitStatusResult: { stdout: string; stderr: string; code: number } = {
  stdout: '',
  stderr: '',
  code: 0,
}
let gitRevListResult: { stdout: string; stderr: string; code: number } = {
  stdout: '0\n',
  stderr: '',
  code: 0,
}
// 2.1.304 #30: the at-stake classifier runs `symbolic-ref -q HEAD`, the
// rev-list counts, and for-each-ref via execFileNoThrowWithCwd inside the
// worktree path. Default: HEAD is on the session's own branch (its_branch).
let gitSymbolicRefResult: { stdout: string; stderr: string; code: number } = {
  stdout: 'refs/heads/claude/wt-301\n',
  stderr: '',
  code: 0,
}

await mock.module('../../utils/worktree.js', () => ({
  ...REAL_WORKTREE_SNAPSHOT,
  getCurrentWorktreeSession: () => mockSession,
  cleanupWorktree: async () => {
    cleanupCalls += 1
  },
  keepWorktree: async () => {
    keepCalls += 1
  },
  killTmuxSession: async () => true,
}))

function execFileNoThrowMock() {
  return {
    ...REAL_EXEC_SNAPSHOT,
    execFileNoThrow: async (_file: string, args: string[]) => {
      if (args[0] === 'status') {
        return { ...gitStatusResult, error: undefined }
      }
      if (args[0] === 'rev-list') {
        return { ...gitRevListResult, error: undefined }
      }
      return { stdout: '', stderr: '', code: 0, error: undefined }
    },
    execFileNoThrowWithCwd: async (_file: string, args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { ...gitSymbolicRefResult, error: undefined }
      }
      if (args[0] === 'rev-list') {
        return { ...gitRevListResult, error: undefined }
      }
      if (args[0] === 'for-each-ref') {
        // Branch exists by default (branchMissing → false).
        return {
          stdout: 'refs/heads/claude/wt-301\n',
          stderr: '',
          code: 0,
          error: undefined,
        }
      }
      return { stdout: '', stderr: '', code: 0, error: undefined }
    },
  }
}

await mock.module('../../utils/execFileNoThrow.js', execFileNoThrowMock)

await mock.module('../../utils/sessionStorage.js', () => ({
  ...REAL_SESSION_SNAPSHOT,
  getCurrentSessionTitle: () => mockSessionTitle,
  saveWorktreeState: () => {},
}))

const { WorktreeExitDialog } = await import('../WorktreeExitDialog.js')

// ---------------------------------------------------------------------------
// Render harness
// ---------------------------------------------------------------------------

const OFFICIAL_HOOK_SUBTITLE =
  "A WorktreeCreate hook made this worktree, so Claude Code can't tell whether it has unpushed commits."

function makeBaseSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    originalCwd: process.cwd(),
    worktreePath: '/tmp/wt-301-test',
    worktreeName: 'wt-301-test',
    sessionId: 'session-301-test',
    ...overrides,
  }
}

type RenderResult = {
  text: () => string
  unmount: () => void
  doneCalls: Array<string | undefined>
}

async function renderDialog(): Promise<RenderResult> {
  let output = ''
  const stdout = new PassThrough()
  ;(stdout as any).columns = 200
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stdinStub = stdin as unknown as Record<string, unknown>
  stdinStub.isTTY = true
  stdinStub.setRawMode = () => {}
  stdinStub.ref = () => {}
  stdinStub.unref = () => {}

  const doneCalls: Array<string | undefined> = []
  const instance = await render(
    <WorktreeExitDialog
      onDone={(result?: string) => {
        doneCalls.push(result)
      }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    },
  )
  return {
    // Ink frames are cumulative repaints — normalize whitespace so wrapped
    // lines compare equal to the official single-line strings.
    text: () => stripAnsi(output).replace(/\s+/g, ' '),
    unmount: () => instance.unmount(),
    doneCalls,
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

beforeEach(() => {
  mockSession = null
  mockSessionTitle = undefined
  cleanupCalls = 0
  keepCalls = 0
  gitStatusResult = { stdout: '', stderr: '', code: 0 }
  gitRevListResult = { stdout: '0\n', stderr: '', code: 0 }
  gitSymbolicRefResult = {
    stdout: 'refs/heads/claude/wt-301\n',
    stderr: '',
    code: 0,
  }
})

afterEach(() => {
  mock.restore()
})

afterAll(() => {
  // Restore the real modules for every later test file in this worker
  // (OCC-97: Bun's mock.module crosses file boundaries).
  mock.module('../../utils/worktree.js', () => ({ ...REAL_WORKTREE_SNAPSHOT }))
  mock.module('../../utils/execFileNoThrow.js', () => ({
    ...REAL_EXEC_SNAPSHOT,
  }))
  mock.module('../../utils/sessionStorage.js', () => ({
    ...REAL_SESSION_SNAPSHOT,
  }))
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hookBased + clean worktree: dialog ASKS with the official v301 subtitle (no silent removal)', async () => {
  mockSession = makeBaseSession({ hookBased: true })
  gitStatusResult = { stdout: '', stderr: '', code: 0 }

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    expect(dialog.text()).toContain(OFFICIAL_HOOK_SUBTITLE)
    // Official sr remove-option description for hook worktrees (v301-new).
    expect(dialog.text()).toContain(
      'Any unpushed commits in the worktree may be lost.',
    )
    // The silent fast path must NOT have fired.
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('hookBased + session title: subtitle gains the official session-name sentence', async () => {
  mockSession = makeBaseSession({ hookBased: true })
  mockSessionTitle = 'fix-bug'

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    expect(dialog.text()).toContain(
      `${OFFICIAL_HOOK_SUBTITLE} This session was named "fix-bug". Keep the worktree to resume it later.`,
    )
    expect(cleanupCalls).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('hookBased + uncommitted changes: official uncommitted prefix precedes the hook sentence', async () => {
  mockSession = makeBaseSession({ hookBased: true })
  gitStatusResult = { stdout: ' M file.txt\n', stderr: '', code: 0 }

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    expect(dialog.text()).toContain(
      `You have 1 uncommitted file. These will be lost if you remove the worktree. ${OFFICIAL_HOOK_SUBTITLE}`,
    )
    expect(cleanupCalls).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('hookBased: no rev-list query is attempted (hook worktrees carry no commit baseline)', async () => {
  mockSession = makeBaseSession({ hookBased: true })
  const gitCalls: string[][] = []
  await mock.module('../../utils/execFileNoThrow.js', () => ({
    ...execFileNoThrowMock(),
    execFileNoThrow: async (_file: string, args: string[]) => {
      gitCalls.push(args)
      if (args[0] === 'status') {
        return { ...gitStatusResult, error: undefined }
      }
      return { ...gitRevListResult, error: undefined }
    },
  }))

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    expect(gitCalls.some(args => args[0] === 'rev-list')).toBe(false)
  } finally {
    dialog.unmount()
    // Restore the shared fake for subsequent tests.
    await mock.module('../../utils/execFileNoThrow.js', execFileNoThrowMock)
  }
})

test('non-hook clean worktree with 0 unpushed commits: silent removal unchanged', async () => {
  mockSession = makeBaseSession({
    worktreeBranch: 'claude/wt-301',
    originalHeadCommit: 'abc123',
  })
  gitStatusResult = { stdout: '', stderr: '', code: 0 }
  gitRevListResult = { stdout: '0\n', stderr: '', code: 0 }

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.doneCalls.length > 0)
    expect(cleanupCalls).toBe(1)
    expect(dialog.doneCalls[0]).toBe('Worktree removed (no changes)')
    expect(dialog.text()).not.toContain('Exiting worktree session')
    expect(dialog.text()).not.toContain(OFFICIAL_HOOK_SUBTITLE)
  } finally {
    dialog.unmount()
  }
})

test('non-hook worktree with failed rev-list: asks with the counted-baseline copy', async () => {
  mockSession = makeBaseSession({
    worktreeBranch: 'claude/wt-301',
    originalHeadCommit: 'abc123',
  })
  gitStatusResult = { stdout: '', stderr: '', code: 0 }
  gitRevListResult = { stdout: '', stderr: 'fatal: bad revision', code: 128 }

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    // OCC-164: official v304 conditional — the session HAS a commit baseline
    // (originalHeadCommit), so the unreadable-HEAD copy is "commits that
    // could not be counted"; "(commit baseline unavailable)" only renders
    // when originalHeadCommit is absent.
    expect(dialog.text()).toContain(
      'The branch claude/wt-301 may hold commits that could not be counted. The branch will be deleted if you remove.',
    )
    // Pre-301 OCC would have silently removed here (parseInt('')||0 → 0).
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('non-hook worktree with unpushed commits: existing ask behavior unchanged', async () => {
  mockSession = makeBaseSession({
    worktreeBranch: 'claude/wt-301',
    originalHeadCommit: 'abc123',
  })
  gitStatusResult = { stdout: '', stderr: '', code: 0 }
  gitRevListResult = { stdout: '2\n', stderr: '', code: 0 }

  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))
    expect(dialog.text()).toContain(
      'You have 2 commits on claude/wt-301. The branch will be deleted if you remove the worktree.',
    )
    expect(dialog.text()).not.toContain(OFFICIAL_HOOK_SUBTITLE)
    expect(cleanupCalls).toBe(0)
  } finally {
    dialog.unmount()
  }
})
