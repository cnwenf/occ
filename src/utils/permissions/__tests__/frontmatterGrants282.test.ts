/**
 * CC 2.1.282 bullet (a) — frontmatter allowed-tools trust gate under the
 * managed `allowManagedPermissionRulesOnly` lock.
 *
 * Official cluster (v2.1.282 linux-x64 ELF, byte-extracted):
 *   - zw()  shouldAllowManagedPermissionRulesOnly (the managed lock)
 *   - FU    TRUSTED_ALLOWED_TOOLS_SOURCES = {plugin, policySettings, built-in,
 *           builtin, bundled}
 *   - yrn   isAllowedToolsSourceTrusted
 *   - ku∘lC plugin trust (id defined && namespace !== "skills-dir")
 *   - ZMe   getAllowedToolsGated (apply-time gate)
 *   - iUn   warnAllowedToolsWithheld — exact warn text:
 *           `Ignoring allowed-tools ${tools} from /${name} (${label}):
 *            permission rules are restricted to managed settings
 *            (allowManagedPermissionRulesOnly).`
 *   - ds    once-per-`/${name} (${label})` session dedupe set
 *   - kb/Pu source labels: userSettings→"user", projectSettings→"project",
 *           localSettings→"project, gitignored", flagSettings→"cli flag",
 *           policySettings→"managed"
 *
 * OCC deviation under test: the scrub runs at LOAD time via
 * gateAllowedToolsAtLoad() (the official apply-site processSlashCommand is
 * out-of-cluster); warning text + dedupe are byte-identical.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97: snapshot real exports BEFORE mocking; restore in afterAll so the
// mocks don't leak into other test files sharing this worker.
const actualPermissionsLoader = { ...(await import('../permissionsLoader.js')) }
const actualDebug = { ...(await import('../../debug.js')) }
const actualAnalytics = { ...(await import('../../../services/analytics/index.js')) }

/** Drives the managed lock (official zw()). */
let managedRulesOnly = false
/** Captured logForDebugging calls: [message, level]. */
let debugLogs: Array<{ message: string; level?: string }> = []
/** Captured logEvent calls. */
let events: Array<{ name: string; metadata: Record<string, unknown> }> = []

mock.module('../permissionsLoader.js', () => ({
  ...actualPermissionsLoader,
  shouldAllowManagedPermissionRulesOnly: () => managedRulesOnly,
}))

mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (
    message: string,
    opts?: { level?: string },
  ) => {
    debugLogs.push({ message, level: opts?.level })
  },
}))

mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))

afterAll(() => {
  mock.module('../permissionsLoader.js', () => ({ ...actualPermissionsLoader }))
  mock.module('../../debug.js', () => ({ ...actualDebug }))
  mock.module('../../../services/analytics/index.js', () => ({ ...actualAnalytics }))
})

const {
  TRUSTED_ALLOWED_TOOLS_SOURCES,
  allowedToolsSourceLabel,
  sanitizeAllowedToolsWarningText,
  pluginIdNamespace,
  isAllowedToolsSourceTrusted,
  getAllowedToolsGated,
  gateAllowedToolsAtLoad,
  getWithheldAllowedToolsSessionSet,
  resetWithheldAllowedToolsSessionSet_FOR_TESTING,
  withheldAllowedToolsKey,
  hasAllowedToolsWithheldWarningBeenShown,
} = await import('../frontmatterGrants.js')

beforeEach(() => {
  managedRulesOnly = false
  debugLogs = []
  events = []
  resetWithheldAllowedToolsSessionSet_FOR_TESTING()
})

