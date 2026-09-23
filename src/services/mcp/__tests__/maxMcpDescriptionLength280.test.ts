import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type ErrorLogSink,
  _resetErrorLogForTesting,
  attachErrorLogSink,
} from '../../../utils/log.js'
import {
  getMaxMcpDescriptionLength,
  truncateMcpDescription,
  truncateMcpServerInstructions,
} from '../client.js'

/**
 * claude-code 2.1.280 (#003) — `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`.
 *
 * "Added CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH to change the 2,048-character
 * cap on MCP tool descriptions and server instructions for every MCP server in
 * the session."
 *
 * Byte-verified against the official 2.1.280 linux-x64 ELF:
 *   t4e=2048                                                            @197916615
 *   function lV(){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??t4e}  @199142387
 *   function Zo(e,n){if(!e)return e;return Qo(e,"Server instructions",n)} @223009523
 *   function Qo(e,n,r){let s=lV();if(e.length<=s)return e;
 *     if(r!==void 0)te(r,`${n} truncated from ${e.length} to ${s} chars`);
 *     return re(e,s)+"… [truncated]"}                                   @223009548
 *   xi(...) factory: Ae=Qo(Le,`Tool "${q.name}" description`,e)          @223078250
 *   env schema binding: CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH:()=>ES    @190802428
 *                       ES=M.int({min:1,digitsOnly:!0})                  @190811950
 *
 * The `M.int({min:1,digitsOnly:!0})` transform is the contract asserted here:
 * digits-only integers >= 1 are honored with NO upper clamp; everything else
 * (unset, empty, non-digit, sci-notation, digit separators, fractional, 0,
 * negative) falls back to 2048.
 */

const ENV_KEY = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const DEFAULT_LIMIT = 2048
/** Official suffix: U+2026 HORIZONTAL ELLIPSIS, one space, `[truncated]`. */
const SUFFIX = '… [truncated]'

let savedEnvValue: string | undefined
let mcpDebugLog: Array<{ serverName: string; message: string }> = []

function captureSink(): ErrorLogSink {
  return {
    logError: () => {},
    logMCPError: () => {},
    logMCPDebug: (serverName, message) => {
      mcpDebugLog.push({ serverName, message })
    },
    getErrorsPath: () => '',
    getMCPLogsPath: () => '',
  }
}

beforeEach(() => {
  savedEnvValue = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  mcpDebugLog = []
  _resetErrorLogForTesting()
  attachErrorLogSink(captureSink())
})

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnvValue
  }
  _resetErrorLogForTesting()
})

function withLimit(value: string): number {
  process.env[ENV_KEY] = value
  return getMaxMcpDescriptionLength()
}

function repeat(char: string, count: number): string {
  return char.repeat(count)
}

describe('2.1.280 #003 — getMaxMcpDescriptionLength (binary lV)', () => {
  test('unset env uses the 2048 default (binary t4e)', () => {
    expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
  })

  test('digits-only integer values are honored verbatim', () => {
    expect(withLimit('4096')).toBe(4096)
    expect(withLimit('1')).toBe(1)
    expect(withLimit('65536')).toBe(65536)
  })

  test('a leading + and surrounding whitespace are accepted (schema trims)', () => {
    expect(withLimit('+12')).toBe(12)
    expect(withLimit('  64  ')).toBe(64)
    expect(withLimit('007')).toBe(7)
  })

  test('there is NO upper clamp (M.int has no max for this var)', () => {
    expect(withLimit('100000000')).toBe(100_000_000)
  })

  test('digitsOnly rejects notation the generic int parser would accept', () => {
    // `1e6` / `64_000` / `1,000` parse fine for CLAUDE_CODE_MAX_OUTPUT_TOKENS
    // (plain M.int) but are refused here — digitsOnly gates before ac().
    for (const value of ['1e6', '64_000', '1,000', '1_000_000']) {
      expect(withLimit(value)).toBe(DEFAULT_LIMIT)
    }
  })

  test('non-numeric and fractional values fall back to the default', () => {
    for (const value of ['abc', '12.5', '0x10', '4096chars', 'NaN', '']) {
      expect(withLimit(value)).toBe(DEFAULT_LIMIT)
    }
  })

  test('values below the min:1 bound fall back to the default', () => {
    for (const value of ['0', '-1', '-2048', '-0']) {
      expect(withLimit(value)).toBe(DEFAULT_LIMIT)
    }
  })

  test('the env var is re-read on every call (no per-process memo)', () => {
    process.env[ENV_KEY] = '4096'
    expect(getMaxMcpDescriptionLength()).toBe(4096)
    process.env[ENV_KEY] = '512'
    expect(getMaxMcpDescriptionLength()).toBe(512)
    delete process.env[ENV_KEY]
    expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
  })
})

