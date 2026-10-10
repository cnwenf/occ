import { afterEach, describe, expect, test } from 'bun:test'
import { getMaxMcpDescriptionLength, truncateMcpDescription } from '../client.js'

/**
 * Gap #112 (official 2.1.295): MCP tool descriptions loaded THROUGH tool
 * search must be cut at 16,384 chars, not the default 2,048.
 *
 * Official evidence:
 * - Constants @213397583: `_Rn=2048,Qts=16384` (v294 @211972652 had only
 *   `X5o=2048` — no 16384).
 * - Cap getter @217055321:
 *   `function mx(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??(e?Qts:_Rn)}`
 *   — env override wins for BOTH variants; v294 @214595818 was single-cap
 *   `function UF(){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??X5o}`.
 * - Truncator `Jt`: `function Jt(e,r,n,s=mx()){if(e.length<=s)return e;...
 *   return ne(e,s)+"… [truncated]"}` — 4th `limit` param new in v295.
 * - Factory `Vn` @243900998 computes both variants eagerly:
 *   `_e=Jt(Re,label,e)` and `ce=Jt(Re,label,e,mx(!0))`, with
 *   `async prompt({loadedThroughToolSearch:Ee}){return Ee?ce:_e}`.
 */

const ENV_KEY = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const savedEnv = process.env[ENV_KEY]

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
})

describe('getMaxMcpDescriptionLength — v295 dual cap (#112)', () => {
  test('default cap is 2048 for the normal path', () => {
    // Arrange
    delete process.env[ENV_KEY]

    // Act & Assert
    expect(getMaxMcpDescriptionLength()).toBe(2048)
    expect(getMaxMcpDescriptionLength(false)).toBe(2048)
  })

  test('tool-search variant gets the official 16384 cap', () => {
    // Arrange
    delete process.env[ENV_KEY]

    // Act & Assert — mx(!0) → Qts
    expect(getMaxMcpDescriptionLength(true)).toBe(16384)
  })

  test('env override wins for BOTH variants (official ?? short-circuit)', () => {
    // Arrange
    process.env[ENV_KEY] = '500'

    // Act & Assert — env beats 2048 AND 16384
    expect(getMaxMcpDescriptionLength()).toBe(500)
    expect(getMaxMcpDescriptionLength(true)).toBe(500)
  })

  test('invalid env value falls back per variant', () => {
    // Arrange — digitsOnly binding rejects non-integer literals
    process.env[ENV_KEY] = 'abc'

    // Act & Assert
    expect(getMaxMcpDescriptionLength()).toBe(2048)
    expect(getMaxMcpDescriptionLength(true)).toBe(16384)
  })

  test('env value below the min of 1 falls back per variant', () => {
    // Arrange
    process.env[ENV_KEY] = '0'

    // Act & Assert
    expect(getMaxMcpDescriptionLength()).toBe(2048)
    expect(getMaxMcpDescriptionLength(true)).toBe(16384)
  })
})

describe('truncateMcpDescription — v295 4th-param limit (#112)', () => {
  test('text at or under the explicit limit passes through untouched', () => {
    // Arrange
    const text = 'a'.repeat(16384)

    // Act & Assert
    expect(truncateMcpDescription(text, 'Tool "x" description', undefined, 16384)).toBe(
      text,
    )
  })

  test('explicit 16384 limit keeps a 3000-char description whole (the #112 fix scope)', () => {
    // Arrange — would have been cut to 2048 under the v294 single cap
    const text = 'b'.repeat(3000)

    // Act
    const result = truncateMcpDescription(text, 'Tool "x" description', undefined, 16384)

    // Assert
    expect(result).toBe(text)
  })

  test('explicit limit cuts oversize text and appends the official suffix', () => {
    // Arrange
    const text = 'c'.repeat(20000)

    // Act
    const result = truncateMcpDescription(text, 'Tool "x" description', undefined, 16384)

    // Assert — ne(e,s)+"… [truncated]" (U+2026 HORIZONTAL ELLIPSIS)
    expect(result).toBe('c'.repeat(16384) + '… [truncated]')
  })

  test('default limit parameter still resolves to the non-tool-search cap', () => {
    // Arrange — 4th param omitted → default `s=mx()` → 2048 (back-compat)
    delete process.env[ENV_KEY]
    const text = 'd'.repeat(2049)

    // Act
    const result = truncateMcpDescription(text, 'Tool "x" description')

    // Assert
    expect(result).toBe('d'.repeat(2048) + '… [truncated]')
  })
})
