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
 * CC 2.1.296 (#061): "Increased the maximum length of MCP tool descriptions
 * and server instructions from 2,048 to 4,096 characters" (cl-296 line 63 —
 * the changelog is the authority for the numeric flip; the binary getter
 * constants sns/sxn are not recoverable from the evidence).
 *
 * Official 296 getter keeps the 295 shape —
 *   `Ax(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??(e?sns:sxn)}`
 * with the general-path constant (sxn, formerly t4e/_Rn=2048) now 4096.
 * The tool-search constant (sns≡Qts=16384, CC 2.1.295 #112) is UNCHANGED.
 *
 * OCC mapping: sxn ≡ DEFAULT_MAX_MCP_DESCRIPTION_LENGTH (4096), sns ≡
 * TOOL_SEARCH_MAX_MCP_DESCRIPTION_LENGTH (16384). The env override still
 * wins for both load paths (the official `??`).
 */

const ENV_KEY = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const DEFAULT_LIMIT = 4096
const TOOL_SEARCH_LIMIT = 16384
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

describe('2.1.296 #061 — getMaxMcpDescriptionLength default raised to 4096', () => {
  test('unset env uses the new 4096 default (was 2048 pre-296)', () => {
    expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
  })

  test('the tool-search load path keeps its own 16384 cap (295 #112 unchanged)', () => {
    expect(getMaxMcpDescriptionLength(true)).toBe(TOOL_SEARCH_LIMIT)
  })

  test('the env override wins for BOTH load paths (official `??`)', () => {
    process.env[ENV_KEY] = '2048'
    expect(getMaxMcpDescriptionLength()).toBe(2048)
    expect(getMaxMcpDescriptionLength(true)).toBe(2048)
    process.env[ENV_KEY] = '512'
    expect(getMaxMcpDescriptionLength()).toBe(512)
    expect(getMaxMcpDescriptionLength(true)).toBe(512)
  })
})

describe('2.1.296 #061 — truncateMcpDescription at the raised cap', () => {
  test('a 3000-char description now survives intact (would truncate under the old 2048 cap)', () => {
    const text = 'd'.repeat(3000)
    expect(truncateMcpDescription(text, 'Tool "t" description')).toBe(text)
  })

  test('exactly 4096 chars pass through (length <= cap)', () => {
    const text = 'x'.repeat(DEFAULT_LIMIT)
    expect(truncateMcpDescription(text, 'Tool "t" description')).toBe(text)
  })

  test('4097 chars truncate to 4096 + the official suffix', () => {
    const text = 'y'.repeat(DEFAULT_LIMIT + 1)
    const out = truncateMcpDescription(text, 'Tool "t" description')
    expect(out).toBe('y'.repeat(DEFAULT_LIMIT) + SUFFIX)
  })

  test('a 5000-char description truncates at 4096 and the debug log reports the new cap', () => {
    const text = 'z'.repeat(5000)
    const out = truncateMcpDescription(
      text,
      'Tool "t" description',
      'srv-name',
    )
    expect(out).toBe('z'.repeat(DEFAULT_LIMIT) + SUFFIX)
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv-name',
        message: 'Tool "t" description truncated from 5000 to 4096 chars',
      },
    ])
  })

  test('an explicit tool-search cap (16384) still overrides the default', () => {
    const text = 'w'.repeat(5000)
    expect(
      truncateMcpDescription(text, 'Tool "t" description', undefined, 16384),
    ).toBe(text)
  })

  test('the env override lowers the truncation point below 4096', () => {
    process.env[ENV_KEY] = '1024'
    const text = 'v'.repeat(3000)
    const out = truncateMcpDescription(text, 'Tool "t" description')
    expect(out).toBe('v'.repeat(1024) + SUFFIX)
  })
})

describe('2.1.296 #061 — truncateMcpServerInstructions at the raised cap', () => {
  test('instructions up to 4096 chars survive', () => {
    const text = 'i'.repeat(DEFAULT_LIMIT)
    expect(truncateMcpServerInstructions(text, 'srv')).toBe(text)
  })

  test('instructions beyond 4096 chars truncate with the official suffix', () => {
    const text = 'j'.repeat(4200)
    const out = truncateMcpServerInstructions(text, 'srv')
    expect(out).toBe('j'.repeat(DEFAULT_LIMIT) + SUFFIX)
    expect(mcpDebugLog).toEqual([
      {
        serverName: 'srv',
        message: 'Server instructions truncated from 4200 to 4096 chars',
      },
    ])
  })

  test('falsy instructions pass through untouched', () => {
    expect(truncateMcpServerInstructions(undefined, 'srv')).toBeUndefined()
    expect(truncateMcpServerInstructions('', 'srv')).toBe('')
  })
})
