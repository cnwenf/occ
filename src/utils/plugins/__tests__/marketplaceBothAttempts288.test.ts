import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 2.1.288 upstream port (gap-research-288 cluster-B Item 52): `owner/repo`
 * marketplaces showed only the SECOND attempt's error when both the SSH and
 * HTTPS fetches failed. Official v288 (@210734308) combines both transport
 * errors, first-tried transport on top:
 *
 *   …if(…message!==n.error.message)
 *     n.error.message = `Fetching the marketplace from GitHub failed on both attempts. `+
 *       `${e.transport} (${e.url}): ${e.error.message}\n\n`+
 *       `${n.transport} (${n.url}): ${n.error.message}`;
 *   return n.error
 *
 * The official combines ONLY when the two messages differ — identical errors
 * surface as the single (second) error. These tests pin:
 *   1. the exported combine helper's condition + message shape (unit),
 *   2. the addMarketplaceSource dual-transport path (SSH-first and
 *      HTTPS-first orderings) end-to-end with a mocked exec boundary,
 *   3. the refreshMarketplace dual-transport fallback path,
 *   4. identical errors → single error preserved.
 *
 * Mock convention: partialCloneTransport287.test.ts (mock.module +
 * real-delegation). CLAUDE_CODE_PLUGIN_CACHE_DIR is sandboxed per test
 * (reservedNameImitation280.test.ts pattern) so no real user config is touched.
 */

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = await makeTempDir('occ-both288-config-')
const savedPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR

const realExecModule = await import('../../execFileNoThrow.js')
const realExecFileNoThrow = realExecModule.execFileNoThrow
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]

const realWhichModule = await import('../../which.js')
const realWhich = realWhichModule.which

let execMockActive = false

interface ExecCall {
  file: string
  args: string[]
}
const execCalls: ExecCall[] = []

const REPO = 'octo/market'
const SSH_URL = `git@github.com:${REPO}.git`
const HTTPS_URL = `https://github.com/${REPO}.git`

/** Per-test programmable responses. */
let sshCloneStderr: string
let httpsCloneStderr: string
let sshTAuthed: boolean
let sshBinaryPath: string | null

async function handleExec(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  execCalls.push({ file, args })
  // Probe: ls-remote --get-url echoes the URL unchanged (no rewrite).
  if (args[0] === 'ls-remote' && args.includes('--get-url')) {
    const url = args[args.length - 1]
    return { stdout: `${url}\n`, stderr: '', code: 0 }
  }
  // Probe: ssh -T.
  if (file === 'ssh' && args[0] === '-T') {
    return sshTAuthed
      ? {
          stdout: '',
          stderr:
            "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.",
          code: 1,
        }
      : {
          stdout: '',
          stderr: 'git@github.com: Permission denied (publickey).',
          code: 255,
        }
  }
  // Probe: ssh -G (clean, straight to github.com).
  if (file === 'ssh' && args[0] === '-G') {
    return {
      stdout: 'user git\nhostname github.com\nport 22\n',
      stderr: '',
      code: 0,
    }
  }
  // Clone attempts: fail with per-transport stderr.
  if (args.includes('clone')) {
    if (args.includes(SSH_URL)) {
      return { stdout: '', stderr: sshCloneStderr, code: 128 }
    }
    if (args.includes(HTTPS_URL)) {
      return { stdout: '', stderr: httpsCloneStderr, code: 128 }
    }
  }
  // Everything else (reconcile/pull/config reads) fails so the code paths
  // fall through to the clone attempts under test.
  return { stdout: '', stderr: 'mock: unsupported exec in test', code: 1 }
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
    return handleExec(file, args)
  },
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts?: ExecOpts,
  ) => {
    if (!execMockActive) {
      return realExecFileNoThrowWithCwd(file, args, opts)
    }
    return handleExec(file, args)
  },
}))

mock.module('../../which.js', () => ({
  ...realWhichModule,
  which: async (command: string) => {
    if (!execMockActive || command !== 'ssh') {
      return realWhich(command)
    }
    return sshBinaryPath
  },
}))

// Isolated module instance (deliberately a distinct specifier).
//
// `pluginUrlRedaction275.test.ts` installs a process-global
// `mock.module('../marketplaceManager.js', …)` that stubs
// `loadKnownMarketplacesConfig` with its own `git-market` fixture, and Bun
// keeps that registration alive across test files in the same process — a
// plain import here would read the other file's fixture instead of this
// file's sandboxed known_marketplaces.json. A cache-busting query specifier
// gives this file its own unmocked instance (marketplaceKeptStale281.test.ts
// pattern). The specifier is held in a variable so tsc does not try to
// resolve the query string (TS2307).
type MarketplaceManagerModule = typeof import('../marketplaceManager.js')
const ISOLATED_MM_SPECIFIER = '../marketplaceManager.js?occ-both-288'
const {
  addMarketplaceSource,
  combineBothAttemptsError,
  getMarketplacesCacheDir,
  refreshMarketplace,
} = (await import(ISOLATED_MM_SPECIFIER)) as MarketplaceManagerModule
const { getPluginsDirectory } = await import('../pluginDirectories.js')

afterAll(() => {
  execMockActive = false
  mock.restore()
  mock.module('../../execFileNoThrow.js', () => realExecModule)
  mock.module('../../which.js', () => realWhichModule)
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  if (savedPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = savedPluginCacheDir
  }
  void Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_PLUGIN_PREFER_HTTPS',
  'CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
]) {
  savedEnv[key] = process.env[key]
}

