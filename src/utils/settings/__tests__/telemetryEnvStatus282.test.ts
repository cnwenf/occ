import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.282 (UI leg): startup notice + /status + doctor entries for the
 * project/local settings telemetry env-var blocklist.
 *
 * Official mechanism (byte-verified against the 2.1.282 linux-x64 ELF; all
 * four probe strings absent from the 2.1.281 ELF):
 *  - `etr()` @210567300-210569900 is DERIVABLE (no collector state): it
 *    re-inspects the project-scoped enabled sources, classifies each blocked
 *    telemetry key via `Vcn` (off-only exception, `aCr` =
 *    `S.envAboveProjectSettings`) into `ignored` (dropped) vs `turnedOff`
 *    (kept), and emits `{file: Er(o), path: "env", message: <template>,
 *    severity: "warning", statusOnly: true}` per source per class.
 *  - `VT()` skip: projectSettings pass is skipped when userSettings is
 *    enabled AND both files `path.resolve` equal (`resolve as ar` @195165725).
 *  - Notice plugin `C7e`/`Nao` @222520299: remote-gated (`Lt()`), fires only
 *    when ignored+turnedOff non-empty; payload key "project-telemetry-env",
 *    warning, priority medium, timeoutMs 15000, no deps → once per session.
 *  - `qqr()` @217299046 pushes each statusNotice message into the /status
 *    System Diagnostics + doctor-screen message lists (ignored entries first,
 *    then turnedOff — `Une()` append order).
 *
 * Mock.module hygiene per OCC-97: snapshot real namespaces BEFORE mocking,
 * restore in afterAll (277-suite pattern).
 */

// Mutable per-test stores the mocked settings modules read.
const settingsBySource: Record<
  string,
  { env?: Record<string, string> } | null
> = {}
const filePathBySource: Record<string, string | undefined> = {}
let enabledSources: string[] = []

// NOTE: bun's mock.module mutates the captured namespace object in place when
// the mock registers — spreading the live namespace in afterAll would
// "restore" the mock itself. Snapshot into plain objects BEFORE any
// mock.module call.
const actualSettingsModule = await import('../settings.js')
const actualConstantsModule = await import('../constants.js')
const actualConfigModule = await import('../../config.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualConstantsExports = { ...actualConstantsModule }
const actualConfigExports = { ...actualConfigModule }

mock.module('../settings.js', () => ({
  ...actualSettingsExports,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
  getSettingsFilePathForSource: (source: string) => filePathBySource[source],
}))
mock.module('../constants.js', () => ({
  ...actualConstantsExports,
  getEnabledSettingSources: () => [...enabledSources],
}))
mock.module('../../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => ({ env: {} }),
}))

afterAll(() => {
  mock.module('../settings.js', () => ({ ...actualSettingsExports }))
  mock.module('../constants.js', () => ({ ...actualConstantsExports }))
  mock.module('../../config.js', () => ({ ...actualConfigExports }))
})

const { _resetManagedEnvForTesting } = await import('../../managedEnv.js')
const {
  getProjectTelemetryEnvStatus,
  getProjectTelemetryEnvStatusMessages,
  getProjectTelemetryEnvNoticeText,
  PROJECT_TELEMETRY_ENV_NOTICE_KEY,
  PROJECT_TELEMETRY_ENV_NOTICE_TEXT,
  PROJECT_TELEMETRY_ENV_NOTICE_TIMEOUT_MS,
} = await import('../telemetryEnvStatus.js')

// Byte-exact single-key expectations, copied from the 2.1.282 ELF
// (grep -aboF + dd): ignored template @96706768/@210568653, turnedOff
// template @96707325/@210569300, notice text @93470892/@222520512.
const EXPECTED_IGNORED_MESSAGE_PROJECT =
  "Claude Code ignores these telemetry variables in .claude/settings.json: OTEL_EXPORTER_OTLP_ENDPOINT. A project's settings files can only turn telemetry off: set OTEL_LOGS_EXPORTER, OTEL_METRICS_EXPORTER, or OTEL_TRACES_EXPORTER to none, or a content variable such as OTEL_LOG_USER_PROMPTS to 0, with the name in upper case. That doesn't work for a variable that managed settings, a --settings file, or the environment you start Claude Code from already sets. If you set them on purpose, set them in your shell, your user settings (~/.claude/settings.json), or managed settings instead."
