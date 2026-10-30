/**
 * CC 2.1.309 (triage-T1-A item 1, security 🔒): sandboxed POSIX commands must
 * spawn `/bin/sh` as the OUTER process, and a sandbox wrap that produced no
 * confinement must abort instead of running the command unconfined.
 *
 * The 308 bug OCC replicated: the outer spawn used the user's shell
 * (`binShell` + `provider.getSpawnArgs`), so the user's shell startup files
 * (.zshrc/.bashrc …) ran OUTSIDE the sandbox — only the inner command was
 * wrapped. Official 309 fix (linux-x64 ELF, byte-verified read-only):
 * - @252257156: `let po=Kt.shellPath,xo=(q??!1)&&!pn,fr=xo&&r==="powershell"?mEn:po;`
 *   (`mEn="/bin/sh"` @252248137; `xo` = sandboxed && !Windows)
 * - @252258300 (non-Windows wrap): `let ds=hKs(sn);Lr=ds;let Ta=await
 *   _En((Ua)=>ze.wrapWithSandbox(ds,fr,To,Ua,vs),n,co);sn=Ta??sn,Ui=Ta===void 0`
 * - @252260048 (unconfined guard + spawn selection):
 *   `if(xo&&sn===Lr)throw m("sandbox_exec","sandbox_wrap_unconfined"),new Dne("The sandbox produced no confinement for this command, so it was not run.","sandbox_wrap_unconfined");let[Ur,ts]=Ko&&Er!==void 0?[Er,Ko.slice(1)]:xo?[mEn,["-c",sn]]:[po,Kt.getSpawnArgs(sn)]`
 * - @246555591 (error class): `class Dne extends Error{reason;constructor(e,n)
 *   {super(e);this.reason=n;this.name="SandboxPolicyRefusalError"}}`
 *
 * OCC port: Shell.ts exec() — isSandboxedPosix outer `/bin/sh -c` spawn +
 * unconfined abort; SandboxPolicyRefusalError in sandbox-adapter.ts.
 * Deviations (declared at the code sites): OCC has no Windows
 * wrapWithSandboxArgv subsystem (Ko branch) and no seccomp pre-transform
 * (hKs is identity without p6n(), so the baseline Lr is the plain command);
 * the official topic logger m("sandbox_exec",…) maps to logForDebugging.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as REAL_CHILD_PROCESS from 'child_process'
import { exec } from '../Shell.js'
import * as REAL_SANDBOX_ADAPTER from '../sandbox/sandbox-adapter.js'
import * as REAL_BASH_PROVIDER from '../shell/bashProvider.js'

// Snapshot the REAL exports by value BEFORE mock.module patches the live
// namespace bindings (precedent: hookStdioFlags285RealChild.test.ts) —
// delegating to `REAL_CHILD_PROCESS.spawn` after mocking would recurse into
// the spy, and restoring from the patched namespace would leak the mock.
const PRISTINE_CHILD_PROCESS = { ...REAL_CHILD_PROCESS }
const PRISTINE_SANDBOX_ADAPTER = { ...REAL_SANDBOX_ADAPTER }
const PRISTINE_BASH_PROVIDER = { ...REAL_BASH_PROVIDER }
const realSpawn = PRISTINE_CHILD_PROCESS.spawn as (...args: unknown[]) => unknown

type SpawnCapture = { binary: string; args: string[] }

/** Minimal fake bash provider so exec() never touches real shell snapshots. */
async function installFakeBashProvider(): Promise<void> {
  await mock.module('../shell/bashProvider.js', () => ({
    createBashShellProvider: async (shellPath: string) => ({
      type: 'bash' as const,
      shellPath,
      detached: false,
      buildExecCommand: async (command: string) => ({
        commandString: command,
        cwdFilePath: '/tmp/occ-outer-spawn-309-cwd',
      }),
      getSpawnArgs: (commandString: string) => ['-c', commandString],
      getEnvironmentOverrides: async () => ({}),
    }),
  }))
}

/** Mock SandboxManager.wrapWithSandbox; spawn delegates to the real one. */
async function installSandboxStub(wrap: (command: string) => string): Promise<{
  spawnCalls: SpawnCapture[]
  wrapBinShells: string[]
}> {
  const capture = { spawnCalls: [] as SpawnCapture[], wrapBinShells: [] as string[] }
  await mock.module('../sandbox/sandbox-adapter.js', () => ({
    ...PRISTINE_SANDBOX_ADAPTER,
    SandboxManager: {
      ...PRISTINE_SANDBOX_ADAPTER.SandboxManager,
      wrapWithSandbox: async (command: string, binShell?: string) => {
        capture.wrapBinShells.push(binShell ?? '')
        return wrap(command)
      },
      cleanupAfterCommand: () => {},
    },
  }))
  await mock.module('child_process', () => ({
    ...PRISTINE_CHILD_PROCESS,
    spawn: (binary: string, args: string[], ...rest: unknown[]) => {
      capture.spawnCalls.push({ binary, args })
      return realSpawn(binary, args, ...rest)
    },
  }))
  return capture
}

