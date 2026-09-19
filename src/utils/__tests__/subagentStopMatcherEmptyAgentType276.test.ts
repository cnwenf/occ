import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../settings/types.js'

/**
 * claude-code 2.1.276: "Fixed SubagentStop hook matcher firing for every
 * stopping subagent when the agent type is empty."
 *
 * Official v274 wrapper (byte-extracted): `let S=For(s); … S?y.filter(…):y`
 * — truthiness gating. Official v276 (`uBn`): `let w=eBn(s); …
 * w!==void 0?y.filter((bt)=>!bt.matcher||rBn(w,…)):y` — `undefined` gating.
 *
 * OCC builds SubagentStop input with `agent_type: agentType ?? ''`
 * (src/utils/hooks.ts), so `''` is live: with truthiness gating the empty
 * string skipped matcher filtering entirely and EVERY SubagentStop hook fired
 * regardless of its matcher. With `undefined` gating, `''` is a real match
 * value that fails a specific matcher and passes only absent/'*' matchers.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only getHooksConfigFromSnapshot, restore.
const actualSnapshotModule = await import('../hooks/hooksConfigSnapshot.js')

let mockedHooksConfig: HooksSettings | null = null

mock.module('../hooks/hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

afterAll(() => {
  mock.module('../hooks/hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
})

const { getMatchingHooks } = await import('../hooks.js')

afterEach(() => {
  mockedHooksConfig = null
})

const SESSION_ID = 'test-session'

function subagentStopInput(agentType: string | undefined): never {
  return {
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    session_id: SESSION_ID,
    transcript_path: '/nonexistent/transcript.jsonl',
    cwd: '/nonexistent',
    permission_mode: 'default',
    agent_id: 'agent-1',
    agent_transcript_path: '/nonexistent/agent.jsonl',
    ...(agentType !== undefined ? { agent_type: agentType } : {}),
  } as never
}

function subagentStopConfig(matcher?: string): HooksSettings {
  return {
    SubagentStop: [
      {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [{ type: 'command', command: 'true' }],
      },
    ],
  } as HooksSettings
}

async function matchedCount(
  agentType: string | undefined,
  matcher?: string,
): Promise<number> {
  mockedHooksConfig = subagentStopConfig(matcher)
  const matched = await getMatchingHooks(
    undefined,
    SESSION_ID,
    'SubagentStop',
    subagentStopInput(agentType),
  )
  return matched.length
}

describe('2.1.276 SubagentStop matcher with empty agent_type', () => {
  test('agent_type "" + specific matcher → hook does NOT fire', async () => {
    // The v274 truthiness bug returned 1 here (filtering skipped for '').
    expect(await matchedCount('', 'code-reviewer')).toBe(0)
  })

  test('agent_type "" + no matcher → hook fires', async () => {
    expect(await matchedCount('')).toBe(1)
  })

  test('agent_type "" + "*" matcher → hook fires', async () => {
    expect(await matchedCount('', '*')).toBe(1)
  })

  test('non-empty matching agent_type + specific matcher → hook fires', async () => {
    expect(await matchedCount('code-reviewer', 'code-reviewer')).toBe(1)
  })

  test('non-empty non-matching agent_type + specific matcher → hook does NOT fire', async () => {
    // Sanity: matcher filtering is really active (not just returning 0 for all).
    expect(await matchedCount('general-purpose', 'code-reviewer')).toBe(0)
  })

  test('agent_type absent (undefined) + specific matcher → filtering skipped, hook fires', async () => {
    // Official v276 keeps the undefined case unfiltered: `w!==void 0?…:y`.
    expect(await matchedCount(undefined, 'code-reviewer')).toBe(1)
  })
})
