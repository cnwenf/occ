import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.277 (C5): failed auto-updates previously left the full staged
 * download behind in ~/.cache/claude/staging (only the 1-hour startup sweep
 * removed it). Official v277 adds a finally-block cleanup around the
 * download+install step of the native update.
 *
 * Binary evidence (v277 ELF @0xc1809fd):
 *   `finally{if(y)await he(v,{recursive:!0,force:!0}).catch((L)=>t(
 *    `Could not remove the update staging directory (a later update removes
 *     it after one hour): ${l(L)}`,{level:"warn"}))}`
 */

process.env.NODE_ENV = 'test'
const SANDBOX = mkdtempSync(join(tmpdir(), 'occ-c5-'))
const FAKE_HOME = join(SANDBOX, 'home')
process.env.HOME = FAKE_HOME
process.env.XDG_CACHE_HOME = join(SANDBOX, 'cache')
process.env.XDG_DATA_HOME = join(SANDBOX, 'data')
process.env.XDG_STATE_HOME = join(SANDBOX, 'state')
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.276',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// -- Mock the download layer (leaf collaborator doing network I/O) --

const realDownload = await import('../download.js')
let downloadImpl: (version: string, stagingPath: string) => Promise<'npm' | 'binary'> =
  async () => 'binary'
let downloadCalls: Array<{ version: string; stagingPath: string }> = []
mock.module('../download.js', () => ({
  ...realDownload,
  downloadVersion: async (version: string, stagingPath: string) => {
    downloadCalls.push({ version, stagingPath })
    return downloadImpl(version, stagingPath)
  },
  getLatestVersion: async () => '9.9.9',
}))

const realDebug = await import('../../debug.js')
const debugLogs: Array<{ message: string; level?: string }> = []
mock.module('../../debug.js', () => ({
  ...realDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugLogs.push({ message, level: opts?.level })
  },
}))

const { performVersionUpdate } = await import('../installer.js')

const STAGING_ROOT = join(SANDBOX, 'cache', 'claude', 'staging')
const VERSIONS_ROOT = join(SANDBOX, 'data', 'claude', 'versions')

beforeEach(() => {
  downloadCalls = []
  debugLogs.length = 0
  downloadImpl = async () => 'binary'
})

afterAll(() => {
  delete process.env.HOME
  delete process.env.XDG_CACHE_HOME
  delete process.env.XDG_DATA_HOME
  delete process.env.XDG_STATE_HOME
})

describe('C5: performVersionUpdate staging cleanup', () => {
  test('failed download removes the staged download directory', async () => {
    const version = '9.9.1'
    const stagingPath = join(STAGING_ROOT, version)
    downloadImpl = async (_v, sp) => {
      // Simulate a partial download landing on disk before the failure.
      const { mkdir, writeFile } = await import('fs/promises')
      await mkdir(sp, { recursive: true })
      await writeFile(join(sp, 'partial.tgz'), 'x'.repeat(1024))
      throw new Error('download interrupted')
    }

    await expect(performVersionUpdate(version, false)).rejects.toThrow(
      'download interrupted',
    )
    expect(downloadCalls.length).toBe(1)
    // The staged partial download must not survive the failure.
    expect(existsSync(stagingPath)).toBe(false)
  })

  test('failed install also removes the staged directory', async () => {
    const version = '9.9.2'
    const stagingPath = join(STAGING_ROOT, version)
    downloadImpl = async (_v, sp) => {
      const { mkdir, writeFile } = await import('fs/promises')
      await mkdir(sp, { recursive: true })
      // 'npm' download type routes to installVersionFromPackage, which
      // fails on a staging dir with no node_modules payload.
      await writeFile(join(sp, 'package.tgz'), 'corrupt')
      return 'npm'
    }

    let threw = false
    try {
      await performVersionUpdate(version, false)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(existsSync(stagingPath)).toBe(false)
  })

  test('already-installed version skips download and leaves staging untouched', async () => {
    const version = '9.9.8'
    // Pre-create an installed version binary so versionIsAvailable() is true.
    const { mkdirSync } = await import('fs')
    mkdirSync(VERSIONS_ROOT, { recursive: true })
    const installPath = join(VERSIONS_ROOT, version)
    writeFileSync(installPath, '#!/bin/sh\necho fake\n')
    chmodSync(installPath, 0o755)

    const result = await performVersionUpdate(version, false)

    expect(result).toBe(false) // no new install performed
    expect(downloadCalls.length).toBe(0) // download never attempted
    expect(existsSync(join(STAGING_ROOT, version))).toBe(false)
    // The activation symlink now points at the installed version.
    const executablePath = join(FAKE_HOME, '.local', 'bin', 'claude')
    expect(existsSync(executablePath)).toBe(true)
  })
})
