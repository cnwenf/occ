import { type ChildProcess, execFileSync, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import {
  constants as fsConstants,
  readFileSync,
  statSync,
  unlinkSync,
} from 'fs'
import {
  type FileHandle,
  mkdir,
  open,
  realpath,
  statfs,
  unlink,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { join as posixJoin } from 'path/posix'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getSessionId,
  setCwdState,
} from '../bootstrap/state.js'
import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { generateTaskId } from '../Task.js'
import { pwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import {
  createAbortedCommand,
  createFailedCommand,
  type ShellCommand,
  wrapSpawn,
} from './ShellCommand.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { which } from './which.js'

export type { ExecResult } from './ShellCommand.js'

import { accessSync } from 'fs'
import { onCwdChangedForHooks } from './hooks/fileChangedWatcher.js'
import { getClaudeTempDirName } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import {
  SandboxManager,
  SandboxPolicyRefusalError,
} from './sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { getTmpRootDir } from './tmpDirBackstop.js'
import { createBashShellProvider } from './shell/bashProvider.js'
import {
  formatE2BigError,
  isE2BIG,
} from './bash/e2bigError.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
import { subprocessEnv } from './subprocessEnv.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes

/**
 * CC 2.1.306 (#P5): errno names for disk/fd exhaustion. Verbatim from the
 * official v306 binary (`O_e=new Set(["ENOSPC","EDQUOT","ENFILE","EMFILE"])`
 * @237500817, defined adjacent to the disk-full predicate `FSn`).
 */
export const DISK_EXHAUSTION_ERRNOS = new Set([
  'ENOSPC',
  'EDQUOT',
  'ENFILE',
  'EMFILE',
])

/**
 * CC 2.1.306 (#P5): true when the error's errno name means the disk is full.
 * Official predicate, verbatim (v306@237500817):
 *   `function FSn(n){let e=E(n);return e==="ENOSPC"||e==="EDQUOT"}`
 * — purely errno-code based (no message fallback).
 */
export function isDiskFullError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'ENOSPC' || code === 'EDQUOT'
}

/**
 * CC 2.1.309 (triage-T3 item 46 / F-7): shared remedy sentence, verbatim from
 * the official binary (`j9` @249266879):
 *   `var j9="Free space on that volume, or restart Claude Code with
 *    CLAUDE_CODE_TMPDIR set to a directory on another one, then retry. If this
 *    is the user's own computer, tell them before deleting anything to make
 *    room.",eco=5000;`
 * (`eco=5000` is the official size-poll interval — no OCC counterpart site.)
 */
export const DISK_FULL_REMEDY =
  "Free space on that volume, or restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another one, then retry. If this is the user's own computer, tell them before deleting anything to make room."

/**
 * CC 2.1.306 (#P5) → CC 2.1.309 (item 46): official disk-full start-failure
 * message. Rewritten in 309 — verbatim from @252265394 (306 text replaced):
 *   `if($r===void 0&&Rst(vs)){let Ss=E(vs),ki=Ss==="EDQUOT"?`the user's disk
 *    quota is used up (${Ss})`:`this computer's disk is full (${Ss})`;return
 *    Gy(`The command was not started: ${ki} on the volume holding
 *    ${xMr(bp(),jNe())} (Claude Code's temporary directory), so the file that
 *    captures command output could not be created there and nothing ran.
 *    ${j9}`)}`
 * — `xMr(bp(),jNe())` is join(tmpRoot, claude-<uid>) via a local `join` alias
 * (name-collision note: the module-level `xMr` @246828031 is a different
 * function; this alias was confirmed from the calling module's own imports).
 * Returned when the file that captures command output could not be created
 * because the disk/quota is full — the command never started.
 */
export function formatDiskFullStartError(errName: string): string {
  const cause =
    errName === 'EDQUOT'
      ? `the user's disk quota is used up (${errName})`
      : `this computer's disk is full (${errName})`
  const tempDir = join(getTmpRootDir(), getClaudeTempDirName())
  return `The command was not started: ${cause} on the volume holding ${tempDir} (Claude Code's temporary directory), so the file that captures command output could not be created there and nothing ran. ${DISK_FULL_REMEDY}`
}

/**
 * CC 2.1.309 (triage-T3 item 46 / F-7): probe-write beside a task-output file
 * to classify a volume failure. Official `SFo` @245635768 (byte-verified):
 *   `var Rt=new Uint8Array([10]);async function SFo(e){let n=`${e}.${Tt(6)
 *    .toString("hex")}.probe`;try{let i;try{i=await N(n,{exclusive:!0,
 *    windowsFlags:"wx"})}catch{return null}try{await i.write(Rt)}finally
 *    {await i.close()}return null}catch(i){return E(i)??null}finally{await
 *    Fun(n).catch((i)=>{t(`probeTaskOutputWrite: could not delete ${n}:
 *    ${d(i)}`)})}}`
 * Returns the errno name of a failed write, or null (open failure ALSO
 * returns null per the official inner catch; unlink is best-effort with a
 * debug log — the official debug string is reused verbatim).
 */
export async function probeTaskOutputWrite(
  outputFilePath: string,
): Promise<string | null> {
  const probePath = `${outputFilePath}.${randomBytes(6).toString('hex')}.probe`
  try {
    let handle: FileHandle
    try {
      handle = await open(probePath, 'wx')
    } catch {
      return null
    }
    try {
      await handle.write(new Uint8Array([10]))
    } finally {
      await handle.close()
    }
    return null
  } catch (error) {
    return getErrnoCode(error) ?? null
  } finally {
    await unlink(probePath).catch(error => {
      logForDebugging(
        `probeTaskOutputWrite: could not delete ${probePath}: ${errorMessage(error)}`,
      )
    })
  }
}

/**
 * CC 2.1.309 (triage-T3 item 46 / F-7): disk-full / inode-exhaustion
 * diagnostic for a FAILED file-mode command whose output may be truncated or
 * lost. Official `tco` @249267000+ (byte-verified; all four message templates
 * verbatim). Flow: statfs(dirname(output), {bigint:true}) →
 *   • plausible volume (`freeMb>=0n && blocks>0n`) with <10 MB free →
 *     "Disk full: …has ${H} MB free…";
 *   • plausible volume with files>0n and ffree<1000n → "Nearly out of inodes…";
 *   • plausible volume, output NOT lost → null (no probe);
 *   • otherwise probe-write beside the output file (SFo): EDQUOT → quota
 *     message (own remedy text, not j9), ENOSPC → disk-full message, else null.
 * `r` = join(bp(),jNe()) = join(getTmpRootDir(), getClaudeTempDirName());
 * `s` = lost ? "whatever this command printed was lost" : "this command's
 * output may be cut short". statfs errors are swallowed (official `catch{}`).
 */
export async function checkTaskOutputDiskFull(
  outputFilePath: string,
  outputWasLost: boolean,
): Promise<string | null> {
  const tempDir = join(getTmpRootDir(), getClaudeTempDirName())
  const lostPhrase = outputWasLost
    ? 'whatever this command printed was lost'
    : "this command's output may be cut short"
  const noSpaceClause = `so ${lostPhrase} and its own writes may have failed with "No space left on device".`
  let volumeLookedPlausible = false
  try {
    const stats = await statfs(dirname(outputFilePath), { bigint: true })
    const freeMb = stats.bavail * stats.bsize / (1024n * 1024n)
    volumeLookedPlausible = freeMb >= 0n && stats.blocks > 0n
    if (volumeLookedPlausible && freeMb < 10n) {
      return `Disk full: this computer's volume holding ${tempDir} (Claude Code's temporary directory) has ${freeMb} MB free, ${noSpaceClause} ${DISK_FULL_REMEDY}`
    }
    if (volumeLookedPlausible && stats.files > 0n && stats.ffree < 1000n) {
      return `Nearly out of inodes: this computer's volume holding ${tempDir} (Claude Code's temporary directory) has ${stats.ffree} free inodes, so creating files there may fail and the command may have failed for that reason. ${DISK_FULL_REMEDY}`
    }
  } catch {
    // statfs unsupported/failed — fall through to the probe (official catch{})
  }
  if (volumeLookedPlausible && !outputWasLost) {
    return null
  }
  const probeErrno = await probeTaskOutputWrite(outputFilePath)
  if (probeErrno === 'EDQUOT') {
    return `Disk quota used up: a test write beside this command's output file, on the volume holding ${tempDir} (Claude Code's temporary directory), failed with EDQUOT, so ${lostPhrase} and its own writes may have failed with "Disk quota exceeded". Delete files there that are no longer needed, or restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another volume, then retry. If this is the user's own computer, tell them before deleting anything to make room.`
  }
  if (probeErrno === 'ENOSPC') {
    return `Disk full: a test write beside this command's output file, on the volume holding ${tempDir} (Claude Code's temporary directory), failed with ENOSPC (the volume, or the user's quota on it, has no space left), ${noSpaceClause} ${DISK_FULL_REMEDY}`
  }
  return null
}

/**
 * CC 2.1.299 (#039): remove 0-byte sandbox mount-point residue at the
 * config-dir bind points. bwrap's deny-write list includes the config file
 * paths; for ones that do not exist on the host, sandbox-runtime pre-creates
 * a 0-byte stub (it mounts /dev/null over them) that survives the command —
 * a 0-byte `.config.json` / `.claude.json` stub then shadows the real auth
 * state on the next config read. Official v299 documents the residue class
 * (prompt text @107002052: "A 0-byte one belongs to the sandbox"; doctor
 * diagnostic @228225896, fix `rm <path>`). Runs AFTER the sandboxed command
 * exits (the mount is gone), removes only regular files that are exactly
 * 0 bytes — a file with content is the user's file and is never touched —
 * and is best-effort: sync, no-op when absent, same contract as
 * SandboxManager.cleanupAfterCommand().
 */
export function cleanupZeroByteConfigResidue(): void {
  const candidates = [
    join(getClaudeConfigHomeDir(), '.config.json'),
    join(
      process.env.CLAUDE_CONFIG_DIR || homedir(),
      `.claude${fileSuffixForOauthConfig()}.json`,
    ),
  ]
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate)
      if (stat.isFile() && stat.size === 0) {
        unlinkSync(candidate)
      }
    } catch {
      // Absent or unstat-able — nothing to clean
    }
  }
}

