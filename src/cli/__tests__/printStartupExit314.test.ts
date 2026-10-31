import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.314 item 6: "Fixed `claude -p` exiting with code 0 and no output
 * when startup failed; it now prints the error and exits 1."
 *
 * Official byte-verified ground truth (v314 offsets; v312 identical unless
 * noted):
 *  - print dispatch `oo` @~263635900: `Po(J,re,…).catch((O)=>Eo(J,O,x))` —
 *    the headless run's escaped rejection is routed to
 *    `endHeadlessSessionOnEscapedError` (v312 `eo` has the same catch).
 *  - `GXe(e,n,r)` @282197560 (v312 `BYe` @268280033, minus the v314-only
 *    `stopHoldingStreamEvents` env-gated diagnostic):
 *      `if(vn()){t("runHeadless rejected during shutdown");return}`
 *      `…try{dx(n,{site:"run_headless"})}catch{}`
 *      ``try{as(`An internal error ended the session (${Wp(n)}).`,r,{resultIndex:h})}catch{}``
 *      `mi(1)`  (mi = gracefulShutdownSync @253380110)
 *  - `as(e,n,{resultIndex:r=0,startupFailureReason:s}={})` @~282198000:
 *    always `process.stderr.write(e+"\n")` + `t(e,{level:"error"})`, and for
 *    `stream-json` also a stdout JSON line `AV(jFe({sessionId:z(),message:e,
 *    reason:s,resultIndex:r}))`.
 *  - `jFe` @248626066 / `$N` @248624922: result event
 *    `{type:"result",subtype:"error_during_execution",…,is_error:!0,
 *    errors:[message]}` with `startup_failure_reason` spread only when the
 *    reason is defined and `result_index` only when resultIndex !== null.
 *    An escaped startup rejection has no numbered resultDelivery yet →
 *    `h=null` → `result_index` omitted.
 */

process.env.NODE_ENV = 'test'
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.314',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// Materialize the real gracefulShutdown exports BEFORE mocking (live-binding
// pitfall — pattern: headlessCostRestore277.test.ts / updateNullLookup277).
const realShutdown = { ...(await import('../../utils/gracefulShutdown.js')) }
let shuttingDown = false
const shutdownCalls: Array<[number] | [number, string]> = []
mock.module('../../utils/gracefulShutdown.js', () => ({
  ...realShutdown,
  isShuttingDown: () => shuttingDown,
  gracefulShutdownSync: (code = 0, reason?: string) => {
    shutdownCalls.push(reason === undefined ? [code] : [code, reason])
  },
}))

const { endHeadlessSessionOnEscapedError } = await import('../print.js')

let stderrChunks: string[] = []
let stdoutChunks: string[] = []
const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
  ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write,
)
const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
  ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write,
)

beforeEach(() => {
  stderrChunks = []
  stdoutChunks = []
  shutdownCalls.length = 0
  shuttingDown = false
})

afterAll(() => {
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
  mock.module('../../utils/gracefulShutdown.js', () => ({ ...realShutdown }))
})

