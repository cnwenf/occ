import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createCappedStderrAccumulator } from '../stderrCap.js'

/**
 * CC 2.1.208 #29 — end-to-end proof that the MCP stdio stderr cap works against
 * a real stdio MCP server process. A chatty/faulty server writes >64MB to
 * stderr during the handshake; the connection must survive (no
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` crash) and the captured stderr must be
 * bounded (head-retention soft cap). After a successful connection the stderr
 * listener is detached and the stream resumed, so post-connect stderr does not
 * accumulate — this is the actual 2.1.208 memory-leak fix.
 *
 * The stderr wiring below mirrors `src/services/mcp/client.ts` exactly
 * (instanceof Readable guard, capped accumulator, on('data'), success-path
 * off + resume). The accumulator + constant under test are the REAL production
 * code imported from `stderrCap.ts`.
 */
describe('2.1.208 #29 — MCP stdio stderr cap (integration)', () => {
  // Use a reduced cap + flood so the I/O-heavy integration test stays fast and
  // CI-friendly; the real 64MB constant + a 65MB feed are pinned in the unit
  // suite (stderrCap.test.ts). The mechanism exercised here is identical.
  const CAP = 1 * 1024 * 1024 // 1MB
  const FLOOD = CAP * 4 // 4MB, well over the cap so dropped data is unambiguous
  const fixturePath = new URL(
    './fixtures/chattyStdioServer.ts',
    import.meta.url,
).pathname

  let client: Client
  let transport: StdioClientTransport

  beforeAll(() => {
    // Arrange — real transport spawning the fake stdio server, with stderr
    // piped (same option production uses).
    transport = new StdioClientTransport({
      command: 'bun',
      args: [fixturePath],
      env: {
        ...process.env,
        FAKE_STDERR_BYTES: String(FLOOD),
      } as Record<string, string>,
      stderr: 'pipe',
    })
    client = new Client(
      { name: 'claude-code-test', version: '1.0.0' },
      { capabilities: {} },
    )
  })

  afterAll(async () => {
    try {
      await client.close()
    } catch {
      // ignore
    }
    try {
      await transport.close()
    } catch {
      // ignore
    }
  })

  test(
    'chatty stdio server (>cap stderr) does not crash connect; stderr is capped + head-retained',
    async () => {
      // Arrange — wire the REAL production accumulator exactly like client.ts.
      const stderrAcc = createCappedStderrAccumulator(CAP)
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrStream: Readable | undefined
      if (transport.stderr instanceof Readable) {
        stderrStream = transport.stderr
        stderrHandler = stderrAcc.handler
        stderrStream.on('data', stderrHandler)
      }

      // Act — connect (handshake + >cap stderr flood). Must NOT throw
      // ERR_CHILD_PROCESS_STDIO_MAXBUFFER or hang.
      await client.connect(transport)

      // Success path: detach the listener + resume the stream (the 2.1.208 fix).
      if (stderrHandler && stderrStream) {
        stderrStream.off('data', stderrHandler)
        stderrStream.resume()
        stderrHandler = undefined
      }

      const retained = stderrAcc.getOutput()

      // Assert — connection survived (we got here without throwing).
      // Assert — stderr is bounded near the cap despite a 4MB flood. The
      // soft cap (check-before-append) means the retained buffer is at most
      // `cap + one delivered chunk`, which stream coalescing can inflate, so
      // assert `cap * 2` as a robust upper bound that is far below the flood.
      expect(retained.length).toBeGreaterThan(0)
      expect(retained.length).toBeGreaterThanOrEqual(CAP)
      expect(retained.length).toBeLessThan(CAP * 2)
      expect(retained.length).toBeLessThan(FLOOD)
      // Assert — head-retention: the HEAD marker (written first) survived...
      expect(retained).toContain('FAKE-STDERR-HEAD-MARKER')
      // ...the TAIL marker (written after the cap was exceeded) was dropped.
      expect(retained).not.toContain('FAKE-STDERR-TAIL-MARKER')
    },
    30_000,
  )

  test('post-connect stderr does not accumulate (listener detached)', async () => {
    // Arrange — fresh accumulator + transport for an isolated run.
    const t = new StdioClientTransport({
      command: 'bun',
      args: [fixturePath],
      env: {
        ...process.env,
        FAKE_STDERR_BYTES: String(FLOOD),
      } as Record<string, string>,
      stderr: 'pipe',
    })
    const c = new Client(
      { name: 'claude-code-test', version: '1.0.0' },
      { capabilities: {} },
    )
    const stderrAcc = createCappedStderrAccumulator(CAP)
    let stderrHandler: ((data: Buffer) => void) | undefined
    let stderrStream: Readable | undefined
    if (t.stderr instanceof Readable) {
      stderrStream = t.stderr
      stderrHandler = stderrAcc.handler
      stderrStream.on('data', stderrHandler)
    }

    try {
      await c.connect(t)
      // Success path: detach + resume (mirrors client.ts).
      if (stderrHandler && stderrStream) {
        stderrStream.off('data', stderrHandler)
        stderrStream.resume()
        stderrHandler = undefined
      }
      const before = stderrAcc.getOutput().length

      // Act — push more "stderr" onto the (still-open) transport stream AFTER
      // connect. Because the listener was detached, this must NOT accumulate.
      stderrStream?.push(Buffer.from('POST-CONNECT-STDERR-SHOULD-NOT-ACCUMULATE'))

      // Give the stream a tick to deliver the pushed chunk.
      await new Promise((r) => setTimeout(r, 50))

      // Assert — no growth: the detached listener no longer captures stderr.
      expect(stderrAcc.getOutput().length).toBe(before)
      expect(stderrAcc.getOutput()).not.toContain(
        'POST-CONNECT-STDERR-SHOULD-NOT-ACCUMULATE',
      )
    } finally {
      try {
        await c.close()
      } catch {
        // ignore
      }
      try {
        await t.close()
      } catch {
        // ignore
      }
    }
  })
})
