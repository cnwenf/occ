/**
 * CC 2.1.305 (/usage one-line fixes): runtime binding for the official `iso`
 * applier — enqueues a UsageFix onto OCC's message queue and logs the
 * `usage_fix` telemetry event.
 *
 * This is the only module in src/commands/usage/ with runtime imports
 * outside the folder (messageQueueManager + analytics), keeping the pure
 * catalog (usageRecommendations.ts) and the scan (usageScan.ts) free of the
 * auth/settings module graph (OCC-97 mock-leakage hardening).
 *
 * OCC adaptations vs official `iso(e,t)` (v306 @256635621 region):
 *   - `agentId:Ze()` (official main-agent id) is omitted — OCC's queue
 *     treats an absent agentId as the main thread.
 *   - `skipAttachments:true` has no OCC QueuedCommand field; only
 *     skipSlashCommands is threaded (documented divergence — OCC prompt
 *     attachments are expanded at input time, not at dequeue time, so the
 *     flag would be a no-op even if present).
 *   - `origin:{kind:"auto-continuation"}` — QueuedCommand.origin is typed
 *     as MessageOrigin (string) but consumers read `.kind`
 *     (messageQueueManager.ts:400, planModeResume.isHumanLikeOrigin), so
 *     the official object shape is kept via a documented cast.
 *   - Telemetry: `usage_fix` (3 hits in the v305 strings dump, 0 in v304).
 *     OCC's LogEventMetadata is number/boolean-only, so the event carries
 *     counts instead of the official key list.
 */
import { logEvent } from '../../services/analytics/index.js'
import type { MessageOrigin } from '../../types/message.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import {
  applyUsageFix,
  type UsageFix,
} from './usageRecommendations.js'

/** Official `iso` bound to OCC's queue + the `usage_fix` telemetry event. */
export function enqueueUsageFix(fix: UsageFix): void {
  applyUsageFix(fix, (message) => {
    enqueue({
      value: message.value,
      mode: message.mode,
      priority: message.priority,
      origin: message.origin as unknown as MessageOrigin,
      ...(message.skipSlashCommands !== undefined
        ? { skipSlashCommands: message.skipSlashCommands }
        : {}),
    })
  })
  logEvent('usage_fix', {
    message_count: fix.messages.length,
    key_count: fix.keys.length,
  })
}
