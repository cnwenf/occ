import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOcc } from './helpers'

/**
 * CC 2.1.283 — thinking-only nudge STATE-MACHINE WIRING (OCC-140 P2).
 *
 * The v2.1.358 acceptance round proved the nudge runtime behavior correct
 * with 4 throwaway wire probes (acceptor's /tmp/candidate-validation/ — a
 * temp path, since lost). This file rebuilds them as CHECKED-IN wire e2e
 * tests, per docs/upstream-version-gap-occ99-2026-09.md §6, pinning the
 * query-loop wiring that version-2.1.283-thinking-only-nudge.e2e.test.ts
 * does not cover:
 *
 *   probe-a  one-shot guard resets ONLY at next_turn (query.ts:2044
 *            `thinkingOnlyNudged: false`, official `Kr` reset set
 *            @211098289) — a tool cycle between two thinking-only
 *            responses must nudge TWICE.
 *   probe-b  the `stop_sequence` arm of the nudge condition (query.ts:1465,
 *            official `V==="stop_sequence"`) is reachable.
 *   probe-c  terminal-MCP-tool walk-back guard (query.ts:1469, official
 *            `Ggo(A)` + `r$e()` env parse @206152475) suppresses the nudge.
 *   probe-d  StructuredOutput-turn guard (query.ts:1471, official `ie(A)`
 *            @211160472) suppresses the nudge.
 *
 * Each probe was mutation-verified against the exact ledger mutations
 * (docs/upstream-version-gap-occ140.md §3): removing the wiring makes the
 * corresponding probe FAIL. See per-probe comments for the mutation and
 * expected failure mode.
 *
 * Harness pattern (sequential mock SSE endpoint + freshHome + runOcc):
 * version-2.1.283-thinking-only-nudge.e2e.test.ts. Kept self-contained per
 * the established version-* e2e convention.
 */

const ANSWER_MARKER = 'OCC140_NUDGE_WIRING_ANSWER'
const NUDGE_TEXT =
  '[Your previous response had no visible output. Please continue and produce a user-visible response.]'
const NUDGE_BLOCK = {
  type: 'text',
  text: NUDGE_TEXT,
  cache_control: { type: 'ephemeral' },
}

function sse(events: Array<{ event: string; data: unknown }>): string {
  return (
    events
      .map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join('') + '\n'
  )
}

function messageStart(id: string): object {
  return {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-nudge283-mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  }
}

