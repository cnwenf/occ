import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.310 changelog item 11 — AppArmor unprivileged-userns diagnostic.
 *
 * Official changelog (verbatim): "Linux: Improved `/sandbox` and the sandbox
 * startup warning to name Ubuntu's AppArmor restriction on user namespaces,
 * and how to lift it, when it keeps bubblewrap from starting the sandbox".
 *
 * Byte evidence (grep -aboF counts, BIN310 = /tmp/cc-diff-310/bin310/package/claude
 * vs BIN309 = /tmp/cc-diff-310/bin309/package/claude — binaries READ-ONLY, never
 * executed):
 *  - `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`: 2 / 0
 *  - `setting up uid map: Permission denied|Failed RTM_NEWADDR`: 2 / 0
 *  - `--unshare-user","--unshare-net","--dev-bind","/","/","/bin/true`: 1 / 0
 *  - `AppArmor restriction on user namespaces stops bubblewrap here`: 2 / 0
 *  - `the bubblewrap trial`: 2 / 0
 *  - `kernel.apparmor_restrict_unprivileged_userns=1 and`: 2 / 0
 *  - `the AppArmor user-namespace check could not be made`: 2 / 0
 *  - `Add bubblewrap's AppArmor profile from https://code.claude.com/docs/en/sandboxing`: 2 / 0
 *  - `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`: 2 / 0
 *  - `(holds until reboot), then restart Claude Code`: 2 / 0
 *  - `readRestrictionSwitch` / `resolveBubblewrap` / `tryBubblewrap`: 3 each / 0
 *
 * Official decompiled shapes mirrored here:
 *  - `d$(deps)` probe: switch `.trim() !== "1"` → undefined; bwrap null →
 *    undefined; trial `!ran || exitCode === 0` → undefined; else warn-log
 *    (raw trimmed stderr), sanitize (`rd`), matcher fail → undefined, else
 *    the verbatim remedy message with first-matching-line extraction
 *    (trim → strip leading `bwrap: ` → `.slice(0, 80)`). Catch-all warn.
 *  - `f$(resolver)` injector: `{readRestrictionSwitch, resolveBubblewrap, tryBubblewrap}`.
 *  - `Oue` trial: sync spawn `bwrap --unshare-user --unshare-net --dev-bind / /
 *    /bin/true`, cwd `/`, env `{PATH:"/usr/bin:/bin",USER_TYPE:"external",
 *    NODE_ENV:"production"}` extendEnv false, stdio ignore/ignore/pipe,
 *    reject false, timeout 2000; `ran = !timedOut && signal === undefined &&
 *    typeof exitCode === "number"`.
 *  - `Zde` call-site gate: `(platform linux || wsl) && errors.length === 0 &&
 *    !runtimeInitialized` → probe; hit → `{...base, errors: [message]}`.
 *  - `rd` sanitizer: lone-surrogate strip (`Nb` @237222391 — NOT an ANSI
 *    stripper as triage glossed) → `stripVTControlCharacters` → drop
 *    `/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu`.
 *
 * OCC mapping deviations (reported, not invented):
 *  - Official `Ge().runtimeInitialized` has no OCC field; the gate maps to the
 *    adapter's existing `initializationPromise === undefined` (assigned at
 *    initialize() start, cleared on failure/reset — observably equivalent for
 *    this memoized probe).
 *  - Official `_Sn` resolver's configured `sandbox.bwrapPath` leg (@240225161)
 *    has no OCC settings key; OCC's resolver is `whichSync('bwrap')` only.
 *
 * NEVER spawns real bwrap: the probe is exercised through injected deps and
 * the adapter integration mocks the probe module.
 *
 * Mock.module hygiene per OCC-97: snapshot real namespaces before mocking,
 * restore in afterAll.
 */

// ---------------------------------------------------------------------------
// Snapshots (BEFORE any mock.module — bun mutates captured namespaces in place)
// ---------------------------------------------------------------------------
const actualDebugModule = await import('../../../utils/debug.js')
const actualSettingsModule = await import('../../../utils/settings/settings.js')
const actualPlatformModule = await import('../../../utils/platform.js')
const actualRuntimeModule = await import('@anthropic-ai/sandbox-runtime')
const actualProbeModule = await import('../apparmorUsernsCheck.js')

