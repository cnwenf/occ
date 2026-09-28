import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THINKING_ONLY_NUDGE_TEXT } from '../../src/query/thinkingOnlyNudge.js'
import { runOcc } from './helpers'

/**
 * CC 2.1.283 — thinking-only response nudge (official query-loop code
 * byte-extracted from the linux-x64 ELF @211166255; upstream changelog
 * 2.1.183 "Fixed turns silently completing with no visible output"):
 *
 *   `let V=g?.message.stop_reason??tn;if((V==="end_turn"||V==="stop_sequence")
 *    &&!g?.isApiErrorMessage&&h!=="compact"&&!nVe(h)&&!Ggo(A)
 *    &&!L.some(W=>W.message.content.some(de=>de.type==="text"
 *      &&de.text.trim().length>0))&&!ie(A)){
 *      if(!ns){p("query_thinking_only_response","nudged");
 *        let W=Ae({content:I$t,isMeta:!0,turnCompanion:!0,...});yield W,
 *        Z={guards:{...Me,thinkingOnlyNudged:!0},messages:[...A,W],...
 *          transition:{reason:"thinking_only_retry"}};continue}
 *      m("query_thinking_only_response","nudge_exhausted")}`
 *
 * Observable wire contract this e2e pins (print mode, mock endpoint):
 *  1. Response #1 = thinking-only assistant message ending `end_turn` →
 *     the CLI must NOT silently complete; it re-queries (2 /v1/messages
 *     calls total).
 *  2. Retry request's `messages` ends with the byte-exact official nudge
 *     `I$t` as a user message.
 *  3. The thinking-only assistant message is DROPPED from the retry
 *     context — official `messages:[...A,W]` where A excludes this turn's
 *     L (proven against the adjacent truncated-recovery `[...A,...L,W]`).
 *  4. Response #2 (visible text) becomes the printed result.
 *  5. One-shot guard: a SECOND consecutive thinking-only response after
 *     the nudge must NOT trigger a third request (`thinkingOnlyNudged`
 *     is never reset inside a turn — official `Kr` resets it only on
 *     next_turn).
 *
 * OCC-100 (§6.1/§6.3 of docs/upstream-version-gap-occ99-2026-09.md) adds
 * the four checked-in wiring probes — next_turn-only reset re-arm
 * (probe-a), the `stop_sequence` arm (probe-b), the terminal-MCP walk-back
 * (probe-c, with negative control), and the StructuredOutput exclusion
 * (probe-d) — and upgrades the "byte-exact" nudge claim from `toContain` to
 * FULL wire equality (`lastMessageLastTextBlock(...) ===
 * THINKING_ONLY_NUDGE_TEXT`).
 *
 * Wire-level mock endpoint pattern from
 * version-2.1.283-model-governance-startup-gate.e2e.test.ts.
 */

const THINKING_MARKER = 'SILENT_THINKING_MARKER_283'
const ANSWER_MARKER = 'OCC99_NUDGE_RECOVERY_ANSWER'

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

const THINKING_ONLY_SSE = thinkingOnlySse({
  messageId: 'msg_thinking_only',
  stopReason: 'end_turn',
})

