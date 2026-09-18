/**
 * CC 2.1.275 (ITEM O follow-up): prompts awaiting model — external store.
 *
 * Tracks which user messages have been sent (appended to the transcript) but
 * not yet received by the model, so the UI can render them dimmed/gray until
 * the first assistant stream event arrives.
 *
 * Byte-faithful port of the official v2.1.276 binary logic (all offsets into
 * /tmp/cc-diff-276/v276/package/claude):
 *   - dx=24 prefix length        @200654898
 *   - CD uuid validation         @215279627
 *   - HU key extraction          @215279748
 *   - awaitModelFor              @217174519
 *   - markModelReceived          @217174696  (official is an arrow class
 *                                property; semantics identical)
 *   - $Qo awaiting filter        @217178523  (I3 user check @192437952)
 *   - RWt shared empty set       @217171099  (initial snapshot value)
 *
 * Module-level store following the OCC streamingTextStore.ts convention:
 * immutable state, published as whole new snapshots, so React can consume it
 * via useSyncExternalStore without tearing.
 */

import type { Message } from '../types/message.js'

/** dx @200654898: uuids are keyed by their first 24 characters. */
export const AWAITING_KEY_PREFIX_LENGTH = 24

/** RWt @217171099: shared immutable empty set (official module-level `new Set`). */
export const EMPTY_AWAITING_SET: ReadonlySet<string> = new Set<string>()

/** Snapshot shape mirrors official `_snapshot.promptsAwaitingModel`. */
export interface PromptsAwaitingModelSnapshot {
  readonly promptsAwaitingModel: ReadonlySet<string>
}

type Listener = () => void

let snapshot: PromptsAwaitingModelSnapshot = {
  promptsAwaitingModel: EMPTY_AWAITING_SET,
}

const listeners = new Set<Listener>()

function publish(next: PromptsAwaitingModelSnapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

/**
 * CD @215279627: `if(typeof l!=="object"||l===null||!("uuid"in l))return!1;`
 * then require a non-empty string uuid.
 */
export function hasUsableUuid(value: unknown): value is { uuid: string } {
  if (typeof value !== 'object' || value === null || !('uuid' in value)) {
    return false
  }
  const { uuid } = value as { uuid?: unknown }
  return typeof uuid === 'string' && uuid !== ''
}

/** HU @215279748: `CD(l)?l.uuid.slice(0,dx):void 0`. */
export function messageAwaitingKey(message: unknown): string | undefined {
  return hasUsableUuid(message)
    ? message.uuid.slice(0, AWAITING_KEY_PREFIX_LENGTH)
    : undefined
}

/**
 * I3 @192437952: `e.type==="user"&&!e.isMeta&&e.toolUseResult===void 0`.
 * Combined into $Qo below; kept separate to mirror official naming.
 */
export function isAwaitingUserMessage(message: Message): boolean {
  return (
    message.type === 'user' && !message.isMeta && message.toolUseResult === undefined
  )
}

/**
 * $Qo @217178523: user messages OR queued_command attachment events both go
 * gray while awaiting the model.
 */
export function isAwaitingEligibleMessage(message: Message): boolean {
  return (
    isAwaitingUserMessage(message) ||
    (message.type === 'attachment' && message.attachment?.type === 'queued_command')
  )
}

/**
 * awaitModelFor @217174519: extract keys from eligible messages; no-op when
 * nothing is extractable; otherwise publish the union with the current set
 * (new Set — never mutate the published snapshot).
 */
export function awaitModelForMessages(messages: readonly Message[]): void {
  const keys = messages
    .filter(isAwaitingEligibleMessage)
    .flatMap(message => {
      const key = messageAwaitingKey(message)
      return key !== undefined ? [key] : []
    })
  if (keys.length === 0) {
    return
  }
  publish({
    promptsAwaitingModel: new Set([
      ...snapshot.promptsAwaitingModel,
      ...keys,
    ]),
  })
}

/**
 * markModelReceived @217174696: no-op when already empty; otherwise publish
 * the shared empty set. Clears the dim for every awaiting prompt at once —
 * official behavior (single global clear, not per-message).
 */
export function markModelReceived(): void {
  if (snapshot.promptsAwaitingModel.size === 0) {
    return
  }
  publish({ promptsAwaitingModel: EMPTY_AWAITING_SET })
}

/** useSyncExternalStore subscribe — official stream store shape (Pb @215281997). */
export function subscribeToPromptsAwaitingModel(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** useSyncExternalStore getSnapshot. */
export function getPromptsAwaitingModelSnapshot(): PromptsAwaitingModelSnapshot {
  return snapshot
}

/**
 * Stable store object handed to <AwaitingModelContext.Provider value={...}> —
 * the official provider passes the stream store itself (`dit=Q_?.stream??null`
 * @216028200) because it exposes subscribe/getSnapshot with the snapshot field
 * `promptsAwaitingModel`.
 */
export const promptsAwaitingModelStore = {
  subscribe: subscribeToPromptsAwaitingModel,
  getSnapshot: getPromptsAwaitingModelSnapshot,
} as const

/**
 * Pure selector backing the official Pb membership test
 * (@215281997): `f!==void 0 && R.promptsAwaitingModel.size>0 &&
 * R.promptsAwaitingModel.has(f)`.
 */
export function selectIsAwaitingModel(
  snapshotValue: PromptsAwaitingModelSnapshot | null,
  key: string | undefined,
): boolean {
  if (snapshotValue === null || key === undefined) {
    return false
  }
  return (
    snapshotValue.promptsAwaitingModel.size > 0 &&
    snapshotValue.promptsAwaitingModel.has(key)
  )
}

/** Test-only: restore the module to its initial snapshot without notifying. */
export function _resetPromptsAwaitingModelForTesting(): void {
  snapshot = { promptsAwaitingModel: EMPTY_AWAITING_SET }
  listeners.clear()
}