/** Thinking-only assistant response ending with the given stop_reason. */
function thinkingOnlySse(
  id: string,
  stopReason: 'end_turn' | 'stop_sequence',
  thinkingMarker: string,
): string {
  return sse([
    { event: 'message_start', data: messageStart(id) },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: thinkingMarker },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_mock' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

/** Single tool_use assistant response (stop_reason tool_use). */
function toolUseSse(opts: {
  id: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
}): string {
  return sse([
    { event: 'message_start', data: messageStart(opts.id) },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: opts.toolUseId,
          name: opts.toolName,
          input: {},
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(opts.input),
        },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

const TEXT_ANSWER_SSE = sse([
  { event: 'message_start', data: messageStart('msg_answer') },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ANSWER_MARKER },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
])

interface MockEndpoint {
  port: number
  /** Request bodies of POST /v1/messages calls, in order. */
  bodies: () => string[]
  close: () => Promise<void>
}

/**
 * Sequential mock: serves `responses[i]` for the i-th POST /v1/messages;
 * once exhausted, repeats the last entry (tests assert exact body counts).
 */
function startMockEndpoint(responses: string[]): Promise<MockEndpoint> {
  const bodies: string[] = []
  let messageCalls = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let payload = responses[responses.length - 1] ?? ''
      if (req.method === 'POST' && req.url?.includes('/v1/messages')) {
        bodies.push(body)
        payload =
          responses[Math.min(messageCalls, responses.length - 1)] ?? ''
        messageCalls++
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.end(payload)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        bodies: () => [...bodies],
        close: () =>
          new Promise<void>(res => {
            server.close(() => res())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function freshHome(root: string, projectDir: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-09-11T00:00:00.000Z',
      migrationVersion: 11,
      userID: 'occ-nudgewire-0000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.283',
      lastReleaseNotesSeen: '2.1.283',
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true }),
  )
  return home
}

function baseEnv(
  endpoint: MockEndpoint,
  home: string,
  projectDir: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: 'occ-nudgewire-key',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
    // Blank model overrides — the runner host may export its own.
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_UNATTENDED_RETRY: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Default: terminal-MCP semantics OFF (probe-c opts in).
    CLAUDE_CODE_TERMINAL_MCP_TOOLS: '',
    ...overrides,
  }
}

function setup(root: string): { projectDir: string; home: string } {
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  const home = freshHome(root, projectDir)
  return { projectDir, home }
}

/** Parse body i and return the LAST content block of its last user message. */
function lastUserLastBlock(body: string): unknown {
  const parsed = JSON.parse(body) as {
    messages: Array<{ role: string; content: unknown }>
  }
  const last = parsed.messages.at(-1)
  expect(last?.role).toBe('user')
  const content = last?.content
  expect(Array.isArray(content)).toBe(true)
  return (content as Array<unknown>).at(-1)
}

describe('2.1.283 thinking-only nudge — state-machine wiring (OCC-140 P2)', () => {
  test('probe-a: one-shot guard resets ONLY at next_turn — a tool cycle between two thinking-only responses nudges TWICE', async () => {
    // Wiring under test: query.ts:2044 — the next_turn State literal carries
    // `thinkingOnlyNudged: false` (official `Kr` reset set @211098289, spread
    // as `{...Me,...Kr}` — the ONLY reset site). Flow:
    //   call 1: thinking-only end_turn  → nudge #1 (guard false→true)
    //   call 2: Bash tool_use           → tool runs → next_turn → guard RESET
    //   call 3: thinking-only end_turn  → nudge #2 (guard was reset)
    //   call 4: visible text            → answer printed
    // MUTATION SEMANTICS (verified empirically, recorded in the occ140 gap
    // doc §3): LITERALLY DELETING `thinkingOnlyNudged: false` from the
    // next_turn literal is INERT — the State is a fresh object literal, so
    // the field becomes `undefined`, which is falsy exactly like `false` at
    // the only read site (`if (!thinkingOnlyNudged)`, query.ts:1473). The
    // FAITHFUL "删复位" mutation is the carry-over form — replacing the line
    // with bare `thinkingOnlyNudged,` (mirroring official `...Me` spread with
    // the `Kr` reset removed). Under that mutation the guard survives the
    // tool cycle, call 3 hits nudge_exhausted, and this probe fails with 3
    // bodies and no ANSWER_MARKER.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudgewire-a-'))
    const endpoint = await startMockEndpoint([
      thinkingOnlySse('msg_a1', 'end_turn', 'SILENT_A1'),
      toolUseSse({
        id: 'msg_a2',
        toolName: 'Bash',
        toolUseId: 'toolu_a2',
        input: {
          command: 'echo occ140-probe-a-tool-cycle',
          description: 'probe-a tool cycle',
        },
      }),
      thinkingOnlySse('msg_a3', 'end_turn', 'SILENT_A3'),
      TEXT_ANSWER_SSE,
    ])
    try {
      const { projectDir, home } = setup(root)
      const result = await runOcc(
        ['-p', 'run the tool then answer', '--dangerously-skip-permissions'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(ANSWER_MARKER)
      const bodies = endpoint.bodies()
      // Nudge fired TWICE → 4 /v1/messages calls total.
      expect(bodies).toHaveLength(4)
      // Retry after nudge #1 ends with the byte-exact nudge block.
      expect(lastUserLastBlock(bodies[1]!)).toEqual(NUDGE_BLOCK)
      // Retry after nudge #2 (post tool-cycle, guard was reset) also ends
      // with the byte-exact nudge block — this is the assertion that dies
      // under the carry-over mutation.
      expect(lastUserLastBlock(bodies[3]!)).toEqual(NUDGE_BLOCK)
      // The tool cycle really happened between the two nudges.
      expect(bodies[3]).toContain('occ140-probe-a-tool-cycle')
      // Both thinking-only turns were dropped from their retries.
      expect(bodies[1]).not.toContain('SILENT_A1')
      expect(bodies[3]).not.toContain('SILENT_A3')
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('probe-b: the stop_sequence arm of the nudge condition is reachable', async () => {
    // Wiring under test: query.ts:1465 — `(lastStopReason === 'end_turn' ||
    // lastStopReason === 'stop_sequence')` (official `V==="end_turn"||V===
    // "stop_sequence"` @211166255). A thinking-only response ending on a
    // STOP SEQUENCE (not end_turn) must still trigger the one-shot nudge.
    // MUTATION: deleting `|| lastStopReason === 'stop_sequence'` makes the
    // turn complete silently after 1 call — this probe fails on the body
    // count and the missing ANSWER_MARKER.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudgewire-b-'))
    const endpoint = await startMockEndpoint([
      thinkingOnlySse('msg_b1', 'stop_sequence', 'SILENT_B1'),
      TEXT_ANSWER_SSE,
    ])
    try {
      const { projectDir, home } = setup(root)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(ANSWER_MARKER)
      const bodies = endpoint.bodies()
      expect(bodies).toHaveLength(2)
      expect(lastUserLastBlock(bodies[1]!)).toEqual(NUDGE_BLOCK)
      expect(bodies[1]).not.toContain('SILENT_B1')
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('probe-c: terminal-MCP-tool walk-back guard suppresses the nudge', async () => {
    // Wiring under test: query.ts:1469 `!isTerminalMcpToolTurn(
    // messagesForQuery)` — official `Ggo(A)` walk-back @206152591 + `r$e()`
    // CLAUDE_CODE_TERMINAL_MCP_TOOLS env parse @206152475. When the turn's
    // history ends in a SUCCESSFUL tool_result for a tool whose name is in
    // the terminal set, a following textless end_turn is BY DESIGN (terminal
    // tools end sessions with no visible text) — no nudge, no extra call.
    // This probe names `Bash` as the terminal tool: the guard is name-based
    // (env list), so this exercises the REAL env→walk-back→suppress wiring
    // without requiring an MCP server.
    // MUTATION: deleting the `!isTerminalMcpToolTurn(...)` clause lets the
    // nudge fire on the thinking-only response → a 3rd call (mock repeats
    // the last response; guard then exhausts) → body-count assertion fails.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudgewire-c-'))
    const endpoint = await startMockEndpoint([
      toolUseSse({
        id: 'msg_c1',
        toolName: 'Bash',
        toolUseId: 'toolu_c1',
        input: {
          command: 'echo occ140-probe-c-terminal',
          description: 'probe-c terminal tool',
        },
      }),
      thinkingOnlySse('msg_c2', 'end_turn', 'SILENT_C2'),
    ])
    try {
      const { projectDir, home } = setup(root)
      const result = await runOcc(
        ['-p', 'run the tool', '--dangerously-skip-permissions'],
        baseEnv(endpoint, home, projectDir, {
          CLAUDE_CODE_TERMINAL_MCP_TOOLS: 'Bash',
        }),
        60_000,
      )
      expect(result.code).toBe(0)
      const bodies = endpoint.bodies()
      // Tool cycle + the suppressed textless turn = exactly 2 calls.
      expect(bodies).toHaveLength(2)
      // No nudge was injected anywhere.
      expect(bodies[1]).not.toContain(NUDGE_TEXT)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('probe-d: StructuredOutput-turn guard suppresses the nudge (--json-schema)', async () => {
    // Wiring under test: query.ts:1471 `!isStructuredOutputTurn(
    // messagesForQuery)` — official `ie(A)` @211160472 with
    // `bi="StructuredOutput"` @201499968. With --json-schema, the turn
    // delivers its answer via the StructuredOutput tool call; the following
    // textless end_turn is BY DESIGN — the nudge must not fire.
    // Flow: call 1 → StructuredOutput tool_use (valid input → tool succeeds,
    // also satisfying the registerStructuredOutputEnforcement Stop hook —
    // executeFunctionHook: callback true → success, no stop_hook_blocking
    // re-query); call 2 → thinking-only end_turn → guard suppresses nudge.
    // MUTATION: deleting the `!isStructuredOutputTurn(...)` clause lets the
    // nudge fire → a 3rd call → body-count assertion fails.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudgewire-d-'))
    const schema = JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    const endpoint = await startMockEndpoint([
      toolUseSse({
        id: 'msg_d1',
        toolName: 'StructuredOutput',
        toolUseId: 'toolu_d1',
        input: { name: 'occ140-probe-d' },
      }),
      thinkingOnlySse('msg_d2', 'end_turn', 'SILENT_D2'),
    ])
    try {
      const { projectDir, home } = setup(root)
      const result = await runOcc(
        [
          '-p',
          'produce the structured output',
          '--json-schema',
          schema,
          '--dangerously-skip-permissions',
        ],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      const bodies = endpoint.bodies()
      // StructuredOutput cycle + the suppressed textless turn = exactly 2.
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).not.toContain(NUDGE_TEXT)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
