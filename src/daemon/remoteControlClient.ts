/**
 * B7 — Remote Control client.
 *
 * Connects to the daemon's local remote-control HTTP server (see
 * remoteControlServer.ts) from another process — used by the
 * `claude remote-control` command, mobile app shims, Slack integrations, or
 * another machine via SSH tunnel.
 *
 * Discovers the socket path + auth token by reading the daemon lockfile
 * (~/.claude/daemon.lock), so the caller does not need to know the
 * connection details ahead of time.
 */

import { request, type RequestOptions } from 'http'
import { connect } from 'net'
import { readLockfile, getDaemonLockfilePath } from './lockfile.js'
import {
  getRemoteControlSocketPath,
  type PendingPrompt,
  type RemoteChannel,
} from './remoteControlServer.js'

/** A snapshot of the session state returned by GET /status. */
export interface RemoteControlStatus {
  supervisorPid: number
  pendingPrompts: PendingPrompt[]
  workers: Array<{
    id: string
    pid: number
    kind: string
    outcome: string
    startedAt: number
    cwd: string
    restart: number
  }>
  /** Active Slack channel binding (I14). Null when no channel is connected. */
  channel: RemoteChannel | null
}

/** Result of queueing a prompt via POST /prompt. */
export interface PromptAccepted {
  id: string
  accepted: boolean
}

/** Result of draining prompts via POST /prompts/drain. */
export interface PromptsDrained {
  drained: PendingPrompt[]
}

export interface RemoteControlClient {
  /** GET /status — supervisor identity, workers, pending prompts, channel. */
  getStatus(): Promise<RemoteControlStatus>
  /** POST /prompt — queue a prompt for the session. */
  sendPrompt(content: string, source?: string): Promise<PromptAccepted>
  /** POST /stop — stop a worker by id or pid. */
  stopTask(opts: { id?: string; pid?: number }): Promise<unknown>
  /** POST /prompts/drain — return + clear pending prompts. */
  drainPrompts(): Promise<PromptsDrained>
  /** POST /channel — set (name set) or clear (name empty) the channel binding. */
  setChannel(name?: string, source?: string): Promise<{ channel: RemoteChannel | null }>
}

/** Connection details resolved from the lockfile. */
export interface RemoteControlEndpoint {
  socketPath: string
  token: string
}

/**
 * Read the daemon lockfile and extract the RC endpoint (socket + token).
 * Returns null if the daemon isn't running or RC isn't configured.
 */
export async function resolveRemoteControlEndpoint(): Promise<RemoteControlEndpoint | null> {
  const lock = await readLockfile()
  if (!lock) return null
  if (!lock.remoteControlToken || !lock.remoteControlSocketPath) {
    return null
  }
  return {
    socketPath: lock.remoteControlSocketPath,
    token: lock.remoteControlToken,
  }
}

/** Build RequestOptions for a Unix-socket HTTP request. */
function buildOptions(
  endpoint: RemoteControlEndpoint,
  method: string,
  path: string,
): RequestOptions {
  return {
    method,
    path,
    socketPath: endpoint.socketPath,
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  }
}

/** Issue a single HTTP request over the Unix socket; returns parsed JSON. */
function rpc(
  endpoint: RemoteControlEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts = buildOptions(endpoint, method, path)
    const req = request(opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw}`))
          return
        }
        if (!raw) {
          resolve(undefined)
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('invalid JSON response'))
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'))
    })
    if (body !== undefined) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

/**
 * Create a remote-control client. Resolves the endpoint from the daemon
 * lockfile; throws if the daemon / RC server is not reachable.
 */
export async function connectRemoteControlClient(): Promise<RemoteControlClient> {
  const endpoint = await resolveRemoteControlEndpoint()
  if (!endpoint) {
    throw new Error(
      `Remote Control is not available — the daemon is not running or the RC server is not configured (check ${getDaemonLockfilePath()}).`,
    )
  }
  // Quick liveness probe on the socket.
  if (!await isSocketReachable(endpoint.socketPath)) {
    throw new Error(
      `Remote Control socket ${endpoint.socketPath} is not reachable. Is the daemon running?`,
    )
  }
  return {
    getStatus: () => rpc(endpoint, 'GET', '/status') as Promise<RemoteControlStatus>,
    sendPrompt: (content: string, source?: string) =>
      rpc(endpoint, 'POST', '/prompt', { content, source }) as Promise<PromptAccepted>,
    stopTask: (opts: { id?: string; pid?: number }) =>
      rpc(endpoint, 'POST', '/stop', opts),
    drainPrompts: () =>
      rpc(endpoint, 'POST', '/prompts/drain') as Promise<PromptsDrained>,
    setChannel: (name?: string, source?: string) =>
      rpc(endpoint, 'POST', '/channel', name ? { name, source } : {}) as Promise<{
        channel: RemoteChannel | null
      }>,
  }
}

/**
 * Non-throwing status fetch for in-process REPL pollers (I14). Resolves the
 * RC endpoint from the lockfile, probes the socket, and returns the status —
 * or null when the daemon / RC server is not running (no lockfile, socket
 * unreachable, or any RPC error). Never rejects.
 */
export async function fetchRemoteControlStatus(): Promise<RemoteControlStatus | null> {
  try {
    const client = await connectRemoteControlClient()
    return await client.getStatus()
  } catch {
    return null
  }
}

/** Probe whether a Unix socket is currently accepting connections. */
function isSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = connect(socketPath, () => {
      conn.end()
      resolve(true)
    })
    conn.on('error', () => resolve(false))
    // Short timeout — the socket is local.
    conn.setTimeout(2000, () => {
      conn.destroy()
      resolve(false)
    })
  })
}

export {
  getRemoteControlSocketPath,
  getDaemonLockfilePath,
}