/** Parameterized thinking-only response — probe-b varies the stop reason. */
function thinkingOnlySse(opts: {
  messageId: string
  stopReason: string
  stopSequence?: string | null
}): string {
  return sse([
    { event: 'message_start', data: messageStart(opts.messageId) },
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
        delta: { type: 'thinking_delta', thinking: THINKING_MARKER },
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
        delta: {
          stop_reason: opts.stopReason,
          stop_sequence: opts.stopSequence ?? null,
        },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

/**
 * Single tool_use response (real-API shape: empty `input` at block start,
 * full JSON via one `input_json_delta`, message ends on `tool_use`).
 */
function toolUseSse(opts: {
  messageId: string
  toolUseId: string
  toolName: string
  inputJson: string
}): string {
  return sse([
    { event: 'message_start', data: messageStart(opts.messageId) },
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
        delta: { type: 'input_json_delta', partial_json: opts.inputJson },
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

/**
 * Wire-layer LAST text block of the last message in a request body
 * (OCC-100 §6.3: the "byte-exact" claim must be an equality assertion, not
 * a substring `toContain`).
 *
 * Empirical wire shape (dumped against the built CLI): normalizeMessagesForAPI
 * MERGES the consecutive user messages ([original prompt, nudge] → one user
 * message), so the nudge arrives as the FINAL text block of the merged
 * message — that block is compared with full equality against the ported
 * THINKING_ONLY_NUDGE_TEXT constant. Role mismatch / missing text blocks
 * yield a diagnostic string so the equality assertion fails loudly.
 */
function lastMessageLastTextBlock(body: string): string {
  const parsed = JSON.parse(body) as {
    messages: Array<{ role: string; content: unknown }>
  }
  const last = parsed.messages.at(-1)
  if (!last) return '<no messages>'
  if (last.role !== 'user') return `<last role: ${last.role}>`
  const content = last.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlocks = content.filter(
      (b): b is { type: 'text'; text: string } =>
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    const lastBlock = textBlocks.at(-1)
    if (!lastBlock) return `<no text blocks: ${JSON.stringify(content)}>`
    return lastBlock.text
  }
  return `<unexpected content: ${JSON.stringify(content)}>`
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
  /**
   * Swap the scripted responses after startup (OCC-100 probes build SSE
   * fixtures that embed temp-dir file paths, which only exist once the
   * per-test project dir has been created).
   */
  replaceResponses: (next: string[]) => void
  close: () => Promise<void>
}

/**
 * Sequential mock: serves `responses[i]` for the i-th POST /v1/messages;
 * once exhausted, repeats the last entry (a test that expects exactly N
 * calls asserts the body count separately).
 */
function startMockEndpoint(responses: string[] = []): Promise<MockEndpoint> {
  const bodies: string[] = []
  let current = responses
  let messageCalls = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let payload = THINKING_ONLY_SSE
      if (req.method === 'POST' && req.url?.includes('/v1/messages')) {
        bodies.push(body)
        payload =
          current[Math.min(messageCalls, current.length - 1)] ??
          THINKING_ONLY_SSE
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
        replaceResponses: (next: string[]) => {
          current = next
        },
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
      userID: 'occ-nudge283-000000000000000000000000000000000000001',
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
): Record<string, string> {
  return {
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: 'occ-nudge283-key',
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
    // The nudge must not be masked by terminal-MCP semantics.
    CLAUDE_CODE_TERMINAL_MCP_TOOLS: '',
  }
}

describe('2.1.283 thinking-only response nudge (query-loop parity)', () => {
  test('thinking-only end_turn → one-shot nudge retry with dropped thinking turn, then answer printed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-'))
    const endpoint = await startMockEndpoint([
      THINKING_ONLY_SSE,
      TEXT_ANSWER_SSE,
    ])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      // (4) the recovered answer is the printed result.
      expect(result.stdout).toContain(ANSWER_MARKER)

      const bodies = endpoint.bodies()
      // (1) exactly two /v1/messages calls — the nudge retry, no more.
      expect(bodies).toHaveLength(2)

      const retry = JSON.parse(bodies[1]!) as {
        messages: Array<{ role: string; content: unknown }>
      }
      const retryMessages = retry.messages
      // (2) the retry request ends with the byte-exact official nudge I$t
      // as a user message. OCC-100 (§6.3): FULL wire equality against the
      // ported constant — the previous `toContain` substring check did not
      // match the "byte-exact" claim (extra blocks/text would have slipped
      // through).
      const last = retryMessages.at(-1)
      expect(last?.role).toBe('user')
      expect(lastMessageLastTextBlock(bodies[1]!)).toBe(THINKING_ONLY_NUDGE_TEXT)
      // (3) the thinking-only assistant turn is DROPPED from the retry
      // context (official messages:[...A,W] — A excludes this turn's L).
      expect(bodies[1]).not.toContain(THINKING_MARKER)
      // The original user prompt survives.
      expect(bodies[1]).toContain('say something visible')
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('second consecutive thinking-only response does NOT trigger a third request (one-shot guard)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-exh-'))
    // Every response is thinking-only: after the nudge retry also comes back
    // textless, the official guard (thinkingOnlyNudged, never reset within
    // the turn) logs nudge_exhausted and completes — exactly 2 calls.
    const endpoint = await startMockEndpoint([THINKING_ONLY_SSE])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      // Turn completes (no visible text) — the CLI must not loop forever.
      expect(result.code).toBe(0)
      expect(endpoint.bodies()).toHaveLength(2)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  // ─────────────────────────────────────────────────────────────────────
  // OCC-100 carry-over P2 (docs/upstream-version-gap-occ99-2026-09.md §6.1):
  // checked-in wire regressions for the query-loop WIRING of the nudge
  // state machine, rebuilt from the acceptance reviewer's four /tmp probes
  // (probe-a-nextturn / probe-b-stopseq / probe-c-terminal /
  // probe-d-structuredoutput). Each probe fails under the matching mutation
  // of src/query.ts (flip the next_turn reset @2044 to sticky-true / delete
  // the `stop_sequence` arm / delete the isTerminalMcpToolTurn guard /
  // delete the isStructuredOutputTurn guard) while the pre-OCC-100 suite
  // stayed green. Precision note (OCC-100 acceptance P3): LITERALLY deleting
  // the `thinkingOnlyNudged: false` line is behavior-neutral — the field is
  // optional, so it reads `undefined`, still falsy under `!thinkingOnlyNudged`
  // — the regression probe-a kills is the sticky-true flip (both mutants
  // re-verified empirically in the 2.1.359 release round).
  // ─────────────────────────────────────────────────────────────────────

  test('probe-a (next_turn reset): a completed tool turn re-arms the one-shot nudge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-pa-'))
    const endpoint = await startMockEndpoint([])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const probeFile = join(projectDir, 'probe-a.txt')
      writeFileSync(probeFile, 'PROBE_A_FILE_OK')
      // Sequence: thinking-only → nudge #1 → tool_use(Read, succeeds) →
      // next_turn transition RESETS thinkingOnlyNudged (query.ts @2044 —
      // the only reset site) → thinking-only again → nudge #2 MUST fire →
      // answer. Killing mutation (reset flipped sticky-true): only 3
      // requests, no nudge #2. A literal deletion of the reset line is
      // behavior-neutral (optional field → `undefined` → still falsy).
      endpoint.replaceResponses([
        THINKING_ONLY_SSE,
        toolUseSse({
          messageId: 'msg_tool_read',
          toolUseId: 'toolu_probe_a',
          toolName: 'Read',
          inputJson: JSON.stringify({ file_path: probeFile }),
        }),
        thinkingOnlySse({ messageId: 'msg_thinking_only_2', stopReason: 'end_turn' }),
        TEXT_ANSWER_SSE,
      ])
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(ANSWER_MARKER)

      const bodies = endpoint.bodies()
      // request1 + nudge retry + post-tool next_turn + nudge retry #2
      expect(bodies).toHaveLength(4)
      // The tool turn really succeeded (Read result carried in request 3).
      expect(bodies[2]).toContain('tool_result')
      expect(bodies[2]).toContain('PROBE_A_FILE_OK')
      // BOTH retries end with the byte-exact nudge (full wire equality).
      expect(lastMessageLastTextBlock(bodies[1]!)).toBe(THINKING_ONLY_NUDGE_TEXT)
      expect(lastMessageLastTextBlock(bodies[3]!)).toBe(THINKING_ONLY_NUDGE_TEXT)
      // Neither thinking-only turn leaks into the retry context.
      expect(bodies[3]).not.toContain(THINKING_MARKER)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('probe-b (stop_sequence arm): thinking-only ending on stop_sequence also nudges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-pb-'))
    const endpoint = await startMockEndpoint([])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      // The official condition is `(V==="end_turn"||V==="stop_sequence")`.
      // Mutation (delete the stop_sequence arm): 1 request, silent
      // completion — exactly the 2.1.183 bug the nudge fixes.
      endpoint.replaceResponses([
        thinkingOnlySse({
          messageId: 'msg_thinking_stopseq',
          stopReason: 'stop_sequence',
          stopSequence: '\n\n',
        }),
        TEXT_ANSWER_SSE,
      ])
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(ANSWER_MARKER)

      const bodies = endpoint.bodies()
      expect(bodies).toHaveLength(2)
      expect(lastMessageLastTextBlock(bodies[1]!)).toBe(THINKING_ONLY_NUDGE_TEXT)
      expect(bodies[1]).not.toContain(THINKING_MARKER)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('probe-c (terminal-MCP walk-back): successful result for a CLAUDE_CODE_TERMINAL_MCP_TOOLS name suppresses the nudge', async () => {
    // Official `Ggo` walk-back: when the history ends with a SUCCESSFUL
    // tool_result for a tool_use whose name is in the env-parsed terminal
    // set (`r$e`), no visible text is expected after it → no nudge. The
    // guard is purely name-based, so the probe drives it with a real
    // successful Read turn and `CLAUDE_CODE_TERMINAL_MCP_TOOLS=Read`;
    // OCC has no other consumer of the env var (grep: only the nudge
    // guard), so this exercises exactly the ported walk-back.
    // Mutation (delete `!isTerminalMcpToolTurn(...)`): a third request
    // carrying the nudge appears.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-pc-'))
    const endpoint = await startMockEndpoint([])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const probeFile = join(projectDir, 'probe-c.txt')
      writeFileSync(probeFile, 'PROBE_C_FILE_OK')
      endpoint.replaceResponses([
        toolUseSse({
          messageId: 'msg_tool_read_c',
          toolUseId: 'toolu_probe_c',
          toolName: 'Read',
          inputJson: JSON.stringify({ file_path: probeFile }),
        }),
        thinkingOnlySse({ messageId: 'msg_thinking_after_terminal', stopReason: 'end_turn' }),
      ])
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        {
          ...baseEnv(endpoint, home, projectDir),
          CLAUDE_CODE_TERMINAL_MCP_TOOLS: 'Read',
        },
        60_000,
      )
      expect(result.code).toBe(0)

      const bodies = endpoint.bodies()
      // initial + post-tool continuation ONLY — the nudge must not fire.
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toContain('tool_result')
      expect(bodies[1]).toContain('PROBE_C_FILE_OK')
      for (const body of bodies) {
        expect(body).not.toContain(THINKING_ONLY_NUDGE_TEXT)
      }
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }

    // Negative control: the SAME transcript with the env var cleared must
    // nudge (proves suppression is env-driven, not a generic "tool turn
    // disables nudge" side effect).
    const root2 = mkdtempSync(join(tmpdir(), 'occ-nudge283-pc0-'))
    const endpoint2 = await startMockEndpoint([])
    try {
      const projectDir = join(root2, 'project')
      mkdirSync(projectDir, { recursive: true })
      const probeFile = join(projectDir, 'probe-c.txt')
      writeFileSync(probeFile, 'PROBE_C_FILE_OK')
      endpoint2.replaceResponses([
        toolUseSse({
          messageId: 'msg_tool_read_c2',
          toolUseId: 'toolu_probe_c2',
          toolName: 'Read',
          inputJson: JSON.stringify({ file_path: probeFile }),
        }),
        thinkingOnlySse({ messageId: 'msg_thinking_no_terminal', stopReason: 'end_turn' }),
        TEXT_ANSWER_SSE,
      ])
      const home = freshHome(root2, projectDir)
      const result = await runOcc(
        ['-p', 'say something visible'],
        baseEnv(endpoint2, home, projectDir), // CLAUDE_CODE_TERMINAL_MCP_TOOLS: ''
        60_000,
      )
      expect(result.code).toBe(0)
      const bodies = endpoint2.bodies()
      expect(bodies).toHaveLength(3)
      expect(lastMessageLastTextBlock(bodies[2]!)).toBe(THINKING_ONLY_NUDGE_TEXT)
    } finally {
      await endpoint2.close()
      rmSync(root2, { recursive: true, force: true })
    }
  }, 180_000)

  test('probe-d (StructuredOutput exclusion): a turn that already called StructuredOutput never nudges', async () => {
    // Official `ie` walk-back: structured-output turns end without visible
    // text BY DESIGN (the answer rides in the tool input), so after a
    // successful StructuredOutput call in the current turn the nudge must
    // stay silent. Driven through the real --json-schema wiring (main.tsx
    // registers the SyntheticOutputTool for non-interactive sessions).
    // Mutation (delete `!isStructuredOutputTurn(...)`): a third request
    // carrying the nudge appears.
    const root = mkdtempSync(join(tmpdir(), 'occ-nudge283-pd-'))
    const endpoint = await startMockEndpoint([])
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      endpoint.replaceResponses([
        toolUseSse({
          messageId: 'msg_structured_out',
          toolUseId: 'toolu_probe_d',
          toolName: 'StructuredOutput',
          inputJson: JSON.stringify({ answer: '42' }),
        }),
        thinkingOnlySse({ messageId: 'msg_thinking_after_structured', stopReason: 'end_turn' }),
      ])
      const home = freshHome(root, projectDir)
      const result = await runOcc(
        [
          '-p',
          'say something visible',
          '--json-schema',
          JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          }),
        ],
        baseEnv(endpoint, home, projectDir),
        60_000,
      )
      expect(result.code).toBe(0)

      const bodies = endpoint.bodies()
      // initial + post-StructuredOutput continuation ONLY.
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toContain('tool_result')
      for (const body of bodies) {
        expect(body).not.toContain(THINKING_ONLY_NUDGE_TEXT)
      }
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
