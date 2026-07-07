import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

async function src(path: string): Promise<string> {
  return Bun.file(`${REPO_ROOT}/${path}`).text()
}

// F6-F22 config/settings/env gaps (agent=fconfig). Each test greps OCC source
// for the exact behavior/wording added to match the official 2.1.200 binary.

describe('2.1.200 fconfig gaps (settings + env vars)', () => {
  test('F6 (2.1.143): worktree.bgIsolation enum includes "worktree" and "none"', async () => {
    const types = await src('src/utils/settings/types.ts')
    // Binary: bgIsolation:A.enum(["worktree","none"]).optional()
    expect(types).toContain(".enum(['worktree', 'none'])")
    // The old single-value enum (.enum(['none'])) must be gone.
    expect(types).not.toContain(".enum(['none'])")
  })

  test('F7 (2.1.139): CLAUDE_CODE_DISABLE_AGENT_VIEW env var + disableAgentView setting', async () => {
    const types = await src('src/utils/settings/types.ts')
    const settings = await src('src/utils/settings/settings.ts')
    // Setting in schema, with the binary's "Equivalent to ..." wording.
    expect(types).toContain('disableAgentView')
    expect(types).toContain('Equivalent to CLAUDE_CODE_DISABLE_AGENT_VIEW=1.')
    // Env var read in the reason helper (mirrors official vto()).
    expect(settings).toContain('process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW')
    expect(settings).toContain(
      'is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW',
    )
    // Setting check returns the managed-settings reason string.
    expect(settings).toContain('disableAgentView setting')
  })

  test('F8 (2.1.98): CLAUDE_CODE_SCRIPT_CAPS per-session script-invocation limit', async () => {
    const settings = await src('src/utils/settings/settings.ts')
    // Env var read + JSON-parsed, finite-number filter (mirrors official bga()).
    expect(settings).toContain('process.env.CLAUDE_CODE_SCRIPT_CAPS')
    expect(settings).toContain('Number.isFinite(')
    expect(settings).toMatch(/getScriptCaps/)
  })

  test('F16 (2.1.169): API_FORCE_IDLE_TIMEOUT Vertex/Foundry stalled-stream abort', async () => {
    const claude = await src('src/services/api/claude.ts')
    // Env var read in the API client (mirrors official Ag(e)).
    expect(claude).toContain('process.env.API_FORCE_IDLE_TIMEOUT')
    // Force-idle-timeout disables the SDK request timeout so the idle
    // watchdog owns the abort.
    expect(claude).toContain('getApiForceIdleTimeout()')
    expect(claude).toContain('timeout: false')
  })

  test('F19 (2.1.169): sandbox.allowAppleEvents setting', async () => {
    const sandboxTypes = await src('src/entrypoints/sandboxTypes.ts')
    const settings = await src('src/utils/settings/settings.ts')
    // Binary: allowAppleEvents:A.boolean().optional().describe("macOS only: Allow sandboxed commands to send Apple Event...")
    expect(sandboxTypes).toContain('allowAppleEvents')
    expect(sandboxTypes).toContain('Apple Events')
    // Binary lists allowAppleEvents in the sandbox managed-keys set.
    expect(settings).toContain("'allowAppleEvents'")
  })

  test('F20 (2.1.183): attribution.sessionUrl setting (omit claude.ai session link)', async () => {
    const types = await src('src/utils/settings/types.ts')
    const attribution = await src('src/utils/attribution.ts')
    // Binary: sessionUrl:A.boolean().optional().describe("Whether to append the claude.ai session link to commits...")
    expect(types).toContain('sessionUrl')
    expect(types).toContain('claude.ai session link')
    // Binary guard: if(Rr().attribution?.sessionUrl===!1)return null
    expect(attribution).toContain('attribution?.sessionUrl === false')
    expect(attribution).toMatch(/getSessionAttributionUrl/)
  })

  test('F21 (2.1.181): CLAUDE_CLIENT_PRESENCE_FILE env var', async () => {
    const settings = await src('src/utils/settings/settings.ts')
    // Env var read + file-stat presence check (mirrors official qDm()).
    expect(settings).toContain('process.env.CLAUDE_CLIENT_PRESENCE_FILE')
    expect(settings).toMatch(/isClientPresenceFileActive/)
  })

  test('F22 (cross): teammateMode config enum includes "iterm2"', async () => {
    const config = await src('src/utils/config.ts')
    // Binary: J$s=["auto","tmux","iterm2","in-process"]
    expect(config).toContain("'iterm2'")
    expect(config).toMatch(/teammateMode\?.*'auto' \| 'tmux' \| 'iterm2' \| 'in-process'/)
  })
})