describe('2.1.280 #003 — truncateMcpDescription (binary Qo)', () => {
  test('text at or under the cap is returned untouched (e.length<=s)', () => {
    const exact = repeat('a', DEFAULT_LIMIT)
    expect(truncateMcpDescription(exact, 'Server instructions')).toBe(exact)
    const short = 'a short description'
    expect(truncateMcpDescription(short, 'Server instructions')).toBe(short)
    expect(mcpDebugLog).toEqual([])
  })

  test('oversized text is cut to the cap plus the exact official suffix', () => {
    const text = repeat('x', DEFAULT_LIMIT + 100)
    const result = truncateMcpDescription(text, 'Server instructions')
    expect(result).toBe(`${repeat('x', DEFAULT_LIMIT)}${SUFFIX}`)
    expect(result.length).toBe(DEFAULT_LIMIT + SUFFIX.length)
    // Suffix bytes: ellipsis (U+2026), single space, "[truncated]".
    expect(result.slice(DEFAULT_LIMIT)).toBe('… [truncated]')
    expect(result.codePointAt(DEFAULT_LIMIT)).toBe(0x2026)
    expect(result.slice(DEFAULT_LIMIT + 1)).toBe(' [truncated]')
  })

  test('a custom env cap is honored end to end', () => {
    process.env[ENV_KEY] = '8'
    expect(truncateMcpDescription('abcdefghijkl', 'Server instructions')).toBe(
      `abcdefgh${SUFFIX}`,
    )
    // The boundary is inclusive: exactly 8 chars stays intact.
    expect(truncateMcpDescription('abcdefgh', 'Server instructions')).toBe(
      'abcdefgh',
    )
  })

  test('invalid env values truncate at the 2048 default', () => {
    process.env[ENV_KEY] = '1e6' // digitsOnly rejects → default
    const text = repeat('y', 3000)
    const result = truncateMcpDescription(text, 'Server instructions')
    expect(result).toBe(`${repeat('y', DEFAULT_LIMIT)}${SUFFIX}`)
  })

  test('logs the official template when a server name is supplied', () => {
    const text = repeat('z', 3000)
    truncateMcpDescription(text, 'Server instructions', 'my-srv')
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'my-srv',
        message: `Server instructions truncated from 3000 to ${DEFAULT_LIMIT} chars`,
      },
    ])
  })

  test('the tool label matches the official xi() factory string', () => {
    process.env[ENV_KEY] = '4'
    truncateMcpDescription('abcdefgh', 'Tool "get_issue" description', 'srv')
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv',
        message: 'Tool "get_issue" description truncated from 8 to 4 chars',
      },
    ])
  })

  test('the reported cap follows the env override', () => {
    process.env[ENV_KEY] = '16'
    truncateMcpDescription(repeat('q', 40), 'Server instructions', 'srv')
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv',
        message: 'Server instructions truncated from 40 to 16 chars',
      },
    ])
  })

  test('no log when the server name is omitted (r!==void 0 guard)', () => {
    truncateMcpDescription(repeat('z', 3000), 'Server instructions')
    expect(mcpDebugLog).toEqual([])
  })
})

