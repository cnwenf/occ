/**
 * Fake stdio MCP server used by the stderr-cap integration test.
 *
 * Speaks just enough MCP JSON-RPC (newline-delimited, per the SDK's stdio
 * framing) to complete the `initialize` handshake, while flooding stderr with
 * more than the cap worth of bytes: a distinctive HEAD marker, a large fill of
 * 'y' bytes, then a distinctive TAIL marker. This reproduces a chatty/faulty
 * stdio MCP server that would otherwise exhaust memory or hit Node's
 * child_process maxBuffer (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
 *
 * Run with: bun <this-file>   (FAKE_STDERR_BYTES env overrides the flood size)
 */
import { createInterface } from 'node:readline'

// Default flood size: ~65MB, just over the 64MB cap. Override for faster runs.
const floodBytes = Number(process.env.FAKE_STDERR_BYTES ?? 65 * 1024 * 1024)

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function writeJson(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line: string) => {
  if (!line.trim()) return
  let msg: { id?: number | string; method?: string }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  if (msg.method === 'initialize') {
    // 1) Distinctive HEAD marker (written first → must be retained).
    process.stderr.write('FAKE-STDERR-HEAD-MARKER\n')
    // 2) Flood >cap bytes of fill, respecting backpressure so the fake server
    //    itself doesn't buffer the whole flood in memory.
    const chunk = Buffer.alloc(64 * 1024, 0x79) // 64KB of 'y'
    let written = 0
    // Synchronous loop; backpressure is handled by the client reading stderr
    // concurrently via the attached 'data' listener.
    while (written < floodBytes) {
      process.stderr.write(chunk)
      written += chunk.length
    }
    // 3) Distinctive TAIL marker (written last, after the cap → must be dropped).
    process.stderr.write('\nFAKE-STDERR-TAIL-MARKER')
    // 4) Complete the handshake so the client's connect() resolves.
    writeJson({
      jsonrpc: '2.0',
      id: msg.id ?? 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'chatty-fake', version: '1.0.0' },
      },
    })
  } else if (msg.method === 'notifications/initialized') {
    // Handshake complete; exit shortly so the child process terminates.
    setTimeout(() => process.exit(0), 50)
  }
})
