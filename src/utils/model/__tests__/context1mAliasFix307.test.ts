import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  dedup1mSuffix,
  getBestModel,
  getDefaultFableModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  parseUserSpecifiedModel,
} from '../model.js'

/**
 * CC 2.1.307 (A3): CLAUDE_CODE_DISABLE_1M_CONTEXT + `[1m]`-suffixed ALIAS
 * must not fall through raw (model-not-found at the API).
 *
 * Official v306 `Dt` (byte-verified @240941000 in the v306 ELF):
 *   let n=e.trim(),r=n.toLowerCase(),s=hp(r),h=s?Mt(r).trim():r;
 * Official v307 `Lt` (byte-verified @42219830 in new307.txt) is identical
 * EXCEPT the strip is UNCONDITIONAL:
 *   let n=e.trim(),r=n.toLowerCase(),s=am(r),h=Mt(r).trim();
 * with:
 *   function ux(){return a.CLAUDE_CODE_DISABLE_1M_CONTEXT}
 *   function am(e){if(ux())return!1;return bWt(e)}   // ≡ has1mContext
 *   function bWt(e){return/\[1m\]/i.test(e)}
 *   function Mt(e){return e.replace(/\[1m\]$/i,"")}  // single trailing suffix
 *   function kG(e){return e.replace(/(\[1m\])+$/i,"")+"[1m]"} // ≡ dedup1mSuffix
 *
 * v306 failure mode: DISABLE_1M set → hp(r)=false → h keeps "[1m]" → the
 * alias switch misses → every re-append arm is `if(s)`-gated (s=false) →
 * raw `opus[1m]` reaches the API → model-not-found 404.
 */

const DISABLE_1M_ENV = 'CLAUDE_CODE_DISABLE_1M_CONTEXT'

// Env keys that could perturb alias/provider resolution — neutralized per
// test so cross-file env leakage in a shared bun-test process cannot matter.
const NEUTRALIZED_ENV = [
  DISABLE_1M_ENV,
  'USER_TYPE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
]

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of NEUTRALIZED_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of NEUTRALIZED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function parse(input: string): string {
  return parseUserSpecifiedModel(input as never)
}

describe('CC 2.1.307 A3 — DISABLE_1M_CONTEXT + [1m] alias resolves (official Lt)', () => {
  test('opus[1m] resolves to the plain default opus model, not raw passthrough', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('opus[1m]')

    // Assert
    expect(result).toBe(getDefaultOpusModel())
    expect(result).not.toContain('[1m]')
  })

  test('sonnet[1m] resolves to the plain default sonnet model', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('sonnet[1m]')

    // Assert
    expect(result).toBe(getDefaultSonnetModel())
    expect(result).not.toContain('[1m]')
  })

  test('haiku[1m] resolves to the plain default haiku model', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('haiku[1m]')

    // Assert
    expect(result).toBe(getDefaultHaikuModel())
    expect(result).not.toContain('[1m]')
  })

  test('opusplan[1m] resolves to the plain default sonnet model', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('opusplan[1m]')

    // Assert — the opusplan arm returns the sonnet default
    expect(result).toBe(getDefaultSonnetModel())
    expect(result).not.toContain('[1m]')
  })

  test('fable[1m] resolves to the plain default fable model', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('fable[1m]')

    // Assert — has1mTag=false → the append1m arm stays off
    expect(result).toBe(getDefaultFableModel())
    expect(result).not.toContain('[1m]')
  })

  test('best resolves unchanged under DISABLE_1M', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('best')

    // Assert
    expect(result).toBe(getBestModel())
  })

  test('uppercase OPUS[1M] is normalized then resolved (official lowercases)', () => {
    // Arrange
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('OPUS[1M]')

    // Assert
    expect(result).toBe(getDefaultOpusModel())
    expect(result).not.toContain('[1m]')
  })

  test('legacy opus with [1m] reaches the remap arm under DISABLE_1M', () => {
    // Arrange — official v307 also fixes this path: IZe(h) sees the STRIPPED
    // model string, so `claude-opus-4-0[1m]` remaps instead of passing raw.
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('claude-opus-4-0[1m]')

    // Assert
    expect(result).toBe(getDefaultOpusModel())
    expect(result).not.toContain('[1m]')
  })

  test('non-alias model with [1m] passes through unchanged under DISABLE_1M', () => {
    // Arrange
    // Official v307 final arms (byte-verified): `if(s)return lx(n.replace(/(\[1m\])+$/i,"").trim()+"[1m]");return lx(n)`
    // — with DISABLE_1M set, s=false, so a non-alias name returns the ORIGINAL
    // trimmed input including the suffix (v306 behaves identically here; the
    // 307 fix only changes the alias-switch and legacy-remap paths).
    process.env[DISABLE_1M_ENV] = '1'

    // Act
    const result = parse('claude-opus-5[1m]')

    // Assert
    expect(result).toBe('claude-opus-5[1m]')
  })
})

describe('CC 2.1.307 A3 — unset DISABLE_1M behavior unchanged (re-append arms)', () => {
  test('opus[1m] keeps a single deduped [1m] suffix', () => {
    // Act
    const result = parse('opus[1m]')

    // Assert
    expect(result).toBe(dedup1mSuffix(getDefaultOpusModel()))
    expect(result.endsWith('[1m]')).toBe(true)
  })

  test('repeated suffixes collapse to one in the final re-append arm', () => {
    // Act — official v307: Mt strips ONE trailing suffix, so h='opus[1m]'
    // misses every switch case; the final `if(s)` arm returns
    // lx(n.replace(/(\[1m\])+$/i,"").trim()+"[1m]") = 'opus[1m]' — repeated
    // suffixes collapse but the alias itself is not resolved (byte-verified;
    // unchanged from v306 and unchanged by the A3 fix).
    const result = parse('opus[1m][1m]')

    // Assert
    expect(result).toBe('opus[1m]')
    expect(result.match(/\[1m\]/gi)).toHaveLength(1)
  })

  test('bare opus resolves to the plain default', () => {
    // Act
    const result = parse('opus')

    // Assert
    expect(result).toBe(getDefaultOpusModel())
    expect(result).not.toContain('[1m]')
  })
})
