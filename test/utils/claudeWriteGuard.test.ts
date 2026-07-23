import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setProjectRoot } from '../../src/bootstrap/state.js'
import {
  assertWriteInsideProject,
  ClaudeWriteOutsideProjectError,
} from '../../src/utils/claudeWriteGuard.js'
import { writeCronTasks } from '../../src/utils/cronTasks.js'

// CC 2.1.216 #18: workflow saves and scheduled-task writes following a
// symlink at `.claude` could redirect writes outside the project. The
// guard refuses (does not silently follow) when the resolved target is
// outside the project root; a within-project `.claude` symlink is allowed.
// These tests build a real on-disk project tree with live symlinks so the
// realpath containment check is exercised end-to-end.

let projectDir: string
let outsideDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cw-guard-proj-'))
  outsideDir = mkdtempSync(join(tmpdir(), 'cw-guard-out-'))
  setProjectRoot(projectDir)
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

describe('assertWriteInsideProject — CC 2.1.216 #18 .claude symlink guard', () => {
  test('(a) .claude symlink pointing OUTSIDE the project → refused', () => {
    // .claude -> /tmp/cw-guard-out-XXXX (outside the project)
    symlinkSync(outsideDir, join(projectDir, '.claude'))
    const target = join(projectDir, '.claude', 'scheduled_tasks.json')
    expect(() => assertWriteInsideProject(target, projectDir)).toThrow(
      ClaudeWriteOutsideProjectError,
    )
  })

  test('(b) normal .claude (no symlink) → allowed', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    const target = join(projectDir, '.claude', 'scheduled_tasks.json')
    expect(() => assertWriteInsideProject(target, projectDir)).not.toThrow()
  })

  test('(c) .claude symlink pointing WITHIN the project → allowed', () => {
    const realClaude = join(projectDir, '.claude_real')
    mkdirSync(realClaude, { recursive: true })
    // .claude -> .claude_real (relative target resolves inside the project)
    symlinkSync(realClaude, join(projectDir, '.claude'))
    const target = join(projectDir, '.claude', 'scheduled_tasks.json')
    expect(() => assertWriteInsideProject(target, projectDir)).not.toThrow()
  })

  test('refusal message names the outside-resolved path', () => {
    symlinkSync(outsideDir, join(projectDir, '.claude'))
    const target = join(projectDir, '.claude', 'scheduled_tasks.json')
    let err: unknown
    try {
      assertWriteInsideProject(target, projectDir)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ClaudeWriteOutsideProjectError)
    expect((err as ClaudeWriteOutsideProjectError).message).toContain(
      'outside the project directory',
    )
    expect((err as ClaudeWriteOutsideProjectError).resolved).toContain(
      outsideDir,
    )
  })
})

describe('writeCronTasks — CC 2.1.216 #18 integration', () => {
  test('(a) .claude symlink OUTSIDE → write refused, nothing leaked', async () => {
    symlinkSync(outsideDir, join(projectDir, '.claude'))
    await expect(
      writeCronTasks([], projectDir),
    ).rejects.toThrow(ClaudeWriteOutsideProjectError)
    // The outside dir must NOT receive a scheduled_tasks.json.
    expect(
      existsSync(join(outsideDir, 'scheduled_tasks.json')),
    ).toBe(false)
  })

  test('(b) normal .claude → writes fine', async () => {
    await writeCronTasks([], projectDir)
    const file = join(projectDir, '.claude', 'scheduled_tasks.json')
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.tasks).toEqual([])
  })

  test('(c) .claude symlink WITHIN project → writes to the real target', async () => {
    mkdirSync(join(projectDir, '.claude_real'), { recursive: true })
    symlinkSync(
      join(projectDir, '.claude_real'),
      join(projectDir, '.claude'),
    )
    await writeCronTasks([], projectDir)
    // The write followed the within-project symlink to the real dir.
    expect(
      existsSync(join(projectDir, '.claude_real', 'scheduled_tasks.json')),
    ).toBe(true)
  })
})
