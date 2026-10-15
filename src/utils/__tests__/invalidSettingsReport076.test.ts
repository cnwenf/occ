import { describe, expect, test } from 'bun:test'
import {
  MAX_FIELD_CODE_UNITS,
  MAX_REPORTED_ENTRIES_PER_GROUP,
  filterReportableSettingsErrors,
  formatInvalidSettingsEntries,
  reportInvalidSettingsForAutomatedSession,
  sanitizeSettingsField,
  settingsErrorKey,
} from '../invalidSettingsReport.js'
import type { ValidationError } from '../settings/validation.js'

/**
 * CC 2.1.299 (#076): "Fixed `claude -p` saying nothing when a settings file
 * fails validation: text-output runs now list the file and the invalid entry
 * on stderr." Official v299-NEW `jR`/`qR`/`NR`/`$hn` (see
 * src/utils/invalidSettingsReport.ts for offsets + verbatim strings).
 */

function err(partial: Partial<ValidationError> & { path: string }): ValidationError {
  return {
    message: 'invalid value',
    ...partial,
  } as ValidationError
}

describe('filterReportableSettingsErrors (official $hn)', () => {
  test('drops mcpErrorMetadata, statusOnly and startupFatal records', () => {
    const errors = [
      err({ path: 'model', message: 'keep me' }),
      err({ path: 'mcp.x', mcpErrorMetadata: { scope: 'user' } as never }),
      err({ path: 'env.A', statusOnly: true }),
      err({ path: 'whole', startupFatal: true }),
    ]
    const kept = filterReportableSettingsErrors(errors)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.message).toBe('keep me')
  })

  test('empty input → empty output', () => {
    expect(filterReportableSettingsErrors([])).toEqual([])
  })
})

describe('settingsErrorKey (official NR)', () => {
  test('key is file:path:message', () => {
    expect(settingsErrorKey(err({ file: '/a/b.json', path: 'model', message: 'bad' }))).toBe(
      '/a/b.json:model:bad',
    )
    expect(settingsErrorKey(err({ path: 'model', message: 'bad' }))).toBe('undefined:model:bad')
  })
})

describe('sanitizeSettingsField (official Ks maxCodeUnits:500)', () => {
  test('collapses whitespace runs to single spaces and trims', () => {
    expect(sanitizeSettingsField('  a\n\t b   c ')).toBe('a b c')
  })

  test('short values pass through', () => {
    expect(sanitizeSettingsField('model')).toBe('model')
  })

  test('truncates to 500 code units', () => {
    const long = 'x'.repeat(MAX_FIELD_CODE_UNITS + 100)
    expect(sanitizeSettingsField(long)).toHaveLength(MAX_FIELD_CODE_UNITS)
  })

  test('truncation never splits a surrogate pair', () => {
    // 499 ASCII chars then an emoji: the cut lands on the high surrogate,
    // which official `ne` drops rather than emitting a lone surrogate.
    const s = 'y'.repeat(MAX_FIELD_CODE_UNITS - 1) + '😀tail'
    const out = sanitizeSettingsField(s)
    expect(out).toBe('y'.repeat(MAX_FIELD_CODE_UNITS - 1))
    const lastUnit = out.charCodeAt(out.length - 1)
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false)
  })

  test('null/undefined render as empty string', () => {
    expect(sanitizeSettingsField(undefined)).toBe('')
    expect(sanitizeSettingsField(null)).toBe('')
  })
})

