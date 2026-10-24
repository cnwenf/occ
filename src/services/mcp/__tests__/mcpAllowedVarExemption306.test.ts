import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsSchema } from '../../../utils/settings/types.js'
import type { McpServerConfig } from '../types.js'

/**
 * Official Claude Code 2.1.306 (#P9) — allowedMcpServers org-delivered
 * exemption with the v306 field narrowing.
 *
 * Official v306 describe text (byte-extract, s306.txt @11983541):
 *   "Enterprise allowlist of the MCP servers users may use. Governs servers
 *    users add (user, project and local config, --mcp-config, agent
 *    frontmatter, plugins, claude.ai connectors); servers the organization
 *    itself delivers (managedMcpServers, and managed-mcp.json entries with no
 *    ${VAR} in their command, args, url or header values) are allowed without
 *    being listed; a managed-mcp.json entry with ${VAR} in any of those must
 *    match this list. If undefined, all servers are allowed. If empty array,
 *    users can use no servers of their own. Denylist takes precedence - if a
 *    server is on both lists, it is denied."
 *
 * v304 scanned EVERY authored field of a managed-mcp.json entry (including
 * `env` — v304 text: "entries that use no ${VAR} expansion", s304 ×2, s306
 * ×0), so an org stdio server whose only ${VAR} lived in `env` still had to
 * be allowlisted. v306 narrows the scan to command/args/url/headers (v306
 * text: "with no ${VAR} in their command, args, url or header values",
 * s306 ×2, s304 ×0) — env-only ${VAR} entries are org-delivered and load
 * unlisted. Denylist stays absolute. The exemption predicate itself is
 * string-less in the official policy module; the official re-parse is
 * `fu(scope,{expandVars:!1})` (authored values, since expanded ones no
 * longer contain the `${...}` markers).
 *
 * OCC note: the "Managed MCP server was ignored" warning (s306 @14261537)
 * belongs to the official `managedMcpServers` settings-KEY schema validator
 * (`Cy`) — a key OCC does not have — NOT to the managed-mcp.json allowlist
 * filter path, so no warning string is asserted or invented here.
 */

// --- environment wiring ------------------------------------------------------
//
// OCC-131 CI leak fix: the env wiring below used to run at MODULE TOP LEVEL.
// Bun evaluates every test file's top level before any tests run, and file
// execution order is not stable across machines — on the CI runner the
// same-worker pair (polluter mcpGetDynamicScope285 -> this file) ran the
// polluter's tests while `USER_TYPE=ant` + `CLAUDE_CODE_MANAGED_SETTINGS_PATH`
// + a seeded managed-mcp.json from THIS file's top level were live, forcing
// the polluter's real config lookup into the enterprise-exclusive branch
// (zero servers, "No MCP server named"). All process-env mutations therefore
// live in beforeAll/afterAll (per-file lifecycle — guaranteed to bracket only
// this file's tests), never at top level.

const managedDir = mkdtempSync(join(tmpdir(), 'occ-mcp-306-managed-'))
const configDir = mkdtempSync(join(tmpdir(), 'occ-mcp-306-config-'))

let savedEnv: Record<string, string | undefined> = {}

function writeManagedMcpJson(mcpServers: Record<string, unknown>): void {
  writeFileSync(
    join(managedDir, 'managed-mcp.json'),
    JSON.stringify({ mcpServers }, null, 2),
  )
}