const actualDebugExports = { ...actualDebugModule }
const actualSettingsExports = { ...actualSettingsModule }
const actualPlatformExports = { ...actualPlatformModule }
const actualRuntimeExports = { ...actualRuntimeModule }
const actualProbeExports = { ...actualProbeModule }

const realSandboxManager = actualRuntimeExports.SandboxManager

// Real probe functions under test (unit block) — pulled from the snapshot so
// the later module mock (integration block) cannot swap them out.
const {
  checkApparmorUsernsBlock,
  createApparmorUsernsProbe,
  readApparmorRestrictionSwitch,
  resolveBubblewrapPath,
  runBubblewrapTrial,
  APPARMOR_USERNS_SWITCH_PATH,
  APPARMOR_USERNS_STDERR_PATTERN,
  BUBBLEWRAP_TRIAL_ARGS,
  BUBBLEWRAP_TRIAL_TIMEOUT_MS,
} = actualProbeExports

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
const debugCalls: Array<{ message: string; level: string | undefined }> = []
let mockPlatform: 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown' = 'linux'
let mockBaseResult: { errors: string[]; warnings: string[] } = {
  errors: [],
  warnings: [],
}
let mockMergedSettings: Record<string, unknown> = {}
let probeResult: string | undefined
const probeCalls: unknown[] = []

mock.module('../../../utils/debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: (
    message: string,
    options?: { level?: string },
  ): undefined => {
    debugCalls.push({ message, level: options?.level })
  },
}))
mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mockMergedSettings,
}))
mock.module('../../../utils/platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () => mockPlatform,
}))
mock.module('@anthropic-ai/sandbox-runtime', () => ({
  ...actualRuntimeExports,
  SandboxManager: {
    ...realSandboxManager,
    checkDependencies: () => mockBaseResult,
    isSupportedPlatform: () => true,
    // No-op: the real reset() runs cleanupBwrapMountPoints() — tests must
    // never touch real bwrap.
    reset: async () => {},
  },
}))
mock.module('../apparmorUsernsCheck.js', () => ({
  ...actualProbeExports,
  checkApparmorUsernsBlock: (deps: unknown) => {
    probeCalls.push(deps)
    return probeResult
  },
}))

// Import the REAL adapter AFTER all mocks are registered.
const adapterModule = await import('../sandbox-adapter.js')
const { SandboxManager } = adapterModule

afterAll(() => {
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugExports }))
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../../utils/platform.js', () => ({ ...actualPlatformExports }))
  mock.module('@anthropic-ai/sandbox-runtime', () => ({
    ...actualRuntimeExports,
  }))
  mock.module('../apparmorUsernsCheck.js', () => ({ ...actualProbeExports }))
})

beforeEach(async () => {
  await SandboxManager.reset()
  mockPlatform = 'linux'
  mockBaseResult = { errors: [], warnings: [] }
  mockMergedSettings = {}
  probeResult = undefined
  probeCalls.length = 0
  debugCalls.length = 0
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type TrialResult = {
  ran: boolean
  exitCode: number | null
  stderr: string
}
type ProbeDeps = {
  readRestrictionSwitch: () => string | undefined
  resolveBubblewrap: () => string | null
  tryBubblewrap: (bwrapPath: string) => TrialResult
}

function makeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    readRestrictionSwitch: () => '1\n',
    resolveBubblewrap: () => '/usr/bin/bwrap',
    tryBubblewrap: () => ({ ran: true, exitCode: 0, stderr: '' }),
    ...overrides,
  }
}

