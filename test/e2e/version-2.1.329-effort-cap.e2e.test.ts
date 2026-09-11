import { describe, expect, test } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, runOcc } from './helpers'

/**
 * OCC-82 (official 2.1.266 → 2.1.267) — settings-side effort cap e2e.
 *
 * Real behavioral coverage of the five trigger-mandated points, driving the
 * BUILT dist/cli.js end-to-end:
 *
 *   ① REPL (tmux): with userSettings maxEffortLevel="high", the /effort
 *      argumentHint renders [low|medium|high|auto], choosing xhigh prints the
 *      byte-verified clamp message ("exceeds the cap … (this session only)")
 *      and NOTHING is persisted to settings.json.
 *   ② headless -p wire: a modelSettings cap keyed by a Bedrock spelling
 *      ("us.anthropic.claude-opus-4-7-v1:0") applies to the canonical model
 *      via getCanonicalName (Bhe) normalization.
 *   ③ headless -p wire: a per-model "max" entry EXEMPTS the model from that
 *      file's top-level cap (xhigh passes through unclamped).
 *   ④ headless -p wire: two settings files (user high, project medium) →
 *      the lowest cap wins.
 *   ⑦ headless -p wire: an effort injected via CLAUDE_CODE_EXTRA_BODY
 *      output_config is NEVER clamped for an effort-capable model (official
 *      JCs second gate `'effort' in n → return`), while the control run
 *      without EXTRA_BODY clamps --effort xhigh to the cap.
 *
 * Review round 2 (tag-hold candidates), tmux REPL block:
 *
 *   ⑤ runtime-3 display clamp: cap 'high' on claude-sonnet-5 + launch
 *      `--effort xhigh` — the wire clamps (pre-existing) AND every display
 *      surface now shows the clamped level (logo suffix "with high effort",
 *      status chip, `/effort` current-level), matching the official 2.1.267
 *      binary empirically (suffix rendered via wtt/kE, /effort picker parked
 *      at the cap).
 *   ⑥ test-f3 ModelPicker: with a cap on claude-opus-4-7, focusing its row
 *      renders the "Higher effort levels are capped" note (`focusedCapped`),
 *      and selecting it with a stale over-cap xhigh persists the CLAMPED
 *      effortLevel='high' (clampEffortToCap before updateSettingsForSource).
 *
 * The wire tests capture the outgoing request body at a local mock Anthropic
 * endpoint (same pattern as resume-interrupted-turn-221.e2e.test.ts) and
 * assert on `output_config.effort` — the actual API-side enforcement point.
 * They need only a built dist/cli.js + the local mock (fake key, temp HOME),
 * so they run in CI too (review P3: CI skip removed). The tmux REPL block (①)
 * stays gated out of CI (needs tmux).
 */

const REQUEST_MODEL = 'claude-opus-4-7'

// Minimal Anthropic streaming response that cleanly ends the turn.
const SSE_BODY = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_occ82',
      type: 'message',
      role: 'assistant',
      model: 'claude-occ82-mock',
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

interface MockEndpoint {
  port: number
  bodies: () => string[]
  close: () => Promise<void>
}

function startMockEndpoint(): Promise<MockEndpoint> {
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

/** Fresh temp HOME seeded past onboarding/trust, with the given user settings. */
function freshHome(root: string, projectDir: string, userSettings: Record<string, unknown>): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-09-11T00:00:00.000Z',
      migrationVersion: 11,
      userID: 'occ-effort-cap-000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.267',
      lastReleaseNotesSeen: '2.1.267',
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true, ...userSettings }),
  )
  return home
}

function baseEnv(endpoint: MockEndpoint, home: string, projectDir: string): Record<string, string> {
  return {
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: 'occ-effort-cap-key',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
    ANTHROPIC_MODEL: REQUEST_MODEL,
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_UNATTENDED_RETRY: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/** Run `occ -p <args> "hi"` and return the effort param of the first captured request. */
async function captureWireEffort(
  endpoint: MockEndpoint,
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; effort: unknown }> {
  const before = endpoint.bodies().length
  const result = await runOcc(['-p', ...args, 'hi'], env, 90_000)
  const bodies = endpoint.bodies().slice(before)
  for (const raw of bodies) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && 'model' in parsed) {
        return { code: result.code, effort: parsed.output_config?.effort }
      }
    } catch {
      // Non-JSON body (shouldn't happen) — keep scanning.
    }
  }
  return { code: result.code, effort: undefined }
}