describe('2.1.280 #003 — surrogate-aware cut (official re(e,n) contract)', () => {
  /** Lone high surrogate: not followed by a low surrogate. */
  const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
  /** Lone low surrogate: not preceded by a high surrogate. */
  const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  test('an astral char straddling the cap is dropped whole, no lone surrogate leaks', () => {
    process.env[ENV_KEY] = '5'
    // '🙂' = U+1F642 — a surrogate pair occupying UTF-16 indices 4–5, so a
    // plain slice(0, 5) cuts the pair and strands the high surrogate.
    const text = 'abcd🙂efgh'
    const result = truncateMcpDescription(text, 'Server instructions')
    expect(result).not.toMatch(LONE_HIGH_SURROGATE)
    expect(result).not.toMatch(LONE_LOW_SURROGATE)
    // Dropped whole: the body is exactly the BMP prefix before the pair.
    expect(result).toBe(`abcd${SUFFIX}`)
  })

  test('a straddling mathematical-script char (𝒳) behaves identically', () => {
    process.env[ENV_KEY] = '9'
    // '𝒳' = U+1D4B3 — a surrogate pair sitting at UTF-16 indices 8–9 here.
    const text = '01234567𝒳9abc'
    const result = truncateMcpDescription(text, 'Server instructions')
    expect(result).not.toMatch(LONE_HIGH_SURROGATE)
    expect(result).not.toMatch(LONE_LOW_SURROGATE)
    expect(result).toBe(`01234567${SUFFIX}`)
  })

  test('an astral char fully inside the cap is kept whole', () => {
    process.env[ENV_KEY] = '6'
    const text = 'abcd🙂efgh'
    const result = truncateMcpDescription(text, 'Server instructions')
    expect(result).not.toMatch(LONE_HIGH_SURROGATE)
    expect(result).not.toMatch(LONE_LOW_SURROGATE)
    // Kept whole: the complete pair survives at the cut surface.
    expect(result).toBe(`abcd🙂${SUFFIX}`)
    expect(result.includes('🙂')).toBe(true)
  })

  test('BMP text at the boundary is unchanged (no behavior change for non-astral)', () => {
    process.env[ENV_KEY] = '8'
    // The cut lands after 'h' (BMP) — byte-identical to the plain slice.
    expect(truncateMcpDescription('abcdefghijkl', 'Server instructions')).toBe(
      `abcdefgh${SUFFIX}`,
    )
    // Exactly at the cap: returned untouched, no suffix.
    expect(truncateMcpDescription('abcdefgh', 'Server instructions')).toBe(
      'abcdefgh',
    )
  })

  test('the debug log still reports the pre-cut lengths (message unchanged)', () => {
    process.env[ENV_KEY] = '5'
    truncateMcpDescription('abcd🙂efgh', 'Server instructions', 'srv')
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv',
        message: 'Server instructions truncated from 10 to 5 chars',
      },
    ])
  })
})

describe('2.1.280 #003 — truncateMcpServerInstructions (binary Zo)', () => {
  test('undefined and empty instructions pass through untouched', () => {
    expect(truncateMcpServerInstructions(undefined, 'srv')).toBeUndefined()
    expect(truncateMcpServerInstructions('', 'srv')).toBe('')
    expect(mcpDebugLog).toEqual([])
  })

  test('oversized instructions are truncated and logged', () => {
    const result = truncateMcpServerInstructions(repeat('i', 2100), 'srv')
    expect(result).toBe(`${repeat('i', DEFAULT_LIMIT)}${SUFFIX}`)
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv',
        message: `Server instructions truncated from 2100 to ${DEFAULT_LIMIT} chars`,
      },
    ])
  })

  test('instructions within the cap are returned as-is', () => {
    const instructions = 'Use `get_issue` to read an issue.'
    expect(truncateMcpServerInstructions(instructions, 'srv')).toBe(
      instructions,
    )
    expect(mcpDebugLog).toEqual([])
  })
})
