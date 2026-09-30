/**
 * Git SSH-command resolution for plugin / marketplace git operations —
 * faithful port of the official Claude Code 2.1.285 SSH-resolution core
 * (@196469100-196472703 in the v285 linux binary), plus the git-config reader
 * `CM` (@203267240), the config-spawn `C4e` (@200969675), the `Ynn`
 * GIT_CONFIG_* preserver (@200978320) and the ssh-binary probe `Swn`
 * (@203268564).
 *
 * v284 -> v285 delta (byte evidence, `grep -aobF` hit counts in the >150M
 * code region): `core.sshCommand` 3 -> 6, `ssh.variant` 0 -> 4,
 * `could not read your git ssh settings` 0 -> 2, `SendEnv=GIT_PROTOCOL` 0 -> 1,
 * `GIT_CEILING_DIRECTORIES` 7 -> 8. v284 honored only the `GIT_SSH_COMMAND` /
 * `GIT_SSH` env vars next to a hardcoded
 * `-c core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes` pin
 * (exactly what OCC's marketplaceManager had). v285 adds a full resolver that
 * ALSO reads the user's `core.sshCommand` / `ssh.variant` from git config and
 * probes the ssh binary, then appends the correct batch options per variant
 * (ssh -> `-o BatchMode=yes -o StrictHostKeyChecking=yes`, plink -> `-batch`,
 * other -> none) and passes the resolved command to git via `GIT_SSH_COMMAND`.
 * Changelog item 2: "honor GIT_SSH / core.sshCommand for plugin/marketplace
 * installs" (keeping the GIT_TERMINAL_PROMPT=0 mitigations).
 *
 * SCOPE / STAGED. This module ports the SSH-command resolution + config read +
 * probe — the observable behavior behind changelog item 2. The wider v285
 * git-env hardening subsystem the official wraps AROUND it is intentionally
 * NOT ported here and stays STAGED as a dedicated effort (OCC has no unified
 * git-env builder surface; it touches every git call site, not just plugin
 * clones):
 *   - `zo`/`ze` base pins (GIT_ALLOW_PROTOCOL:"/", GIT_CONFIG_PARAMETERS alias
 *     neutralization, GIT_NO_LAZY_FETCH, GIT_NO_REPLACE_OBJECTS, ...)
 *   - `Nt`/`Rt`/`Ct` protocol.*.allow=never pins, `yn` core.hooksPath/fsmonitor
 *     pins, `R` GIT_LFS_SKIP_SMUDGE, `q_n` safe.bareRepository/protocol.file
 *   - `Zjt`/`e4`/`CN` credential.interactive=false + GCM_INTERACTIVE pins
 *   - `Pt`/`K_n`/`Ngt` GIT_* env scrub, `Q_n` GIT_CEILING_DIRECTORIES spawn cwd
 * A clean-env (`extendEnv:false`) `git config` read is likewise STAGED — OCC's
 * exec wrapper always extends process.env, so the config read here inherits the
 * user's own GIT_CONFIG_* (which `Ynn` preserves anyway); this only affects
 * which config values are visible, not the resolution logic.
 *
 * The pure resolution core below is byte-faithful and unit-tested; the config
 * reader's only I/O deviation from official is the inherited-process-env read
 * documented above.
 */

import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, isAbsolute, join, resolve } from 'path'
import { logForDebugging } from '../debug.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { getPlatform } from '../platform.js'
import { getTmpRootDir } from '../tmpDirBackstop.js'

// --- Constants (official verbatim) ---------------------------------------

/** Official `gt`: batch options appended for the `ssh` variant (strict host keys). */
const STRICT_HOST_OPTIONS = '-o BatchMode=yes -o StrictHostKeyChecking=yes'
/** Official `Et`: batch options for `ssh` when strictHostKeys is off. */
const BATCH_ONLY_OPTIONS = '-o BatchMode=yes'
/** Official `Ee`: batch flag for the `plink` variant. */
const PLINK_BATCH_FLAG = '-batch'
/** Official `_wn` (probe) and `v` (config read) — both 5000ms in the binary. */
const PROBE_TIMEOUT_MS = 5000
const CONFIG_READ_TIMEOUT_MS = 5000
/** Official `mwn(hwn(r,"claude-ssh-config-"))` temp-dir prefix. */
const SSH_CONFIG_TEMP_PREFIX = 'claude-ssh-config-'
/** Official `e4` no-prompt pins — OCC also applies these via GIT_NO_PROMPT_ENV at the call site. */
const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
} as const