describe(
  'OCC-82 (2.1.267) settings-side effort cap — headless wire e2e (②③④⑦)',
  () => {
    test('⑦ CLAUDE_CODE_EXTRA_BODY effort is NOT clamped; control run clamps --effort to the cap', async () => {
      const endpoint = await startMockEndpoint()
      const root = mkdtempSync(join(tmpdir(), 'occ-cap7-'))
      const projectDir = join(root, 'proj')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir, { maxEffortLevel: 'high' })
      const env = baseEnv(endpoint, home, projectDir)
      try {
        // Control: --effort xhigh under cap=high → the API request carries the
        // clamped value (kE clamp on the real enforcement point).
        const control = await captureWireEffort(endpoint, env, ['--effort', 'xhigh'])
        expect(control.code).toBe(0)
        expect(control.effort).toBe('high')

        // ⑦: EXTRA_BODY-injected output_config.effort wins unclamped (official
        // JCs: `'effort' in outputConfig` → early return, no cap applied).
        const injected = await captureWireEffort(
          endpoint,
          {
            ...env,
            CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ output_config: { effort: 'xhigh' } }),
          },
          ['--effort', 'high'],
        )
        expect(injected.code).toBe(0)
        expect(injected.effort).toBe('xhigh')
      } finally {
        await endpoint.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 180_000)

    test('③ per-model "max" exempts the model from the file top-level cap', async () => {
      const root = mkdtempSync(join(tmpdir(), 'occ-cap3-'))
      const projectDir = join(root, 'proj')
      mkdirSync(projectDir, { recursive: true })
      const endpoint = await startMockEndpoint()
      try {
        const home = freshHome(root, projectDir, {
          maxEffortLevel: 'medium',
          modelSettings: { [REQUEST_MODEL]: { maxEffortLevel: 'max' } },
        })
        const exempt = await captureWireEffort(endpoint, baseEnv(endpoint, home, projectDir), [
          '--effort',
          'xhigh',
        ])
        expect(exempt.code).toBe(0)
        expect(exempt.effort).toBe('xhigh')

        // Control: without the per-model exemption the top-level cap clamps.
        writeFileSync(
          join(home, '.claude', 'settings.json'),
          JSON.stringify({ disableAllHooks: true, maxEffortLevel: 'medium' }),
        )
        const capped = await captureWireEffort(endpoint, baseEnv(endpoint, home, projectDir), [
          '--effort',
          'xhigh',
        ])
        expect(capped.code).toBe(0)
        expect(capped.effort).toBe('medium')
      } finally {
        await endpoint.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 180_000)

    test('④ two settings files: the lowest cap wins (user high, project medium → medium)', async () => {
      const endpoint = await startMockEndpoint()
      const root = mkdtempSync(join(tmpdir(), 'occ-cap4-'))
      const projectDir = join(root, 'proj')
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      const home = freshHome(root, projectDir, { maxEffortLevel: 'high' })
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ maxEffortLevel: 'medium' }),
      )
      const env = baseEnv(endpoint, home, projectDir)
      try {
        const result = await captureWireEffort(endpoint, env, ['--effort', 'high'])
        expect(result.code).toBe(0)
        expect(result.effort).toBe('medium')
      } finally {
        await endpoint.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 180_000)

    test('② a Bedrock-spelled modelSettings cap key applies to the canonical request model', async () => {
      const endpoint = await startMockEndpoint()
      const root = mkdtempSync(join(tmpdir(), 'occ-cap2-'))
      const projectDir = join(root, 'proj')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir, {
        modelSettings: { 'us.anthropic.claude-opus-4-7-v1:0': { maxEffortLevel: 'medium' } },
      })
      const env = baseEnv(endpoint, home, projectDir)
      try {
        const result = await captureWireEffort(endpoint, env, ['--effort', 'high'])
        expect(result.code).toBe(0)
        // The request model is the plain canonical name; the settings key is
        // the Bedrock spelling — Bhe/getCanonicalName normalization must make
        // the per-model cap apply anyway.
        expect(result.effort).toBe('medium')
      } finally {
        await endpoint.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 180_000)
  },
)

// ---------- ① REPL (tmux) ----------

const SESSION = 'occ-effort-cap-repl'
const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return ''
  }
}

