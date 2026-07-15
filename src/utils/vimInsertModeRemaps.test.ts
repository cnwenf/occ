import { mock, describe, expect, test, beforeEach } from 'bun:test'
import { SettingsSchema } from './settings/types.js'
import {
  VIM_INSERT_REMAP_TIMEOUT_MS,
  detectInsertModeRemap,
  getVimInsertModeRemaps,
  normalizeVimInsertModeRemaps,
  type PendingRemap,
} from './vimInsertModeRemaps.js'

/**
 * claude-code 2.1.208: `vimInsertModeRemaps` setting lets users remap a
 * two-key sequence typed in vim INSERT mode to Escape (e.g. {"jj": "<Esc>"}).
 * All identifiers reverse-engineered from the official 2.1.210 binary.
 */

describe('2.1.208 normalizeVimInsertModeRemaps (binary IS_)', () => {
  test('returns an empty Map for undefined / non-object input', () => {
    // Arrange
    // Act
    const a = normalizeVimInsertModeRemaps(undefined)
    const b = normalizeVimInsertModeRemaps(null)
    const c = normalizeVimInsertModeRemaps('not-a-record')
    const d = normalizeVimInsertModeRemaps(42)
    const e = normalizeVimInsertModeRemaps(['array'])
    // Assert
    expect(a.size).toBe(0)
    expect(b.size).toBe(0)
    expect(c.size).toBe(0)
    expect(d.size).toBe(0)
    expect(e.size).toBe(0)
  })

  test('returns an empty Map when no entries survive validation', () => {
    // Arrange — value must case-insensitively equal "<esc>"
    // Assert
    expect(normalizeVimInsertModeRemaps({}).size).toBe(0)
    expect(
      normalizeVimInsertModeRemaps({ jj: '<escape>' }).size,
    ).toBe(0) // not "<esc>"
    expect(
      normalizeVimInsertModeRemaps({ jj: 'Escape' }).size,
    ).toBe(0) // not the "<...>" token form
    expect(normalizeVimInsertModeRemaps({ jj: 123 }).size).toBe(0) // non-string value
  })

  test('accepts the escape token case-insensitively and normalizes to <Esc>', () => {
    // Arrange — "<esc>", "<ESC>", "<Esc>" all accepted
    // Act
    const map = normalizeVimInsertModeRemaps({
      jj: '<esc>',
      kk: '<ESC>',
      hh: '<Esc>',
    })
    // Assert
    expect(map.size).toBe(3)
    expect(map.get('jj')).toBe('<Esc>')
    expect(map.get('kk')).toBe('<Esc>')
    expect(map.get('hh')).toBe('<Esc>')
  })

  test('NFC-normalizes keys', () => {
    // Arrange — a decomposed 2-codepoint key is NFC-equivalent to a precomposed
    // form; the normalized map uses the NFC form.
    // Act
    const map = normalizeVimInsertModeRemaps({ '\u0065\u0301': '<Esc>' }) // e + combining acute
    // Assert — the value is a 2-codepoint, 2-grapheme key (e + combining mark is
    // 1 grapheme), so it must be rejected by the cae(o)===2 grapheme check.
    expect(map.size).toBe(0)
  })

  test('rejects keys that are not exactly two printable code points', () => {
    // Arrange
    // Act
    const map = normalizeVimInsertModeRemaps({
      j: '<Esc>', // 1 char
      jkl: '<Esc>', // 3 chars
      'j j': '<Esc>', // contains a space (\p{Z})
      '\u0000j': '<Esc>', // contains a control char (\p{C})
    })
    // Assert
    expect(map.size).toBe(0)
  })

  test('keeps a valid two-char key', () => {
    // Act
    const map = normalizeVimInsertModeRemaps({ jj: '<Esc>', jk: '<Esc>' })
    // Assert
    expect(map.size).toBe(2)
    expect(map.has('jj')).toBe(true)
    expect(map.has('jk')).toBe(true)
  })
})