export type ShellConfig = {
  provider: ShellProvider
}

function isExecutable(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK)
    return true
  } catch (_err) {
    // Fallback for Nix and other environments where X_OK check might fail
    try {
      // Try to execute the shell with --version, which should exit quickly
      // Use execFileSync to avoid shell injection vulnerabilities
      execFileSync(shellPath, ['--version'], {
        timeout: 1000,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
}

/**
 * Determines the best available shell to use.
 */
export async function findSuitableShell(): Promise<string> {
  // Check for explicit shell override first
  const shellOverride = process.env.CLAUDE_CODE_SHELL
  if (shellOverride) {
    // Validate it's a supported shell type
    const isSupported =
      shellOverride.includes('bash') || shellOverride.includes('zsh')
    if (isSupported && isExecutable(shellOverride)) {
      logForDebugging(`Using shell override: ${shellOverride}`)
      return shellOverride
    } else {
      // Note, if we ever want to add support for new shells here we'll need to update or Bash tool parsing to account for this
      logForDebugging(
        `CLAUDE_CODE_SHELL="${shellOverride}" is not a valid bash/zsh path, falling back to detection`,
      )
    }
  }

  // Check user's preferred shell from environment
  const env_shell = process.env.SHELL
  // Only consider SHELL if it's bash or zsh
  const isEnvShellSupported =
    env_shell && (env_shell.includes('bash') || env_shell.includes('zsh'))
  const preferBash = env_shell?.includes('bash')

  // Try to locate shells using which (uses Bun.which when available)
  const [zshPath, bashPath] = await Promise.all([which('zsh'), which('bash')])

  // Populate shell paths from which results and fallback locations
  const shellPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']

  // Order shells based on user preference
  const shellOrder = preferBash ? ['bash', 'zsh'] : ['zsh', 'bash']
  const supportedShells = shellOrder.flatMap(shell =>
    shellPaths.map(path => `${path}/${shell}`),
  )

  // Add discovered paths to the beginning of our search list
  // Put the user's preferred shell type first
  if (preferBash) {
    if (bashPath) supportedShells.unshift(bashPath)
    if (zshPath) supportedShells.push(zshPath)
  } else {
    if (zshPath) supportedShells.unshift(zshPath)
    if (bashPath) supportedShells.push(bashPath)
  }

  // Always prioritize SHELL env variable if it's a supported shell type
  if (isEnvShellSupported && isExecutable(env_shell)) {
    supportedShells.unshift(env_shell)
  }

  const shellPath = supportedShells.find(shell => shell && isExecutable(shell))

  // If no valid shell found, throw a helpful error
  if (!shellPath) {
    const errorMsg =
      'No suitable shell found. Claude CLI requires a Posix shell environment. ' +
      'Please ensure you have a valid shell installed and the SHELL environment variable set.'
    logError(new Error(errorMsg))
    throw new Error(errorMsg)
  }

  return shellPath
}

async function getShellConfigImpl(): Promise<ShellConfig> {
  const binShell = await findSuitableShell()
  const provider = await createBashShellProvider(binShell)
  return { provider }
}

// Memoize the entire shell config so it only happens once per session
export const getShellConfig = memoize(getShellConfigImpl)

export const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const psPath = await getCachedPowerShellPath()
  if (!psPath) {
    throw new Error('PowerShell is not available')
  }
  return createPowerShellProvider(psPath)
})

const resolveProvider: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => (await getShellConfig()).provider,
  powershell: getPsProvider,
}

