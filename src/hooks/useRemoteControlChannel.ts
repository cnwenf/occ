/**
 * useRemoteControlChannel — REPL poller for the active Slack channel binding
 * (I14).
 *
 * When OCC is connected to a Slack channel via the daemon's Remote Control
 * server (B7), the RC server tracks an active channel binding (set via
 * `POST /channel` or carried by `POST /prompt`). This hook polls
 * `GET /status` for that binding so the REPL can render a `#channel` header.
 *
 * Never throws. `fetchRemoteControlStatus` resolves to null when the daemon
 * or RC server isn't running (no lockfile, socket unreachable, RPC error),
 * so this hook is a no-op for a standalone REPL with no daemon — no
 * regression. A transient poll failure keeps the last known channel (avoids
 * header flicker during a brief daemon blip); an authoritative
 * `status.channel === null` clears it.
 */
import { useEffect, useState } from 'react'
import { fetchRemoteControlStatus } from '../daemon/remoteControlClient.js'
import type { RemoteChannel } from '../daemon/remoteControlServer.js'

/** How often to poll the RC /status endpoint for the channel binding. */
const POLL_INTERVAL_MS = 5000

/** True when two channel bindings are equivalent (name + source match). */
function sameChannel(
  a: RemoteChannel | null,
  b: RemoteChannel | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.name === b.name && (a.source ?? '') === (b.source ?? '')
}

/**
 * @returns the active Slack channel, or null when none is connected / the
 *          daemon isn't running.
 */
export function useRemoteControlChannel(): RemoteChannel | null {
  const [channel, setChannel] = useState<RemoteChannel | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async (): Promise<void> => {
      const status = await fetchRemoteControlStatus()
      if (cancelled) return
      // Unreachable (no daemon / transient RPC error): keep the last known
      // channel so the header doesn't flicker during a brief daemon blip.
      if (status === null) return
      setChannel(prev =>
        sameChannel(prev, status.channel) ? prev : (status.channel ?? null),
      )
    }

    void poll()
    const timer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return channel
}
