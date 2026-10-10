/**
 * SessionStart additionalContext resume dedupe (OCC-side fix).
 *
 * Problem: on every resume (/resume, /branch, --resume), SessionStart hooks
 * re-run with source 'resume' and their `hook_additional_context` payloads
 * are appended to the restored transcript again — so a hook that injects the
 * same static context grows the conversation by one duplicate attachment per
 * resume cycle.
 *
 * The official 2.1.295 dedupe mechanism is NOT extractable from the binary
 * strings dump (no identifiable fingerprint/dedupe surface around the
 * SessionStart resume path), so per the task rule this is an OCC-side
 * implementation of the observable contract:
 *   - identical additionalContext (same content + same hook identity) that is
 *     already present in the restored transcript is NOT re-injected;
 *   - changed/new context IS still injected.
 *
 * Mechanism: sha256 fingerprint over `hookName + "\n" + content` for every
 * `hook_additional_context` attachment with hookEvent 'SessionStart' found in
 * the restored messages; freshly produced hook messages are filtered against
 * that set (per content entry — an attachment whose contexts are ALL already
 * present is dropped entirely). Immutable: inputs are never mutated.
 *
 * Identity note: processSessionStartHooks aggregates the additionalContexts
 * of ALL SessionStart hooks into a single attachment whose hookName is
 * 'SessionStart', so per-hook identity beyond the attachment hookName is not
 * recoverable from the persisted transcript; the fingerprint uses the
 * attachment hookName as the identity component.
 */

import { createHash } from 'node:crypto'
import type { HookResultMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'

/** Loose view of a persisted attachment message (restored-log data). */
type AttachmentLike = {
  type?: string
  hookEvent?: string
  hookName?: string
  content?: unknown
}

type MessageLike = {
  type?: string
  attachment?: AttachmentLike
}

function isSessionStartContextAttachment(
  attachment: AttachmentLike | undefined,
): attachment is AttachmentLike & { content: string[]; hookName: string } {
  return (
    attachment?.type === 'hook_additional_context' &&
    attachment.hookEvent === 'SessionStart' &&
    typeof attachment.hookName === 'string' &&
    Array.isArray(attachment.content) &&
    attachment.content.every(entry => typeof entry === 'string')
  )
}

/**
 * sha256 fingerprint of one additionalContext entry + its hook identity.
 */
export function fingerprintSessionStartContext(
  hookName: string,
  context: string,
): string {
  return createHash('sha256')
    .update(`${hookName}\n${context}`)
    .digest('hex')
}

/**
 * Collect the fingerprints of all SessionStart additionalContext entries
 * already present in a (restored) transcript.
 */
export function collectSessionStartContextFingerprints(
  messages: readonly Message[],
): ReadonlySet<string> {
  const fingerprints = new Set<string>()
  for (const message of messages) {
    const candidate = message as MessageLike
    if (candidate.type !== 'attachment') {
      continue
    }
    const attachment = candidate.attachment
    if (!isSessionStartContextAttachment(attachment)) {
      continue
    }
    for (const entry of attachment.content) {
      fingerprints.add(
        fingerprintSessionStartContext(attachment.hookName, entry),
      )
    }
  }
  return fingerprints
}

/**
 * Filter freshly produced SessionStart hook messages against the contexts
 * already present in the restored transcript. Resume-only call sites.
 *
 * - Non hook_additional_context messages (hook output, system messages) pass
 *   through unchanged — only the re-injected context is deduped.
 * - A context attachment keeps only the entries whose fingerprint is not yet
 *   present; when every entry is a duplicate the whole message is dropped.
 * - Returns a NEW array; inputs are never mutated.
 */
export function dedupeSessionStartHookMessages(
  hookMessages: readonly HookResultMessage[],
  existingMessages: readonly Message[],
): HookResultMessage[] {
  const existing = collectSessionStartContextFingerprints(existingMessages)
  if (existing.size === 0) {
    return [...hookMessages]
  }
  const deduped: HookResultMessage[] = []
  for (const message of hookMessages) {
    const candidate = message as MessageLike
    if (
      candidate.type !== 'attachment' ||
      !isSessionStartContextAttachment(candidate.attachment)
    ) {
      deduped.push(message)
      continue
    }
    const attachment = candidate.attachment
    const freshEntries = attachment.content.filter(
      entry =>
        !existing.has(
          fingerprintSessionStartContext(attachment.hookName, entry),
        ),
    )
    if (freshEntries.length === attachment.content.length) {
      deduped.push(message)
      continue
    }
    if (freshEntries.length === 0) {
      logForDebugging(
        `Hooks: SessionStart additionalContext unchanged since the restored transcript — skipping re-injection (${attachment.content.length} entr${attachment.content.length === 1 ? 'y' : 'ies'})`,
      )
      continue
    }
    logForDebugging(
      `Hooks: SessionStart additionalContext partially unchanged — injecting ${freshEntries.length} of ${attachment.content.length} entries`,
    )
    deduped.push({
      ...message,
      attachment: { ...attachment, content: freshEntries },
    } as HookResultMessage)
  }
  return deduped
}
