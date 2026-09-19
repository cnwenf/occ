import { afterAll, describe, expect, mock, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { Command } from '../../../types/command.js'
import type { Message } from '../../../types/message.js'

/**
 * CC 2.1.276 (ITEM R): "--forward-subagent-text" dropped the messages of
 * subagents spawned by `context: fork` skills (including nested forks).
 *
 * Official v274 fork loop (byte-extracted @202941888):
 *   `if(K.push(L),L.type!=="assistant"&&L.type!=="user")continue;`
 * — nested progress messages entered the result set but were NEVER forwarded
 * to the parent's onProgress. Official v276 (@204000779) inserts:
 *   `if(G.push(j),w7(j)){if(ae)f?.(hMt(j));continue}`
 * with the shared predicate `w7` (@203722538):
 *   `e.type==="progress"&&(e.data.type==="agent_progress"||e.data.type==="skill_progress")`
 * and the rewrap `hMt` (@203722646):
 *   `{type:"progress",toolUseID:e.toolUseID,parentToolUseID:e.parentToolUseID,data:e.data}`
 * `ae` = `options.forwardSubagentText`, `f` = the parent onProgress.
 *
 * OCC's onProgress takes the 2-field ToolProgress shape ({toolUseID, data});
 * src/services/tools/toolExecution.ts re-adds `type:'progress'` and
 * `parentToolUseID` (the skill's own tool_use id), so the nested toolUseID and
 * data are forwarded verbatim — same shape as the AgentTool bash_progress
 * forward (AgentTool.tsx).
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Snapshot the real exports into plain objects BEFORE mocking (the imported
// namespace re-resolves to the mock), spread them, override only what these
// tests drive, and restore in afterAll.
const actualCommands = { ...(await import('../../../commands.js')) }
const actualForkedAgent = { ...(await import('../../../utils/forkedAgent.js')) }
const actualRunAgent = { ...(await import('../../AgentTool/runAgent.js')) }
const actualSkillUsage = {
  ...(await import('../../../utils/suggestions/skillUsageTracking.js')),
}

const FORKED_SKILL_NAME = 'nested-fork-skill'
const SKILL_CONTENT = 'Do the nested thing.'
const NESTED_AGENT_ID = 'nested-agent-1'

/** Messages the mocked forked sub-agent yields, set per test. */
let mockedForkStream: Message[] = []

const forkedCommand = {
  type: 'prompt',
  name: FORKED_SKILL_NAME,
  description: 'a forked skill',
  context: 'fork',
} as unknown as Command

mock.module('../../../commands.js', () => ({
  ...actualCommands,
  getCommands: async () => [forkedCommand],
}))

mock.module('../../../utils/forkedAgent.js', () => ({
  ...actualForkedAgent,
  prepareForkedCommandContext: async (
    _command: unknown,
    _args: string,
    context: { getAppState: () => unknown },
  ) => ({
    modifiedGetAppState: context.getAppState,
    baseAgent: { agentType: FORKED_SKILL_NAME },
    promptMessages: [],
    skillContent: SKILL_CONTENT,
  }),
  shouldForkedSkillRunAsync: () => false,
  extractResultText: () => 'fork result',
}))

mock.module('../../AgentTool/runAgent.js', () => ({
  ...actualRunAgent,
  runAgent: async function* () {
    for (const message of mockedForkStream) {
      yield message
    }
  },
}))

mock.module('../../../utils/suggestions/skillUsageTracking.js', () => ({
  ...actualSkillUsage,
  recordSkillUsage: () => {},
}))

afterAll(() => {
  mock.module('../../../commands.js', () => ({ ...actualCommands }))
  mock.module('../../../utils/forkedAgent.js', () => ({ ...actualForkedAgent }))
  mock.module('../../AgentTool/runAgent.js', () => ({ ...actualRunAgent }))
  mock.module('../../../utils/suggestions/skillUsageTracking.js', () => ({
    ...actualSkillUsage,
  }))
})

const { SkillTool } = await import('../SkillTool.js')

function nestedProgress(
  progressType: 'agent_progress' | 'skill_progress' | 'bash_progress',
  toolUseID: string,
): Message {
  return {
    type: 'progress',
    uuid: `progress-${toolUseID}`,
    toolUseID,
    parentToolUseID: `parent-${toolUseID}`,
    data: {
      type: progressType,
      message: assistantMessage(`nested-${toolUseID}`, [
        { type: 'text', text: 'nested subagent text' },
      ]),
      prompt: '',
      agentId: NESTED_AGENT_ID,
    },
  } as unknown as Message
}

function assistantMessage(id: string, content: unknown[]): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: {},
    },
    parentToolUseID: null,
    isSidechain: false,
    costUSD: 0,
    durationMs: 0,
    timestamp: Date.now(),
  } as unknown as Message
}

