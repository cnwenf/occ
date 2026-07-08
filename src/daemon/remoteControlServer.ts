/**
 * B7 — Remote Control server (daemon's local HTTP bridge).
 *
 * Listens on a Unix socket (~/.claude/daemon-remote.sock) and exposes a
 * token-authenticated HTTP API so other devices/channels (mobile, Slack,
 * another machine via SSH tunnel) can query session state and send commands
 * to a running OCC daemon.
 *
 * Endpoints:
 *   GET  /status          — supervisor identity + worker list + pending prompts
 *   POST /prompt          — queue a prompt for the session {content, source?}
 *   POST /stop            — stop a worker by id or pid {id?|pid?}
 *   POST /prompts/drain   — return + clear pending prompts
 *
 * Auth: Bearer token in the Authorization header. The token + socket path
 * are written into the daemon lockfile by the supervisor so clients can
 * discover them via readLockfile().
 *
 * No external WebSocket library — uses Node's http module only.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { logEvent } from '../services/analytics/index.js'
import { listWorkers, getWorker, settleWorker } from './workerRegistry.js'
import { isPidAlive, sigtermWorker } from './process.js'

/** Socket filename under ~/.claude/. */
const REMOTE_SOCKET_NAME = 'daemon-remote.sock'
/** File mirroring the in-memory prompt queue (cross-process visibility). */
const REMOTE_PROMPTS_FILE = 'daemon-remote-prompts.json'
/** File mirroring the active Slack channel (cross-process visibility). */
const REMOTE_CHANNEL_FILE = 'daemon-remote-channel.json'

/** Max body size for POST requests (bytes). */
const MAX_BODY_BYTES = 256 * 1024

/** Where the Unix socket lives. */
export function getRemoteControlSocketPath(): string {
  return join(getClaudeConfigHomeDir(), REMOTE_SOCKET_NAME)
}

/** Where the prompt-queue mirror file lives. */
export function getRemoteControlPromptsPath(): string {
  return join(getClaudeConfigHomeDir(), REMOTE_PROMPTS_FILE)
}

/** Where the active-channel mirror file lives. */
export function getRemoteControlChannelPath(): string {
  return join(getClaudeConfigHomeDir(), REMOTE_CHANNEL_FILE)
}

/** Generate a fresh opaque auth token. */
export function generateRemoteControlToken(): string {
  return randomBytes(24).toString('hex')
}

/** A queued remote prompt (mirrored to disk). */
export interface PendingPrompt {
  id: string
  content: string
  receivedAt: number
  source?: string
}

/**
 * The Slack channel currently bound to this RC session (I14). Set when a
 * Slack integration posts a prompt carrying channel metadata, or via
 * `POST /channel`. Mirrored to disk so it survives RC server restarts.
 * `name` is the channel name without the leading `#`.
 */
export interface RemoteChannel {
  name: string
  /** Where the channel binding originated (e.g. 'slack'). */
  source?: string
}

/** State of the RC server returned to callers. */
export interface RemoteControlServerHandle {
  server: Server
  token: string
  socketPath: string
}

/** In-memory prompt queue (authoritative; mirrored to disk best-effort). */
const promptQueue: PendingPrompt[] = []

/** Load the on-disk prompt mirror into memory (called at server start). */
function loadPromptMirror(): void {
  promptQueue.length = 0
  try {
    if (!existsSync(getRemoteControlPromptsPath())) return
    const raw = readFileSync(getRemoteControlPromptsPath(), { encoding: 'utf-8' })
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const p of parsed) {
        if (p && typeof p.id === 'string' && typeof p.content === 'string') {
          promptQueue.push({
            id: p.id,
            content: p.content,
            receivedAt: typeof p.receivedAt === 'number' ? p.receivedAt : Date.now(),
            source: typeof p.source === 'string' ? p.source : undefined,
          })
        }
      }
    }
  } catch {
    // corrupt mirror — start empty
  }
}

