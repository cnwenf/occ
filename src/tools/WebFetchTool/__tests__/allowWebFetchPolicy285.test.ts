import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WebFetchTool transitively pulls in the fetch path which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx). Mirror that polyfill so the
// module imports cleanly under `bun test` (same as disableWebFetch285.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { enableConfigs } from '../../../utils/config.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from '../../../utils/settings/managedPath.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import {
  getSettingsWithErrors,
  loadManagedFileSettings,
} from '../../../utils/settings/settings.js'
import { WEB_FETCH_TOOL_NAME } from '../prompt.js'

/**
 * PORT (CC 2.1.285, contract-002): the second conjunct of the official WebFetch
 * gate `isEnabled(){return!a.CLAUDE_CODE_DISABLE_WEB_FETCH&&Yt(wye)}`
 * (@34173852 new285; key literal `cFe="allow_web_fetch"` / `wye`).
 *
 * In the official binary `Yt(wye)` reads the server-populated org entitlement
 * `allow_web_fetch` (HIPAA-R3, `deniedUnder:["hipaa"]`, `onCacheMiss:"allow"` —
 * default ALLOW when unset; Monitor ws gate detail string: "arbitrary-URL
 * egress is disabled by your organization's policy"). OCC has no entitlement
 * subsystem, so the admin-controlled analog is the managed (policySettings)
 * source — the same surface `allowedProviders` enforcement consumes.
 *
 * Contract under test:
 *   isEnabled() = !process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
 *                 && policySettings.allow_web_fetch !== false
 * with the env conjunct being the official RAW NEGATION (any non-empty value
 * disables — pinned in disableWebFetch285.test.ts), default-true when the
 * policy key is unset, and ONLY the managed source honored (a user-level
 * value must neither disable nor RE-ENABLE against an org shutoff).
 *
 * Test architecture mirrors allowedProviders285.test.ts: zero mock.module,
 * zero top-level env mutation, ENV_KEYS window in beforeAll/afterAll, real
 * managed-file loader via USER_TYPE=ant + CLAUDE_CODE_MANAGED_SETTINGS_PATH,
 * lodash-memoize cache clears + resetSettingsCache around every test.
 */

const { WebFetchTool } = await import('../WebFetchTool.js')

const ENV_KEYS = [
  'USER_TYPE',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CONFIG_DIR',
  'NODE_ENV',
  'CI',
  'CLAUDE_CODE_DISABLE_WEB_FETCH',
] as const

let savedEnv: Record<string, string | undefined> = {}
let testRoot = ''
let managedDir = ''
let configDir = ''

const clearManagedPathCaches = (): void => {
  ;(getManagedFilePath as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    getManagedSettingsDropInDir as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

const resetAll = (): void => {
  resetSettingsCache()
}

/** Write the managed-settings.json and prime the settings caches like startup. */
const armManaged = (doc: Record<string, unknown>): void => {
  writeFileSync(
    join(managedDir, 'managed-settings.json'),
    JSON.stringify(doc),
    'utf8',
  )
  resetAll()
  getSettingsWithErrors()
}

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-awf-285-'))
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  enableConfigs()
})

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (key !== 'NODE_ENV' && key !== 'CI') {
      delete process.env[key]
    }
  }
  managedDir = mkdtempSync(join(testRoot, 'managed-'))
  configDir = mkdtempSync(join(testRoot, 'config-'))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  clearManagedPathCaches()
  resetAll()
})

afterEach(() => {
  resetAll()
  clearManagedPathCaches()
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetAll()
  clearManagedPathCaches()
  rmSync(testRoot, { recursive: true, force: true })
})

