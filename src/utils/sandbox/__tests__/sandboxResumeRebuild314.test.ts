import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.314 #32 — "Fixed sandbox protections not applying to a worktree
 * entered by `claude -p --resume` or `--continue`."
 *
 * Byte-verified official v314 mechanism (scratch-occ138/v314/package/claude):
 *  - Resume-validation function `YF` @282197900 region gained (vs v312 `yF`
 *    @268280300, otherwise identical) `let h=ve(),y=null;` at the top plus
 *    this NEW block before the persist branch:
 *    `if(!y&&ve()!==h&&kVt()){if(await Re(ui().catch(()=>null),sG),bn(oG,{safe:!0})){let C=!1;try{C=Ke.refreshConfig()}catch(w){JI(w,"configNotRebuilt")}if(!C)return m("sandbox_resume_rebuild","rebuild_failed"),as("Error: could not apply the sandbox's protections to this session's worktree, so the session was not resumed. Run the resume again. If it fails the same way, check the sandbox paths in your settings, or re-run with --fork-session to continue without the worktree.",s),mi(1),!0;g("sandbox_resume_rebuild")}}`
 *  - Symbol resolutions (all byte-verified): `oG="tengu_anchored_lantern"`,
 *    `sG=2000` @281953480; `kVt()` = sandbox-active predicate @250912474;
 *    `Ke` = sandbox manager singleton @250938634; `tb` (refreshConfig)
 *    @250937055: `if(We().configBuildFailed)return!1;if(!Pc())return!0;let
 *    e=Ew();if(e===void 0)return!1;return bi(e),!0`; `Re(promise,ms)` =
 *    timeout-race (undefined on timeout); `ui()` = GrowthBook init/fetch
 *    promise; `m`/`g` = failure/success analytics pair (same convention as
 *    the OCC-ported sandbox_exclude_command events).
 *  - v312 absence verified: "could not apply the sandbox" → 0 hits;
 *    "sandbox_resume_rebuild" → 0 hits.
 *
 * SCOPE NOTE (cluster boundary): this suite covers the SANDBOX-SIDE wiring
 * only (the piece WP-D owns). The caller-side refuse-resume branch
 * (stderr write + exit(1) in the print-mode resume path) lands in the
 * print-mode startup-error region owned by WP-F (item 6) — it is delivered
 * as a reported patch, not an edit, per the cluster instructions.
 *
 * OCC adaptation notes:
 *  - OCC's `refreshConfig()` is void (2.1.292 per-command cadence); the
 *    boolean official `tb` semantics are provided by
 *    `rebuildSandboxConfigForResult` inside the new helper.
 *  - `worktreeMainRepoPath` is cached at initialize() from the pre-resume
 *    cwd; entering a worktree makes it stale, so the rebuild re-detects it
 *    against the new cwd before rebuilding (fs-based detection, no git
 *    subprocess).
 *  - `ui()` maps to `refreshGrowthBookFeatures()` bounded by the official
 *    2000 ms `sG` race.
 */

const actualSettingsModule = await import('../../../utils/settings/settings.js')
const actualAnalyticsModule = await import(
  '../../../services/analytics/index.js'
)
const actualGrowthbookModule = await import(
  '../../../services/analytics/growthbook.js'
)
const actualStateModule = await import('../../../bootstrap/state.js')
const actualDebugModule = await import('../../../utils/debug.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualAnalyticsExports = { ...actualAnalyticsModule }
const actualGrowthbookExports = { ...actualGrowthbookModule }
const actualStateExports = { ...actualStateModule }
const actualDebugExports = { ...actualDebugModule }

let settingsResult: unknown = {}
let settingsThrow: Error | null = null
let currentCwd = '/repo/main'
let anchoredLanternGate = false
let growthBookWaitCalls = 0
let growthBookNeverSettles = false
const loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => {
    if (settingsThrow !== null) {
      throw settingsThrow
    }
    return settingsResult
  },
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsExports,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata })
  },
}))
mock.module('../../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbookExports,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: (gate: string) =>
    gate === 'tengu_anchored_lantern' ? anchoredLanternGate : false,
  refreshGrowthBookFeatures: async () => {
    growthBookWaitCalls += 1
    if (growthBookNeverSettles) {
      await new Promise(() => {})
    }
  },
}))
mock.module('../../../bootstrap/state.js', () => ({
  ...actualStateExports,
  getCwdState: () => currentCwd,
}))
mock.module('../../../utils/debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: () => {},
}))

afterAll(() => {
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsExports,
  }))
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbookExports,
  }))
  mock.module('../../../bootstrap/state.js', () => ({ ...actualStateExports }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugExports }))
})

const {
  SANDBOX_RESUME_REBUILD_GATE,
  SANDBOX_RESUME_GROWTHBOOK_WAIT_MS,
  SANDBOX_RESUME_REBUILD_ERROR_MESSAGE,
  shouldRebuildSandboxOnWorktreeResume,
  refreshSandboxConfigForResumedWorktree,
} = await import('../sandbox-adapter.js')

beforeEach(() => {
  settingsResult = {}
  settingsThrow = null
  currentCwd = '/repo/main'
  anchoredLanternGate = false
  growthBookWaitCalls = 0
  growthBookNeverSettles = false
  loggedEvents.length = 0
})

