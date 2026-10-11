import { describe, expect, test } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers'

/**
 * OCC-154 fix-round D-item (e2e-01 ≡ t-01) — ARTIFACT-LEVEL regression for
 * the scripts/build.ts hljs guard injection (Gap-289 #2 + CC 2.1.295 #091).
 *
 * Why this file exists: the onLoad injection in scripts/build.ts appends
 * `installHighlightBounds(...)` + `applyGrammarPatches(...)` calls to every
 * inlined `highlight.js/lib/index.js` copy. Deleting the injection block
 * keeps `bun run build` exit 0 and ALL existing unit/e2e suites green —
 * the only observable failure is in the BUILT ARTIFACT (验收员 probe:
 * markers 2→0). In dist the failure is real, not cosmetic:
 *
 *  - dist inlines TWO hljs generations — cli-highlight's highlight.js@10.7.3
 *    (the instance that actually renders terminal highlights; verified by
 *    byte offsets: injection site #1 sits inside the 10.7.3 block) and the
 *    root highlight.js@11.11.1.
 *  - src/utils/cliHighlight.ts bounds the @11 copy at runtime, but its
 *    anchored require of cli-highlight's @10 copy fails inside the bundle —
 *    the build injection is the ONLY bound on the @10 render instance.
 *  - With the injection no-op'd, a ```handlebars fence containing
 *    `<script>`×24 freezes the artifact's Ink render for >70 s (measured
 *    UNBOUNDED on hljs@10.7.3: `<script>`×20 = 13.1 s, ×24 exceeds a 70 s
 *    timeout; `handlebars` embeds xml as a subLanguage, so the cascade
 *    reproduces, and it DODGES cliHighlight.ts's html/xml/xhtml prefilter).
 *    With the injection, the same input throws HighlightBoundError in ~16 ms
 *    and withPlainFallback renders it as plain text.
 *
 * Two legs:
 *  1. Marker extraction from dist/cli.js (UNGATED — this is the CI-red
 *     guarantee: ci.yml builds dist before tests, so a release machine with
 *     a silently-dead injection fails here). Rename-tolerant markers:
 *     `.installHighlightBounds(module` matches both `module.exports` and
 *     bundler-renamed `module2.exports` forms, and does NOT match the two
 *     bare runtime calls in cliHighlight.ts (argument is a variable, not
 *     `module`). Expected count: exactly 2 (one per inlined hljs copy).
 *  2. Catastrophic input through the ARTIFACT RENDER PATH (tmux REPL +
 *     mock Anthropic SSE streaming the ```handlebars fence; skipIf(CI)
 *     like the sibling tmux e2e tests — needs tmux). The discriminating
 *     assertion is EVENT-LOOP RESPONSIVENESS, not pane text: Markdown.tsx
 *     paints the fence via the Suspense fallback (highlight=null → plain)
 *     BEFORE getCliHighlightPromise resolves, so the pane shows the raw
 *     `<script>` body at ~1 s in BOTH builds. The highlighted re-render
 *     then runs synchronously inside Ink: without the injection the
 *     unbounded hljs@10 cascade freezes the event loop (>70 s, measured:
 *     typed keys are never echoed), with the injection it throws
 *     HighlightBoundError (~16 ms), memoizes, re-renders plain, and the
 *     REPL stays responsive. So the pane assertions are: fence text paints
 *     within the bound (mutation RED mode A: the freeze can pre-empt the
 *     fallback flush), then a LATE keystroke canary echoes after a settle
 *     delay (mutation RED mode B: frozen loop never echoes; the early
 *     canary is deliberately unasserted — it can slip through the ~100 ms
 *     pre-freeze window and false-GREEN). FORCE_COLOR=1 is mandatory —
 *     without a color-capable env the artifact disables highlighting
 *     entirely and the freeze never triggers. Print mode (`-p`) never
 *     highlights, so the REPL is the only artifact surface that exercises
 *     the injected guards.
 *
 * Mutation-verify recipe: no-op the build.ts onLoad injection filter
 * (`/node_modules…/` → `/MUTATION_NOOP…/`) → `bun run build` → leg 1 goes
 * RED (markers 2→0) and leg 2 goes RED (canary never echoed — frozen
 * event loop); restore → rebuild → both GREEN. Both legs verified this
 * round against the mutated artifact.
 */

