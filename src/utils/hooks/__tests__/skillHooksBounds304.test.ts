// CC 2.1.304 #60 — skill hooks bounds (1024 hooks + 16384 matcher chars per
// source per session, memoized verdicts, capped warns, telemetry) and
// CC 2.1.304 #39 — a skill's once:true hook removal is scoped to its own
// skillRoot so an identical hook from another skill survives.
//
// Official references (docs/gap-research-304/research-R4-skills-hooks.md):
//   #60 `yt` (s304 24873529): ledger `{hooks,characters,texts,unfitTexts}`
//       keyed by plugin id ?? source kind; ask = Σ max(1, hooks.length) /
//       Σ (matcher?.length ?? 0) × max(1, hooks.length); characters checked
//       BEFORE count; memo per (skillName, hooks); warn cap Kt=64 with
//       silent early return at cap; tengu_skill_hooks_bounds_checked.
//   #39 `St` (s304 24874527): removal gained `{skillRoot:s}` identity.
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AppState } from 'src/state/AppState.js'
import * as analytics from '../../../services/analytics/index.js'
import * as debug from '../../debug.js'
import type { HooksSettings } from '../../settings/types.js'
import {
  registerSkillHooks,
  resetSkillHooksLedgerForTesting,
  SKILL_HOOKS_BOUND,
  SKILL_HOOKS_KEPT_OUT_NOTICE,
  SKILL_MATCHER_CHARS_BOUND,
  type SkillHooksUnfitReason,
} from '../registerSkillHooks.js'
import { removeSessionHook } from '../sessionHooks.js'

const SESSION_ID = 'session-bounds-304'

/** Local mirror of sessionHooks' non-exported SessionHookMatcher shape. */
type Matcher = {
  matcher: string
  skillRoot?: string
  hooks: Array<{ hook: unknown; onHookSuccess?: () => void }>
}

function makeFakeState() {
  const appState = {
    sessionHooks: new Map<string, { hooks: Record<string, Matcher[]> }>(),
  } as unknown as AppState
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    const next = updater(appState)
    Object.assign(appState, next)
  }
  return { appState, setAppState }
}

function registeredMatchers(appState: AppState, event = 'PreToolUse'): Matcher[] {
  const store = appState.sessionHooks.get(SESSION_ID) as unknown as
    | { hooks: Record<string, Matcher[]> }
    | undefined
  return store?.hooks[event] ?? []
}

function commandHook(command: string, once = false): unknown {
  return { type: 'command', command, ...(once ? { once: true } : {}) }
}

function hooksWith(
  matcher: string,
  hookCount: number,
  prefix = 'h',
  once = false,
): HooksSettings {
  return {
    PreToolUse: [
      {
        matcher,
        hooks: Array.from({ length: hookCount }, (_, i) =>
          commandHook(`${prefix}-${i}`, once),
        ),
      },
    ],
  } as unknown as HooksSettings
}

let logEventSpy: ReturnType<typeof spyOn>
let debugSpy: ReturnType<typeof spyOn>

function telemetryCalls(): Array<{ name: string; metadata: Record<string, unknown> }> {
  return logEventSpy.mock.calls.map((c: unknown[]) => ({
    name: String(c[0]),
    metadata: c[1] as Record<string, unknown>,
  }))
}

function boundsEvents() {
  return telemetryCalls().filter(
    e => e.name === 'tengu_skill_hooks_bounds_checked',
  )
}

function warnMessages(): string[] {
  return debugSpy.mock.calls.map((c: unknown[]) => String(c[0]))
}

beforeEach(() => {
  resetSkillHooksLedgerForTesting()
  // Bun's spyOn returns the SAME mock when re-spying an already-spied
  // export, so explicitly clear accumulated calls between tests.
  logEventSpy = spyOn(analytics, 'logEvent').mockImplementation(() => {})
  logEventSpy.mockClear()
  debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})
  debugSpy.mockClear()
})

afterAll(() => {
  // Bun test shares ONE process across files; an unrestored spyOn export leaks
  // into later files' own spyOn calls (they get the same accumulating mock —
  // agentHookTrust.test.ts observed stale calls from this file). Restore the
  // original implementations so subsequent files spy on a clean export.
  logEventSpy.mockRestore()
  debugSpy.mockRestore()
})

