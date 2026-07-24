import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CLI_BINARY_NAME } from '../cli.js'

describe('CLI binary name', () => {
  test('matches the sole package.json bin entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'),
    ) as { bin: Record<string, string> }

    expect(Object.keys(pkg.bin)).toEqual([CLI_BINARY_NAME])
  })

  test('is the command OCC exposes to users', () => {
    expect(`${CLI_BINARY_NAME} --resume session-id`).toBe(
      'occ --resume session-id',
    )
  })
})