async function restoreMocks(): Promise<void> {
  await mock.module('../sandbox/sandbox-adapter.js', () => ({
    ...PRISTINE_SANDBOX_ADAPTER,
  }))
  await mock.module('child_process', () => ({ ...PRISTINE_CHILD_PROCESS }))
  // OCC-97 hygiene: the fake bash provider must be restored too — leaking it
  // into later files in the same `bun test` process made their real-provider
  // assertions (e.g. tmpdirBackstop277) see the raw-command stub.
  await mock.module('../shell/bashProvider.js', () => ({
    ...PRISTINE_BASH_PROVIDER,
  }))
}

describe('CC 2.1.309 item 1 — sandboxed POSIX outer spawn is /bin/sh', () => {
  afterEach(async () => {
    await restoreMocks()
  })

  test('sandboxed bash spawns /bin/sh -c <wrapped>, never the user shell', async () => {
    // Arrange — the stand-in wrapper must stay a runnable sh command so the
    // delegated real spawn exits 0 (the guard only compares pre/post-wrap).
    await installFakeBashProvider()
    const capture = await installSandboxStub(command => `true && ${command}`)

    // Act
    const shellCommand = await exec('echo hi', new AbortController().signal, 'bash', {
      shouldUseSandbox: true,
    })
    const result = await shellCommand.result

    // Assert — official: `xo?[mEn,["-c",sn]]` with mEn="/bin/sh"
    expect(capture.spawnCalls.length).toBe(1)
    expect(capture.spawnCalls[0]!.binary).toBe('/bin/sh')
    expect(capture.spawnCalls[0]!.args).toEqual(['-c', 'true && echo hi'])
    // wrapWithSandbox still receives the provider shell as inner binShell
    // (official fr=po for non-powershell)
    expect(capture.wrapBinShells.length).toBe(1)
    expect(capture.wrapBinShells[0]).not.toBe('')
    expect(result.code).toBe(0)
  })

  test('non-sandboxed bash keeps the provider shell + getSpawnArgs (no regression)', async () => {
    // Arrange
    await installFakeBashProvider()
    const capture = await installSandboxStub(command => command)

    // Act
    const shellCommand = await exec('echo hi', new AbortController().signal, 'bash')
    const result = await shellCommand.result

    // Assert — official non-xo arm: `[po,Kt.getSpawnArgs(sn)]`
    expect(capture.spawnCalls.length).toBe(1)
    expect(capture.spawnCalls[0]!.binary).not.toBe('/bin/sh')
    expect(capture.spawnCalls[0]!.args).toEqual(['-c', 'echo hi'])
    expect(result.code).toBe(0)
  })

  test('wrap that produced no confinement aborts with SandboxPolicyRefusalError and never spawns', async () => {
    // Arrange — stub returns the command UNCHANGED (official: sn===Lr)
    await installFakeBashProvider()
    const capture = await installSandboxStub(command => command)

    // Act + Assert — official @252260048:
    // `throw m("sandbox_exec","sandbox_wrap_unconfined"),new Dne("The sandbox
    //  produced no confinement for this command, so it was not run.",
    //  "sandbox_wrap_unconfined")`
    let thrown: unknown
    try {
      await exec('echo hi', new AbortController().signal, 'bash', {
        shouldUseSandbox: true,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const refusal = thrown as Error & { reason?: string }
    expect(refusal.name).toBe('SandboxPolicyRefusalError')
    expect(refusal.reason).toBe('sandbox_wrap_unconfined')
    expect(refusal.message).toBe(
      'The sandbox produced no confinement for this command, so it was not run.',
    )
    expect(capture.spawnCalls.length).toBe(0)
  })

  test('confining wrap does not trigger the unconfined abort', async () => {
    // Arrange
    await installFakeBashProvider()
    const capture = await installSandboxStub(command => `true && ${command}`)

    // Act — must not throw
    const shellCommand = await exec('true', new AbortController().signal, 'bash', {
      shouldUseSandbox: true,
    })
    const result = await shellCommand.result

    // Assert
    expect(capture.spawnCalls.length).toBe(1)
    expect(result.code).toBe(0)
  })
})