describe('registerSkillHooks bounds (CC 2.1.304 #60)', () => {
  test('fits: registers hooks, returns undefined, telemetry outcome=fits with official field shape', () => {
    // Arrange
    const { appState, setAppState } = makeFakeState()

    // Act
    const reason = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 2),
      'skill-fits',
      '/skills/fits',
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(reason).toBeUndefined()
    const matchers = registeredMatchers(appState)
    expect(matchers).toHaveLength(1)
    expect(matchers[0]!.hooks).toHaveLength(2)
    const events = boundsEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.metadata).toEqual({
      outcome: 'fits',
      source_kind: 'userSettings',
      hooks_asked: 2,
      characters_asked: 8, // 'Bash'.length (4) × max(1, 2 hooks)
      hooks_drawn_before: 0,
      characters_drawn_before: 0,
      hooks_bound: SKILL_HOOKS_BOUND,
      characters_bound: SKILL_MATCHER_CHARS_BOUND,
    })
  })

  test('count bound: 1025 hooks refused with reason=count, registers NOTHING', () => {
    // Arrange
    const { appState, setAppState } = makeFakeState()

    // Act
    const reason = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', SKILL_HOOKS_BOUND + 1),
      'skill-count',
      undefined,
      { sourceKind: 'plugin' },
    )

    // Assert
    expect(reason).toBe('count')
    expect(registeredMatchers(appState)).toHaveLength(0)
    const events = boundsEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.metadata.outcome).toBe('count')
    expect(events[0]!.metadata.hooks_asked).toBe(SKILL_HOOKS_BOUND + 1)
    // Official warn text, verbatim shape
    const warns = warnMessages().filter(m =>
      m.includes('registers none of its hooks and grants no tools'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toBe(
      `Skill 'skill-count' registers none of its hooks and grants no tools (count): the skills of one source hold at most ${SKILL_HOOKS_BOUND} hooks and ${SKILL_MATCHER_CHARS_BOUND} characters of matchers in a session, and a cloud session tests some matchers only`,
    )
  })

  test('characters bound: 16385 matcher chars refused with reason=characters', () => {
    // Arrange
    const { appState, setAppState } = makeFakeState()

    // Act
    const reason = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('x'.repeat(SKILL_MATCHER_CHARS_BOUND + 1), 1),
      'skill-chars',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(reason).toBe('characters')
    expect(registeredMatchers(appState)).toHaveLength(0)
    expect(boundsEvents()[0]!.metadata.outcome).toBe('characters')
    expect(boundsEvents()[0]!.metadata.characters_asked).toBe(
      SKILL_MATCHER_CHARS_BOUND + 1,
    )
  })

  test('characters bound is checked BEFORE count bound (official order)', () => {
    // Arrange — a single matcher violating both bounds
    const { setAppState } = makeFakeState()

    // Act
    const reason = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('x'.repeat(SKILL_MATCHER_CHARS_BOUND + 1), SKILL_HOOKS_BOUND + 1),
      'skill-both',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(reason).toBe('characters')
  })

  test('matcher chars multiply by hook count; draws accumulate across skills of one source', () => {
    // Arrange
    const { appState, setAppState } = makeFakeState()
    // First skill draws 8000 characters (8000-char matcher × 1 hook)
    const first = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('a'.repeat(8000), 1),
      'skill-draw-1',
      undefined,
      { sourceKind: 'userSettings' },
    )
    // Second skill asks 8000 × 1 = cumulative 16000 ≤ 16384 → fits
    const second = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('b'.repeat(8000), 1),
      'skill-draw-2',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Act — third skill asks 400 × 1 = cumulative 16400 > 16384 → refused
    const third = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('c'.repeat(400), 1),
      'skill-draw-3',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(third).toBe('characters')
    expect(registeredMatchers(appState)).toHaveLength(2)
    const events = boundsEvents()
    expect(events[2]!.metadata.characters_drawn_before).toBe(16000)
    expect(events[2]!.metadata.hooks_drawn_before).toBe(2)
  })

  test('empty hooks array counts as 1 hook (official max(1, hooks.length))', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    const emptyMatcher = {
      PreToolUse: [{ matcher: 'Bash', hooks: [] }],
    } as unknown as HooksSettings

    // Act
    const reason = registerSkillHooks(
      setAppState,
      SESSION_ID,
      emptyMatcher,
      'skill-empty',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(reason).toBeUndefined()
    const events = boundsEvents()
    expect(events[0]!.metadata.hooks_asked).toBe(1)
    expect(events[0]!.metadata.characters_asked).toBe(4)
  })

  test('count bound accumulates across skills: 1000 + 30 refused, then 20 fits at exactly 1024', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 1000, 'a'),
      'skill-1000',
      undefined,
      { sourceKind: 'projectSettings' },
    )

    // Act
    const overAsk = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 30, 'b'),
      'skill-30',
      undefined,
      { sourceKind: 'projectSettings' },
    )
    const exactAsk = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 24, 'c'),
      'skill-24',
      undefined,
      { sourceKind: 'projectSettings' },
    )

    // Assert — 1000+30 > 1024 refused; 1000+24 = 1024 fits (bound is >, not >=)
    expect(overAsk).toBe('count')
    expect(exactAsk).toBeUndefined()
  })

  test('ledger is keyed by plugin id ?? source kind (independent plugins do not share draws)', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    const p1 = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', SKILL_HOOKS_BOUND, 'p1'),
      'skill-p1',
      undefined,
      { sourceKind: 'plugin', pluginId: 'plugin-one' },
    )

    // Act — a different plugin gets its own full budget; plugin-one is spent
    const p2 = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', SKILL_HOOKS_BOUND, 'p2'),
      'skill-p2',
      undefined,
      { sourceKind: 'plugin', pluginId: 'plugin-two' },
    )
    const p1Again = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 1, 'p1b'),
      'skill-p1-again',
      undefined,
      { sourceKind: 'plugin', pluginId: 'plugin-one' },
    )

    // Assert
    expect(p1).toBeUndefined()
    expect(p2).toBeUndefined()
    expect(p1Again).toBe('count')
    // Telemetry source_kind is the SOURCE KIND (official `c(o)`), not the plugin id
    expect(boundsEvents().every(e => e.metadata.source_kind === 'plugin')).toBe(
      true,
    )
  })

  test('memo: identical (skillName, hooks) verdict returns without new telemetry, warn, or draw', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    const overHooks = hooksWith('Bash', SKILL_HOOKS_BOUND + 1, 'over')
    const first: SkillHooksUnfitReason | undefined = registerSkillHooks(
      setAppState,
      SESSION_ID,
      overHooks,
      'skill-memo',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Act — replay the exact same skill
    const second = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', SKILL_HOOKS_BOUND + 1, 'over'),
      'skill-memo',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert — memo hit: same verdict, no second telemetry event, no second warn
    expect(first).toBe('count')
    expect(second).toBe('count')
    expect(boundsEvents()).toHaveLength(1)
    expect(
      warnMessages().filter(m =>
        m.includes('registers none of its hooks and grants no tools'),
      ),
    ).toHaveLength(1)
  })

  test('memo on fits: a replayed fitting skill does not double-draw the ledger', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    const drawn = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 1000, 'a'),
      'skill-drawn',
      undefined,
      { sourceKind: 'userSettings' },
    )
    const replay = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 1000, 'a'),
      'skill-drawn',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Act — 1000 + 24 = 1024 fits only if the replay did NOT draw again
    const after = registerSkillHooks(
      setAppState,
      SESSION_ID,
      hooksWith('Bash', 24, 'b'),
      'skill-after',
      undefined,
      { sourceKind: 'userSettings' },
    )

    // Assert
    expect(drawn).toBeUndefined()
    expect(replay).toBeUndefined()
    expect(after).toBeUndefined()
    expect(boundsEvents()).toHaveLength(2) // replay was a memo hit
  })

  test('warn cap: 64 warns per source, then refusals stay silent (official Kt early return)', () => {
    // Arrange
    const { setAppState } = makeFakeState()
    const overHooks = hooksWith('Bash', SKILL_HOOKS_BOUND + 1)

    // Act — 65 DISTINCT unfit skills (distinct names → distinct memo keys)
    const reasons: Array<SkillHooksUnfitReason | undefined> = []
    for (let i = 0; i < 65; i++) {
      reasons.push(
        registerSkillHooks(
          setAppState,
          SESSION_ID,
          overHooks,
          `skill-cap-${i}`,
          undefined,
          { sourceKind: 'userSettings' },
        ),
      )
    }

    // Assert — every call refuses with 'count', but warns + telemetry stop at 64
    expect(reasons.every(r => r === 'count')).toBe(true)
    expect(
      warnMessages().filter(m =>
        m.includes('registers none of its hooks and grants no tools'),
      ),
    ).toHaveLength(64)
    expect(boundsEvents()).toHaveLength(64)
  })

  test('kt notice constant matches the official 2.1.304 text verbatim', () => {
    // Assert — model-facing safety text; keep byte-identical to official `kt`
    expect(SKILL_HOOKS_KEPT_OUT_NOTICE).toBe(
      "This skill declares hooks, and they were not registered in this session: a limit on hooks, a matcher that cannot be tested here, or the organization's policy kept them out. The tools that its allowed-tools would grant were not granted either. If the skill relies on its hooks to check or block tool calls, nothing checks them now: tell the user.",
    )
  })
})

