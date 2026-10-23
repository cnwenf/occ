// This file represents useful wrappers over node:child_process
// These wrappers ease error handling and cross-platform compatbility
// By using execa, Windows automatically gets shell escaping + BAT / CMD handling

import { type ExecaError, execa } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { type GitEnvOptions, buildMergedGitEnv } from './git/gitEnv.js'
import {
  GIT_MISSING_MACOS_EXIT_CODE,
  GIT_MISSING_MACOS_MESSAGE,
  isGitMissingOnMacos,
} from './git/macosGitMissing.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  // Setting useCwd=false avoids circular dependencies during initialization
  // getCwd() -> PersistentShell -> logEvent() -> execFileNoThrow
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
  // Official v285 `Je` option (@196477428): spawn the child detached from the
  // controlling terminal on POSIX so ssh cannot prompt on /dev/tty. Used by
  // the worktree/teleport fetch fail-fast (2.1.285 changelog item 3).
  withoutControllingTerminal?: boolean
  // Opt-in git-env hardening (official git-spawn wrapper `WNt`/`jKs`→`air`,
  // BIN309 @23003239/@22986874). When set, `env` is treated as the minimal
  // override layer and routed through buildMergedGitEnv before reaching execa:
  // inherited GIT_* redirect/config vars are scrubbed and (2.1.309 item 10)
  // GIT_NO_REPLACE_OBJECTS=1 is default-injected. Pass `true` for the default
  // merge, or a GitEnvOptions to pin a repository / opt out of the C locale.
  // Absent → the generic exec path is unchanged (no git coupling).
  gitEnv?: boolean | GitEnvOptions
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
    withoutControllingTerminal: options.withoutControllingTerminal,
    gitEnv: options.gitEnv,
  })
}

type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string | undefined
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
  /** See ExecFileOptions.withoutControllingTerminal (official `Je` `be`). */
  withoutControllingTerminal?: boolean
  /** See ExecFileOptions.gitEnv (official git-spawn wrapper `WNt`/`jKs`→`air`). */
  gitEnv?: boolean | GitEnvOptions
}

type ExecaResultWithError = {
  shortMessage?: string
  signal?: string
}

/**
 * Extracts a human-readable error message from an execa result.
 *
 * Priority order:
 * 1. shortMessage - execa's human-readable error (e.g., "Command failed with exit code 1: ...")
 *    This is preferred because it already includes signal info when a process is killed,
 *    making it more informative than just the signal name.
 * 2. signal - the signal that killed the process (e.g., "SIGTERM")
 * 3. errorCode - fallback to just the numeric exit code
 */
function getErrorMessage(
  result: ExecaResultWithError,
  errorCode: number,
): string {
  if (result.shortMessage) {
    return result.shortMessage
  }
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(errorCode)
}

/**
 * execFile, but always resolves (never throws)
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
    withoutControllingTerminal,
    gitEnv,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  // Official `Je` (v285 @196477428): `L = be && O() !== "windows"` →
  // `...L && { detached: !0 }` — the child is spawned in its own session with
  // no controlling terminal, so ssh cannot open /dev/tty and passphrase /
  // new-host prompts fail fast instead of seizing the REPL's terminal.
  const detachFromTerminal =
    withoutControllingTerminal === true && getPlatform() !== 'windows'
  // Official git-spawn wrapper `WNt`/`jKs`→`air` (BIN309 @23003239/@22986874):
  // when `gitEnv` is opted into, `finalEnv` is the minimal override layer and
  // the real child env is assembled by the hardened merge-builder (scrubs
  // inherited GIT_* redirect/config vars; default-injects
  // GIT_NO_REPLACE_OBJECTS=1 per 2.1.309 item 10). Generic exec is untouched
  // when `gitEnv` is absent.
  const resolvedEnv =
    gitEnv === undefined
      ? finalEnv
      : buildMergedGitEnv(
          finalEnv ?? {},
          typeof gitEnv === 'object' ? gitEnv : {},
        )
  // Official 2.1.309 item 42 guard (BIN309 @240891566):
  //   if (T !== null && JNe(A, T.env)) return { stdout:"", stderr:Lvn, code:127, error:Lvn }
  // `isGitMissingOnMacos` is a faithful FALSE STUB (official linux-x64 `JNe`
  // @240801245), so this git-spawn-path branch EXISTS but is unreachable — no
  // darwin detection logic is invented. See git/macosGitMissing.ts.
  if (gitEnv !== undefined && isGitMissingOnMacos(file, resolvedEnv)) {
    return Promise.resolve({
      stdout: '',
      stderr: GIT_MISSING_MACOS_MESSAGE,
      code: GIT_MISSING_MACOS_EXIT_CODE,
      error: GIT_MISSING_MACOS_MESSAGE,
    })
  }
  return new Promise(resolve => {
    // Use execa for cross-platform .bat/.cmd compatibility on Windows
    const subprocess = execa(file, args, {
      maxBuffer,
      // execa v9 renamed the AbortSignal option `signal` → `cancelSignal`
      // (passing `signal` throws a TypeError synchronously, which rejected
      // this "never throws" wrapper for every caller passing an abortSignal).
      // cancelSignal SIGTERMs the child as soon as the signal aborts — the
      // kill-on-abort path used by PDF renders (2.1.281 #032), update checks,
      // and the file-index git scans.
      cancelSignal: abortSignal,
      timeout: finalTimeout,
      cwd: finalCwd,
      env: resolvedEnv,
      shell,
      stdin: finalStdin,
      input: finalInput,
      ...(detachFromTerminal ? { detached: true } : {}),
      reject: false, // Don't throw on non-zero exit codes
    })
    // Official `Je`: `h = L ? f.pid : void 0`, and in the finally block
    // `if (h !== void 0 && (g === void 0 || g.exitCode === void 0)) Oe(h)` —
    // `Oe` @196474487: `if (pid > 1) { try { process.kill(-pid, 'SIGTERM') } catch {} }`.
    // A detached child that ended without a normal exit code (timeout/kill)
    // gets its whole process group SIGTERMed so no orphaned ssh survives.
    const detachedPid = detachFromTerminal ? subprocess.pid : undefined
    const killDetachedGroup = (exitCode: number | undefined) => {
      if (detachedPid !== undefined && detachedPid > 1 && exitCode === undefined) {
        try {
          process.kill(-detachedPid, 'SIGTERM')
        } catch {
          // The group is already gone — same best-effort semantics as official Oe.
        }
      }
    }
    subprocess
      .then(result => {
        killDetachedGroup(result.exitCode)
        if (result.failed) {
          if (finalPreserveOutput) {
            const errorCode = result.exitCode ?? 1
            void resolve({
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              code: errorCode,
              error: getErrorMessage(
                result as unknown as ExecaResultWithError,
                errorCode,
              ),
            })
          } else {
            void resolve({ stdout: '', stderr: '', code: result.exitCode ?? 1 })
          }
        } else {
          void resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            code: 0,
          })
        }
      })
      .catch((error: ExecaError) => {
        // Official `Je` finally: `g === void 0` (no result at all) → group kill.
        killDetachedGroup(undefined)
        logError(error)
        void resolve({ stdout: '', stderr: '', code: 1 })
      })
  })
}
