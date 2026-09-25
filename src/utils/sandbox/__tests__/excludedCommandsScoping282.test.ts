import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.282 (P1): sandbox.excludedCommands trusted-tier scoping.
 *
 * Official mechanism (byte-verified against the 2.1.282 linux-x64 ELF):
 *  - Gate `vO()` @~199146800: GrowthBook `forbidUnsandboxedCommands`
 *    (`_O()`, stubbed false in OCC — no GrowthBook gate wiring) OR any
 *    managed tier sets `sandbox.network.allowManagedDomainsOnly: true`
 *    (`m4()`, binary `Xu()` = policy allTiers) OR (policy ?? flagSettings)
 *    sets `sandbox.allowUnsandboxedCommands: false`.
 *  - Read path `IJ()` (getExcludedCommands): gate closed → merged settings
 *    list (2.1.281 behavior). Gate open → `q$n()` = uniq of
 *    [policy, flag, user-if-enabled] excludedCommands + one-time byte-exact
 *    warning counting the dropped repo-scoped entries.
 *  - Write path `OIt()` @199158943 (addToExcludedCommands): gate open +
 *    userSettings disabled → refuse with telemetry reason
 *    `user_settings_disabled`; otherwise target = gate open ? userSettings :
 *    localSettings; result carries `outcome` (2.1.281 returned a bare
 *    commandPattern string).
 *  - Schema: excludedCommands .describe() = base sentence + `Md`
 *    (@194525877/@194547946), both new in 2.1.282.
 *
 * Mock.module hygiene per OCC-97: snapshot real namespaces before mocking,
 * restore in afterAll.
 */

type SandboxSettingsShape = {
  sandbox?: {
    excludedCommands?: string[]
    allowUnsandboxedCommands?: boolean
    network?: { allowManagedDomainsOnly?: boolean }
  }
} | null

const settingsBySource: Record<string, SandboxSettingsShape> = {}
let mergedSettings: { sandbox?: { excludedCommands?: string[] } } = {}
let userSettingsEnabled = true
let sandboxingEnabled = true

const writes: Array<{ source: string; patch: SandboxSettingsShape }> = []
const debugLines: string[] = []
const events: Array<{ name: string; metadata: Record<string, unknown> }> = []

// NOTE: bun's mock.module mutates the captured namespace object in place when
// the mock registers — spreading the live namespace later (mock factory OR
// afterAll restore) would capture/restore the MOCK itself. Snapshot every
// real namespace into a plain object BEFORE any mock.module call (the
// sandboxExcludedCommandsEveryPart277 suite pattern).
const actualSettingsModule = await import('../../../utils/settings/settings.js')
const actualConstantsModule = await import(
  '../../../utils/settings/constants.js'
)
const actualDebugModule = await import('../../../utils/debug.js')
const actualAnalyticsModule = await import(
  '../../../services/analytics/index.js'
)
const actualSettingsExports = { ...actualSettingsModule }
const actualConstantsExports = { ...actualConstantsModule }
const actualDebugExports = { ...actualDebugModule }
const actualAnalyticsExports = { ...actualAnalyticsModule }
const realIsSettingSourceEnabled = actualConstantsExports.isSettingSourceEnabled

mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mergedSettings,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
  updateSettingsForSource: (source: string, patch: SandboxSettingsShape) => {
    writes.push({ source, patch })
    return { error: null }
  },
}))
mock.module('../../../utils/settings/constants.js', () => ({
  ...actualConstantsExports,
  isSettingSourceEnabled: (source: string) =>
    source === 'userSettings'
      ? userSettingsEnabled
      : realIsSettingSourceEnabled(
          source as Parameters<typeof realIsSettingSourceEnabled>[0],
        ),
}))
mock.module('../../../utils/debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: (message: string) => {
    debugLines.push(message)
  },
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsExports,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    events.push({ name, metadata })
  },
}))

// Import the REAL adapter (with the mocked deps above) — these exports keep
// their real module state (warning latch, gate, getter).
const realAdapter = await import('../sandbox-adapter.js')

const actualAdapterExports = { ...realAdapter }

// shouldUseSandbox reads SandboxManager.isSandboxingEnabled /
// areUnsandboxedCommandsAllowed — pin them so the tests exercise ONLY the
// excludedCommands path. getExcludedCommands stays the REAL function.
mock.module('../sandbox-adapter.js', () => ({
  ...actualAdapterExports,
  SandboxManager: {
    ...actualAdapterExports.SandboxManager,
    isSandboxingEnabled: () => sandboxingEnabled,
    areUnsandboxedCommandsAllowed: () => true,
  },
}))

const { shouldUseSandbox } = await import(
  '../../../tools/BashTool/shouldUseSandbox.js'
)
const { SandboxSettingsSchema } = await import(
  '../../../entrypoints/sandboxTypes.js'
)
const {
  addToExcludedCommands,
  shouldRestrictExcludedCommands,
  _resetExcludedCommandsWarningForTesting,
  SandboxManager: RealSandboxManager,
} = realAdapter

