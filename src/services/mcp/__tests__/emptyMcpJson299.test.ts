/**
 * CC 2.1.299 #032 — an EMPTY `.mcp.json` (`{}` or a blank file) must be
 * treated as a VALID config with zero servers, not reported invalid by
 * `mcp list` / doctor / `/status`.
 *
 * Official evidence (v299 binary, NEW — absent from v296):
 *  - `ast` @226018857: blank PROJECT-scope .mcp.json short-circuits to a
 *    valid empty-server config with the debug log
 *    `MCP config is blank, read as no servers: <path>`.
 *  - `lCe` @226003329 (write-back reader): parses `mcpServers` with
 *    `.default({})` — an object without mcpServers is still parseable.
 *
 * OCC implementation: parseMcpConfig early-returns `{mcpServers:{}}` for a
 * keyless object; readMcpConfigFileContents short-circuits blank project
 * files before safeParseJSON. Malformed JSON and the `{servers:...}` typo
 * (an object WITH keys) still fail.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from '../config.js'

const tempDirs: string[] = []

function makeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-empty-mcp-299-'))
  tempDirs.push(dir)
  const filePath = join(dir, '.mcp.json')
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('#032 parseMcpConfig — empty object is valid', () => {
  test('treats `{}` as a valid config with zero servers (project scope)', () => {
    // Arrange / Act
    const { config, errors } = parseMcpConfig({
      configObject: {},
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(errors).toEqual([])
    expect(config).toEqual({ mcpServers: {} })
    expect(Object.keys(config?.mcpServers ?? {})).toHaveLength(0)
  })

  test('treats `{}` as a valid config with zero servers (user scope)', () => {
    // Arrange / Act
    const { config, errors } = parseMcpConfig({
      configObject: {},
      expandVars: false,
      scope: 'user',
    })

    // Assert
    expect(errors).toEqual([])
    expect(config).toEqual({ mcpServers: {} })
  })

  test('still rejects an object WITH unknown keys (the `{servers:...}` typo)', () => {
    // Arrange / Act — `{}` leniency must NOT swallow typo'd configs
    const { config, errors } = parseMcpConfig({
      configObject: { servers: { foo: { command: 'x' } } },
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(config).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toBe(
      'Does not adhere to MCP server configuration schema',
    )
  })

  test('still rejects null and array inputs', () => {
    // Arrange / Act
    const nullResult = parseMcpConfig({
      configObject: null,
      expandVars: false,
      scope: 'project',
    })
    const arrayResult = parseMcpConfig({
      configObject: [],
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(nullResult.config).toBeNull()
    expect(nullResult.errors.length).toBeGreaterThan(0)
    expect(arrayResult.config).toBeNull()
    expect(arrayResult.errors.length).toBeGreaterThan(0)
  })
})

describe('#032 parseMcpConfigFromFilePath — blank/empty project file is valid', () => {
  test('`{}` project file → valid, zero servers, no errors', () => {
    // Arrange
    const filePath = makeTempFile('{}')

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(errors).toEqual([])
    expect(config).toEqual({ mcpServers: {} })
  })

  test('whitespace-only project file → valid, zero servers (official `ast` short-circuit)', () => {
    // Arrange
    const filePath = makeTempFile('   \n\t  \n ')

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(errors).toEqual([])
    expect(config).toEqual({ mcpServers: {} })
  })

  test('empty (0-byte) project file → valid, zero servers', () => {
    // Arrange
    const filePath = makeTempFile('')

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(errors).toEqual([])
    expect(config).toEqual({ mcpServers: {} })
  })

  test('malformed JSON project file → still invalid (fatal)', () => {
    // Arrange
    const filePath = makeTempFile('{invalid')

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(config).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('MCP config is not a valid JSON')
    expect(errors[0]?.mcpErrorMetadata?.severity).toBe('fatal')
  })

  test('whitespace-only NON-project file keeps the strict JSON path (project-only short-circuit)', () => {
    // Arrange — official `ast` gates on `s==="project"`; user scope stays strict
    const filePath = makeTempFile('   \n ')

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'user',
    })

    // Assert
    expect(config).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('MCP config is not a valid JSON')
  })

  test('populated project file still parses normally (no regression)', () => {
    // Arrange
    const filePath = makeTempFile(
      JSON.stringify({
        mcpServers: {
          'my-server': { type: 'stdio', command: 'echo', args: ['hi'] },
        },
      }),
    )

    // Act
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath,
      expandVars: false,
      scope: 'project',
    })

    // Assert
    expect(errors).toEqual([])
    expect(Object.keys(config?.mcpServers ?? {})).toEqual(['my-server'])
  })
})
