/**
 * 2.1.281 PORT #112: `--agents <json-or-file>` resolution helpers.
 *
 * Mirrors the official v281 binary chain, byte-verified from the linux-x64
 * ELF:
 *   - `oBt` shape-sniff (inline JSON vs file path)          → isInlineAgentsJson
 *   - `qWr` guarded file read (open flags `Hct`, stat guards
 *     `Olt`, hard-link guard `Gko`, bounded chunked read
 *     `Oct`, post-read size check `zWn`, dev/ino TOCTOU
 *     re-check, CRLF→LF)                                   → readAgentsFile
 *   - `Tvt` JSON validator (BOM strip `Ko`, 20-line issue
 *     cap `fyt`, message sanitizer `vg`, dash-name check)   → validateAgentsJson
 *
 * Kept in its own module so the parse-site logic in main.tsx stays thin and
 * the guards are unit-testable without booting the CLI.
 */
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { open, realpath, stat } from 'node:fs/promises'
import { AgentsJsonSchema } from '../tools/AgentTool/loadAgentsDir.js'
import { errorMessage } from './errors.js'
import { jsonParse } from './slowOperations.js'

/** Official `i` size cap for the --agents file read (256 MiB). */
export const AGENTS_FILE_MAX_BYTES = 268_435_456

/** Official `Oct` chunk size for the bounded read loop. */
const AGENTS_FILE_READ_CHUNK_BYTES = 65_536

/** Official `Hct` open flags: read-only, never block, never grab a tty. */
const AGENTS_FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY

/** Official `uEe` — max issue lines before the "…and N more" cap (`fyt`). */
const AGENTS_ISSUE_LINE_CAP = 20

/** Official `VWr` gate error — verbatim. */
export const AGENTS_FILE_PATH_REQUIRES_PRINT_ERROR =
  'Error: --agents takes a JSON object, or a file path only with --print (-p). Pass the agents as inline JSON, or run with -p to read them from a file.'

/** Internal code for the dev/ino TOCTOU mismatch (mapped by readAgentsFile). */
const ERR_AGENTS_FILE_CHANGED = 'ERR_AGENTS_FILE_CHANGED'

/**
 * Result of readAgentsFile. Deliberately a single object type with optional
 * fields instead of an `{ ok: true } | { ok: false }` discriminated union:
 * this repo's compiler (tsc 6.0.2 under strict:false) does not narrow
 * boolean-literal discriminants (TS2339 on the sibling branch's fields), so
 * consumers check `.ok` and read the fields directly.
 */
export type AgentsFileReadResult = {
  ok: boolean
  /** File text (CRLF normalized to LF) — present when ok. */
  json?: string
  /** The path as passed on the command line — present when ok. */
  filePath?: string
  /** realpath() of the file actually read — present when ok. */
  realPath?: string
  /** Official user-facing error message, ready for stderr — present when !ok. */
  error?: string
}

/** Official `Ko` — strip a leading UTF-8 BOM. */
const UTF8_BOM = '\uFEFF'
function stripBom(value: string): string {
  return value.startsWith(UTF8_BOM) ? value.slice(1) : value
}

/**
 * Official `vg` — sanitize untrusted text (agent names, JSON error messages,
 * issue paths) before it is echoed back: strip control/format characters,
 * collapse whitespace, cap at 200 chars. Prevents forged/terminal-escape
 * content in error output.
 */
function sanitizeAgentsText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Official `fyt` — join issue lines, capped at AGENTS_ISSUE_LINE_CAP. */
function capIssueLines(lines: string[]): string {
  if (lines.length <= AGENTS_ISSUE_LINE_CAP) {
    return lines.join('\n')
  }
  return [
    ...lines.slice(0, AGENTS_ISSUE_LINE_CAP),
    `…and ${lines.length - AGENTS_ISSUE_LINE_CAP} more`,
  ].join('\n')
}

/**
 * Official `oBt` shape-sniff: a --agents value is inline JSON when (after
 * BOM strip + leading-whitespace trim) it starts with "{" or parses as JSON.
 * Anything else is treated as a file path.
 */
export function isInlineAgentsJson(value: string): boolean {
  const stripped = stripBom(value).trimStart()
  if (stripped.startsWith('{')) {
    return true
  }
  try {
    return jsonParse(stripped) !== null
  } catch {
    return false
  }
}

/**
 * Official `Olt` + `Gko` stat guards, throwing coded errors that
 * mapAgentsFileReadError renders into the official user-facing messages.
 */
function assertReadableAgentsFile(stats: {
  isDirectory(): boolean
  isFile(): boolean
  size: bigint
  nlink: bigint
}): void {
  if (stats.isDirectory()) {
    throw Object.assign(
      new Error('EISDIR: illegal operation on a directory, read'),
      { code: 'EISDIR', errno: -21, syscall: 'read' },
    )
  }
  if (!stats.isFile()) {
    throw Object.assign(
      new Error('Not a regular file (device, FIFO, or socket)'),
      { code: 'ERR_NOT_REGULAR_FILE' },
    )
  }
  if (stats.size > BigInt(AGENTS_FILE_MAX_BYTES)) {
    throw Object.assign(new Error('File exceeds maxBytes limit'), {
      code: 'ERR_FILE_TOO_LARGE',
      size: stats.size,
      maxBytes: AGENTS_FILE_MAX_BYTES,
    })
  }
  if (Number(stats.nlink) > 1) {
    throw Object.assign(new Error('File has more than one hard link'), {
      code: 'ERR_MULTIPLE_LINKS',
    })
  }
}

