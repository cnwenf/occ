import {
  afterAll,
  afterEach,
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
 * 2.1.288 upstream port (gap-research-288 cluster-B Item 44): official v288
 * hardens the "is GitHub SSH configured" probe (`drt` @~207590400) that gates
 * the SSH→HTTPS clone fallback. Recovered official logic:
 *
 *   if(O()==="windows") return !1;                      // stay on SSH
 *   … if(GIT_SSH_COMMAND||GIT_SSH set) return !1;       // stay on SSH
 *   let S=await Xe(Tt(),["ls-remote","--get-url","--",n],{…timeout:5000});
 *   if(S.code!==0||S.stdout.trim()!==n)
 *     return t(`GitHub SSH URL is rewritten by git config, or git could not say (code=${S.code}): staying on SSH`),!1;
 *   if(await e.probeSsh()!=="not-configured") return !1; // ssh -T probe
 *   if(await Hl("ssh")===null) return !0;                // no ssh binary → HTTPS
 *   let w=await Xe("ssh",["-G","git@github.com"],{…timeout:5000}), B=w.stdout.split(…)
 *   if(w.code===0&&B.includes("hostname github.com")&&!B.some((H)=>/^proxy(command|jump)(?! none$)/.test(H)))
 *     return !0;
 *   return t(`ssh -G does not show git@github.com going straight to github.com (code=${w.code}): staying on SSH`),!1;
 *
 * OCC polarity is inverted (official true = "fall back to HTTPS"; OCC
 * isGitHubSshLikelyConfigured true = "stay on SSH / try SSH first"). These
 * tests pin the ported decision table and the two verbatim official log
 * strings. Exec/which/debug boundaries are mocked with the repo's
 * mock.module + real-delegation convention (partialCloneTransport287.test.ts).
 */

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = await makeTempDir('occ-ssh288-config-')

const realExecModule = await import('../../execFileNoThrow.js')
const realExecFileNoThrow = realExecModule.execFileNoThrow
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]

const realWhichModule = await import('../../which.js')
const realWhich = realWhichModule.which

const realDebugModule = await import('../../debug.js')
const debugLogs: string[] = []

let execMockActive = false

interface ExecCall {
  file: string
  args: string[]
  opts?: Record<string, unknown>
}
const execCalls: ExecCall[] = []

const SSH_URL = 'git@github.com:octo/market.git'

/** Programmable probe responses. */
let lsRemoteResponse: { stdout: string; stderr: string; code: number }
let sshTResponse: { stdout: string; stderr: string; code: number }
let sshGResponse: { stdout: string; stderr: string; code: number }
let sshBinaryPath: string | null

const SSH_AUTHED_STDERR =
  "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access."
const SSH_DENIED_STDERR = 'git@github.com: Permission denied (publickey).'
const CLEAN_SSH_G_STDOUT = [
  'user git',
  'hostname github.com',
  'port 22',
  'addressfamily any',
  'proxycommand none',
  '',
].join('\n')

