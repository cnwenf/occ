import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  getConditionalRulesForCwdLevelDirectory,
  getMemoryFilesForNestedDirectory,
} from '../claudemd.js'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import type { SettingSource } from '../settings/constants.js'
import { setOriginalCwd } from '../../bootstrap/state.js'

/**
 * CC 2.1.211: "Fixed nested .claude/rules/*.md files loading even when setting
 * sources exclude project settings."
 *
 * The nested-directory rules loaders (getMemoryFilesForNestedDirectory and
 * getConditionalRulesForCwdLevelDirectory) guard CLAUDE.md with
 * isSettingSourceEnabled('projectSettings') but used to load
 * .claude/rules/*.md unconditionally. When project settings are excluded
 * (--setting-sources without projectSettings), nested rules must NOT load.
 *
 * These tests exercise the REAL loader code path against a real filesystem
 * fixture — only the global setting-source state is toggled.
 */

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const NO_PROJECT_SOURCES: SettingSource[] = [
  'userSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

describe('CC 2.1.211 — nested .claude/rules exclusion when projectSettings excluded', () => {
  let tmpDir: string
  let savedSources: SettingSource[]
  let savedCwd: string

  beforeAll(async () => {
    savedSources = getAllowedSettingSources()
    savedCwd = process.cwd()
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-rules-excl-'))
    await mkdir(join(tmpDir, '.claude', 'rules'), { recursive: true })
    await writeFile(
      join(tmpDir, '.claude', 'rules', 'unconditional.md'),
      '# unconditional rule\n',
    )
    await writeFile(
      join(tmpDir, '.claude', 'rules', 'conditional.md'),
      '---\npaths:\n  - "**/*.ts"\n---\n# conditional rule\n',
    )
    // Point originalCwd at the fixture so pathInOriginalCwd resolves correctly.
    setOriginalCwd(tmpDir)
  })

  afterAll(async () => {
    setAllowedSettingSources(savedSources)
    setOriginalCwd(savedCwd)
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('nested unconditional .claude/rules/*.md is NOT loaded when projectSettings excluded', async () => {
    setAllowedSettingSources(NO_PROJECT_SOURCES)
    try {
      const processed = new Set<string>()
      const files = await getMemoryFilesForNestedDirectory(
        tmpDir,
        join(tmpDir, 'some.ts'),
        processed,
      )
      const paths = files.map(f => f.path)
      expect(
        paths.some(p => p.endsWith('unconditional.md')),
        `expected no unconditional.md, got: ${JSON.stringify(paths)}`,
      ).toBe(false)
    } finally {
      setAllowedSettingSources(ALL_SOURCES)
    }
  })

  test('nested conditional .claude/rules/*.md is NOT loaded when projectSettings excluded', async () => {
    setAllowedSettingSources(NO_PROJECT_SOURCES)
    try {
      const processed = new Set<string>()
      const files = await getConditionalRulesForCwdLevelDirectory(
        tmpDir,
        join(tmpDir, 'target.ts'),
        processed,
      )
      const paths = files.map(f => f.path)
      expect(
        paths.some(p => p.endsWith('conditional.md')),
        `expected no conditional.md, got: ${JSON.stringify(paths)}`,
      ).toBe(false)
    } finally {
      setAllowedSettingSources(ALL_SOURCES)
    }
  })

  test('nested .claude/rules/*.md IS loaded when projectSettings included (regression guard)', async () => {
    setAllowedSettingSources(ALL_SOURCES)
    const processed = new Set<string>()
    const files = await getMemoryFilesForNestedDirectory(
      tmpDir,
      join(tmpDir, 'some.ts'),
      processed,
    )
    const paths = files.map(f => f.path)
    expect(
      paths.some(p => p.endsWith('unconditional.md')),
      `expected unconditional.md to load, got: ${JSON.stringify(paths)}`,
    ).toBe(true)
  })

  test('CLAUDE.md is NOT loaded when projectSettings excluded (existing behavior, guard)', async () => {
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# project\n')
    setAllowedSettingSources(NO_PROJECT_SOURCES)
    try {
      const processed = new Set<string>()
      const files = await getMemoryFilesForNestedDirectory(
        tmpDir,
        join(tmpDir, 'some.ts'),
        processed,
      )
      const paths = files.map(f => f.path)
      expect(
        paths.some(p => p.endsWith('CLAUDE.md')),
        `expected no CLAUDE.md, got: ${JSON.stringify(paths)}`,
      ).toBe(false)
    } finally {
      setAllowedSettingSources(ALL_SOURCES)
    }
  })
})
