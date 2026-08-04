import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OCC_ARGS, OCC_BIN, REPO_ROOT } from './helpers'

/**
 * 2.1.221 (B) — `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0` must DISABLE
 * interrupted-turn auto-resume in the headless path (wiring test).
 *
 * OCC-44 changed `src/cli/print.ts` from a raw-string truthy check to
 * `isEnvTruthy(...)`. With the raw check, the non-empty string `"0"` was
 * truthy, so `=0` still auto-resumed (the exact bug the official 2.1.221
 * fixed). This e2e pins the WIRED behavior end-to-end through the real
 * `cli.tsx -p --resume` path against a mock Anthropic endpoint:
 *
 *   - An interrupted transcript (last turn-relevant message = a plain user
 *     prompt) is resumed via `-p --resume <file.jsonl>`.
 *   - The SDK `initialize` control request triggers the auto-resume drain
 *     (print.ts drains the pre-enqueued interrupted prompt after initialize).
 *   - With the env var `=1`, auto-resume re-enqueues the interrupted prompt
 *     → the model endpoint receives a request containing it.
 *   - With the env var `=0`, auto-resume is OFF → the model endpoint is never
 *     called (no request).
 *
 * Reverting `print.ts` to the pre-fix raw truthy check makes the `=0` case
 * send the prompt (reproducing the original bug) and fails this test.
 */

const MARKER = 'OCC44_INTERRUPTED_PROMPT_MARKER'

// Minimal Anthropic streaming response that cleanly ends the turn.
const SSE_BODY = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_occ44',
      type: 'message',
      role: 'assistant',
      model: 'claude-occ44-mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n')

function startMockEndpoint(): Promise<{
  port: number
  bodies: () => string[]
  close: () => Promise<void>
}> {
  const received: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      received.push(body)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.end(SSE_BODY)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        bodies: () => [...received],
        close: () =>
          new Promise<void>(res => {
            server.close(() => res())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function interruptedTranscriptPath(root: string): string {
  const sessionId = randomUUID()
  const msgUuid = randomUUID()
  const ts = new Date().toISOString()
  const line = {
    parentUuid: null,
    isSidechain: false,
    sessionId,
    uuid: msgUuid,
    timestamp: ts,
    type: 'user',
    message: { role: 'user', content: `${MARKER} please respond` },
  }
  const transcriptDir = join(root, 'transcript')
  mkdirSync(transcriptDir, { recursive: true })
  const path = join(transcriptDir, `${sessionId}.jsonl`)
  writeFileSync(path, `${JSON.stringify(line)}\n`)
  return path
}

function freshHome(root: string, projectDir: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-08-05T00:00:00.000Z',
      migrationVersion: 11,
      userID: 'occ-resume-turn-00000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.221',
      lastReleaseNotesSeen: '2.1.221',
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true }),
  )
  return home
}

/**
 * Run `occ -p --resume <transcript>` in stream-json mode, sending a single SDK
 * `initialize` control request on stdin (which triggers the auto-resume drain)
 * and then EOF. Returns the exit code.
 */
function runResume(
  transcript: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(OCC_BIN, [...OCC_ARGS, '-p', '--resume', transcript,
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      env: { ...process.env, ...env },
      cwd: env.OCC_CWD ?? REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
    const timer = setTimeout(() => {
      killGroup()
      finish(-1)
    }, timeoutMs)
    child.on('close', code => finish(code ?? -1))
    // Send the initialize control request, then close stdin so the input loop
    // reaches EOF and the process can exit after draining.
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'req_init_1',
        request: { subtype: 'initialize' },
      })}\n`,
    )
    child.stdin.end()
  })
}

describe.skipIf(!!process.env.CI)(
  '2.1.221 (B) — CLAUDE_CODE_RESUME_INTERRUPTED_TURN falsy honored (print -p --resume wiring)',
  () => {
    test(
      '=1 re-enqueues the interrupted prompt; =0 does not',
      async () => {
        const endpoint = await startMockEndpoint()
        const root = mkdtempSync(join(tmpdir(), 'occ-resume-turn-'))
        const projectDir = join(root, 'proj')
        mkdirSync(projectDir, { recursive: true })
        const home = freshHome(root, projectDir)
        const transcript = interruptedTranscriptPath(root)

        const baseEnv = {
          HOME: home,
          OCC_CWD: projectDir,
          ANTHROPIC_API_KEY: 'occ-resume-turn-key',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
          ANTHROPIC_MODEL: 'claude-occ44-mock',
          CLAUDE_CODE_MAX_RETRIES: '0',
          CLAUDE_CODE_UNATTENDED_RETRY: '0',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        }

        try {
          // Case =1: auto-resume enabled → the interrupted prompt reaches the
          // model endpoint.
          const code1 = await runResume(
            transcript,
            { ...baseEnv, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' },
            60_000,
          )
          const bodiesAfter1 = endpoint.bodies()
          expect(code1).not.toBe(-1)
          expect(
            bodiesAfter1.some(b => b.includes(MARKER)),
            'expected =1 to send the interrupted prompt to the model',
          ).toBe(true)

          // Case =0: auto-resume disabled → the interrupted prompt is NOT
          // sent (no model request). With the pre-fix raw truthy check, "0" is
          // truthy and this wrongly sends the prompt — reproducing the bug.
          const code0 = await runResume(
            transcript,
            { ...baseEnv, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '0' },
            60_000,
          )
          const bodiesAfter0 = endpoint.bodies().slice(bodiesAfter1.length)
          expect(code0).not.toBe(-1)
          expect(
            bodiesAfter0.some(b => b.includes(MARKER)),
            'expected =0 to NOT send the interrupted prompt to the model',
          ).toBe(false)
        } finally {
          await endpoint.close()
          rmSync(root, { recursive: true, force: true })
        }
      },
      150_000,
    )
  },
)
