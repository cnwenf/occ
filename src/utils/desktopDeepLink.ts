import { execa } from 'execa'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { coerce as semverCoerce } from 'semver'
import { getSessionId } from '../bootstrap/state.js'
import { truncateToDisplayLength } from '../services/mcp/displaySanitize.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { pathExists } from './file.js'
import { gte as semverGte } from './semver.js'

/**
 * Minimum Claude Desktop version accepted by the /desktop handoff.
 * The official v276 binary ships `wZt="1.1.9669"` (@204687473); OCC keeps its
 * own constant (documented deviation) but adopts the official user-facing
 * string shapes verbatim (`… is too old. Update to ${MIN_DESKTOP_VERSION} or
 * later.` / `… need v${MIN_DESKTOP_VERSION}+).`).
 */
export const MIN_DESKTOP_VERSION = '1.1.2396'

function isDevMode(): boolean {
  if ((process.env.NODE_ENV as string) === 'development') {
    return true
  }

  // Local builds from build directories are dev mode even with NODE_ENV=production
  const pathsToCheck = [process.argv[1] || '', process.execPath || '']
  const buildDirs = [
    '/build-ant/',
    '/build-ant-native/',
    '/build-external/',
    '/build-external-native/',
  ]

  return pathsToCheck.some(p => buildDirs.some(dir => p.includes(dir)))
}

/**
 * Builds a deep link URL for Claude Desktop to resume a CLI session.
 * Format: claude://resume?session={sessionId}&cwd={cwd}
 * In dev mode: claude-dev://resume?session={sessionId}&cwd={cwd}
 * (Official v276 `m(r)=d("resume",{session:r})` carries only `session`; the
 * extra `cwd` param is a pre-existing OCC deviation, kept.)
 */
function buildDesktopDeepLink(sessionId: string): string {
  const protocol = isDevMode() ? 'claude-dev' : 'claude'
  const url = new URL(`${protocol}://resume`)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('cwd', getCwd())
  return url.toString()
}

/**
 * Check if Claude Desktop app is installed.
 * On macOS, checks for /Applications/Claude.app.
 * On Linux, checks if xdg-open can handle claude:// protocol.
 * On Windows, checks if the protocol handler exists.
 * In dev mode, always returns true (assumes dev Desktop is running).
 */
async function isDesktopInstalled(): Promise<boolean> {
  // In dev mode, assume the dev Desktop app is running
  if (isDevMode()) {
    return true
  }

  const platform = process.platform

  if (platform === 'darwin') {
    // Check for Claude.app in /Applications
    return pathExists('/Applications/Claude.app')
  } else if (platform === 'linux') {
    // Check if xdg-mime can find a handler for claude://
    // Note: xdg-mime returns exit code 0 even with no handler, so check stdout too
    const { code, stdout } = await execFileNoThrow('xdg-mime', [
      'query',
      'default',
      'x-scheme-handler/claude',
    ])
    return code === 0 && stdout.trim().length > 0
  } else if (platform === 'win32') {
    // On Windows, try to query the registry for the protocol handler
    const { code } = await execFileNoThrow('reg', [
      'query',
      'HKEY_CLASSES_ROOT\\claude',
      '/ve',
    ])
    return code === 0
  }

  return false
}

/**
 * Detect the installed Claude Desktop version.
 * On macOS, reads CFBundleShortVersionString from the app plist.
 * On Windows, finds the highest app-X.Y.Z directory in the Squirrel install.
 * Returns null if version cannot be determined.
 */
async function getDesktopVersion(): Promise<string | null> {
  const platform = process.platform

  if (platform === 'darwin') {
    const { code, stdout } = await execFileNoThrow('defaults', [
      'read',
      '/Applications/Claude.app/Contents/Info.plist',
      'CFBundleShortVersionString',
    ])
    if (code !== 0) {
      return null
    }
    const version = stdout.trim()
    return version.length > 0 ? version : null
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) {
      return null
    }
    const installDir = join(localAppData, 'AnthropicClaude')
    try {
      const entries = await readdir(installDir)
      const versions = entries
        .filter(e => e.startsWith('app-'))
        .map(e => e.slice(4))
        .filter(v => semverCoerce(v) !== null)
        .sort((a, b) => {
          const ca = semverCoerce(a)!
          const cb = semverCoerce(b)!
          return ca.compare(cb)
        })
      return versions.length > 0 ? versions[versions.length - 1]! : null
    } catch {
      return null
    }
  }

  return null
}

export type DesktopInstallStatus =
  | { status: 'not-installed' }
  | { status: 'version-too-old'; version: string }
  | { status: 'ready'; version: string }

