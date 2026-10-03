/**
 * v2.1.288 PORT #69 — "Improved cloud sessions: a new conversation's first
 * turn no longer waits for a stdio MCP server whose config sets
 * alwaysLoad: false".
 *
 * Official 2.1.288 linux-x64 ELF @226009370 (`$h`, with its conversation scan
 * `uR` and the shared empty set `qh`):
 *
 *   var qh=new Set,lR=new Set([qG,AN,sj]);
 *   function uR(e,r){let n=(s)=>r!==void 0&&z(r,(g)=>g===s)===1;
 *     try{let s=new Set,g=nY(e,r&&{surfaced:{exceptAnnouncements:new Set}}),S=new Set(g);
 *       for(let h of e)
 *         if(h.type==="assistant"){for(let M of h.message.content)
 *             if(M.type==="tool_use") g.add(M.name),S.add(M.name)}
 *         else if(h.type==="attachment"){let{attachment:M}=h;
 *           if(M.type==="deferred_tools_delta"){
 *             for(let w of qs(M.addedNames)) g.add(w);
 *             for(let w of qs(M.wireHiddenNames)) g.add(w),S.add(w)}
 *           else if(M.type==="mcp_instructions_delta")
 *             for(let w of qs(M.addedNames)){let E=fF(w); if(!n(E)) s.add(E)}}
 *       for(let h of g){let M=as(h);
 *         if(M){if(S.has(h)||!n(M.serverName)) s.add(M.serverName)}
 *         else if(lR.has(h)||h.startsWith("mcp__")) return}
 *       return s}
 *     catch(s){t(`MCP prewait: reading the conversation failed: ${l(s)}`,{level:"error"});return}}
 *   function $h({policyAllows:e,clients:r,requiredServerNames:n,messages:s}){
 *     let g=r.filter((M)=>M.type==="pending"&&M.config.alwaysLoad===!1
 *               &&(M.config.type===void 0||M.config.type==="stdio"));
 *     if(g.length===0||!e()||VPe()!=="tst"||!Qh()) return qh;
 *     let S=uR(s,DJe()?r.map((M)=>fF(M.name)):void 0);
 *     if(S===void 0) return qh;
 *     let h=n();
 *     return new Set(g.map((M)=>({name:M.name,segment:fF(M.name)}))
 *       .filter((M)=>!h.has(M.segment)&&!S.has(M.segment)).map((M)=>M.name))}
 *
 * and the wait orchestrator `ga` consumes it as `skipServerNames:he`:
 *   K=(It)=>(ae===void 0||ae.has(It.name))&&!he?.has(It.name)&&…
 *   telemetry: pendingFullyDeferredSkippedBefore:z(Ut.clients,
 *     (It)=>It.type==="pending"&&he?.has(It.name)===!0&&!_t(It))
 * `skipServerNames` marker count 0→5 and `MCP prewait` 0→2 vs 2.1.287.
 *
 * `fF` (official @199725239) is `as(`${$s(e)}x`)?.serverName??En(e)` — OCC
 * already ports both halves as `getMcpServerNameCollisionKey` (official `Jd`)
 * and `normalizeNameForMCP` (official `En`/`wn`).
 *
 * Documented OCC divergences (see computeFirstTurnSkipServerNames):
 *  - `policyAllows()` / `Qh()` (deferral active) have no OCC equivalent; OCC's
 *    deferral IS the `alwaysLoad:false` candidate predicate.
 *  - `lR` (three builtin tool names that force a bail) is not ported — the
 *    `startsWith("mcp__")` bail is, which is the part that protects MCP names.
 *  - OCC's waitForMcpConnectionBatch races ONE merged batch promise instead of
 *    `ga`'s per-client store subscription, so the skip applies only when it
 *    covers the whole batch.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../types.js'

// Spy on the leveled debug logger the official uses for the fail-safe message.
const actualDebug = await import('../../../utils/debug.js')
const debugCalls: { message: string; level: string }[] = []
mock.module('../../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, options?: { level?: string }) => {
    debugCalls.push({ message, level: options?.level ?? 'debug' })
  },
}))

const {
  EMPTY_SKIP_SERVER_NAMES,
  MCP_CONNECTION_TIMEOUT_MS,
  computeFirstTurnSkipServerNames,
  waitForMcpConnectionBatch,
} = await import('../client.js')

afterEach(() => {
  debugCalls.length = 0
  delete process.env.MCP_CONNECTION_NONBLOCKING
})

afterAll(() => {
  mock.module('../../../utils/debug.js', () => ({ ...actualDebug }))
})

function stdioClient(
  name: string,
  alwaysLoad: boolean | undefined,
  overrides: { type?: 'stdio' | 'http'; clientType?: MCPServerConnection['type'] } = {},
): MCPServerConnection {
  const config = {
    ...(overrides.type === undefined ? {} : { type: overrides.type }),
    command: 'srv',
    args: [],
    scope: 'user',
    ...(alwaysLoad === undefined ? {} : { alwaysLoad }),
  } as unknown as ScopedMcpServerConfig
  return {
    name,
    type: overrides.clientType ?? 'pending',
    config,
  } as unknown as MCPServerConnection
}

function userText(text: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantToolUse(toolName: string): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: toolName }] },
  } as unknown as Message
}

describe('2.1.288 #69: first-turn prewait skip set', () => {
  test('skips a pending stdio alwaysLoad:false server the first turn never references', () => {
    // Arrange
    const clients = [stdioClient('widgets', false, { type: 'stdio' })]

    // Act
    const skipped = computeFirstTurnSkipServerNames({
      clients,
      messages: [userText('hello there')],
      isFirstTurn: true,
    })

    // Assert
    expect([...skipped]).toEqual(['widgets'])
  })

  test('skips a config with no explicit type (official: config.type===void 0 counts as stdio)', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('legacy', false)],
      messages: [],
      isFirstTurn: true,
    })

    // Assert
    expect([...skipped]).toEqual(['legacy'])
  })

  test('still waits on a server referenced by a first-turn tool call', () => {
    // Arrange
    const clients = [stdioClient('widgets', false, { type: 'stdio' })]

    // Act
    const skipped = computeFirstTurnSkipServerNames({
      clients,
      messages: [assistantToolUse('mcp__widgets__list_things')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits on a server named in the first-turn prompt text', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('widgets', false, { type: 'stdio' })],
      messages: [userText('run mcp__widgets__list_things for me')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits when alwaysLoad is true', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('eager', true, { type: 'stdio' })],
      messages: [userText('hello')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits when alwaysLoad is unset', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('default', undefined, { type: 'stdio' })],
      messages: [userText('hello')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits on a non-stdio (http) server', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('remote', false, { type: 'http' })],
      messages: [userText('hello')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits on a server that is not pending', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('up', false, { type: 'stdio', clientType: 'connected' })],
      messages: [userText('hello')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('still waits on a required server (official requiredServerNames segment match)', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('widgets', false, { type: 'stdio' })],
      messages: [userText('hello')],
      isFirstTurn: true,
      requiredServerNames: () => new Set(['widgets']),
    })

    // Assert
    expect(skipped.size).toBe(0)
  })

  test('non-first turn returns the shared empty set (official VPe()!=="tst" → qh)', () => {
    // Arrange / Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('widgets', false, { type: 'stdio' })],
      messages: [userText('hello')],
      isFirstTurn: false,
    })

    // Assert
    expect(skipped.size).toBe(0)
    expect(skipped).toBe(EMPTY_SKIP_SERVER_NAMES)
  })

  test('logs the official message and waits normally when reading the conversation throws', () => {
    // Arrange — an unreadable conversation (iterator throws)
    const throwingMessages = {
      [Symbol.iterator]() {
        throw new Error('transcript unavailable')
      },
    } as unknown as readonly Message[]

    // Act
    const skipped = computeFirstTurnSkipServerNames({
      clients: [stdioClient('widgets', false, { type: 'stdio' })],
      messages: throwingMessages,
      isFirstTurn: true,
    })

    // Assert — fail-safe: nothing is skipped, and the official string is logged
    expect(skipped.size).toBe(0)
    expect(debugCalls).toHaveLength(1)
    expect(debugCalls[0]!.level).toBe('error')
    expect(debugCalls[0]!.message.startsWith('MCP prewait: reading the conversation failed: ')).toBe(true)
    expect(debugCalls[0]!.message).toContain('transcript unavailable')
  })

  test('fails safe when a conversation name looks like an MCP tool but cannot be parsed', () => {
    // Arrange — official `uR` bails (returns undefined) on an unparseable
    // "mcp__"-prefixed name, and `$h` turns that into `qh`.
    const clients = [stdioClient('widgets', false, { type: 'stdio' })]

    // Act
    const skipped = computeFirstTurnSkipServerNames({
      clients,
      messages: [assistantToolUse('mcp__')],
      isFirstTurn: true,
    })

    // Assert
    expect(skipped.size).toBe(0)
  })
})

describe('2.1.288 #69: waitForMcpConnectionBatch honors skipServerNames', () => {
  test("returns 'skipped' immediately when the skip set covers the batch", async () => {
    // Arrange — a connection promise that never settles (the slow stdio server)
    const never = new Promise(() => {})
    const started = Date.now()

    // Act
    const result = await waitForMcpConnectionBatch(never, 'regular', {
      skipServerNames: new Set(['widgets']),
      batchServerNames: ['widgets'],
    })

    // Assert
    expect(result).toBe('skipped')
    expect(Date.now() - started).toBeLessThan(MCP_CONNECTION_TIMEOUT_MS)
  })

  test("still waits when the skip set does not cover the batch", async () => {
    // Arrange
    const resolves = new Promise(resolve => setTimeout(resolve, 10))

    // Act
    const result = await waitForMcpConnectionBatch(resolves, 'regular', {
      skipServerNames: new Set(['widgets']),
      batchServerNames: ['widgets', 'github'],
    })

    // Assert
    expect(result).toBe('connected')
  })

  test('is unchanged when no options are passed (existing callers)', async () => {
    // Arrange
    const resolves = new Promise(resolve => setTimeout(resolve, 10))

    // Act
    const result = await waitForMcpConnectionBatch(resolves, 'regular')

    // Assert
    expect(result).toBe('connected')
  })
})