function toolUseContext(forwardSubagentText: boolean): never {
  return {
    abortController: new AbortController(),
    readFileState: {},
    options: {
      tools: [],
      forwardSubagentText,
      mcpClients: [],
      isNonInteractiveSession: true,
    },
    getAppState: () => ({ mcp: { commands: [] } }),
    setAppState: () => {},
  } as never
}

/** The fork loop only ever runs through SkillTool.call's fork branch. */
async function runForkedSkill(
  forwardSubagentText: boolean,
  forkStream: Message[],
): Promise<Array<{ toolUseID: string; data: { type?: string } }>> {
  mockedForkStream = forkStream
  const forwarded: Array<{ toolUseID: string; data: { type?: string } }> = []
  const parentMessage = assistantMessage('skill-parent', [
    {
      type: 'tool_use',
      id: 'skill_tool_use',
      name: 'Skill',
      input: { skill: FORKED_SKILL_NAME },
    },
  ]) as never

  await SkillTool.call(
    { skill: FORKED_SKILL_NAME, args: '' },
    toolUseContext(forwardSubagentText),
    (async () => ({ behavior: 'allow' as const, updatedInput: {} })) as never,
    parentMessage,
    progress => {
      forwarded.push(progress as { toolUseID: string; data: { type?: string } })
    },
  )
  return forwarded
}

const NESTED_AGENT_PROGRESS_ID = 'nested-tool-use-agent'
const NESTED_SKILL_PROGRESS_ID = 'nested-tool-use-skill'
const NESTED_BASH_PROGRESS_ID = 'nested-tool-use-bash'

function forkStreamWithNestedProgress(): Message[] {
  return [
    nestedProgress('agent_progress', NESTED_AGENT_PROGRESS_ID),
    nestedProgress('skill_progress', NESTED_SKILL_PROGRESS_ID),
    nestedProgress('bash_progress', NESTED_BASH_PROGRESS_ID),
    assistantMessage('fork-turn', [
      { type: 'tool_use', id: 'fork-tu', name: 'Bash', input: {} },
    ]),
  ]
}

describe('2.1.276 ITEM R — forked skill forwards nested subagent progress', () => {
  test('forwards agent_progress and skill_progress exactly once when the flag is on', async () => {
    // Arrange
    const stream = forkStreamWithNestedProgress()

    // Act
    const forwarded = await runForkedSkill(true, stream)

    // Assert — v274 forwarded NEITHER (they are not assistant/user turns).
    const agentForwards = forwarded.filter(p => p.data.type === 'agent_progress')
    const skillNestedForwards = forwarded.filter(
      p =>
        p.data.type === 'skill_progress' &&
        p.toolUseID === NESTED_SKILL_PROGRESS_ID,
    )
    expect(agentForwards).toHaveLength(1)
    expect(skillNestedForwards).toHaveLength(1)
    // The nested toolUseID is preserved (official `hMt` copies it verbatim).
    expect(agentForwards[0]!.toolUseID).toBe(NESTED_AGENT_PROGRESS_ID)
  })

  test('does not duplicate a nested progress message through the skill_progress branch', async () => {
    // Arrange
    const stream = forkStreamWithNestedProgress()

    // Act
    const forwarded = await runForkedSkill(true, stream)

    // Assert — the nested agent_progress must appear once (the official
    // `continue` keeps it out of the assistant/user forwarding path), while the
    // fork's own tool_use turn still produces the pre-existing skill_progress.
    expect(
      forwarded.filter(p => p.toolUseID === NESTED_AGENT_PROGRESS_ID),
    ).toHaveLength(1)
    const ownSkillForwards = forwarded.filter(
      p => p.data.type === 'skill_progress' && p.toolUseID !== NESTED_SKILL_PROGRESS_ID,
    )
    expect(ownSkillForwards).toHaveLength(1)
    expect(ownSkillForwards[0]!.toolUseID).toBe('skill_skill-parent')
  })

  test('does not forward nested progress when the flag is off', async () => {
    // Arrange
    const stream = forkStreamWithNestedProgress()

    // Act
    const forwarded = await runForkedSkill(false, stream)

    // Assert
    expect(forwarded.filter(p => p.data.type === 'agent_progress')).toEqual([])
    expect(
      forwarded.filter(p => p.toolUseID === NESTED_SKILL_PROGRESS_ID),
    ).toEqual([])
    // The pre-existing tool-bearing forward is flag-independent.
    expect(
      forwarded.filter(p => p.toolUseID === 'skill_skill-parent'),
    ).toHaveLength(1)
  })

  test('leaves non-subagent progress (bash_progress) untouched', async () => {
    // Arrange — the official `w7` predicate is narrow: only agent_progress and
    // skill_progress are forwarded.
    const stream = [nestedProgress('bash_progress', NESTED_BASH_PROGRESS_ID)]

    // Act
    const forwarded = await runForkedSkill(true, stream)

    // Assert
    expect(forwarded.filter(p => p.toolUseID === NESTED_BASH_PROGRESS_ID)).toEqual(
      [],
    )
  })
})