// OCC-97 cross-file leak, second vector: getManagedFilePath is memoized in
// managedPath.ts — a SHARED module that even the cache-busted config.js
// instance below resolves to. In combined runs an earlier suite's preload can
// seed that memo under the default env (USER_TYPE unset → '/etc/claude-code')
// before the env wiring exists, and lodash memoize never re-reads the
// override — doesEnterpriseMcpConfigExist then pins false and the enterprise
// branch dies (zero servers). beforeAll clears both path memos after the env
// wiring so the first call re-memoizes under the override; afterAll clears
// again to un-pin for later files.
//
// OCC-131 CI-hang fix: ALL module loads in this file (managedPath.js,
// settings.js, the settings mock.module registration and the cache-busted
// config.js instance) used to run at MODULE TOP LEVEL. In a same-worker pair
// run bun evaluates both files' top levels CONCURRENTLY, so this file's
// mock.module() fired while the polluter's (mcpGetDynamicScope285's heavy
// mcp.js-handler chain) module graph was still mid-evaluation — on the CI
// runner that combination deadlocked bun's module loader (68+ min, zero
// output, both attempts; NOT reproducible locally, and pair #6's victim has
// a top-level TLA import but registers no mock, while the 296 pairs register
// top-level mocks but against a light polluter graph — only THIS pair has
// both). Loading everything inside beforeAll serializes it strictly after
// every file's top level has settled, mirroring the load sequence of the
// per-file run that has always passed in CI.
type ManagedPathModule = typeof import('../../../utils/settings/managedPath.js')
type SettingsModule = typeof import('../../../utils/settings/settings.js')
type ConfigModule = typeof import('../config.js')

let managedPathModule: ManagedPathModule
let actualSettings: SettingsModule
// OCC-131 hang fix — BY-VALUE snapshot of the real settings exports, taken
// in beforeAll BEFORE any mock.module registration. bun's mock.module
// RETROACTIVELY re-points the live bindings of already-captured namespace
// objects (the ci-test.sh pair-2 warning): spreading `actualSettings` at
// afterAll time copies the shim back in, re-installing it process-wide.
// The re-installed shim then delegates to `actualSettings.getInitialSettings`
// — which now resolves to the shim ITSELF. ESM is strict mode and bun's JSC
// implements proper tail calls, so that self-recursion NEVER overflows the
// stack: it spins synchronously at 100% CPU, starving the event loop (no
// timer, no per-test timeout, no inspector). Trigger: any later same-process
// file whose background work calls getInitialSettings() (rb295's headless
// redial → getAllMcpConfigs → isMcpServerDenied). Every factory below must
// spread/delegate through THIS snapshot, never the live namespace.
let pristineSettingsExports: SettingsModule
let doesEnterpriseMcpConfigExist: ConfigModule['doesEnterpriseMcpConfigExist']
let getClaudeCodeMcpConfigs: ConfigModule['getClaudeCodeMcpConfigs']
let isMcpServerAllowedByPolicy: ConfigModule['isMcpServerAllowedByPolicy']

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only what this test drives, restore after.
// OCC-131: delegation + `mockActive` pass-through (the autoDefaultNudge296
// pattern) — when this suite is NOT the file currently running, the
// registration passes through to the REAL getInitialSettings, so a
// same-worker sibling whose tests run under any file order never binds the
// fake. Registered in beforeAll (see the CI-hang note above).
let currentSettings: Record<string, unknown> = {}
let settingsMockActive = false

beforeAll(async () => {
  managedPathModule = await import(
    '../../../utils/settings/managedPath.js'
  )
  actualSettings = await import('../../../utils/settings/settings.js')
  // Snapshot by value NOW — before mock.module re-points the live bindings
  // of `actualSettings` (see the pristineSettingsExports declaration comment).
  pristineSettingsExports = { ...actualSettings } as SettingsModule

  savedEnv = {
    USER_TYPE: process.env.USER_TYPE,
    CLAUDE_CODE_MANAGED_SETTINGS_PATH:
      process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OCC_P9_TOKEN: process.env.OCC_P9_TOKEN,
    OCC_P9_CMD: process.env.OCC_P9_CMD,
  }
  // getManagedFilePath (memoized) honors the override only for USER_TYPE=ant.
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.OCC_P9_TOKEN = 'secret-token-value'
  process.env.OCC_P9_CMD = 'cmd-var-binary'
  // doesEnterpriseMcpConfigExist is memoized — seed a valid file before the
  // first parse so the enterprise-exclusive branch is live for every test.
  writeManagedMcpJson({})
  managedPathModule.getManagedFilePath.cache.clear()
  managedPathModule.getManagedSettingsDropInDir.cache.clear()

  mock.module('../../../utils/settings/settings.js', () => ({
    ...pristineSettingsExports,
    getInitialSettings: () =>
      settingsMockActive
        ? currentSettings
        : pristineSettingsExports.getInitialSettings(),
  }))

  // OCC-97 cross-file mock leak: a src/cli/handlers MCP suite `mock.module`s
  // config.js (with an empty `getClaudeCodeMcpConfigs`) at its top level, and
  // Bun evaluates every test file's top level before any afterAll restore —
  // so a plain top-level import here binds that leaked fake and #P9 sees zero
  // servers. The cache-busted query specifier pulls a genuine config.js
  // instance no sibling mock intercepts (same remedy mcpGetDynamicScope285
  // uses); its internal settings.js import still resolves to THIS file's
  // settings mock registered just above.
  const cfg = (await import('../config.js?occ-p9-real')) as unknown as ConfigModule
  doesEnterpriseMcpConfigExist = cfg.doesEnterpriseMcpConfigExist
  getClaudeCodeMcpConfigs = cfg.getClaudeCodeMcpConfigs
  isMcpServerAllowedByPolicy = cfg.isMcpServerAllowedByPolicy

  // Arm the settings-mock delegation for this file's tests.
  settingsMockActive = true
})

