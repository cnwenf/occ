import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveDirectoryTarget } from '../cdLogic.js'

describe('resolveDirectoryTarget (2.1.206 #1)', () => {
  let tmpRoot: string
  let realDir: string
  let aFile: string
  const originalCwd = process.cwd()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cd-logic-'))
    realDir = mkdtempSync(join(tmpRoot, 'realdir-'))
    aFile = join(tmpRoot, 'a-file.txt')
    writeFileSync(aFile, 'hi')
    process.chdir(tmpRoot)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('resolves an existing directory to its realpath', () => {
    const result = resolveDirectoryTarget(realDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.physical).toBe(realDir)
    }
  })

  test('resolves a relative directory path against process.cwd()', () => {
    // tmpRoot is the cwd; realDir's basename is a relative dir under it.
    const rel = realDir.split('/').pop()!
    const result = resolveDirectoryTarget(rel)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.physical).toBe(realDir)
    }
  })

  test('returns a clear error for a nonexistent path', () => {
    const result = resolveDirectoryTarget(join(tmpRoot, 'nope'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/does not exist/)
    }
  })

  test('returns a clear error when the path is a file, not a directory', () => {
    const result = resolveDirectoryTarget(aFile)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Not a directory/)
    }
  })

  test('error message includes the resolved absolute path', () => {
    const result = resolveDirectoryTarget('./nope')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // ./nope resolves under tmpRoot (the cwd)
      expect(result.error).toContain(join(tmpRoot, 'nope'))
    }
  })
})
