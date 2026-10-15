/**
 * CC 2.1.299 #101 — `--safe-mode` background sessions silently leave safe
 * mode on wake/restart.
 *
 * Official mechanism (v299 @228912399/@230297193): the bg-session env carry
 * list `Cke` starts with `O=["CLAUDE_CODE_SAFE_MODE","CLAUDE_CODE_SIMPLE",
 * "CLAUDE_CODE_RESTRICTED"]`; recorded session env's carry vars are re-applied
 * at respawn (`for(let f of Cke)if(!e.env?.[f])delete o[f]`) — a session that
 * was started in safe mode keeps CLAUDE_CODE_SAFE_MODE across restarts.
 *
 * OCC port: WorkerRecord gains `safeMode`, captured at spawn time from the
 * worker's effective env, persisted in daemon-status.json, and restored as
 * CLAUDE_CODE_SAFE_MODE on every respawn path (forceRespawnWorker / eStale).
 */
import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Daemon-local dependency mock (same pattern as workerRegistryCwdCanonicalize):
// pid liveness stubbed dead so respawn paths run without real processes.
mock.module('../../daemon/process.js', () => ({
  isPidAlive: () => false,
  pidRecycled: () => false,
  sigtermWorker: () => {},
}))

const spawnCalls: Array<{ args: string[]; opts: Record<string, any> }> = []
let nextPid = 5000
const makeFakeChild = () => {
  const child = {
    pid: nextPid++,
    on: () => child,
    once: () => child,
  }
  return child
}

const {
  spawnWorker,
  forceRespawnWorker,
  eStale,
  getWorker,
  writeDaemonStatus,
  readDaemonStatus,
  _setSpawnForTesting,
  _resetForTesting,
} = await import('../workerRegistry.js')

const restoreSpawn = _setSpawnForTesting(
  (_cmd: string, _args: string[], opts: Record<string, any>) => {
    spawnCalls.push({ args: _args as string[], opts })
    return makeFakeChild() as never
  },
)

let tmpConfigHome: string
let savedConfigDir: string | undefined
let savedSafeMode: string | undefined

function setUp(): void {
  tmpConfigHome = mkdtempSync(join(tmpdir(), 'occ-safemode-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedSafeMode = process.env.CLAUDE_CODE_SAFE_MODE
  process.env.CLAUDE_CONFIG_DIR = tmpConfigHome
  delete process.env.CLAUDE_CODE_SAFE_MODE
  spawnCalls.length = 0
}

function tearDown(): void {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedSafeMode === undefined) delete process.env.CLAUDE_CODE_SAFE_MODE
  else process.env.CLAUDE_CODE_SAFE_MODE = savedSafeMode
  try {
    rmSync(tmpConfigHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('CC 2.1.299 #101: safe-mode persistence for background sessions', () => {
  beforeEach(setUp)
  afterEach(tearDown)

  afterAll(() => {
    restoreSpawn()
    _resetForTesting()
    mock.restore()
  })

  test('spawnWorker records safeMode=true when the worker env sets CLAUDE_CODE_SAFE_MODE', () => {
    // Arrange / Act
    const rec = spawnWorker('default', {
      env: { CLAUDE_CODE_SAFE_MODE: '1' },
    })

    // Assert
    expect(rec.safeMode).toBe(true)
  })

  test('spawnWorker records safeMode=false when nothing sets safe mode', () => {
    // Arrange / Act
    const rec = spawnWorker('default', {})

    // Assert
    expect(rec.safeMode).toBe(false)
  })

  test('spawnWorker records safeMode from the supervisor env when no worker env is given', () => {
    // Arrange
    process.env.CLAUDE_CODE_SAFE_MODE = 'true'

    // Act
    const rec = spawnWorker('default', {})

    // Assert
    expect(rec.safeMode).toBe(true)
  })

  test('forceRespawnWorker restores CLAUDE_CODE_SAFE_MODE for a safe-mode session', () => {
    // Arrange — original spawn in safe mode.
    const rec = spawnWorker('default', {
      id: 'sm-1',
      env: { CLAUDE_CODE_SAFE_MODE: '1' },
    })
    expect(rec.safeMode).toBe(true)
    spawnCalls.length = 0

    // Act — respawn (restart path).
    const fresh = forceRespawnWorker('sm-1')

    // Assert — respawned worker env carries safe mode again.
    expect(fresh).not.toBeNull()
    expect(fresh!.safeMode).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.opts.env.CLAUDE_CODE_SAFE_MODE).toBe('1')
  })

  test('forceRespawnWorker does NOT leave safe mode on for a non-safe-mode session even if the daemon runs in safe mode', () => {
    // Arrange — worker recorded WITHOUT safe mode; daemon env now has it
    // (e.g. the daemon itself was restarted with --safe-mode).
    spawnWorker('default', { id: 'sm-2' })
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    spawnCalls.length = 0

    // Act
    const fresh = forceRespawnWorker('sm-2')

    // Assert — the recorded session state wins: safe mode stays OFF.
    expect(fresh!.safeMode).toBe(false)
    expect(spawnCalls[0]!.opts.env.CLAUDE_CODE_SAFE_MODE).toBe('0')
  })

  test('eStale respawn carries the recorded safe-mode flag', () => {
    // Arrange
    const rec = spawnWorker('prewarm', {
      id: 'sm-3',
      env: { CLAUDE_CODE_SAFE_MODE: '1' },
    })
    spawnCalls.length = 0

    // Act — stale-respawn path.
    eStale(getWorker('sm-3')!, 'stalled')

    // Assert
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.opts.env.CLAUDE_CODE_SAFE_MODE).toBe('1')
    expect(rec.safeMode).toBe(true)
  })

  test('safeMode round-trips through the persisted daemon-status snapshot', () => {
    // Arrange — one safe-mode session, one normal session.
    spawnWorker('default', { id: 'sm-persist-1', env: { CLAUDE_CODE_SAFE_MODE: '1' } })
    spawnWorker('default', { id: 'sm-persist-2' })

    // Act
    writeDaemonStatus()
    const restored = readDaemonStatus()

    // Assert — session saved with safeMode → restored has safeMode;
    // without → false.
    const safe = restored.find(r => r.id === 'sm-persist-1')
    const normal = restored.find(r => r.id === 'sm-persist-2')
    expect(safe?.safeMode).toBe(true)
    expect(normal?.safeMode).toBe(false)
  })
})
