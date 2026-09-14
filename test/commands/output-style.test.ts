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
  // When non-null, getAllOutputStyles returns this map instead of the default
  // fixture — used by the boundary tests (empty style set, sanitizer inputs).
  stylesOverride: null as Record<string, unknown> | null,
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
  getAllOutputStyles: async () =>
    mockState.stylesOverride ?? {
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
    },
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
  mockState.stylesOverride = null
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

  // Review P3-7: guard-order combination pin. The already-active check MUST
  // run before the localSettings-enabled guard — swapping the two (a mutation
  // that previously survived) changes the message in this combined state.
  test('already-active wins over localSettings-disabled (guard order)', async () => {
    mockState.localSettingsEnabled = false
    const value = text(await call('default', ctx))
    expect(value).toBe('Output style is already default')
    expect(value).not.toContain("which this session doesn't load")
    expect(mockState.savedPayloads).toEqual([])
  })
})

// Review P3-6: the official `_n` (chunk-q3eg9j9b @~188806900) is a display
// SANITIZER, not an identity — ported as displaySanitizer. `-p` args reach
// call() raw, so every user-facing echo must strip control chars / lone
// surrogates / invisibles and cap length, exactly like the official.
describe('/output-style display sanitizer (official _n parity)', () => {
  test('CSI-wrapped unknown arg echoes with ESC bytes stripped', async () => {
    // Official behavior for `occ -p '/output-style "\x1b[31mFoo\x1b[0m"'`:
    // the ESC (\p{Cc}) bytes are removed, the printable remainder is kept.
    const value = text(await call('\x1b[31mFoo\x1b[0m', ctx))
    expect(value).toBe(
      'Unknown output style "[31mFoo[0m". Available styles: default, Concise, Explanatory, Learning, Team Custom',
    )
    expect(value).not.toContain('\x1b')
  })

  test('NUL and other C0 control chars are stripped from the echo', async () => {
    const value = text(await call('a\x00b\x07c', ctx))
    expect(value).toContain('Unknown output style "abc"')
  })

  test('braille blank U+2800 and non-space separators are stripped', async () => {
    // Official C regex: [...⠀]|(?! )\p{Zs} — U+2800 (Default_
    // Ignorable) and U+00A0 (\p{Zs} but not  ) both go; plain spaces stay.
    const value = text(await call('a⠀b c d', ctx))
    expect(value).toContain('Unknown output style "abc d"')
  })

  test('lone surrogates are removed, well-formed pairs survive', async () => {
    const value = text(await call('a\uD800b\uDC00c', ctx))
    expect(value).toContain('Unknown output style "abc"')
    const emoji = text(await call('nope😀tail', ctx))
    expect(emoji).toContain('Unknown output style "nope😀tail"')
  })

  test('echo is truncated to 1024 UTF-16 units (official ne(·,1024))', async () => {
    const value = text(await call('x'.repeat(2000), ctx))
    expect(value).toContain(`Unknown output style "${'x'.repeat(1024)}"`)
    expect(value).not.toContain('x'.repeat(1025))
  })

  test('truncation does not split a surrogate pair at the boundary', async () => {
    // High surrogate lands at index 1023 → official ne drops the trailing
    // high surrogate rather than emitting a lone one.
    const arg = 'x'.repeat(1023) + '😀' + 'y'.repeat(10)
    const value = text(await call(arg, ctx))
    expect(value).toContain(`Unknown output style "${'x'.repeat(1023)}"`)
    expect(value).not.toContain('\uD83D')
  })

  test('listing name AND description pass through the sanitizer', async () => {
    // Official: `- ${_n(c)}${O}: ${_n(S)}` — both halves sanitized.
    mockState.stylesOverride = {
      default: null,
      'Weird\x1bName': {
        name: 'Weird\x1bName',
        source: 'built-in',
        description: 'desc\x1bwith\x07esc',
      },
    }
    const value = text(await call('', ctx))
    expect(value).toContain('- WeirdName: descwithesc')
    expect(value).not.toContain('\x1b')
    expect(value).not.toContain('\x07')
  })

  test('already-active and set-to messages are sanitized', async () => {
    mockState.stylesOverride = {
      default: null,
      'Bad\x1bStyle': {
        name: 'Bad\x1bStyle',
        source: 'built-in',
        description: null,
      },
    }
    const setValue = text(await call('Bad\x1bStyle', ctx))
    expect(setValue).toBe('Output style set to BadStyle')

    mockState.currentStyle = 'Bad\x1bStyle'
    const alreadyValue = text(await call('Bad\x1bStyle', ctx))
    expect(alreadyValue).toBe('Output style is already BadStyle')
  })

  test('save-error message stays RAW (official d.error.message interpolation, unsanitized)', async () => {
    // Pinned divergence from the other sites: the official does NOT run _n
    // over the save error — a mutation adding sanitization here fails.
    mockState.saveError = new Error('raw\x1bmessage')
    const value = text(await call('Concise', ctx))
    expect(value).toBe('Could not save output style: raw\x1bmessage')
    expect(value).toContain('\x1b')
  })
})

