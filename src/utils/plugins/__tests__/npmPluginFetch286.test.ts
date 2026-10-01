import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.286 changelog (SECURITY) — npm-source validation WIRING.
 *
 * Complements npmPluginFetch275.test.ts (which covers the pack/SRI/unpack
 * pipeline). This file pins the 2.1.286 additions to npmPluginFetch.ts:
 *  - `dY` argv hardening: every npm exec prepends `--git=<workDir>/git-is-disabled`.
 *  - `Crr`/`Trr` exec options: env `npm_config_ignore_scripts:"true"`, `stdin:"ignore"`.
 *  - `bRr` name-check: `resolveNpmPackage` refuses non-registry specs before `npm view`.
 *  - `Z8t` registry-override validation before `npm view` / `npm pack`.
 *  - `oXt`/`HWe`/`Mrr`: `packNpmTarball` refuses git/folder/foreign-http specs before `npm pack`.
 *
 * exec is mocked at the module boundary (mock.module spreading the real module,
 * restored + seams healed in afterAll per OCC-96). Official identifiers in
 * comments reference the v286 binary (~207.63 MB code region).
 */

const realExecModule = await import('../../execFileNoThrow.js')

interface ExecCall {
  file: string
  args: string[]
  opts: Record<string, unknown>
}
const execCalls: ExecCall[] = []
let execHandler:
  | ((call: ExecCall) => Promise<{ stdout: string; stderr: string; code: number }>)
  | null = null

const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]

mock.module('../../execFileNoThrow.js', () => ({
  ...realExecModule,
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    const call = { file, args, opts }
    execCalls.push(call)
    if (execHandler) {
      return execHandler(call)
    }
    return realExecFileNoThrowWithCwd(file, args, opts as ExecOpts)
  },
}))

const {
  NpmPluginFetchError,
  packNpmTarball,
  resolveNpmPackage,
} = await import('../npmPluginFetch.js')
const { buildInvalidPackageNameMessage } = await import('../npmSpecValidation.js')

const tempRoots: string[] = []
async function makeTempDir(prefix = 'occ-npm286-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  execHandler = null
  execCalls.length = 0
  mock.restore()
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  execCalls.length = 0
  execHandler = null
})

/** Dispatch a mock npm result by which subcommand the argv carries. */
function byCommand(handlers: {
  view?: () => { stdout: string; stderr?: string; code?: number }
  pack?: () => { stdout: string; stderr?: string; code?: number }
  configGet?: () => { stdout: string; stderr?: string; code?: number }
}) {
  return async (call: ExecCall) => {
    const has = (...words: string[]) => words.every(w => call.args.includes(w))
    if (has('view')) {
      const r = handlers.view?.() ?? { stdout: '', code: 0 }
      return { stdout: r.stdout, stderr: r.stderr ?? '', code: r.code ?? 0 }
    }
    if (has('pack')) {
      const r = handlers.pack?.() ?? { stdout: '', code: 0 }
      return { stdout: r.stdout, stderr: r.stderr ?? '', code: r.code ?? 0 }
    }
    if (has('config', 'get')) {
      const r = handlers.configGet?.() ?? { stdout: '', code: 0 }
      return { stdout: r.stdout, stderr: r.stderr ?? '', code: r.code ?? 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
}

const gitArgv = (workDir: string) => `--git=${join(workDir, 'git-is-disabled')}`

// --- dY argv hardening + Crr/Trr exec options -------------------------------
describe('npm argv hardening (official dY/Trr/Crr)', () => {
  test('resolveNpmPackage prepends --git and hardens env/stdin on npm view', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({
      view: () => ({
        stdout: JSON.stringify([
          {
            version: '1.0.0',
            name: 'my-plugin',
            'dist.tarball': 'https://registry.npmjs.org/my-plugin/-/my-plugin-1.0.0.tgz',
          },
        ]),
        code: 0,
      }),
    })
    const res = await resolveNpmPackage('my-plugin', undefined, { workDir })
    expect(res.name).toBe('my-plugin')
    expect(res.version).toBe('1.0.0')
    const view = execCalls.find(c => c.args.includes('view'))
    expect(view).toBeDefined()
    expect(view?.args[0]).toBe(gitArgv(workDir))
    expect(view?.opts.stdin).toBe('ignore')
    expect((view?.opts.env as Record<string, string>).npm_config_ignore_scripts).toBe('true')
    expect(view?.opts.cwd).toBe(workDir)
  })

  test('getDefaultRegistryOrigin prepends --git on npm config get', async () => {
    const workDir = await makeTempDir()
    // http registry override forces Z8t to probe the default origin via `vue`.
    execHandler = byCommand({
      configGet: () => ({ stdout: 'https://registry.npmjs.org/\n', code: 0 }),
    })
    await expect(
      resolveNpmPackage('my-plugin', undefined, { workDir, registry: 'http://evil.registry' }),
    ).rejects.toBeInstanceOf(NpmPluginFetchError)
    const cfg = execCalls.find(c => c.args.includes('config'))
    expect(cfg).toBeDefined()
    expect(cfg?.args[0]).toBe(gitArgv(workDir))
    expect(cfg?.args).toContain('--workspaces=false')
    expect(cfg?.opts.stdin).toBe('ignore')
  })
})

// --- bRr: name-check before npm view ----------------------------------------
describe('resolveNpmPackage name-check (official bRr/zy)', () => {
  test('refuses a git spec before any npm invocation', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({ view: () => ({ stdout: '[]', code: 0 }) })
    let caught: unknown
    try {
      await resolveNpmPackage('github:foo/bar', undefined, { workDir })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NpmPluginFetchError)
    const err = caught as InstanceType<typeof NpmPluginFetchError>
    expect(err.reason).toBe('npm package name is not a registry name')
    expect(err.message).toBe(buildInvalidPackageNameMessage('github:foo/bar'))
    // zy check runs before `npm view` — nothing shelled out.
    expect(execCalls.some(c => c.args.includes('view'))).toBe(false)
  })

  test('refuses a folder spec', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({ view: () => ({ stdout: '[]', code: 0 }) })
    await expect(
      resolveNpmPackage('./local-folder', undefined, { workDir }),
    ).rejects.toThrow(/is not a valid npm package name/)
    expect(execCalls.some(c => c.args.includes('view'))).toBe(false)
  })
})

