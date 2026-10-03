/**
 * Minimal fake LSP server for timeout tests (fixture — not a test file).
 *
 * Speaks raw JSON-RPC over stdio with LSP `Content-Length` framing:
 * - answers `initialize` and `shutdown` normally
 * - exits on the `exit` notification
 * - NEVER answers any other request — simulates a language server that stalls
 *   (e.g. mid dynamic-capability-registration), the official v288 #55 bug.
 */

let buffer = Buffer.alloc(0)

function send(msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg)
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
  )
}

function handleMessage(msg: {
  id?: number | string
  method?: string
}): void {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
    return
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') {
    process.exit(0)
  }
  // Every other request/notification: intentionally never answered.
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return
    }
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length: *(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const contentLength = Number(match[1])
    const messageEnd = headerEnd + 4 + contentLength
    if (buffer.length < messageEnd) {
      return
    }
    const body = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
    buffer = buffer.subarray(messageEnd)
    try {
      handleMessage(JSON.parse(body))
    } catch {
      // Malformed frame — ignore, keep the server alive.
    }
  }
})
