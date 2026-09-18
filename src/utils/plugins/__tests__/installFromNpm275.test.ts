import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Integration coverage for installFromNpm in pluginLoader.ts after the
 * CC 2.1.275 item-6 rewrite: it must delegate to installNpmPluginPackage
 * (npm pack --ignore-scripts + SRI verification) inside a fresh work dir
 * under <plugins>/npm-cache, clean that work dir up on both success and
 * failure, and propagate fetch errors unchanged.
 *
 * The npmPluginFetch module is mocked at the module boundary (spread of the
 * real module + recording stub), restored in afterAll, so no npm binary is
 * invoked and no network access happens.
 */

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

// Redirect the config/plugins directory into a throwaway temp dir BEFORE the
// module graph is loaded (getClaudeConfigHomeDir memoizes off CLAUDE_CONFIG_DIR).
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = await makeTempDir('occ-npm-loader-275-')
process.env.CLAUDE_CONFIG_DIR = configDir

const realNpmPluginFetch = await import('../npmPluginFetch.js')

interface InstallCall {
  params: unknown
  destPath: string
}
const installCalls: InstallCall[] = []
/** Per-test behavior override; the rejected promise is created lazily at call
 * time so it never sits unhandled while installFromNpm does its fs setup. */
let installImpl:
  | ((params: unknown, destPath: string) => Promise<unknown>)
  | null = null

mock.module('../npmPluginFetch.js', () => ({
  ...realNpmPluginFetch,
  installNpmPluginPackage: (params: unknown, destPath: string) => {
    installCalls.push({ params, destPath })
    if (installImpl) {
      return installImpl(params, destPath)
    }
    return Promise.resolve({
      name: 'pkg',
      version: '1.0.0',
      tarballUrl: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
    })
  },
}))

const { installFromNpm } = await import('../pluginLoader.js')
const { getPluginsDirectory } = await import('../pluginDirectories.js')

afterAll(async () => {
  mock.restore()
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  installCalls.length = 0
  installImpl = null
})

describe('pluginLoader installFromNpm (v2.1.275 ignore-scripts + integrity)', () => {
  test('delegates to installNpmPluginPackage with a fresh npm-cache work dir and removes it afterwards', async () => {
    const targetPath = await makeTempDir('occ-npm-target-')
    await installFromNpm('pkg', targetPath, {
      registry: 'https://registry.example.com',
      version: '1.2.3',
    })
    expect(installCalls).toHaveLength(1)
    const { params, destPath } = installCalls[0]
    expect(destPath).toBe(targetPath)
    expect(params).toEqual({
      packageName: 'pkg',
      versionSpec: '1.2.3',
      registry: 'https://registry.example.com',
      workDir: expect.any(String),
    })
    const workDir = (params as { workDir: string }).workDir
    const npmCacheRoot = join(getPluginsDirectory(), 'npm-cache')
    expect(workDir.startsWith(npmCacheRoot + '/')).toBe(true)
    // work dir is cleaned up on success
    await expect(stat(workDir)).rejects.toThrow()
  })

  test('works without registry/version options', async () => {
    const targetPath = await makeTempDir('occ-npm-target-')
    await installFromNpm('pkg', targetPath)
    const params = installCalls[0].params as Record<string, unknown>
    expect(params.packageName).toBe('pkg')
    expect(params.versionSpec).toBeUndefined()
    expect(params.registry).toBeUndefined()
  })

  test('propagates fetch errors and still cleans up the work dir', async () => {
    const targetPath = await makeTempDir('occ-npm-target-')
    const fetchError = new Error(
      'pkg@1.0.0 was not installed: the downloaded tarball does not match the integrity (sha512-BAD) the registry reported',
    )
    installImpl = () => Promise.reject(fetchError)
    let caught: unknown = null
    try {
      await installFromNpm('pkg', targetPath, { version: '1.0.0' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(fetchError)
    expect(installCalls).toHaveLength(1)
    const workDir = (installCalls[0].params as { workDir: string }).workDir
    await expect(stat(workDir)).rejects.toThrow()
  })
})