afterAll(async () => {
  // Flip the delegation flag first so the permanent settings registration
  // passes through to the real module for any later file in the worker.
  settingsMockActive = false
  // Re-pin with the BY-VALUE pre-mock snapshot — NOT `{...actualSettings}`:
  // the namespace's live bindings were re-pointed to the shim the moment
  // beforeAll's mock.module ran, so an afterAll-time spread re-installs the
  // shim process-wide and its pass-through branch tail-recurses into itself
  // forever (strict-mode TCO ⇒ no stack overflow ⇒ silent 100%-CPU spin —
  // the OCC-131 CI hang). See pristineSettingsExports declaration.
  mock.module('../../../utils/settings/settings.js', () => ({
    ...pristineSettingsExports,
  }))
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  // Un-pin the shared managed-path memos (seeded under this suite's override)
  // so later files re-memoize under the restored env.
  managedPathModule.getManagedFilePath.cache.clear()
  managedPathModule.getManagedSettingsDropInDir.cache.clear()
  // OCC-97 half-close (2.1.308 follow-up): doesEnterpriseMcpConfigExist is
  // ALSO memoized (config.ts) — this suite seeds it `true` under the temp
  // managedDir it then rmSyncs. Clear the cache-busted instance's memo, and
  // also clear whatever '../config.js' resolves to at teardown time (the
  // shared instance, or a sibling's mock-registered fake that spread the
  // real config exports) so no later file in the same worker inherits a memo
  // pinned to a now-deleted directory.
  doesEnterpriseMcpConfigExist.cache.clear()
  const sharedConfig = (await import('../config.js')) as {
    doesEnterpriseMcpConfigExist?: { cache?: { clear?: () => void } }
  }
  sharedConfig.doesEnterpriseMcpConfigExist?.cache?.clear?.()
  rmSync(managedDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

// --- fixtures ---------------------------------------------------------------

// Built via concatenation so the literal MCP "${...}" references stay plain
// strings without tripping noTemplateCurlyInString (same approach as
// dynamicMcpConfig.test.ts).
function mcpVar(name: string): string {
  return '${' + name + '}'
}
function mcpVarDefault(name: string, fallback: string): string {
  return '${' + name + ':-' + fallback + '}'
}

const authoredEnvOnly: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: { TOKEN: mcpVar('OCC_P9_TOKEN') },
}
const expandedEnvOnly: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: { TOKEN: 'secret-token-value' },
}
const authoredPlain: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['plain.js'],
}
const authoredCmdVar: McpServerConfig = {
  type: 'stdio',
  command: mcpVar('OCC_P9_CMD'),
  args: [],
}
const authoredArgsVar: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['--token=' + mcpVar('OCC_P9_TOKEN')],
}
const authoredUrlVar: McpServerConfig = {
  type: 'http',
  url: 'https://urlvar.example.com/' + mcpVar('OCC_P9_TOKEN'),
}
const authoredHeadersVar: McpServerConfig = {
  type: 'http',
  url: 'https://headers.example.com',
  headers: { Authorization: 'Bearer ' + mcpVar('OCC_P9_TOKEN') },
}
const authoredCmdVarDefault: McpServerConfig = {
  type: 'stdio',
  command: mcpVarDefault('OCC_P9_CMD', 'node'),
  args: [],
}

