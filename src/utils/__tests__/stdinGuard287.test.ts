import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_BINARY_NAME } from '../../constants/cli.js'
import {
  buildStdinGuardAdviceLine,
  buildStdinGuardLines,
  buildStdinGuardMessage,
  classifyStdinFdKind,
  classifyStdinGuardCase,
  exitWithStdinGuardMessage,
  getStdinGuardMessage,
  shouldRunStdinGuard,
  STDIN_GUARD_CASES,
  type StdinFdKind,
} from '../stdinGuard.js'

/**
 * claude-code 2.1.287 (#21) — piped/redirected stdin startup guard.
 *
 * Official v287 @ ~215311316 (verbatim, from docs/gap-research-287
 * cluster-d2-misc.md):
 *
 *   var lr="Claude Code can't read the keyboard here: stdin is not a terminal
 *     (it is piped, redirected, or supplied by the program that launched claude)",
 *   ns={windows:{lines:[`${lr}, and on Windows it can't fall back to the console
 *     for input yet.`,"Run claude directly in Windows Terminal, PowerShell, or
 *     Command Prompt, without piping or redirecting its input."],reader:"type"},
 *   ci:{lines:[`${lr}, and the CI environment variable is set, so it doesn't
 *     fall back to the terminal for input.`,"Unset the CI environment variable
 *     to work interactively."],reader:"cat"},
 *   tty_unavailable:{lines:[`${lr}, and the terminal device (/dev/tty) couldn't
 *     be opened to read the keyboard instead.`,"Start claude directly from a
 *     terminal."],reader:"cat"}};
 *   function uro(e){return ns[e].lines.join("\n")}
 *   function Vl(e){return`To send text as a prompt and print the reply instead,
 *     add -p; it also works with --continue and --resume <session-id>
 *     (for example: ${e} notes.md | claude -p --continue).`}
 *
 * Byte-exactness note: every lowercase `claude` COMMAND name is asserted
 * through `CLI_BINARY_NAME` — OCC's documented convention
 * (docs/occ29-claude-command-name-audit.md) keeps the brand "Claude Code"
 * verbatim and routes command names through the single bin-name source. All
 * other characters are asserted literally.
 */

const BASE_SENTENCE_PREFIX =
  "Claude Code can't read the keyboard here: stdin is not a terminal (it is piped, redirected, or supplied by the program that launched "

const BASE_SENTENCE = `${BASE_SENTENCE_PREFIX}${CLI_BINARY_NAME})`

describe('stdinGuard (2.1.287 #21) — official lr base sentence', () => {
  test('keeps the brand wording byte-exact and routes the command name through CLI_BINARY_NAME', () => {
    expect(BASE_SENTENCE).toBe(
      `Claude Code can't read the keyboard here: stdin is not a terminal (it is piped, redirected, or supplied by the program that launched ${CLI_BINARY_NAME})`,
    )
    // The base sentence is shared verbatim by all three cases.
    for (const stdinGuardCase of ['windows', 'ci', 'tty_unavailable'] as const) {
      expect(getStdinGuardMessage(stdinGuardCase).lines[0]?.startsWith(BASE_SENTENCE)).toBe(
        true,
      )
    }
  })
})

describe('stdinGuard (2.1.287 #21) — official ns case table', () => {
  test('windows case lines and reader are byte-exact', () => {
    expect(getStdinGuardMessage('windows').lines).toEqual([
      `${BASE_SENTENCE}, and on Windows it can't fall back to the console for input yet.`,
      `Run ${CLI_BINARY_NAME} directly in Windows Terminal, PowerShell, or Command Prompt, without piping or redirecting its input.`,
    ])
    expect(getStdinGuardMessage('windows').reader).toBe('type')
  })

  test('ci case lines and reader are byte-exact', () => {
    expect(getStdinGuardMessage('ci').lines).toEqual([
      `${BASE_SENTENCE}, and the CI environment variable is set, so it doesn't fall back to the terminal for input.`,
      'Unset the CI environment variable to work interactively.',
    ])
    expect(getStdinGuardMessage('ci').reader).toBe('cat')
  })

  test('tty_unavailable case lines and reader are byte-exact', () => {
    expect(getStdinGuardMessage('tty_unavailable').lines).toEqual([
      `${BASE_SENTENCE}, and the terminal device (/dev/tty) couldn't be opened to read the keyboard instead.`,
      `Start ${CLI_BINARY_NAME} directly from a terminal.`,
    ])
    expect(getStdinGuardMessage('tty_unavailable').reader).toBe('cat')
  })

  test('each case has exactly two lines (official ns shape)', () => {
    expect(STDIN_GUARD_CASES).toEqual(['windows', 'ci', 'tty_unavailable'])
    for (const stdinGuardCase of STDIN_GUARD_CASES) {
      expect(getStdinGuardMessage(stdinGuardCase).lines).toHaveLength(2)
    }
  })
})

