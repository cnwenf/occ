import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// WebFetchTool transitively pulls in the fetch path which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx). Mirror that polyfill so the
// module imports cleanly under `bun test`.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../../utils/settings/settingsCache.js'
import { WEB_FETCH_TOOL_NAME } from '../prompt.js'

/**
 * CC 2.1.285 (item-B1): CLAUDE_CODE_DISABLE_WEB_FETCH kill-switch on
 * WebFetchTool.isEnabled.
 *
 * Official v285 `isEnabled(){return!a.CLAUDE_CODE_DISABLE_WEB_FETCH&&Yt(wye)}`
 * (@204286795) added the env gate that v284 lacked (0 hits for the var in v284,
 * 9 in v285). `Yt(wye)` is the official `allow_web_fetch` managed-policy check
 * (contract-002 — ported via the policySettings source, covered in
 * allowWebFetchPolicy285.test.ts). When the env var is truthy the tool is
 * removed from the tool list entirely — pinned at the registry level below
 * (test-08) through the real `getToolsForDefaultPreset()`.
 */

const { WebFetchTool } = await import('../WebFetchTool.js')

const ENV_KEY = 'CLAUDE_CODE_DISABLE_WEB_FETCH'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe('CC 2.1.285 item-B1: WebFetchTool.isEnabled honors CLAUDE_CODE_DISABLE_WEB_FETCH', () => {
  test('env unset → enabled (prior v284 behavior preserved)', () => {
    delete process.env[ENV_KEY]
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="1" → disabled', () => {
    process.env[ENV_KEY] = '1'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="true" → disabled', () => {
    process.env[ENV_KEY] = 'true'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="yes" → disabled (isEnvTruthy alias)', () => {
    process.env[ENV_KEY] = 'yes'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="on" → disabled (isEnvTruthy alias)', () => {
    process.env[ENV_KEY] = 'on'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="0" → enabled (falsy value does not disable)', () => {
    process.env[ENV_KEY] = '0'
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="" → enabled (empty string is falsy)', () => {
    process.env[ENV_KEY] = ''
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="false" → enabled (non-truthy string)', () => {
    process.env[ENV_KEY] = 'false'
    expect(WebFetchTool.isEnabled()).toBe(true)
  })
})

/**
 * CC 2.1.285 (test-08): registry-level coverage — the kill-switch must remove
 * WebFetch from the tool list handed to the model, not just flip isEnabled().
 * Calls the real `getToolsForDefaultPreset()` (src/tools.ts), which maps
 * `tool.isEnabled()` over `getAllBaseTools()` and filters; no filter logic is
 * reimplemented here. The policySettings slot is seeded through the settings
 * cache's own public API (`setCachedSettingsForSource`) so a real host
 * `/etc/claude-code/managed-settings.json` cannot flip the contract-002
 * `allow_web_fetch` conjunct underneath these assertions (the real-file
 * loader→cache→isEnabled chain is covered in allowWebFetchPolicy285.test.ts).
 * USER_TYPE=ant is deliberately NOT used: it trips an unrelated latent
 * `resolveAntModel` ReferenceError in model.ts's ant-only branch under the
 * registry's getAllBaseTools() walk.
 */
describe('CC 2.1.285 test-08: getToolsForDefaultPreset() registry-level kill-switch', () => {
  beforeEach(() => {
    // Cached "no policy settings on this machine" (null = cache hit, not a
    // miss): allow_web_fetch reads as unset → default-allow.
    resetSettingsCache()
    setCachedSettingsForSource('policySettings', null)
  })

  afterEach(() => {
    resetSettingsCache()
  })

  test('CLAUDE_CODE_DISABLE_WEB_FETCH="1" → WebFetch excluded from the default preset', async () => {
    process.env[ENV_KEY] = '1'
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).not.toContain(WEB_FETCH_TOOL_NAME)
  })

  test('kill-switch unset → WebFetch included in the default preset', async () => {
    delete process.env[ENV_KEY]
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).toContain(WEB_FETCH_TOOL_NAME)
  })

  test("managed allow_web_fetch:false → WebFetch excluded even with the env kill-switch unset (registry sees the policy conjunct)", async () => {
    delete process.env[ENV_KEY]
    setCachedSettingsForSource('policySettings', { allow_web_fetch: false })
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).not.toContain(WEB_FETCH_TOOL_NAME)
  })
})
