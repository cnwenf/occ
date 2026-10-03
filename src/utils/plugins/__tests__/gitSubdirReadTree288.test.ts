import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 2.1.288 upstream port (gap-research-288 cluster-B Item 24): git-subdir
 * installs failed — or cached an incomplete plugin — on git < 2.39 because
 * `sparse-checkout set --cone` alone does not reliably materialise the cone on
 * those versions. Official v288 (@210993448 / @210994570) adds an explicit
 * tree materialisation right after the cone is set:
 *
 *   xe=[...ye,"read-tree","-u","--reset"]
 *   …sparse-checkout set --cone -- <path> …
 *   if(Ye.code!==0) throw at(Error(`git read-tree after sparse-checkout failed: ${S6(Ye.stderr,w)}`),
 *      "plugin git-subdir read-tree (post sparse-checkout) failed (stderr redacted)");
 *
 * These tests pin the ported sequence in installFromGitSubdir:
 *   1. `git read-tree -u --reset` runs in the clone dir after sparse-checkout
 *      (on both the no-sha and the sha branch).
 *   2. read-tree failure → install throws (official error string, stderr
 *      credential-scrubbed) and nothing is cached at the target path.
 *   3. read-tree "succeeds" but leaves the subdir empty → install fails
 *      instead of caching an incomplete plugin (OCC-side guard from the port
 *      instruction; the official recovery stops at the read-tree check).
 *   4. happy path: subdir contents land at the target and the resolved sha is
 *      returned.
 *
 * The exec boundary is mocked with the repo's `mock.module` + real-delegation
 * convention (see partialCloneTransport287.test.ts) so no git process runs;
 * the mock simulates what each git step would leave on disk.
 */

// Redirect the config/plugins directory into a throwaway temp dir BEFORE the
// module graph is loaded (getClaudeConfigHomeDir memoizes off CLAUDE_CONFIG_DIR).
const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = await makeTempDir('occ-rt288-config-')

const realExecModule = await import('../../execFileNoThrow.js')
const realExecFileNoThrow = realExecModule.execFileNoThrow
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]
let execMockActive = false

interface ExecCall {
  file: string
  args: string[]
  opts?: Record<string, unknown>
}
const execCalls: ExecCall[] = []

/** Per-test programmable responses for the simulated git steps. */
let sparseCheckoutResult: { code: number; stderr: string }
let readTreeResult: { code: number; stderr: string }
/** What the mocked `read-tree` materialises inside the clone dir. */
let readTreeEffect: 'populate' | 'empty-subdir' | 'nothing'
let subdirForEffect: string
let cloneDirForEffect: string

const OK = { stdout: '', stderr: '', code: 0 }

async function handleExec(
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  execCalls.push({ file, args, opts })
  const sub = args[0]
  if (sub === 'clone') {
    // `clone --no-checkout` creates the repo dir with .git but no worktree.
    const cloneDir = args[args.length - 1]
    cloneDirForEffect = cloneDir
    await mkdir(join(cloneDir, '.git'), { recursive: true })
    return OK
  }
  if (sub === 'sparse-checkout') {
    subdirForEffect = args[args.length - 1]
    return { stdout: '', stderr: sparseCheckoutResult.stderr, code: sparseCheckoutResult.code }
  }
  if (sub === 'read-tree') {
    if (readTreeResult.code === 0 && readTreeEffect === 'populate') {
      const dir = join(cloneDirForEffect, subdirForEffect)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'plugin.md'), 'real plugin content\n')
    } else if (readTreeResult.code === 0 && readTreeEffect === 'empty-subdir') {
      await mkdir(join(cloneDirForEffect, subdirForEffect), { recursive: true })
    }
    return { stdout: '', stderr: readTreeResult.stderr, code: readTreeResult.code }
  }
  if (sub === 'rev-parse') {
    return { stdout: 'a'.repeat(40), stderr: '', code: 0 }
  }
  if (sub === 'checkout' || sub === 'fetch') {
    return OK
  }
  return OK
}

mock.module('../../execFileNoThrow.js', () => ({
  ...realExecModule,
  execFileNoThrow: async (
    file: string,
    args: string[],
    opts?: ExecOpts,
  ) => {
    if (!execMockActive) {
      return realExecFileNoThrow(file, args, opts as ExecOpts)
    }
    return handleExec(file, args, opts as Record<string, unknown>)
  },
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts?: ExecOpts,
  ) => {
    if (!execMockActive) {
      return realExecFileNoThrowWithCwd(file, args, opts)
    }
    return handleExec(file, args, opts as Record<string, unknown>)
  },
}))

const { installFromGitSubdir } = await import('../pluginLoader.js')

afterAll(() => {
  execMockActive = false
  mock.restore()
  mock.module('../../execFileNoThrow.js', () => realExecModule)
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  void Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  execMockActive = true
  execCalls.length = 0
  sparseCheckoutResult = { code: 0, stderr: '' }
  readTreeResult = { code: 0, stderr: '' }
  readTreeEffect = 'populate'
  subdirForEffect = ''
  cloneDirForEffect = ''
})