describe('2.1.314 #32 — official constants (byte-verified)', () => {
  test('gate name is tengu_anchored_lantern (official oG @281953480)', () => {
    expect(SANDBOX_RESUME_REBUILD_GATE).toBe('tengu_anchored_lantern')
  })

  test('GrowthBook wait bound is the official sG=2000ms', () => {
    expect(SANDBOX_RESUME_GROWTHBOOK_WAIT_MS).toBe(2000)
  })

  test('refuse-resume message matches the official string byte-for-byte (@122721011)', () => {
    expect(SANDBOX_RESUME_REBUILD_ERROR_MESSAGE).toBe(
      "Error: could not apply the sandbox's protections to this session's worktree, so the session was not resumed. Run the resume again. If it fails the same way, check the sandbox paths in your settings, or re-run with --fork-session to continue without the worktree.",
    )
  })
})

describe('2.1.314 #32 — shouldRebuildSandboxOnWorktreeResume (official `ve()!==h&&kVt()`)', () => {
  test('cwd unchanged → no rebuild', () => {
    expect(
      shouldRebuildSandboxOnWorktreeResume({
        previousCwd: '/repo/main',
        currentCwd: '/repo/main',
        sandboxActive: true,
      }),
    ).toBe(false)
  })

  test('cwd changed but sandbox not active → no rebuild', () => {
    expect(
      shouldRebuildSandboxOnWorktreeResume({
        previousCwd: '/repo/main',
        currentCwd: '/repo/main/.claude/worktrees/wt',
        sandboxActive: false,
      }),
    ).toBe(false)
  })

  test('cwd changed and sandbox active → rebuild', () => {
    expect(
      shouldRebuildSandboxOnWorktreeResume({
        previousCwd: '/repo/main',
        currentCwd: '/repo/main/.claude/worktrees/wt',
        sandboxActive: true,
      }),
    ).toBe(true)
  })
})

describe('2.1.314 #32 — refreshSandboxConfigForResumedWorktree flow', () => {
  test('cwd unchanged: resolves true, no GrowthBook wait, no analytics', async () => {
    // Act
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main')

    // Assert
    expect(result).toBe(true)
    expect(growthBookWaitCalls).toBe(0)
    expect(loggedEvents).toEqual([])
  })

  test('sandbox not active (no initialization in this process): true, no wait, no analytics', async () => {
    // Arrange — live predicate: initializationPromise undefined in tests
    currentCwd = '/repo/wt'

    // Act
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main')

    // Assert
    expect(result).toBe(true)
    expect(growthBookWaitCalls).toBe(0)
    expect(loggedEvents).toEqual([])
  })

  test('active + gate OFF: waits for GrowthBook, no rebuild analytics, true', async () => {
    // Arrange
    currentCwd = '/repo/wt'
    anchoredLanternGate = false

    // Act
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main', {
      sandboxActive: true,
    })

    // Assert — official: `await Re(ui().catch(()=>null),sG), bn(oG)` gate off
    // skips the whole rebuild block
    expect(result).toBe(true)
    expect(growthBookWaitCalls).toBe(1)
    expect(loggedEvents).toEqual([])
  })

  test('active + gate ON + rebuild succeeds: success analytics event, true', async () => {
    // Arrange — settings mock keeps isSandboxingEnabled() false in the test
    // env, which is the official tb `if(!Pc())return!0` success branch
    currentCwd = '/repo/wt'
    anchoredLanternGate = true

    // Act
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main', {
      sandboxActive: true,
    })

    // Assert — official `g("sandbox_resume_rebuild")`
    expect(result).toBe(true)
    expect(loggedEvents).toEqual([{ name: 'sandbox_resume_rebuild', metadata: {} }])
  })

  test('active + gate ON + config build throws: rebuild_failed analytics, false', async () => {
    // Arrange — official `try{C=Ke.refreshConfig()}catch(w){JI(w,"configNotRebuilt")}`
    currentCwd = '/repo/wt'
    anchoredLanternGate = true
    settingsThrow = new Error('settings read failed')

    // Act
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main', {
      sandboxActive: true,
    })

    // Assert — official `m("sandbox_resume_rebuild","rebuild_failed")` then
    // refuse-resume (the refuse leg itself is WP-F territory, reported)
    expect(result).toBe(false)
    expect(loggedEvents).toEqual([
      { name: 'sandbox_resume_rebuild', metadata: { reason: 'rebuild_failed' } },
    ])
  })

  test('GrowthBook wait is bounded by the official 2000ms race', async () => {
    // Arrange — ui() never settles; Re(promise,2000) must still resolve
    currentCwd = '/repo/wt'
    anchoredLanternGate = false
    growthBookNeverSettles = true

    // Act
    const startedAt = Date.now()
    const result = await refreshSandboxConfigForResumedWorktree('/repo/main', {
      sandboxActive: true,
    })
    const elapsedMs = Date.now() - startedAt

    // Assert — bounded by sG=2000 (+slack), NOT the hung promise
    expect(result).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(1900)
    expect(elapsedMs).toBeLessThan(4000)
  }, 8000)
})
