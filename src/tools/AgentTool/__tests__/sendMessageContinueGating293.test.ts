import { describe, expect, test } from 'bun:test'

// agentToolUtils / AgentTool transitively read MACRO.VERSION at call time
// (analytics + permission paths); mirror the cli.tsx polyfill before import.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
// Hermetic for credential-less environments (getSubscriptionType/auth guard).
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const { AgentTool } = await import('../AgentTool.js')
const { getPrompt } = await import('../prompt.js')
const { GENERAL_PURPOSE_AGENT } = await import('../built-in/generalPurposeAgent.js')

// Official Claude Code 2.1.293 changelog entry #9: when SendMessage is NOT in
// the session's tool table (host / permission-rule / --tools removed it), the
// model must not be told to continue or message subagents with SendMessage.
//
// Binary-verified surfaces (vver ELF):
//   gate: `function Dw(o){return o.some((e)=>Dt(e,nr))}` with nr="SendMessage"
//   async_launched footer @220374706:
//     `agentId: ${n.agentId} (internal ID - do not mention to user.${n.canContinueAgent===!1?"":` Use ${nr} with to: '${n.agentId}', summary: '<5-10 word recap>' to continue this agent.`})`
//   completed trailer @220376291:
//     `let k=n.canContinueAgent===!1?"":` (use ${nr} with to: '${n.agentId}', ... to continue this agent)``
//   prompt builder H6o @215972233 (continueAvailable `g`):
//     `${g?`To continue a previously spawned agent, use ${nr} ...`:`A previously spawned agent cannot be continued from here. Every ${yt} call`} starts a fresh agent ...`
//
// OCC keeps its own (292-era) wording for the AVAILABLE branch byte-identical
// and only swaps in the official "cannot be continued from here" fallback when
// SendMessage is unavailable, so the default path never regresses.

const mapper = (AgentTool as unknown as {
  mapToolResultToToolResultBlockParam: (
    data: unknown,
    id: string,
  ) => { content: Array<{ type: string; text?: string }> }
}).mapToolResultToToolResultBlockParam

function textOf(mapped: { content: Array<{ type: string; text?: string }> }): string {
  return mapped.content.map(c => c.text ?? '').join('\n')
}

function asyncData(canContinueAgent?: boolean) {
  return {
    status: 'async_launched' as const,
    agentId: 'agent-123',
    description: 'do a thing',
    prompt: 'p',
    outputFile: '/tmp/out.txt',
    canReadOutputFile: false,
    ...(canContinueAgent === undefined ? {} : { canContinueAgent }),
  }
}

function completedData(canContinueAgent?: boolean) {
  return {
    status: 'completed' as const,
    agentId: 'agent-123',
    prompt: 'p',
    content: [{ type: 'text' as const, text: 'done' }],
    totalTokens: 10,
    totalToolUseCount: 2,
    totalDurationMs: 300,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    },
    ...(canContinueAgent === undefined ? {} : { canContinueAgent }),
  }
}

describe('#9 async_launched footer gating (AgentTool.tsx mapToolResult)', () => {
  test('canContinueAgent===false drops the SendMessage continue clause but keeps the internal-ID note', () => {
    const text = textOf(mapper(asyncData(false), 'tu-1'))
    expect(text).toContain('(internal ID - do not mention to user.)')
    expect(text).not.toContain('to continue this agent')
    expect(text).not.toContain('SendMessage')
  })

  test('canContinueAgent===true keeps the SendMessage continue clause', () => {
    const text = textOf(mapper(asyncData(true), 'tu-2'))
    expect(text).toContain('Use SendMessage')
    expect(text).toContain('to continue this agent')
  })

  test('absent canContinueAgent (legacy/resume) defaults to continue-available', () => {
    const text = textOf(mapper(asyncData(undefined), 'tu-3'))
    expect(text).toContain('to continue this agent')
  })
})

describe('#9 completed trailer gating (AgentTool.tsx mapToolResult)', () => {
  test('canContinueAgent===false drops the SendMessage continue clause', () => {
    const text = textOf(mapper(completedData(false), 'tu-4'))
    expect(text).toContain('agentId: agent-123')
    expect(text).toContain('<usage>')
    expect(text).not.toContain('to continue this agent')
    expect(text).not.toContain('SendMessage')
  })

  test('canContinueAgent===true keeps the SendMessage continue clause', () => {
    const text = textOf(mapper(completedData(true), 'tu-5'))
    expect(text).toContain('to continue this agent')
  })

  test('absent canContinueAgent (legacy/resume) defaults to continue-available', () => {
    const text = textOf(mapper(completedData(undefined), 'tu-6'))
    expect(text).toContain('to continue this agent')
  })
})

function makeAgent(agentType: string) {
  return {
    agentType,
    whenToUse: `Test agent ${agentType}`,
    tools: ['*'],
    source: 'built-in',
    getSystemPrompt: () => '',
  } as never
}

describe('#9 prompt-builder continue-instruction gating (prompt.ts getPrompt)', () => {
  const REVIEWER = makeAgent('code-reviewer')

  test('continueAvailable default (true) advertises SendMessage continuation', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT, REVIEWER])
    expect(prompt).toContain('To continue a previously spawned agent, use SendMessage')
    expect(prompt).not.toContain('A previously spawned agent cannot be continued from here')
  })

  test('continueAvailable=false swaps in the official fallback sentence', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT, REVIEWER], false, undefined, false)
    expect(prompt).toContain('A previously spawned agent cannot be continued from here')
    expect(prompt).not.toContain('To continue a previously spawned agent, use SendMessage')
  })

  test('continueAvailable=true (explicit) keeps the SendMessage bullet', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT, REVIEWER], false, undefined, true)
    expect(prompt).toContain('To continue a previously spawned agent, use SendMessage')
  })
})
