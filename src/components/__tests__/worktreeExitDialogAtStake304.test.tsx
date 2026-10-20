import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import * as REAL_EXEC_NS from '../../utils/execFileNoThrow.js'
import * as REAL_SESSION_NS from '../../utils/sessionStorage.js'
import * as REAL_WORKTREE_NS from '../../utils/worktree.js'
import { render } from '../../ink.js'

/**
 * CC 2.1.304 #30 — "Fixed `claude --worktree` removing the worktree and its
 * branch without asking at exit when HEAD was detached or on another branch,
 * which could lose commits."
 *
 * The pre-304 dialog counted `originalHeadCommit..HEAD` — with a detached or
 * moved-off HEAD, commits on the worktree's OWN branch were invisible (count
 * 0 → silent removal). The official fix classifies HEAD (symbolic-ref) and
 * counts at-stake commits on `refs/heads/<worktreeBranch>` (official `Cn` /
 * `G$r` / `nOt`, byte-recovered @249016065 — see
 * docs/gap-research-304/research-R6-env-misc.md #30).
 *
 * Scenario matrix (task #30d):
 * - detached HEAD holding branch commits → ASKS (was: silent removal)
 * - HEAD on another branch holding branch commits → ASKS (+ tOt phrase)
 * - onKeptBranch refinement (own branch clean, kept branch has commits) →
 *   ASKS, never silent removal
 * - its_branch clean → silent removal unchanged
 * - unreadable HEAD → ASKS (fail-closed)
 *
 * Same render harness as worktreeExitDialogHook301.test.tsx; git execution is
 * mocked at BOTH exec seams (execFileNoThrow for `git status`,
 * execFileNoThrowWithCwd for the at-stake classifier).
 */

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_EXEC_SNAPSHOT = { ...REAL_EXEC_NS }
const REAL_WORKTREE_SNAPSHOT = { ...REAL_WORKTREE_NS }
const REAL_SESSION_SNAPSHOT = { ...REAL_SESSION_NS }

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

type GitResult = { stdout: string; stderr: string; code: number }

let mockSession: MockSession | null = null
let cleanupCalls = 0
let keepCalls = 0

