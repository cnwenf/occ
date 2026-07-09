import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAdditionalWorkingDirectories,
  getOriginalCwd,
  setAdditionalWorkingDirectories,
} from '../../../bootstrap/state.js'
import { getMcpRoots } from '../roots.js'

describe('getMcpRoots (MCP roots/list)', () => {
  afterEach(() => {
    // Reset the bootstrap singleton so tests don't leak state.
    setAdditionalWorkingDirectories([])
  })

  test('returns only the cwd when there are no additional working directories', () => {
    setAdditionalWorkingDirectories([])
    const roots = getMcpRoots()
    expect(roots).toEqual([{ uri: `file://${getOriginalCwd()}` }])
  })

  test('includes cwd plus each additional working directory as a file:// URI', () => {
    const added = ['/tmp/added-a', '/tmp/added-b']
    setAdditionalWorkingDirectories(added)

    const roots = getMcpRoots()

    // cwd is always first
    expect(roots[0]).toEqual({ uri: `file://${getOriginalCwd()}` })
    // every add-dir is present as a file:// URI
    expect(roots).toContainEqual({ uri: 'file:///tmp/added-a' })
    expect(roots).toContainEqual({ uri: 'file:///tmp/added-b' })
    expect(roots).toHaveLength(1 + added.length)
  })

  test('reflects removals from the singleton', () => {
    setAdditionalWorkingDirectories(['/tmp/keep', '/tmp/drop'])
    expect(getMcpRoots()).toHaveLength(3)

    setAdditionalWorkingDirectories(['/tmp/keep'])
    const roots = getMcpRoots()
    expect(roots).toContainEqual({ uri: 'file:///tmp/keep' })
    expect(roots).not.toContainEqual({ uri: 'file:///tmp/drop' })
    expect(roots).toHaveLength(2)
  })

  test('getAdditionalWorkingDirectories mirrors the singleton value', () => {
    setAdditionalWorkingDirectories(['/tmp/mirror'])
    expect(getAdditionalWorkingDirectories()).toEqual(['/tmp/mirror'])
  })
})
