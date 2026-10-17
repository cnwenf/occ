/**
 * CC 2.1.302 changelog #07 — alias-conditional model specifier normalizer.
 *
 * Official v302 (`dFt`, byte-verified @237166167):
 *   function dFt(e){return Xge(e.toLowerCase().trim())?Ot(e):e}
 *
 * `Xge` = membership test against the bare alias list `sU`
 * (fable/opusplan/sonnet/haiku/opus/best); `Ot` = parseUserSpecifiedModel.
 * v301 ran `Ot` UNCONDITIONALLY inside the settings-key builder, so a
 * concrete gateway-prefixed model (e.g. `anthropic/claude-opus-4-1`) hit the
 * legacy-Opus remap and became the default-Opus key. v302 normalizes ONLY
 * bare aliases; concrete model strings (prefixed or not) pass through
 * untouched (identity — no trim, no case folding).
 */
import { describe, expect, test } from 'bun:test'
import {
  normalizeModelSpecifier,
  parseUserSpecifiedModel,
} from '../model.js'

describe('CC 2.1.302 #07 — normalizeModelSpecifier (official dFt)', () => {
  test("bare 'opus' resolves to a concrete model, not the literal alias", () => {
    // Act
    const resolved = normalizeModelSpecifier('opus')

    // Assert: resolved through the alias switch (≡ parseUserSpecifiedModel),
    // never the literal 'opus' (the v301 OCC leak: getCanonicalName('opus')
    // === 'opus' as a settings key).
    expect(resolved).not.toBe('opus')
    expect(resolved).toBe(parseUserSpecifiedModel('opus'))
  })

  test("bare 'sonnet' resolves to a concrete model", () => {
    const resolved = normalizeModelSpecifier('sonnet')
    expect(resolved).not.toBe('sonnet')
    expect(resolved).toBe(parseUserSpecifiedModel('sonnet'))
  })

  test("bare 'haiku' resolves to a concrete model", () => {
    const resolved = normalizeModelSpecifier('haiku')
    expect(resolved).not.toBe('haiku')
    expect(resolved).toBe(parseUserSpecifiedModel('haiku'))
  })

  test("every bare alias arm (fable/opusplan/best) resolves", () => {
    for (const alias of ['fable', 'opusplan', 'best'] as const) {
      const resolved = normalizeModelSpecifier(alias)
      expect(resolved).not.toBe(alias)
      expect(resolved).toBe(parseUserSpecifiedModel(alias))
    }
  })

  test('gateway-prefixed concrete model passes through UNCHANGED (identity)', () => {
    // The changelog case: a gateway names Opus 4.1 with a prefix. v301's
    // unconditional parse remapped it to the default Opus; v302 (and this
    // port) never runs the alias/remap ladder on a concrete string.
    const prefixed = 'anthropic/claude-opus-4-1'
    expect(normalizeModelSpecifier(prefixed)).toBe(prefixed)
  })

  test('bare concrete model IDs pass through unchanged', () => {
    for (const concrete of [
      'claude-opus-4-1',
      'claude-opus-4-20250514',
      'claude-sonnet-4-6',
      'claude-opus-5-5',
    ]) {
      expect(normalizeModelSpecifier(concrete)).toBe(concrete)
    }
  })

  test('whitespace/case around a bare alias still resolves (official lowercases+trims for the membership test)', () => {
    expect(normalizeModelSpecifier(' opus ')).toBe(parseUserSpecifiedModel('opus'))
    expect(normalizeModelSpecifier('OPUS')).toBe(parseUserSpecifiedModel('opus'))
    expect(normalizeModelSpecifier('Sonnet')).toBe(parseUserSpecifiedModel('sonnet'))
  })

  test('unknown concrete strings pass through unchanged (no trim/case folding on the identity path)', () => {
    expect(normalizeModelSpecifier('my-custom-deployment-123')).toBe(
      'my-custom-deployment-123',
    )
    expect(normalizeModelSpecifier(' My-Gateway-Model ')).toBe(
      ' My-Gateway-Model ',
    )
  })

  test('[1m]-suffixed aliases are NOT bare aliases (official Xge tests the raw string against sU)', () => {
    // dFt membership runs on the raw lowercased/trimmed string, so 'opus[1m]'
    // is not in sU and passes through untouched.
    expect(normalizeModelSpecifier('opus[1m]')).toBe('opus[1m]')
    expect(normalizeModelSpecifier('sonnet[1m]')).toBe('sonnet[1m]')
  })
})
