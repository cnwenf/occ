import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 2.1.287 upstream port (gap-research-287 cluster-B Item 7): partial clone is
 * gated on the git URL transport. Official v287 shapes (byte-verified):
 *
 *   marketplace clone `slr` @206995523:
 *     if(h){if(F4n(e))j.push("--filter=blob:none");j.push("--no-checkout")}
 *     else j.push("--recurse-submodules","--shallow-submodules");
 *   git-subdir clone @207252449:
 *     Se=[...,"clone","--depth","1",...F4n(w)?["--filter=tree:0"]:[],"--no-checkout"];
 *
 * `F4n` is the https/ssh allowlist predicate (official `he=["https","ssh"]`),
 * ported to `src/utils/plugins/gitTransport.ts`. Over plain http the filter is
 * dropped so nothing has to be lazy-fetched later over a transport git may
 * block (`fatal: transport 'http' not allowed`); `--no-checkout` and the rest
 * of the argv stay exactly as before.
 *
 * The exec boundary is mocked with the repo's `mock.module` + real-delegation
 * convention (see marketplaceGitCredentials280.test.ts / installFromNpm275.test.ts)
 * so no git process runs and the clone argv is asserted directly.
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
process.env.CLAUDE_CONFIG_DIR = await makeTempDir('occ-pct287-config-')

const realExecModule = await import('../../execFileNoThrow.js')

interface ExecCall {
  file: string
  args: string[]
  opts?: Record<string, unknown>
}
const execCalls: ExecCall[] = []

// Capture the real function values BEFORE mock.module registration: Bun patches
// live ESM namespaces, so delegating through the namespace inside the factory
// would recurse into the mock itself. `execMockActive` keeps the stub from
// leaking into sibling test files batched after this one.
const realExecFileNoThrow = realExecModule.execFileNoThrow
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]
let execMockActive = false

const record = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
): { stdout: string; stderr: string; code: number } => {
  execCalls.push({ file, args, opts })
  return { stdout: '', stderr: '', code: 0 }
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
    return record(file, args, opts as Record<string, unknown>)
  },
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts?: ExecOpts,
  ) => {
    if (!execMockActive) {
      return realExecFileNoThrowWithCwd(file, args, opts)
    }
    return record(file, args, opts as Record<string, unknown>)
  },
}))

const { gitClone } = await import('../marketplaceManager.js')
const { installFromGitSubdir } = await import('../pluginLoader.js')

afterAll(() => {
  execMockActive = false
  mock.restore()
  // Belt and braces: re-register the real module so sibling test files batched
  // after this one never observe the stub.
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
})

/** The `clone` argv captured for a sparse marketplace clone. */
async function marketplaceCloneArgs(
  gitUrl: string,
  sparsePaths?: string[],
): Promise<string[]> {
  const targetPath = await makeTempDir('occ-pct287-marketplace-')
  const result = await gitClone(gitUrl, targetPath, undefined, sparsePaths)
  expect(result.code).toBe(0)
  const cloneCall = execCalls.find(call => call.args.includes('clone'))
  expect(cloneCall).toBeDefined()
  return cloneCall!.args
}

/**
 * The `clone` argv captured for a git-subdir install. The mocked clone creates
 * nothing on disk, so the subdir move fails afterwards — expected here, and the
 * clone argv (the only thing under test) is already captured.
 */
async function gitSubdirCloneArgs(gitUrl: string): Promise<string[]> {
  const targetPath = join(await makeTempDir('occ-pct287-subdir-'), 'plugin')
  await installFromGitSubdir(gitUrl, targetPath, 'tools/plugin').catch(() => {
    // Expected: nothing was really cloned, so the subdir cannot be moved out.
  })
  const cloneCall = execCalls.find(call => call.args[0] === 'clone')
  expect(cloneCall).toBeDefined()
  return cloneCall!.args
}