/**
 * Check Desktop install status including version compatibility.
 * Official v276 `xLn` (@204689604 chunk): same three-variant shape; version
 * detection stays richer than the official linux build (whose `C()` is null).
 */
export async function getDesktopInstallStatus(): Promise<DesktopInstallStatus> {
  const installed = await isDesktopInstalled()
  if (!installed) {
    return { status: 'not-installed' }
  }

  let version: string | null
  try {
    version = await getDesktopVersion()
  } catch {
    // Best effort — proceed with handoff if version detection fails
    return { status: 'ready', version: 'unknown' }
  }

  if (!version) {
    // Can't determine version — assume it's ready (dev mode or unknown install)
    return { status: 'ready', version: 'unknown' }
  }

  const coerced = semverCoerce(version)
  if (!coerced || !semverGte(coerced.version, MIN_DESKTOP_VERSION)) {
    return { status: 'version-too-old', version }
  }

  return { status: 'ready', version }
}

// ---------------------------------------------------------------------------
// Official v276 opener-failure detail builder (`D(r,e)` @204689707 chunk) and
// the display-sanitize pipeline it runs stderr through (`wn` @190910153).
// ---------------------------------------------------------------------------

/** Official `v=200` (@204689707 chunk) — stderr detail cap passed to `wn`. */
const OPENER_DETAIL_MAX_LENGTH = 200

/** Official `y` (@190911701) pre-slices to `n*8` before ANSI-boundary repair. */
const DETAIL_PRE_SLICE_FACTOR = 8

/** Official `N=4` (@190910058 `jar`) — ANSI-strip fixed-point pass count. */
const ANSI_STRIP_PASSES = 4

// Official `b` (@190909897 region): CSI sequences (params \x30-\x3f,
// intermediates \x20-\x2f, final \x40-\x7e) and string sequences
// (OSC ] / DCS P / SOS X / PM ^ / APC _) terminated by BEL or ST.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim ANSI strip regex `b` (v276 @190909897)
const ANSI_SEQUENCE_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g

// Official `je` (@190576033 region, used by `f6`): unpaired UTF-16 surrogates.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// Official `An` (@190766242): C0/C1 controls + format chars + line/paragraph
// separators collapse to a single space. (No biome-ignore needed: `\p{Cc}` and
// the `\u2028`/`\u2029` escapes are not literal control chars in the source.)
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu

// Official `p` (@190911701 region): combining marks not preceded by a
// non-space non-punctuation base — stray marks left by sanitization.
const STRAY_COMBINING_MARK_RE = /(?<![^\s\p{P}])\p{M}+/gu

// Official `wn` (@190910153): backtick lookalikes fold to ASCII apostrophe.
const BACKTICK_VARIANT_RE = /[\u0060\uff40\u02cb\u1fef\u2035]/g

// Official `y` (@190911701): trailing partial escape detector + the two
// complete-sequence probes used to decide whether the cut landed mid-escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim partial-escape detector (v276 `y` @190911701)
const PARTIAL_ESCAPE_TAIL_RE = /\x1b(?:[\]PX^_][^\x1b\x07]*\x1b?|\[[\x30-\x3f]*[\x20-\x2f]*)$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim CSI probe (v276 `y` @190911701)
const COMPLETE_CSI_RE = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim string-escape probe (v276 `y` @190911701)
const COMPLETE_STRING_ESCAPE_RE = /^\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/

const isWellFormed: ((text: string) => boolean) | undefined =
  typeof String.prototype.isWellFormed === 'function'
    ? Function.prototype.call.bind(String.prototype.isWellFormed)
    : undefined

/** Official `f6` (@190577265) — drop lone surrogates (isWellFormed fast path). */
function stripLoneSurrogates(text: string): string {
  if (isWellFormed && isWellFormed(text)) return text
  return text.replace(LONE_SURROGATE_RE, '')
}

/** Official `jar` (@190910058) — fixed-point (≤4 pass) ANSI sequence strip. */
function stripAnsiSequences(text: string): string {
  let result = text
  for (let pass = 0; pass < ANSI_STRIP_PASSES; pass++) {
    const next = result.replace(ANSI_SEQUENCE_RE, '')
    if (next === result) break
    result = next
  }
  return result
}

/**
 * Official `qP` (@190909897): `An(jar(f6(e))).replace(/ {2,}/g," ").trim()` —
 * lone surrogates → ANSI strip → controls/format → space, collapse space
 * runs, trim.
 */
