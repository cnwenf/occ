/**
 * CC 2.1.304 #30 — ExitWorktreeTool at-stake gate.
 *
 * Official fix: removal counts at-stake commits on `refs/heads/<worktreeBranch>`
 * via the HEAD classifier (official `Cn`/`G$r`/`nOt`), not on `HEAD` — a
 * detached or moved-off HEAD no longer hides the worktree branch's commits.
 * Plus the `onKeptBranch` refinement: HEAD sits on another branch that holds
 * commits the session baseline lacks — removal keeps that branch (nothing
 * lost) but must never proceed silently (official verbatim refusal message;
 * trailing confirm guidance is OCC's `${f} ${Dt}` equivalent).
 *
 * Scenarios (task #30d): detached-with-branch-commits → refuses (errorCode 2);
 * another-branch-with-commits → refuses; onKeptBranch → verbatim refusal;
 * its_branch clean → allowed; unreadable HEAD → fail-closed (errorCode 3).
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import * as REAL_EXEC_NS from '../../../utils/execFileNoThrow.js'
import * as REAL_WORKTREE_NS from '../../../utils/worktree.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_EXEC_SNAPSHOT = { ...REAL_EXEC_NS }
const REAL_WORKTREE_SNAPSHOT = { ...REAL_WORKTREE_NS }

type GitResult = { stdout: string; stderr: string; code: number }

type MockSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalHeadCommit?: string
  sessionId: string
  hookBased?: boolean
}

let mockSession: MockSession | null = null
let gitStatusResult: GitResult = { stdout: '', stderr: '', code: 0 }
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

await mock.module('../../../utils/worktree.js', () => ({
  ...REAL_WORKTREE_SNAPSHOT,
  getCurrentWorktreeSession: () => mockSession,
}))

await mock.module('../../../utils/execFileNoThrow.js', () => ({
  ...REAL_EXEC_SNAPSHOT,
  execFileNoThrow: async (_file: string, args: string[]) => {
    if (args.includes('status')) {
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

const { ExitWorktreeTool } = await import('../ExitWorktreeTool.js')

const BRANCH = 'claude/wt-304'
const WT_PATH = '/tmp/wt-304-tool'
const CONFIRM_TAIL =
  'Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.'

function makeSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    originalCwd: process.cwd(),
    worktreePath: WT_PATH,
    worktreeName: 'wt-304-tool',
    worktreeBranch: BRANCH,
    originalHeadCommit: 'abc123',
    sessionId: 'session-304-tool',
    ...overrides,
  }
}

async function validateRemove() {
  // validateInput on the built tool — the at-stake gate lives entirely here.
  return await (ExitWorktreeTool as any).validateInput({ action: 'remove' })
}

beforeEach(() => {
  mockSession = makeSession()
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
  mock.module('../../../utils/worktree.js', () => ({
    ...REAL_WORKTREE_SNAPSHOT,
  }))
  mock.module('../../../utils/execFileNoThrow.js', () => ({
    ...REAL_EXEC_SNAPSHOT,
  }))
})

test('detached HEAD holding branch commits → refuses with errorCode 2 (pre-304: HEAD count 0 → allowed)', async () => {
  // Arrange
  symbolicRefResult = { stdout: '', stderr: '', code: 1 }
  revListImpl = () => ({ stdout: '3\n', stderr: '', code: 0 })

  // Act
  const result = await validateRemove()

  // Assert
  expect(result.result).toBe(false)
  expect(result.errorCode).toBe(2)
  expect(result.message).toBe(
    `Worktree has 3 commits on ${BRANCH}. Removing will discard this work permanently. ${CONFIRM_TAIL}`,
  )
})

test('HEAD on another branch holding branch commits → refuses with errorCode 2', async () => {
  // Arrange
  symbolicRefResult = { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 }
  revListImpl = () => ({ stdout: '2\n', stderr: '', code: 0 })

  // Act
  const result = await validateRemove()

  // Assert
  expect(result.result).toBe(false)
  expect(result.errorCode).toBe(2)
  expect(result.message).toContain(`2 commits on ${BRANCH}`)
})

test('onKeptBranch refinement → official verbatim refusal (removal keeps the branch, still never silent)', async () => {
  // Arrange — classification count 0; kept branch (refs/heads/feature-x) has 4.
  symbolicRefResult = { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 }
  revListImpl = args =>
    args[2] === 'refs/heads/feature-x'
      ? { stdout: '4\n', stderr: '', code: 0 }
      : { stdout: '0\n', stderr: '', code: 0 }

  // Act
  const result = await validateRemove()

  // Assert
  expect(result.result).toBe(false)
  expect(result.errorCode).toBe(2)
  expect(result.message).toBe(
    `The worktree is now on another branch, which has 4 commits that this session's starting commit lacks. Removing the worktree keeps that branch, so no commit is lost, but the user may still be working there. ${CONFIRM_TAIL}`,
  )
})

test('its_branch clean → removal allowed', async () => {
  // Arrange — defaults: HEAD on the session branch, 0 commits, clean status.

  // Act
  const result = await validateRemove()

  // Assert
  expect(result).toEqual({ result: true })
})

test('unreadable HEAD → fail-closed with errorCode 3 (cannot verify state)', async () => {
  // Arrange — symbolic-ref fails with a non-detached signature.
  symbolicRefResult = { stdout: '', stderr: 'fatal: not a git repo', code: 128 }

  // Act
  const result = await validateRemove()

  // Assert
  expect(result.result).toBe(false)
  expect(result.errorCode).toBe(3)
  expect(result.message).toContain(`Could not verify worktree state at ${WT_PATH}`)
})

test('discard_changes: true bypasses the at-stake gate (explicit confirmation)', async () => {
  // Arrange
  symbolicRefResult = { stdout: '', stderr: '', code: 1 }
  revListImpl = () => ({ stdout: '3\n', stderr: '', code: 0 })

  // Act
  const result = await (ExitWorktreeTool as any).validateInput({
    action: 'remove',
    discard_changes: true,
  })

  // Assert
  expect(result).toEqual({ result: true })
})