const ALLOWLIST_OTHER = [{ serverName: 'listed-srv' }]

// --- unit: the exemption predicate ------------------------------------------

describe('#P9 isMcpServerAllowedByPolicy — org-delivered exemption (v306 field set)', () => {
  // env-only ${VAR}: the v306 narrowing — env is NOT in the scanned field set.
  test('env-only var reference in the authored config IS exempt from an unlisted allowlist (v306 narrowing)', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert — v304 would have returned false here (env was scanned).
    expect(
      isMcpServerAllowedByPolicy('env-srv', expandedEnvOnly, authoredEnvOnly),
    ).toBe(true)
  })

  test('no-var authored config is exempt even from an EMPTY allowlist', () => {
    // Arrange
    currentSettings = { allowedMcpServers: [] }

    // Act / Assert — empty allowlist blocks user servers, not org-delivered
    // ones ("If empty array, users can use no servers of their own.").
    expect(
      isMcpServerAllowedByPolicy('plain-srv', authoredPlain, authoredPlain),
    ).toBe(true)
    expect(
      isMcpServerAllowedByPolicy('env-srv', expandedEnvOnly, authoredEnvOnly),
    ).toBe(true)
  })

  test('command var reference is NOT exempt — must match the allowlist', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy('cmd-srv', authoredCmdVar, authoredCmdVar),
    ).toBe(false)
    // …and matching by name allows it.
    currentSettings = { allowedMcpServers: [{ serverName: 'cmd-srv' }] }
    expect(
      isMcpServerAllowedByPolicy('cmd-srv', authoredCmdVar, authoredCmdVar),
    ).toBe(true)
  })

  test('args var reference is NOT exempt', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy(
        'args-srv',
        authoredArgsVar,
        authoredArgsVar,
      ),
    ).toBe(false)
  })

  test('url var reference is NOT exempt', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy('url-srv', authoredUrlVar, authoredUrlVar),
    ).toBe(false)
  })

  test('header var reference is NOT exempt', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy(
        'headers-srv',
        authoredHeadersVar,
        authoredHeadersVar,
      ),
    ).toBe(false)
  })

  test('var-with-default form counts as a var reference (official ENV_VAR_PATTERN covers defaults)', () => {
    // Arrange
    currentSettings = { allowedMcpServers: ALLOWLIST_OTHER }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy(
        'cmd-def-srv',
        authoredCmdVarDefault,
        authoredCmdVarDefault,
      ),
    ).toBe(false)
  })

  test('denylist is absolute — blocks even a no-var org-delivered entry', () => {
    // Arrange
    currentSettings = {
      allowedMcpServers: ALLOWLIST_OTHER,
      deniedMcpServers: [{ serverName: 'plain-srv' }],
    }

    // Act / Assert
    expect(
      isMcpServerAllowedByPolicy('plain-srv', authoredPlain, authoredPlain),
    ).toBe(false)
  })

  test('without authoredConfig, pre-306 behavior is unchanged (empty allowlist blocks)', () => {
    // Arrange
    currentSettings = { allowedMcpServers: [] }

    // Act / Assert — non-enterprise callers pass two args and never get the
    // exemption (only the managed-mcp.json branch re-parses authored values).
    expect(isMcpServerAllowedByPolicy('plain-srv', authoredPlain)).toBe(false)
  })
})

// --- integration: getClaudeCodeMcpConfigs enterprise branch ------------------