/** Official remedy message — byte-verbatim template, excerpt interpolated. */
const expectedRemedyMessage = (excerpt: string): string =>
  `Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here ("${excerpt}"). Add bubblewrap's AppArmor profile from https://code.claude.com/docs/en/sandboxing, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` (holds until reboot), then restart Claude Code`

/** Official warn line emitted on every failed trial (before the matcher). */
const expectedTrialWarn = (
  bwrapPath: string,
  exitCode: number | null,
  stderr: string,
): string =>
  `[sandbox] kernel.apparmor_restrict_unprivileged_userns=1 and the bubblewrap trial (${bwrapPath} ${BUBBLEWRAP_TRIAL_ARGS.join(' ')}) exited ${exitCode}: ${stderr.trim()}`

// ---------------------------------------------------------------------------
// Unit: constants (byte-verified against BIN310)
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item 11 — verbatim constants', () => {
  test('switch path is the official /proc knob', () => {
    expect(APPARMOR_USERNS_SWITCH_PATH).toBe(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    )
  })

  test('trial argv is the official bubblewrap trial command', () => {
    expect(BUBBLEWRAP_TRIAL_ARGS).toEqual([
      '--unshare-user',
      '--unshare-net',
      '--dev-bind',
      '/',
      '/',
      '/bin/true',
    ])
  })

  test('trial timeout is the official 2000ms', () => {
    expect(BUBBLEWRAP_TRIAL_TIMEOUT_MS).toBe(2000)
  })

  test('stderr matcher is the official two-branch pattern', () => {
    expect(APPARMOR_USERNS_STDERR_PATTERN.test('setting up uid map: Permission denied')).toBe(true)
    expect(APPARMOR_USERNS_STDERR_PATTERN.test('Failed RTM_NEWADDR')).toBe(true)
    expect(APPARMOR_USERNS_STDERR_PATTERN.test('no newline on the socket')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: probe with injected deps (official d$ / f$ shape — never spawns bwrap)
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item 11 — checkApparmorUsernsBlock probe (binary d$)', () => {
  test('switch off ("0"): undefined, resolver never consulted', () => {
    // Arrange
    let resolverCalls = 0
    const deps = makeDeps({
      readRestrictionSwitch: () => '0\n',
      resolveBubblewrap: () => {
        resolverCalls += 1
        return '/usr/bin/bwrap'
      },
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert
    expect(result).toBeUndefined()
    expect(resolverCalls).toBe(0)
    expect(debugCalls).toEqual([])
  })

  test('switch missing (readRestrictionSwitch undefined): undefined', () => {
    const result = checkApparmorUsernsBlock(
      makeDeps({ readRestrictionSwitch: () => undefined }),
    )
    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([])
  })

  test('switch garbage ("yes"): undefined — only exact trimmed "1" proceeds', () => {
    const result = checkApparmorUsernsBlock(
      makeDeps({ readRestrictionSwitch: () => 'yes\n' }),
    )
    expect(result).toBeUndefined()
  })

  test('switch on + no bubblewrap: undefined, trial never run', () => {
    // Arrange
    let trialCalls = 0
    const deps = makeDeps({
      resolveBubblewrap: () => null,
      tryBubblewrap: () => {
        trialCalls += 1
        return { ran: true, exitCode: 1, stderr: '' }
      },
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert
    expect(result).toBeUndefined()
    expect(trialCalls).toBe(0)
    expect(debugCalls).toEqual([])
  })

  test('trial success (ran, exit 0): undefined, no warn', () => {
    const result = checkApparmorUsernsBlock(
      makeDeps({
        tryBubblewrap: () => ({ ran: true, exitCode: 0, stderr: '' }),
      }),
    )
    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([])
  })

  test('trial not-ran (timeout/throw shape): undefined even with matching stderr', () => {
    // ran=false short-circuits BEFORE the warn log and the matcher.
    const result = checkApparmorUsernsBlock(
      makeDeps({
        tryBubblewrap: () => ({
          ran: false,
          exitCode: null,
          stderr: 'bwrap: setting up uid map: Permission denied',
        }),
      }),
    )
    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([])
  })

  test('trial fail + matching stderr: exact verbatim remedy message + warn log', () => {
    // Arrange
    const stderr = 'bwrap: setting up uid map: Permission denied\n'
    const deps = makeDeps({
      tryBubblewrap: () => ({ ran: true, exitCode: 1, stderr }),
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert — excerpt = first matching line, trimmed, `bwrap: ` prefix stripped
    expect(result).toBe(
      expectedRemedyMessage('setting up uid map: Permission denied'),
    )
    expect(debugCalls).toEqual([
      {
        message: expectedTrialWarn('/usr/bin/bwrap', 1, stderr),
        level: 'warn',
      },
    ])
  })

  test('Failed RTM_NEWADDR branch matches too', () => {
    const result = checkApparmorUsernsBlock(
      makeDeps({
        tryBubblewrap: () => ({
          ran: true,
          exitCode: 1,
          stderr: 'bwrap: Failed RTM_NEWADDR: Operation not permitted\n',
        }),
      }),
    )
    expect(result).toBe(
      expectedRemedyMessage('Failed RTM_NEWADDR: Operation not permitted'),
    )
  })

  test('first matching line wins across multi-line stderr', () => {
    const stderr = [
      'bwrap: some unrelated noise',
      'Failed RTM_NEWADDR: first matching',
      'setting up uid map: Permission denied: second matching',
      '',
    ].join('\n')
    const result = checkApparmorUsernsBlock(
      makeDeps({
        tryBubblewrap: () => ({ ran: true, exitCode: 1, stderr }),
      }),
    )
    expect(result).toBe(expectedRemedyMessage('Failed RTM_NEWADDR: first matching'))
  })

  test('excerpt is sliced to 80 chars', () => {
    // Arrange — 36-char match + 60 filler = 96 chars
    const longLine = `setting up uid map: Permission denied${'x'.repeat(60)}`
    const deps = makeDeps({
      tryBubblewrap: () => ({
        ran: true,
        exitCode: 1,
        stderr: `bwrap: ${longLine}\n`,
      }),
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert
    expect(result).toBe(expectedRemedyMessage(longLine.slice(0, 80)))
    expect(result).toContain(`${longLine.slice(37, 80)}")`)
    expect(longLine.length).toBe(97)
  })

  test('trial fail + non-matching stderr: undefined but warn IS logged (pre-matcher)', () => {
    // Arrange
    const stderr = 'bwrap: No permissions to creating new namespace\n'
    const deps = makeDeps({
      tryBubblewrap: () => ({ ran: true, exitCode: 1, stderr }),
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert — official logs the failed trial before testing the matcher
    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([
      {
        message: expectedTrialWarn('/usr/bin/bwrap', 1, stderr),
        level: 'warn',
      },
    ])
  })

  test('stderr is sanitized (lone surrogates + control chars) before matching', () => {
    // Arrange — BEL (\u0007, Cc) and a lone surrogate embedded in the match
    const stderr = 'bwrap: \uD800setting up uid map:\u0007 Permission denied\n'
    const deps = makeDeps({
      tryBubblewrap: () => ({ ran: true, exitCode: 1, stderr }),
    })

    // Act
    const result = checkApparmorUsernsBlock(deps)

    // Assert — sanitizer strips both; excerpt is the clean text
    expect(result).toBe(
      expectedRemedyMessage('setting up uid map: Permission denied'),
    )
    // The warn line keeps the RAW trimmed stderr (official logs before rd()).
    expect(debugCalls[0]!.message).toBe(
      expectedTrialWarn('/usr/bin/bwrap', 1, stderr),
    )
  })

  test('deps throwing: catch-all warn, undefined (never rethrows)', () => {
    const deps = makeDeps({
      readRestrictionSwitch: () => {
        throw new Error('boom')
      },
    })

    const result = checkApparmorUsernsBlock(deps)

    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([
      {
        message:
          '[sandbox] the AppArmor user-namespace check could not be made: Error: boom',
        level: 'warn',
      },
    ])
  })

  test('tryBubblewrap throwing: same catch-all warn, undefined', () => {
    const deps = makeDeps({
      tryBubblewrap: () => {
        throw new Error('spawn failed')
      },
    })

    const result = checkApparmorUsernsBlock(deps)

    expect(result).toBeUndefined()
    expect(debugCalls).toEqual([
      {
        message:
          '[sandbox] the AppArmor user-namespace check could not be made: Error: spawn failed',
        level: 'warn',
      },
    ])
  })

  test('createApparmorUsernsProbe wires the official f$ shape', () => {
    const resolver = () => '/custom/bwrap'
    const deps = createApparmorUsernsProbe(resolver)

    expect(deps.resolveBubblewrap).toBe(resolver)
    expect(deps.readRestrictionSwitch).toBe(readApparmorRestrictionSwitch)
    expect(deps.tryBubblewrap).toBe(runBubblewrapTrial)
  })

  test('production readRestrictionSwitch/resolveBubblewrap are side-effect-free lookups', () => {
    // Environment-agnostic assertions only: the switch read returns the proc
    // file contents or undefined (no throw); the resolver returns a path or
    // null (no spawn).
    const switchValue = readApparmorRestrictionSwitch()
    expect(switchValue === undefined || typeof switchValue === 'string').toBe(
      true,
    )
    const resolved = resolveBubblewrapPath()
    expect(resolved === null || typeof resolved === 'string').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: adapter checkDependencies wiring (official Zde gate)
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item 11 — checkDependencies gate (binary Zde)', () => {
  test('linux + zero errors + uninitialized: probe consulted, hit appends error', () => {
    // Arrange
    mockPlatform = 'linux'
    mockBaseResult = { errors: [], warnings: ['socat missing'] }
    probeResult = expectedRemedyMessage('setting up uid map: Permission denied')

    // Act
    const result = SandboxManager.checkDependencies()

    // Assert
    expect(probeCalls.length).toBe(1)
    expect(result.errors).toEqual([probeResult])
    expect(result.warnings).toEqual(['socat missing'])
  })

  test('wsl is gated in like linux', () => {
    mockPlatform = 'wsl'
    probeResult = expectedRemedyMessage('Failed RTM_NEWADDR')

    const result = SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(1)
    expect(result.errors).toEqual([probeResult])
  })

  test('probe consulted with the official injected-deps object', () => {
    SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(1)
    const deps = probeCalls[0] as Record<string, unknown>
    expect(typeof deps.readRestrictionSwitch).toBe('function')
    expect(typeof deps.resolveBubblewrap).toBe('function')
    expect(typeof deps.tryBubblewrap).toBe('function')
  })

  test('non-linux platform (macos): probe NOT consulted', () => {
    mockPlatform = 'macos'

    const result = SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(0)
    expect(result.errors).toEqual([])
  })

  test('unknown platform: probe NOT consulted', () => {
    mockPlatform = 'unknown'

    SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(0)
  })

  test('existing dependency errors: probe NOT consulted, base preserved', () => {
    mockBaseResult = { errors: ['bwrap not found'], warnings: [] }
    probeResult = expectedRemedyMessage('setting up uid map: Permission denied')

    const result = SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(0)
    expect(result.errors).toEqual(['bwrap not found'])
  })

  test('probe miss (undefined): base result returned unchanged', () => {
    probeResult = undefined

    const result = SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test('memoized: second call does not re-consult the probe', () => {
    probeResult = expectedRemedyMessage('Failed RTM_NEWADDR')

    const first = SandboxManager.checkDependencies()
    const second = SandboxManager.checkDependencies()

    expect(probeCalls.length).toBe(1)
    expect(second).toEqual(first)
  })

  test('consumer path: startup warning + isSandboxingEnabled see the verbatim message', () => {
    // Arrange — sandbox explicitly enabled, linux, base deps clean, probe hits
    mockPlatform = 'linux'
    mockMergedSettings = { sandbox: { enabled: true } }
    probeResult = expectedRemedyMessage('setting up uid map: Permission denied')

    // Act
    const reason = SandboxManager.getSandboxUnavailableReason()

    // Assert — sandbox-adapter.ts:1506-1535 dependency branch carries the
    // verbatim message through unchanged (consumers NOT modified).
    expect(reason).toBe(
      `sandbox.enabled is set but dependencies are missing: ${probeResult} · install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details`,
    )
    expect(SandboxManager.isSandboxingEnabled()).toBe(false)
  })
})