function sanitizeForDisplay(text: string): string {
  return stripAnsiSequences(stripLoneSurrogates(text))
    .replace(CONTROL_FORMAT_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Official `y` (@190911701): head-slice to `n*8`, then repair a cut that
 * landed inside an ANSI escape — when the sliced tail looks like a partial
 * escape but the full remainder forms a complete sequence, drop it.
 */
function sliceWithAnsiBoundaryRepair(text: string, max: number): string {
  const head = truncateToDisplayLength(text, max * DETAIL_PRE_SLICE_FACTOR)
  if (head.length === text.length) return head
  const partial = PARTIAL_ESCAPE_TAIL_RE.exec(head)
  if (partial === null) return head
  const remainder = text.slice(partial.index)
  const isCompleteEscape =
    remainder[1] === '['
      ? COMPLETE_CSI_RE.test(remainder)
      : COMPLETE_STRING_ESCAPE_RE.test(remainder)
  return isCompleteEscape ? head.slice(0, partial.index) : head
}

/** Official `eEt` (@190910353) — head-truncate to `max` + ellipsis. */
function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max
    ? `${truncateToDisplayLength(text, max)}…`
    : text
}

/**
 * Official `wn` (@190910153):
 * `eEt(qP(y(e,n)).normalize("NFC").replace(/[\u0060\uff40\u02cb\u1fef\u2035]/g,"'").replace(p,""),n)`
 */
function sanitizeDetailText(text: string, max = 160): string {
  return truncateWithEllipsis(
    sanitizeForDisplay(sliceWithAnsiBoundaryRepair(text, max))
      .normalize('NFC')
      .replace(BACKTICK_VARIANT_RE, "'")
      .replace(STRAY_COMBINING_MARK_RE, ''),
    max,
  )
}

/** Official `st`/`Or` (@190578137) — text before the first separator. */
function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}

/**
 * Official `Ke`/`Be` exec result contract (@191407400 region): success →
 * `{code:0, exitCode:0}`; failure → `{code: exitCode ?? 1, error, exitCode}`
 * with `exitCode` left undefined on signal-kill/spawn failure; spawn throw →
 * `{stdout:'', stderr:'', code:1}`.
 */
export type OpenerExecResult = {
  stdout: string
  stderr: string
  code: number
  exitCode?: number
  error?: string
}

/** Result of a deep-link open attempt — official v276 `{opened,detail}` shape. */
export type DeepLinkOpenResult =
  | { opened: true }
  | { opened: false; detail: string }

const OPENER_TIMEOUT_MS = 10 * 60 * 1000

type ExecaFailureFields = { shortMessage?: string; signal?: string }

/** Official `Be` failure-message priority: shortMessage → signal → code. */
function getOpenerErrorMessage(
  result: ExecaFailureFields,
  code: number,
): string {
  if (result.shortMessage) {
    return result.shortMessage
  }
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(code)
}

/**
 * Runs a deep-link opener command and maps the outcome to the official
 * `Ke`/`Be` contract above.
 *
 * Deviation (documented): the official calls its shared exec wrapper
 * `Ke("xdg-open",[url],{useCwd:!0,useToolMemoryCgroup:!1})`. OCC's
 * `execFileNoThrow` collapses `exitCode` into `code` (`exitCode ?? 1`), which
 * loses the undefined-exitCode signal the official `D()` builder needs for the
 * "failed" (vs "exited N") form — so this local execa runner preserves the raw
 * `exitCode` exactly like the official wrapper does.
 */
async function runOpenerCommand(
  file: string,
  args: string[],
): Promise<OpenerExecResult> {
  try {
    const result = await execa(file, args, {
      cwd: getCwd(),
      timeout: OPENER_TIMEOUT_MS,
      reject: false,
    })
    if (!result.failed) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: 0,
        exitCode: 0,
      }
    }
    const code = result.exitCode ?? 1
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      code,
      exitCode: result.exitCode,
      error: getOpenerErrorMessage(
        result as unknown as ExecaFailureFields,
        code,
      ),
    }
  } catch {
    // Official spawn-throw fallback: empty output, code 1, no exitCode.
    return { stdout: '', stderr: '', code: 1 }
  }
}

/**
 * Official v276 `D(r,e)` (@204689707 chunk), byte-verified:
 * ```js
 * var v=200;
 * function D(r,e){let{code:o,exitCode:n,stderr:i,error:s}=e;
 *   if(o===0)return{opened:!0};
 *   let a=i||s;
 *   t(`Deep link opener ${r} failed: code ${o}, exitCode ${n??"undefined"}${a?`: ${a}`:""}`);
 *   let l=n===void 0?`\`${r}\` failed`:`\`${r}\` exited ${n}`,
 *       u=wn(Or(i.trim())||(n===void 0?s:"")||"",v).replace(/\.$/,"");
 *   return{opened:!1,detail:u.length===0?l:`${l}: ${u}`}}
 * ```
 */
