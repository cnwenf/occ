import { afterEach, describe, expect, test } from 'bun:test'
import {
  getCliName,
  getCliNameCached,
  OCC_BIN_NAME,
} from '../../src/utils/cliName.js'

describe('getCliName (OCC-27)', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  test('returns the bin name when invoked via the occ symlink', () => {
    process.argv = ['/usr/local/bin/node', '/usr/local/bin/occ']
    expect(getCliName()).toBe('occ')
  })

  test('strips .cjs extension from the occ bin', () => {
    process.argv = ['/usr/local/bin/node', '/opt/occ/bin/occ.cjs']
    expect(getCliName()).toBe('occ')
  })

  test('strips .mjs extension from the occ bin', () => {
    process.argv = ['/usr/local/bin/node', '/opt/occ/bin/occ.mjs']
    expect(getCliName()).toBe('occ')
  })

  test('falls back to OCC_BIN_NAME for the bundled dist/cli.js entry', () => {
    process.argv = ['/usr/local/bin/bun', '/app/dist/cli.js']
    expect(getCliName()).toBe(OCC_BIN_NAME)
    expect(getCliName()).toBe('occ')
  })

  test('falls back to OCC_BIN_NAME for the dev .tsx entry', () => {
    process.argv = ['/usr/local/bin/bun', '/repo/src/entrypoints/cli.tsx']
    expect(getCliName()).toBe(OCC_BIN_NAME)
  })

  test('falls back to OCC_BIN_NAME when argv[1] is unset', () => {
    process.argv = ['/usr/local/bin/node']
    expect(getCliName()).toBe(OCC_BIN_NAME)
  })

  test('never returns the upstream claude name, even from a claude path', () => {
    // OCC is a Claude Code fork; the upstream name must not leak into
    // user-facing copy regardless of the invocation path.
    process.argv = ['/usr/local/bin/node', '/anywhere/claude']
    expect(getCliName()).toBe('occ')
    process.argv = ['/usr/local/bin/node', '/anywhere/claude.cjs']
    expect(getCliName()).toBe('occ')
  })

  test('getCliNameCached memoizes the derived value', () => {
    process.argv = ['/usr/local/bin/node', '/usr/local/bin/occ']
    const first = getCliNameCached()
    process.argv = ['/usr/local/bin/node', '/somewhere/else']
    const second = getCliNameCached()
    expect(first).toBe('occ')
    expect(second).toBe(first) // cached — argv change is ignored after first read
  })
})
