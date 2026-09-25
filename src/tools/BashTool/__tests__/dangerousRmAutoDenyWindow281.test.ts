/**
 * CC 2.1.281 #137 — dangerous-rm auto-deny window.
 *
 * Official binary evidence (v2.1.281 linux-x64 ELF):
 *   - config `p1()` @201961701: key `tengu_splendid_horizon`, defaults
 *     {enabled:true, showDialog:true, timeoutMs:120000, maxDialogTimeouts:3},
 *     clamps 5000..3600000 ms / integer 0..100, env kill-switch
 *     CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT (raw truthiness).
 *   - counters `hee/Xyt/n7r/Qje` @201962445 (denialTracking.ts).
 *   - resolver `b0t` @203102345 + window `VFt` @202939624.
 *   - dialog timer `oo` @220031905: expiry → deny + counter increment +
 *     `tengu_safety_check_dialog_auto_denied {unansweredThisSession}`;
 *     answered → `Qje()` reset @220028984.
 *   - capped deny + `tengu_safety_check_dialog_capped` @203102747.
 *   - deny text `$0t` @204142297 (byte-compared against the binary-eval'd
 *     function during porting).
 *
 * Repo mock.module template (readTool281.test.ts): snapshot actuals BEFORE
 * mocking, dynamic-import the module under test AFTER registration, restore
 * in afterAll — mock.module leaks across files in the same worker.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test'

const actualAnalytics = {
  ...(await import('../../../services/analytics/index.js')),
}
const actualGrowthbook = {
  ...(await import('../../../services/analytics/growthbook.js')),
}

let loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata })
  },
}))

let gbFeatures: Record<string, unknown> = {}
mock.module('../../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, def: unknown) =>
    key in gbFeatures ? gbFeatures[key] : def,
}))

type DangerousRmModule = typeof import('../dangerousRmAutoDeny.js')
// Cache-busting specifier: isolated instance bound to THIS file's mocks.
const ISOLATED_SPECIFIER = '../dangerousRmAutoDeny.js?occ-dangerous-rm-281'
const {
  buildDangerousRmAutoDenyMessage,
  getDangerousRmAutoDenyConfig,
  resolveDangerousRmAutoDenyConfig,
  resolveDangerousRmSafetyCheck,
  startDangerousRmAutoDenyTimer,
  DANGEROUS_RM_AUTO_DENY_DEFAULTS,
} = (await import(ISOLATED_SPECIFIER)) as DangerousRmModule

// Shared (non-isolated) instance — the module under test imports the same
// resolved path, so counter state is shared exactly like production.
const {
  getUnansweredSafetyDialogCount,
  incrementUnansweredSafetyDialogs,
  resetUnansweredSafetyDialogCount,
} = await import('../../../utils/permissions/denialTracking.js')

const FLAGGED_TEXT = 'Destructive command blocked: rm -rf $UNSET/*'
const KILL_SWITCH_ENV_VAR = 'CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT'

function makeLegacyDeny() {
  return {
    behavior: 'deny' as const,
    message: `Legacy: ${FLAGGED_TEXT}`,
    decisionReason: { type: 'other' as const, reason: FLAGGED_TEXT },
  }
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return loggedEvents.filter((e) => e.name === name).map((e) => e.metadata)
}

beforeEach(() => {
  loggedEvents = []
  gbFeatures = {}
  resetUnansweredSafetyDialogCount()
  delete process.env[KILL_SWITCH_ENV_VAR]
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

afterAll(() => {
  mock.restore()
})

describe('CC 2.1.281 #137: dangerous-rm auto-deny window', () => {
  describe('$0t deny message (verbatim @204142297)', () => {
    test('reproduces the official deny message byte-for-byte', () => {
      const message = buildDangerousRmAutoDenyMessage('rm -rf $HOME')
      expect(message).toBe(
        'Permission for this command was denied by a built-in Claude Code safety check, not by the user. The check stops removals that can delete far more than intended: a system, home or workspace directory, or a target it cannot resolve, such as a shell variable that, if unset or empty, turns this into `rm -rf /` or `rm -rf /*`. Only a person may approve such a removal, and no person did (the permission prompt timed out, or this session cannot prompt). ' +
          `The command was NOT run; do not claim it succeeded. Do not work around the check by splitting, scripting, or re-issuing the removal through another tool or shell: the check exists because a removal like this can destroy the user's data, and getting past it would not make it safe. If the text below suggests a safe rewrite, run that instead; it goes through the same check. Otherwise finish the rest of the task without this removal, tell the user what you wanted to delete and why, and leave the removal to them. What was flagged: rm -rf $HOME`,
      )
    })

    test('inserts the official unanswered-count sentence when a count is given', () => {
      const message = buildDangerousRmAutoDenyMessage('X', 3)
      expect(message).toContain(
        'The prompt for such removals has already gone unanswered 3 times in this session, so it was not shown again. ',
      )
      expect(message).toContain('What was flagged: X')
    })
  })

  describe('auto-deny timer (official oo @220031905)', () => {
    test('auto-denies an unanswered dangerous-rm dialog after the window with the verbatim $0t message + telemetry', async () => {
      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: true,
        config: { ...DANGEROUS_RM_AUTO_DENY_DEFAULTS },
        legacyDeny: makeLegacyDeny(),
        permissionMode: 'default',
      })
      expect(resolution.kind).toBe('prompt-with-auto-deny-window')
      if (resolution.kind !== 'prompt-with-auto-deny-window') return
      expect(resolution.window.autoDenyAfterMs).toBe(120_000)

      // A dialog nobody answers.
      const neverAnswered = new Promise<'allow' | 'deny'>(() => {})
      const pending = startDangerousRmAutoDenyTimer({
        window: resolution.window,
        answered: neverAnswered,
        toolName: 'Bash',
        permissionMode: 'default',
      })

      jest.advanceTimersByTime(119_999)
      // Not yet expired: still pending (no sync resolution possible; assert
      // via the counter/telemetry side effects being absent).
      expect(getUnansweredSafetyDialogCount()).toBe(0)
      expect(eventsNamed('tengu_safety_check_dialog_auto_denied')).toHaveLength(
        0,
      )

      jest.advanceTimersByTime(1)
      const result = await pending
      expect(typeof result).toBe('object')
      if (result === 'answered') throw new Error('expected deny decision')
      expect(result.behavior).toBe('deny')
      expect(result.message).toBe(buildDangerousRmAutoDenyMessage(FLAGGED_TEXT))
      expect(getUnansweredSafetyDialogCount()).toBe(1)

      const telemetry = eventsNamed('tengu_safety_check_dialog_auto_denied')
      expect(telemetry).toHaveLength(1)
      expect(telemetry[0]).toMatchObject({
        toolName: 'Bash',
        isMcp: false,
        permissionMode: 'default',
        promptSurface: 'terminal',
        timeoutMs: 120_000,
        unansweredThisSession: 1,
      })
      expect(typeof telemetry[0].elapsedMs).toBe('number')
    })

    test('an answered dialog resets the session counter and cancels the timer', async () => {
      incrementUnansweredSafetyDialogs()
      incrementUnansweredSafetyDialogs()
      expect(getUnansweredSafetyDialogCount()).toBe(2)

      let answer!: (v: 'allow' | 'deny') => void
      const answered = new Promise<'allow' | 'deny'>((r) => {
        answer = r
      })
      const pending = startDangerousRmAutoDenyTimer({
        window: {
          autoDenyAfterMs: 120_000,
          autoDenyResolution: {
            behavior: 'deny' as const,
            message: buildDangerousRmAutoDenyMessage(FLAGGED_TEXT),
            decisionReason: { type: 'other' as const, reason: FLAGGED_TEXT },
          },
        },
        answered,
        toolName: 'Bash',
      })

      answer('allow')
      const result = await pending
      expect(result).toBe('answered')
      // Official Qje() @220028984: any answered dialog resets the counter.
      expect(getUnansweredSafetyDialogCount()).toBe(0)

      // The cleared timer must not fire afterwards.
      jest.advanceTimersByTime(500_000)
      expect(
        eventsNamed('tengu_safety_check_dialog_auto_denied'),
      ).toHaveLength(0)
      expect(getUnansweredSafetyDialogCount()).toBe(0)
    })

    test('each unanswered timeout increments the session counter (unansweredThisSession)', async () => {
      const makeWindow = () => ({
        autoDenyAfterMs: 120_000,
        autoDenyResolution: {
          behavior: 'deny' as const,
          message: buildDangerousRmAutoDenyMessage(FLAGGED_TEXT),
          decisionReason: { type: 'other' as const, reason: FLAGGED_TEXT },
        },
      })
      for (const expected of [1, 2]) {
        const pending = startDangerousRmAutoDenyTimer({
          window: makeWindow(),
          answered: new Promise<'allow' | 'deny'>(() => {}),
          toolName: 'Bash',
        })
        jest.advanceTimersByTime(120_000)
        await pending
        expect(getUnansweredSafetyDialogCount()).toBe(expected)
      }
      const telemetry = eventsNamed('tengu_safety_check_dialog_auto_denied')
      expect(telemetry.map((t) => t.unansweredThisSession)).toEqual([1, 2])
    })
  })

  describe('dialog cap (official b0t @203102747)', () => {
    test('after maxDialogTimeouts unanswered dialogs, denies immediately with the capped message + capped telemetry', () => {
      incrementUnansweredSafetyDialogs()
      incrementUnansweredSafetyDialogs()
      incrementUnansweredSafetyDialogs()

      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: true,
        config: { ...DANGEROUS_RM_AUTO_DENY_DEFAULTS },
        legacyDeny: makeLegacyDeny(),
        permissionMode: 'auto',
      })
      expect(resolution.kind).toBe('deny')
      if (resolution.kind !== 'deny') return
      // Official capped path passes the count to $0t (h(_)).
      expect(resolution.decision.message).toContain(
        'The prompt for such removals has already gone unanswered 3 times in this session, so it was not shown again.',
      )
      expect(resolution.decision.message).toContain(
        `What was flagged: ${FLAGGED_TEXT}`,
      )

      const capped = eventsNamed('tengu_safety_check_dialog_capped')
      expect(capped).toHaveLength(1)
      expect(capped[0]).toMatchObject({
        permissionMode: 'auto',
        unansweredPrompts: 3,
        maxDialogTimeouts: 3,
      })
    })

    test('an answered dialog after timeouts re-enables prompting (counter reset)', () => {
      incrementUnansweredSafetyDialogs()
      incrementUnansweredSafetyDialogs()
      incrementUnansweredSafetyDialogs()
      resetUnansweredSafetyDialogCount()

      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: true,
        config: { ...DANGEROUS_RM_AUTO_DENY_DEFAULTS },
        legacyDeny: makeLegacyDeny(),
      })
      expect(resolution.kind).toBe('prompt-with-auto-deny-window')
      expect(eventsNamed('tengu_safety_check_dialog_capped')).toHaveLength(0)
    })
  })

  describe('kill-switch + cannot-prompt branch (official p1/b0t)', () => {
    test('CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT=1 disables the feature: legacy deny, no timer', () => {
      process.env[KILL_SWITCH_ENV_VAR] = '1'
      const config = getDangerousRmAutoDenyConfig()
      expect(config.enabled).toBe(false)

      const legacyDeny = makeLegacyDeny()
      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: true,
        config,
        legacyDeny,
      })
      expect(resolution.kind).toBe('deny')
      if (resolution.kind !== 'deny') return
      // Feature off → the pre-2.1.281 deny is returned UNCHANGED (no $0t).
      expect(resolution.decision).toBe(legacyDeny)
      expect(loggedEvents).toHaveLength(0)
    })

    test('official kill-switch uses raw env truthiness — even "0" disables', () => {
      process.env[KILL_SWITCH_ENV_VAR] = '0'
      expect(getDangerousRmAutoDenyConfig().enabled).toBe(false)
      process.env[KILL_SWITCH_ENV_VAR] = ''
      expect(getDangerousRmAutoDenyConfig().enabled).toBe(true)
    })

    test('a session that cannot prompt gets the immediate $0t deny without the count sentence', () => {
      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: false,
        config: { ...DANGEROUS_RM_AUTO_DENY_DEFAULTS },
        legacyDeny: makeLegacyDeny(),
      })
      expect(resolution.kind).toBe('deny')
      if (resolution.kind !== 'deny') return
      expect(resolution.decision.message).toBe(
        buildDangerousRmAutoDenyMessage(FLAGGED_TEXT),
      )
      expect(resolution.decision.message).not.toContain('gone unanswered')
      expect(loggedEvents).toHaveLength(0)
    })

    test('showDialog:false also takes the immediate $0t deny branch', () => {
      const resolution = resolveDangerousRmSafetyCheck({
        flaggedText: FLAGGED_TEXT,
        canShowDialog: true,
        config: { ...DANGEROUS_RM_AUTO_DENY_DEFAULTS, showDialog: false },
        legacyDeny: makeLegacyDeny(),
      })
      expect(resolution.kind).toBe('deny')
      if (resolution.kind !== 'deny') return
      expect(resolution.decision.message).toBe(
        buildDangerousRmAutoDenyMessage(FLAGGED_TEXT),
      )
    })
  })

  describe('config resolution (official p1 @201961701)', () => {
    test('defaults match the official gee object', () => {
      expect(resolveDangerousRmAutoDenyConfig(undefined, false)).toEqual({
        enabled: true,
        showDialog: true,
        timeoutMs: 120_000,
        maxDialogTimeouts: 3,
      })
    })

    test('timeoutMs is clamped to [5000, 3600000] — out-of-bounds/invalid falls back to 120000', () => {
      const cases: Array<[unknown, number]> = [
        [4_999, 120_000],
        [5_000, 5_000],
        [60_000, 60_000],
        [3_600_000, 3_600_000],
        [3_600_001, 120_000],
        [Number.NaN, 120_000],
        [Number.POSITIVE_INFINITY, 120_000],
        ['60000', 120_000],
        [null, 120_000],
      ]
      for (const [input, expected] of cases) {
        expect(
          resolveDangerousRmAutoDenyConfig({ timeoutMs: input }, false)
            .timeoutMs,
        ).toBe(expected)
      }
    })

    test('maxDialogTimeouts must be an integer in [0, 100] — invalid falls back to 3', () => {
      const cases: Array<[unknown, number]> = [
        [0, 0],
        [100, 100],
        [101, 3],
        [-1, 3],
        [2.5, 3],
        ['3', 3],
        [undefined, 3],
      ]
      for (const [input, expected] of cases) {
        expect(
          resolveDangerousRmAutoDenyConfig({ maxDialogTimeouts: input }, false)
            .maxDialogTimeouts,
        ).toBe(expected)
      }
    })

    test('boolean enabled/showDialog overrides are honored; non-boolean values fall back to defaults', () => {
      expect(
        resolveDangerousRmAutoDenyConfig({ enabled: false }, false).enabled,
      ).toBe(false)
      expect(
        resolveDangerousRmAutoDenyConfig({ enabled: 'false' }, false).enabled,
      ).toBe(true)
      expect(
        resolveDangerousRmAutoDenyConfig({ showDialog: false }, false)
          .showDialog,
      ).toBe(false)
    })

    test('reads the tengu_splendid_horizon remote key through the OCC growthbook accessor', () => {
      gbFeatures.tengu_splendid_horizon = {
        timeoutMs: 30_000,
        maxDialogTimeouts: 5,
        showDialog: false,
      }
      const config = getDangerousRmAutoDenyConfig()
      expect(config).toEqual({
        enabled: true,
        showDialog: false,
        timeoutMs: 30_000,
        maxDialogTimeouts: 5,
      })
    })

    test('kill-switch beats a remote enabled:true', () => {
      gbFeatures.tengu_splendid_horizon = { enabled: true }
      process.env[KILL_SWITCH_ENV_VAR] = '1'
      expect(getDangerousRmAutoDenyConfig().enabled).toBe(false)
    })
  })
})
