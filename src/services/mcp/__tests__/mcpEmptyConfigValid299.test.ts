import { afterEach, describe, expect, test } from 'bun:test'

import {
  type FsOperations,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'
import { parseMcpConfigFromFilePath } from '../config.js'

/**
 * claude-code 2.1.299 changelog #32 (ledger row 60):
 *   "Fixed `claude mcp list`, `claude doctor` and `/status` reporting an empty
 *    `.mcp.json` as invalid."
 *
 * OCC root cause: an EMPTY `.mcp.json` (0 bytes / whitespace-only) is read as an
 * empty string; `safeParseJSON('')` returns null (`if (!json) return null`), so
 * `readMcpConfigFileContents` reports the fatal error "MCP config is not a valid
 * JSON". `mcp list` / `doctor` / `/status` surface that fatal error as "invalid".
 * An empty file is a legitimate "no servers configured" state, not a JSON syntax
 * error, so it must parse as a valid config with zero servers and NO error.
 *
 * Fix: in `readMcpConfigFileContents`, treat whitespace-only content as an empty
 * server map (`{ mcpServers: {} }`) before the JSON-parse gate, so it flows
 * through `parseMcpConfig` as a valid config with zero servers.
 */

function fakeFsWithContent(content: string): FsOperations {
  return {
    readFileSync: () => content,
  } as unknown as FsOperations
}

afterEach(() => {
  setOriginalFsImplementation()
})

describe('parseMcpConfigFromFilePath — 2.1.299 #32 empty .mcp.json is valid', () => {
  test('a 0-byte .mcp.json parses as a valid config with zero servers', () => {
    setFsImplementation(fakeFsWithContent(''))
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath: '/proj/.mcp.json',
      expandVars: false,
      scope: 'project',
    })
    expect(errors).toEqual([])
    expect(config).not.toBeNull()
    expect(Object.keys(config?.mcpServers ?? {})).toEqual([])
  })

  test('a whitespace-only .mcp.json parses as a valid config with zero servers', () => {
    setFsImplementation(fakeFsWithContent('   \n\t  \n'))
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath: '/proj/.mcp.json',
      expandVars: false,
      scope: 'project',
    })
    expect(errors).toEqual([])
    expect(config).not.toBeNull()
    expect(Object.keys(config?.mcpServers ?? {})).toEqual([])
  })

  test('a genuinely malformed .mcp.json is still reported invalid (regression)', () => {
    setFsImplementation(fakeFsWithContent('{ not json'))
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath: '/proj/.mcp.json',
      expandVars: false,
      scope: 'project',
    })
    expect(config).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toContain('not a valid JSON')
  })

  test('a populated .mcp.json still parses its servers (regression)', () => {
    setFsImplementation(
      fakeFsWithContent(
        JSON.stringify({
          mcpServers: { srv: { type: 'stdio', command: 'node', args: ['x'] } },
        }),
      ),
    )
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath: '/proj/.mcp.json',
      expandVars: false,
      scope: 'project',
    })
    expect(errors).toEqual([])
    expect(Object.keys(config?.mcpServers ?? {})).toEqual(['srv'])
  })
})