describe('formatInvalidSettingsEntries (official qR)', () => {
  test('entry line is "  file (path): message"', () => {
    const out = formatInvalidSettingsEntries(
      [err({ file: '/home/u/.claude/settings.json', path: 'model', message: 'unknown model' })],
      undefined,
    )
    expect(out).toBe('  /home/u/.claude/settings.json (model): unknown model')
  })

  test('missing file renders as "settings"', () => {
    const out = formatInvalidSettingsEntries([err({ path: 'env.X', message: 'bad' })], undefined)
    expect(out).toBe('  settings (env.X): bad')
  })

  test('the --settings flag path renders as "--settings (inline JSON)"', () => {
    const out = formatInvalidSettingsEntries(
      [err({ file: '/tmp/claude-settings-abc.json', path: 'model', message: 'bad' })],
      '/tmp/claude-settings-abc.json',
    )
    expect(out).toBe('  --settings (inline JSON) (model): bad')
  })

  test('more than 10 entries → first 10 plus "… and N more"', () => {
    const entries = Array.from({ length: 13 }, (_, i) =>
      err({ file: '/f.json', path: `k${i}`, message: `m${i}` }),
    )
    const lines = formatInvalidSettingsEntries(entries, undefined).split('\n')
    expect(lines).toHaveLength(MAX_REPORTED_ENTRIES_PER_GROUP + 1)
    expect(lines[10]).toBe('  … and 3 more')
  })
})

describe('reportInvalidSettingsForAutomatedSession (official jR)', () => {
  function run(
    errors: ValidationError[],
    outputFormat: string | undefined,
  ): string[] {
    const written: string[] = []
    reportInvalidSettingsForAutomatedSession(outputFormat, {
      getErrors: () => errors,
      getInlineSettingsPath: () => undefined,
      writeStderr: text => {
        written.push(text)
      },
    })
    return written
  }

  test('no errors → nothing written', () => {
    expect(run([], undefined)).toEqual([])
    expect(run([], 'text')).toEqual([])
  })

  test('hard error lists the not-loaded file block with verbatim header', () => {
    const written = run(
      [err({ file: '/a.json', path: 'hooks.X', message: 'unrecognized key' })],
      'text',
    )
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(
      'These settings files did not load, so nothing in them is in effect, including hooks and permission rules. Each loads again once the problem listed for it is fixed:\n' +
        '  /a.json (hooks.X): unrecognized key\n',
    )
  })

  test('warning-only file entries land in the skipped-entry block', () => {
    const written = run(
      [err({ file: '/b.json', path: 'env.Y', message: 'ignored', severity: 'warning' })],
      undefined,
    )
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(
      "These settings entries were skipped because this version of Claude Code can't apply them; the rest of each file is in effect:\n" +
        '  /b.json (env.Y): ignored\n',
    )
  })

  test('mixed severities: hard-error file pulls ALL its entries into the not-loaded group', () => {
    const written = run(
      [
        err({ file: '/a.json', path: 'hooks.X', message: 'hard' }),
        err({ file: '/a.json', path: 'env.Z', message: 'soft', severity: 'warning' }),
        err({ file: '/b.json', path: 'env.Y', message: 'only-warning', severity: 'warning' }),
      ],
      'text',
    )
    expect(written).toHaveLength(1)
    const [block1, block2] = (written[0] ?? '').split('\nThese settings entries')
    expect(block1).toContain('These settings files did not load')
    expect(block1).toContain('  /a.json (hooks.X): hard')
    expect(block1).toContain('  /a.json (env.Z): soft')
    expect(block2).toContain('  /b.json (env.Y): only-warning')
    // Blocks are joined with '\n' and the whole write ends with '\n'.
    expect(written[0]?.endsWith('\n')).toBe(true)
  })

  test('json and stream-json output formats suppress the stderr write', () => {
    const errors = [err({ file: '/a.json', path: 'hooks.X', message: 'hard' })]
    expect(run(errors, 'json')).toEqual([])
    expect(run(errors, 'stream-json')).toEqual([])
    expect(run(errors, 'text')).toHaveLength(1)
  })

  test('mcp/statusOnly/startupFatal records never reach the report', () => {
    const written = run(
      [
        err({ path: 'mcp.x', mcpErrorMetadata: { scope: 'user' } as never }),
        err({ path: 'env.A', statusOnly: true }),
        err({ path: 'whole', startupFatal: true }),
      ],
      'text',
    )
    expect(written).toEqual([])
  })
})