const EXPECTED_TURNED_OFF_MESSAGE_PROJECT =
  ".claude/settings.json turns telemetry off with these variables: OTEL_TRACES_EXPORTER. Claude Code uses these values unless managed settings or a --settings file sets the same variable. Your user settings don't override this file. To keep one on, set it in the environment you start Claude Code from, in a --settings file, or in managed settings."
const EXPECTED_NOTICE_TEXT =
  "This project's settings set telemetry environment variables. Run /status to see which ones Claude Code ignored and which turned telemetry off."

const PROJECT_FILE = '/proj/.claude/settings.json'
const LOCAL_FILE = '/proj/.claude/settings.local.json'
const USER_FILE = '/home/user/.claude/settings.json'

beforeEach(() => {
  _resetManagedEnvForTesting()
  for (const key of Object.keys(settingsBySource)) {
    delete settingsBySource[key]
  }
  filePathBySource.userSettings = USER_FILE
  filePathBySource.projectSettings = PROJECT_FILE
  filePathBySource.localSettings = LOCAL_FILE
  filePathBySource.policySettings = undefined
  filePathBySource.flagSettings = undefined
  enabledSources = [
    'userSettings',
    'projectSettings',
    'localSettings',
    'policySettings',
    'flagSettings',
  ]
})

afterEach(() => {
  delete process.env.OTEL_METRICS_EXPORTER
  delete process.env.OTEL_TRACES_EXPORTER
  _resetManagedEnvForTesting()
})

describe('getProjectTelemetryEnvStatus — official etr() classification', () => {
  test('returns empty ignored and turnedOff when no blocked telemetry keys are set', () => {
    // Arrange
    settingsBySource.projectSettings = { env: { SOME_OTHER_VAR: 'x' } }
    settingsBySource.localSettings = { env: {} }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toEqual([])
    expect(turnedOff).toEqual([])
  })

  test('classifies a blocked enable-value key as ignored with the byte-exact entry shape', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(turnedOff).toEqual([])
    expect(ignored).toHaveLength(1)
    expect(ignored[0]).toEqual({
      file: PROJECT_FILE,
      path: 'env',
      message: EXPECTED_IGNORED_MESSAGE_PROJECT,
      severity: 'warning',
      statusOnly: true,
    })
  })

  test('classifies OTEL_TRACES_EXPORTER=none kept via the Vcn off-only exception as turnedOff', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { OTEL_TRACES_EXPORTER: 'none' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toEqual([])
    expect(turnedOff).toHaveLength(1)
    expect(turnedOff[0]).toEqual({
      file: PROJECT_FILE,
      path: 'env',
      message: EXPECTED_TURNED_OFF_MESSAGE_PROJECT,
      severity: 'warning',
      statusOnly: true,
    })
  })

  test('classifies OTEL_LOG_USER_PROMPTS=0 (ko-falsy content knob) as turnedOff', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { OTEL_LOG_USER_PROMPTS: '0' },
    }

    // Act
    const { turnedOff, ignored } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toEqual([])
    expect(turnedOff).toHaveLength(1)
    expect(turnedOff[0]?.message).toContain(
      'turns telemetry off with these variables: OTEL_LOG_USER_PROMPTS.',
    )
  })

  test('reclassifies an off-value as ignored when the same name exists above project settings', () => {
    // Arrange — spawn env (pre-settings snapshot) already sets the name, so
    // the Vcn shadow check fails and the project value is dropped.
    process.env.OTEL_METRICS_EXPORTER = 'otlp'
    settingsBySource.projectSettings = {
      env: { OTEL_METRICS_EXPORTER: 'none' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(turnedOff).toEqual([])
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.message).toContain(
      'ignores these telemetry variables in .claude/settings.json: OTEL_METRICS_EXPORTER.',
    )
  })

  test('classifies a lowercase off-value key as ignored (Vcn requires exact upper case)', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { otel_traces_exporter: 'none' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(turnedOff).toEqual([])
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.message).toContain(
      'ignores these telemetry variables in .claude/settings.json: otel_traces_exporter.',
    )
  })

  test('joins multiple keys in settings order and splits classes within one source', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: {
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_HEADERS: 'auth=1',
      },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert — official keeps original key order per class: ignored =
    // [PROTOCOL, HEADERS], turnedOff = [METRICS none].
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.message).toContain(
      ': OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_EXPORTER_OTLP_HEADERS.',
    )
    expect(turnedOff).toHaveLength(1)
    expect(turnedOff[0]?.message).toContain(
      'turns telemetry off with these variables: OTEL_METRICS_EXPORTER.',
    )
  })

  test('reports localSettings with its own file and display path', () => {
    // Arrange
    settingsBySource.localSettings = {
      env: { OTEL_LOGS_EXPORTER: 'otlp' },
    }

    // Act
    const { ignored } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.file).toBe(LOCAL_FILE)
    expect(ignored[0]?.message).toContain(
      'ignores these telemetry variables in .claude/settings.local.json: OTEL_LOGS_EXPORTER.',
    )
  })

  test('skips projectSettings when it resolves to the same file as enabled userSettings (official VT)', () => {
    // Arrange — e.g. cwd === $HOME: .claude/settings.json IS the user file.
    filePathBySource.projectSettings = USER_FILE
    settingsBySource.projectSettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toEqual([])
    expect(turnedOff).toEqual([])
  })

  test('does not skip projectSettings when userSettings is not an enabled source', () => {
    // Arrange — same resolved path, but the official gate also requires
    // `r.includes("userSettings")`.
    filePathBySource.projectSettings = USER_FILE
    enabledSources = ['projectSettings', 'localSettings']
    settingsBySource.projectSettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    }

    // Act
    const { ignored } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toHaveLength(1)
  })

  test('never reports userSettings-scope env (official RLt: project scope only)', () => {
    // Arrange
    settingsBySource.userSettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    }

    // Act
    const { ignored, turnedOff } = getProjectTelemetryEnvStatus()

    // Assert
    expect(ignored).toEqual([])
    expect(turnedOff).toEqual([])
  })

  test('is derivable — repeated calls return fresh equal results with no accumulation', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { OTEL_TRACES_EXPORTER: 'none' },
    }

    // Act
    const first = getProjectTelemetryEnvStatus()
    const second = getProjectTelemetryEnvStatus()

    // Assert
    expect(second).toEqual(first)
    expect(second.turnedOff).toHaveLength(1)
    expect(second.turnedOff).not.toBe(first.turnedOff)
  })
})

