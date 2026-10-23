import { tmpdir } from 'os'
import { join } from 'path'
import { join as posixJoin } from 'path/posix'
import { getSessionEnvironmentMap } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * PowerShell invocation flags + command. Shared by the provider's getSpawnArgs
 * and the hook spawn path in hooks.ts so the flag set stays in one place.
 */
export function buildPowerShellArgs(cmd: string): string[] {
  // 2.1.143: -ExecutionPolicy Bypass matches the official 2.1.200 binary's
  // flag set: ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
  // "-EncodedCommand",n]. Lets user scripts that call restricted cmdlets
  // (e.g. Set-ExecutionPolicy-dependent profiles) run without policy blocks.
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]
}

/**
 * Base64-encode a string as UTF-16LE for PowerShell's -EncodedCommand.
 * Same encoding the parser uses (parser.ts toUtf16LeBase64). The output
 * is [A-Za-z0-9+/=] only — survives ANY shell-quoting layer, including
 * @anthropic-ai/sandbox-runtime's shellquote.quote() which would otherwise
 * corrupt !$? to \!$? when re-wrapping a single-quoted string in double
 * quotes. Review 2964609818.
 */
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

/**
 * CC 2.1.309 #32: exit-code-2 propagation wrapper for the PowerShell HOOK
 * spawn path. `pwsh -Command "<native exe>"` does not reliably surface the
 * inner program's exit code, so a blocking hook whose program exits 2 failed
 * open on Windows. The official 309 appends this wrapper at hook spawn time
 * (BIN309:126298081 & 252638083; ZERO hits in BIN308 — new in 2.1.309):
 *
 *   let vs=n==="PermissionRequest"||IWe(to)?to:to+`
 *   ; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }`
 *
 * Byte-verbatim, including the LEADING REAL NEWLINE in the template literal.
 *
 * Structural note (deviation): the official applies the wrapper inline in the
 * hook spawner; OCC applies it via buildHookPowerShellCommand() below, called
 * from the hooks.ts PS spawn branch. It must NOT live inside
 * buildPowerShellArgs() — that helper is shared with the provider path
 * (buildExecCommand), which has its own $LASTEXITCODE capture + `exit $_ec`
 * and would be corrupted by a second wrapper.
 */
export const POWERSHELL_HOOK_EXIT_WRAPPER =
  '\n; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }'

/**
 * Port of the official `IWe` predicate (BIN309 @249832507, full source
 * extracted). True when the command starts (after leading whitespace, `;`,
 * `#` line comments and `<#...#>` block comments) with a PowerShell
 * DECLARATION that the exit wrapper must not be appended after:
 * `using namespace|module|assembly`, `param(`, a named block
 * (`begin|process|end|clean|dynamicparam {`), or a leading `[Attribute`
 * that is NOT a `[Type]::` static-method call.
 *
 * Official symbol → OCC name: `IWe` → startsWithPowerShellDeclaration.
 */
