/**
 * CC 2.1.275 (ITEM O follow-up): awaiting-model context + hook.
 *
 * Mirrors the official v2.1.276 mechanism (offsets into
 * /tmp/cc-diff-276/v276/package/claude):
 *   - `var qet=Xt(null)` context, default null   @215281980
 *   - `Pb` hook                                  @215281997:
 *       function Pb(l){
 *         let m=De(qet),
 *             f=HU({uuid:l}),
 *             h=Me(m==="every"?null:m,(R)=>f!==void 0&&
 *                 R.promptsAwaitingModel.size>0&&
 *                 R.promptsAwaitingModel.has(f));
 *         return m==="every"||h===!0
 *       }
 *   - providers @216027683-216028109: placeholder echo wrapped in
 *     `value:"every"` (always gray), main transcript area wrapped in the
 *     stream store itself (`r(qet.Provider,{value:dit` @216028109).
 *
 * The `"every"` literal forces the dimmed state regardless of the store —
 * official uses it for the userInputOnProcessing placeholder echo, which has
 * no real message uuid yet.
 */

import * as React from 'react'
import { useSyncExternalStore } from 'react'
import {
  messageAwaitingKey,
  selectIsAwaitingModel,
  type PromptsAwaitingModelSnapshot,
} from '../state/promptsAwaitingModel.js'

/** Store shape the context accepts — subscribe/getSnapshot pair (official stream store). */
export interface AwaitingModelStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PromptsAwaitingModelSnapshot
}

/** Context value: a store, the literal "every" (always gray), or null (never gray). */
export type AwaitingModelContextValue = AwaitingModelStore | 'every' | null

/** qet @215281980: `Xt(null)` — default null means nothing dims. */
export const AwaitingModelContext =
  React.createContext<AwaitingModelContextValue>(null)

/** No-op subscribe for the null-store branch of the official `m==="every"?null:m` trick. */
function noopSubscribe(): () => void {
  return () => {}
}

/**
 * Pb @215281997: true when the context says "every", or when this message's
 * awaiting key is present in the store snapshot. The selector body is the
 * pure selectIsAwaitingModel (state/promptsAwaitingModel.ts), kept outside
 * the hook so it is unit-testable without React.
 */
export function useAwaitingModel(messageId: string | undefined): boolean {
  const contextValue = React.useContext(AwaitingModelContext)
  const key = messageAwaitingKey({ uuid: messageId })
  // Official `m==="every"?null:m` — "every" short-circuits the subscription.
  const store = contextValue === 'every' ? null : contextValue
  const snapshotValue = useSyncExternalStore<
    PromptsAwaitingModelSnapshot | null
  >(
    store === null ? noopSubscribe : store.subscribe,
    store === null ? () => null : store.getSnapshot,
  )
  const isAwaiting = selectIsAwaitingModel(snapshotValue, key)
  // Official `return m==="every"||h===!0`.
  return contextValue === 'every' || isAwaiting === true
}
