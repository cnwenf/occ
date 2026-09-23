import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * OCC-134 acceptance round (E2E PROBE-4) wiring regression.
 *
 * Official Claude Code 2.1.280 keeps `/fast` visible in EVERY environment —
 * including custom `ANTHROPIC_BASE_URL` gateways and 3P providers — and
 * explains unavailability through the `FastModePicker` panel
 * (`getFastModeUnavailableReason()` reason strings) instead of answering
 * "Unknown command: /fast".
 *
 * OCC previously declared `availability: ['claude-ai','console']` on the fast
 * command, an OCC-invented visibility layer that filtered it out of
 * `getCommands()` via `meetsAvailabilityRequirement()` before dispatch. The
 * fix deletes that line; this test pins the registration at the production
 * entry (`getCommands()`) in a non-first-party environment, so re-adding any
 * `availability` gate to the fast command fails here.
 *
 * Isolation: each probe runs `bun -e` in a subprocess with a clean
 * CLAUDE_CONFIG_DIR (no OAuth tokens on disk → `isClaudeAISubscriber()`
 * false) and API-key auth, mirroring the commands-alignment e2e pattern.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const COMMANDS_TS = join(REPO_ROOT, 'src', 'commands.ts')

async function registeredCommandNames(
  env: Record<string, string>,
): Promise<string[]> {
  const script = `
const { getCommands } = await import(${JSON.stringify(COMMANDS_TS)});
const names = (await getCommands(${JSON.stringify(REPO_ROOT)})).map(c => c.name).filter(Boolean);
console.log(JSON.stringify(names));
`
  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`bun -e probe exited ${exitCode}: ${stderr}`)
  }
  return JSON.parse(stdout.trim()) as string[]
}

function gatewayEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDE_CODE_DISABLE_FAST_MODE') {
      env[key] = value
    }
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    ANTHROPIC_API_KEY: 'dummy-key-for-registration-probe',
    // Keep 3P provider switches off so the environment is exactly the
    // PROBE-4 case: API-key auth against a custom (non-first-party) base URL.
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
  }
}

describe('OCC-134 PROBE-4: /fast registration in non-first-party environments', () => {
  test('getCommands() includes fast under a custom ANTHROPIC_BASE_URL gateway', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'occ-fast-probe-'))
    try {
      const names = await registeredCommandNames(gatewayEnv(configDir))
      expect(names).toContain('fast')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('negative control: an availability-gated command IS filtered in the same env', async () => {
    // /upgrade declares availability: ['claude-ai']; with a clean config dir
    // (no OAuth) and a custom base URL it must NOT register. If this ever
    // passes vacuously (gate broken for everyone), the fast assertion above
    // would be meaningless — this pins that the gate is live and fast is
    // exempt because it no longer declares availability.
    const configDir = mkdtempSync(join(tmpdir(), 'occ-fast-probe-'))
    try {
      const names = await registeredCommandNames(gatewayEnv(configDir))
      expect(names).not.toContain('upgrade')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('fast command declaration carries no availability gate', async () => {
    const fast = (await import('../index.js')).default
    expect(fast.name).toBe('fast')
    expect((fast as { availability?: unknown }).availability).toBeUndefined()
  })
})