// --- Z8t: registry-override validation --------------------------------------
describe('resolveNpmPackage registry override (official Z8t)', () => {
  test('http registry differing from default is refused before npm view', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({
      configGet: () => ({ stdout: 'https://registry.npmjs.org/', code: 0 }),
      view: () => ({ stdout: '[]', code: 0 }),
    })
    let caught: unknown
    try {
      await resolveNpmPackage('my-plugin', undefined, {
        workDir,
        registry: 'http://evil.registry',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NpmPluginFetchError)
    expect((caught as InstanceType<typeof NpmPluginFetchError>).reason).toBe(
      'npm registry override is http',
    )
    expect(execCalls.some(c => c.args.includes('view'))).toBe(false)
  })

  test('invalid registry URL is refused (not a URL)', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({ view: () => ({ stdout: '[]', code: 0 }) })
    let caught: unknown
    try {
      await resolveNpmPackage('my-plugin', undefined, {
        workDir,
        registry: 'ftp://registry.example.com',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as InstanceType<typeof NpmPluginFetchError>).reason).toBe(
      'npm registry override is not a URL',
    )
  })
})

// --- oXt/HWe/Mrr: packNpmTarball spec validation ----------------------------
describe('packNpmTarball spec validation (official oXt/HWe/Mrr)', () => {
  test('refuses a git-host tarball URL before npm pack', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({ pack: () => ({ stdout: '', code: 0 }) })
    let caught: unknown
    try {
      await packNpmTarball('https://github.com/foo/bar', {
        workDir,
        displaySpec: 'foo@1.0.0',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NpmPluginFetchError)
    const err = caught as InstanceType<typeof NpmPluginFetchError>
    expect(err.reason).toBe('npm spec is not a plain tarball download')
    expect(err.message).toBe(
      `"foo@1.0.0" was not installed: its registry lists a download address that is on GitHub, GitLab, Bitbucket or SourceHut, where npm may fetch it as a git repository and run its setup script. The package's publisher can fix that.`,
    )
    expect(execCalls.some(c => c.args.includes('pack'))).toBe(false)
  })

  test('refuses an unencrypted http tarball on a foreign host', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({
      configGet: () => ({ stdout: 'https://registry.npmjs.org/', code: 0 }),
      pack: () => ({ stdout: '', code: 0 }),
    })
    let caught: unknown
    try {
      await packNpmTarball('http://evil.example.com/x.tgz', {
        workDir,
        displaySpec: 'x@1.0.0',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as InstanceType<typeof NpmPluginFetchError>).reason).toBe(
      'npm spec is not a plain tarball download',
    )
    expect(execCalls.some(c => c.args.includes('pack'))).toBe(false)
  })

  test('allows a plain https tarball through to npm pack', async () => {
    const workDir = await makeTempDir()
    execHandler = byCommand({ pack: () => ({ stdout: '', code: 0 }) })
    // Validation passes → npm pack runs → empty workDir has no .tgz → the
    // downstream "wrote no tarball" error proves we got past the 286 gate.
    let caught: unknown
    try {
      await packNpmTarball('https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz', {
        workDir,
        displaySpec: 'pkg@1.0.0',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NpmPluginFetchError)
    expect((caught as InstanceType<typeof NpmPluginFetchError>).reason).toBe(
      'npm pack wrote no tarball',
    )
    const pack = execCalls.find(c => c.args.includes('pack'))
    expect(pack).toBeDefined()
    expect(pack?.args[0]).toBe(gitArgv(workDir))
  })
})