type Env = NodeJS.ProcessEnv
type SshVariant = 'ssh' | 'plink' | 'other'

/** Official `O()` ≡ OCC `getPlatform()`. */
function isWindows(): boolean {
  return getPlatform() === 'windows'
}

// --- Pure resolution core (byte-faithful, no I/O) -------------------------

/** Official `k`: non-blank string, else undefined. */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * Official `XA`: read an env key; on Windows fall back to a case-insensitive
 * scan (Windows env vars are case-insensitive but Node preserves the given case).
 */
export function readEnv(env: Env, key: string): string | undefined {
  if (env[key] !== undefined || !isWindows()) return env[key]
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === key && value !== undefined) return value
  }
  return undefined
}

/**
 * Official `S`: build a deletion map — `{ key: undefined }` for every env key
 * whose (upperCased, original) pair satisfies `pred`. Spreading the result over
 * an env removes those keys (case-insensitively) under execa/Node.
 */
function deletionMap(
  env: Env,
  pred: (upperKey: string, originalKey: string) => boolean,
): Record<string, undefined> {
  const out: Record<string, undefined> = {}
  for (const key of Object.keys(env)) {
    if (pred(key.toUpperCase(), key)) out[key] = undefined
  }
  return out
}

/**
 * Official `Vr`: shell-quote an argv array into a single command string.
 * Safe chars pass through; the empty string becomes `''`; anything else is
 * single-quoted with `'` escaped as `'"'"'`.
 */
function shellQuote(args: string[]): string {
  return args
    .map(arg => {
      const value = String(arg)
      if (value === '') return "''"
      if (/^[A-Za-z0-9_./:=@+,-]+$/.test(value)) return value
      return `'${value.replaceAll("'", `'"'"'`)}'`
    })
    .join(' ')
}

/** Official `ht`: the first shell word of a command, unquoted. */
function firstWord(command: string): string {
  const match = command.trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

/** Official `Te`: basename of a command, lowercased, `.exe` stripped. */
function commandBasename(command: string): string {
  return basename(command.trim().replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '')
}

/**
 * Official `Tt`: quote/escape-aware splitter returning the basename of the
 * FIRST word of a command. Returns '' on an unclosed quote or a trailing
 * backslash. Windows splits on `[\\/]`, POSIX on `/`.
 */
function firstWordBasename(command: string): string {
  let word = ''
  let quote: string | undefined
  let inFirstWord = true
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    let literal: string | undefined
    if (quote === undefined && /[ \t\n\r]/.test(char)) {
      inFirstWord = false
    } else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char
    } else if (char === quote) {
      quote = undefined
    } else if (char === '\\' && quote !== "'") {
      i++
      if (i >= command.length) return ''
      literal = command[i]
    } else {
      literal = char
    }
    if (inFirstWord && literal !== undefined) word += literal
  }
  if (quote !== undefined) return ''
  const separator = isWindows() ? /[\\/]/ : /\//
  return word.split(separator).filter(part => part !== '').at(-1) ?? ''
}

