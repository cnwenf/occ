import { describe, expect, test } from 'bun:test'
import type { McpServerConfig } from '../types.js'
import {
  getInvalidMcpServerNameReason,
  partitionMcpServersByName,
} from '../normalization.js'

describe('getInvalidMcpServerNameReason', () => {
  test('returns undefined for valid names', () => {
    expect(getInvalidMcpServerNameReason('valid-name')).toBeUndefined()
    expect(getInvalidMcpServerNameReason('my_server')).toBeUndefined()
    expect(getInvalidMcpServerNameReason('Server123')).toBeUndefined()
    expect(getInvalidMcpServerNameReason('a')).toBeUndefined()
    expect(getInvalidMcpServerNameReason('a-b_c-1')).toBeUndefined()
  })

  test('returns a reason for names with invalid characters', () => {
    expect(getInvalidMcpServerNameReason('my server')).toMatch(/can only contain/)
    expect(getInvalidMcpServerNameReason('foo.bar')).toMatch(/can only contain/)
    expect(getInvalidMcpServerNameReason('café')).toMatch(/can only contain/)
    expect(getInvalidMcpServerNameReason('name/with/slash')).toMatch(/can only contain/)
    expect(getInvalidMcpServerNameReason('with space')).toMatch(/can only contain/)
  })

  test('returns a reason for empty names', () => {
    expect(getInvalidMcpServerNameReason('')).toBe('name is empty')
  })

  test('returns a reason for names longer than 64 characters', () => {
    const longName = 'a'.repeat(65)
    expect(getInvalidMcpServerNameReason(longName)).toBe(
      'name is longer than 64 characters',
    )
  })

  test('accepts a 64-character name (boundary)', () => {
    expect(getInvalidMcpServerNameReason('a'.repeat(64))).toBeUndefined()
  })

  test('treats hyphens and underscores as valid', () => {
    expect(getInvalidMcpServerNameReason('-_-_-_')).toBeUndefined()
  })
})

describe('partitionMcpServersByName', () => {
  const stdioConfig = { type: 'stdio', command: 'node' } as unknown as McpServerConfig

  test('returns all servers as valid when names are valid', () => {
    const servers = {
      'valid-one': stdioConfig,
      'valid_two': stdioConfig,
    }
    const { valid, invalid } = partitionMcpServersByName(servers)
    expect(Object.keys(valid)).toHaveLength(2)
    expect(valid['valid-one']).toBe(stdioConfig)
    expect(valid['valid_two']).toBe(stdioConfig)
    expect(invalid).toEqual([])
  })

  test('separates invalid-named servers from valid ones', () => {
    const servers = {
      'good-name': stdioConfig,
      'bad name': stdioConfig,
      'also.good': stdioConfig,
    }
    const { valid, invalid } = partitionMcpServersByName(servers)
    expect(Object.keys(valid)).toEqual(['good-name'])
    expect(valid['good-name']).toBe(stdioConfig)
    expect(invalid).toHaveLength(2)
    const names = invalid.map(i => i.name)
    expect(names).toContain('bad name')
    expect(names).toContain('also.good')
    for (const entry of invalid) {
      expect(typeof entry.reason).toBe('string')
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  test('returns all as invalid when every name is invalid', () => {
    const servers = {
      'with space': stdioConfig,
      'dot.name': stdioConfig,
    }
    const { valid, invalid } = partitionMcpServersByName(servers)
    expect(valid).toEqual({})
    expect(invalid).toHaveLength(2)
  })

  test('returns empty result for empty input', () => {
    const { valid, invalid } = partitionMcpServersByName({})
    expect(valid).toEqual({})
    expect(invalid).toEqual([])
  })

  test('preserves the config object reference for valid servers', () => {
    const servers = { 'keep-me': stdioConfig }
    const { valid } = partitionMcpServersByName(servers)
    expect(valid['keep-me']).toBe(stdioConfig)
  })

  test('reports length reason for over-64-char names', () => {
    const servers = { [`${'a'.repeat(65)}`]: stdioConfig }
    const { invalid } = partitionMcpServersByName(servers)
    expect(invalid).toHaveLength(1)
    expect(invalid[0].reason).toBe('name is longer than 64 characters')
  })
})