// Review P3-9: boundary inputs + the relayed/off-box branch strings, which
// previously had zero assertions. OCC never sets dispatchedOverBridge /
// submissionVerifiedSlackHumanTurn at runtime (no Remote-Control/Slack
// subsystem), but the official `Oee(o)` predicate reads exactly those two
// optional fields — drivable via the context object for behavior locking.
describe('/output-style boundary inputs', () => {
  test('surrounding whitespace is trimmed before matching', async () => {
    const value = text(await call('  Concise  ', ctx))
    expect(value).toBe('Output style set to Concise')
    expect(mockState.savedPayloads).toEqual([{ outputStyle: 'Concise' }])
  })

  test('whitespace-only args fall through to the listing', async () => {
    const value = text(await call('   ', ctx))
    expect(value).toContain('Output style: default')
    expect(value).toContain('Usage: /output-style <style>')
  })

  test('undefined settings outputStyle defaults to "default"', async () => {
    mockState.currentStyle = undefined
    const value = text(await call('', ctx))
    expect(value).toContain('Output style: default')
    expect(value).toContain('- default (current)')
  })

  test.each([
    'display',
    'view',
    'get',
    'check',
    'describe',
    'print',
    'version',
    'about',
  ])('untested LIST_ARGS word %r falls through to the listing', async word => {
    // Completes the official nN allowlist coverage (chunk-vfsq2z4g @185269045):
    // list/show/current/status/?/help/-h/--help were covered above.
    const value = text(await call(word, ctx))
    expect(value).toContain('Output style: default')
    expect(value).toContain('Usage: /output-style <style>')
    expect(value).not.toContain('Unknown output style')
    expect(mockState.savedPayloads).toEqual([])
  })

  test('empty style set lists nothing and every arg is unknown', async () => {
    mockState.stylesOverride = {}
    const listing = text(await call('', ctx))
    expect(listing).toContain('Output style: default')
    expect(listing).toContain('Available styles:\n')
    expect(listing).not.toContain('- default')

    const unknown = text(await call('anything', ctx))
    expect(unknown).toBe('Unknown output style "anything". Available styles: ')
    expect(mockState.savedPayloads).toEqual([])
  })
})

describe('/output-style relayed (off-box) branches', () => {
  const bridgeCtx = { dispatchedOverBridge: true } as any
  const slackCtx = { submissionVerifiedSlackHumanTurn: true } as any

  test('dispatchedOverBridge listing shows builtin-only + off-box note', async () => {
    const value = text(await call('', bridgeCtx))
    expect(value).toContain('- default (current)')
    expect(value).toContain('- Concise:')
    expect(value).not.toContain('- Team Custom')
    expect(value).toContain(
      "\nCustom output styles can't be selected over Remote Control or from a relayed message. Select one in the session itself, or pick a built-in style here.",
    )
  })

  test('submissionVerifiedSlackHumanTurn drives the same relayed predicate', async () => {
    const value = text(await call('', slackCtx))
    expect(value).not.toContain('- Team Custom')
    expect(value).toContain("can't be selected over Remote Control")
  })

  test('relayed listing masks a custom current style with the placeholder', async () => {
    // Official: `Output style: ${u&&!jJe(n[s])?g:_n(s)}` — g = 'a custom style'.
    mockState.currentStyle = 'Team Custom'
    const value = text(await call('', bridgeCtx))
    expect(value).toContain('Output style: a custom style')
    expect(value).not.toContain('Output style: Team Custom')
  })

  test('relayed unknown-style appends the off-box note after builtin-only list', async () => {
    const value = text(await call('nope', bridgeCtx))
    expect(value).toBe(
      'Unknown output style "nope". Available styles: default, Concise, Explanatory, Learning' +
        "\nCustom output styles can't be selected over Remote Control or from a relayed message. Select one in the session itself, or pick a built-in style here.",
    )
  })

  test('relayed custom-style target is not selectable → unknown message', async () => {
    const value = text(await call('Team Custom', bridgeCtx))
    expect(value).toContain('Unknown output style "Team Custom"')
    expect(value).not.toContain('Team Custom, ')
    expect(mockState.savedPayloads).toEqual([])
  })

  test('relayed builtin switch still works normally', async () => {
    const value = text(await call('concise', bridgeCtx))
    expect(value).toBe('Output style set to Concise')
    expect(mockState.savedPayloads).toEqual([{ outputStyle: 'Concise' }])
  })

  test('relayed save error withholds detail (SAVE_FAILURE_OFF_BOX)', async () => {
    mockState.saveError = new Error('secret internal path /home/x')
    const value = text(await call('Concise', bridgeCtx))
    expect(value).toBe(
      "Couldn't save the output style (detail withheld on this connection).",
    )
    expect(value).not.toContain('secret internal path')
  })

  test('non-relayed context never emits the off-box strings', async () => {
    mockState.saveError = new Error('plain failure')
    const value = text(await call('Concise', ctx))
    expect(value).toBe('Could not save output style: plain failure')
    expect(value).not.toContain('detail withheld')
  })
})