export function buildDeepLinkOpenerResult(
  openerName: string,
  result: OpenerExecResult,
): DeepLinkOpenResult {
  const { code, exitCode, stderr, error } = result
  if (code === 0) {
    return { opened: true }
  }
  const context = stderr || error
  logForDebugging(
    `Deep link opener ${openerName} failed: code ${code}, exitCode ${exitCode ?? 'undefined'}${context ? `: ${context}` : ''}`,
  )
  const prefix =
    exitCode === undefined
      ? `\`${openerName}\` failed`
      : `\`${openerName}\` exited ${exitCode}`
  const detail = sanitizeDetailText(
    firstLine(stderr.trim()) || (exitCode === undefined ? (error ?? '') : ''),
    OPENER_DETAIL_MAX_LENGTH,
  ).replace(/\.$/, '')
  return {
    opened: false,
    detail: detail.length === 0 ? prefix : `${prefix}: ${detail}`,
  }
}

/**
 * Opens a deep link URL using the platform-specific mechanism.
 * Official v276 `f(r)`: logs `Opening deep link: ${url}`, runs the opener, and
 * returns the `D()`-built `{opened,detail}` result. The official linux binary
 * only ships the xdg-open branch (its dead darwin/win32 branches were removed
 * in v276); OCC keeps its live cross-platform branches and its live
 * no-opener fallback (`no deep link opener for ${platform}` — the official
 * v274 vestige hardcoded "linux").
 */
async function openDeepLink(deepLinkUrl: string): Promise<DeepLinkOpenResult> {
  const platform = process.platform
  logForDebugging(`Opening deep link: ${deepLinkUrl}`)

  if (platform === 'darwin') {
    if (isDevMode()) {
      // In dev mode, `open` launches a bare Electron binary (without app code)
      // because setAsDefaultProtocolClient registers just the Electron executable.
      // Use AppleScript to route the URL to the already-running Electron app.
      return buildDeepLinkOpenerResult(
        'osascript',
        await runOpenerCommand('osascript', [
          '-e',
          `tell application "Electron" to open location "${deepLinkUrl}"`,
        ]),
      )
    }
    return buildDeepLinkOpenerResult(
      'open',
      await runOpenerCommand('open', [deepLinkUrl]),
    )
  } else if (platform === 'linux') {
    return buildDeepLinkOpenerResult(
      'xdg-open',
      await runOpenerCommand('xdg-open', [deepLinkUrl]),
    )
  } else if (platform === 'win32') {
    // On Windows, use cmd /c start to open URLs
    return buildDeepLinkOpenerResult(
      'cmd',
      await runOpenerCommand('cmd', ['/c', 'start', '', deepLinkUrl]),
    )
  }

  return { opened: false, detail: `no deep link opener for ${platform}` }
}

/**
 * Build and open a deep link to resume the current session in Claude Desktop.
 * Official v276 `oEr()` (@204689604 chunk): install-status gate first
 * (not-installed / version-too-old each get their own byte-exact message),
 * then the open attempt whose failure embeds the `D()` detail.
 */
export async function openCurrentSessionInDesktop(): Promise<{
  success: boolean
  error?: string
  deepLinkUrl?: string
}> {
  const sessionId = getSessionId()
  const installStatus = await getDesktopInstallStatus()

  if (installStatus.status === 'not-installed') {
    return {
      success: false,
      error:
        'Claude Desktop is not installed. Install it from https://claude.ai/download',
    }
  }

  if (installStatus.status === 'version-too-old') {
    return {
      success: false,
      error: `Claude Desktop ${installStatus.version} is too old. Update to ${MIN_DESKTOP_VERSION} or later.`,
    }
  }

  // Build and open the deep link
  const deepLinkUrl = buildDesktopDeepLink(sessionId)
  const openResult = await openDeepLink(deepLinkUrl)

  // Official `if(!n.opened)` — explicit `=== false` keeps the discriminated-
  // union narrowing under this repo's `strict: false` tsc.
  if (openResult.opened === false) {
    return {
      success: false,
      error: `Couldn't open Claude Desktop (${openResult.detail}). Open Claude Desktop and run /desktop again.`,
      deepLinkUrl,
    }
  }

  return { success: true, deepLinkUrl }
}
