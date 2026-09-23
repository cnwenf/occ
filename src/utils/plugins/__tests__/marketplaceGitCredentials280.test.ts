import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.280 changelog item #049 (marketplace git credential handling):
 *
 * Official v280 DROPS the `-c credential.helper=` / disableCredentialHelper
 * machinery entirely (v278 binary: 8 hits for `disableCredentialHelper`,
 * v280: 0) and the `tengu_plugin_autoupdate_allow_credential_helper` gate
 * (v278: 2 hits, v280: 0). Background marketplace autoupdate previously
 * disabled credential helpers, so private-repo marketplaces either re-cloned
 * every run or never updated.
 *
 * Official v280 replacements (byte-verified):
 *   $se (ls-remote) @200749864: spawn opts include `stdin:"ignore"`, no
 *     credentialArgs.
 *   kB (refresh dedup) @200816052: keyed by marketplace name only — v278 E1
 *     keyed `${name}:${disableCredentialHelper?1:0}`.
 *   autoupdate @206898216: `kB(e,n,void 0,{isBackground:!0})` — the flag and
 *     its GrowthBook gate are gone.
 *   Mz env pin: {GIT_TERMINAL_PROMPT:"0",GIT_ASKPASS:"",GCM_INTERACTIVE:"never"}
 *     — non-interactive prompting is enforced via env + stdin, not by
 *     disabling credential helpers.
 *
 * OCC port: gitPull()/gitSubmoduleUpdate()/cacheMarketplaceFromGit()/
 * refreshMarketplace() no longer accept or spread disableCredentialHelper.
 * GIT_TERMINAL_PROMPT/GIT_ASKPASS env pin and stdin:'ignore' on every
 * marketplace git spawn are retained.
 *
 * exec is mocked at the module boundary (mock.module spreading the real
 * module, per npmPluginFetch275.test.ts convention).
 */

// --- module-boundary mocks (registered BEFORE importing the module under test)

const realExecModule = await import('../../execFileNoThrow.js')

interface ExecCall {
  file: string
  args: string[]
  opts: Record<string, unknown>
}
const execCalls: ExecCall[] = []

// Capture the real function value BEFORE mock.module registration: Bun patches
// live ESM namespaces, so calling realModule.fn() inside the factory would
// recurse into the mock itself. Bun's mock.restore() does NOT undo mock.module
// registry patches, so the mock delegates to the real implementation whenever
// execMockActive is false — otherwise the stub would leak into sibling test
// files batched after this one (e.g. marketplaceSwapSafety276's real git
// clones). Same convention as npmPluginFetch275.test.ts.
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]
let execMockActive = false

mock.module('../../execFileNoThrow.js', () => ({
  ...realExecModule,
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    if (!execMockActive) {
      return realExecFileNoThrowWithCwd(file, args, opts as ExecOpts)
    }
    execCalls.push({ file, args, opts })
    // All git ops "succeed" so gitPull walks its full spawn sequence
    // (fetch → checkout → pull → submodule update).
    return { stdout: '', stderr: '', code: 0 }
  },
}))

const { gitPull } = await import('../marketplaceManager')

describe('marketplace git credential handling (2.1.280 #049)', () => {
  let workdir: string

  beforeEach(() => {
    execMockActive = true
    execCalls.length = 0
    workdir = mkdtempSync(join(tmpdir(), 'mgc280-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  afterAll(() => {
    execMockActive = false
    mock.restore()
    // Belt and braces: re-register the real module so sibling test files
    // batched after this one never observe the stub (see execMockActive note).
    mock.module('../../execFileNoThrow.js', () => realExecModule)
  })

  test('gitPull default branch: no -c credential.helper= args, stdin ignored', async () => {
    const result = await gitPull(workdir)
    expect(result.code).toBe(0)

    // pull origin HEAD (+ submodule stat short-circuits: no .gitmodules)
    expect(execCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of execCalls) {
      const joined = call.args.join(' ')
      expect(joined).not.toContain('credential.helper')
      expect(call.opts.stdin).toBe('ignore')
      const env = call.opts.env as Record<string, string>
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GIT_ASKPASS).toBe('')
    }
    expect(execCalls[0]!.args).toEqual(['pull', 'origin', 'HEAD'])
  })

  test('gitPull with ref: fetch/checkout/pull all credential-helper-free', async () => {
    const result = await gitPull(workdir, 'v1.2.3')
    expect(result.code).toBe(0)

    // fetch → checkout → pull
    expect(execCalls.length).toBeGreaterThanOrEqual(3)
    expect(execCalls[0]!.args).toEqual(['fetch', 'origin', 'v1.2.3'])
    expect(execCalls[1]!.args).toEqual(['checkout', 'v1.2.3'])
    expect(execCalls[2]!.args).toEqual(['pull', 'origin', 'v1.2.3'])
    for (const call of execCalls) {
      expect(call.args.join(' ')).not.toContain('credential.helper')
      expect(call.opts.stdin).toBe('ignore')
    }
  })

  test('gitSubmoduleUpdate spawn: sshCommand pin kept, no credential.helper', async () => {
    // .gitmodules present → submodule update spawn is not skipped
    writeFileSync(join(workdir, '.gitmodules'), '[submodule "x"]\n')

    const result = await gitPull(workdir)
    expect(result.code).toBe(0)

    const submoduleCall = execCalls.find(call =>
      call.args.includes('submodule'),
    )
    expect(submoduleCall).toBeDefined()
    expect(submoduleCall!.args).toEqual([
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
    ])
    expect(submoduleCall!.args.join(' ')).not.toContain('credential.helper')
    expect(submoduleCall!.opts.stdin).toBe('ignore')
  })

  test('gitPull no longer accepts disableCredentialHelper (v280 signature)', async () => {
    // v278 signature: gitPull(cwd, ref?, { disableCredentialHelper?, sparsePaths? })
    // v280 port: options only carries sparsePaths. Passing the removed flag
    // must NOT add credential args (flag is dead — official v280 has 0 hits).
    const legacyOptions = { disableCredentialHelper: true } as unknown as {
      sparsePaths?: string[]
    }
    const result = await gitPull(workdir, undefined, legacyOptions)
    expect(result.code).toBe(0)
    for (const call of execCalls) {
      expect(call.args.join(' ')).not.toContain('credential.helper')
    }
  })
})