describe('once-hook removal is skillRoot-scoped (CC 2.1.304 #39)', () => {
  test("firing one skill's once hook leaves another skill's identical hook registered", () => {
    // Arrange — two skills, byte-identical once:true PreToolUse hooks,
    // different skillRoots
    const { appState, setAppState } = makeFakeState()
    const makeHooks = () =>
      ({
        PreToolUse: [
          { matcher: 'Bash', hooks: [commandHook('echo guarded', true)] },
        ],
      }) as unknown as HooksSettings
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-a', '/skills/a', {
      sourceKind: 'userSettings',
    })
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-b', '/skills/b', {
      sourceKind: 'userSettings',
    })
    const before = registeredMatchers(appState)
    expect(before).toHaveLength(2)

    // Act — fire skill A's once hook
    const matcherA = before.find(m => m.skillRoot === '/skills/a')!
    matcherA.hooks[0]!.onHookSuccess?.()

    // Assert — A's hook is gone; B's identical hook survives
    const after = registeredMatchers(appState)
    expect(after).toHaveLength(1)
    expect(after[0]!.skillRoot).toBe('/skills/b')
    expect(after[0]!.hooks).toHaveLength(1)
  })

  test('removeSessionHook without the skillRoot argument keeps legacy cross-matcher removal', () => {
    // Arrange — goal-command callers (src/commands/goal/index.tsx) pass 4 args
    const { appState, setAppState } = makeFakeState()
    const makeHooks = () =>
      ({
        PreToolUse: [
          { matcher: 'Bash', hooks: [commandHook('echo shared')] },
        ],
      }) as unknown as HooksSettings
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-a', '/skills/a', {
      sourceKind: 'userSettings',
    })
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-b', '/skills/b', {
      sourceKind: 'userSettings',
    })
    expect(registeredMatchers(appState)).toHaveLength(2)

    // Act — legacy 4-arg removal
    removeSessionHook(setAppState, SESSION_ID, 'PreToolUse', {
      type: 'command',
      command: 'echo shared',
    })

    // Assert — removed from ALL matchers (pre-304 behavior preserved)
    expect(registeredMatchers(appState)).toHaveLength(0)
  })

  test('removeSessionHook with explicit undefined skillRoot only removes unscoped matchers', () => {
    // Arrange — one skill registered without skillRoot, one with
    const { appState, setAppState } = makeFakeState()
    const makeHooks = () =>
      ({
        PreToolUse: [
          { matcher: 'Bash', hooks: [commandHook('echo unscoped')] },
        ],
      }) as unknown as HooksSettings
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-noroot', undefined, {
      sourceKind: 'userSettings',
    })
    registerSkillHooks(setAppState, SESSION_ID, makeHooks(), 'skill-rooted', '/skills/b', {
      sourceKind: 'userSettings',
    })
    expect(registeredMatchers(appState)).toHaveLength(2)

    // Act — scoped removal with skillRoot explicitly undefined (the 5th
    // argument is PRESENT, so scoping applies: undefined === undefined)
    removeSessionHook(
      setAppState,
      SESSION_ID,
      'PreToolUse',
      { type: 'command', command: 'echo unscoped' },
      undefined,
    )

    // Assert — only the unscoped matcher lost the hook
    const after = registeredMatchers(appState)
    expect(after).toHaveLength(1)
    expect(after[0]!.skillRoot).toBe('/skills/b')
  })
})