describe('stdinGuard (2.1.287 #21) — official uro(e) lines join', () => {
  test('joins the case lines with a single newline', () => {
    expect(buildStdinGuardLines('windows')).toBe(
      `${BASE_SENTENCE}, and on Windows it can't fall back to the console for input yet.\nRun ${CLI_BINARY_NAME} directly in Windows Terminal, PowerShell, or Command Prompt, without piping or redirecting its input.`,
    )
    expect(buildStdinGuardLines('ci')).toBe(
      `${BASE_SENTENCE}, and the CI environment variable is set, so it doesn't fall back to the terminal for input.\nUnset the CI environment variable to work interactively.`,
    )
    expect(buildStdinGuardLines('tty_unavailable')).toBe(
      `${BASE_SENTENCE}, and the terminal device (/dev/tty) couldn't be opened to read the keyboard instead.\nStart ${CLI_BINARY_NAME} directly from a terminal.`,
    )
  })
})

describe('stdinGuard (2.1.287 #21) — official Vl(e) advice line', () => {
  test('cat reader (ci / tty_unavailable) is byte-exact', () => {
    expect(buildStdinGuardAdviceLine('cat')).toBe(
      `To send text as a prompt and print the reply instead, add -p; it also works with --continue and --resume <session-id> (for example: cat notes.md | ${CLI_BINARY_NAME} -p --continue).`,
    )
  })

  test('type reader (windows) is byte-exact', () => {
    expect(buildStdinGuardAdviceLine('type')).toBe(
      `To send text as a prompt and print the reply instead, add -p; it also works with --continue and --resume <session-id> (for example: type notes.md | ${CLI_BINARY_NAME} -p --continue).`,
    )
  })
})

describe('stdinGuard (2.1.287 #21) — official rs(e) stderr body', () => {
  test('is [...lines, Vl(reader)] joined by newlines for every case', () => {
    for (const stdinGuardCase of ['windows', 'ci', 'tty_unavailable'] as const) {
      const { lines, reader } = getStdinGuardMessage(stdinGuardCase)
      expect(buildStdinGuardMessage(stdinGuardCase)).toBe(
        [...lines, buildStdinGuardAdviceLine(reader)].join('\n'),
      )
      expect(buildStdinGuardMessage(stdinGuardCase).split('\n')).toHaveLength(3)
    }
  })

  test('tty_unavailable full message (the common Linux/macOS piped-stdin case)', () => {
    expect(buildStdinGuardMessage('tty_unavailable')).toBe(
      [
        `${BASE_SENTENCE}, and the terminal device (/dev/tty) couldn't be opened to read the keyboard instead.`,
        `Start ${CLI_BINARY_NAME} directly from a terminal.`,
        `To send text as a prompt and print the reply instead, add -p; it also works with --continue and --resume <session-id> (for example: cat notes.md | ${CLI_BINARY_NAME} -p --continue).`,
      ].join('\n'),
    )
  })
})

describe('stdinGuard (2.1.287 #21) — case classification', () => {
  test('win32 selects the windows case', () => {
    expect(classifyStdinGuardCase({ platform: 'win32', ciEnvValue: undefined })).toBe(
      'windows',
    )
  })

  test('windows wins over a set CI variable (official table order)', () => {
    expect(classifyStdinGuardCase({ platform: 'win32', ciEnvValue: 'true' })).toBe(
      'windows',
    )
  })

  test('a truthy CI variable selects the ci case', () => {
    for (const ciEnvValue of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(classifyStdinGuardCase({ platform: 'linux', ciEnvValue })).toBe('ci')
    }
  })

  test('an unset or falsy CI variable falls through to tty_unavailable', () => {
    for (const ciEnvValue of [undefined, '', '0', 'false', 'off', 'no']) {
      expect(classifyStdinGuardCase({ platform: 'linux', ciEnvValue })).toBe(
        'tty_unavailable',
      )
    }
    expect(classifyStdinGuardCase({ platform: 'darwin', ciEnvValue: undefined })).toBe(
      'tty_unavailable',
    )
  })
})

describe('stdinGuard (2.1.287 #21) — startup guard condition', () => {
  test('fires only for interactive + non-TTY stdin + no /dev/tty override', () => {
    expect(
      shouldRunStdinGuard({
        isInteractive: true,
        isStdinTty: false,
        hasStdinOverride: false,
      }),
    ).toBe(true)
  })

  test('does not fire when stdin is a TTY', () => {
    expect(
      shouldRunStdinGuard({
        isInteractive: true,
        isStdinTty: true,
        hasStdinOverride: false,
      }),
    ).toBe(false)
  })

  test('does not fire when a /dev/tty override was opened', () => {
    expect(
      shouldRunStdinGuard({
        isInteractive: true,
        isStdinTty: false,
        hasStdinOverride: true,
      }),
    ).toBe(false)
  })

  test('does not fire for non-interactive (-p / SDK / non-TTY stdout) sessions', () => {
    expect(
      shouldRunStdinGuard({
        isInteractive: false,
        isStdinTty: false,
        hasStdinOverride: false,
      }),
    ).toBe(false)
    expect(
      shouldRunStdinGuard({
        isInteractive: false,
        isStdinTty: true,
        hasStdinOverride: true,
      }),
    ).toBe(false)
  })
})

