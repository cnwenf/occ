import { describe, test, expect, mock, beforeEach } from 'bun:test'

/**
 * /output-style command — ported byte-faithfully from the official 2.1.270
 * binary (module at offset 202167402, chunk-87knjp1g). These tests assert the
 * official output contract captured live from the official binary REPL:
 *
 *   Output style: default
 *
 *   Available styles:
 *   - default (current)
 *   - Concise: Claude responds tersely, ...
 *   ...
 *   Usage: /output-style <style>
 *
 * plus the unknown-style / already-active / save branches.
 */

const R = import.meta.dir.replace(/\/test\/commands$/, '')

// --- module mocks (must precede the dynamic import of the command) ---

const logEventCalls: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

const mockState = {
  currentStyle: 'default' as string | undefined,
  localSettingsEnabled: true,
  saveError: null as Error | null,
  savedPayloads: [] as Array<Record<string, unknown>>,
}

mock.module(`${R}/src/utils/cwd.ts`, () => ({
  getCwd: () => '/fake/project',
}))

mock.module(`${R}/src/constants/outputStyles.ts`, () => ({
  DEFAULT_OUTPUT_STYLE_NAME: 'default',
  OUTPUT_STYLE_CONFIG: {
    default: null,
    Concise: { name: 'Concise', source: 'built-in' },
    Explanatory: { name: 'Explanatory', source: 'built-in' },
    Learning: { name: 'Learning', source: 'built-in' },
  },
  getAllOutputStyles: async () => ({
    default: null,
    Concise: {
      name: 'Concise',
      source: 'built-in',
      description:
        'Claude responds tersely, leading with results and skipping preamble and narration',
    },
    Explanatory: {
      name: 'Explanatory',
      source: 'built-in',
      description:
        'Claude explains its implementation choices and codebase patterns',
    },
    Learning: {
      name: 'Learning',
      source: 'built-in',
      description:
        'Claude pauses and asks you to write small pieces of code for hands-on practice',
    },
    'Team Custom': {
      name: 'Team Custom',
      source: 'projectSettings',
      description: 'A project-defined style',
    },
  }),
}))

mock.module(`${R}/src/utils/settings/settings.ts`, () => ({
  getSettings_DEPRECATED: () => ({ outputStyle: mockState.currentStyle }),
  updateSettingsForSource: (
    _source: string,
    settings: Record<string, unknown>,
  ) => {
    mockState.savedPayloads.push(settings)
    return { error: mockState.saveError }
  },
}))

mock.module(`${R}/src/utils/settings/constants.ts`, () => ({
  isSettingSourceEnabled: (source: string) =>
    source === 'localSettings' ? mockState.localSettingsEnabled : true,
}))

mock.module(`${R}/src/services/analytics/index.ts`, () => ({
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    logEventCalls.push({ name, metadata })
  },
}))

const { call } = await import(`${R}/src/commands/output-style/output-style.ts`)

const ctx = {} as any

function text(result: { type: string; value?: string }): string {
  expect(result.type).toBe('text')
  return result.value ?? ''
}

beforeEach(() => {
  mockState.currentStyle = 'default'
  mockState.localSettingsEnabled = true
  mockState.saveError = null
  mockState.savedPayloads = []
  logEventCalls.length = 0
})

describe('/output-style listing', () => {
  test('empty args lists styles with current marker and usage line', async () => {
    const value = text(await call('', ctx))
    expect(value).toContain('Output style: default')
    expect(value).toContain('Available styles:')
    expect(value).toContain('- default (current)')
    expect(value).toContain(
      '- Concise: Claude responds tersely, leading with results and skipping preamble and narration',
    )
    expect(value).toContain('- Team Custom: A project-defined style')
    expect(value).toContain('Usage: /output-style <style>')
    // Official list output has no trailing note when not relayed.
    expect(value).not.toContain('Remote Control')
  })

  test.each(['list', 'show', 'current', 'status', '?', 'help', '-h', '--help'])(
    'allowlist word %r falls through to the listing',
    async word => {
      const value = text(await call(word, ctx))
      expect(value).toContain('Output style: default')
      expect(value).toContain('Usage: /output-style <style>')
    },
  )

  test('allowlist match is case-insensitive on the lowercased arg', async () => {
    const value = text(await call('LIST', ctx))
    expect(value).toContain('Output style: default')
  })

  test('marks a non-default current style', async () => {
    mockState.currentStyle = 'Concise'
    const value = text(await call('', ctx))
    expect(value).toContain('Output style: Concise')
    expect(value).toContain('- Concise (current):')
    expect(value).not.toContain('- default (current)')
  })
})

describe('/output-style unknown style', () => {
  test('unknown style reports official message with available list', async () => {
    const value = text(await call('nope', ctx))
    expect(value).toBe(
      'Unknown output style "nope". Available styles: default, Concise, Explanatory, Learning, Team Custom',
    )
  })

  test('unknown style echoes the raw (untrimmed-lowercased) argument', async () => {
    // Official: `Unknown output style "${_n(r)}"` where r = args.trim() —
    // original casing preserved in the quoted name.
    const value = text(await call('Nope', ctx))
    expect(value).toContain('Unknown output style "Nope"')
  })

  test('no save/telemetry side effects on unknown style', async () => {
    await call('nope', ctx)
    expect(mockState.savedPayloads).toEqual([])
    expect(logEventCalls).toEqual([])
  })
})

describe('/output-style switching', () => {
  test('case-insensitive match sets the canonical style name', async () => {
    const value = text(await call('concise', ctx))
    expect(value).toBe('Output style set to Concise')
    expect(mockState.savedPayloads).toEqual([{ outputStyle: 'Concise' }])
  })

  test('already-active style short-circuits without saving', async () => {
    const value = text(await call('default', ctx))
    expect(value).toBe('Output style is already default')
    expect(mockState.savedPayloads).toEqual([])
    expect(logEventCalls).toEqual([])
  })

  test('already-active check is case-insensitive via the canonical match', async () => {
    mockState.currentStyle = 'Concise'
    const value = text(await call('CONCISE', ctx))
    expect(value).toBe('Output style is already Concise')
  })

  test('emits tengu_output_style_changed with official metadata', async () => {
    await call('Concise', ctx)
    expect(logEventCalls).toEqual([
      {
        name: 'tengu_output_style_changed',
        metadata: {
          style: 'Concise',
          source: 'slash_command',
          settings_source: 'localSettings',
        },
      },
    ])
  })

  test('custom (non-builtin) style telemetry reports "custom"', async () => {
    const value = text(await call('Team Custom', ctx))
    expect(value).toBe('Output style set to Team Custom')
    expect(logEventCalls[0]?.metadata?.style).toBe('custom')
  })
})

describe('/output-style guard branches', () => {
  test('localSettings not loaded → official fEt message', async () => {
    mockState.localSettingsEnabled = false
    const value = text(await call('Concise', ctx))
    expect(value).toBe(
      "Output styles are saved to local settings (.claude/settings.local.json), which this session doesn't load, so the style can't be changed here.",
    )
    expect(mockState.savedPayloads).toEqual([])
  })

  test('save error surfaces the detailed message (non-relayed session)', async () => {
    mockState.saveError = new Error('disk on fire')
    const value = text(await call('Concise', ctx))
    expect(value).toBe('Could not save output style: disk on fire')
    expect(logEventCalls).toEqual([])
  })
})