let gitStatusResult: GitResult = { stdout: '', stderr: '', code: 0 }
/** Per-test responders for the at-stake classifier's git commands. */
let symbolicRefResult: GitResult = {
  stdout: 'refs/heads/claude/wt-304\n',
  stderr: '',
  code: 0,
}
let revListImpl: (args: string[]) => GitResult = () => ({
  stdout: '0\n',
  stderr: '',
  code: 0,
})
let forEachRefResult: GitResult = {
  stdout: 'refs/heads/claude/wt-304\n',
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

await mock.module('../../utils/execFileNoThrow.js', () => ({
  ...REAL_EXEC_SNAPSHOT,
  execFileNoThrow: async (_file: string, args: string[]) => {
    if (args[0] === 'status') {
      return { ...gitStatusResult, error: undefined }
    }
    return { stdout: '', stderr: '', code: 0, error: undefined }
  },
  execFileNoThrowWithCwd: async (_file: string, args: string[]) => {
    if (args[0] === 'symbolic-ref') {
      return { ...symbolicRefResult, error: undefined }
    }
    if (args[0] === 'rev-list') {
      return { ...revListImpl(args), error: undefined }
    }
    if (args[0] === 'for-each-ref') {
      return { ...forEachRefResult, error: undefined }
    }
    return { stdout: '', stderr: '', code: 0, error: undefined }
  },
}))

await mock.module('../../utils/sessionStorage.js', () => ({
  ...REAL_SESSION_SNAPSHOT,
  getCurrentSessionTitle: () => undefined,
  saveWorktreeState: () => {},
}))

const { WorktreeExitDialog } = await import('../WorktreeExitDialog.js')

// ---------------------------------------------------------------------------
// Render harness (identical to the 301 test)
// ---------------------------------------------------------------------------

const BRANCH = 'claude/wt-304'

function makeSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    originalCwd: process.cwd(),
    worktreePath: '/tmp/wt-304-test',
    worktreeName: 'wt-304-test',
    worktreeBranch: BRANCH,
    originalHeadCommit: 'abc123',
    sessionId: 'session-304-test',
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
  cleanupCalls = 0
  keepCalls = 0
  gitStatusResult = { stdout: '', stderr: '', code: 0 }
  symbolicRefResult = { stdout: `refs/heads/${BRANCH}\n`, stderr: '', code: 0 }
  revListImpl = () => ({ stdout: '0\n', stderr: '', code: 0 })
  forEachRefResult = { stdout: `refs/heads/${BRANCH}\n`, stderr: '', code: 0 }
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

test('detached HEAD holding branch commits: ASKS with the official tOt detached phrase (pre-304: silent removal)', async () => {
  // Arrange — HEAD detached (symbolic-ref exits 1 silently); the branch ref
  // holds 3 commits beyond the session baseline.
  mockSession = makeSession()
  symbolicRefResult = { stdout: '', stderr: '', code: 1 }
  revListImpl = () => ({ stdout: '3\n', stderr: '', code: 0 })

  // Act
  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))

    // Assert
    expect(dialog.text()).toContain(
      `You have 3 commits on ${BRANCH} or at the detached HEAD. The branch will be deleted if you remove the worktree.`,
    )
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('HEAD on another branch holding branch commits: ASKS with the "that <other> doesn\'t have" phrase', async () => {
  // Arrange
  mockSession = makeSession()
  symbolicRefResult = { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 }
  revListImpl = () => ({ stdout: '2\n', stderr: '', code: 0 })

  // Act
  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))

    // Assert
    expect(dialog.text()).toContain(
      `You have 2 commits on ${BRANCH} that feature-x doesn't have. The branch will be deleted if you remove the worktree.`,
    )
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('onKeptBranch refinement: own branch clean but kept branch holds commits → ASKS (never silent removal)', async () => {
  // Arrange — classification rev-list (positive ref = our branch) → 0;
  // kept-branch rev-list (positive ref = refs/heads/feature-x) → 4.
  mockSession = makeSession()
  symbolicRefResult = { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 }
  revListImpl = args =>
    args[2] === 'refs/heads/feature-x'
      ? { stdout: '4\n', stderr: '', code: 0 }
      : { stdout: '0\n', stderr: '', code: 0 }

  // Act
  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))

    // Assert — official guard `!("onKeptBranch" in Cn)` blocks the silent
    // fast path even though changes=0 and commits=0.
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})

test('its_branch clean: silent removal unchanged', async () => {
  // Arrange — HEAD on the session branch, 0 unpushed commits, clean status.
  mockSession = makeSession()

  // Act
  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.doneCalls.length > 0)

    // Assert
    expect(cleanupCalls).toBe(1)
    expect(dialog.doneCalls[0]).toBe('Worktree removed (no changes)')
    expect(dialog.text()).not.toContain('Exiting worktree session')
  } finally {
    dialog.unmount()
  }
})

test('unreadable HEAD: ASKS with the baseline-unavailable copy (fail-closed)', async () => {
  // Arrange — symbolic-ref fails with an unexpected signature (code 128).
  mockSession = makeSession()
  symbolicRefResult = { stdout: '', stderr: 'fatal: not a git repo', code: 128 }

  // Act
  const dialog = await renderDialog()
  try {
    await waitFor(() => dialog.text().includes('Exiting worktree session'))

    // Assert
    expect(dialog.text()).toContain(
      `The branch ${BRANCH} may hold unpushed commits (commit baseline unavailable). The branch will be deleted if you remove.`,
    )
    expect(cleanupCalls).toBe(0)
    expect(dialog.doneCalls.length).toBe(0)
  } finally {
    dialog.unmount()
  }
})