beforeEach(async () => {
  execMockActive = true
  execCalls.length = 0
  sshCloneStderr = 'ssh transport exploded'
  httpsCloneStderr = 'https transport exploded'
  sshTAuthed = true
  sshBinaryPath = '/usr/bin/ssh'
  for (const key of Object.keys(savedEnv)) {
    delete process.env[key]
  }
  // Fresh per-test sandbox for known_marketplaces.json + marketplaces cache.
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = await makeTempDir('occ-both288-cache-')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function seedRegisteredGitHubMarketplace(
  name: string,
): Promise<string> {
  const pluginsDir = getPluginsDirectory()
  await mkdir(pluginsDir, { recursive: true })
  const installLocation = join(getMarketplacesCacheDir(), `${name}-dir`)
  await mkdir(installLocation, { recursive: true })
  await writeFile(
    join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({
      [name]: {
        source: { source: 'github', repo: REPO },
        installLocation,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      },
    }),
  )
  return installLocation
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<string> {
  let message = ''
  await promise.catch((e: unknown) => {
    message = (e as Error).message
  })
  expect(message).not.toBe('')
  return message
}

describe('combineBothAttemptsError (official @210734308)', () => {
  test('combines differing messages, first-tried transport on top, returning the second error', () => {
    // Arrange
    const firstError = new Error('first boom')
    const secondError = new Error('second boom')

    // Act
    const result = combineBothAttemptsError(
      { transport: 'SSH', url: SSH_URL, error: firstError },
      { transport: 'HTTPS', url: HTTPS_URL, error: secondError },
    )

    // Assert
    expect(result).toBe(secondError)
    expect(result.message).toBe(
      `Fetching the marketplace from GitHub failed on both attempts. ` +
        `SSH (${SSH_URL}): first boom\n\n` +
        `HTTPS (${HTTPS_URL}): second boom`,
    )
  })

  test('identical messages keep the single second error (no combination)', () => {
    // Arrange
    const firstError = new Error('same boom')
    const secondError = new Error('same boom')

    // Act
    const result = combineBothAttemptsError(
      { transport: 'SSH', url: SSH_URL, error: firstError },
      { transport: 'HTTPS', url: HTTPS_URL, error: secondError },
    )

    // Assert
    expect(result).toBe(secondError)
    expect(result.message).toBe('same boom')
  })
})

describe('addMarketplaceSource github dual-transport combined error (Item 52)', () => {
  test('SSH-first: both attempts fail → combined message with SSH on top', async () => {
    // Arrange: ssh -T authenticated → SSH tried first.
    const progress: string[] = []

    // Act
    const message = await expectRejection(
      addMarketplaceSource(
        { source: 'github', repo: REPO },
        m => {
          progress.push(m)
        },
      ),
    )

    // Assert
    expect(message).toBe(
      `Fetching the marketplace from GitHub failed on both attempts. ` +
        `SSH (${SSH_URL}): Failed to clone marketplace repository: ssh transport exploded\n\n` +
        `HTTPS (${HTTPS_URL}): Failed to clone marketplace repository: https transport exploded`,
    )
    // SSH really was the first-tried transport.
    expect(progress).toContain(`Cloning via SSH: ${SSH_URL}`)
    expect(progress).toContain(`SSH clone failed, retrying with HTTPS: ${HTTPS_URL}`)
  })

  test('HTTPS-first: both attempts fail → combined message with HTTPS on top', async () => {
    // Arrange: ssh -T not configured + no ssh binary → HTTPS fallback path.
    sshTAuthed = false
    sshBinaryPath = null

    // Act
    const message = await expectRejection(
      addMarketplaceSource({ source: 'github', repo: REPO }),
    )

    // Assert
    expect(message).toBe(
      `Fetching the marketplace from GitHub failed on both attempts. ` +
        `HTTPS (${HTTPS_URL}): Failed to clone marketplace repository: https transport exploded\n\n` +
        `SSH (${SSH_URL}): Failed to clone marketplace repository: ssh transport exploded`,
    )
  })

  test('identical errors on both transports → single error preserved', async () => {
    // Arrange
    sshCloneStderr = 'identical boom'
    httpsCloneStderr = 'identical boom'

    // Act
    const message = await expectRejection(
      addMarketplaceSource({ source: 'github', repo: REPO }),
    )

    // Assert
    expect(message).toBe(
      'Failed to clone marketplace repository: identical boom',
    )
    expect(message).not.toContain('both attempts')
  })
})

describe('refreshMarketplace github dual-transport combined error (Item 52)', () => {
  test('both transports fail on refresh → wrapped error carries the combined message, SSH on top', async () => {
    // Arrange
    await seedRegisteredGitHubMarketplace('both-mp')

    // Act
    const message = await expectRejection(refreshMarketplace('both-mp'))

    // Assert
    expect(message).toBe(
      `Failed to refresh marketplace 'both-mp': ` +
        `Fetching the marketplace from GitHub failed on both attempts. ` +
        `SSH (${SSH_URL}): Failed to clone marketplace repository: ssh transport exploded\n\n` +
        `HTTPS (${HTTPS_URL}): Failed to clone marketplace repository: https transport exploded`,
    )
  })

  test('identical errors on refresh → single error preserved inside the wrapper', async () => {
    // Arrange
    sshCloneStderr = 'identical boom'
    httpsCloneStderr = 'identical boom'
    await seedRegisteredGitHubMarketplace('both-mp-same')

    // Act
    const message = await expectRejection(refreshMarketplace('both-mp-same'))

    // Assert
    expect(message).toBe(
      `Failed to refresh marketplace 'both-mp-same': Failed to clone marketplace repository: identical boom`,
    )
    expect(message).not.toContain('both attempts')
  })
})
