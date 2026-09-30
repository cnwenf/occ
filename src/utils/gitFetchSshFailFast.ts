import { constants as fsConstants } from 'node:fs'
import { open as fsOpen } from 'node:fs/promises'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'
import { getPlatform } from './platform.js'
import { readEnv, resolveSshCommand } from './plugins/gitSshCommand.js'

/**
 * 2.1.285 upstream port (changelog item 3): "SSH passphrase and new-host
 * prompts from worktree and /teleport fetches" — the fetches now stop quickly
 * instead of seizing the terminal.
 *
 * Official v285 mechanism (byte-verified, linux ELF):
 *   - `D0` @204089380 — async spawn-options helper used by every worktree
 *     fetch (3 sites in the worktree-create fn `aPe` @204105560/204106341/
 *     204106522) and the --teleport fetch (`rJo` @206111563):
 *       var L9n=5000;async function D0(e){let n=Kvo(Zjt(),e),
 *         r=await Azo(n,...),s=r.SSH_ASKPASS_REQUIRE?.trim();
 *         return{env:Boolean(s)||O()==="windows"||!await Xen()?r:
 *           {...r,SSH_ASKPASS_REQUIRE:"never",SSH_ASKPASS:"false"},
 *           withoutControllingTerminal:!0}}
 *   - `Xen` @204088534 — controlling-terminal probe: open("/dev/tty",
 *     O_RDWR|O_NOCTTY), close, true; any error → false.
 *   - `Azo` @196470770 — Windows-only: resolve GIT_SSH_COMMAND /
 *     core.sshCommand into the env via `X_n` (resolveSshCommand) with
 *     strictHostKeys:false. Identity on POSIX (`if(O()!=="windows")return e`).
 *   - `Je` @196477428 consumes `withoutControllingTerminal` —
 *     `L=be&&O()!=="windows"` → `...L&&{detached:!0}` on the spawn plus a
 *     `Oe(pid)` group SIGTERM (`if(pid>1)process.kill(-pid,"SIGTERM")`
 *     @196474487) when the child ends without a normal exit code. That is
 *     implemented in execFileNoThrow.ts (OCC's `Je` equivalent).
 *
 * v284 spawned the same fetches with `env:ijn(TXe(),dir)` (plain env pins,
 * no SSH_ASKPASS hardening, no terminal detach) — an ssh passphrase or
 * unknown-host-key prompt could grab /dev/tty and hang the fetch.
 *
 * Net effect of the port: on POSIX, unless the user set their own
 * SSH_ASKPASS_REQUIRE and unless no controlling terminal exists, the fetch
 * child gets SSH_ASKPASS_REQUIRE=never + SSH_ASKPASS=false (ssh cannot launch
 * an askpass helper) and is spawned detached from the controlling terminal
 * (ssh cannot open /dev/tty), so prompts fail fast instead of seizing the REPL.
 *
 * Pre-existing OCC simplifications kept (they predate the v284→v285 delta and
 * are unchanged by it): the base env is the call site's no-prompt env rather
 * than the official `Zjt()` chain (full `e4` pins + credential.interactive
 * GIT_CONFIG parameter), and the `Kvo` GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR
 * layout pins are unnecessary because OCC spawns with `cwd` inside the repo.
 */

/** Official `L9n` = 5000 — timeout of the D0/Azo git config read. */
const CONFIG_READ_TIMEOUT_MS = 5000

/**
 * Official `yn` — hook-neutralizing pins prefixed to every D0 config read:
 * `["-c","core.hooksPath=/dev/null","-c","core.fsmonitor="]`.
 */
const HOOK_NEUTRALIZING_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
] as const

/**
 * Official `Xen` @204088534: returns true when this process has a usable
 * controlling terminal — `open("/dev/tty", O_RDWR|O_NOCTTY)` succeeds and the
 * handle closes; any error (ENXIO/ENOENT/EPERM, non-POSIX) → false.
 */
export async function canOpenControllingTerminal(): Promise<boolean> {
  try {
    const handle = await fsOpen(
      '/dev/tty',
      fsConstants.O_RDWR | fsConstants.O_NOCTTY,
    )
    await handle.close()
    return true
  } catch {
    return false
  }
}

export interface FetchSshFailFastSpawn {
  /** Env for the git fetch spawn (official `D0(...).env`). */
  env: NodeJS.ProcessEnv
  /**
   * Official `D0(...).withoutControllingTerminal` — always true. On POSIX the
   * spawn runs detached so ssh cannot prompt on /dev/tty (see the `Je` port in
   * execFileNoThrow.ts); ignored on Windows.
   */
  withoutControllingTerminal: boolean
}

/**
 * Official `Azo` @196470770: on Windows only, resolve the user's ssh program
 * (GIT_SSH_COMMAND env, else `git config --null --get core.sshCommand`) into
 * the env with BatchMode options (strictHostKeys:false). Identity on POSIX.
 *
 * The official parses the config stdout with a minified `ot(stdout,"\0")`
 * helper that could not be uniquely resolved in the binary; `--get` emits a
 * single NUL-terminated value, so the first split segment is that value.
 */
async function resolveWindowsSshEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  if (getPlatform() !== 'windows') return env
  const fromEnv = readEnv(env, 'GIT_SSH_COMMAND')
  if (fromEnv !== undefined) {
    return fromEnv.trim() === ''
      ? env
      : resolveSshCommand(env, undefined, { strictHostKeys: false }).env
  }
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [...HOOK_NEUTRALIZING_ARGS, 'config', '--null', '--get', 'core.sshCommand'],
    { cwd, env, stdin: 'ignore', timeout: CONFIG_READ_TIMEOUT_MS },
  )
  const value =
    result.code === 0 && result.stdout.includes('\0')
      ? result.stdout.split('\0')[0]
      : undefined
  if (value?.trim() === '') return env
  return resolveSshCommand(env, value, { strictHostKeys: false }).env
}

/**
 * Official `D0` @204089380: build the spawn options for a worktree/teleport
 * git fetch so SSH passphrase / new-host prompts fail fast.
 *
 * `baseEnv` is the call site's env (OCC equivalent of the official
 * `Kvo(Zjt(), cwd)` chain — see the module header). `probe` is injectable for
 * tests; the default is the official `Xen` /dev/tty probe.
 */
export async function resolveFetchSshFailFast(
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  probe: () => Promise<boolean> = canOpenControllingTerminal,
): Promise<FetchSshFailFastSpawn> {
  const env = await resolveWindowsSshEnv(baseEnv, cwd)
  const userAskpassRequire = env.SSH_ASKPASS_REQUIRE?.trim()
  const keepEnvUnpinned =
    Boolean(userAskpassRequire) ||
    getPlatform() === 'windows' ||
    !(await probe())
  return keepEnvUnpinned
    ? { env, withoutControllingTerminal: true }
    : {
        env: { ...env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: 'false' },
        withoutControllingTerminal: true,
      }
}
