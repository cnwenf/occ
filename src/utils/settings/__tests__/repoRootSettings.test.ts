/**
 * TDD tests for CC 2.1.211: "Changed 'always allow' permission rules to
 * save at the repository root, so approvals granted in a git worktree
 * persist across sessions and worktrees."
 *
 * Tests call the REAL getSettingsRootPathForSource function (the storage
 * code path) — no mocking of the function under test. Only the filesystem
 * (git repo + worktree fixtures) is a leaf collaborator.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import {
  getSettingsRootPathForSource,
  getSettingsFilePathForSource,
} from 'src/utils/settings/settings.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import {
  getOriginalCwd,
  setOriginalCwd,
  getCwdState,
  setCwdState,
} from 'src/bootstrap/state.js'

// ---------------------------------------------------------------------------
// Helpers — create real git repo + worktree fixtures on disk
// ---------------------------------------------------------------------------

let mainRepoDir: string
let worktreeDir: string
let prevCwd: string
let prevOriginalCwd: string

function setupGitRepoWithWorktree(): void {
  const tmpBase = mkdtempSync(join(tmpdir(), 'occ-reporoot-'))

  // Main repo
  mainRepoDir = join(tmpBase, 'main-repo')
  mkdirSync(mainRepoDir, { recursive: true })
  execSync('git init', { cwd: mainRepoDir })
  execSync('git config user.email test@test.com', { cwd: mainRepoDir })
  execSync('git config user.name TestUser', { cwd: mainRepoDir })

  // Create an initial commit so the main branch exists
  writeFileSync(join(mainRepoDir, 'README.md'), '# test\n')
  execSync('git add -A', { cwd: mainRepoDir })
  execSync('git commit -m "initial"', { cwd: mainRepoDir })

  // Create a worktree
  worktreeDir = join(tmpBase, 'worktree')
  execSync(`git worktree add ${worktreeDir}`, { cwd: mainRepoDir })

  // Save and set CWD to the worktree
  prevCwd = getCwdState()
  prevOriginalCwd = getOriginalCwd()
  setCwdState(worktreeDir)
  setOriginalCwd(worktreeDir)
  resetSettingsCache()
}

function teardownGitRepo(): void {
  setCwdState(prevCwd)
  setOriginalCwd(prevOriginalCwd)
  resetSettingsCache()

  const tmpBase = dirname(mainRepoDir)
  try {
    rmSync(tmpBase, { recursive: true, force: true })
  } catch {
    // Best effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Tests — REAL getSettingsRootPathForSource storage code path
// ---------------------------------------------------------------------------

describe('getSettingsRootPathForSource resolves to canonical repo root (CC 2.1.211)', () => {
  beforeEach(() => {
    setupGitRepoWithWorktree()
  })

  afterEach(() => {
    teardownGitRepo()
  })

  test('projectSettings resolves to main repo root, not worktree dir', () => {
    // Act: call the REAL function under test
    const rootPath = getSettingsRootPathForSource('projectSettings')

    // Assert: resolves to mainRepoDir, not worktreeDir
    expect(rootPath).toBe(mainRepoDir)
    expect(rootPath).not.toBe(worktreeDir)
  })

  test('localSettings resolves to main repo root, not worktree dir', () => {
    // Act: call the REAL function under test
    const rootPath = getSettingsRootPathForSource('localSettings')

    // Assert: resolves to mainRepoDir, not worktreeDir
    expect(rootPath).toBe(mainRepoDir)
    expect(rootPath).not.toBe(worktreeDir)
  })

  test('settings file path for projectSettings points to repo root .claude/settings.json', () => {
    // Act
    const filePath = getSettingsFilePathForSource('projectSettings')

    // Assert
    expect(filePath).toBe(join(mainRepoDir, '.claude', 'settings.json'))
    expect(filePath).not.toBe(join(worktreeDir, '.claude', 'settings.json'))
  })

  test('settings file path for localSettings points to repo root .claude/settings.local.json', () => {
    // Act
    const filePath = getSettingsFilePathForSource('localSettings')

    // Assert
    expect(filePath).toBe(join(mainRepoDir, '.claude', 'settings.local.json'))
    expect(filePath).not.toBe(join(worktreeDir, '.claude', 'settings.local.json'))
  })
})
