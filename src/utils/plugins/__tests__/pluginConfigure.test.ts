/**
 * Tests for pluginConfigure.ts — the official 2.1.285 `claude plugin configure`
 * core (changelog item 9). User-facing strings are asserted byte-identical to
 * the decompiled v285 `pluginConfigureHandler` (Aa).
 */

import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_CONFIGURE_DISPLAY_FOOTER,
  PLUGIN_CONFIGURE_NO_CHANGES_TEXT,
  PLUGIN_CONFIGURE_SAVED_TEXT,
  PLUGIN_CONFIGURE_STDIN_MAX_BYTES,
  PLUGIN_CONFIGURE_STDIN_OVER_LIMIT,
  PLUGIN_CONFIGURE_VALUE_MAX_BYTES,
  PluginConfigureRefusedError,
  buildConfigureDisplayJson,
  buildConfigureDisplayLines,
  buildConfigureOptionRow,
  buildConfigureRefusedJson,
  buildConfigureSavedJson,
  collectSensitiveRedactionValues,
  configureOptionDisplayName,
  parseBooleanValue,
  parseStdinValuesJson,
  pluralizeOptionWord,
  pluginConfigureCouldNotReadSavedMessage,
  pluginConfigureNotFoundMessage,
  pluginConfigureSaveFailedMessage,
  pluginConfigureSavedRereadFailedMessage,
  pluginConfigureStdinNotJsonObjectMessage,
  pluginConfigureStdinNotPipedMessage,
  redactSensitiveValues,
  validateConfigureValues,
} from '../pluginConfigure.js'

describe('byte caps (official tn/an)', () => {
  test('stdin cap is 256 KB and value cap is 64 KB', () => {
    expect(PLUGIN_CONFIGURE_STDIN_MAX_BYTES).toBe(262144)
    expect(PLUGIN_CONFIGURE_VALUE_MAX_BYTES).toBe(65536)
  })
})

describe('parseStdinValuesJson (official nn)', () => {
  test('accepts a plain object of strings', () => {
    // Act
    const result = parseStdinValuesJson({ a: '1', b: 'two' })

    // Assert
    expect(result).toEqual({ a: '1', b: 'two' })
  })

  test('rejects non-objects, arrays, null, and non-string values', () => {
    expect(parseStdinValuesJson('nope')).toBeUndefined()
    expect(parseStdinValuesJson(null)).toBeUndefined()
    expect(parseStdinValuesJson(['a'])).toBeUndefined()
    expect(parseStdinValuesJson({ a: 1 })).toBeUndefined()
  })
})

describe('sensitive redaction (official $e + O collector)', () => {
  test('collects sensitive values raw+trimmed, non-empty, longest-first', () => {
    // Arrange
    const schema = { tok: { sensitive: true }, plain: {} }
    const values = { tok: '  secret  ', plain: 'visible' }

    // Act
    const collected = collectSensitiveRedactionValues(values, schema)

    // Assert — 'visible' excluded (not sensitive); longest first
    expect(collected).toEqual(['  secret  ', 'secret'])
  })

  test('redacts every sensitive occurrence with U+2026', () => {
    // Act
    const redacted = redactSensitiveValues('leaked secret here', ['secret'])

    // Assert
    expect(redacted).toBe('leaked … here')
  })
})

describe('parseBooleanValue (official LHe)', () => {
  test('accepts the message-specified set case-insensitively', () => {
    expect(parseBooleanValue('true')).toBe(true)
    expect(parseBooleanValue('YES')).toBe(true)
    expect(parseBooleanValue('1')).toBe(true)
    expect(parseBooleanValue('On')).toBe(true)
    expect(parseBooleanValue('false')).toBe(false)
    expect(parseBooleanValue('NO')).toBe(false)
    expect(parseBooleanValue('0')).toBe(false)
    expect(parseBooleanValue('off')).toBe(false)
  })

  test('returns undefined for anything else', () => {
    expect(parseBooleanValue('maybe')).toBeUndefined()
    expect(parseBooleanValue('2')).toBeUndefined()
  })
})