async function handleExec(
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  execCalls.push({ file, args, opts })
  if (args[0] === 'ls-remote' && args.includes('--get-url')) {
    return lsRemoteResponse
  }
  if (file === 'ssh' && args[0] === '-T') {
    return sshTResponse
  }
  if (file === 'ssh' && args[0] === '-G') {
    return sshGResponse
  }
  return { stdout: '', stderr: '', code: 1 }
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

mock.module('../../which.js', () => ({
  ...realWhichModule,
  which: async (command: string) => {
    if (!execMockActive || command !== 'ssh') {
      return realWhich(command)
    }
    return sshBinaryPath
  },
}))

mock.module('../../debug.js', () => ({
  ...realDebugModule,
  logForDebugging: (message: string) => {
    debugLogs.push(message)
  },
}))

// Isolated module instance (deliberately a distinct specifier): sibling test
// files (pluginUrlRedaction275.test.ts) install process-global
// mock.module('../marketplaceManager.js', …) registrations that Bun keeps
// alive across files in the same process. A cache-busting query specifier
// gives this file its own unmocked instance regardless of file order
// (marketplaceKeptStale281.test.ts pattern). Held in a variable so tsc does
// not try to resolve the query string (TS2307).
type MarketplaceManagerModule = typeof import('../marketplaceManager.js')
const ISOLATED_MM_SPECIFIER = '../marketplaceManager.js?occ-ssh-288'
const { isGitHubSshLikelyConfigured } = (await import(
  ISOLATED_MM_SPECIFIER
)) as MarketplaceManagerModule

afterAll(() => {
  execMockActive = false
  mock.restore()
  mock.module('../../execFileNoThrow.js', () => realExecModule)
  mock.module('../../which.js', () => realWhichModule)
  mock.module('../../debug.js', () => realDebugModule)
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir
  }
  void Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

const savedGitSshCommand = process.env.GIT_SSH_COMMAND
const savedGitSsh = process.env.GIT_SSH

beforeEach(() => {
  execMockActive = true
  execCalls.length = 0
  debugLogs.length = 0
  // Defaults: URL echoes back, ssh -T not configured, ssh present, clean -G.
  lsRemoteResponse = { stdout: `${SSH_URL}\n`, stderr: '', code: 0 }
  sshTResponse = { stdout: '', stderr: SSH_DENIED_STDERR, code: 255 }
  sshGResponse = { stdout: CLEAN_SSH_G_STDOUT, stderr: '', code: 0 }
  sshBinaryPath = '/usr/bin/ssh'
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH
})

afterEach(() => {
  if (savedGitSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
  else process.env.GIT_SSH_COMMAND = savedGitSshCommand
  if (savedGitSsh === undefined) delete process.env.GIT_SSH
  else process.env.GIT_SSH = savedGitSsh
})

function ranLsRemote(): boolean {
  return execCalls.some(
    c => c.args[0] === 'ls-remote' && c.args.includes('--get-url'),
  )
}
function ranSshT(): boolean {
  return execCalls.some(c => c.file === 'ssh' && c.args[0] === '-T')
}
function ranSshG(): boolean {
  return execCalls.some(c => c.file === 'ssh' && c.args[0] === '-G')
}

describe('isGitHubSshLikelyConfigured v288 hardened probe (Item 44)', () => {
  test('GIT_SSH_COMMAND set bails to stay-on-SSH without probing', async () => {
    // Arrange
    process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/custom_key'

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(execCalls.length).toBe(0)
  })

  test('GIT_SSH set bails to stay-on-SSH without probing', async () => {
    // Arrange
    process.env.GIT_SSH = '/usr/local/bin/my-ssh-wrapper'

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(execCalls.length).toBe(0)
  })

  test('rewritten SSH URL (ls-remote --get-url echo differs) stays on SSH with the official log', async () => {
    // Arrange: git config url.*.insteadOf rewrites the scp-like URL to https.
    lsRemoteResponse = {
      stdout: 'https://github.com/octo/market.git\n',
      stderr: '',
      code: 0,
    }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(debugLogs).toContain(
      'GitHub SSH URL is rewritten by git config, or git could not say (code=0): staying on SSH',
    )
    // The rewrite verdict short-circuits before the ssh -T probe.
    expect(ranLsRemote()).toBe(true)
    expect(ranSshT()).toBe(false)
  })

  test('ls-remote failure (git could not say) stays on SSH with code in the official log', async () => {
    // Arrange
    lsRemoteResponse = { stdout: '', stderr: 'fatal: bad git', code: 128 }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(debugLogs).toContain(
      'GitHub SSH URL is rewritten by git config, or git could not say (code=128): staying on SSH',
    )
  })

  test('ls-remote --get-url runs against git with the 5s official timeout', async () => {
    // Act
    await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    const call = execCalls.find(
      c => c.args[0] === 'ls-remote' && c.args.includes('--get-url'),
    )
    expect(call).toBeDefined()
    expect(call!.args).toEqual(['ls-remote', '--get-url', '--', SSH_URL])
    expect(call!.opts?.timeout).toBe(5000)
  })

  test('ssh -T successfully authenticated stays on SSH without running ssh -G', async () => {
    // Arrange
    sshTResponse = { stdout: '', stderr: SSH_AUTHED_STDERR, code: 1 }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(ranSshT()).toBe(true)
    expect(ranSshG()).toBe(false)
  })

  test('not-configured ssh -T plus missing ssh binary allows HTTPS fallback', async () => {
    // Arrange
    sshBinaryPath = null

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(false)
    expect(ranSshG()).toBe(false)
  })

  test('clean ssh -G (hostname github.com, proxycommand none) allows HTTPS fallback with 5s timeout', async () => {
    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(false)
    const call = execCalls.find(c => c.file === 'ssh' && c.args[0] === '-G')
    expect(call).toBeDefined()
    expect(call!.args).toEqual(['-G', 'git@github.com'])
    expect(call!.opts?.timeout).toBe(5000)
  })

  test('proxyjump in ssh -G output stays on SSH with the official log', async () => {
    // Arrange
    sshGResponse = {
      stdout: [
        'user git',
        'hostname github.com',
        'port 22',
        'proxyjump bastion.example.com',
        '',
      ].join('\n'),
      stderr: '',
      code: 0,
    }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(debugLogs).toContain(
      'ssh -G does not show git@github.com going straight to github.com (code=0): staying on SSH',
    )
  })

  test('proxycommand other than none in ssh -G output stays on SSH', async () => {
    // Arrange
    sshGResponse = {
      stdout: [
        'user git',
        'hostname github.com',
        'proxycommand nc -X connect -x proxy.corp:8080 %h %p',
        '',
      ].join('\n'),
      stderr: '',
      code: 0,
    }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
  })

  test('ssh -G missing hostname github.com stays on SSH', async () => {
    // Arrange: ssh -G succeeds but the effective hostname was rewritten.
    sshGResponse = {
      stdout: ['user git', 'hostname github.enterprise.corp', 'port 22', ''].join(
        '\n',
      ),
      stderr: '',
      code: 0,
    }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(debugLogs).toContain(
      'ssh -G does not show git@github.com going straight to github.com (code=0): staying on SSH',
    )
  })

  test('ssh -G failure stays on SSH with the exit code in the official log', async () => {
    // Arrange
    sshGResponse = { stdout: '', stderr: 'ssh: garbage', code: 255 }

    // Act
    const configured = await isGitHubSshLikelyConfigured(SSH_URL)

    // Assert
    expect(configured).toBe(true)
    expect(debugLogs).toContain(
      'ssh -G does not show git@github.com going straight to github.com (code=255): staying on SSH',
    )
  })
})
