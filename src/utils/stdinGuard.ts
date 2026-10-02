import { fstat } from 'fs/promises'

import { CLI_BINARY_NAME } from '../constants/cli.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { writeToStderr as writeStderrText } from './process.js'

/**
 * claude-code 2.1.287 (#21) — piped/redirected stdin startup guard.
 *
 * Changelog: "Fixed interactive claude hanging or crashing with 'Raw mode is
 * not supported' when its input is piped or redirected; it now says why and
 * exits (use -p for piped input)".
 *
 * Official v287 @ ~215311316, recovered verbatim (minified names in comments):
 *
 *   var lr="Claude Code can't read the keyboard here: stdin is not a terminal
 *     (it is piped, redirected, or supplied by the program that launched claude)",
 *   ns={windows:{lines:[`${lr}, and on Windows it can't fall back to the console
 *       for input yet.`,"Run claude directly in Windows Terminal, PowerShell, or
 *       Command Prompt, without piping or redirecting its input."],reader:"type"},
 *     ci:{lines:[`${lr}, and the CI environment variable is set, so it doesn't
 *       fall back to the terminal for input.`,"Unset the CI environment variable
 *       to work interactively."],reader:"cat"},
 *     tty_unavailable:{lines:[`${lr}, and the terminal device (/dev/tty) couldn't
 *       be opened to read the keyboard instead.`,"Start claude directly from a
 *       terminal."],reader:"cat"}};
 *   function uro(e){return ns[e].lines.join("\n")}
 *   async function rs(e){let{lines:o,reader:n}=ns[e];
 *     return jS([...o,Vl(n)].join("\n")),await sar(e),Vs()}
 *   function Vl(e){return`To send text as a prompt and print the reply instead,
 *     add -p; it also works with --continue and --resume <session-id>
 *     (for example: ${e} notes.md | claude -p --continue).`}
 *   async function Xl(){let e=await new Promise((o)=>{Yl(0,(n,r)=>o(n?void 0:r))});
 *     if(e===void 0)return"unknown";if(e.isFIFO())return"pipe";
 *     if(e.isFile())return"file";if(e.isSocket())return"socket";
 *     if(e.isCharacterDevice())return"character_device";return"other"}
 *
 * (`jS` = print to stderr, `sar` = telemetry/exit flush, `Vs` = exit,
 * `Yl` = fs.stat on fd 0.)
 *
 * Product-name convention (docs/occ29-claude-command-name-audit.md): the
 * brand "Claude Code" is kept byte-verbatim, while every lowercase `claude`
 * COMMAND name is routed through `CLI_BINARY_NAME` — the same convention the
 * rest of OCC's user-facing text uses. No other wording is changed.
 */

/** The three cases the official `ns` table names. */
export const STDIN_GUARD_CASES = ['windows', 'ci', 'tty_unavailable'] as const

export type StdinGuardCase = (typeof STDIN_GUARD_CASES)[number]

/** Command that reads a file to stdout on the case's platform (`ns[e].reader`). */
export type StdinGuardReaderCommand = 'type' | 'cat'

/** fd-0 file-type classification (official `Xl` result set). */
export type StdinFdKind =
  | 'pipe'
  | 'file'
  | 'socket'
  | 'character_device'
  | 'other'
  | 'unknown'

export interface StdinGuardMessage {
  readonly lines: readonly string[]
  readonly reader: StdinGuardReaderCommand
}

/** Official `lr` — the shared base sentence. */
const STDIN_NOT_A_TERMINAL_BASE = `Claude Code can't read the keyboard here: stdin is not a terminal (it is piped, redirected, or supplied by the program that launched ${CLI_BINARY_NAME})`

/** Official `ns` — per-case lines + reader command. */
const STDIN_GUARD_MESSAGES: Record<StdinGuardCase, StdinGuardMessage> = {
  windows: {
    lines: [
      `${STDIN_NOT_A_TERMINAL_BASE}, and on Windows it can't fall back to the console for input yet.`,
      `Run ${CLI_BINARY_NAME} directly in Windows Terminal, PowerShell, or Command Prompt, without piping or redirecting its input.`,
    ],
    reader: 'type',
  },
  ci: {
    lines: [
      `${STDIN_NOT_A_TERMINAL_BASE}, and the CI environment variable is set, so it doesn't fall back to the terminal for input.`,
      'Unset the CI environment variable to work interactively.',
    ],
    reader: 'cat',
  },
  tty_unavailable: {
    lines: [
      `${STDIN_NOT_A_TERMINAL_BASE}, and the terminal device (/dev/tty) couldn't be opened to read the keyboard instead.`,
      `Start ${CLI_BINARY_NAME} directly from a terminal.`,
    ],
    reader: 'cat',
  },
}

/**
 * Official `Vl(e)` — the `-p` advice line appended after the case lines.
 * `reader` is the case's file-reading command ('type' on Windows, else 'cat').
 */
export function buildStdinGuardAdviceLine(
  reader: StdinGuardReaderCommand,
): string {
  return `To send text as a prompt and print the reply instead, add -p; it also works with --continue and --resume <session-id> (for example: ${reader} notes.md | ${CLI_BINARY_NAME} -p --continue).`
}

/** The case's message table entry (official `ns[e]`). */
export function getStdinGuardMessage(
  stdinGuardCase: StdinGuardCase,
): StdinGuardMessage {
  return STDIN_GUARD_MESSAGES[stdinGuardCase]
}