const DIST_CLI = process.env.OCC_ENTRYPOINT ?? join(REPO_ROOT, 'dist/cli.js')

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

describe('dist hljs injection — artifact markers (ungated CI-red gate)', () => {
  test('dist/cli.js carries both injected guard call sites per hljs copy', () => {
    // Arrange — the artifact must exist; ci.yml builds before testing
    // ("先构建再测试：e2e 测试会运行 dist/cli.js，需要产物已存在").
    expect(
      existsSync(DIST_CLI),
      `dist/cli.js not found at ${DIST_CLI} — run \`bun run build\` first`,
    ).toBe(true)
    const dist = readFileSync(DIST_CLI, 'utf8')

    // Act / Assert — injection-specific dot-call markers, rename-tolerant.
    // Mutation RED point: no-op the build.ts onLoad injection → both 2→0.
    expect(countOccurrences(dist, '.installHighlightBounds(module')).toBe(2)
    expect(countOccurrences(dist, '.applyGrammarPatches(module')).toBe(2)

    // Both hljs generations are actually inlined (the probe's hljsInline
    // leg): a tree-shaken/externalized hljs would silently void the guards.
    expect(countOccurrences(dist, 'hljs.registerLanguage')).toBeGreaterThanOrEqual(300)
  })
})

// ── Leg 2: catastrophic input through the artifact REPL render path ──

const SESSION = 'occ-dist-hljs-e2e'
const MOCK_KEY = 'sk-ant-mock-dist-hljs-injection'
// `<script>`×24 = 192 chars: UNBOUNDED hljs@10.7.3 handlebars cascade
// exceeds 70 s (×20 measured 13.1 s); BOUNDED throws in ~16 ms.
const ADVERSARIAL_FENCE =
  'Here is the block:\n```handlebars\n' + '<script>'.repeat(24) + '\n```\n'
// Generous vs the ~16 ms bounded path + REPL/stream overhead, far below the
// >70 s unbounded freeze.
const BOUND_MS = 30_000