/** Official `Ot`: true when `-batch` already appears after the first word. */
function hasBatchFlag(command: string): boolean {
  const first = command.trim().match(/^(?:"[^"]*"|'[^']*'|\S+)/)?.[0] ?? ''
  return /(?:^|\s)-batch(?:\s|$)/.test(command.trim().slice(first.length))
}

/**
 * Official `St`: resolve the ssh variant. An explicit non-`auto`
 * `GIT_SSH_VARIANT` maps plink->plink, putty/tortoiseplink/simple->other,
 * anything else->ssh. Otherwise infer from the command basename (ssh/plink
 * pass through, everything else is `other`).
 */
function resolveVariant(env: Env, named: string): SshVariant {
  const fromEnv = readEnv(env, 'GIT_SSH_VARIANT')
  if (fromEnv !== undefined && fromEnv !== 'auto') {
    return fromEnv === 'plink'
      ? 'plink'
      : ['putty', 'tortoiseplink', 'simple'].includes(fromEnv)
        ? 'other'
        : 'ssh'
  }
  const base = commandBasename(named)
  return base === 'ssh' || base === 'plink' ? base : 'other'
}

/** Official `mt`: variant + strictHostKeys -> the batch options to append. */
function batchOptionsFor(
  variant: SshVariant,
  strictHostKeys: boolean,
): string | undefined {
  switch (variant) {
    case 'ssh':
      return strictHostKeys ? STRICT_HOST_OPTIONS : BATCH_ONLY_OPTIONS
    case 'plink':
      return PLINK_BATCH_FLAG
    case 'other':
      return undefined
  }
}

/**
 * Official `eKr`: the variant to pin into `GIT_SSH_VARIANT` — an explicit
 * non-`auto` config variant wins; otherwise infer from the chosen command's
 * first-word basename (ssh/plink/tortoiseplink), else `auto`.
 */
function inferVariant(
  configVariant: string | undefined,
  chosen: string,
): string {
  if (configVariant !== undefined && configVariant !== 'auto') {
    return configVariant
  }
  const base = firstWordBasename(chosen).toLowerCase().replace(/\.exe$/, '')
  return ['ssh', 'plink', 'tortoiseplink'].includes(base) ? base : 'auto'
}

/**
 * Official `D`: resolution order for the ssh command —
 * `GIT_SSH_COMMAND` env → config `core.sshCommand` → `GIT_SSH` env (shell-quoted)
 * → plain `ssh`. `named` is the first word of the chosen command (or the raw
 * `GIT_SSH` when that won).
 */
function resolveChosenAndNamed(
  env: Env,
  configCommand: string | undefined,
): { chosen: string; named: string | undefined } {
  const command =
    nonBlank(readEnv(env, 'GIT_SSH_COMMAND')) ?? nonBlank(configCommand)
  const gitSsh = nonBlank(readEnv(env, 'GIT_SSH'))
  return {
    chosen: command ?? shellQuote([gitSsh ?? 'ssh']),
    named: command !== undefined ? firstWord(command) : gitSsh,
  }
}

/** Official `me`: env with GIT_SSH/GIT_SSH_COMMAND removed and GIT_SSH_COMMAND set. */
function withSshCommand(env: Env, command: string): Env {
  return {
    ...env,
    ...deletionMap(
      env,
      key => key === 'GIT_SSH_COMMAND' || key === 'GIT_SSH',
    ),
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: command,
  }
}

/**
 * Official `X_n`: the main resolver. Appends the variant's batch options to the
 * chosen command (skipping when there are none, or when a `plink` command
 * already carries `-batch`), returning the final command + env.
 */
export function resolveSshCommand(
  env: Env,
  configCommand: string | undefined,
  { strictHostKeys = true }: { strictHostKeys?: boolean } = {},
): { command: string; env: Env } {
  const { chosen, named } = resolveChosenAndNamed(env, configCommand)
  const options = batchOptionsFor(
    named === undefined ? 'ssh' : resolveVariant(env, named),
    strictHostKeys,
  )
  if (
    options === undefined ||
    (options === PLINK_BATCH_FLAG && hasBatchFlag(chosen))
  ) {
    return { command: chosen, env }
  }
  const command = `${chosen} ${options}`
  return { command, env: withSshCommand(env, command) }
}

/**
 * Official `Tzo`: the probe candidate — the chosen command, but only when the
 * variant is undefined/auto AND the named command isn't already a known
 * ssh/plink/tortoiseplink (i.e. the variant is genuinely ambiguous).
 */
function probeCandidate(
  env: Env,
  configCommand: string | undefined,
): string | undefined {
  const variant = readEnv(env, 'GIT_SSH_VARIANT')
  const { chosen, named } = resolveChosenAndNamed(env, configCommand)
  return (variant === undefined || variant === 'auto') &&
    named !== undefined &&
    !['ssh', 'plink', 'tortoiseplink'].includes(commandBasename(named))
    ? chosen
    : undefined
}

/** Official `eWt`: wrap a command so it cds into `dir` first (CDPATH-neutralized). */
function cdWrapper(dir: string, command: string): string {
  const target = isWindows() ? dir.replace(/\\/g, '/') : dir
  return `CDPATH= cd -- ${shellQuote([target])} 2>/dev/null || cd / || exit 1; ${command}`
}

/** Official `tWt`: the home dir (fallback `resolve('/')`) used as the probe cwd. */
function safeHomeDir(): string {
  let home = ''
  try {
    home = homedir()
  } catch {
    // homedir() can throw when no home is derivable; fall back below.
  }
  return isAbsolute(home) ? home : resolve('/')
}

// --- Config reader + probe (I/O) ------------------------------------------

/**
 * Official `Ynn`: preserve GIT_CONFIG_GLOBAL/SYSTEM and the
 * GIT_CONFIG_COUNT/KEY_n/VALUE_n chain from the environment, so the config read
 * sees the same config sources the user's git would.
 */
function preserveGitConfigEnv(env: Env): { env: Env; count: string | undefined } {
  const preserved: Env = {}
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    const value = readEnv(env, key)
    if (value !== undefined) preserved[key] = value
  }
  const rawCount = readEnv(env, 'GIT_CONFIG_COUNT')
  const count = Number(rawCount)
  if (rawCount === undefined || !Number.isInteger(count) || count <= 0) {
    return { env: preserved, count: undefined }
  }
  preserved.GIT_CONFIG_COUNT = rawCount
  for (let i = 0; i < count; i++) {
    const key = readEnv(env, `GIT_CONFIG_KEY_${i}`)
    if (key === undefined) break
    preserved[`GIT_CONFIG_KEY_${i}`] = key
    const value = readEnv(env, `GIT_CONFIG_VALUE_${i}`)
    if (value !== undefined) preserved[`GIT_CONFIG_VALUE_${i}`] = value
  }
  return { env: preserved, count: rawCount }
}

