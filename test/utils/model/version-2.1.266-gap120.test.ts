import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * Gap-120 tests — OCC version catch-up 2.1.263 → 2.1.266
 * (issue OCC-120, round 2026-09-10).
 *
 * Gap-120a: /model save confirmation (official 2.1.265) — the picker no
 *   longer claims "saved as your default" when the settings write fails;
 *   it falls back to "for this session only" + a failure suffix.
 *   Binary-verbatim: official 2.1.266 `DKe`/`wMe`/`vMe`.
 * Gap-120b: chord timeout (official 2.1.265) — two-key shortcuts wait
 *   3 seconds (was 1) and announce the cancellation with a notification.
 *   Binary-verbatim: `var Nn=3000;` + `chord-timeout` notification copy.
 * Gap-120c: `opusplan[1m]` alias acceptance (official 2.1.265) — alias
 *   registration + sonnet-1m gate set + renderModelSetting resolution.
 *   Binary-verbatim: official 2.1.266 `lin`/`v9`/`XC`/`ND`.
 * Gap-120d: stale 1M-unavailable copy fix — "Opus/Sonnet with 1M context
 *   is not available for your account." (byte-identical in the official
 *   2.1.263 AND 2.1.266 binaries; OCC carried stale "Opus 4.6/Sonnet 4.6"
 *   wording).
 *
 * See docs/upstream-version-gap-occ120.md for offsets and full triage.
 */

import {
  renderModelSaveFailureSuffix,
  type ModelDefaultSaveResult,
} from '../../../src/commands/model/model.js'
import { MODEL_ALIASES, isModelAlias } from '../../../src/utils/model/aliases.js'
import {
  getDefaultSonnetModel,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  renderModelName,
  renderModelSetting,
} from '../../../src/utils/model/model.js'
import { chordToDisplayString, parseChord } from '../../../src/keybindings/parser.js'

const SRC = join(process.cwd(), 'src')

// Deterministic userSettings path: point the Claude config dir at a temp dir
// so renderModelSaveFailureSuffix() resolves a predictable settings.json path.
let configDir = ''
let savedConfigDir: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'occ-gap120-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

// ============================================================================
// Gap-120a — /model save confirmation
// ============================================================================

describe('Gap-120a: renderModelSaveFailureSuffix copy (official `vMe`)', () => {
  test('returns empty string when the save succeeded', () => {
    expect(renderModelSaveFailureSuffix({ kind: 'saved' })).toBe('')
  })

  test("invalid-JSON write failure renders \"isn't valid JSON\" with the settings path", () => {
    const result: ModelDefaultSaveResult = {
      kind: 'failed',
      error: new Error(`Invalid JSON syntax in settings file at ${join(configDir, 'settings.json')}`),
    }
    const suffix = renderModelSaveFailureSuffix(result)
    // Official copy: ` · couldn't save it as your default: <path> isn't valid JSON`
    expect(suffix).toBe(
      ` \xB7 couldn't save it as your default: ${join(configDir, 'settings.json')} isn't valid JSON`,
    )
  })

  test('other write failures render "can\'t be written (<cause>)"', () => {
    const result: ModelDefaultSaveResult = {
      kind: 'failed',
      error: new Error('EACCES: permission denied, open settings.json'),
    }
    const suffix = renderModelSaveFailureSuffix(result)
    expect(suffix).toBe(
      ` \xB7 couldn't save it as your default: ${join(configDir, 'settings.json')} can't be written (EACCES: permission denied, open settings.json)`,
    )
  })
})

describe('Gap-120a: handleSelect assembly (source-verified, official `DKe`)', () => {
  const src = readFileSync(join(SRC, 'commands/model/model.tsx'), 'utf-8')

  test('the save result gates the saved/session-only base copy', () => {
    expect(src).toContain('const saveResult = saveModelAsDefault(model)')
    expect(src).toContain(' and saved as your default for new sessions')
    expect(src).toContain(' for this session only')
    expect(src).toContain('isSaved ?')
  })

  test('the failure suffix is appended after fast-mode and before the billed suffix', () => {
    // Official assembly order: base → fast-mode(gX) → vMe → billed(sin/iin).
    const failureIdx = src.indexOf('renderModelSaveFailureSuffix(saveResult)')
    const fastModeIdx = src.indexOf('" \\xB7 Fast mode ON"')
    const billedIdx = src.indexOf('" \\xB7 Billed as extra usage"')
    expect(failureIdx).toBeGreaterThan(-1)
    expect(fastModeIdx).toBeGreaterThan(-1)
    expect(billedIdx).toBeGreaterThan(-1)
    expect(failureIdx).toBeGreaterThan(fastModeIdx)
    expect(failureIdx).toBeLessThan(billedIdx)
  })

  test('the fire-and-forget save is gone', () => {
    expect(src).not.toContain('updateSettingsForSource("userSettings", { model });\n    let message')
  })
})