function sseBody(): string {
  const events: Array<[string, unknown]> = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_dist_hljs',
        type: 'message',
        role: 'assistant',
        model: 'claude-mock',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ADVERSARIAL_FENCE },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function startMockEndpoint(): Promise<{
  port: number
  bodies: () => string[]
  close: () => Promise<void>
}> {
  const received: string[] = []
  const body = sseBody()
  const server: Server = createServer((req, res) => {
    let reqBody = ''
    req.on('data', chunk => (reqBody += chunk))
    req.on('end', () => {
      received.push(reqBody)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.end(body)
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

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return ''
  }
}

function seededHome(projectDir: string): string {
  const home = mkdtempSync(join(tmpdir(), 'occ-dist-hljs-home-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: '2026-07-06T00:00:00.000Z',
    migrationVersion: 11,
    userID: 'occ-dist-hljs-seed-00000000000000000000000000000000000000aa',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.200',
    lastReleaseNotesSeen: '2.1.200',
    projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    // Pre-approve the mock key's truncated form so the custom-API-key
    // dialog never blocks the REPL (same trick as repl-interactive).
    customApiKeyResponses: { approved: [MOCK_KEY.slice(-20)], rejected: [] },
  }
  writeFileSync(join(home, '.claude.json'), JSON.stringify(config))
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true, disableAllHooks: true }),
  )
  return home
}

function startRepl(home: string, projectDir: string, port: number): void {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
  // Full parent env (preserves sandbox vars for --dangerously-skip-permissions
  // under root) + overrides; later spread keys win.
  const envStr = Object.entries({
    ...process.env,
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: MOCK_KEY,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_MODEL: 'claude-mock',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_UNATTENDED_RETRY: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Color-capable env is MANDATORY: without it the artifact disables
    // syntax highlighting entirely (fences render plain, the hljs pipeline
    // never runs) and the freeze cannot be triggered. tmux panes here start
    // with no TERM/color support in the parent env.
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(' ')
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 -c '${projectDir}' "env ${envStr} ${DIST_CLI} --dangerously-skip-permissions"`,
    { timeout: 5_000 },
  )
}

function capturePane(): string {
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-'])
}

async function waitForText(substr: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (capturePane().includes(substr)) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

describe.skipIf(!!process.env.CI)(
  'dist hljs injection — catastrophic input through the artifact render path',
  () => {
    test(
      '```handlebars <script>x24 fence keeps the artifact REPL responsive (injected budget guard)',
      async () => {
        const projectDir = mkdtempSync(join(tmpdir(), 'occ-dist-hljs-proj-'))
        const home = seededHome(projectDir)
        const endpoint = await startMockEndpoint()
        try {
          startRepl(home, projectDir, endpoint.port)
          // REPL ready (footer hint rendered).
          const ready = await waitForText('shift+tab', 25_000)
          expect(ready).toBe(true)

          // Act — send a prompt; the mock streams back the adversarial fence.
          // The Markdown renderer routes it to cli-highlight → inlined
          // hljs@10.7.3 (bounded ONLY by the build injection in dist).
          tmux(['send-keys', '-t', SESSION, 'go'])
          tmux(['send-keys', '-t', SESSION, 'Enter'])

          // The fence body appears in the healthy build (bounded plain
          // fallback). Mutation RED mode A: WITHOUT the injection the
          // highlighted re-render can freeze the event loop BEFORE Ink
          // flushes the Suspense fallback frame — the fence never reaches
          // the pane and this wait times out (observed: 30 s, no paint).
          const rendered = await waitForText('<script><script><script>', BOUND_MS)
          expect(
            rendered,
            'adversarial handlebars fence never reached the pane within the bound — ' +
              'unbounded hljs@10.7.3 cascade froze Ink before the fallback paint ' +
              '(build injection dead?)',
          ).toBe(true)
          expect(endpoint.bodies().length).toBeGreaterThanOrEqual(1)

          // Assert — SUSTAINED event-loop responsiveness via keystroke
          // canaries. Race hardening (observed false-GREEN): a canary typed
          // immediately after the fallback paint can still be echoed in the
          // mutated build during the brief pre-freeze window (promise
          // resolution → frozen re-render starts ~100 ms later; the freeze
          // then lasts >70 s). So: canary #1 is sent but NOT asserted; after
          // a settle delay (freeze guaranteed in flight on the mutated
          // build, turn long finished on the healthy one) canary #2 must
          // echo. Healthy dist: HighlightBoundError (~16 ms) → memo → plain
          // re-render → both canaries echo. Mutation RED mode B: frozen →
          // canary #2 never echoes within BOUND_MS.
          const earlyCanary = 'CANARY_EARLY_HLJS154'
          const lateCanary = 'CANARY_LATE_HLJS154'
          tmux(['send-keys', '-t', SESSION, '-l', earlyCanary])
          await new Promise(r => setTimeout(r, 5_000))
          tmux(['send-keys', '-t', SESSION, '-l', lateCanary])
          const echoed = await waitForText(lateCanary, BOUND_MS)
          expect(
            echoed,
            'REPL event loop frozen after the adversarial fence — late keystroke ' +
              `canary never echoed within ${BOUND_MS} ms (unbounded hljs@10.7.3 ` +
              'cascade; build injection dead?)',
          ).toBe(true)
        } finally {
          execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
          await endpoint.close()
          rmSync(home, { recursive: true, force: true })
          rmSync(projectDir, { recursive: true, force: true })
        }
      },
      120_000,
    )
  },
)