describe('2.1.282 bullet (a): frontmatter allowed-tools trust gate', () => {
  test('gate OFF: every source is trusted and tools pass through unchanged', async () => {
    managedRulesOnly = false
    expect(isAllowedToolsSourceTrusted('userSettings')).toBe(true)
    expect(isAllowedToolsSourceTrusted(undefined)).toBe(true)
    expect(isAllowedToolsSourceTrusted('plugin')).toBe(true)

    const tools = ['Bash(git:*)', 'WebFetch']
    expect(
      await getAllowedToolsGated({
        name: 'deploy',
        source: 'projectSettings',
        allowedTools: tools,
      }),
    ).toEqual(tools)
    expect(
      gateAllowedToolsAtLoad({
        name: 'deploy',
        source: 'projectSettings',
        allowedTools: tools,
      }),
    ).toEqual(tools)
    expect(debugLogs).toEqual([])
    expect(getWithheldAllowedToolsSessionSet().size).toBe(0)
  })

  test('gate ON: repo/user/cli-flag skill+command allowed-tools are withheld', async () => {
    managedRulesOnly = true
    for (const source of [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
    ]) {
      expect(isAllowedToolsSourceTrusted(source)).toBe(false)
      expect(
        await getAllowedToolsGated({
          name: 'deploy',
          source,
          allowedTools: ['Bash(git:*)'],
        }),
      ).toEqual([])
    }
    // Undefined source is untrusted under the lock (official yrn requires a
    // source in FU).
    expect(isAllowedToolsSourceTrusted(undefined)).toBe(false)
  })

  test('gate ON: plugin/bundled/builtin/policySettings sources stay trusted', async () => {
    managedRulesOnly = true
    expect(TRUSTED_ALLOWED_TOOLS_SOURCES.has('plugin')).toBe(true)
    for (const source of ['bundled', 'builtin', 'built-in', 'policySettings']) {
      expect(isAllowedToolsSourceTrusted(source)).toBe(true)
    }
    // Official ku: plugin trusted iff id defined && namespace !== "skills-dir".
    expect(
      isAllowedToolsSourceTrusted('plugin', { id: 'myplugin@marketplace' }),
    ).toBe(true)
    expect(isAllowedToolsSourceTrusted('plugin', { id: 'inline[x]' })).toBe(true)
    expect(isAllowedToolsSourceTrusted('plugin', { id: 'skills-dir[x]' })).toBe(
      false,
    )
    expect(isAllowedToolsSourceTrusted('plugin', undefined)).toBe(false)
    expect(isAllowedToolsSourceTrusted('plugin', {})).toBe(false)

    const tools = ['Bash(npm:*)']
    expect(
      await getAllowedToolsGated({
        name: 'myplugin:deploy',
        source: 'plugin',
        allowedTools: tools,
        pluginInfo: { repository: 'myplugin@marketplace' },
      }),
    ).toEqual(tools)
    // skills-dir-namespaced plugin id is withheld even with source "plugin".
    expect(
      await getAllowedToolsGated({
        name: 'x',
        source: 'plugin',
        allowedTools: tools,
        pluginInfo: { repository: 'skills-dir[abc]' },
      }),
    ).toEqual([])
  })

  test('gate ON: withheld warning is byte-exact with source labels', () => {
    managedRulesOnly = true
    const cases: Array<[string, string]> = [
      ['userSettings', 'user'],
      ['projectSettings', 'project'],
      ['localSettings', 'project, gitignored'],
      ['flagSettings', 'cli flag'],
      ['policySettings', 'managed'],
    ]
    for (const [source, label] of cases) {
      expect(allowedToolsSourceLabel(source)).toBe(label)
    }
    // Non-settings sources pass through unchanged (official kb/Pu).
    expect(allowedToolsSourceLabel('bundled')).toBe('bundled')

    gateAllowedToolsAtLoad({
      name: 'deploy',
      source: 'projectSettings',
      allowedTools: ['Bash(git:*)', 'WebFetch'],
    })
    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0].level).toBe('warn')
    expect(debugLogs[0].message).toBe(
      'Ignoring allowed-tools Bash(git:*), WebFetch from /deploy (project): permission rules are restricted to managed settings (allowManagedPermissionRulesOnly).',
    )
  })

  test('gate ON: once-per-session dedupe via the withheld set', () => {
    managedRulesOnly = true
    const command = {
      name: 'deploy',
      source: 'projectSettings',
      allowedTools: ['Bash(git:*)'],
    }
    expect(gateAllowedToolsAtLoad(command)).toEqual([])
    expect(gateAllowedToolsAtLoad(command)).toEqual([])
    expect(gateAllowedToolsAtLoad(command)).toEqual([])
    // Warned exactly once; the session set holds the `/name (label)` key.
    expect(debugLogs).toHaveLength(1)
    expect(getWithheldAllowedToolsSessionSet().has('/deploy (project)')).toBe(
      true,
    )
    expect(
      hasAllowedToolsWithheldWarningBeenShown('deploy', {
        source: 'projectSettings',
      }),
    ).toBe(true)
    // A different name warns separately.
    gateAllowedToolsAtLoad({ ...command, name: 'release' })
    expect(debugLogs).toHaveLength(2)
    expect(getWithheldAllowedToolsSessionSet().size).toBe(2)
  })

  test('withheldAllowedToolsKey: plugin origins key by pluginId, sources by label', () => {
    expect(
      withheldAllowedToolsKey('deploy', { source: 'userSettings' }),
    ).toBe('/deploy (user)')
    expect(
      withheldAllowedToolsKey('myplugin:deploy', {
        pluginId: 'myplugin@marketplace',
      }),
    ).toBe('/myplugin:deploy (myplugin@marketplace)')
  })

  test('telemetry: tengu_frontmatter_grant_withheld with origin mapping', () => {
    managedRulesOnly = true
    gateAllowedToolsAtLoad({
      name: 'deploy',
      source: 'projectSettings',
      allowedTools: ['Bash(git:*)', 'WebFetch'],
    })
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('tengu_frontmatter_grant_withheld')
    expect(events[0].metadata.origin).toBe('projectSettings')
    expect(events[0].metadata.tool_count).toBe(2)

    // Plugin origins map to plugin_skills_dir / plugin_other.
    gateAllowedToolsAtLoad({
      name: 'x',
      source: 'plugin',
      allowedTools: ['Bash'],
      pluginInfo: { repository: 'skills-dir[abc]' },
    })
    expect(events[1].metadata.origin).toBe('plugin_skills_dir')
    // Plugin without an id (repository undefined → "") is untrusted: ku
    // requires id !== undefined.
    gateAllowedToolsAtLoad({
      name: 'y',
      source: 'plugin',
      allowedTools: ['Bash'],
    })
    expect(events[2].metadata.origin).toBe('plugin_other')
  })

  test('pluginIdNamespace: official lC prefix decoding', () => {
    expect(pluginIdNamespace('myplugin@marketplace')).toBeUndefined()
    expect(pluginIdNamespace('inline[abc]')).toBe('inline')
    expect(pluginIdNamespace('synced[abc]')).toBe('synced')
    expect(pluginIdNamespace('skills-dir[abc]')).toBe('skills-dir')
    expect(pluginIdNamespace('plain-id')).toBeUndefined()
  })

  test('sanitizer: official f_ strips control/format chars but keeps tab/newline', () => {
    expect(sanitizeAllowedToolsWarningText('a\u0000b\u001bc')).toBe('abc')
    expect(sanitizeAllowedToolsWarningText('a\tb\nc')).toBe('a\tb\nc')
    expect(sanitizeAllowedToolsWarningText('a\u2028b\u2029c')).toBe('abc')
    expect(sanitizeAllowedToolsWarningText('a\u200bb')).toBe('ab')
    expect(sanitizeAllowedToolsWarningText('plain text')).toBe('plain text')
  })

  test('getAllowedToolsGated: getAllowedTools closure wins; empty list passes through', async () => {
    managedRulesOnly = true
    // Empty tools short-circuit before the trust check (official ZMe).
    expect(
      await getAllowedToolsGated({
        name: 'deploy',
        source: 'projectSettings',
        allowedTools: [],
      }),
    ).toEqual([])
    // Async getAllowedTools closure is awaited and gated the same way.
    expect(
      await getAllowedToolsGated({
        name: 'deploy',
        source: 'userSettings',
        getAllowedTools: async () => ['Bash(git:*)'],
      }),
    ).toEqual([])
    expect(
      await getAllowedToolsGated({
        name: 'deploy',
        source: 'bundled',
        getAllowedTools: async () => ['Bash(git:*)'],
      }),
    ).toEqual(['Bash(git:*)'])
  })

  test('control chars in untrusted names/tools are stripped from the warning', () => {
    managedRulesOnly = true
    gateAllowedToolsAtLoad({
      name: 'de\u0000ploy',
      source: 'userSettings',
      allowedTools: ['Bash\u001b(evil)'],
    })
    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0].message).toBe(
      'Ignoring allowed-tools Bash(evil) from /deploy (user): permission rules are restricted to managed settings (allowManagedPermissionRulesOnly).',
    )
    // The dedupe key is stored sanitized too.
    expect(getWithheldAllowedToolsSessionSet().has('/deploy (user)')).toBe(true)
  })
})