/**
 * Official `C4e`: run `git config --includes --null --show-scope --get-regexp`
 * in `cwd` and return `[key, value]` pairs from the system/global/command
 * scopes. Returns `[]` when git exits 1/129 without a timeout (no match / usage),
 * and `null` on any other failure (the caller logs and falls back).
 *
 * `timedOut`/`maxBufferExceeded` are folded into OCC's `error.includes('timed
 * out')` — the exec wrapper does not surface them separately. A maxBuffer
 * overflow on a two-key `--get-regexp` read is not reachable in practice.
 */
async function readGitSshConfigEntries(
  cwd: string,
  pattern: string,
  envPins: Env,
): Promise<Array<[string, string]> | null> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--includes', '--null', '--show-scope', '--get-regexp', pattern],
    {
      cwd,
      env: envPins,
      timeout: CONFIG_READ_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
    },
  )
  if (result.code !== 0) {
    const timedOut = result.error?.includes('timed out') ?? false
    return (result.code === 1 || result.code === 129) && !timedOut ? [] : null
  }
  const parts = result.stdout.split('\0')
  const entries: Array<[string, string]> = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] as string
    const keyValue = parts[i + 1] ?? ''
    const newline = keyValue.indexOf('\n')
    if (
      (scope === 'system' || scope === 'global' || scope === 'command') &&
      newline !== -1
    ) {
      entries.push([keyValue.slice(0, newline), keyValue.slice(newline + 1)])
    }
  }
  return entries
}

/** Official `kwn`: SIGKILL a detached process group (best-effort). */
function killProcessGroup(pid: number | undefined): void {
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGKILL')
  } catch {
    // The group may already be gone; the probe treats any failure as "not ssh".
  }
}

/**
 * Official `Swn`: probe whether a candidate command is a real OpenSSH client by
 * running `<command> -G -o SendEnv=GIT_PROTOCOL example.invalid` (wrapped to cd
 * into a safe dir first). Exit 0 within 5s ⇒ ssh. The child is detached so the
 * timeout can SIGKILL the whole process group.
 */
function probeSshBinary(
  command: string,
  env: Env,
  cwd: string,
): Promise<boolean> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'sh',
        [
          '-c',
          `${command} "$@"`,
          command,
          '-G',
          '-o',
          'SendEnv=GIT_PROTOCOL',
          'example.invalid',
        ],
        { cwd, env, stdio: 'ignore', detached: true, windowsHide: true },
      )
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => killProcessGroup(child.pid), PROBE_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** Official error-log message 1 (no private temp dir under the tmp root). */
const NO_TEMP_DIR_MESSAGE = (root: string): string =>
  `[plugins] could not read your git ssh settings: no private temporary directory could be made under ${root} (the path must not contain '${delimiter}'). Plugin and marketplace clones ignore your core.sshCommand and ssh.variant and use GIT_SSH_COMMAND, GIT_SSH or plain ssh. Set CLAUDE_CODE_TMPDIR to a usable directory to fix this.`

/** Official error-log message 2 (git config failed or timed out). */
const CONFIG_READ_FAILED_MESSAGE =
  '[plugins] could not read your git ssh settings (git config failed or timed out). Plugin and marketplace clones ignore your core.sshCommand and ssh.variant and use GIT_SSH_COMMAND, GIT_SSH or plain ssh.'