export type ExecOptions = {
  timeout?: number
  onProgress?: (
    lastLines: string,
    allLines: string,
    totalLines: number,
    totalBytes: number,
    isIncomplete: boolean,
  ) => void
  preventCwdChanges?: boolean
  shouldUseSandbox?: boolean
  shouldAutoBackground?: boolean
  /** When provided, stdout is piped (not sent to file) and this callback fires on each data chunk. */
  onStdout?: (data: string) => void
}

/**
 * Execute a shell command using the environment snapshot
 * Creates a new shell process for each command execution
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options?: ExecOptions,
): Promise<ShellCommand> {
  const {
    timeout,
    onProgress,
    preventCwdChanges,
    shouldUseSandbox,
    shouldAutoBackground,
    onStdout,
  } = options ?? {}
  const commandTimeout = timeout || DEFAULT_TIMEOUT

  const provider = await resolveProvider[shellType]()

  const id = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')

  // Sandbox temp directory - use per-user directory name to prevent multi-user permission conflicts
  const sandboxTmpDir = posixJoin(
    process.env.CLAUDE_CODE_TMPDIR || '/tmp',
    getClaudeTempDirName(),
  )

  const { commandString: builtCommand, cwdFilePath } =
    await provider.buildExecCommand(command, {
      id,
      sandboxTmpDir: shouldUseSandbox ? sandboxTmpDir : undefined,
      useSandbox: shouldUseSandbox ?? false,
    })

  let commandString = builtCommand

  let cwd = pwd()

  // Recover if the current working directory no longer exists on disk.
  // This can happen when a command deletes its own CWD (e.g., temp dir cleanup).
  try {
    await realpath(cwd)
  } catch {
    const fallback = getOriginalCwd()
    logForDebugging(
      `Shell CWD "${cwd}" no longer exists, recovering to "${fallback}"`,
    )
    try {
      await realpath(fallback)
      setCwdState(fallback)
      cwd = fallback
    } catch {
      return createFailedCommand(
        `Working directory "${cwd}" no longer exists. Please restart Claude from an existing directory.`,
      )
    }
  }

  // If already aborted, don't spawn the process at all
  if (abortSignal.aborted) {
    return createAbortedCommand()
  }

  const binShell = provider.shellPath

  // Sandboxed PowerShell: wrapWithSandbox hardcodes `<binShell> -c '<cmd>'` —
  // using pwsh there would lose -NoProfile -NonInteractive (profile load
  // inside sandbox → delays, stray output, may hang on prompts). Instead:
  //   • powershellProvider.buildExecCommand (useSandbox) pre-wraps as
  //     `pwsh -NoProfile -NonInteractive -EncodedCommand <base64>` — base64
  //     survives the runtime's shellquote.quote() layer
  //   • pass /bin/sh as the sandbox's inner shell to exec that invocation
  //   • outer spawn is also /bin/sh -c to parse the runtime's POSIX output
  // /bin/sh exists on every platform where sandbox is supported.
  const isSandboxedPowerShell = shouldUseSandbox && shellType === 'powershell'
  const sandboxBinShell = isSandboxedPowerShell ? '/bin/sh' : binShell

  // CC 2.1.309 (triage-T1-A item 1, security): official `xo=(q??!1)&&!pn`
  // (@252257156) — sandboxed && !Windows. On POSIX every sandboxed command
  // spawns `/bin/sh -c <wrapped>` as the OUTER process (official
  // `xo?[mEn,["-c",sn]]` @252260048, `mEn="/bin/sh"` @252248137) so the user's
  // shell startup files no longer run OUTSIDE the sandbox (the 308 bug).
  const isSandboxedPosix =
    (shouldUseSandbox ?? false) && getPlatform() !== 'windows'

  if (shouldUseSandbox) {
    // Official @252258300: `let ds=hKs(sn);Lr=ds;let Ta=await _En((Ua)=>
    // ze.wrapWithSandbox(ds,fr,To,Ua,vs),n,co);sn=Ta??sn,Ui=Ta===void 0`.
    // DEVIATIONS (declared): OCC has no seccomp pre-transform (`hKs` is
    // identity without `p6n()`, so the baseline `Lr` is the plain command) and
    // no abort-retry wrapper (`_En`) — OCC's wrapWithSandbox cannot return
    // undefined, so the official `Ui` wrap-undefined abort
    // (tengu_shell_abort_before_spawn) has no reachable OCC analogue.
    const preWrapCommand = commandString
    commandString = await SandboxManager.wrapWithSandbox(
      commandString,
      sandboxBinShell,
      undefined,
      abortSignal,
    )
    // Official unconfined guard @252260048 (byte-verbatim):
    // `if(xo&&sn===Lr)throw m("sandbox_exec","sandbox_wrap_unconfined"),
    //   new Dne("The sandbox produced no confinement for this command, so it
    //   was not run.","sandbox_wrap_unconfined")`
    // — the official topic logger m("sandbox_exec",…) maps to logForDebugging.
    if (isSandboxedPosix && commandString === preWrapCommand) {
      logForDebugging('sandbox_exec: sandbox_wrap_unconfined')
      throw new SandboxPolicyRefusalError(
        'The sandbox produced no confinement for this command, so it was not run.',
        'sandbox_wrap_unconfined',
      )
    }
    // Create sandbox temp directory for sandboxed processes with secure permissions
    try {
      const fs = getFsImplementation()
      await fs.mkdir(sandboxTmpDir, { mode: 0o700 })
    } catch (error) {
      logForDebugging(`Failed to create ${sandboxTmpDir} directory: ${error}`)
    }
  }

  // CC 2.1.309 item 1: official spawn selection @252260048 —
  // `xo?[mEn,["-c",sn]]:[po,Kt.getSpawnArgs(sn)]`. DEVIATION: the official
  // first arm (`Ko&&Er!==void 0?[Er,Ko.slice(1)]`) is the Windows
  // wrapWithSandboxArgv path — OCC has no argv-based Windows wrap subsystem,
  // so it is not ported (sandboxed PowerShell keeps its existing /bin/sh arm).
  const usesShOuterSpawn = isSandboxedPosix || isSandboxedPowerShell
  const spawnBinary = usesShOuterSpawn ? '/bin/sh' : binShell
  const shellArgs = usesShOuterSpawn
    ? ['-c', commandString]
    : provider.getSpawnArgs(commandString)
  const envOverrides = await provider.getEnvironmentOverrides(command)

  // When onStdout is provided, use pipe mode: stdout flows through
  // StreamWrapper → TaskOutput in-memory buffer instead of a file fd.
  // This lets callers receive real-time stdout callbacks.
  const usePipeMode = !!onStdout
  const taskId = generateTaskId('local_bash')
  const taskOutput = new TaskOutput(taskId, onProgress ?? null, !usePipeMode)
  await mkdir(getTaskOutputDir(), { recursive: true })

  // In file mode, both stdout and stderr go to the same file fd.
  // On POSIX, O_APPEND makes each write atomic (seek-to-end + write), so
  // stdout and stderr are interleaved chronologically without tearing.
  // On Windows, 'a' mode strips FILE_WRITE_DATA (only grants FILE_APPEND_DATA)
  // via libuv's fs__open. MSYS2/Cygwin probes inherited handles with
  // NtQueryInformationFile(FileAccessInformation) and treats handles without
  // FILE_WRITE_DATA as read-only, silently discarding all output. Using 'w'
  // grants FILE_GENERIC_WRITE. Atomicity is preserved because duplicated
  // handles share the same FILE_OBJECT with FILE_SYNCHRONOUS_IO_NONALERT,
  // which serializes all I/O through a single kernel lock.
  // SECURITY: O_NOFOLLOW prevents symlink-following attacks from the sandbox.
  // On Windows, use string flags — numeric flags can produce EINVAL through libuv.
  let outputHandle: FileHandle | undefined
  let childProcess: ChildProcess | undefined

  try {
    // CC 2.1.306 (#P5): the output-capture file is opened INSIDE the try so a
    // disk-full failure reaches the catch below — the official structure has
    // the open inside the try and reports ENOSPC/EDQUOT here as "the command
    // was not started" (v306@249973898 guard `Fa===void 0&&FSn(cs)`).
    if (!usePipeMode) {
      const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
      outputHandle = await open(
        taskOutput.path,
        process.platform === 'win32'
          ? 'w'
          : fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_APPEND |
              O_NOFOLLOW,
      )
    }

    childProcess = spawn(spawnBinary, shellArgs, {
      env: {
        ...subprocessEnv(),
        SHELL: shellType === 'bash' ? binShell : undefined,
        GIT_EDITOR: 'true',
        CLAUDECODE: '1',
        ...envOverrides,
        ...(process.env.USER_TYPE === 'ant'
          ? {
              CLAUDE_CODE_SESSION_ID: getSessionId(),
            }
          : {}),
      },
      cwd,
      stdio: usePipeMode
        ? ['pipe', 'pipe', 'pipe']
        : ['pipe', outputHandle?.fd, outputHandle?.fd],
      // Don't pass the signal - we'll handle termination ourselves with tree-kill
      detached: provider.detached,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

    const shellCommand = wrapSpawn(
      childProcess,
      abortSignal,
      commandTimeout,
      taskOutput,
      shouldAutoBackground,
    )

    // Close our copy of the fd — the child has its own dup.
    // Must happen after wrapSpawn attaches 'error' listener, since the await
    // yields and the child's ENOENT 'error' event can fire in that window.
    // Wrapped in its own try/catch so a close failure (e.g. EIO) doesn't fall
    // through to the spawn-failure catch block, which would orphan the child.
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close()
      } catch {
        // fd may already be closed by the child; safe to ignore
      }
    }

    // In pipe mode, attach the caller's callbacks alongside StreamWrapper.
    // Both listeners receive the same data chunks (Node.js ReadableStream supports
    // multiple 'data' listeners). StreamWrapper feeds TaskOutput for persistence;
    // these callbacks give the caller real-time access.
    if (childProcess.stdout && onStdout) {
      childProcess.stdout.on('data', (chunk: string | Buffer) => {
        onStdout(typeof chunk === 'string' ? chunk : chunk.toString())
      })
    }

    // Attach cleanup to the command result
    // NOTE: readFileSync/unlinkSync are intentional here — these must complete
    // synchronously within the .then() microtask so that callers who
    // `await shellCommand.result` see the updated cwd immediately after.
    // Using async readFile would introduce a microtask boundary, causing
    // a race where cwd hasn't been updated yet when the caller continues.

    // On Windows, cwdFilePath is a POSIX path (for bash's `pwd -P >| $path`),
    // but Node.js needs a native Windows path for readFileSync/unlinkSync.
    // Similarly, `pwd -P` outputs a POSIX path that must be converted before setCwd.
    const nativeCwdFilePath =
      getPlatform() === 'windows'
        ? posixPathToWindowsPath(cwdFilePath)
        : cwdFilePath

    void shellCommand.result.then(async result => {
      // On Linux, bwrap creates 0-byte mount-point files on the host to deny
      // writes to non-existent paths (.bashrc, HEAD, etc.). These persist after
      // bwrap exits as ghost dotfiles in cwd. Cleanup is synchronous and a no-op
      // on macOS. Keep before any await so callers awaiting .result see a clean
      // working tree in the same microtask.
      if (shouldUseSandbox) {
        SandboxManager.cleanupAfterCommand()
        // CC 2.1.299 (#039): also remove the 0-byte stubs bwrap pre-created
        // at the config-dir bind points, before any await (same sync
        // contract as the cwd-ghost cleanup above).
        cleanupZeroByteConfigResidue()
      }
      // Only foreground tasks update the cwd
      if (result && !preventCwdChanges && !result.backgroundTaskId) {
        try {
          let newCwd = readFileSync(nativeCwdFilePath, {
            encoding: 'utf8',
          }).trim()
          if (getPlatform() === 'windows') {
            newCwd = posixPathToWindowsPath(newCwd)
          }
          // cwd is NFC-normalized (setCwdState); newCwd from `pwd -P` may be
          // NFD on macOS APFS. Normalize before comparing so Unicode paths
          // don't false-positive as "changed" on every command.
          if (newCwd.normalize('NFC') !== cwd) {
            setCwd(newCwd, cwd)
            invalidateSessionEnvCache()
            void onCwdChangedForHooks(cwd, newCwd)
          }
        } catch {
          logEvent('tengu_shell_set_cwd', { success: false })
        }
      }
      // Clean up the temp file used for cwd tracking
      try {
        unlinkSync(nativeCwdFilePath)
      } catch {
        // File may not exist if command failed before pwd -P ran
      }
    })

    // CC 2.1.309 (triage-T3 item 46 / F-7): disk-full cut-off diagnostic.
    // Official caller @249271400 sits in the ShellCommand exit path (#M):
    //   `else if(this.taskOutput.stdoutToFile&&e!==0&&!(n&&e===H9)){let w=await
    //    tco(this.taskOutput.path,r==="");if(w)s.stdout=r?`${w}\n${r}`:w}`
    // (H9=137; n = status was "killed"; r = accumulated stdout).
    // STRUCTURAL DEVIATION (declared): ShellCommand.ts is outside this work
    // package's file list, so OCC wires the identical gate here by augmenting
    // `shellCommand.result` AFTER the cwd-tracking .then above (preserving its
    // sync-microtask contract). The killed-with-137 skip reads
    // shellCommand.status (OCC keeps 'killed' sticky through #handleExit);
    // official `s.stdout=` mutation becomes an immutable spread.
    if (taskOutput.stdoutToFile) {
      const baseResult = shellCommand.result
      shellCommand.result = baseResult.then(async result => {
        if (result.code === 0) {
          return result
        }
        if (shellCommand.status === 'killed' && result.code === 137) {
          return result
        }
        const diagnostic = await checkTaskOutputDiskFull(
          taskOutput.path,
          result.stdout === '',
        )
        if (diagnostic === null) {
          return result
        }
        return {
          ...result,
          stdout: result.stdout ? `${diagnostic}\n${result.stdout}` : diagnostic,
        }
      })
    }

    return shellCommand
  } catch (error) {
    // Close the fd if spawn failed (child never got its dup)
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close()
      } catch {
        // May already be closed
      }
    }
    taskOutput.clear()

    logForDebugging(`Shell exec error: ${errorMessage(error)}`)

    // E2BIG ("argument list too long"): in repos with many git worktrees the
    // Bash sandbox profile denies writes to a per-worktree git file for every
    // registered worktree, growing the sandboxed command line past ARG_MAX.
    // Surface an actionable error instead of an opaque exec failure. (2.1.201)
    if (isE2BIG(error)) {
      let sandboxDenyPaths: string[] = []
      if (shouldUseSandbox) {
        try {
          sandboxDenyPaths =
            SandboxManager.getFsWriteConfig()?.denyWithinAllow ?? []
        } catch {
          sandboxDenyPaths = []
        }
      }
      const e2bigMessage = formatE2BigError({
        binary: spawnBinary,
        argv: shellArgs,
        env: {
          ...subprocessEnv(),
          SHELL: shellType === 'bash' ? binShell : undefined,
          GIT_EDITOR: 'true',
          CLAUDECODE: '1',
          ...envOverrides,
        },
        sandboxDenyPaths,
      })
      logForDebugging(e2bigMessage)
      return createAbortedCommand(undefined, {
        code: 126, // Standard Unix code for execution errors
        stderr: e2bigMessage,
      })
    }

    // CC 2.1.306 (#P5): disk full before the command started — the official
    // guard is `Fa===void 0&&FSn(cs)` (child process never spawned; the
    // output-capture-file open sits inside the try before spawn, so its
    // ENOSPC/EDQUOT lands here — v306@249973898). Branch sits after the e2big
    // branch and before the raw passthrough; message is verbatim official copy.
    if (childProcess === undefined && isDiskFullError(error)) {
      return createAbortedCommand(undefined, {
        code: 126, // Standard Unix code for execution errors
        stderr: formatDiskFullStartError(getErrnoCode(error) ?? 'ENOSPC'),
      })
    }

    return createAbortedCommand(undefined, {
      code: 126, // Standard Unix code for execution errors
      stderr: errorMessage(error),
    })
  }
}

/**
 * Set the current working directory
 */
export function setCwd(path: string, relativeTo?: string): void {
  const resolved = isAbsolute(path)
    ? path
    : resolve(relativeTo || getFsImplementation().cwd(), path)
  // Resolve symlinks to match the behavior of pwd -P.
  // realpathSync throws ENOENT if the path doesn't exist - convert to a
  // friendlier error message instead of a separate existsSync pre-check (TOCTOU).
  let physicalPath: string
  try {
    physicalPath = getFsImplementation().realpathSync(resolved)
  } catch (e) {
    if (isENOENT(e)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    throw e
  }

  setCwdState(physicalPath)
  if (process.env.NODE_ENV !== 'test') {
    try {
      logEvent('tengu_shell_set_cwd', {
        success: true,
      })
    } catch (_error) {
      // Ignore logging errors to prevent test failures
    }
  }
}
