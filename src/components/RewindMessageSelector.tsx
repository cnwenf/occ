import * as React from 'react'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { UserMessage } from '../types/message.js'
import {
  getCommandQueueSnapshot,
  remove,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import {
  findQueuedCommandForMessage,
  withQueuedPromptMessages,
} from '../utils/queuedRewindMessages.js'
import { MessageSelector } from './MessageSelector.js'

type MessageSelectorProps = React.ComponentProps<typeof MessageSelector>

/**
 * CC 2.1.290 — rewind screen wrapper (official `nSt` analogue).
 *
 * Official nSt (NEW shape in 290; cc289 `vht` @228917878 passed `messages:Pe`
 * straight through):
 *   {messages:Pe}=fp(Ge()), Me=X(()=>LMe(Pe),[Pe]);
 *   return e(DMe,{messages:Me, onPreRestore:h.cancel, ...,
 *                 onRestoreMessage:(Oe)=>k.handleRestoreMessage(Oe,"message_selector")})
 * — memoizes the LMe queued-prompt transform over the store messages before
 * handing them to the (unchanged) selector component DMe.
 *
 * OCC adaptation: queued prompts live in the module-level commandQueue rather
 * than transcript attachment rows, so this leaf component subscribes to the
 * queue itself (useSyncExternalStore — same leaf-subscription pattern the
 * REPL uses for PromptInputQueuedCommands, keeping whole-screen re-renders
 * off the queue path) and appends synthesized rows via
 * withQueuedPromptMessages. On restore of a synthesized row it removes the
 * queue entry first — the OCC equivalent of the official truncation
 * consuming the queued_command attachment row (xMe/i2r source_uuid
 * resolution @232103682/@210039574) — then delegates to the standard
 * onRestoreMessage path, which prefills the draft with the prompt text.
 */
export function RewindMessageSelector(
  props: MessageSelectorProps,
): React.ReactNode {
  const queue = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )
  // Official: Me=X(()=>LMe(Pe),[Pe])
  const messages = useMemo(
    () => withQueuedPromptMessages(props.messages, queue),
    [props.messages, queue],
  )
  const onRestoreMessage = props.onRestoreMessage
  const handleRestoreMessage = useCallback(
    async (message: UserMessage) => {
      const queued = findQueuedCommandForMessage(message)
      if (queued) remove([queued])
      await onRestoreMessage(message)
    },
    [onRestoreMessage],
  )
  return (
    <MessageSelector
      {...props}
      messages={messages}
      onRestoreMessage={handleRestoreMessage}
    />
  )
}