/** Persist the in-memory queue to disk (best-effort). */
function savePromptMirror(): void {
  try {
    writeFileSync(getRemoteControlPromptsPath(), JSON.stringify(promptQueue), {
      encoding: 'utf-8',
    })
  } catch {
    // best-effort
  }
}

/**
 * Drain pending remote prompts (return + clear). Exported so an in-process
 * REPL hook can claim queued prompts; cross-process clients use the
 * `POST /prompts/drain` endpoint.
 */
export function drainPendingPrompts(): PendingPrompt[] {
  const drained = [...promptQueue]
  promptQueue.length = 0
  savePromptMirror()
  return drained
}

/** Peek pending prompts without removing them. */
export function peekPendingPrompts(): PendingPrompt[] {
  return [...promptQueue]
}

/** Active Slack channel binding (I14). Null when no channel is connected. */
let activeChannel: RemoteChannel | null = null

/** Load the on-disk channel mirror into memory (called at server start). */
function loadChannelMirror(): void {
  try {
    if (!existsSync(getRemoteControlChannelPath())) return
    const raw = readFileSync(getRemoteControlChannelPath(), { encoding: 'utf-8' })
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed.name === 'string' &&
      parsed.name.length > 0
    ) {
      activeChannel = {
        name: parsed.name,
        source: typeof parsed.source === 'string' ? parsed.source : undefined,
      }
    } else {
      activeChannel = null
    }
  } catch {
    // corrupt mirror — start with no channel
    activeChannel = null
  }
}

/** Persist the active channel to disk (best-effort). */
function saveChannelMirror(): void {
  try {
    writeFileSync(
      getRemoteControlChannelPath(),
      activeChannel ? JSON.stringify(activeChannel) : 'null',
      { encoding: 'utf-8' },
    )
  } catch {
    // best-effort
  }
}

/** Read the active channel binding (for in-process consumers). */
export function getActiveChannel(): RemoteChannel | null {
  return activeChannel ? { ...activeChannel } : null
}

/**
 * Set or clear the active channel binding. Persisted to disk so it survives
 * RC server restarts. Passing null clears the binding.
 */
export function setActiveChannel(channel: RemoteChannel | null): void {
  if (channel && typeof channel.name === 'string' && channel.name.length > 0) {
    activeChannel = { name: channel.name, source: channel.source }
  } else {
    activeChannel = null
  }
  saveChannelMirror()
}

