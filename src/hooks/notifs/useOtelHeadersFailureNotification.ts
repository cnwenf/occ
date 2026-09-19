import { useEffect } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import type { Notification } from '../../context/notifications.js'
import {
  getOtelHeadersLastFailure,
  subscribeOtelHeadersFailure,
} from '../../utils/auth.js'
import { truncate } from '../../utils/truncate.js'

/**
 * 2.1.275: startup warning when the configured otelHeadersHelper fails, so
 * sessions that silently export no telemetry are noticed.
 *
 * Port of the official notification service `HGt` (v2.1.276 binary
 * @217401542; key string @92371252, text @92748384/217401830). OCC's
 * notification surface has no `kind` field, so the official `kind:"warning"`
 * maps onto `color:"warning"`. The official growthbook gate
 * (`tengu_quirky_teacup`, default true) is omitted.
 */

/** Official `UGt` key (v2.1.276 @92371252/217401542). */
export const OTEL_HEADERS_HELPER_FAILED_NOTIFICATION_KEY =
  'otel-headers-helper-failed'

/** Official notification timeout (`timeoutMs:30000` @217401880). */
const OTEL_HEADERS_FAILURE_TIMEOUT_MS = 30_000

/** Official message cap (`wn(te,120)` @217401930). */
const OTEL_HEADERS_FAILURE_MESSAGE_MAX_LENGTH = 120

/** Byte-exact official prefix (@92748384/217401830). */
const OTEL_HEADERS_FAILURE_TEXT_PREFIX =
  'otelHeadersHelper failed; telemetry is not being exported. See /status: '

export function buildOtelHeadersFailureNotification(
  message: string,
): Notification {
  return {
    key: OTEL_HEADERS_HELPER_FAILED_NOTIFICATION_KEY,
    color: 'warning',
    priority: 'high',
    timeoutMs: OTEL_HEADERS_FAILURE_TIMEOUT_MS,
    text: `${OTEL_HEADERS_FAILURE_TEXT_PREFIX}${truncate(message, OTEL_HEADERS_FAILURE_MESSAGE_MAX_LENGTH)}`,
  }
}

/**
 * Framework-agnostic core of the official service setup (@217401620): a
 * fire-once latch that checks the already-recorded failure first, then
 * subscribes for later failures. Returns the cleanup (unsubscribe).
 */
export function createOtelHeadersFailureNotifier(
  addNotification: (notification: Notification) => void,
): () => void {
  let hasNotified = false
  const notify = (message: string): void => {
    if (hasNotified) {
      return
    }
    hasNotified = true
    addNotification(buildOtelHeadersFailureNotification(message))
  }
  const existingFailure = getOtelHeadersLastFailure()
  if (existingFailure !== null) {
    notify(existingFailure)
  }
  return subscribeOtelHeadersFailure(notify)
}

/**
 * Hook wired in the REPL (interactive sessions only, matching the official
 * interactive gating of the failure surface). Skipped in remote mode like
 * the sibling notification hooks.
 */
export function useOtelHeadersFailureNotification(): void {
  const { addNotification } = useNotifications()
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    return createOtelHeadersFailureNotifier(addNotification)
  }, [addNotification])
}