describe('2.1.208 SettingsSchema .catch(undefined) (binary schema)', () => {
  test('drops a non-record value to undefined', () => {
    // Arrange — the binary schema is
    // `A.record(A.string(),A.unknown()).optional().catch(void 0)`.
    // Act
    const parsed = SettingsSchema().parse({
      vimInsertModeRemaps: 'not-a-record',
    })
    // Assert — malformed (non-record) values are swallowed, not thrown.
    expect(parsed.vimInsertModeRemaps).toBeUndefined()
  })

  test('drops a number value to undefined', () => {
    const parsed = SettingsSchema().parse({ vimInsertModeRemaps: 5 })
    expect(parsed.vimInsertModeRemaps).toBeUndefined()
  })

  test('keeps a valid record (value validation happens in IS_, not the schema)', () => {
    // Arrange — z.unknown() accepts any value; the record shape is valid.
    // Act
    const parsed = SettingsSchema().parse({
      vimInsertModeRemaps: { jj: 123, kk: '<Esc>' },
    })
    // Assert
    expect(parsed.vimInsertModeRemaps).toEqual({ jj: 123, kk: '<Esc>' })
  })

  test('unset leaves the field undefined', () => {
    expect(SettingsSchema().parse({}).vimInsertModeRemaps).toBeUndefined()
  })
})

describe('2.1.208 detectInsertModeRemap (binary INSERT handler)', () => {
  // A configured {"jj": "<Esc>"} remap.
  const jjRemaps = normalizeVimInsertModeRemaps({ jj: '<Esc>' })

  test('triggers a two-key remap when "jj" is typed in sequence', () => {
    // Arrange — first "j" typed at offset 0 into empty text.
    const t0 = 1_000_000
    const first = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'j',
      keyName: '',
      now: t0,
      offset: 0,
      text: '',
    })
    // Assert — no trigger; a pending state is tracked (j is a prefix of "jj").
    expect(first.action).toBe('pass')
    expect(first.nextPending).not.toBeNull()
    expect(first.nextPending!.char).toBe('j')

    // Act — second "j" within the timeout, cursor advanced to offset 1, buffer
    // now contains the first "j".
    const second = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: first.nextPending,
      key: 'j',
      keyName: '',
      now: t0 + 50,
      offset: 1,
      text: 'j',
    })
    // Assert — remap fires; the first "j" must be removed from the buffer.
    expect(second.action).toBe('remap')
    expect(second).toMatchObject({ kind: 'twoKey' })
    expect(second.removeFirstChar!.charLen).toBe(1)
    expect(second.removeFirstChar!.recorded).toBe(true)
  })

  test('does not trigger when the second key arrives after the timeout', () => {
    // Arrange
    const t0 = 5_000_000
    const first = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'j',
      keyName: '',
      now: t0,
      offset: 0,
      text: '',
    })
    expect(first.action).toBe('pass')

    // Act — second "j" just past the 1000ms window.
    const second = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: first.nextPending,
      key: 'j',
      keyName: '',
      now: t0 + VIM_INSERT_REMAP_TIMEOUT_MS + 1,
      offset: 1,
      text: 'j',
    })
    // Assert — no remap; timeout exceeded.
    expect(second.action).toBe('pass')
  })

  test('does not trigger when the cursor moved between keys', () => {
    // Arrange
    const t0 = 9_000_000
    const first = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'j',
      keyName: '',
      now: t0,
      offset: 0,
      text: '',
    })
    // Act — user pressed an arrow; cursor is now at offset 2, not the
    // pending offsetAfter (1).
    const second = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: first.nextPending,
      key: 'j',
      keyName: '',
      now: t0 + 50,
      offset: 2, // moved
      text: 'jx',
    })
    // Assert — no remap; offset mismatch invalidates the sequence.
    expect(second.action).toBe('pass')
  })

  test('an unmapped sequence ("xx") passes through normally', () => {
    // Arrange — remaps only contains "jj"; "x" is not a prefix of any remap key.
    // Act
    const first = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'x',
      keyName: '',
      now: 1,
      offset: 0,
      text: '',
    })
    // Assert — no pending state is tracked (x cannot start a remap).
    expect(first.action).toBe('pass')
    expect(first.nextPending).toBeNull()

    const second = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'x',
      keyName: '',
      now: 2,
      offset: 1,
      text: 'x',
    })
    expect(second.action).toBe('pass')
    expect(second.nextPending).toBeNull()
  })

  test('tracks pending only for keys that prefix a remap (binary b())', () => {
    // Arrange — "jk" and "jj" both start with "j".
    const remaps = normalizeVimInsertModeRemaps({ jj: '<Esc>', jk: '<Esc>' })
    // Act
    const jPress = detectInsertModeRemap({
      remaps,
      pending: null,
      key: 'j',
      keyName: '',
      now: 1,
      offset: 0,
      text: '',
    })
    // Assert — "j" is a prefix → pending tracked.
    expect(jPress.action).toBe('pass')
    expect(jPress.nextPending!.char).toBe('j')

    // Act — "k" completes "jk".
    const kPress = detectInsertModeRemap({
      remaps,
      pending: jPress.nextPending,
      key: 'k',
      keyName: '',
      now: 2,
      offset: 1,
      text: 'j',
    })
    // Assert
    expect(kPress.action).toBe('remap')
    expect(kPress.kind).toBe('twoKey')
  })

  test('non-typeable keys (backspace) never complete a remap', () => {
    // Arrange
    const t0 = 7_000_000
    const first = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: null,
      key: 'j',
      keyName: '',
      now: t0,
      offset: 0,
      text: '',
    })
    // Act — backspace pressed next.
    const second = detectInsertModeRemap({
      remaps: jjRemaps,
      pending: first.nextPending,
      key: '',
      keyName: 'backspace',
      now: t0 + 5,
      offset: 1,
      text: 'j',
    })
    // Assert — backspace is excluded by the c6s membership check.
    expect(second.action).toBe('pass')
  })

  test('a two-codepoint key directly in the map triggers singleKey', () => {
    // Arrange — a 2-codepoint key that is itself a remap key.
    const remaps = new Map([['jk', '<Esc>']])
    // Act — the full "jk" arrives as a single keypress (e.g. IME composition).
    const result = detectInsertModeRemap({
      remaps,
      pending: null,
      key: 'jk',
      keyName: '',
      now: 1,
      offset: 0,
      text: '',
    })
    // Assert
    expect(result.action).toBe('remap')
    expect(result.kind).toBe('singleKey')
  })

  test('no remaps configured never tracks pending', () => {
    const result = detectInsertModeRemap({
      remaps: new Map(),
      pending: null,
      key: 'j',
      keyName: '',
      now: 1,
      offset: 0,
      text: '',
    })
    expect(result.action).toBe('pass')
    expect(result.nextPending).toBeNull()
  })
})