describe('endHeadlessSessionOnEscapedError — print startup failure exits 1 (2.1.314 item 6)', () => {
  test('writes the official escaped-error message to stderr and shuts down with code 1', () => {
    endHeadlessSessionOnEscapedError(new Error('boom'), 'text')

    expect(stderrChunks.join('')).toBe(
      'An internal error ended the session (boom).\n',
    )
    expect(shutdownCalls).toEqual([[1]])
    expect(stdoutChunks.join('')).toBe('')
  })

  test('stream-json also emits the $N-shaped error_during_execution result on stdout', () => {
    endHeadlessSessionOnEscapedError(new Error('kaboom'), 'stream-json')

    // Official as(): stderr write happens for EVERY output format.
    expect(stderrChunks.join('')).toBe(
      'An internal error ended the session (kaboom).\n',
    )
    const lines = stdoutChunks
      .join('')
      .split('\n')
      .filter(line => line.length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('result')
    expect(parsed.subtype).toBe('error_during_execution')
    expect(parsed.is_error).toBe(true)
    expect(parsed.errors).toEqual(['An internal error ended the session (kaboom).'])
    expect(parsed.num_turns).toBe(0)
    expect(parsed.total_cost_usd).toBe(0)
    // jFe conditional spreads: no startupFailureReason given and no numbered
    // resultDelivery for an escaped startup rejection → both keys omitted.
    expect('startup_failure_reason' in parsed).toBe(false)
    expect('result_index' in parsed).toBe(false)
    expect(shutdownCalls).toEqual([[1]])
  })

  test('non-Error rejection values are stringified via errorMessage (official Wp)', () => {
    endHeadlessSessionOnEscapedError('plain string failure', 'text')

    expect(stderrChunks.join('')).toBe(
      'An internal error ended the session (plain string failure).\n',
    )
    expect(shutdownCalls).toEqual([[1]])
  })

  test('returns silently while a shutdown is already in progress (official vn() guard)', () => {
    shuttingDown = true
    endHeadlessSessionOnEscapedError(new Error('late'), 'text')

    expect(stderrChunks.join('')).toBe('')
    expect(stdoutChunks.join('')).toBe('')
    expect(shutdownCalls).toEqual([])
  })

  test('main.tsx print dispatch attaches the catch (official Po(...).catch((O)=>Eo(J,O,x)))', async () => {
    const source = await Bun.file(
      new URL('../../main.tsx', import.meta.url),
    ).text()
    expect(source).toContain('endHeadlessSessionOnEscapedError')
    const dispatch = source.slice(
      source.indexOf('void runHeadless('),
      source.indexOf('void runHeadless(') + 6000,
    )
    expect(dispatch).toContain('.catch(')
  })
})

/**
 * 2.1.408 review P3-3c: the source-string pin above only proves main.tsx
 * CONTAINS the `.catch(` wiring — it can't prove a real `occ -p` startup
 * failure exits 1 with the error printed (the actual item-6 user-visible
 * contract: "Fixed `claude -p` exiting with code 0 and no output when
 * startup failed"). This drives the REAL CLI in a child bun process:
 * `-p --resume <nonexistent-session-id>` fails during startup message
 * loading (print.ts `emitLoadError` + `gracefulShutdownSync(1)`) BEFORE any
 * network/auth is touched — deterministic and offline (dummy key, isolated
 * HOME/CLAUDE_CONFIG_DIR/cwd, unreachable-by-design session id).
 */

const CLI_ENTRY = join(import.meta.dir, '../../entrypoints/cli.tsx')
const MISSING_SESSION_ID = '00000000-0000-4000-8000-000000000000'
const SPAWN_TIMEOUT_MS = 60_000

function spawnRealCli(args: string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const home = mkdtempSync(join(tmpdir(), 'occ-p33c-home-'))
  const cfgDir = mkdtempSync(join(tmpdir(), 'occ-p33c-cfg-'))
  const workDir = mkdtempSync(join(tmpdir(), 'occ-p33c-work-'))
  try {
    const child = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      input: '',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        CLAUDE_CONFIG_DIR: cfgDir,
        ANTHROPIC_API_KEY: 'sk-ant-dummy-not-real',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })
    expect(child.error).toBeUndefined()
    return {
      status: child.status,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
}

describe('item 6 REAL subprocess — `occ -p` startup failure exits 1 with the error printed (2.1.408 review P3-3c)', () => {
  test('text format: resume of a nonexistent session exits 1 and prints the error to stderr', () => {
    const { status, stdout, stderr } = spawnRealCli([
      '-p',
      'say hi',
      '--resume',
      MISSING_SESSION_ID,
    ])

    expect(status).toBe(1)
    expect(stderr).toContain(
      `No conversation found with session ID: ${MISSING_SESSION_ID}`,
    )
    // Pre-item-6 bug shape was exit 0 + NO output; the answer channel stays
    // empty (nothing was silently swallowed into stdout either).
    expect(stdout).toBe('')
  }, SPAWN_TIMEOUT_MS)

  test('stream-json: same failure exits 1 and emits the error_during_execution result line', () => {
    const { status, stdout } = spawnRealCli([
      '-p',
      'say hi',
      '--output-format',
      'stream-json',
      '--resume',
      MISSING_SESSION_ID,
    ])

    expect(status).toBe(1)
    const resultLine = stdout
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(evt => evt.type === 'result')
    expect(resultLine).toBeDefined()
    expect(resultLine?.subtype).toBe('error_during_execution')
    expect(resultLine?.is_error).toBe(true)
    expect(resultLine?.errors).toEqual([
      `No conversation found with session ID: ${MISSING_SESSION_ID}`,
    ])
  }, SPAWN_TIMEOUT_MS)
})