describe('stdinGuard (2.1.287 #21) — official Xl fd-0 stat classifier', () => {
  const VALID_KINDS: readonly StdinFdKind[] = [
    'pipe',
    'file',
    'socket',
    'character_device',
    'other',
    'unknown',
  ]

  test('classifies the live fd 0 as one of the official kinds', async () => {
    expect(VALID_KINDS).toContain(await classifyStdinFdKind())
  })

  test('classifies a redirected file, a shell pipe and /dev/null', async () => {
    // Real fd-0 checks in a child shell: Bun.spawn's stdin:'pipe' hands the
    // child a socket rather than a FIFO, so the deterministic branches are
    // exercised through actual shell redirection instead.
    const dir = mkdtempSync(join(tmpdir(), 'stdin-guard-287-'))
    try {
      const probePath = join(dir, 'probe.ts')
      const modulePath = new URL('../stdinGuard.ts', import.meta.url).pathname
      writeFileSync(
        probePath,
        `const { classifyStdinFdKind } = await import(${JSON.stringify(modulePath)});` +
          'process.stdout.write(await classifyStdinFdKind())',
      )
      const inputPath = join(dir, 'input.txt')
      writeFileSync(inputPath, 'redirected stdin\n')

      const runWithStdin = async (command: string): Promise<string> => {
        const proc = Bun.spawn(['/bin/sh', '-c', command], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const stdout = await new Response(proc.stdout).text()
        await proc.exited
        return stdout
      }
      const bin = process.execPath

      // isFile() → 'file'
      expect(await runWithStdin(`${bin} ${probePath} < ${inputPath}`)).toBe('file')
      // isFIFO() → 'pipe'
      expect(await runWithStdin(`printf piped | ${bin} ${probePath}`)).toBe('pipe')
      // isCharacterDevice() → 'character_device'
      expect(await runWithStdin(`${bin} ${probePath} < /dev/null`)).toBe(
        'character_device',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('stdinGuard (2.1.287 #21) — official rs(e) report-and-exit', () => {
  test('writes the message to stderr, logs the fd kind, then exits non-zero', async () => {
    const stderrWrites: string[] = []
    const debugMessages: string[] = []
    let exitCalls = 0

    await exitWithStdinGuardMessage('ci', {
      writeToStderr: text => {
        stderrWrites.push(text)
      },
      logDebug: message => {
        debugMessages.push(message)
      },
      classifyFdKind: async () => 'pipe',
      exitNonZero: async () => {
        exitCalls += 1
      },
    })

    expect(stderrWrites).toEqual([buildStdinGuardMessage('ci')])
    expect(exitCalls).toBe(1)
    expect(debugMessages).toHaveLength(1)
    expect(debugMessages[0]).toContain('case=ci')
    expect(debugMessages[0]).toContain('stdin_fd=pipe')
  })
})

describe('stdinGuard (2.1.287 #21) — startup wiring', () => {
  const readSource = (relativePath: string): string =>
    readFileSync(new URL(relativePath, import.meta.url), 'utf8')

  test('main.tsx runs the guard before Ink mounts', () => {
    const mainSource = readSource('../../main.tsx')
    const guardIndex = mainSource.indexOf('shouldRunStdinGuard({')
    const inkMountIndex = mainSource.indexOf('createRoot(ctx.renderOptions)')

    expect(guardIndex).toBeGreaterThan(-1)
    expect(mainSource).toContain('exitWithStdinGuardMessage(classifyStdinGuardCase({')
    // The guard must be evaluated before the Ink root is created — that is the
    // whole point of the official fix (no raw-mode throw, no hang).
    expect(inkMountIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(inkMountIndex)
  })

  test('the /dev/tty override probe is exported and gated on the affected case', () => {
    const renderOptionsSource = readSource('../renderOptions.ts')
    expect(renderOptionsSource).toContain(
      'export function getStdinOverride(): ReadStream | undefined',
    )

    const mainSource = readSource('../../main.tsx')
    // Opening /dev/tty caches an override + holds a TTY handle; the headless -p
    // path must not pay for it, so the probe stays behind the interactive +
    // non-TTY-stdin gate.
    expect(mainSource).toContain(
      'const stdinOverrideProbeNeeded = !getIsNonInteractiveSession() && !process.stdin.isTTY;',
    )
    expect(mainSource).toContain(
      'hasStdinOverride: stdinOverrideProbeNeeded ? getStdinOverride() !== undefined : false',
    )
  })
})