describe('marketplace gitClone --filter=blob:none transport gate (v287 slr)', () => {
  test('https sparse clone keeps --filter=blob:none immediately before --no-checkout', async () => {
    const args = await marketplaceCloneArgs('https://example.com/repo.git', [
      'plugins/foo',
    ])
    expect(args).toContain('--filter=blob:none')
    expect(args).toContain('--no-checkout')
    expect(args.indexOf('--filter=blob:none') + 1).toBe(
      args.indexOf('--no-checkout'),
    )
    expect(args.slice(0, 7)).toEqual([
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--no-checkout',
    ])
  })

  test('http sparse clone drops --filter entirely (full clone fallback) but keeps --no-checkout', async () => {
    const args = await marketplaceCloneArgs('http://example.com/repo.git', [
      'plugins/foo',
    ])
    expect(args.some(arg => arg.startsWith('--filter='))).toBe(false)
    expect(args.join(' ')).not.toContain('--filter=')
    expect(args).toContain('--no-checkout')
    // Still shallow, still no submodule recursion in the sparse branch.
    expect(args).toContain('--depth')
    expect(args).not.toContain('--recurse-submodules')
  })

  test('ssh transports (git+ssh:// and scp-like) keep --filter=blob:none', async () => {
    const gitSsh = await marketplaceCloneArgs(
      'git+ssh://example.com/repo.git',
      ['plugins/foo'],
    )
    expect(gitSsh).toContain('--filter=blob:none')

    execCalls.length = 0
    const scpLike = await marketplaceCloneArgs('git@example.com:owner/repo.git', [
      'plugins/foo',
    ])
    expect(scpLike).toContain('--filter=blob:none')
  })

  test('file:// sparse clone drops --filter (transport not in the https/ssh allowlist)', async () => {
    const args = await marketplaceCloneArgs('file:///tmp/repo.git', [
      'plugins/foo',
    ])
    expect(args.some(arg => arg.startsWith('--filter='))).toBe(false)
    expect(args).toContain('--no-checkout')
  })

  test('non-sparse clone is unchanged for both https and http (no filter, no --no-checkout)', async () => {
    for (const gitUrl of [
      'https://example.com/repo.git',
      'http://example.com/repo.git',
    ]) {
      execCalls.length = 0
      const args = await marketplaceCloneArgs(gitUrl)
      expect(args.join(' ')).not.toContain('--filter=')
      expect(args).not.toContain('--no-checkout')
      expect(args).toContain('--recurse-submodules')
      expect(args).toContain('--shallow-submodules')
    }
  })
})

describe('git-subdir installFromGitSubdir --filter=tree:0 transport gate (v287)', () => {
  test('https git-subdir clone keeps --filter=tree:0 between --depth 1 and --no-checkout', async () => {
    const args = await gitSubdirCloneArgs('https://example.com/repo.git')
    expect(args).toContain('--filter=tree:0')
    expect(args).toContain('--no-checkout')
    expect(args.indexOf('--filter=tree:0') + 1).toBe(
      args.indexOf('--no-checkout'),
    )
    expect(args.slice(0, 5)).toEqual([
      'clone',
      '--depth',
      '1',
      '--filter=tree:0',
      '--no-checkout',
    ])
  })

  test('http git-subdir clone drops --filter=tree:0 (full clone fallback), keeps --no-checkout', async () => {
    const args = await gitSubdirCloneArgs('http://example.com/repo.git')
    expect(args.some(arg => arg.startsWith('--filter='))).toBe(false)
    expect(args.join(' ')).not.toContain('--filter=')
    expect(args.slice(0, 4)).toEqual([
      'clone',
      '--depth',
      '1',
      '--no-checkout',
    ])
  })

  test('ssh git-subdir clone (git@host:path) keeps --filter=tree:0', async () => {
    const args = await gitSubdirCloneArgs('git@example.com:owner/repo.git')
    expect(args).toContain('--filter=tree:0')
    expect(args).toContain('--no-checkout')
  })

  test('GitHub owner/repo shorthand keeps --filter=tree:0 (resolves to https or ssh)', async () => {
    // resolveGitSubdirUrl maps the shorthand to https://github.com/… or
    // git@github.com:… (CLAUDE_CODE_REMOTE); both transports are allowlisted.
    const args = await gitSubdirCloneArgs('owner/repo')
    expect(args).toContain('--filter=tree:0')
  })
})