describe('CC 2.1.285 contract-002: WebFetchTool.isEnabled honors the managed allow_web_fetch policy (official Yt(wye) conjunct)', () => {
  test("managed {'allow_web_fetch': false} → isEnabled() === false (env unset)", () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    armManaged({ allow_web_fetch: false })
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test("managed {'allow_web_fetch': true} → env switch still governs (unset → enabled)", () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    armManaged({ allow_web_fetch: true })
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('managed key absent (empty policy doc) → default-allow (official onCacheMiss:"allow")', () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    armManaged({})
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('no managed file at all → default-allow', () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    resetAll()
    getSettingsWithErrors()
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env kill-switch + managed true → disabled (both conjuncts, official && semantics)', () => {
    process.env.CLAUDE_CODE_DISABLE_WEB_FETCH = '1'
    armManaged({ allow_web_fetch: true })
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env kill-switch + managed false → disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_WEB_FETCH = '1'
    armManaged({ allow_web_fetch: false })
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('user-level allow_web_fetch:false is NOT honored — managed (policy) source only', () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ allow_web_fetch: false }),
      'utf8',
    )
    resetAll()
    getSettingsWithErrors()
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('user-level allow_web_fetch:true cannot RE-ENABLE under a managed org shutoff (re-enable direction pinned)', () => {
    // OCC-103 R2 test-boundary note (a): the disable direction above must not
    // be the only pin — a merged-settings read (user source shadowing the
    // policy source) would pass that test yet wrongly re-enable here.
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ allow_web_fetch: true }),
      'utf8',
    )
    armManaged({ allow_web_fetch: false })
    expect(WebFetchTool.isEnabled()).toBe(false)
  })
})

describe('CC 2.1.285 contract-002: allow_web_fetch is a recognized boolean key in the strict policy parse', () => {
  test('valid boolean survives the real policySource parse with zero errors', () => {
    writeFileSync(
      join(managedDir, 'managed-settings.json'),
      JSON.stringify({ allow_web_fetch: false }),
      'utf8',
    )
    const { settings, errors } = loadManagedFileSettings()
    expect(settings?.allow_web_fetch).toBe(false)
    expect(errors).toEqual([])
  })

  test('non-boolean value is dropped with a warning record → reads as unset (default-allow)', () => {
    writeFileSync(
      join(managedDir, 'managed-settings.json'),
      JSON.stringify({ allow_web_fetch: 'no' }),
      'utf8',
    )
    const { settings, errors } = loadManagedFileSettings()
    expect(settings?.allow_web_fetch).toBeUndefined()
    expect(errors.length).toBe(1)
    expect(errors[0]?.path).toBe('allow_web_fetch')
    expect(errors[0]?.message).toContain('This field was ignored.')
  })
})

/**
 * OCC-103 R2 test-boundary note (c): the ant-profile registry+policy
 * combination, previously untestable under `bun test`.
 *
 * DECISION (documented per the review): model.ts's ant-only branch calls
 * `resolveAntModel` as a GLOBAL — installed at startup by cli.tsx's
 * USER_TYPE-gated dynamic import (Gap-133a/OCC-133), which defers antModels
 * module EVALUATION to ant runs and keeps the codename table DCE-strippable
 * from external builds. It is NOT a missing import; adding a static import to
 * model.ts would undermine that design. `bun test` never runs the cli.tsx
 * install, so the test-side fix mirrors startup: install the same three
 * globals before walking the registry.
 */
describe('CC 2.1.285 test-08 (ant profile): registry-level WebFetch removal with the real managed-file loader', () => {
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>
    if (typeof g.resolveAntModel === 'undefined') {
      const antModels = await import('../../../utils/model/antModels.js')
      g.resolveAntModel = antModels.resolveAntModel
      g.getAntModels = antModels.getAntModels
      g.getAntModelOverrideConfig = antModels.getAntModelOverrideConfig
    }
  })

  test('USER_TYPE=ant + managed allow_web_fetch:false → WebFetch excluded from the default preset', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    armManaged({ allow_web_fetch: false })
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).not.toContain(WEB_FETCH_TOOL_NAME)
  })

  test('USER_TYPE=ant + managed allow_web_fetch:true → WebFetch included (registry walk survives the ant model branch)', async () => {
    delete process.env.CLAUDE_CODE_DISABLE_WEB_FETCH
    armManaged({ allow_web_fetch: true })
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).toContain(WEB_FETCH_TOOL_NAME)
  })

  test('USER_TYPE=ant + env kill-switch → WebFetch excluded even with policy allow', async () => {
    process.env.CLAUDE_CODE_DISABLE_WEB_FETCH = '1'
    armManaged({ allow_web_fetch: true })
    const { getToolsForDefaultPreset } = await import('../../../tools.js')
    expect(getToolsForDefaultPreset()).not.toContain(WEB_FETCH_TOOL_NAME)
  })
})