interface ReplOptions {
  /** Extra env for the REPL process; an explicit `undefined` value REMOVES an inherited var. */
  extraEnv?: Record<string, string | undefined>
  extraArgs?: string[]
}

function startRepl(home: string, opts: ReplOptions = {}) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    ...opts.extraEnv,
  }
  const envStr = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(' ')
  const args = ['--dangerously-skip-permissions', ...(opts.extraArgs ?? [])].join(' ')
  execSync(
    `tmux new-session -d -s ${SESSION} -x 220 -y 60 "env ${envStr} bun ${BIN} ${args}"`,
    { timeout: 5_000 },
  )
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
}

/** Send a literal string (may contain spaces) as one send-keys argument. */
function sendLiteral(text: string) {
  tmux(['send-keys', '-t', SESSION, '-l', text])
}

function sendKey(key: string) {
  tmux(['send-keys', '-t', SESSION, key])
}

function capturePane(): string {
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-'])
}

async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (capturePane().toLowerCase().includes(substr.toLowerCase())) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

/** Same onboarding-skip seed as repl-interactive.e2e.test.ts, plus custom user settings. */
function replHomeWith(userSettings: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'occ-cap-repl-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const apiKey = process.env.ANTHROPIC_API_KEY
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: '2026-09-11T00:00:00.000Z',
    migrationVersion: 11,
    userID: 'occ-cap-repl-00000000000000000000000000000000000000000000aa',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.267',
    lastReleaseNotesSeen: '2.1.267',
    projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
  }
  if (apiKey && apiKey.length >= 20) {
    config.customApiKeyResponses = { approved: [apiKey.slice(-20)], rejected: [] }
  }
  writeFileSync(join(home, '.claude.json'), JSON.stringify(config))
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableAllHooks: true,
      ...userSettings,
    }),
  )
  return home
}

/** Same onboarding-skip seed as repl-interactive.e2e.test.ts, plus the cap. */
function replHome(): string {
  return replHomeWith({ maxEffortLevel: 'high' })
}

/**
 * Env that points the REPL at the local mock SSE endpoint with an explicit
 * model roster (same shape as the review-round probes). `undefined` values
 * REMOVE an inherited var (notably CLAUDE_CODE_EFFORT_LEVEL).
 */
function mockModelEnv(endpoint: MockEndpoint): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'occ-effort-cap-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
    ANTHROPIC_MODEL: 'claude-sonnet-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-6-x',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_EFFORT_LEVEL: undefined,
  }
}

/** Wait until the mock endpoint has captured more than `count` bodies; return the newest. */
async function waitForWireBody(
  endpoint: MockEndpoint,
  count: number,
  timeoutMs = 20_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bodies = endpoint.bodies()
    if (bodies.length > count) return bodies[bodies.length - 1]
    await new Promise(r => setTimeout(r, 200))
  }
  return undefined
}