afterAll(() => {
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../../utils/settings/constants.js', () => ({
    ...actualConstantsExports,
  }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugExports }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsExports,
  }))
  mock.module('../sandbox-adapter.js', () => ({ ...actualAdapterExports }))
})

let savedUserType: string | undefined
beforeEach(() => {
  savedUserType = process.env.USER_TYPE
  delete process.env.USER_TYPE
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  mergedSettings = {}
  userSettingsEnabled = true
  sandboxingEnabled = true
  writes.length = 0
  debugLines.length = 0
  events.length = 0
  _resetExcludedCommandsWarningForTesting()
})

afterAll(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

describe('CC 2.1.282 P1 — shouldRestrictExcludedCommands gate (binary vO)', () => {
  test('gate closed by default (2.1.281 behavior)', () => {
    expect(shouldRestrictExcludedCommands()).toBe(false)
  })

  test('policySettings sandbox.allowUnsandboxedCommands:false opens the gate', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    expect(shouldRestrictExcludedCommands()).toBe(true)
  })

  test('flagSettings variant opens the gate when policy says nothing', () => {
    settingsBySource.flagSettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    expect(shouldRestrictExcludedCommands()).toBe(true)
  })

  test('policy allowUnsandboxedCommands:true wins over flag false (official ?? chain)', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: true },
    }
    settingsBySource.flagSettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    expect(shouldRestrictExcludedCommands()).toBe(false)
  })

  test('managed sandbox.network.allowManagedDomainsOnly:true opens the gate', () => {
    settingsBySource.policySettings = {
      sandbox: { network: { allowManagedDomainsOnly: true } },
    }
    expect(shouldRestrictExcludedCommands()).toBe(true)
  })

  test('allowUnsandboxedCommands left undefined everywhere keeps the gate closed', () => {
    settingsBySource.policySettings = { sandbox: {} }
    settingsBySource.flagSettings = { sandbox: {} }
    expect(shouldRestrictExcludedCommands()).toBe(false)
  })
})

describe('CC 2.1.282 P1 — getExcludedCommands trusted-tier filter (binary IJ)', () => {
  test('gate closed: merged settings list returned unchanged, no warning', () => {
    mergedSettings = { sandbox: { excludedCommands: ['git:*', 'npm:*'] } }
    settingsBySource.projectSettings = {
      sandbox: { excludedCommands: ['git:*', 'npm:*'] },
    }

    expect(RealSandboxManager.getExcludedCommands()).toEqual(['git:*', 'npm:*'])
    expect(debugLines).toEqual([])
  })

  test('gate open: only trusted tiers (policy → flag → user), repo entries dropped', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['policy-cmd:*'] },
    }
    settingsBySource.flagSettings = {
      sandbox: { excludedCommands: ['flag-cmd:*'] },
    }
    settingsBySource.userSettings = {
      sandbox: { excludedCommands: ['user-cmd:*'] },
    }
    mergedSettings = {
      sandbox: {
        excludedCommands: ['policy-cmd:*', 'flag-cmd:*', 'user-cmd:*', 'repo-cmd:*'],
      },
    }

    expect(RealSandboxManager.getExcludedCommands()).toEqual([
      'policy-cmd:*',
      'flag-cmd:*',
      'user-cmd:*',
    ])
  })

  test('one-time byte-exact warning counts dropped repo entries (singular)', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['policy-cmd:*'] },
    }
    mergedSettings = {
      sandbox: { excludedCommands: ['policy-cmd:*', 'repo-cmd:*'] },
    }

    RealSandboxManager.getExcludedCommands()

    expect(debugLines).toEqual([
      '[sandbox] excludedCommands restricted to trusted settings tiers: ignoring 1 sandbox.excludedCommands entry not set by managed, --settings, or user settings',
    ])
  })

  test('warning plural form + one-time latch across calls', () => {
    settingsBySource.flagSettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    mergedSettings = {
      sandbox: { excludedCommands: ['repo-a:*', 'repo-b:*'] },
    }

    expect(RealSandboxManager.getExcludedCommands()).toEqual([])
    expect(debugLines).toEqual([
      '[sandbox] excludedCommands restricted to trusted settings tiers: ignoring 2 sandbox.excludedCommands entries not set by managed, --settings, or user settings',
    ])

    // Second call: latch holds, no repeat warning.
    RealSandboxManager.getExcludedCommands()
    expect(debugLines.length).toBe(1)
  })

  test('gate open + userSettings source disabled: user tier is not trusted either', () => {
    userSettingsEnabled = false
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['policy-cmd:*'] },
    }
    settingsBySource.userSettings = {
      sandbox: { excludedCommands: ['user-cmd:*'] },
    }
    mergedSettings = {
      sandbox: { excludedCommands: ['policy-cmd:*', 'user-cmd:*'] },
    }

    expect(RealSandboxManager.getExcludedCommands()).toEqual(['policy-cmd:*'])
  })

  test('dedupe: same pattern from multiple trusted tiers appears once, policy first', () => {
    settingsBySource.policySettings = {
      sandbox: { network: { allowManagedDomainsOnly: true }, excludedCommands: ['git:*'] },
    }
    settingsBySource.flagSettings = {
      sandbox: { excludedCommands: ['git:*', 'npm:*'] },
    }
    mergedSettings = { sandbox: { excludedCommands: ['git:*', 'npm:*'] } }

    expect(RealSandboxManager.getExcludedCommands()).toEqual(['git:*', 'npm:*'])
    // Nothing dropped → no warning.
    expect(debugLines).toEqual([])
  })
})

