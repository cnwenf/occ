/**
 * CC 2.1.217 #5 — background session isolation: canonicalize symlinked cwd.
 *
 * When a background (daemon worker) session is spawned with a cwd, the cwd
 * must be realpath-canonicalized before being handed to spawn() so a symlinked
 * cwd resolves to its real target. This prevents a session from hiding behind
 * a symlink to escape its workspace folder — the recorded cwd is the real path.
 */
import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// We swap the module-local spawn entry point (NOT a process-wide
// `mock.module('child_process')`) so the real child_process stays intact for
// every other test file in the shared bun process. A global mock leaked into
// unrelated files and broke apiKeyHelper / cacheMarketplaceFromGit subprocess
// spawns and agentTelemetry analytics capture.
const spawnCalls: Array<{ args: string[]; opts: Record<string, unknown> }> = []
const fakeChild = {
  pid: 4242,
  on: () => fakeChild,
  once: () => fakeChild,
}

// `process.js` is a daemon-local dependency (only this module imports it);
// it has no external consumers, so a relative mock does not leak into other
// files' surfaces. Kept as a mock.module because it has no test seam and
// stubbing the live pid/signal helpers is benign + local.
mock.module('../../daemon/process.js', () => ({
  isPidAlive: () => false,
  pidRecycled: () => false,
  sigtermWorker: () => {},
}))

// --- Load the module under test AFTER the process.js mock is registered ------
const { spawnWorker, _setSpawnForTesting, _resetForTesting } = await import(
  '../workerRegistry.js'
)

// Wire the spawn seam to our capture stub for the duration of these tests.
const restoreSpawn = _setSpawnForTesting(
  (_cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ args, opts })
    return fakeChild as never
  },
)

// --- Helpers ----------------------------------------------------------------

let tmpRoot: string

function setUp(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), 'occ-bg-cwd-'))
}

function tearDown(): void {
  spawnCalls.length = 0
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// --- Tests -------------------------------------------------------------------

describe('spawnWorker: symlinked cwd canonicalization (CC 2.1.217 #5)', () => {
  beforeEach(setUp)
  afterEach(tearDown)

  afterAll(() => {
    restoreSpawn()
    _resetForTesting()
    mock.restore()
  })

  test('a symlinked cwd is realpath-resolved to the real target', () => {
    // Arrange — real workspace dir + a symlink to it.
    const realWs = join(tmpRoot, 'real-workspace')
    mkdirSync(realWs, { recursive: true })
    const symlinkCwd = join(tmpRoot, 'link-to-ws')
    symlinkSync(realWs, symlinkCwd, 'dir')
    const expectedReal = realpathSync(symlinkCwd).normalize('NFC')

    // Act
    const record = spawnWorker('prewarm', { cwd: symlinkCwd })

    // Assert — the cwd handed to spawn() is the realpath, not the symlink.
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.opts.cwd).toBe(expectedReal)
    // And the recorded WorkerRecord.cwd is the canonical real path.
    expect(record.cwd).toBe(expectedReal)
    expect(record.cwd).not.toBe(symlinkCwd)
  })

  test('a symlinked cwd that would escape the workspace is canonicalized to the real (escaped) path', () => {
    // Arrange — workspace folder W; an escape target E outside W; a symlink
    // *inside* W pointing to E. Taken literally, the symlink cwd looks like it
    // lives inside W (the workspace folder). After realpath canonicalization,
    // the recorded cwd is E — the escape is no longer hidden behind the symlink.
    const workspaceFolder = join(tmpRoot, 'workspace')
    const escapeTarget = join(tmpRoot, 'escape-target')
    mkdirSync(workspaceFolder, { recursive: true })
    mkdirSync(escapeTarget, { recursive: true })
    const symlinkInsideWs = join(workspaceFolder, 'lnk-to-escape')
    symlinkSync(escapeTarget, symlinkInsideWs, 'dir')
    const expectedReal = realpathSync(symlinkInsideWs).normalize('NFC')

    // Act
    const record = spawnWorker('prewarm', { cwd: symlinkInsideWs })

    // Assert — canonicalized to the real escape target, not the in-workspace symlink path.
    expect(record.cwd).toBe(expectedReal)
    expect(record.cwd).toBe(escapeTarget.normalize('NFC'))
    expect(record.cwd).not.toBe(symlinkInsideWs)
    expect(spawnCalls[0]!.opts.cwd).toBe(expectedReal)
  })
})
