/**
 * PID-namespace isolation for sandboxed subprocesses on Linux.
 *
 * Mirrors the official 2.1.200 binary's `unshare` / `CLONE_NEWPID` sandbox
 * hardening: when a Bash command runs in sandbox mode on Linux, the command
 * is executed inside a new PID namespace so it cannot see (or signal)
 * processes outside its namespace. This limits the blast radius of a
 * sandbox-escape attempt that tries to `kill` or `ps` a sibling process.
 *
 * Implementation: wrap the assembled command string with
 *   unshare --user --pid --fork --map-root-user -- <shell> -c '<cmd>'
 *
 * `--user --map-root-user` is required so an *unprivileged* user can create a
 * PID namespace (creating a PID namespace normally needs CAP_SYS_ADMIN; a user
 * namespace grants that capability inside the new namespace). The user is
 * mapped to root *inside the namespace only* — file access is still governed
 * by the real filesystem permissions on the host, so the sandbox tmpdir the
 * user owns remains accessible.
 *
 * `--pid --fork` creates the new PID namespace and forks so the child becomes
 * PID 1 in the new namespace (a PID namespace's init). `--fork` is mandatory:
 * without it, unshare only affects the calling process's *children*, and a
 * single-process `bash -c` would not be re-parented correctly.
 *
 * Availability is checked up front (Linux + the `unshare` binary on PATH).
 * When unavailable, `wrapWithPidNamespace` is a no-op so sandboxing degrades
 * gracefully — the command still runs, just without PID isolation.
 */

import { execFileSync } from 'child_process'
import { getPlatform } from '../platform.js'
import { quote } from '../bash/shellQuote.js'

/** Env var to force-disable PID-namespace isolation (kill switch / debug). */
export const PID_NAMESPACE_DISABLE_ENV = 'CLAUDE_CODE_DISABLE_PID_NAMESPACE'

let _availabilityCache: boolean | undefined

/**
 * Is PID-namespace isolation available on this host?
 *
 * True only when:
 *   - the platform is Linux, AND
 *   - the `unshare` binary is present on PATH, AND
 *   - the kernel advertises PID namespace support via /proc/self/ns/pid, AND
 *   - CLAUDE_CODE_DISABLE_PID_NAMESPACE is not set.
 *
 * Cached after the first probe — the answer doesn't change within a session.
 */
export function isPidNamespaceAvailable(): boolean {
  if (_availabilityCache !== undefined) return _availabilityCache
  _availabilityCache = computePidNamespaceAvailable()
  return _availabilityCache
}

function computePidNamespaceAvailable(): boolean {
  if (getPlatform() !== 'linux') return false
  if (process.env[PID_NAMESPACE_DISABLE_ENV]) return false
  // Quick path: /proc/self/ns/pid exists on any Linux with PID namespace
  // support (which is every modern kernel). If it's missing, the kernel
  // was built without CONFIG_PID_NS — bail.
  try {
    execFileSync('test', ['-e', '/proc/self/ns/pid'], { stdio: 'ignore' })
  } catch {
    return false
  }
  // Confirm the `unshare` binary is on PATH.
  try {
    execFileSync('command', ['-v', 'unshare'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: 'bash',
    })
  } catch {
    // `command -v` may not be available in non-bash shells; fall back to
    // `which` (bsdmainutils) and a direct `unshare --help` probe.
    try {
      execFileSync('unshare', ['--help'], { stdio: 'ignore' })
    } catch {
      return false
    }
  }
  return true
}

/**
 * Wrap a command string so it executes inside a new PID namespace.
 *
 * Returns the wrapped string when PID-namespace isolation is available, or the
 * original command string unchanged when it isn't (graceful degradation).
 *
 * @param shellPath  the shell executable (e.g. /bin/bash)
 * @param commandString  the fully-assembled command string (the `-c` body)
 * @returns a command string suitable for `spawn(unshare, ['-c', ...])`-style
 *          invocation — actually returned as the new `-c` body for the outer
 *          shell so the existing spawn(shellPath, getSpawnArgs) path is reused.
 */
export function wrapWithPidNamespace(
  shellPath: string,
  commandString: string,
): string {
  if (!isPidNamespaceAvailable()) return commandString
  // unshare flags:
  //   --user            create a new user namespace (grants CAP_SYS_ADMIN in it)
  //   --map-root-user   map the calling user to root inside the user namespace
  //   --pid             create a new PID namespace
  //   --fork            fork before running the command (child is PID 1)
  //   --                end of unshare options; following is the command to run
  //
  // We re-invoke the SAME shell with -c so the assembled commandString (which
  // already contains snapshot sourcing, eval, pwd tracking) runs verbatim
  // inside the new namespace.
  const innerShell = quote([shellPath])
  const innerCmd = quote([commandString])
  return `unshare --user --map-root-user --pid --fork -- ${innerShell} -c ${innerCmd}`
}

/**
 * Reset the availability cache. Exposed for tests that mock the platform or
 * PATH between cases.
 */
export function _resetPidNamespaceCache(): void {
  _availabilityCache = undefined
}