describe('CC 2.1.282 P1 — shouldUseSandbox reads the FILTERED list (no bypass)', () => {
  test('gate open: project-only exclusion no longer exempts the command', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    settingsBySource.projectSettings = {
      sandbox: { excludedCommands: ['git:*'] },
    }
    mergedSettings = { sandbox: { excludedCommands: ['git:*'] } }

    // 2.1.281 would return false here (exempted) — the repo-committed
    // exclusion is now ignored, so the command stays sandboxed.
    expect(shouldUseSandbox({ command: 'git status' })).toBe(true)
  })

  test('gate open: trusted user-tier exclusion still exempts', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    settingsBySource.userSettings = {
      sandbox: { excludedCommands: ['git:*'] },
    }
    mergedSettings = { sandbox: { excludedCommands: ['git:*'] } }

    expect(shouldUseSandbox({ command: 'git status' })).toBe(false)
  })

  test('gate closed: merged exclusion exempts (2.1.281 behavior preserved)', () => {
    settingsBySource.projectSettings = {
      sandbox: { excludedCommands: ['git:*'] },
    }
    mergedSettings = { sandbox: { excludedCommands: ['git:*'] } }

    expect(shouldUseSandbox({ command: 'git status' })).toBe(false)
  })
})

describe('CC 2.1.282 P1 — addToExcludedCommands write path (binary OIt)', () => {
  test('gate closed: writes to localSettings, outcome "added" (plus telemetry)', () => {
    settingsBySource.localSettings = { sandbox: {} }

    const result = addToExcludedCommands('docker')

    expect(result).toEqual({
      outcome: 'added',
      commandPattern: 'docker',
      settingsSource: 'localSettings',
    })
    expect(writes.length).toBe(1)
    expect(writes[0]!.source).toBe('localSettings')
    expect(writes[0]!.patch).toEqual({
      sandbox: { excludedCommands: ['docker'] },
    })
    expect(events.map((event) => event.name)).toEqual(['sandbox_exclude_command'])
  })

  test('gate open + userSettings enabled: redirect to userSettings', () => {
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }
    settingsBySource.userSettings = {
      sandbox: { excludedCommands: ['git:*'] },
    }

    const result = addToExcludedCommands('docker')

    expect(result).toEqual({
      outcome: 'added',
      commandPattern: 'docker',
      settingsSource: 'userSettings',
    })
    expect(writes.length).toBe(1)
    expect(writes[0]!.source).toBe('userSettings')
    expect(writes[0]!.patch).toEqual({
      sandbox: { excludedCommands: ['git:*', 'docker'] },
    })
  })

  test('gate open + userSettings disabled: refused, no write, telemetry reason byte-exact', () => {
    userSettingsEnabled = false
    settingsBySource.policySettings = {
      sandbox: { allowUnsandboxedCommands: false },
    }

    const result = addToExcludedCommands('docker')

    expect(result).toEqual({ outcome: 'refused', commandPattern: 'docker' })
    expect(writes).toEqual([])
    expect(events).toEqual([
      {
        name: 'sandbox_exclude_command',
        metadata: { reason: 'user_settings_disabled' },
      },
    ])
  })

  test('already-present pattern: no write, still outcome "added" + telemetry', () => {
    settingsBySource.localSettings = {
      sandbox: { excludedCommands: ['docker'] },
    }

    const result = addToExcludedCommands('docker')

    expect(result).toEqual({
      outcome: 'added',
      commandPattern: 'docker',
      settingsSource: 'localSettings',
    })
    expect(writes).toEqual([])
    expect(events.map((event) => event.name)).toEqual(['sandbox_exclude_command'])
  })

  test('Bash permission-rule suggestion still extracts the command pattern', () => {
    settingsBySource.localSettings = { sandbox: {} }

    const result = addToExcludedCommands('npm run test -- --watch', [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }] },
    ])

    expect(result).toEqual({
      outcome: 'added',
      commandPattern: 'npm run test',
      settingsSource: 'localSettings',
    })
  })
})

describe('CC 2.1.282 P1 — excludedCommands schema describe (binary Md)', () => {
  test('describe carries the official base sentence + the 282 restriction sentence', () => {
    const schema = SandboxSettingsSchema()
    const description =
      (
        schema.shape.excludedCommands._def as { description?: string } | undefined
      )?.description ??
      (schema.shape.excludedCommands as unknown as { description?: string })
        .description
    expect(description).toBe(
      'Command patterns (Bash permission-rule syntax) that always run outside the sandbox. A convenience, not a security boundary: excluded commands still go through the permission flow. Merged across settings sources. ' +
        'When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored.',
    )
  })
})
