/**
 * CC 2.1.292 L26 (carryover, identical in the 2.1.293 binary) — Remote-Control
 * session-persist guards in sessionStorage's Project class, byte-verified
 * against the vprev/vver ELF extracts (cluster-c-h-carryover.md §L26):
 *
 *  ★ sidechain-via-writer persist guard (appendEntry dedup-transcript tail,
 *    verbatim):
 *      if(!z){if(G.add(e.uuid),jM(e))
 *        if(this.internalEventWriter&&$s())this.persistToRemote(n,e);
 *        else await this.persistToRemote(n,e)}
 *      else if(this.internalEventWriter&&jM(e))this.persistToRemote(n,e)
 *    — sidechain entries DO reach Remote Control through the CCR v2 internal
 *    event lane (fire-and-forget, agentId option), while the v1 session-
 *    ingress path must NEVER see them (inc-4718 single Last-Uuid chain →
 *    409 → gracefulShutdownSync(1)).
 *
 *  ★ shutdown nuance (persistToRemote head, verbatim):
 *      if(this.appendsSealedForShutdown)return;
 *      if($s()&&!this.internalEventWriter)return;
 *    + append-side seal machinery:
 *      appendsSealedForShutdown=!1;
 *      sealAppendsForShutdown(){this.appendsSealedForShutdown=!0}
 *      shouldSkipPersistence(){return La()||this.appendsSealedForShutdown}
 *      enqueueWrite(e,n,r){if(this.appendsSealedForShutdown)return Promise.resolve();...}
 *      export FYr as sealTranscriptAppendsForShutdown
 *    The old OCC behavior (unconditional `if (isShuttingDown()) return` in
 *    persistToRemote) dropped the final turns of CCR v2 sessions; the
 *    official only skips the v1 ingress path during shutdown and hard-stops
 *    everything once the internal-event lane closes (seal).
 *
 *  N-A in OCC (documented via source pins below + code comments in
 *  sessionStorage.ts): the /teleport skip (`jZn(n,this.internalEventWriterSessionId)`)
 *  and the compact-pair taint skip (`Tve(n)&&(this.foreignWithheldEntryUuids
 *  .delete(n.uuid)||yk(la(e)))`) — both predicates depend on machinery OCC
 *  does not have (teleport-pull session tracking; account-memory redaction
 *  bridge with foreignWithheldEntryUuids / history-suppression taint), so
 *  porting the guards would add unreachable dead code.
 *
 * Mock plumbing follows the OCC-97/129 leak-free delegation convention
 * (exemplar: sessionStorage.parallelTRRecovery286.test.ts).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, type UUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Leak-free delegation shims — installed BEFORE the module under test imports.
// ---------------------------------------------------------------------------
let mockActive = false

const actualAnalytics = await import('../../services/analytics/index.js')
const actualLogEvent = actualAnalytics.logEvent
const capturedEvents: Array<{ name: string; metadata: unknown }> = []
mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: unknown) => {
    if (!mockActive) {
      actualLogEvent(name, metadata as never)
      return
    }
    capturedEvents.push({ name, metadata })
  },
}))

const actualDebug = await import('../debug.js')
const actualLogForDebugging = actualDebug.logForDebugging
const debugLines: string[] = []
mock.module('../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (line: string, opts?: unknown) => {
    if (!mockActive) {
      actualLogForDebugging(line, opts as never)
      return
    }
    debugLines.push(line)
  },
}))

// gracefulShutdown: controllable isShuttingDown + captured (never real)
// gracefulShutdownSync — the real one exits the process.
const actualGS = await import('../gracefulShutdown.js')
const actualIsShuttingDown = actualGS.isShuttingDown
const actualGracefulShutdownSync = actualGS.gracefulShutdownSync
let fakeShuttingDown = false
const shutdownSyncCalls: Array<{ code: number; reason: string }> = []
mock.module('../gracefulShutdown.js', () => ({
  ...actualGS,
  isShuttingDown: () => (mockActive ? fakeShuttingDown : actualIsShuttingDown()),
  gracefulShutdownSync: ((code: number, reason: string) => {
    if (!mockActive) {
      actualGracefulShutdownSync(code, reason as never)
      return
    }
    shutdownSyncCalls.push({ code, reason })
  }) as typeof actualGracefulShutdownSync,
}))

// sessionIngress: capture v1 appendSessionLog calls (never hit the network).
const actualIngress = await import('../../services/api/sessionIngress.js')
const actualAppendSessionLog = actualIngress.appendSessionLog
const ingressCalls: Array<{ sessionId: string; uuid: string }> = []
mock.module('../../services/api/sessionIngress.js', () => ({
  ...actualIngress,
  appendSessionLog: async (
    sessionId: string,
    entry: { uuid: UUID },
    url: string,
  ) => {
    if (!mockActive) return actualAppendSessionLog(sessionId, entry as never, url)
    ingressCalls.push({ sessionId, uuid: String(entry.uuid) })
    return true
  },
}))

const ss = await import('../sessionStorage.js')

// ---------------------------------------------------------------------------
// Env + fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-l26-292-'))
const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'ENABLE_SESSION_PERSISTENCE',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

const SESSION_ID = randomUUID()
let fileCounter = 0

function baseFields(): Record<string, unknown> {
  fileCounter += 1
  return {
    parentUuid: null,
    cwd: '/tmp/occ-l26-fixture',
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: `2026-10-08T00:00:${String(fileCounter).padStart(2, '0')}.000Z`,
    version: '2.1.292',
    gitBranch: null,
    isSidechain: false,
  }
}

function userEntry(extra: Record<string, unknown> = {}): never {
  return {
    type: 'user',
    uuid: randomUUID(),
    isMeta: false,
    message: { role: 'user', content: 'hello' },
    ...baseFields(),
    ...extra,
  } as never
}

// Writer fixture — optional hold so fire-and-forget vs awaited is observable.
type WriterCall = {
  eventType: string
  payload: Record<string, unknown>
  options?: { isCompaction?: boolean; agentId?: string }
}
const writerCalls: WriterCall[] = []
let holdWriter: { promise: Promise<void>; resolve: () => void } | null = null

function registerCapturingWriter(): void {
  ss.setInternalEventWriter(
    async (
      eventType: string,
      payload: Record<string, unknown>,
      options?: { isCompaction?: boolean; agentId?: string },
    ) => {
      writerCalls.push({ eventType, payload, options })
      if (holdWriter) await holdWriter.promise
    },
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

let sessionFilePath = ''

beforeEach(() => {
  mockActive = true
  // Order-independence: v1 ingress is enabled per-test via enableV1Ingress().
  delete process.env.ENABLE_SESSION_PERSISTENCE
  fakeShuttingDown = false
  writerCalls.length = 0
  ingressCalls.length = 0
  shutdownSyncCalls.length = 0
  capturedEvents.length = 0
  debugLines.length = 0
  holdWriter = null
  ss.resetProjectForTesting()
  ss.clearSessionMessagesCache()
  sessionFilePath = join(TEST_CONFIG_DIR, `session-${randomUUID()}.jsonl`)
  ss.setSessionFileForTesting(sessionFilePath)
})

afterEach(() => {
  holdWriter = null
  mockActive = false
})

afterAll(async () => {
  mockActive = false
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
  mock.module('../debug.js', () => ({
    ...actualDebug,
    logForDebugging: actualLogForDebugging,
  }))
  mock.module('../gracefulShutdown.js', () => ({
    ...actualGS,
    isShuttingDown: actualIsShuttingDown,
    gracefulShutdownSync: actualGracefulShutdownSync,
  }))
  mock.module('../../services/api/sessionIngress.js', () => ({
    ...actualIngress,
    appendSessionLog: actualAppendSessionLog,
  }))
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

function enableV1Ingress(): void {
  process.env.ENABLE_SESSION_PERSISTENCE = '1'
  ss.setRemoteIngressUrlForTesting('https://ingress.test')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CC 2.1.292 L26 — RC session persist guards (sessionStorage)', () => {
  test('① sidechain entry WITH CCR v2 writer goes remote via the writer lane (agentId option), never via v1 ingress', async () => {
    registerCapturingWriter()
    enableV1Ingress() // prove writer precedence: v1 fully configured but unused
    const agentId = randomUUID()
    const entry = userEntry({ isSidechain: true, agentId })

    await ss.appendEntryForTesting(entry)
    await sleep(20)

    expect(writerCalls.length).toBe(1)
    expect(writerCalls[0]?.eventType).toBe('transcript')
    expect(writerCalls[0]?.options?.agentId).toBe(agentId)
    expect(writerCalls[0]?.payload?.uuid).toBe((entry as { uuid: string }).uuid)
    // inc-4718: sidechain rows must never reach v1 session ingress.
    expect(ingressCalls.length).toBe(0)
    expect(shutdownSyncCalls.length).toBe(0)
  })

  test('② sidechain entry WITHOUT writer never reaches v1 ingress (inc-4718 regression guard)', async () => {
    enableV1Ingress()
    const entry = userEntry({ isSidechain: true, agentId: randomUUID() })

    await ss.appendEntryForTesting(entry)
    await sleep(20)

    expect(ingressCalls.length).toBe(0)
    expect(shutdownSyncCalls.length).toBe(0)
  })

  test('③ main-thread entry during shutdown WITH writer is fire-and-forget, not skipped', async () => {
    registerCapturingWriter()
    holdWriter = (() => {
      let resolve!: () => void
      const promise = new Promise<void>(r => {
        resolve = r
      })
      return { promise, resolve }
    })()
    fakeShuttingDown = true
    const entry = userEntry()

    // appendEntry must resolve WITHOUT awaiting the pending writer call
    // (official: `if(this.internalEventWriter&&$s())this.persistToRemote(n,e)`
    // — unawaited). A pre-fix run skips the writer entirely; a naive port
    // that awaits would hang here until the test timeout.
    await ss.appendEntryForTesting(entry)

    expect(writerCalls.length).toBe(1)
    expect(writerCalls[0]?.options?.agentId).toBeUndefined()
    // Writer promise still pending at this point — release for cleanup.
    holdWriter.resolve()
    await sleep(10)
    expect(ingressCalls.length).toBe(0)
  })

  test('④ main-thread entry during shutdown WITHOUT writer still skips v1 ingress ($s()&&!writer guard)', async () => {
    enableV1Ingress()
    fakeShuttingDown = true
    const entry = userEntry()

    await ss.appendEntryForTesting(entry)
    await sleep(20)

    expect(ingressCalls.length).toBe(0)
    expect(shutdownSyncCalls.length).toBe(0)
  })

  test('⑤ sealTranscriptAppendsForShutdown stops appends, local writes, and remote persistence', async () => {
    registerCapturingWriter()
    enableV1Ingress()
    const sealFn = (
      ss as { sealTranscriptAppendsForShutdown?: () => void }
    ).sealTranscriptAppendsForShutdown
    expect(sealFn).toBeInstanceOf(Function)
    sealFn?.()

    await ss.appendEntryForTesting(userEntry())
    // Longer than FLUSH_INTERVAL_MS (10ms with a writer registered) — a
    // non-sealed run would have created the session file by now.
    await sleep(60)

    expect(writerCalls.length).toBe(0)
    expect(ingressCalls.length).toBe(0)
    expect(existsSync(sessionFilePath)).toBe(false)
  })

  test('⑥ source pins — verbatim guards landed, N-A guards documented with reasons', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../sessionStorage.ts', import.meta.url)),
      'utf8',
    )
    // Append-side seal machinery (field + method + export + both guards).
    expect(source).toContain('appendsSealedForShutdown')
    expect(source).toContain('sealAppendsForShutdown()')
    expect(source).toContain(
      'export function sealTranscriptAppendsForShutdown()',
    )
    expect(source).toMatch(
      /private enqueueWrite\([\s\S]{0,600}?if \(this\.appendsSealedForShutdown\)/,
    )
    // Shutdown nuance in persistToRemote (verbatim `if($s()&&!this.internalEventWriter)return`).
    expect(source).toContain('if (isShuttingDown() && !this.internalEventWriter)')
    // Sidechain-via-writer branch + main-thread fire-and-forget branch.
    expect(source).toMatch(
      /if \(this\.internalEventWriter && isShuttingDown\(\)\)\s*\{\s*void this\.persistToRemote/,
    )
    expect(source).toMatch(
      /\} else if \(\s*this\.internalEventWriter &&\s*isTranscriptMessage\(entry\)\s*\) \{\s*(?:\/\/[^\n]*\n\s*)*void this\.persistToRemote/,
    )
    // N-A documentation: teleport guard + compact-pair taint guard, with the
    // official verbatim lines and the reason they cannot fire in OCC.
    expect(source).toContain('jZn')
    expect(source).toContain('/teleport-pulled')
    expect(source).toContain('foreignWithheldEntryUuids')
    expect(source).toContain('Skipping compact-pair upload')
  })
})