/** Official `uro(e)` — the case lines joined, without the advice line. */
export function buildStdinGuardLines(stdinGuardCase: StdinGuardCase): string {
  return STDIN_GUARD_MESSAGES[stdinGuardCase].lines.join('\n')
}

/**
 * Official `rs(e)` message body — `[...lines, Vl(reader)].join("\n")`. The
 * caller prints this to stderr and then exits non-zero.
 */
export function buildStdinGuardMessage(stdinGuardCase: StdinGuardCase): string {
  const { lines, reader } = STDIN_GUARD_MESSAGES[stdinGuardCase]
  return [...lines, buildStdinGuardAdviceLine(reader)].join('\n')
}

export interface StdinGuardCaseInput {
  /** `process.platform` — 'win32' selects the windows case. */
  readonly platform: string
  /** Raw `process.env.CI` value (parsed with OCC's shared isEnvTruthy). */
  readonly ciEnvValue: string | undefined
}

/**
 * Picks the official case: windows when the platform is win32, ci when the CI
 * environment variable is truthy, otherwise tty_unavailable (the /dev/tty open
 * failed or was skipped). The ci predicate matches `getStdinOverride()`'s CI
 * gate so classification and the override decision can never disagree.
 */
export function classifyStdinGuardCase(
  input: StdinGuardCaseInput,
): StdinGuardCase {
  if (input.platform === 'win32') {
    return 'windows'
  }
  if (isEnvTruthy(input.ciEnvValue)) {
    return 'ci'
  }
  return 'tty_unavailable'
}

/**
 * Official `Xl` — classify fd 0 by file type so the failure report says what
 * stdin actually was. `fs.stat(0)` (the official `Yl`) rejects an integer fd
 * under Bun, so this uses `fstat(0)`, which is the same syscall on the same
 * descriptor. Errors resolve to 'unknown' (official: `n ? void 0 : r`).
 */
export async function classifyStdinFdKind(): Promise<StdinFdKind> {
  try {
    const stats = await fstat(0)
    if (stats.isFIFO()) {
      return 'pipe'
    }
    if (stats.isFile()) {
      return 'file'
    }
    if (stats.isSocket()) {
      return 'socket'
    }
    if (stats.isCharacterDevice()) {
      return 'character_device'
    }
    return 'other'
  } catch {
    return 'unknown'
  }
}

export interface StdinGuardDecisionInput {
  /** Interactive (non `-p`/SDK/init-only, TTY stdout) session. */
  readonly isInteractive: boolean
  /** `process.stdin.isTTY`. */
  readonly isStdinTty: boolean
  /** `getStdinOverride() !== undefined` — a usable /dev/tty input stream. */
  readonly hasStdinOverride: boolean
}

/**
 * The guard fires only when the session is interactive, stdin is not a TTY,
 * and no /dev/tty override could be opened — exactly the situation where Ink
 * would boot and die on the 'Raw mode is not supported' throw.
 */
export function shouldRunStdinGuard(input: StdinGuardDecisionInput): boolean {
  return (
    input.isInteractive && !input.isStdinTty && !input.hasStdinOverride
  )
}

export interface StdinGuardExitDeps {
  /** Official `jS` — print to stderr. */
  readonly writeToStderr: (text: string) => void
  /** Official `await sar(e), Vs()` — telemetry/exit flush, then exit. */
  readonly exitNonZero: () => Promise<void>
  /** Official `Xl` — fd-0 classification for the debug log. */
  readonly classifyFdKind: () => Promise<StdinFdKind>
  /** OCC's standard debug logger (no new telemetry event is invented). */
  readonly logDebug: (message: string) => void
}

const DEFAULT_STDIN_GUARD_EXIT_DEPS: StdinGuardExitDeps = {
  // Official `jS` — OCC's shared stderr writer (EPIPE-safe, skips a
  // destroyed stream).
  writeToStderr: (text: string) => {
    writeStderrText(`${text}\n`)
  },
  exitNonZero: async () => {
    // Lazy import: gracefulShutdown pulls in Ink + analytics, and this exit
    // path runs before either is mounted.
    const { gracefulShutdown } = await import('./gracefulShutdown.js')
    await gracefulShutdown(1)
  },
  classifyFdKind: classifyStdinFdKind,
  logDebug: (message: string) => {
    logForDebugging(message)
  },
}

/**
 * Official `rs(e)` — report why the keyboard is unreadable and exit non-zero.
 * Returns after the exit path resolves so callers can `return` from their own
 * handler (in production the process is already gone).
 */
export async function exitWithStdinGuardMessage(
  stdinGuardCase: StdinGuardCase,
  deps: Partial<StdinGuardExitDeps> = {},
): Promise<void> {
  const { writeToStderr, exitNonZero, classifyFdKind, logDebug } = {
    ...DEFAULT_STDIN_GUARD_EXIT_DEPS,
    ...deps,
  }

  const stdinFdKind = await classifyFdKind()
  logDebug(
    `[STARTUP] stdin guard: interactive session without a readable terminal (case=${stdinGuardCase}, stdin_fd=${stdinFdKind})`,
  )
  writeToStderr(buildStdinGuardMessage(stdinGuardCase))
  await exitNonZero()
}