/**
 * Official `CM`: read the user's `core.sshCommand` / `ssh.variant` for a plugin
 * or marketplace git URL. `file://` URLs skip the read (no ssh). The config
 * `core.sshCommand` is used only when `GIT_SSH_COMMAND` env is absent/blank;
 * `ssh.variant` only when `GIT_SSH_VARIANT` env is absent. On non-Windows, when
 * the variant is ambiguous, the chosen command is probed (`ssh -G`): success
 * pins the variant to `ssh`. Runs `git config` in a private temp dir under the
 * tmp root (GIT_CEILING_DIRECTORIES-pinned) and always removes it.
 */
async function readPluginGitSshConfig(
  url: string,
  baseEnv: Env = process.env,
): Promise<{ command?: string; variant?: string }> {
  if (url.startsWith('file://')) return {}
  const root = resolve(getTmpRootDir())
  const tempDir = root.includes(delimiter)
    ? undefined
    : await mkdtemp(join(root, SSH_CONFIG_TEMP_PREFIX)).catch(() => undefined)
  if (tempDir === undefined) {
    logForDebugging(NO_TEMP_DIR_MESSAGE(root), { level: 'error' })
    return {}
  }
  try {
    const entries = await readGitSshConfigEntries(
      tempDir,
      '^(core\\.sshcommand|ssh\\.variant)$',
      { ...preserveGitConfigEnv(baseEnv).env, GIT_CEILING_DIRECTORIES: root, ...NO_PROMPT_ENV },
    )
    if (entries === null) {
      logForDebugging(CONFIG_READ_FAILED_MESSAGE, { level: 'error' })
      return {}
    }
    const lastValue = (key: string): string | undefined =>
      entries.findLast(([name]) => name === key)?.[1]
    const sshCommandEnv = readEnv(baseEnv, 'GIT_SSH_COMMAND')
    const command =
      sshCommandEnv !== undefined && sshCommandEnv.trim() !== ''
        ? undefined
        : lastValue('core.sshcommand')
    const variant =
      readEnv(baseEnv, 'GIT_SSH_VARIANT') === undefined
        ? lastValue('ssh.variant')
        : undefined
    const candidate =
      isWindows() || (variant !== undefined && variant !== 'auto')
        ? undefined
        : probeCandidate(baseEnv, command)
    const resolvedVariant =
      candidate !== undefined &&
      (await probeSshBinary(cdWrapper(safeHomeDir(), candidate), baseEnv, tempDir))
        ? 'ssh'
        : variant
    return {
      ...(command !== undefined && { command }),
      ...(resolvedVariant !== undefined && { variant: resolvedVariant }),
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

// --- Exported composition -------------------------------------------------

/**
 * Official composition `yt(env, CM(url))` scoped to the SSH command: read the
 * user's config, pin `GIT_SSH_VARIANT` when it is undefined/auto (official `yt`
 * `i` branch), then resolve the final `GIT_SSH_COMMAND`. Returns the resolved
 * command and an env carrying it (with GIT_SSH/GIT_SSH_COMMAND case-variants
 * removed). Callers merge this env with their own no-prompt pins.
 *
 * When the user has no custom ssh config this yields exactly OCC's previous
 * hardcoded pin (`ssh -o BatchMode=yes -o StrictHostKeyChecking=yes`), so the
 * fail-closed SSH default is preserved.
 */
export async function resolvePluginGitSshEnv(
  url: string,
  baseEnv: Env = process.env,
): Promise<{ command: string; env: Env }> {
  const config = await readPluginGitSshConfig(url)
  const variantFromEnv = readEnv(baseEnv, 'GIT_SSH_VARIANT')
  const env =
    variantFromEnv === undefined || variantFromEnv === 'auto'
      ? {
          ...baseEnv,
          ...deletionMap(baseEnv, key => key === 'GIT_SSH_VARIANT'),
          GIT_SSH_VARIANT: inferVariant(
            config.variant,
            resolveChosenAndNamed(baseEnv, config.command).chosen,
          ),
        }
      : baseEnv
  return resolveSshCommand(env, config.command, { strictHostKeys: true })
}

// Pure helpers re-exported for unit tests (byte-faithful to the official core).
export const __test = {
  nonBlank,
  readEnv,
  deletionMap,
  shellQuote,
  firstWord,
  commandBasename,
  firstWordBasename,
  hasBatchFlag,
  resolveVariant,
  batchOptionsFor,
  inferVariant,
  resolveChosenAndNamed,
  withSshCommand,
  resolveSshCommand,
  probeCandidate,
  cdWrapper,
  safeHomeDir,
  STRICT_HOST_OPTIONS,
  BATCH_ONLY_OPTIONS,
  PLINK_BATCH_FLAG,
}
