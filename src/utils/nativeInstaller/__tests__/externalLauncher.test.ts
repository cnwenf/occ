import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isExternallyManagedLauncher,
  isNativeManagedLauncher,
  isNpmManagedLauncher,
} from '../launcherOwnership.js'

/**
 * 2.1.207 #5: the auto-updater must NOT overwrite an externally-managed
 * launcher at `~/.local/bin/claude`. The discriminator (mirroring the binary's
 * `Ear` / `Aar`) decides what the installer owns vs. what it must leave alone.
 *
 * These tests exercise the REAL filesystem logic (creating real symlinks and
 * script files in a temp dir), not source-grep — they verify the actual
 * ownership decision that gates the overwrite-refusal and doctor warning.
 */
describe('2.1.207 #5 launcher ownership discriminator', () => {
  let tmpRoot: string
  let versionsDir: string
  let binDir: string

  beforeEach(async () => {
    tmpRoot = join(
      tmpdir(),
      `occ-launcher-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    )
    binDir = join(tmpRoot, '.local', 'bin')
    versionsDir = join(tmpRoot, 'share', 'claude', 'versions')
    await mkdir(binDir, { recursive: true })
    await mkdir(versionsDir, { recursive: true })
    // A fake version binary the installer would have downloaded.
    await writeFile(join(versionsDir, '2.1.210'), 'fake-binary')
  })

  afterEach(async () => {
    try {
      const { rm } = await import('fs/promises')
      await rm(tmpRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('isNativeManagedLauncher (binary Ear)', () => {
    test('returns true for a symlink whose target includes claude/versions/', async () => {
      const launcher = join(binDir, 'claude')
      await symlink(join(versionsDir, '2.1.210'), launcher)
      expect(await isNativeManagedLauncher(launcher)).toBe(true)
    })

    test('returns false for a regular file (custom wrapper script)', async () => {
      const launcher = join(binDir, 'claude')
      await writeFile(launcher, '#!/bin/bash\nexec somewhere-else\n')
      expect(await isNativeManagedLauncher(launcher)).toBe(false)
    })

    test('returns false for a symlink that does NOT point into versions/', async () => {
      const otherTarget = join(tmpRoot, 'custom-claude')
      await writeFile(otherTarget, 'custom')
      const launcher = join(binDir, 'claude')
      await symlink(otherTarget, launcher)
      expect(await isNativeManagedLauncher(launcher)).toBe(false)
    })

    test('returns true for a missing launcher (ENOENT — installer creates it)', async () => {
      const launcher = join(binDir, 'claude-missing')
      expect(await isNativeManagedLauncher(launcher)).toBe(true)
    })
  })

  describe('isNpmManagedLauncher (binary Aar)', () => {
    test('returns true for a realpath ending with .js', async () => {
      const shim = join(binDir, 'claude.js')
      await writeFile(shim, 'require("...")')
      expect(await isNpmManagedLauncher(shim)).toBe(true)
    })

    test('returns true for a realpath including node_modules', async () => {
      const nmDir = join(tmpRoot, 'node_modules', '@anthropic-ai', 'claude-code')
      await mkdir(nmDir, { recursive: true })
      const shim = join(nmDir, 'cli.js')
      await writeFile(shim, 'module.exports = {}')
      expect(await isNpmManagedLauncher(shim)).toBe(true)
    })

    test('returns false for a regular native binary', async () => {
      const binary = join(versionsDir, '2.1.210')
      expect(await isNpmManagedLauncher(binary)).toBe(false)
    })
  })

  describe('isExternallyManagedLauncher (the overwrite-refuse gate)', () => {
    test('returns true for a custom wrapper script (must NOT be overwritten)', async () => {
      const launcher = join(binDir, 'claude')
      await writeFile(launcher, '#!/bin/bash\nexec my-wrapper "$@"\n')
      expect(await isExternallyManagedLauncher(launcher)).toBe(true)
    })

    test('returns true for a custom symlink outside versions/ and node_modules', async () => {
      const customTarget = join(tmpRoot, 'my-launcher')
      await writeFile(customTarget, 'custom')
      const launcher = join(binDir, 'claude')
      await symlink(customTarget, launcher)
      expect(await isExternallyManagedLauncher(launcher)).toBe(true)
    })

    test('returns false for a native-managed symlink (installer owns it)', async () => {
      const launcher = join(binDir, 'claude')
      await symlink(join(versionsDir, '2.1.210'), launcher)
      expect(await isExternallyManagedLauncher(launcher)).toBe(false)
    })

    test('returns false for an npm shim (installer owns it)', async () => {
      const shim = join(binDir, 'claude.js')
      await writeFile(shim, 'require("...")')
      expect(await isExternallyManagedLauncher(shim)).toBe(false)
    })

    test('returns false for a missing launcher (installer creates it)', async () => {
      const launcher = join(binDir, 'claude-missing')
      expect(await isExternallyManagedLauncher(launcher)).toBe(false)
    })
  })
})