/** Read the request body as a string, capped at MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let len = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      len += chunk.length
      if (len > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Validate the Bearer token. Returns true if authorized. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  // constant-time-ish compare
  const provided = match[1].trim()
  if (provided.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}

/** Route a single request. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Health endpoint is unauthenticated (used for liveness probes).
  if (path === '/health' && method === 'GET') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (!isAuthorized(req, token)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  if (path === '/status' && method === 'GET') {
    const workers = listWorkers().map(w => ({
      id: w.id,
      pid: w.pid,
      kind: w.kind,
      outcome: w.outcome,
      startedAt: w.startedAt,
      cwd: w.cwd,
      restart: w.restart,
    }))
    sendJson(res, 200, {
      supervisorPid: process.pid,
      pendingPrompts: peekPendingPrompts(),
      workers,
      channel: getActiveChannel(),
    })
    return
  }

  if (path === '/prompt' && method === 'POST') {
    let parsed: any
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const content = typeof parsed?.content === 'string' ? parsed.content : ''
    if (!content.trim()) {
      sendJson(res, 400, { error: 'content is required' })
      return
    }
    const prompt: PendingPrompt = {
      id: `p-${Date.now()}-${randomBytes(3).toString('hex')}`,
      content,
      receivedAt: Date.now(),
      source: typeof parsed?.source === 'string' ? parsed.source : 'remote',
    }
    promptQueue.push(prompt)
    savePromptMirror()
    // I14: a prompt carrying channel metadata binds the session to that
    // Slack channel so the REPL can show a #channel header.
    const channel = parsed?.channel
    if (channel && typeof channel.name === 'string' && channel.name.length > 0) {
      setActiveChannel({
        name: channel.name,
        source: typeof channel.source === 'string' ? channel.source : prompt.source,
      })
    }
    logEvent('daemon_remote_control_prompt', { source: prompt.source as any })
    sendJson(res, 202, { id: prompt.id, accepted: true })
    return
  }

  if (path === '/prompts/drain' && method === 'POST') {
    const drained = drainPendingPrompts()
    sendJson(res, 200, { drained })
    return
  }

  // I14: set or clear the active Slack channel binding. Body { name, source? }
  // sets the channel; an empty body or { name: "" } clears it.
  if (path === '/channel' && method === 'POST') {
    let parsed: any
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const name = typeof parsed?.name === 'string' ? parsed.name : ''
    if (name.length > 0) {
      setActiveChannel({
        name,
        source: typeof parsed?.source === 'string' ? parsed.source : undefined,
      })
    } else {
      setActiveChannel(null)
    }
    logEvent('daemon_remote_control_channel', {
      action: name.length > 0 ? ('set' as any) : ('clear' as any),
    })
    sendJson(res, 200, { channel: getActiveChannel() })
    return
  }

  if (path === '/stop' && method === 'POST') {
    let parsed: any
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const id = typeof parsed?.id === 'string' ? parsed.id : undefined
    const pid = typeof parsed?.pid === 'number' ? parsed.pid : undefined
    if (id) {
      const rec = getWorker(id)
      if (!rec) {
        sendJson(res, 404, { error: `no worker with id ${id}` })
        return
      }
      if (isPidAlive(rec.pid)) {
        sigtermWorker(rec.pid)
      }
      await settleWorker(id, 2000)
      sendJson(res, 200, { id, stopped: true, outcome: rec.outcome })
      return
    }
    if (pid) {
      sigtermWorker(pid)
      logEvent('daemon_remote_control_stop', { pid: pid as any })
      sendJson(res, 200, { pid, stopped: true })
      return
    }
    sendJson(res, 400, { error: 'id or pid is required' })
    return
  }

  sendJson(res, 404, { error: `unknown route ${method} ${path}` })
}

/**
 * Start the remote-control HTTP server on the Unix socket.
 *
 * Removes any stale socket file first, then listens. Returns the handle
 * (server + token + socketPath) so the supervisor can register the
 * token/socketPath in the lockfile and stop the server on shutdown.
 *
 * Returns null if the socket could not be bound.
 */
export async function startRemoteControlServer(
  token: string,
): Promise<RemoteControlServerHandle | null> {
  const socketPath = getRemoteControlSocketPath()

  // Clean up any stale socket from a previous supervisor that didn't unwind.
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
  } catch {
    // ignore
  }

  loadPromptMirror()
  loadChannelMirror()

  const server = createServer((req, res) => {
    handleRequest(req, res, token).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' })
      }
    })
  })

  // Unix socket path length limit (~104 macOS, 108 Linux). If the path is too
  // long, fall back to a localhost TCP port.
  const MAX_SOCKET_PATH = 100
  const listenTarget: { path: string } | { port: number; host: string } =
    socketPath.length > MAX_SOCKET_PATH
      ? { port: 0, host: '127.0.0.1' }
      : { path: socketPath }

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: any) => {
      reject(err)
    })
    server.listen(listenTarget, () => resolve())
  }).catch(() => null)

  if (!server.listening) {
    return null
  }

  const address = server.address()
  const resolvedSocketPath =
    typeof address === 'object' && address !== null && 'path' in address
      ? (address as any).path
      : socketPath

  logEvent('daemon_remote_control_started', {})

  return { server, token, socketPath: resolvedSocketPath }
}

/**
 * Stop the remote-control server and remove the socket file.
 */
export async function stopRemoteControlServer(handle: RemoteControlServerHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve())
    // If there are pending connections, close won't fire immediately; resolve
    // after a short grace anyway.
    setTimeout(resolve, 500)
  })
  try {
    if (existsSync(handle.socketPath)) {
      unlinkSync(handle.socketPath)
    }
  } catch {
    // ignore
  }
  savePromptMirror()
  saveChannelMirror()
  logEvent('daemon_remote_control_stopped', {})
}
