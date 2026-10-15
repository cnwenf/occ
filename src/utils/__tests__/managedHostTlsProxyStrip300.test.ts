import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.300 (#55) — "Changed CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST sessions to
 * ignore CA-bundle, tool-proxy, git TLS and git config variables like
 * SSL_CERT_FILE in settings; under Claude Desktop, only in project settings."
 *
 * Official v300 filter fn `b(e,n,r,i)` @219874632 (byte-verified,
 * docs/gap-research-300/triage-T3.md ## 55):
 *   if(r.managedByHostFlag&&(!r.desktopHost||oJe(n))&&(Vln(s)||iJe(s))){
 *     L(i,s,n,r.desktopHost);continue}
 *   Vln = proxy set `Tl` (9 vars) @216530205
 *   iJe = `Ky` (mTLS/auth 6 + Pl) ∪ `vDr` (Pl list + git regexes) @216530140
 *   Pl  = dedup(pte[14 CA] + Gme[2] + CYn[18 tool-proxy] + vl[3] +
 *         pJ∖fQe[5 git-config]) minus {NODE_EXTRA_CA_CERTS, JAVA_TOOL_OPTIONS,
 *         Tl members} @216530140 / @216517650 / @216520764 / @216276040
 *   l5n = /^GIT_(?:SSL|PROXY)_/i, mQe = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i
 *   fQe (12 git repo-location vars: GIT_DIR, GIT_WORK_TREE, …) are KEPT — they
 *     say where the repo is, not how to establish TLS.
 *   L warning text @219874060 (desktopHost ⇒ "re-point the TLS/proxy channel";
 *     else ⇒ "provider routing is managed by the host").
 *
 * OCC mapping: managedByHostFlag → isEnvTruthy(CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST);
 * desktopHost → CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'; oJe(n) →
 * PROJECT_SCOPED_SOURCES.has(source). Wired into filterSettingsEnv.
 *
 * Test architecture follows projectScopeEnvBlocklist251.test.ts: mock
 * settings.js (getSettingsForSource) + config.js (getGlobalConfig), drive the
 * real applyConfigEnvironmentVariables, restore modules in afterAll (OCC-97).
 */

const settingsBySource: Record<
  string,
  { env?: Record<string, string> } | null
> = {}

const actualSettingsModule = await import('../settings/settings.js')
const actualConfigModule = await import('../config.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualConfigExports = { ...actualConfigModule }

mock.module('../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
}))
mock.module('../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => ({ env: {} }),
}))

afterAll(() => {
  mock.module('../settings/settings.js', () => ({ ...actualSettingsExports }))
  mock.module('../config.js', () => ({ ...actualConfigExports }))
})

const { applyConfigEnvironmentVariables, _resetManagedEnvForTesting } =
  await import('../managedEnv.js')
const { isHostManagedTlsOrProxyVar, GIT_REPO_LOCATION_VARS } = await import(
  '../managedEnvConstants.js'
)

const ENV_KEYS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'GIT_SSL_CAINFO',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_KEY_0',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'CLAUDE_CODE_CLIENT_CERT',
  'UV_NATIVE_TLS',
  'OCC_TEST_NEUTRAL',
] as const

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  _resetManagedEnvForTesting()
})

function setManagedByHost(on: boolean): void {
  if (on) process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  else delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
}

function clearStripTargets(): void {
  for (const key of [
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'GIT_SSL_CAINFO',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_KEY_0',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'CLAUDE_CODE_CLIENT_CERT',
    'UV_NATIVE_TLS',
    'OCC_TEST_NEUTRAL',
  ]) {
    delete process.env[key]
  }
}

// ---------------------------------------------------------------------------
// (a) pure predicate — byte-verified membership
// ---------------------------------------------------------------------------