// ============================================================================
// Gap-120b — chord timeout 1000 → 3000ms + cancellation notice
// ============================================================================

describe('Gap-120b: chord timeout (source-verified, official `Nn=3000`)', () => {
  const src = readFileSync(join(SRC, 'keybindings/KeybindingProviderSetup.tsx'), 'utf-8')

  test('the timeout constant is 3000ms and exported', () => {
    expect(src).toContain('export const CHORD_TIMEOUT_MS = 3000')
  })

  test('the timeout callback emits the official chord-timeout notification', () => {
    expect(src).toContain('key: "chord-timeout"')
    expect(src).toContain('cancelled — no next key within ')
    expect(src).toContain('CHORD_TIMEOUT_MS / 1000')
    expect(src).toContain('priority: "immediate"')
    expect(src).toContain('timeoutMs: 3000')
  })

  test('the notification text formatter produces the official shape', () => {
    // Official: `${tK(x, w0())} cancelled — no next key within ${Nn/1000}s`
    // with tK = chordToDisplayString, w0 = getPlatform.
    const chord = parseChord('ctrl+c r')
    const text = `${chordToDisplayString(chord, 'linux')} cancelled — no next key within ${3000 / 1000}s`
    expect(text).toBe('ctrl+c r cancelled — no next key within 3s')
  })
})

// ============================================================================
// Gap-120c — opusplan[1m] alias acceptance
// ============================================================================

describe('Gap-120c: opusplan[1m] alias', () => {
  test('is registered in MODEL_ALIASES', () => {
    expect((MODEL_ALIASES as readonly string[])).toContain('opusplan[1m]')
    expect(isModelAlias('opusplan[1m]')).toBe(true)
  })

  test('parses to the default sonnet model with the [1m] suffix', () => {
    // Official parse path (2.1.266 `Et`): opusplan[1m] → sonnet default + [1m]
    // (Sonnet in normal mode; the plan-mode upgrade to opus[1m] lives in the
    // runtime model resolution, unchanged).
    expect(parseUserSpecifiedModel('opusplan[1m]')).toBe(
      `${getDefaultSonnetModel()}[1m]`,
    )
  })

  test('renderModelSetting resolves it instead of capitalizing the raw alias', () => {
    // Official `ND`: opusplan[1m] falls into the alias branch →
    // Gs(Et(e)) = renderModelName(parseUserSpecifiedModel(e)).
    expect(renderModelSetting('opusplan[1m]')).toBe(
      renderModelName(parseUserSpecifiedModel('opusplan[1m]')),
    )
    expect(renderModelSetting('opusplan[1m]')).not.toBe('Opusplan[1m]')
    // The plain opusplan special case is untouched.
    expect(renderModelSetting('opusplan')).toBe('Opus Plan')
  })

  test('renderDefaultModelSetting keeps the official `bW` behavior', () => {
    // Official `bW`: only bare "opusplan" gets the plan-mode sentence;
    // opusplan[1m] resolves through parseUserSpecifiedModel.
    expect(renderDefaultModelSetting('opusplan')).toBe(
      'Opus in plan mode, else Sonnet',
    )
    expect(renderDefaultModelSetting('opusplan[1m]')).toBe(
      renderModelName(parseUserSpecifiedModel('opusplan[1m]')),
    )
  })

  test('the sonnet-1m gate set matches the official `lin` (source-verified)', () => {
    const src = readFileSync(join(SRC, 'commands/model/model.tsx'), 'utf-8')
    expect(src).toContain("m.includes('sonnet[1m]')")
    expect(src).toContain("m.includes('sonnet-4-6[1m]')")
    expect(src).toContain("m.includes('sonnet-5[1m]')")
    expect(src).toContain("m.trim() === 'opusplan[1m]'")
  })
})

// ============================================================================
// Gap-120d — stale 1M-unavailable copy fix
// ============================================================================

describe('Gap-120d: 1M-unavailable copy is byte-current with the official binary', () => {
  const src = readFileSync(join(SRC, 'commands/model/model.tsx'), 'utf-8')

  test('uses the official current wording', () => {
    expect(src).toContain(
      'Opus with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
    )
    expect(src).toContain(
      'Sonnet with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
    )
  })

  test('the stale "4.6" wording is gone from the /model command', () => {
    expect(src).not.toContain('Opus 4.6 with 1M context is not available')
    expect(src).not.toContain('Sonnet 4.6 with 1M context is not available')
  })
})