describe('configureOptionDisplayName / pluralizeOptionWord (official pe/P)', () => {
  test('prefers the option title, falling back to the key', () => {
    expect(configureOptionDisplayName('apiKey', { title: 'API Key' })).toBe(
      'API Key',
    )
    expect(configureOptionDisplayName('apiKey', {})).toBe('apiKey')
    expect(configureOptionDisplayName('apiKey', undefined)).toBe('apiKey')
  })

  test('pluralizes "option"', () => {
    expect(pluralizeOptionWord(1)).toBe('option')
    expect(pluralizeOptionWord(2)).toBe('options')
  })
})

describe('message builders (byte-exact)', () => {
  test('not-found names the id and the list command', () => {
    expect(pluginConfigureNotFoundMessage('foo@bar')).toBe(
      'No installed plugin has the id "foo@bar". Use its full id ' +
        '(name@marketplace), as `claude plugin list` shows it.',
    )
  })

  test('not-found adds --cowork to the list command when cowork', () => {
    expect(pluginConfigureNotFoundMessage('foo@bar', true)).toContain(
      '`claude plugin list --cowork`',
    )
  })

  test('stdin usage errors carry the example hint', () => {
    expect(pluginConfigureStdinNotPipedMessage()).toBe(
      'No option values were piped in. Example: claude plugin configure ' +
        '<plugin> --values-stdin < values.json',
    )
    expect(pluginConfigureStdinNotJsonObjectMessage()).toBe(
      "The input on stdin isn't a JSON object of strings. Example: claude " +
        'plugin configure <plugin> --values-stdin < values.json',
    )
    expect(PLUGIN_CONFIGURE_STDIN_OVER_LIMIT).toBe(
      'The input on stdin is over the 256 KB limit.',
    )
  })

  test('save/reread/read messages interpolate the error text', () => {
    expect(pluginConfigureSaveFailedMessage('boom')).toBe(
      'Failed to save configuration: boom',
    )
    expect(pluginConfigureSavedRereadFailedMessage('boom')).toBe(
      'plugin configure: saved, but the re-read of unset options failed: boom',
    )
    expect(pluginConfigureCouldNotReadSavedMessage('foo@bar', 'boom')).toBe(
      'Could not read the saved options for "foo@bar": boom',
    )
  })

  test('saved / no-changes text is byte-exact', () => {
    expect(PLUGIN_CONFIGURE_SAVED_TEXT).toBe(
      'Configuration saved. Restart Claude Code to apply it.',
    )
    expect(PLUGIN_CONFIGURE_NO_CHANGES_TEXT).toBe('No configuration changes.')
  })
})

