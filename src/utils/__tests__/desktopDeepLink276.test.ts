/**
 * CC 2.1.276 (ITEM 13) — improved `/desktop` error surface.
 *
 * Verifies the port of the official v276 deep-link opener failure builder
 * `D(r,e)` (@204689707 chunk) and the two byte-exact user-facing strings in
 * `oEr()` (@204689604 chunk):
 *   - failure:   `Couldn't open Claude Desktop (${detail}). Open Claude Desktop and run /desktop again.`
 *   - too-old:   `Claude Desktop ${version} is too old. Update to ${MIN_DESKTOP_VERSION} or later.`
 * plus the debug log line `Deep link opener ${r} failed: code ${code}, exitCode ${exitCode??"undefined"}${ctx?`: ${ctx}`:""}`.
 *
 * OCC keeps its OWN min-version constant (1.1.2396) where the official ships
 * wZt="1.1.9669" (@204687473) — a documented deviation; the string SHAPE is
 * official, the constant value is OCC's.
 *
 * The `D()` detail cap `v=200` and the display-sanitize pipeline (`wn`
 * @190910153: first-line → ANSI-strip → control-fold → NFC → backtick-fold →
 * head-truncate + ellipsis) are exercised through buildDeepLinkOpenerResult.
 *
 * Mock plumbing follows the OCC-97/129 convention (sessionStorage.transcriptLoad276.test.ts):
 * mocks installed BEFORE the module under test is imported; real refs re-pinned
 * in afterAll.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const actualDebugModule = await import('../debug.js')
const actualLogForDebugging = actualDebugModule.logForDebugging

const debugLines: Array<{ message: string; level?: string }> = []
let mockActive = true

mock.module('../debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    if (!mockActive) {
      return actualLogForDebugging(message, opts as never)
    }
    debugLines.push({ message, level: opts?.level })
  },
}))

// runOpenerCommand() calls execa(file, args, {reject:false}) directly.
const actualExecaModule = await import('execa')
type ExecaHandler = (
  file: string,
  args: string[],
  opts: unknown,
) => Promise<Record<string, unknown>>
let execaHandler: ExecaHandler = async () => ({
  failed: false,
  stdout: '',
  stderr: '',
  exitCode: 0,
})
const execaCalls: Array<{ file: string; args: string[] }> = []

// Direct function refs captured pre-mock — delegating through the live
// namespace would recurse into the patched binding (OCC-96).
const actualExeca = actualExecaModule.execa
mock.module('execa', () => ({
  ...actualExecaModule,
  execa: (file: string, args: string[], opts: unknown) => {
    if (!mockActive) {
      return (actualExeca as unknown as typeof import('execa').execa)(
        file,
        args,
        opts as never,
      )
    }
    execaCalls.push({ file, args })
    return execaHandler(file, args, opts)
  },
}))

// isDesktopInstalled() / getDesktopVersion() call execFileNoThrow().
const actualExecFileNoThrowModule = await import('../execFileNoThrow.js')
type ExecFileHandler = (
  file: string,
  args: string[],
  opts: unknown,
) => Promise<{ stdout: string; stderr: string; code: number; error?: string }>
let execFileHandler: ExecFileHandler = async () => ({
  stdout: '',
  stderr: '',
  code: 1,
})

const actualExecFileNoThrow = actualExecFileNoThrowModule.execFileNoThrow
mock.module('../execFileNoThrow.js', () => ({
  ...actualExecFileNoThrowModule,
  execFileNoThrow: (file: string, args: string[], opts: unknown) =>
    mockActive
      ? execFileHandler(file, args, opts)
      : (
          actualExecFileNoThrow as (
            f: string,
            a: string[],
            o: unknown,
          ) => Promise<unknown>
        )(file, args, opts),
}))

const {
  buildDeepLinkOpenerResult,
  openCurrentSessionInDesktop,
  MIN_DESKTOP_VERSION,
} = await import('../desktopDeepLink.js')

// ---------------------------------------------------------------------------
// Platform / env override plumbing
// ---------------------------------------------------------------------------

const originalPlatform = process.platform
const originalNodeEnv = process.env.NODE_ENV
const originalLocalAppData = process.env.LOCALAPPDATA

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

const tempDirs: string[] = []

beforeEach(() => {
  debugLines.length = 0
  execaCalls.length = 0
  execaHandler = async () => ({
    failed: false,
    stdout: '',
    stderr: '',
    exitCode: 0,
  })
  execFileHandler = async () => ({ stdout: '', stderr: '', code: 1 })
  // Force the non-dev protocol ('claude://') + real install probe path.
  process.env.NODE_ENV = 'test'
})

afterAll(async () => {
  // OCC-97 leak guard: re-pin the REAL refs captured pre-mock.
  mockActive = false
  mock.module('../debug.js', () => ({
    ...actualDebugModule,
    logForDebugging: actualLogForDebugging,
  }))
  mock.module('execa', () => actualExecaModule)
  mock.module('../execFileNoThrow.js', () => actualExecFileNoThrowModule)

  setPlatform(originalPlatform)
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData
  }
  await Promise.allSettled(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  )
})

// ---------------------------------------------------------------------------
// buildDeepLinkOpenerResult — the official D(r,e) detail builder
// ---------------------------------------------------------------------------

describe('ITEM 13 (2.1.276): buildDeepLinkOpenerResult (official D)', () => {
  test('code 0 → { opened: true }, no debug log', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: '',
      code: 0,
      exitCode: 0,
    })
    expect(result).toEqual({ opened: true })
    expect(debugLines).toEqual([])
  })

  test('defined exitCode + stderr → "`opener` exited N: detail" with trailing period stripped', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'boom.',
      code: 1,
      exitCode: 3,
      error: 'ignored',
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` exited 3: boom',
    })
  })

  test('undefined exitCode + error → "`opener` failed: error"', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: '',
      code: 1,
      error: 'spawn ENOENT',
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` failed: spawn ENOENT',
    })
  })

  test('undefined exitCode + empty stderr/error → bare "`opener` failed"', () => {
    const result = buildDeepLinkOpenerResult('open', {
      stdout: '',
      stderr: '',
      code: 1,
    })
    expect(result).toEqual({ opened: false, detail: '`open` failed' })
  })

  test('stderr longer than the v=200 cap is head-truncated + ellipsized', () => {
    const long = 'a'.repeat(250)
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: long,
      code: 1,
      exitCode: 1,
    })
    // truncateWithEllipsis keeps the FIRST 200 chars + a single … (head slice,
    // per official eEt/re — NOT the tail).
    expect(result).toEqual({
      opened: false,
      detail: `\`xdg-open\` exited 1: ${'a'.repeat(200)}…`,
    })
  })

  test('multi-line stderr keeps only the first line (official Or)', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'first line\nsecond line',
      code: 1,
      exitCode: 2,
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` exited 2: first line',
    })
  })

  test('ANSI escape sequences are stripped from the detail (official jar)', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: '\x1b[31mboom\x1b[0m',
      code: 1,
      exitCode: 2,
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` exited 2: boom',
    })
  })

  test('debug log line matches the official byte-exact template', () => {
    buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'boom.',
      code: 1,
      exitCode: 3,
    })
    // context = stderr || error = 'boom.' (raw, NOT sanitized, per official `a=i||s`).
    expect(debugLines).toEqual([
      {
        message: 'Deep link opener xdg-open failed: code 1, exitCode 3: boom.',
        level: undefined,
      },
    ])
  })

  test('debug log uses "undefined" for a missing exitCode (official n??"undefined")', () => {
    buildDeepLinkOpenerResult('cmd', {
      stdout: '',
      stderr: '',
      code: 1,
      error: 'spawn ENOENT',
    })
    expect(debugLines).toEqual([
      {
        message:
          'Deep link opener cmd failed: code 1, exitCode undefined: spawn ENOENT',
        level: undefined,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// openCurrentSessionInDesktop — the official oEr() user strings
// ---------------------------------------------------------------------------

describe('ITEM 13 (2.1.276): openCurrentSessionInDesktop (official oEr)', () => {
  test('linux: not-installed → official download message, no opener run', async () => {
    setPlatform('linux')
    // xdg-mime query returns code 0 with EMPTY stdout → no handler → not installed.
    execFileHandler = async () => ({ stdout: '', stderr: '', code: 0 })

    const result = await openCurrentSessionInDesktop()

    expect(result).toEqual({
      success: false,
      error:
        'Claude Desktop is not installed. Install it from https://claude.ai/download',
    })
    expect(execaCalls).toEqual([])
  })

  test('linux: opener failure → "Couldn\'t open Claude Desktop (detail). …" with deepLinkUrl', async () => {
    setPlatform('linux')
    // installed: xdg-mime returns a handler name.
    execFileHandler = async () => ({
      stdout: 'claude.desktop',
      stderr: '',
      code: 0,
    })
    // opener fails with exitCode 3.
    execaHandler = async () => ({
      failed: true,
      stdout: '',
      stderr: 'no handler found.',
      exitCode: 3,
    })

    const result = await openCurrentSessionInDesktop()

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      "Couldn't open Claude Desktop (`xdg-open` exited 3: no handler found). Open Claude Desktop and run /desktop again.",
    )
    expect(result.deepLinkUrl).toMatch(/^claude:\/\/resume\?session=/)
    expect(execaCalls[0]?.file).toBe('xdg-open')
  })

  test('linux: opener success → { success: true, deepLinkUrl }', async () => {
    setPlatform('linux')
    execFileHandler = async () => ({
      stdout: 'claude.desktop',
      stderr: '',
      code: 0,
    })
    execaHandler = async () => ({
      failed: false,
      stdout: '',
      stderr: '',
      exitCode: 0,
    })

    const result = await openCurrentSessionInDesktop()

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.deepLinkUrl).toMatch(/^claude:\/\/resume\?session=/)
  })

  test('win32: version-too-old → official shape with OCC MIN_DESKTOP_VERSION constant', async () => {
    setPlatform('win32')
    // reg query succeeds → installed.
    execFileHandler = async (file) => {
      if (file === 'reg') {
        return { stdout: '', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 1 }
    }
    // Real fs: LOCALAPPDATA/AnthropicClaude/app-1.0.0 → version '1.0.0'.
    const base = await mkdtemp(join(tmpdir(), 'occ-item13-win32-'))
    tempDirs.push(base)
    await mkdir(join(base, 'AnthropicClaude', 'app-1.0.0'), { recursive: true })
    process.env.LOCALAPPDATA = base

    const result = await openCurrentSessionInDesktop()

    // Byte-exact official oEr() too-old string, with OCC's constant (1.1.2396),
    // NOT the official wZt (1.1.9669).
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      `Claude Desktop 1.0.0 is too old. Update to ${MIN_DESKTOP_VERSION} or later.`,
    )
    expect(result.error).toBe(
      'Claude Desktop 1.0.0 is too old. Update to 1.1.2396 or later.',
    )
    // The opener is never run when the version is too old.
    expect(execaCalls).toEqual([])
  })
})

describe('ITEM 13 (2.1.276): MIN_DESKTOP_VERSION constant', () => {
  test('OCC keeps its own 1.1.2396 (documented deviation from official wZt=1.1.9669)', () => {
    expect(MIN_DESKTOP_VERSION).toBe('1.1.2396')
  })
})

// ---------------------------------------------------------------------------
// 2.1.287 #15 — /desktop opener failure cause naming (official v287 `y()`)
//
// Official v287 (@218727474 region) destructures `timedOut`/`maxBufferExceeded`
// off the exec result and adds two early returns BEFORE the v276 `D()`
// failed/exited-N fallthrough, byte-exact:
//   if(…,u)return{opened:!1,detail:`\`${e}\` timed out`}
//   if(c)return{opened:!1,detail:`\`${e}\` printed too much output`}
// The debug log line still fires BEFORE the branches (official `if(t(…),u)`).
// ---------------------------------------------------------------------------

describe('ITEM 15 (2.1.287): buildDeepLinkOpenerResult cause naming (official y)', () => {
  test('timedOut → byte-exact "`opener` timed out" (early return, no stderr quote)', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'partial output before kill',
      code: 1,
      timedOut: true,
    })
    expect(result).toEqual({ opened: false, detail: '`xdg-open` timed out' })
  })

  test('maxBufferExceeded → byte-exact "`opener` printed too much output"', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'f'.repeat(300),
      code: 1,
      maxBufferExceeded: true,
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` printed too much output',
    })
  })

  test('official branch order: timedOut wins when both flags are set (u before c)', () => {
    const result = buildDeepLinkOpenerResult('open', {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: true,
      maxBufferExceeded: true,
    })
    expect(result).toEqual({ opened: false, detail: '`open` timed out' })
  })

  test('code 0 short-circuits before the cause branches (official o===0 first)', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: '',
      code: 0,
      exitCode: 0,
      timedOut: true,
      maxBufferExceeded: true,
    })
    expect(result).toEqual({ opened: true })
  })

  test('debug log still fires before the early return (official t(…) then u)', () => {
    buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: true,
    })
    expect(debugLines).toEqual([
      {
        message: 'Deep link opener xdg-open failed: code 1, exitCode undefined',
        level: undefined,
      },
    ])
  })

  test('neither flag (plain non-zero exit) → v276 fallthrough unchanged', () => {
    const result = buildDeepLinkOpenerResult('xdg-open', {
      stdout: '',
      stderr: 'boom.',
      code: 1,
      exitCode: 3,
      timedOut: false,
      maxBufferExceeded: false,
    })
    expect(result).toEqual({
      opened: false,
      detail: '`xdg-open` exited 3: boom',
    })
  })
})

describe('ITEM 15 (2.1.287): runOpenerCommand execa v9 field mapping', () => {
  // execa v9 renamed the old `maxBufferExceeded` result field to `isMaxBuffer`
  // (node_modules/execa result.d.ts) — runOpenerCommand maps it back to the
  // official v287 `y()` field name. `timedOut` passes through unchanged.
  test('linux: execa timedOut → user error names the timeout cause', async () => {
    setPlatform('linux')
    execFileHandler = async () => ({
      stdout: 'claude.desktop',
      stderr: '',
      code: 0,
    })
    execaHandler = async () => ({
      failed: true,
      stdout: '',
      stderr: '',
      exitCode: undefined,
      timedOut: true,
      shortMessage: 'xdg-open timed out after 600000 milliseconds',
    })

    const result = await openCurrentSessionInDesktop()

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      "Couldn't open Claude Desktop (`xdg-open` timed out). Open Claude Desktop and run /desktop again.",
    )
  })

  test('linux: execa isMaxBuffer → user error names the output-overflow cause', async () => {
    setPlatform('linux')
    execFileHandler = async () => ({
      stdout: 'claude.desktop',
      stderr: '',
      code: 0,
    })
    execaHandler = async () => ({
      failed: true,
      stdout: 'x'.repeat(200),
      stderr: '',
      exitCode: undefined,
      isMaxBuffer: true,
      shortMessage: 'maxBuffer exceeded',
    })

    const result = await openCurrentSessionInDesktop()

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      "Couldn't open Claude Desktop (`xdg-open` printed too much output). Open Claude Desktop and run /desktop again.",
    )
  })

  test('linux: plain non-zero exit (no flags) → v276 fallthrough end-to-end', async () => {
    setPlatform('linux')
    execFileHandler = async () => ({
      stdout: 'claude.desktop',
      stderr: '',
      code: 0,
    })
    execaHandler = async () => ({
      failed: true,
      stdout: '',
      stderr: 'no handler found.',
      exitCode: 3,
      timedOut: false,
      isMaxBuffer: false,
    })

    const result = await openCurrentSessionInDesktop()

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      "Couldn't open Claude Desktop (`xdg-open` exited 3: no handler found). Open Claude Desktop and run /desktop again.",
    )
  })
})
