import { mkdir, writeFile } from 'fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logOTelEvent } from './events.js'

// Mirrors the official 2.1.200 OTEL_LOG_RAW_API_BODIES handling (p5f/ZGl/t3l).
//
// The env var selects a mode:
//   file:<dir>  — write each request/response body as <request_id>.{request|response}.json
//   <truthy>    — inline: emit the body via an OTel log event
//   otherwise   — disabled
//
// Parsing is memoized on the raw env value (ZGl), so toggling the env at runtime
// re-resolves on the next call.

type RawApiBodiesConfig =
  | { mode: 'disabled' }
  | { mode: 'inline' }
  | { mode: 'file'; dir: string }

let cached: { raw: string | undefined; config: RawApiBodiesConfig } | undefined

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

// p5f(e): parse the raw env value into a config.
function parseRawApiBodiesConfig(
  value: string | undefined,
): RawApiBodiesConfig {
  if (value?.startsWith('file:')) {
    const dir = value.slice(5)
    return dir ? { mode: 'file', dir: path.resolve(dir) } : { mode: 'disabled' }
  }
  return isEnvTruthy(value) ? { mode: 'inline' } : { mode: 'disabled' }
}

// ZGl(): memoized config accessor.
export function getRawApiBodiesConfig(): RawApiBodiesConfig {
  const raw = process.env.OTEL_LOG_RAW_API_BODIES
  if (!cached || cached.raw !== raw) {
    cached = { raw, config: parseRawApiBodiesConfig(raw) }
  }
  return cached.config
}

// e3l(): whether raw API body logging is active.
export function isRawApiBodiesLoggingEnabled(): boolean {
  return getRawApiBodiesConfig().mode !== 'disabled'
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// f5f(e,t,n): write a file, creating the parent dir if missing.
async function writeRawBodyFile(
  dir: string,
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await writeFile(filePath, content)
  } catch {
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content)
  }
}

// t3l(e,t,n): log a raw API body. `eventName` is "api_request_body" or
// "api_response_body"; `body` is the request/response object; `metadata`
// carries the request_id used to name file dumps.
export function logRawApiBody(
  eventName: 'api_request_body' | 'api_response_body',
  body: unknown,
  metadata: { request_id?: string } = {},
): void {
  const config = getRawApiBodiesConfig()
  if (config.mode === 'disabled') return
  const content = safeJsonStringify(body)
  if (config.mode === 'file') {
    const kind = eventName === 'api_request_body' ? 'request' : 'response'
    const id = metadata.request_id ?? randomUUID()
    const safeId = /^[A-Za-z0-9_-]+$/.test(id) ? id : randomUUID()
    const filePath = path.join(config.dir, `${safeId}.${kind}.json`)
    void writeRawBodyFile(config.dir, filePath, content).catch(() => {
      // Swallow — raw-body logging is best-effort debugging telemetry.
    })
    return
  }
  // inline: emit via the OTel event logger
  void logOTelEvent(eventName, {
    request_id: metadata.request_id,
    body: content,
  })
}