describe('validateConfigureValues (official ln validation)', () => {
  test('rejects an undeclared option, listing known options', () => {
    // Arrange
    const schema = { tok: { sensitive: true } }

    // Act & Assert
    expect(() => validateConfigureValues(schema, { bogus: 'x' })).toThrow(
      'This plugin has no option "bogus". Known options: tok.',
    )
  })

  test('pluralizes and lists multiple undeclared options', () => {
    // Act & Assert
    expect(() => validateConfigureValues({}, { a: '1', b: '2' })).toThrow(
      'This plugin has no options "a", "b".',
    )
  })

  test('rejects a value over the 64 KB cap', () => {
    // Arrange
    const schema = { tok: {} }
    const values = { tok: 'a'.repeat(PLUGIN_CONFIGURE_VALUE_MAX_BYTES + 1) }

    // Act & Assert
    expect(() => validateConfigureValues(schema, values)).toThrow(
      'tok is too long (over 64 KB).',
    )
  })

  test('rejects a value containing a line break', () => {
    // Act & Assert
    expect(() =>
      validateConfigureValues({ tok: {} }, { tok: 'a\nb' }),
    ).toThrow('tok must be a single line.')
  })

  test('rejects a blank required option', () => {
    // Act & Assert
    expect(() =>
      validateConfigureValues({ tok: { required: true } }, { tok: '   ' }),
    ).toThrow('tok is required but not provided')
  })

  test('allows a blank required sensitive option that already has a value', () => {
    // Arrange — sensitive + required, existing saved value
    const schema = { tok: { required: true, sensitive: true } }

    // Act & Assert — no throw
    expect(() =>
      validateConfigureValues(schema, { tok: '' }, { tok: 'stored' }),
    ).not.toThrow()
  })

  test('rejects a non-boolean value for a boolean option', () => {
    // Act & Assert
    expect(() =>
      validateConfigureValues({ flag: { type: 'boolean' } }, { flag: 'maybe' }),
    ).toThrow('flag must be true or false (or 1/0, yes/no, on/off).')
  })

  test('accepts valid values without throwing', () => {
    // Arrange
    const schema = { tok: { required: true }, flag: { type: 'boolean' } }

    // Act & Assert
    expect(() =>
      validateConfigureValues(schema, { tok: 'abc', flag: 'yes' }),
    ).not.toThrow()
  })

  test('refusal errors carry the reason and option key', () => {
    // Act
    let caught: unknown
    try {
      validateConfigureValues({ flag: { type: 'boolean' } }, { flag: 'x' })
    } catch (error) {
      caught = error
    }

    // Assert
    expect(caught).toBeInstanceOf(PluginConfigureRefusedError)
    const refused = caught as PluginConfigureRefusedError
    expect(refused.option).toBe('flag')
    expect(refused.reason).toBe(
      'plugin configure: option value is not a boolean',
    )
  })
})

describe('display + JSON builders (official Aa render paths)', () => {
  test('builds an option row with flags and title suffix', () => {
    // Act
    const row = buildConfigureOptionRow(
      '>',
      'tok',
      { title: 'Token', required: true, sensitive: true },
      true,
    )

    // Assert — em-dash title suffix, comma-joined flags
    expect(row).toBe('  > tok — Token (required, sensitive, set)')
  })

  test('omits the title suffix when the title equals the key', () => {
    expect(buildConfigureOptionRow('>', 'tok', { title: 'tok' }, false)).toBe(
      '  > tok (optional, not set)',
    )
  })

  test('renders the no-options line when the schema is empty', () => {
    expect(buildConfigureDisplayLines('Acme', 'acme@shop', {}, [], '>')).toEqual(
      ['Acme (acme@shop) has no options to set.'],
    )
  })

  test('renders header, one row per option, blank line, and footer', () => {
    // Arrange
    const schema = { a: { required: true }, b: {} }

    // Act
    const lines = buildConfigureDisplayLines(
      'Acme',
      'acme@shop',
      schema,
      ['a'],
      '>',
    )

    // Assert
    expect(lines[0]).toBe('Options for Acme (acme@shop):')
    expect(lines[1]).toBe('  > a (required, set)')
    expect(lines[2]).toBe('  > b (optional, not set)')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe(PLUGIN_CONFIGURE_DISPLAY_FOOTER)
  })

  test('builds the refused / saved / display JSON envelopes', () => {
    expect(
      buildConfigureRefusedJson('acme@shop', 'Acme', 'tok', 'nope'),
    ).toEqual({
      pluginId: 'acme@shop',
      displayName: 'Acme',
      refused: { option: 'tok', message: 'nope' },
    })
    expect(
      buildConfigureSavedJson('acme@shop', 'Acme', ['tok'], undefined),
    ).toEqual({ pluginId: 'acme@shop', displayName: 'Acme', saved: ['tok'] })
    expect(
      buildConfigureSavedJson('acme@shop', 'Acme', ['tok'], ['other']),
    ).toEqual({
      pluginId: 'acme@shop',
      displayName: 'Acme',
      saved: ['tok'],
      unconfigured: ['other'],
    })
    expect(
      buildConfigureDisplayJson('acme@shop', 'Acme', { a: {} }, {}, {}, [], []),
    ).toEqual({
      pluginId: 'acme@shop',
      displayName: 'Acme',
      schema: { a: {} },
      inputs: {},
      choices: {},
      configured: [],
      unconfigured: [],
    })
  })
})
