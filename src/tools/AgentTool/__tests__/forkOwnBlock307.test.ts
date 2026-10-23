/**
 * CC 2.1.307 (B13): when the parent launches several fork subagents in one
 * assistant turn, each child must be told WHICH tool_use launch is its own.
 *
 * Official v307 (byte-verified @3476793 in /tmp/cc-diff-308/new307.txt):
 *   var Far="Fork started — that fork is you.",
 *       $ar="This call started a fork, and that fork is you. The call's other work and its result belong to the parent.",
 *       Bar="This is the parent's call, not yours. It may not have run yet, and its result goes to the parent.";
 *   function Kbo(e,n,r){...
 *     let y=h.length===1?h[0]?.id:r,
 *         S=h.map((H)=>({type:"tool_result",tool_use_id:H.id,
 *           content:[{type:"text",
 *             text:H.id!==y?Bar:H.name===ht||H.name===wf?Far:$ar}]})),...}
 *
 * with ht="Agent" (@28367079 `var ht="Agent"`) and wf="Task" — OCC
 * analogues AGENT_TOOL_NAME / LEGACY_AGENT_TOOL_NAME. The uniform v302
 * placeholder ("Fork started — processing in background") is GONE upstream;
 * official keeps no uniform placeholder.
 *
 * Per-block selection:
 *   - block is NOT this child's own launch            → Bar (parent's call)
 *   - own launch AND the tool is a fork launcher
 *     (Agent/Task)                                    → Far (that fork is you)
 *   - own launch but some other tool (sub-agent call
 *     inside a forked-skill body, etc.)               → $ar (call's other work
 *                                                       belongs to the parent)
 *   - own id = blocks.length===1 ? blocks[0].id : ownToolUseId (caller passes
 *     the spawning tool_use id; official call site `Kbo(G,h,z??e.toolUseId)`).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const {
  buildForkedMessages,
  FORK_RESULT_OWN_LAUNCH,
  FORK_RESULT_OWN_OTHER_WORK,
  FORK_RESULT_PARENT_CALL,
} = await import('../forkSubagent.js')
const { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } = await import(
  '../constants.js'
)

type AnyBlock = { type: string; [key: string]: unknown }

function makeAssistantMessage(
  blocks: Array<{ id: string; name: string }>,
): never {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: blocks.map(b => ({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: {},
      })),
    },
  } as never
}

function toolResultsOf(resultMessage: { message?: { content?: unknown } }): Array<{
  tool_use_id: string
  text: string
}> {
  const content = (resultMessage.message?.content ?? []) as AnyBlock[]
  return content
    .filter(b => b.type === 'tool_result')
    .map(b => ({
      tool_use_id: b.tool_use_id as string,
      text: ((b.content as AnyBlock[])[0]!.text as string) ?? '',
    }))
}

// ---------------------------------------------------------------------------
// Verbatim official strings (em-dash U+2014 included)
// ---------------------------------------------------------------------------

describe('fork tool_result strings (CC 2.1.307 B13 — official Far/$ar/Bar)', () => {
  test('FORK_RESULT_OWN_LAUNCH is byte-exact (em-dash U+2014)', () => {
    expect(FORK_RESULT_OWN_LAUNCH).toBe('Fork started — that fork is you.')
    expect(FORK_RESULT_OWN_LAUNCH).toContain('—')
  })

  test('FORK_RESULT_OWN_OTHER_WORK is byte-exact', () => {
    expect(FORK_RESULT_OWN_OTHER_WORK).toBe(
      "This call started a fork, and that fork is you. The call's other work and its result belong to the parent.",
    )
  })

  test('FORK_RESULT_PARENT_CALL is byte-exact', () => {
    expect(FORK_RESULT_PARENT_CALL).toBe(
      "This is the parent's call, not yours. It may not have run yet, and its result goes to the parent.",
    )
  })

  test('the uniform v302 placeholder is gone (official keeps no uniform placeholder)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'forkSubagent.ts'), 'utf8')
    expect(src).not.toContain('Fork started — processing in background')
    expect(src).not.toContain('FORK_PLACEHOLDER_RESULT')
  })
})

// ---------------------------------------------------------------------------
// Per-block selection (official Kbo body)
// ---------------------------------------------------------------------------

describe('buildForkedMessages own-launch selection (CC 2.1.307 B13 — official Kbo port)', () => {
  test('single Agent block without ownToolUseId → own launch (Far)', () => {
    // Arrange — official: y = h.length===1 ? h[0].id : r
    const assistant = makeAssistantMessage([
      { id: 'tu_only', name: AGENT_TOOL_NAME },
    ])

    // Act
    const [assistantOut, resultMsg] = buildForkedMessages('do the work', assistant)

    // Assert
    const results = toolResultsOf(resultMsg)
    expect(results).toEqual([
      { tool_use_id: 'tu_only', text: FORK_RESULT_OWN_LAUNCH },
    ])
    // assistant clone preserved with a fresh uuid
    expect(assistantOut.uuid).not.toBe((assistant as { uuid: string }).uuid)
  })

  test('single Task (legacy launcher) block → own launch (Far)', () => {
    // Arrange
    const assistant = makeAssistantMessage([
      { id: 'tu_legacy', name: LEGACY_AGENT_TOOL_NAME },
    ])

    // Act
    const [, resultMsg] = buildForkedMessages('legacy fork', assistant)

    // Assert
    expect(toolResultsOf(resultMsg)).toEqual([
      { tool_use_id: 'tu_legacy', text: FORK_RESULT_OWN_LAUNCH },
    ])
  })

  test('single non-launcher block is still "own" → other-work string ($ar)', () => {
    // Arrange — own id resolves to the only block, but its name is not a
    // fork launcher: official H.name===ht||H.name===wf?Far:$ar
    const assistant = makeAssistantMessage([{ id: 'tu_bash', name: 'Bash' }])

    // Act
    const [, resultMsg] = buildForkedMessages('bash fork', assistant)

    // Assert
    expect(toolResultsOf(resultMsg)).toEqual([
      { tool_use_id: 'tu_bash', text: FORK_RESULT_OWN_OTHER_WORK },
    ])
  })

  test('multi-block with ownToolUseId → own launcher gets Far, siblings get Bar', () => {
    // Arrange
    const assistant = makeAssistantMessage([
      { id: 'tu_a', name: AGENT_TOOL_NAME },
      { id: 'tu_b', name: AGENT_TOOL_NAME },
      { id: 'tu_c', name: 'Bash' },
    ])

    // Act — this child was spawned by tu_b
    const [, resultMsg] = buildForkedMessages('child b', assistant, 'tu_b')

    // Assert
    expect(toolResultsOf(resultMsg)).toEqual([
      { tool_use_id: 'tu_a', text: FORK_RESULT_PARENT_CALL },
      { tool_use_id: 'tu_b', text: FORK_RESULT_OWN_LAUNCH },
      { tool_use_id: 'tu_c', text: FORK_RESULT_PARENT_CALL },
    ])
  })

  test('multi-block, own launch is a non-launcher tool → $ar for own, Bar for siblings', () => {
    // Arrange
    const assistant = makeAssistantMessage([
      { id: 'tu_agent', name: AGENT_TOOL_NAME },
      { id: 'tu_read', name: 'Read' },
    ])

    // Act — own launch is the Read call (e.g. forked-skill body)
    const [, resultMsg] = buildForkedMessages('child read', assistant, 'tu_read')

    // Assert
    expect(toolResultsOf(resultMsg)).toEqual([
      { tool_use_id: 'tu_agent', text: FORK_RESULT_PARENT_CALL },
      { tool_use_id: 'tu_read', text: FORK_RESULT_OWN_OTHER_WORK },
    ])
  })

  test('multi-block without ownToolUseId → every block gets Bar (no own id resolvable)', () => {
    // Arrange
    const assistant = makeAssistantMessage([
      { id: 'tu_x', name: AGENT_TOOL_NAME },
      { id: 'tu_y', name: AGENT_TOOL_NAME },
    ])

    // Act
    const [, resultMsg] = buildForkedMessages('ambiguous', assistant)

    // Assert
    expect(toolResultsOf(resultMsg)).toEqual([
      { tool_use_id: 'tu_x', text: FORK_RESULT_PARENT_CALL },
      { tool_use_id: 'tu_y', text: FORK_RESULT_PARENT_CALL },
    ])
  })

  test('directive text block is appended after the tool_results', () => {
    // Arrange
    const assistant = makeAssistantMessage([
      { id: 'tu_1', name: AGENT_TOOL_NAME },
    ])

    // Act
    const [, resultMsg] = buildForkedMessages('the directive', assistant)

    // Assert
    const content = (resultMsg.message?.content ?? []) as AnyBlock[]
    const textBlocks = content.filter(b => b.type === 'text')
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]!.text as string).toContain('the directive')
    expect(content[content.length - 1]!.type).toBe('text')
  })

  test('zero tool_use blocks → single user message fallback (unchanged official error path)', () => {
    // Arrange
    const assistant = {
      type: 'assistant',
      uuid: randomUUID(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    } as never

    // Act
    const out = buildForkedMessages('no tools here', assistant)

    // Assert
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Caller wiring — the spawning tool_use id is threaded through.
// ---------------------------------------------------------------------------

describe('AgentTool fork caller passes the spawning tool_use id (CC 2.1.307 B13)', () => {
  test('buildForkedMessages call site threads toolUseContext.toolUseId', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'AgentTool.tsx'), 'utf8')
    expect(src).toContain(
      'buildForkedMessages(prompt, assistantMessage, toolUseContext.toolUseId)',
    )
  })
})