const MANAGED_SERVERS = {
  envVarOnly: {
    type: 'stdio',
    command: 'node',
    args: ['env-server.js'],
    env: { TOKEN: mcpVar('OCC_P9_TOKEN') },
  },
  plainSrv: { type: 'stdio', command: 'node', args: ['plain.js'] },
  cmdVar: { type: 'stdio', command: mcpVar('OCC_P9_CMD'), args: [] },
  urlVar: {
    type: 'http',
    url: 'https://urlvar.example.com/' + mcpVar('OCC_P9_TOKEN'),
  },
  headersVar: {
    type: 'http',
    url: 'https://headers.example.com',
    headers: { Authorization: 'Bearer ' + mcpVar('OCC_P9_TOKEN') },
  },
  deniedSrv: { type: 'stdio', command: 'node', args: ['denied.js'] },
}

describe('#P9 getClaudeCodeMcpConfigs — enterprise branch authored re-parse', () => {
  test('unlisted env-only/plain entries load; var-in-checked-fields entries need the list; denied stays blocked', async () => {
    // Arrange
    writeManagedMcpJson(MANAGED_SERVERS)
    currentSettings = {
      allowedMcpServers: [{ serverName: 'cmdVar' }],
      deniedMcpServers: [{ serverName: 'deniedSrv' }],
    }

    // Act
    const { servers, errors } = await getClaudeCodeMcpConfigs()

    // Assert — org-delivered (env-only ${VAR}, plain) load WITHOUT being
    // listed; cmdVar loads via its name entry; urlVar/headersVar are
    // ${VAR}-in-checked-fields and unlisted → dropped; deniedSrv is on the
    // denylist → dropped despite being ${VAR}-free.
    expect(errors).toEqual([])
    expect(Object.keys(servers).sort()).toEqual([
      'cmdVar',
      'envVarOnly',
      'plainSrv',
    ])
    expect(servers.envVarOnly?.scope).toBe('enterprise')
    // The loaded config is the EXPANDED one (authored copy is scan-only).
    expect(
      (servers.envVarOnly as { env?: Record<string, string> })?.env?.TOKEN,
    ).toBe('secret-token-value')
    expect(
      (servers.cmdVar as { command?: string })?.command,
    ).toBe('cmd-var-binary')
  })

  test('empty allowlist: only the no-checked-var org entries survive', async () => {
    // Arrange — the deny entry stays on: deniedSrv is ${VAR}-free, so without
    // the denylist it would ride the org-delivered exemption. Denylist is
    // absolute even under an empty allowlist.
    writeManagedMcpJson(MANAGED_SERVERS)
    currentSettings = {
      allowedMcpServers: [],
      deniedMcpServers: [{ serverName: 'deniedSrv' }],
    }

    // Act
    const { servers } = await getClaudeCodeMcpConfigs()

    // Assert
    expect(Object.keys(servers).sort()).toEqual(['envVarOnly', 'plainSrv'])
  })
})

// --- schema describe text -----------------------------------------------------

describe('#P9 allowedMcpServers describe — official v306 text (OCC trim)', () => {
  test('matches the v306 describe byte-for-byte minus the managedMcpServers trim', () => {
    // Arrange — the official string with `managedMcpServers, and ` removed
    // (OCC has no managedMcpServers settings key; the org-delivered surface
    // here is managed-mcp.json only).
    const officialV306Trimmed =
      'Enterprise allowlist of the MCP servers users may use. ' +
      'Governs servers users add (user, project and local config, --mcp-config, agent frontmatter, plugins, claude.ai connectors); ' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: official v306 describe text carries the literal MCP ${VAR} syntax
      'servers the organization itself delivers (managed-mcp.json entries with no ${VAR} in their command, args, url or header values) are allowed without being listed; ' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: official v306 describe text carries the literal MCP ${VAR} syntax
      'a managed-mcp.json entry with ${VAR} in any of those must match this list. ' +
      'If undefined, all servers are allowed. If empty array, users can use no servers of their own. ' +
      'Denylist takes precedence - if a server is on both lists, it is denied.'

    // Act
    const description = SettingsSchema().shape.allowedMcpServers.description

    // Assert
    expect(description).toBe(officialV306Trimmed)
  })
})