/**
 * Official `Oct` — bounded positional read of at most `maxBytes`, in
 * AGENTS_FILE_READ_CHUNK_BYTES chunks; stops at the first zero-length read.
 */
async function readBoundedBytes(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let position = 0
  while (position < maxBytes) {
    const buffer = Buffer.allocUnsafe(
      Math.min(AGENTS_FILE_READ_CHUNK_BYTES, maxBytes - position),
    )
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) {
      break
    }
    chunks.push(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return Buffer.concat(chunks, position)
}

/** Maps coded read failures to the official user-facing error strings. */
function mapAgentsFileReadError(error: unknown, filePath: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return `Error: --agents file not found: ${filePath} (a value that is not a JSON object is read as a file path)`
  }
  if (code === ERR_AGENTS_FILE_CHANGED) {
    return `Error: --agents file changed while it was read: ${filePath}`
  }
  if (code === 'ERR_FILE_TOO_LARGE') {
    return `Error: --agents file is larger than ${AGENTS_FILE_MAX_BYTES} bytes: ${filePath}`
  }
  if (code === 'ERR_MULTIPLE_LINKS') {
    return `Error: --agents file has more than one hard link: ${filePath} (its other names are not write-protected; pass a file with one name)`
  }
  return `Error reading --agents file ${filePath}: ${errorMessage(error)}`
}

/**
 * Test seam for the dev/ino TOCTOU re-check: resolves the real path and
 * re-stats it. Production default; tests may inject a diverging re-stat to
 * exercise the "changed while it was read" branch deterministically
 * (mock.module('node:fs/promises') deadlocks Bun's loader).
 *
 * @internal Exported for testing
 */
export type AgentsFileReStat = (
  realPath: string,
) => Promise<{ dev: bigint; ino: bigint } | null>

const defaultReStat: AgentsFileReStat = async realPath => {
  const stats = await stat(realPath, { bigint: true }).catch(() => null)
  return stats === null ? null : { dev: stats.dev, ino: stats.ino }
}

/**
 * Official `qWr` — guarded read of the --agents file. Returns the file text
 * (CRLF normalized to LF, per official `zMt`) as `json` plus the resolved
 * `realPath`, or `{ ok: false, error }` with the official message ready for
 * stderr. Guards, in official order:
 *   1. open with O_RDONLY|O_NONBLOCK|O_NOCTTY (never blocks on FIFOs/tty)
 *   2. fstat guards: directory / non-regular / oversized / nlink > 1
 *   3. realpath + dev/ino re-check (TOCTOU: file swapped while opening)
 *   4. bounded chunked read of cap+1 bytes, then post-read size check
 */
export async function readAgentsFile(
  filePath: string,
  reStat: AgentsFileReStat = defaultReStat,
): Promise<AgentsFileReadResult> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, AGENTS_FILE_OPEN_FLAGS)
    const handleStats = await handle.stat({ bigint: true })
    assertReadableAgentsFile(handleStats)

    const realPath = await realpath(filePath).catch(() => filePath)
    const realStats = await reStat(realPath)
    if (
      realStats !== null &&
      (realStats.dev !== handleStats.dev || realStats.ino !== handleStats.ino)
    ) {
      throw Object.assign(new Error('File changed while it was read'), {
        code: ERR_AGENTS_FILE_CHANGED,
      })
    }

    const content = await readBoundedBytes(handle, AGENTS_FILE_MAX_BYTES + 1)
    if (content.length > AGENTS_FILE_MAX_BYTES) {
      throw Object.assign(new Error('File exceeds maxBytes limit'), {
        code: 'ERR_FILE_TOO_LARGE',
        size: BigInt(content.length),
        maxBytes: AGENTS_FILE_MAX_BYTES,
      })
    }
    return {
      ok: true,
      json: content.toString('utf8').replaceAll('\r\n', '\n'),
      filePath,
      realPath,
    }
  } catch (error) {
    return { ok: false, error: mapAgentsFileReadError(error, filePath) }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Official `Tvt` — validate the raw --agents JSON text. Returns null when
 * valid, otherwise the details block (already line-capped and sanitized) that
 * main.tsx embeds into `Error: Invalid --agents configuration:\n${details}`.
 */
export function validateAgentsJson(value: string): string | null {
  let parsed: unknown
  try {
    parsed = jsonParse(stripBom(value))
  } catch (error) {
    return `invalid JSON: ${sanitizeAgentsText(errorMessage(error))}`
  }
  const result = AgentsJsonSchema().safeParse(parsed)
  if (!result.success) {
    return capIssueLines(
      result.error.issues.map(issue =>
        issue.path.length > 0
          ? `${sanitizeAgentsText(issue.path.join('.'))}: ${issue.message}`
          : issue.message,
      ),
    )
  }
  const dashNames = Object.keys(result.data).filter(name =>
    name.startsWith('-'),
  )
  if (dashNames.length > 0) {
    return capIssueLines(
      dashNames.map(
        name => `${sanitizeAgentsText(name)}: agent names must not start with '-'`,
      ),
    )
  }
  return null
}