function callIndex(pred: (call: ExecCall) => boolean): number {
  return execCalls.findIndex(pred)
}

const isSparse = (c: ExecCall): boolean => c.args[0] === 'sparse-checkout'
const isReadTree = (c: ExecCall): boolean => c.args[0] === 'read-tree'

describe('git-subdir read-tree after sparse-checkout (v288 Item 24)', () => {
  test('runs `git read-tree -u --reset` in the clone dir after sparse-checkout set --cone', async () => {
    // Arrange
    const targetPath = join(await makeTempDir('occ-rt288-ok-'), 'plugin')

    // Act
    const sha = await installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    const sparseIdx = callIndex(isSparse)
    const readTreeIdx = callIndex(isReadTree)
    expect(sparseIdx).toBeGreaterThanOrEqual(0)
    expect(readTreeIdx).toBe(sparseIdx + 1)
    const readTreeCall = execCalls[readTreeIdx]!
    expect(readTreeCall.args).toEqual(['read-tree', '-u', '--reset'])
    expect(readTreeCall.opts?.cwd).toBe(`${targetPath}.clone`)
    // Subdir materialised at the target, resolved sha returned, clone dir gone.
    expect(sha).toBe('a'.repeat(40))
    expect(await readFile(join(targetPath, 'plugin.md'), 'utf-8')).toBe(
      'real plugin content\n',
    )
    expect(existsSync(`${targetPath}.clone`)).toBe(false)
  })

  test('read-tree also runs before the checkout on the explicit-sha branch', async () => {
    // Arrange
    const targetPath = join(await makeTempDir('occ-rt288-sha-'), 'plugin')
    const sha = 'b'.repeat(40)

    // Act
    const resolved = await installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
      undefined,
      sha,
    )

    // Assert
    const readTreeIdx = callIndex(isReadTree)
    const checkoutIdx = callIndex(c => c.args[0] === 'checkout')
    expect(readTreeIdx).toBeGreaterThan(callIndex(isSparse))
    expect(checkoutIdx).toBeGreaterThan(readTreeIdx)
    expect(resolved).toBe(sha)
  })

  test('read-tree failure throws the official error and caches nothing', async () => {
    // Arrange
    readTreeResult = { code: 128, stderr: 'fatal: failed to read tree' }
    const targetPath = join(await makeTempDir('occ-rt288-fail-'), 'plugin')

    // Act
    const promise = installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    await expect(promise).rejects.toThrow(
      'git read-tree after sparse-checkout failed: fatal: failed to read tree',
    )
    expect(existsSync(targetPath)).toBe(false)
    // No checkout runs after the failed read-tree, and the clone dir is cleaned.
    const readTreeIdx = callIndex(isReadTree)
    expect(
      execCalls.slice(readTreeIdx + 1).some(c => c.args[0] === 'checkout'),
    ).toBe(false)
    expect(existsSync(`${targetPath}.clone`)).toBe(false)
  })

  test('read-tree failure scrubs credentials embedded in stderr', async () => {
    // Arrange
    readTreeResult = {
      code: 128,
      stderr:
        'fatal: unable to access https://user:hunter2@example.com/repo.git/: tree fetch failed',
    }
    const targetPath = join(await makeTempDir('occ-rt288-redact-'), 'plugin')

    // Act
    const promise = installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    let message = ''
    await promise.catch((e: unknown) => {
      message = (e as Error).message
    })
    expect(message).toContain('git read-tree after sparse-checkout failed:')
    expect(message).not.toContain('hunter2')
  })

  test('empty subdir after read-tree fails instead of caching an incomplete plugin', async () => {
    // Arrange
    readTreeEffect = 'empty-subdir'
    const targetPath = join(await makeTempDir('occ-rt288-empty-'), 'plugin')

    // Act
    const promise = installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    await expect(promise).rejects.toThrow(/empty/i)
    expect(existsSync(targetPath)).toBe(false)
    expect(existsSync(`${targetPath}.clone`)).toBe(false)
  })

  test('missing subdir after read-tree keeps the friendly not-found error', async () => {
    // Arrange
    readTreeEffect = 'nothing'
    const targetPath = join(await makeTempDir('occ-rt288-missing-'), 'plugin')

    // Act
    const promise = installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    await expect(promise).rejects.toThrow(
      "Subdirectory 'tools/plugin' not found in repository https://example.com/repo.git",
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  test('sparse-checkout failure still short-circuits before read-tree (unchanged error)', async () => {
    // Arrange
    sparseCheckoutResult = { code: 1, stderr: 'fatal: not a git repository' }
    const targetPath = join(await makeTempDir('occ-rt288-sparse-'), 'plugin')

    // Act
    const promise = installFromGitSubdir(
      'https://example.com/repo.git',
      targetPath,
      'tools/plugin',
    )

    // Assert
    await expect(promise).rejects.toThrow('git sparse-checkout set failed')
    expect(callIndex(isReadTree)).toBe(-1)
  })
})
