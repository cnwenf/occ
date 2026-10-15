import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { AgentId } from 'src/types/ids.js'
import { asAgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { rebuildAgentNameRegistryFromTranscript } from '../agentNameRehydration.js'

// Official Claude Code 2.1.299 (#124) — changelog: "Fixed `SendMessage` not
// finding a subagent by name after the CLI restarted and resumed the session
// (names given before the last compaction still need the agent ID)."
// Port of the official binary `t_n` transcript reconstruction.

const AGENT_ID_1 = 'a0123456789abcdef'
const AGENT_ID_2 = 'alabel-fedcba9876543210'

let uuidCounter = 0
function nextUuid(): UUID {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}` as UUID
}

function assistantAgentSpawn(
  toolUseId: string,
  name: string,
  toolName: 'Agent' | 'Task' = 'Agent',
): Message {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: { name, prompt: 'do the work', subagent_type: 'general-purpose' },
        },
      ],
    },
  } as Message
}

function toolResultUserMessage(
  toolUseId: string,
  toolUseResult: unknown,
  opts: { isError?: boolean; extraResults?: number } = {},
): Message {
  const results = [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: 'launched' }],
      ...(opts.isError && { is_error: true }),
    },
    ...Array.from({ length: opts.extraResults ?? 0 }, (_, i) => ({
      type: 'tool_result',
      tool_use_id: `${toolUseId}-extra-${i}`,
      content: [{ type: 'text', text: 'other' }],
    })),
  ]
  return {
    type: 'user',
    uuid: nextUuid(),
    toolUseResult,
    message: { role: 'user', content: results },
  } as Message
}

describe('rebuildAgentNameRegistryFromTranscript (2.1.299 #124)', () => {
  test('rebuilds name → agent-ID mapping from an async_launched spawn', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    const rebuilt = rebuildAgentNameRegistryFromTranscript(
      transcript,
      new Map(),
    )
    expect(rebuilt).not.toBeNull()
    expect(rebuilt!.get('researcher')).toBe(AGENT_ID_1)
  })

  test('registry survives serialize → deserialize (simulated CLI restart + resume)', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
      assistantAgentSpawn('toolu_2', 'writer'),
      toolResultUserMessage('toolu_2', {
        status: 'completed',
        agentId: AGENT_ID_2,
      }),
    ]
    // Round-trip through JSON like the on-disk transcript JSONL.
    const revived = JSON.parse(JSON.stringify(transcript)) as Message[]
    // "Restart": registry starts empty; rebuild from the revived transcript.
    const rebuilt = rebuildAgentNameRegistryFromTranscript(revived, new Map())
    expect(rebuilt).not.toBeNull()
    // SendMessage lookup by name resolves to the right agent IDs.
    expect(rebuilt!.get('researcher')).toBe(AGENT_ID_1)
    expect(rebuilt!.get('writer')).toBe(asAgentId(AGENT_ID_2))
    expect(rebuilt!.size).toBe(2)
  })

  test('legacy Task tool name is also reconstructed', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', 'legacy-worker', 'Task'),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    const rebuilt = rebuildAgentNameRegistryFromTranscript(transcript, new Map())
    expect(rebuilt!.get('legacy-worker')).toBe(AGENT_ID_1)
  })

  test('merges over the current registry without dropping live entries', () => {
    const current = new Map<string, AgentId>([
      ['in-memory', asAgentId(AGENT_ID_2)],
    ])
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    const rebuilt = rebuildAgentNameRegistryFromTranscript(transcript, current)
    expect(rebuilt!.get('in-memory')).toBe(AGENT_ID_2)
    expect(rebuilt!.get('researcher')).toBe(AGENT_ID_1)
    // Input registry is not mutated (immutable merge)
    expect(current.has('researcher')).toBe(false)
  })

  test('names already in the current registry keep the in-memory mapping', () => {
    const current = new Map<string, AgentId>([
      ['researcher', asAgentId(AGENT_ID_2)],
    ])
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    // Official `!t.has(name)` guard: the transcript entry is skipped; nothing
    // new reconstructs → null (caller keeps state unchanged).
    expect(rebuildAgentNameRegistryFromTranscript(transcript, current)).toBeNull()
  })

  test('error tool_result does not register the name', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage(
        'toolu_1',
        { status: 'async_launched', agentId: AGENT_ID_1 },
        { isError: true },
      ),
    ]
    expect(rebuildAgentNameRegistryFromTranscript(transcript, new Map())).toBeNull()
  })

  test('message with multiple tool_results does not register (ambiguous pairing)', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', 'researcher'),
      toolResultUserMessage(
        'toolu_1',
        { status: 'async_launched', agentId: AGENT_ID_1 },
        { extraResults: 1 },
      ),
    ]
    expect(rebuildAgentNameRegistryFromTranscript(transcript, new Map())).toBeNull()
  })

  test('invalid toolUseResult payloads are rejected', () => {
    const badPayloads: unknown[] = [
      undefined,
      null,
      { status: 'async_launched' }, // missing agentId
      { agentId: AGENT_ID_1 }, // missing status
      { status: 'failed', agentId: AGENT_ID_1 }, // wrong status
      { status: 'async_launched', agentId: 'not-an-agent-id' }, // bad id format
    ]
    for (const payload of badPayloads) {
      const transcript = [
        assistantAgentSpawn('toolu_1', 'researcher'),
        toolResultUserMessage('toolu_1', payload),
      ]
      expect(
        rebuildAgentNameRegistryFromTranscript(transcript, new Map()),
      ).toBeNull()
    }
  })

  test('a raw agent ID passed as the name is not registered as a name', () => {
    const transcript = [
      assistantAgentSpawn('toolu_1', AGENT_ID_1),
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_2,
      }),
    ]
    expect(rebuildAgentNameRegistryFromTranscript(transcript, new Map())).toBeNull()
  })

  test('spawn without a name is skipped', () => {
    const transcript = [
      {
        type: 'assistant',
        uuid: nextUuid(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Agent',
              input: { prompt: 'x', subagent_type: 'general-purpose' },
            },
          ],
        },
      } as Message,
      toolResultUserMessage('toolu_1', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    expect(rebuildAgentNameRegistryFromTranscript(transcript, new Map())).toBeNull()
  })

  test('empty transcript → null (nothing to restore)', () => {
    expect(rebuildAgentNameRegistryFromTranscript([], new Map())).toBeNull()
  })

  test('documented compaction limit: names only in the compacted-away segment are NOT restored', () => {
    // The transcript after compaction no longer carries the original spawn —
    // the official fix documents that those names still need the agent ID.
    const compactedTranscript = [
      {
        type: 'system',
        uuid: nextUuid(),
        compactMetadata: {},
      } as Message,
      assistantAgentSpawn('toolu_9', 'post-compaction-agent'),
      toolResultUserMessage('toolu_9', {
        status: 'async_launched',
        agentId: AGENT_ID_1,
      }),
    ]
    const rebuilt = rebuildAgentNameRegistryFromTranscript(
      compactedTranscript,
      new Map(),
    )
    expect(rebuilt!.has('pre-compaction-agent')).toBe(false)
    expect(rebuilt!.get('post-compaction-agent')).toBe(AGENT_ID_1)
  })
})
