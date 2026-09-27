import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOcc } from './helpers'

/**
 * CC 2.1.283 — managed model governance STARTUP GATE (official call site
 * @212235442, byte-extracted from the linux-x64 ELF, never executed):
 *
 *   `Bn=TH(je);if(Bn!==null)return hx(Bn),await Az({sessionId:Y(),
 *    message:Bn,reason:"managed_settings_invalid"}),$i();`
 *
 * `je` is the resolved initial model straight out of the startup resolver, so
 * the gate covers BOTH the user-specified model and the zero-config tier
 * default. Observable contract: red block message on stderr (`hx`) then
 * exit(1) (`$i` → `nn`); the `Az` exit-reason telemetry stays PORT-NEXT.
 *
 * OCC-98 acceptance #10 (P2) reproducer for the confirmed HIGH fail-open: a
 * DENY-ONLY policy (`deniedModels` without `availableModels` /
 * `enforceAvailableModels`) plus ZERO user model config previously resolved
 * the tier default without ever consulting the deny oracle, and the CLI
 * started normally against the wire. Post-fix, the built CLI must refuse to
 * start (exit 1, official message, no wire request); a deny policy that does
 * not match the default must start clean (negative control).
 *
 * Managed settings are injected via `CLAUDE_CODE_MANAGED_SETTINGS_PATH`
 * (ant-gated env override in src/utils/settings/managedPath.ts — the same
 * real-file loader path production uses; first e2e to exercise it).
 * Wire-level mock endpoint pattern from version-2.1.283-system-prompt-merge.
 */

const SSE_BODY = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_mg283',
      type: 'message',
      role: 'assistant',
      model: 'claude-mg283-mock',
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
  requests: () => string[]
  close: () => Promise<void>
}

function startMockEndpoint(): Promise<MockEndpoint> {
  const received: string[] = []
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
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
        requests: () => [...requests],
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
      userID: 'occ-mg283-0000000000000000000000000000000000000001',
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

/** Write the managed-settings.json the production loader reads. */
function managedSettingsDir(root: string, policy: Record<string, unknown>): string {
  const dir = join(root, 'managed')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'managed-settings.json'), JSON.stringify(policy))
  return dir
}

function baseEnv(
  endpoint: MockEndpoint,
  home: string,
  projectDir: string,
  managedDir: string,
): Record<string, string> {
  return {
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: 'occ-mg283-key',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
    // ZERO user model config — the runner host may export model overrides
    // (this very dev box sets ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*); blank
    // them so the tier default resolves from the binary, not the shell.
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    // Managed-settings env override is ant-gated (src/utils/settings/managedPath.ts).
    USER_TYPE: 'ant',
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: managedDir,
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_UNATTENDED_RETRY: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

// Constructed RegExp, not a literal — keeps biome's
// noControlCharactersInRegex off an intentional ANSI-color strip.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')
const stripAnsi = (value: string): string => value.replace(ANSI_RE, '')

const SHARED_TAIL =
  ', and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".'

describe('2.1.283 managed model governance startup gate (OCC-98 #10 deny-only default-path closure)', () => {
  test('deny-only policy + zero user model config: exit 1, official block message, NO wire request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-mg283-gate-'))
    const endpoint = await startMockEndpoint()
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir)
      const managedDir = managedSettingsDir(root, {
        // The confirmed fail-open shape: ONLY deniedModels — no
        // availableModels, no enforceAvailableModels.
        deniedModels: ['opus', 'sonnet', 'haiku', 'fable'],
      })
      const result = await runOcc(
        ['-p', 'say hi'],
        baseEnv(endpoint, home, projectDir, managedDir),
        60_000,
      )
      expect(result.code).toBe(1)
      const stderr = stripAnsi(result.stderr)
      expect(stderr).toContain(
        "Claude Code can't start: your organization's managed settings block the default model",
      )
      expect(stderr).toContain('in "deniedModels"')
      expect(stderr).toContain(SHARED_TAIL)
      // The gate fires BEFORE any inference traffic — fail-closed, not
      // fail-late. (Bodyless GET/HEAD startup probes — connectivity/auth —
      // may precede the gate and are not model traffic.)
      const messageCalls = endpoint
        .requests()
        .filter(r => r.includes('/v1/messages'))
      expect(messageCalls).toHaveLength(0)
      expect(endpoint.bodies().filter(b => b !== '')).toHaveLength(0)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('negative control: deny policy not matching the default starts clean and reaches the wire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-mg283-ctrl-'))
    const endpoint = await startMockEndpoint()
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })
      const home = freshHome(root, projectDir)
      const managedDir = managedSettingsDir(root, {
        deniedModels: ['my-custom-model'], // literal entry; never matches
      })
      const result = await runOcc(
        ['-p', 'say hi'],
        baseEnv(endpoint, home, projectDir, managedDir),
        60_000,
      )
      expect(result.code).toBe(0)
      const stderr = stripAnsi(result.stderr)
      expect(stderr).not.toContain("Claude Code can't start")
      const messageCalls = endpoint
        .requests()
        .filter(r => r.includes('/v1/messages'))
      expect(messageCalls.length).toBeGreaterThan(0)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