describe.skipIf(!!process.env.CI || !tmuxAvailable())(
  'OCC-82 (2.1.267) settings-side effort cap — REPL tmux e2e (①⑤⑥)',
  () => {
    test('① capped argumentHint + clamp message + no settings write', async () => {
      const home = replHome()
      startRepl(home)
      try {
        expect(await waitForText('shift+tab', 30_000)).toBe(true)

        // argumentHint renders cap-filtered: [low|medium|high|auto] — no
        // xhigh/max/ultracode under maxEffortLevel="high". The hint only
        // renders with exactly one trailing space after the command (same
        // typeahead rule as the official), so send "/effort ".
        sendLiteral('/effort ')
        expect(await waitForText('[low|medium|high|auto]', 10_000)).toBe(true)
        const hintPane = capturePane()
        expect(hintPane).not.toContain('xhigh|')
        expect(hintPane).not.toContain('|ultracode')

        // Choosing xhigh prints the byte-verified clamp message and is
        // session-only (official U: persist skipped when clamped).
        sendLiteral('xhigh')
        sendKey('Enter')
        expect(await waitForText('exceeds the cap', 10_000)).toBe(true)
        const pane = capturePane()
        expect(pane).toContain("Effort 'xhigh' exceeds the cap")
        expect(pane).toContain("(this session only)")
        expect(pane).toContain("set to 'high' instead")

        // No effortLevel was written to any settings file.
        const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
        expect(settings.effortLevel).toBeUndefined()
        expect(settings.maxEffortLevel).toBe('high')
      } finally {
        killRepl()
        rmSync(home, { recursive: true, force: true })
      }
    }, 120_000)

    test('⑤ runtime-3: display surfaces show the CLAMPED level (banner / chip / /effort) and the wire clamps', async () => {
      const endpoint = await startMockEndpoint()
      const home = replHomeWith({
        modelSettings: { 'claude-sonnet-5': { maxEffortLevel: 'high' } },
      })
      startRepl(home, {
        extraEnv: mockModelEnv(endpoint),
        extraArgs: ['--effort', 'xhigh'],
      })
      try {
        expect(await waitForText('shift+tab', 30_000)).toBe(true)
        const startup = capturePane()
        // The Eur startup warning still names the raw over-cap attempt...
        expect(startup).toContain("Effort 'xhigh' exceeds the cap")
        // ...but every DISPLAY surface renders the clamped level. Official
        // 2.1.267 renders the logo suffix via wtt (kE-clamped) and its /effort
        // picker parks at the cap — empirically verified against the real
        // binary (cap 'high' on claude-sonnet-5, launch `--effort xhigh` →
        // "Sonnet 5 with high effort", chip at high, slider at high).
        expect(startup).toContain('with high effort')
        expect(startup).not.toContain('with xhigh effort')
        expect(startup).not.toContain('xhigh · /effort')

        // /effort current-level output displays the clamped value.
        sendLiteral('/effort')
        sendKey('Enter')
        expect(await waitForText('Current effort level: high', 10_000)).toBe(true)
        expect(capturePane()).not.toContain('Current effort level: xhigh')

        // The wire request clamps too (kE on the enforcement point), and the
        // status chip after the turn shows the clamped level.
        const before = endpoint.bodies().length
        sendLiteral('hi')
        sendKey('Enter')
        const raw = await waitForWireBody(endpoint, before)
        expect(raw).toBeDefined()
        const parsed = JSON.parse(raw as string)
        expect(parsed.output_config?.effort).toBe('high')
        expect(await waitForText('high · /effort', 15_000)).toBe(true)
        expect(capturePane()).not.toContain('xhigh · /effort')
      } finally {
        killRepl()
        await endpoint.close()
        rmSync(home, { recursive: true, force: true })
      }
    }, 180_000)

    test('⑥ test-f3: ModelPicker renders the capped note and clamps a stale over-cap effort before the settings write', async () => {
      const endpoint = await startMockEndpoint()
      const home = replHomeWith({
        modelSettings: { 'claude-opus-4-7': { maxEffortLevel: 'high' } },
      })
      startRepl(home, { extraEnv: mockModelEnv(endpoint) })
      try {
        expect(await waitForText('shift+tab', 30_000)).toBe(true)
        sendLiteral('/model')
        sendKey('Enter')
        expect(await waitForText('Select model', 15_000)).toBe(true)
        // Flow ported from the reviewer's verified probe: Up 4 → row 1 =
        // Default (Sonnet 5); Right → toggle xhigh (sonnet-5 is xhigh-capable
        // and NOT capped here); Down → the capped claude-opus-4-7 row, where
        // the focusedCapped note must render.
        for (let i = 0; i < 4; i++) {
          sendKey('Up')
          await new Promise(r => setTimeout(r, 150))
        }
        sendKey('Right')
        await new Promise(r => setTimeout(r, 300))
        sendKey('Down')
        expect(
          await waitForText(
            'Higher effort levels are capped by your settings or organization.',
            10_000,
          ),
        ).toBe(true)
        sendKey('Enter')
        // The picker clamps the stale over-cap xhigh to the cap before
        // persisting (official 2.1.267: ladder/note via dt(t)/wr, persist via
        // lF — clampEffortToCap before updateSettingsForSource).
        const settingsPath = join(home, '.claude', 'settings.json')
        let settings: Record<string, unknown> = {}
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
          if (settings.effortLevel !== undefined) break
          await new Promise(r => setTimeout(r, 200))
        }
        expect(settings.effortLevel).toBe('high')
        expect(['claude-opus-4-7', 'opus']).toContain(settings.model)
        // The /model confirmation shows the CLAMPED select effort (official
        // ns(Ki): the value handed to onSelect runs through lF).
        expect(await waitForText('with high effort', 10_000)).toBe(true)
        expect(capturePane()).not.toContain('with xhigh effort')
      } finally {
        killRepl()
        await endpoint.close()
        rmSync(home, { recursive: true, force: true })
      }
    }, 180_000)
  },
)
