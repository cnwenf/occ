import { test, expect, describe, mock, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  switchSession,
  setOriginalCwd,
  setCwdState,
  getOriginalCwd,
  getCwdState,
  getSessionId,
  getSessionProjectDir,
} from '../../src/bootstrap/state.js'

// CC 2.1.216 #14 no-resurrect — real-disk tests for sessionStorage.ts
// disk-tombstone + deleteRemoteAgentMetadata hardening (items 2 & 3).
// Uses a real temp project dir so readDeletedSessions/appendDeletedSession
// hit the real filesystem, and deleteRemoteAgentMetadata's no-silent-swallow
// contract is verified against a real non-ENOENT unlink failure.

const logCalls: string[] = []

// Capture logForDebugging so the "must LOG the failure" contract (item 3)
// is asserted, not just the throw. Provide the full debug.ts surface as
// no-ops so sessionStorage's transitive importers (services/api/client.ts)
// don't break on a missing export.
mock.module('../../src/utils/debug.js', () => ({
  getMinDebugLogLevel: () => 'debug' as const,
  isDebugMode: () => false,
  enableDebugLogging: () => false,
  getDebugFilter: () => null,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: () => Promise.resolve(),
  logForDebugging: (msg: string) => {
    logCalls.push(msg)
  },
  getDebugLogPath: () => '',
  logAntError: () => {},
}))

const { appendDeletedSession, readDeletedSessions, deleteRemoteAgentMetadata } =
  await import('../../src/utils/sessionStorage.js')

let projectDir: string
const SESSION_ID = 'test-session-noresurrect'

// Saved bootstrap STATE so afterEach can restore it. This file mutates
// sessionId / originalCwd / sessionProjectDir / cwd; without restore the leak
// breaks downstream files (fork UUID assertion, resumeAgentPrompt +
// resumeModelBehavioral path resolution under getOriginalCwd/getSessionProjectDir).
let savedOriginalCwd: string
let savedCwd: string
let savedSessionId: string
let savedSessionProjectDir: string | null

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'nr-disk-'))
  // Snapshot global STATE before mutating it.
  savedOriginalCwd = getOriginalCwd()
  savedCwd = getCwdState()
  savedSessionId = getSessionId() as string
  savedSessionProjectDir = getSessionProjectDir()
  // Point the bootstrap state at the temp project dir so the sidecar /
  // tombstone paths resolve under it. switchSession atomically sets
  // sessionId + sessionProjectDir (CC-34).
  setOriginalCwd(projectDir)
  setCwdState(projectDir)
  switchSession(SESSION_ID as never, projectDir)
  logCalls.length = 0
})

afterEach(() => {
  // Restore the global session state so the temp dir + session id don't leak
  // into other test files after the temp dir is deleted.
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  switchSession(savedSessionId as never, savedSessionProjectDir)
  rmSync(projectDir, { recursive: true, force: true })
})

describe('Item 2 — disk tombstone (real filesystem)', () => {
  test('appendDeletedSession writes a file readDeletedSessions reads fresh', async () => {
    await appendDeletedSession('disk-1')
    const path = join(projectDir, SESSION_ID, 'deleted-sessions.json')
    expect(existsSync(path)).toBe(true)
    // Fresh read (simulates a restarted client reading the list cold).
    const ids = await readDeletedSessions()
    expect(ids).toEqual(['disk-1'])
  })

  test('multiple appends accumulate; duplicates deduped', async () => {
    await appendDeletedSession('a')
    await appendDeletedSession('b')
    await appendDeletedSession('a') // idempotent
    const ids = await readDeletedSessions()
    expect(ids).toEqual(['a', 'b'])
  })

  test('readDeletedSessions returns [] when the file does not exist', async () => {
    // Fresh project dir, no tombstone written yet.
    const ids = await readDeletedSessions()
    expect(ids).toEqual([])
  })
})

describe('Item 3 — deleteRemoteAgentMetadata no-silent-swallow', () => {
  test('nonexistent sidecar (ENOENT) resolves silently — benign', async () => {
    // No file created. ENOENT is the "already absent" case.
    await deleteRemoteAgentMetadata('never-existed')
    // No log for the benign ENOENT path.
    const enoentLogs = logCalls.filter(l => l.includes('never-existed'))
    expect(enoentLogs).toEqual([])
  })

  test('non-ENOENT unlink failure is logged AND thrown, not swallowed', async () => {
    // Make the remote-agents PATH a regular FILE (not a directory), so the
    // metadata path (file/sub) fails unlink with ENOTDIR. ENOTDIR is in the
    // OLD isFsInaccessible set, so the old code swallowed it SILENTLY (no
    // throw, no log). The hardened path must LOG + throw. This works as root
    // (ENOTDIR is not bypassed by uid 0 the way EACCES is) and proves the
    // delta against the old silent-swallow behavior.
    const taskId = 'enotdir-fail'
    const sessionDir = join(projectDir, SESSION_ID)
    mkdirSync(sessionDir, { recursive: true })
    // Create a regular file where the remote-agents DIRECTORY would be.
    writeFileSync(join(sessionDir, 'remote-agents'), 'not-a-dir')
    let threw = false
    let errCode: string | undefined
    try {
      await deleteRemoteAgentMetadata(taskId)
    } catch (e) {
      threw = true
      errCode = (e as NodeJS.ErrnoException | undefined)?.code
    }
    expect(threw).toBe(true)
    expect(errCode).toBe('ENOTDIR')
    // The hardening contract: the failure is LOGGED, not silent.
    const logged = logCalls.some(l => l.includes(taskId))
    expect(logged).toBe(true)
  })
})
