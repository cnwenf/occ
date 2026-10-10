import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getMaxMcpDescriptionLength, truncateMcpDescription } from '../client.js'

/**
 * Official Claude Code v2.1.295 item #112 — "MCP tool descriptions loaded
 * through tool search are now truncated at 16,384 characters instead of 2,048."
 *
 * Byte-verified against the v295 linux-x64 ELF:
 *
 * - @213397142 `_Rn=2048,Qts=16384` — s295-only (s294 has neither token).
 * - @~217055278 `mx(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??
 *   (e?Qts:_Rn)}` — s294's `UF(){return ...??X5o}` had NO branch; the
 *   `loadedThroughToolSearch` parameter is the 295 delta. The env override
 *   wins for BOTH load paths (single `??` in front of the branch).
 * - @243847045 truncator gained a cap parameter: `Jt(e,r,n,s=mx())`.
 * - @243900141 MCP tool factory computes two eager variants
 *   `_e=Jt(Re,`Tool "${q.name}" description`,e)` and `ce=Jt(Re,...,e,mx(!0))`,
 *   and `async prompt({loadedThroughToolSearch:Ee}){return Ee?ce:_e}`
 *   (dup factory @244085866). Call site @217614375 sets the flag only for
 *   tool-search-discovered tools; schema-cache bit @215678602 adds `"LT:"`
 *   when `loadedThroughToolSearch===!0&&isMcp===!0`.
 *
 * Scope note: OCC's Tool.prompt options type (src/Tool.ts) and the API-schema
 * serializer (src/utils/api.ts) do not plumb `loadedThroughToolSearch` yet —
 * both are outside this change's file cluster. The MCP factory's prompt() in
 * client.ts already reads the flag structurally, so behavior stays exactly
 * 2048 for every current caller and flips to 16384 the moment the flag is
 * plumbed. This suite pins the cap layer (mx/Jt equivalents).
 */

const ENV_KEY = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const DEFAULT_LIMIT = 2048
const TOOL_SEARCH_LIMIT = 16384
/** Official suffix: U+2026 HORIZONTAL ELLIPSIS, one space, `[truncated]`. */
const SUFFIX = '… [truncated]'

let savedEnvValue: string | undefined

beforeEach(() => {
  savedEnvValue = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnvValue
  }
})

describe('2.1.295 #112 — getMaxMcpDescriptionLength (binary mx @~217055278)', () => {
  test('general path stays 2048, tool-search path is 16384 (env unset)', () => {
    // Arrange / Act / Assert — `mx(e=!1){return ...??(e?Qts:_Rn)}`
    expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
    expect(getMaxMcpDescriptionLength(false)).toBe(DEFAULT_LIMIT)
    expect(getMaxMcpDescriptionLength(true)).toBe(TOOL_SEARCH_LIMIT)
  })

  test('env override wins for BOTH load paths (single ?? in front of the branch)', () => {
    // Arrange
    process.env[ENV_KEY] = '512'

    // Act / Assert
    expect(getMaxMcpDescriptionLength()).toBe(512)
    expect(getMaxMcpDescriptionLength(true)).toBe(512)
  })

  test('invalid env values fall back per-path (digitsOnly, min 1 — 280 contract intact)', () => {
    // Arrange / Act / Assert
    for (const invalid of ['abc', '0', '-5', '1e6', '64_000', '', '1.5']) {
      process.env[ENV_KEY] = invalid
      expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
      expect(getMaxMcpDescriptionLength(true)).toBe(TOOL_SEARCH_LIMIT)
    }
  })
})

describe('2.1.295 #112 — truncateMcpDescription cap parameter (binary Jt @243847045)', () => {
  test('default cap still truncates a 3000-char description at 2048 + suffix', () => {
    // Arrange
    const text = 'x'.repeat(3000)

    // Act
    const result = truncateMcpDescription(text, 'Tool "t" description')

    // Assert
    expect(result).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
  })

  test('explicit 16384 cap passes a 3000-char description through untouched', () => {
    // Arrange
    const text = 'x'.repeat(3000)

    // Act — the factory's tool-search variant: Jt(Re,label,e,mx(!0))
    const result = truncateMcpDescription(
      text,
      'Tool "t" description',
      undefined,
      getMaxMcpDescriptionLength(true),
    )

    // Assert
    expect(result).toBe(text)
  })

  test('explicit 16384 cap truncates a 20000-char description at 16384 + suffix', () => {
    // Arrange
    const text = 'y'.repeat(20000)

    // Act
    const result = truncateMcpDescription(
      text,
      'Tool "t" description',
      undefined,
      getMaxMcpDescriptionLength(true),
    )

    // Assert
    expect(result).toBe('y'.repeat(TOOL_SEARCH_LIMIT) + SUFFIX)
  })

  test('explicit cap parameter is honored verbatim (arbitrary small cap)', () => {
    // Arrange / Act
    const result = truncateMcpDescription(
      'abcdefghijkl',
      'Tool "t" description',
      undefined,
      4,
    )

    // Assert
    expect(result).toBe('abcd' + SUFFIX)
  })
})
