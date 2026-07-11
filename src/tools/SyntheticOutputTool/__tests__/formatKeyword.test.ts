import { describe, expect, test } from 'bun:test'
import { createSyntheticOutputTool } from '../SyntheticOutputTool.js'

describe('createSyntheticOutputTool — format keyword (2.1.205 #2)', () => {
  test('rejects an invalid email when format:"email" is specified', async () => {
    const schema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    await expect(result.tool.call({ email: 'not-an-email' })).rejects.toThrow(
      /schema/i,
    )
  })

  test('accepts a valid email when format:"email" is specified', async () => {
    const schema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    const out = await result.tool.call({ email: 'a@example.com' })
    expect(out.structured_output).toEqual({ email: 'a@example.com' })
  })

  test('rejects an invalid date-time when format:"date-time" is specified', async () => {
    const schema = {
      type: 'object',
      properties: { ts: { type: 'string', format: 'date-time' } },
      required: ['ts'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    await expect(result.tool.call({ ts: 'yesterday' })).rejects.toThrow(
      /schema/i,
    )
  })

  test('accepts a valid date-time when format:"date-time" is specified', async () => {
    const schema = {
      type: 'object',
      properties: { ts: { type: 'string', format: 'date-time' } },
      required: ['ts'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    const out = await result.tool.call({ ts: '2025-07-11T12:00:00Z' })
    expect(out.structured_output).toEqual({ ts: '2025-07-11T12:00:00Z' })
  })

  test('rejects an invalid uri when format:"uri" is specified', async () => {
    const schema = {
      type: 'object',
      properties: { link: { type: 'string', format: 'uri' } },
      required: ['link'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    await expect(result.tool.call({ link: 'ht tp://bad' })).rejects.toThrow(
      /schema/i,
    )
  })

  test('rejects an explicitly invalid JSON schema', () => {
    // `properties` must be an object; a string is a meta-schema violation.
    const badSchema = { type: 'object', properties: 'not-an-object' }
    const result = createSyntheticOutputTool(badSchema as unknown as Record<string, unknown>)
    expect('error' in result).toBe(true)
  })

  test('still validates plain schemas without format keyword (no regression)', async () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'],
    }
    const result = createSyntheticOutputTool(schema)
    expect('tool' in result).toBe(true)
    if (!('tool' in result)) throw new Error('expected tool')
    await expect(result.tool.call({ count: -1 })).rejects.toThrow(/schema/i)
    const ok = await result.tool.call({ count: 3 })
    expect(ok.structured_output).toEqual({ count: 3 })
  })

  test('caches by schema object identity', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
    }
    const a = createSyntheticOutputTool(schema)
    const b = createSyntheticOutputTool(schema)
    expect(a).toBe(b)
  })
})