describe('getProjectTelemetryEnvStatusMessages — official qqr()/Une() order', () => {
  test('orders ignored messages before turnedOff messages', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_TRACES_EXPORTER: 'none',
      },
    }

    // Act
    const messages = getProjectTelemetryEnvStatusMessages()

    // Assert
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('Claude Code ignores these telemetry variables')
    expect(messages[1]).toContain('turns telemetry off with these variables')
  })

  test('returns no messages when nothing is blocked', () => {
    // Arrange
    settingsBySource.projectSettings = { env: {} }

    // Act + Assert
    expect(getProjectTelemetryEnvStatusMessages()).toEqual([])
  })
})

describe('getProjectTelemetryEnvNoticeText — official Nao trigger condition', () => {
  test('returns null when no project-scope telemetry key was ignored or kept-as-off', () => {
    // Arrange
    settingsBySource.projectSettings = { env: { UNRELATED: '1' } }

    // Act + Assert
    expect(getProjectTelemetryEnvNoticeText()).toBeNull()
  })

  test('returns the byte-exact notice text when at least one key was ignored', () => {
    // Arrange
    settingsBySource.projectSettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
    }

    // Act + Assert
    expect(getProjectTelemetryEnvNoticeText()).toBe(EXPECTED_NOTICE_TEXT)
  })

  test('returns the notice text when only turnedOff entries exist', () => {
    // Arrange
    settingsBySource.localSettings = {
      env: { OTEL_LOG_TOOL_DETAILS: 'false' },
    }

    // Act + Assert
    expect(getProjectTelemetryEnvNoticeText()).toBe(EXPECTED_NOTICE_TEXT)
  })

  test('exposes the official notice key and 15000ms timeout constants', () => {
    // Assert — official payload @222520299: key "project-telemetry-env",
    // priority "medium", timeoutMs 15000.
    expect(PROJECT_TELEMETRY_ENV_NOTICE_KEY).toBe('project-telemetry-env')
    expect(PROJECT_TELEMETRY_ENV_NOTICE_TIMEOUT_MS).toBe(15000)
    expect(PROJECT_TELEMETRY_ENV_NOTICE_TEXT).toBe(EXPECTED_NOTICE_TEXT)
  })
})
