import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const THINKING_ONLY_SSE = sse([
  { event: 'message_start', data: messageStart('msg_thinking_only') },
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
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
])

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
 * once exhausted, repeats the last entry (a test that expects exactly N
 * calls asserts the body count separately).
 */
function startMockEndpoint(responses: string[]): Promise<MockEndpoint> {
  const bodies: string[] = []
  let messageCalls = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let payload = THINKING_ONLY_SSE
      if (req.method === 'POST' && req.url?.includes('/v1/messages')) {
        bodies.push(body)
        payload =
          responses[Math.min(messageCalls, responses.length - 1)] ??
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
      // as a user message.
      const last = retryMessages.at(-1)
      expect(last?.role).toBe('user')
      expect(JSON.stringify(last?.content)).toContain(
        '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
      )
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
})