describe('#55 isHostManagedTlsOrProxyVar predicate', () => {
  test('strips proxy / CA-bundle / mTLS / native-TLS / git-TLS / git-config vars', () => {
    for (const key of [
      // proxy set (Tl)
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'CLAUDE_CODE_HTTP_PROXY',
      'CLAUDE_CODE_HTTPS_PROXY',
      'NPM_CONFIG_PROXY',
      'NPM_CONFIG_HTTP_PROXY',
      'NPM_CONFIG_HTTPS_PROXY',
      // CA-bundle (pte)
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'AWS_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'NIX_SSL_CERT_FILE',
      // native-TLS CA store (Gme)
      'UV_NATIVE_TLS',
      'DENO_TLS_CA_STORE',
      // tool-proxy (CYn)
      'YARN_HTTPS_PROXY',
      'GLOBAL_AGENT_HTTP_PROXY',
      'DOCKER_HTTPS_PROXY',
      'CLOUDSDK_PROXY_ADDRESS',
      'ELECTRON_GET_USE_PROXY',
      // mTLS/auth (Ky base)
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'CLAUDE_CODE_OAUTH_SCOPES',
      // git-config (pJ∖fQe)
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG',
    ]) {
      expect(isHostManagedTlsOrProxyVar(key)).toBe(true)
    }
  })

  test('strips git TLS/proxy + indexed git-config by regex (case-insensitive)', () => {
    expect(isHostManagedTlsOrProxyVar('GIT_SSL_VERIFY')).toBe(true)
    expect(isHostManagedTlsOrProxyVar('GIT_PROXY_COMMAND')).toBe(true)
    expect(isHostManagedTlsOrProxyVar('GIT_CONFIG_KEY_0')).toBe(true)
    expect(isHostManagedTlsOrProxyVar('GIT_CONFIG_VALUE_12')).toBe(true)
    expect(isHostManagedTlsOrProxyVar('git_ssl_cainfo')).toBe(true)
    expect(isHostManagedTlsOrProxyVar('git_config_key_3')).toBe(true)
  })

  test('KEEPS git repo-location vars (fQe) — they say where the repo is, not how to do TLS', () => {
    for (const key of GIT_REPO_LOCATION_VARS) {
      expect(isHostManagedTlsOrProxyVar(key)).toBe(false)
    }
    expect(GIT_REPO_LOCATION_VARS).toContain('GIT_DIR')
    expect(isHostManagedTlsOrProxyVar('GIT_DIR')).toBe(false)
    expect(isHostManagedTlsOrProxyVar('GIT_WORK_TREE')).toBe(false)
    expect(isHostManagedTlsOrProxyVar('GIT_INDEX_FILE')).toBe(false)
  })

  test('KEEPS unrelated vars (provider routing, PATH, neutral)', () => {
    expect(isHostManagedTlsOrProxyVar('ANTHROPIC_MODEL')).toBe(false)
    expect(isHostManagedTlsOrProxyVar('PATH')).toBe(false)
    expect(isHostManagedTlsOrProxyVar('OCC_TEST_NEUTRAL')).toBe(false)
    // JAVA_TOOL_OPTIONS is in CYn but the official Pl filter excludes it.
    expect(isHostManagedTlsOrProxyVar('JAVA_TOOL_OPTIONS')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b) managed-by-host wiring through applyConfigEnvironmentVariables
// ---------------------------------------------------------------------------

describe('#55 managed-by-host TLS/proxy strip', () => {
  test('SSL_CERT_FILE from project settings is dropped; GIT_DIR + neutral survive', () => {
    clearStripTargets()
    setManagedByHost(true)
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    settingsBySource.projectSettings = {
      env: {
        SSL_CERT_FILE: '/evil/ca.pem',
        GIT_DIR: '/repo/.git',
        OCC_TEST_NEUTRAL: 'keep-me',
      },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.SSL_CERT_FILE).toBeUndefined()
    expect(process.env.GIT_DIR).toBe('/repo/.git')
    expect(process.env.OCC_TEST_NEUTRAL).toBe('keep-me')
  })

  test('strips proxy + CA + mTLS + git-TLS + git-config across the board', () => {
    clearStripTargets()
    setManagedByHost(true)
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    settingsBySource.projectSettings = {
      env: {
        HTTP_PROXY: 'http://evil:8080',
        NODE_EXTRA_CA_CERTS: '/evil/ca.pem',
        CLAUDE_CODE_CLIENT_CERT: '/evil/client.pem',
        GIT_SSL_CAINFO: '/evil/git-ca.pem',
        GIT_CONFIG_GLOBAL: '/evil/gitconfig',
        UV_NATIVE_TLS: 'true',
        GIT_WORK_TREE: '/repo',
      },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(process.env.CLAUDE_CODE_CLIENT_CERT).toBeUndefined()
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined()
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(process.env.UV_NATIVE_TLS).toBeUndefined()
    // git repo-location survives.
    expect(process.env.GIT_WORK_TREE).toBe('/repo')
  })

  test('non-managed session strips NOTHING (SSL_CERT_FILE + proxy survive)', () => {
    clearStripTargets()
    setManagedByHost(false)
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    settingsBySource.projectSettings = {
      env: {
        SSL_CERT_FILE: '/legit/ca.pem',
        HTTP_PROXY: 'http://corp:8080',
        GIT_CONFIG_GLOBAL: '/legit/gitconfig',
      },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.SSL_CERT_FILE).toBe('/legit/ca.pem')
    expect(process.env.HTTP_PROXY).toBe('http://corp:8080')
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/legit/gitconfig')
  })

  test('managed-by-host strips from USER settings too (non-desktop = all sources)', () => {
    clearStripTargets()
    setManagedByHost(true)
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    settingsBySource.userSettings = {
      env: { SSL_CERT_FILE: '/user/ca.pem' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.SSL_CERT_FILE).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (c) desktop-host clause — project scope only
// ---------------------------------------------------------------------------

describe('#55 Claude Desktop narrows the strip to project settings', () => {
  test('desktop host: project-scoped SSL_CERT_FILE is dropped', () => {
    clearStripTargets()
    setManagedByHost(true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    settingsBySource.projectSettings = {
      env: { SSL_CERT_FILE: '/evil/ca.pem' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.SSL_CERT_FILE).toBeUndefined()
  })

  test('desktop host: user-scoped SSL_CERT_FILE is KEPT (only project scope stripped)', () => {
    clearStripTargets()
    setManagedByHost(true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    settingsBySource.userSettings = {
      env: { SSL_CERT_FILE: '/user/ca.pem' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.SSL_CERT_FILE).toBe('/user/ca.pem')
  })
})

// ---------------------------------------------------------------------------
// (d) warning text (byte-verified against v300 @219874060)
// ---------------------------------------------------------------------------

describe('#55 drop warnings', () => {
  test('non-desktop managed-by-host emits the provider-routing warning once', () => {
    clearStripTargets()
    setManagedByHost(true)
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    const dir = mkdtempSync(join(tmpdir(), 'occ-55-'))
    const logFile = join(dir, 'diag.log')
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = logFile
    settingsBySource.projectSettings = {
      env: { SSL_CERT_FILE: '/evil/ca.pem' },
    }

    applyConfigEnvironmentVariables()
    applyConfigEnvironmentVariables()

    const lines = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { level: string; event: string })
    const warns = lines.filter((entry) =>
      entry.event.includes("provider routing is managed by the host"),
    )
    expect(warns.length).toBe(1)
    expect(warns[0].level).toBe('warn')
    expect(warns[0].event).toBe(
      "Ignoring SSL_CERT_FILE from projectSettings — this session's provider " +
        'routing is managed by the host (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST ' +
        'or a host-auth-callback marker), so settings-sourced provider/auth ' +
        'configuration does not apply.',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('desktop host emits the TLS/proxy-channel warning', () => {
    clearStripTargets()
    setManagedByHost(true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    const dir = mkdtempSync(join(tmpdir(), 'occ-55-desktop-'))
    const logFile = join(dir, 'diag.log')
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = logFile
    settingsBySource.projectSettings = {
      env: { SSL_CERT_FILE: '/evil/ca.pem' },
    }

    applyConfigEnvironmentVariables()

    const lines = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { level: string; event: string })
    const warns = lines.filter((entry) =>
      entry.event.includes("can't re-point the TLS/proxy channel"),
    )
    expect(warns.length).toBe(1)
    expect(warns[0].event).toBe(
      'Ignoring SSL_CERT_FILE from projectSettings — repo-committed settings ' +
        "can't re-point the TLS/proxy channel of a session whose credential " +
        'comes from the host. Set it in ~/.claude/settings.json or managed ' +
        'settings instead.',
    )
    rmSync(dir, { recursive: true, force: true })
  })
})
