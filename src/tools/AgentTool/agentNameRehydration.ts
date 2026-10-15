import { z } from 'zod'
import type { AgentId } from '../../types/ids.js'
import { toAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'

/**
 * CC 2.1.299 (#124) — SendMessage name-registry rehydration from the
 * resumed transcript. Official changelog: "Fixed `SendMessage` not finding
 * a subagent by name after the CLI restarted and resumed the session (names
 * given before the last compaction still need the agent ID)."
 *
 * Verbatim port of the official 2.1.299 binary function `t_n` (recovered at
 * ELF offset 244543193):
 *
 *   function t_n(e, t) {                       // e = transcript, t = current registry
 *     let r = new Map, d = new Map
 *     for (let n of e)
 *       if (n.type === "assistant" && Array.isArray(n.message.content)) {
 *         for (let s of n.message.content)
 *           if (s.type === "tool_use" && (s.name === Agent || s.name === Task)) {
 *             let i = L().safeParse(s.input)   // agent-tool input schema
 *             if (i.success && !t.has(i.data.name)) r.set(s.id, i.data.name)
 *           }
 *       } else if (n.type === "user" && Array.isArray(n.message.content)) {
 *         let [s, ...i] = n.message.content.filter(f => f.type === "tool_result")
 *         let m = s !== undefined && i.length === 0 && !s.is_error
 *           ? r.get(s.tool_use_id) : undefined  // exactly one non-error result
 *         if (m === undefined) continue
 *         let a = D().safeParse(n.toolUseResult)
 *         let l = a.success ? Dv(a.data.agentId) : null
 *         if (l !== null) d.set(m, l)
 *       }
 *     return d.size > 0 ? new Map([...t, ...d]) : null
 *   }
 *
 * Documented limit (official): names given before the last compaction are no
 * longer in the transcript, so those still need the agent ID.
 */

/** Official `D()` — the toolUseResult schema the agentId is read from. */
const AgentToolUseResultSchema = z.object({
  status: z.union([z.literal('async_launched'), z.literal('completed')]),
  agentId: z.string(),
})

type ContentBlock = {
  type?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
}

/**
 * OCC stand-in for the official `L()` input-schema name validation: a name
 * must be a non-empty string that is not itself a raw agent ID (resumes by
 * ID pass the ID through `name`-shaped inputs; registering those would
 * shadow the ID lookup semantics).
 */
function validAgentName(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const name = (input as { name?: unknown }).name
  if (typeof name !== 'string' || name.length === 0) return null
  if (toAgentId(name) !== null) return null
  return name
}

/**
 * Rebuild the name → agent-ID registry from a resumed transcript, merged
 * over the current registry. Returns null when nothing could be
 * reconstructed (official: caller keeps state unchanged on null).
 */
export function rebuildAgentNameRegistryFromTranscript(
  messages: Message[],
  currentRegistry: Map<string, AgentId>,
): Map<string, AgentId> | null {
  const pendingNameByToolUseId = new Map<string, string>()
  const reconstructed = new Map<string, AgentId>()

  for (const msg of messages) {
    const content = msg.message?.content
    if (msg.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (
          block.type === 'tool_use' &&
          (block.name === AGENT_TOOL_NAME ||
            block.name === LEGACY_AGENT_TOOL_NAME) &&
          typeof block.id === 'string'
        ) {
          const name = validAgentName(block.input)
          if (name !== null && !currentRegistry.has(name)) {
            pendingNameByToolUseId.set(block.id, name)
          }
        }
      }
    } else if (msg.type === 'user' && Array.isArray(content)) {
      const [first, ...rest] = (content as ContentBlock[]).filter(
        b => b.type === 'tool_result',
      )
      // Official pairing rule: exactly ONE tool_result in the message and it
      // is not an error — anything else leaves the spawn unconfirmed.
      const name =
        first !== undefined && rest.length === 0 && !first.is_error
          ? pendingNameByToolUseId.get(first.tool_use_id ?? '')
          : undefined
      if (name === undefined) continue
      const parsed = AgentToolUseResultSchema.safeParse(msg.toolUseResult)
      const agentId = parsed.success ? toAgentId(parsed.data.agentId) : null
      if (agentId !== null) {
        reconstructed.set(name, agentId)
      }
    }
  }

  return reconstructed.size > 0
    ? new Map([...currentRegistry, ...reconstructed])
    : null
}