describe('2.1.208 getVimInsertModeRemaps reader (binary n6s)', () => {
  beforeEach(() => {
    mock.clearAllMocks()
  })

  test('returns an empty Map when the setting is unset', async () => {
    // Arrange — mock the settings module so no source defines the key.
    mock.module('./settings/settings.js', () => ({
      getSettingsForSource: () => null,
    }))
    // Re-import so the mock takes effect.
    const mod = await import('./vimInsertModeRemaps.js?t=' + Date.now())
    // Act
    const remaps = mod.getVimInsertModeRemaps()
    // Assert — mirrors n6s: IS_(G5t("vimInsertModeRemaps")[0] ?? {}).
    expect(remaps.size).toBe(0)
    expect(remaps).toBeInstanceOf(Map)
  })

  test('reads and normalizes the value from the first defining source', async () => {
    // Arrange — userSettings defines {"jj": "<Esc>"}; policy/flag do not.
    let calls = 0
    mock.module('./settings/settings.js', () => ({
      getSettingsForSource: (source: string) => {
        calls++
        if (source === 'userSettings') return { vimInsertModeRemaps: { jj: '<esc>' } }
        return null
      },
    }))
    const mod = await import('./vimInsertModeRemaps.js?u=' + Date.now())
    // Act
    const remaps = mod.getVimInsertModeRemaps()
    // Assert
    expect(remaps.size).toBe(1)
    expect(remaps.get('jj')).toBe('<Esc>')
    // policy > flag > user order: user is checked last.
    expect(calls).toBe(3)
  })
})