export function startsWithPowerShellDeclaration(command: string): boolean {
  let i = 0
  for (;;) {
    while (i < command.length && /[\s;]/.test(command[i]!)) {
      i++
    }
    if (command[i] === '#') {
      while (i < command.length && command[i] !== '\n') {
        i++
      }
      continue
    }
    if (command.startsWith('<#', i)) {
      const end = command.indexOf('#>', i + 2)
      i = end === -1 ? command.length : end + 2
      continue
    }
    break
  }
  const rest = command.slice(i)
  return (
    /^using\s+(namespace|module|assembly)\b/i.test(rest) ||
    /^param\s*\(/i.test(rest) ||
    /^(begin|process|end|clean|dynamicparam)\s*\{/i.test(rest) ||
    (/^\[\w/.test(rest) && !/^\[[\w.]+\]::/.test(rest))
  )
}

/**
 * CC 2.1.309 #32: build the `-Command` payload for a PowerShell HOOK spawn.
 * Mirrors the official ternary exactly:
 *   hookEvent === "PermissionRequest" || IWe(command) ? command : command + wrapper
 * (BIN309 hook spawn @~252637500; `n` = hookEvent, `to` = finalCommand.)
 */
export function buildHookPowerShellCommand(
  hookEvent: string,
  command: string,
): string {
  if (
    hookEvent === 'PermissionRequest' ||
    startsWithPowerShellDeclaration(command)
  ) {
    return command
  }
  return command + POWERSHELL_HOOK_EXIT_WRAPPER
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  let currentSandboxTmpDir: string | undefined

  return {
    type: 'powershell' as ShellProvider['type'],
    shellPath,
    detached: false,

    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      // Stash sandboxTmpDir for getEnvironmentOverrides (mirrors bashProvider)
      currentSandboxTmpDir = opts.useSandbox ? opts.sandboxTmpDir : undefined

      // When sandboxed, tmpdir() is not writable — the sandbox only allows
      // writes to sandboxTmpDir. Put the cwd tracking file there so the
      // inner pwsh can actually write it. Only applies on Linux/macOS/WSL2;
      // on Windows native, sandbox is never enabled so this branch is dead.
      const cwdFilePath =
        opts.useSandbox && opts.sandboxTmpDir
          ? posixJoin(opts.sandboxTmpDir, `claude-pwd-ps-${opts.id}`)
          : join(tmpdir(), `claude-pwd-ps-${opts.id}`)
      const escapedCwdFilePath = cwdFilePath.replace(/'/g, "''")
      // Exit-code capture: prefer $LASTEXITCODE when a native exe ran.
      // On PS 5.1, a native command that writes to stderr while the stream
      // is PS-redirected (e.g. `git push 2>&1`) sets $? = $false even when
      // the exe returned exit 0 — so `if (!$?)` reports a false positive.
      // $LASTEXITCODE is $null only when no native exe has run in the
      // session; in that case fall back to $? for cmdlet-only pipelines.
      // Tradeoff: `native-ok; cmdlet-fail` now returns 0 (was 1). Reverse
      // is also true: `native-fail; cmdlet-ok` now returns the native
      // exit code (was 0 — old logic only looked at $? which the trailing
      // cmdlet set true). Both rarer than the git/npm/curl stderr case.
      const cwdTracking = `\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n; (Get-Location).Path | Out-File -FilePath '${escapedCwdFilePath}' -Encoding utf8 -NoNewline\n; exit $_ec`
      const psCommand = command + cwdTracking

      // Sandbox wraps the returned commandString as `<binShell> -c '<cmd>'` —
      // hardcoded `-c`, no way to inject -NoProfile -NonInteractive. So for
      // the sandbox path, build a command that itself invokes pwsh with the
      // full flag set. Shell.ts passes /bin/sh as the sandbox binShell,
      // producing: bwrap ... sh -c 'pwsh -NoProfile ... -EncodedCommand ...'.
      // The non-sandbox path returns the bare PS command; getSpawnArgs() adds
      // the flags via buildPowerShellArgs().
      //
      // -EncodedCommand (base64 UTF-16LE), not -Command: the sandbox runtime
      // applies its OWN shellquote.quote() on top of whatever we build. Any
      // string containing ' triggers double-quote mode which escapes ! as \! —
      // POSIX sh preserves that literally, pwsh parse error. Base64 is
      // [A-Za-z0-9+/=] — no chars that any quoting layer can corrupt.
      // Review 2964609818.
      //
      // shellPath is POSIX-single-quoted so a space-containing install path
      // (e.g. /opt/my tools/pwsh) survives the inner `/bin/sh -c` word-split.
      // Flags and base64 are [A-Za-z0-9+/=-] only — no quoting needed.
      const commandString = opts.useSandbox
        ? [
            `'${shellPath.replace(/'/g, `'\\''`)}'`,
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encodePowerShellCommand(psCommand),
          ].join(' ')
        : psCommand

      return { commandString, cwdFilePath }
    },

    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    async getEnvironmentOverrides(): Promise<Record<string, string>> {
      const env: Record<string, string> = {}
      // Apply session env vars set via /env (child processes only, not
      // the REPL). Without this, `/env PATH=...` affects Bash tool
      // commands but not PowerShell — so PyCharm users with a stripped
      // PATH can't self-rescue.
      // Ordering: session vars FIRST so the sandbox TMPDIR below can't be
      // overridden by `/env TMPDIR=...`. bashProvider.ts has these in the
      // opposite order (pre-existing), but sandbox isolation should win.
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      // CC 2.1.296 #036: PowerShell can't dot-source the bash-style session
      // environment script (CLAUDE_ENV_FILE + hook env files), so the
      // official parses its plain assignments into a Map and injects them
      // into the pwsh child env. ALL-OR-NOTHING: if any line isn't a plain
      // assignment the Map is empty and nothing is applied. Merged AFTER
      // /env vars for bash parity (the sourced script wins there too), and
      // BEFORE the sandbox TMPDIR block so sandbox isolation still wins.
      for (const [key, value] of await getSessionEnvironmentMap()) {
        env[key] = value
      }
      if (currentSandboxTmpDir) {
        // PowerShell on Linux/macOS honors TMPDIR for [System.IO.Path]::GetTempPath()
        env.TMPDIR = currentSandboxTmpDir
        env.CLAUDE_CODE_TMPDIR = currentSandboxTmpDir
      }
      return env
    },
  }
}
