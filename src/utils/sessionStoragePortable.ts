/**
 * Portable session storage utilities.
 *
 * Pure Node.js — no internal dependencies on logging, experiments, or feature
 * flags. Shared between the CLI (src/utils/sessionStorage.ts) and the VS Code
 * extension (packages/claude-vscode/src/common-host/sessionStorage.ts).
 */

import type { UUID } from 'crypto'
import { open as fsOpen, readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

/** Size of the head/tail buffer for lite metadata reads. */
export const LITE_READ_BUF_SIZE = 65536

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

// ---------------------------------------------------------------------------
// JSON string field extraction — no full parse, works on truncated lines
// ---------------------------------------------------------------------------

/**
 * Unescape a JSON string value extracted as raw text.
 * Only allocates a new string when escape sequences are present.
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * Looks for `"key":"value"` or `"key": "value"` patterns.
 * Returns the first match, or undefined if not found.
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * Like extractJsonStringField but finds the LAST occurrence.
 * Useful for fields that are appended (customTitle, tag, etc.).
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

// ---------------------------------------------------------------------------
// Line-based JSONL field extraction — CC 2.1.224 binary-verified ports
// ---------------------------------------------------------------------------

/**
 * Port of the official `ndt`: scans JSONL text BACKWARDS line by line and
 * returns the string field `field` of the LAST line whose `"type"` equals
 * `type`. Lines are fully JSON-parsed (substring pre-filter first); malformed
 * lines are skipped. Used to read `relocatedCwd` from the newest
 * `"type":"relocated"` entry in a session file tail.
 */
export function extractLastTypedLineField(
  text: string,
  type: string,
  field: string,
): string | undefined {
  const typeMarker = `"type":"${type}"`
  const fieldMarker = `"${field}":`
  let end = text.length
  while (end > 0) {
    const lineStart = text.lastIndexOf('\n', end - 1)
    const line = text.slice(lineStart + 1, end)
    end = lineStart
    if (line.includes(typeMarker) && line.includes(fieldMarker)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed === 'object' && parsed !== null && parsed.type === type) {
          const value = parsed[field]
          if (typeof value === 'string') return value
        }
      } catch {
        // malformed line — keep scanning
      }
    }
    if (lineStart < 0) break
  }
  return undefined
}

/**
 * Port of the official `loo`: scans JSONL text FORWARDS line by line and
 * returns the string field `field` of the FIRST line that carries it. Lines
 * are fully JSON-parsed (substring pre-filter first); malformed lines are
 * skipped. Used to read the session's original `cwd` from the head.
 */
export function extractFirstLineField(
  text: string,
  field: string,
): string | undefined {
  const fieldMarker = `"${field}":`
  let start = 0
  while (start < text.length) {
    const lineEnd = text.indexOf('\n', start)
    const line = lineEnd < 0 ? text.slice(start) : text.slice(start, lineEnd)
    start = lineEnd < 0 ? text.length : lineEnd + 1
    if (line.includes(fieldMarker)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed === 'object' && parsed !== null) {
          const value = parsed[field]
          if (typeof value === 'string') return value
        }
      } catch {
        // malformed line — keep scanning
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// First prompt extraction from head chunk
// ---------------------------------------------------------------------------

/**
 * Pattern matching auto-generated or system messages that should be skipped
 * when looking for the first meaningful user prompt. Matches anything that
 * starts with a lowercase XML-like tag (IDE context, hook output, task
 * notifications, channel messages, etc.) or a synthetic interrupt marker.
 */
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * Extracts the first meaningful user prompt from a JSONL head chunk.
 *
 * Skips tool_result messages, isMeta, isCompactSummary, command-name messages,
 * and auto-generated patterns (session hooks, tick, IDE metadata, etc.).
 * Truncates to 200 chars.
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue
    if (
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    )
      continue

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) continue

        // Skip slash-command messages but remember first as fallback
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        // Format bash input with ! prefix before the generic XML skip
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '\u2026'
        }
        return result
      }
    } catch {
    }
  }
  if (commandFallback) return commandFallback
  return ''
}

// ---------------------------------------------------------------------------
// File I/O — read head and tail of a file
// ---------------------------------------------------------------------------

/**
 * Reads the first and last LITE_READ_BUF_SIZE bytes of a file.
 *
 * For small files where head covers tail, `tail === head`.
 * Accepts a shared Buffer to avoid per-file allocation overhead.
 * Returns `{ head: '', tail: '' }` on any error.
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }

      const head = buf.toString('utf8', 0, headResult.bytesRead)

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return { head: '', tail: '' }
  }
}

export type LiteSessionFile = {
  mtime: number
  size: number
  head: string
  tail: string
}

/**
 * Opens a single session file, stats it, and reads head + tail in one fd.
 * Allocates its own buffer — safe for concurrent use with Promise.all.
 * Returns null on any error.
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionFile | null> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const stat = await fh.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return null

      const head = buf.toString('utf8', 0, headResult.bytesRead)
      const tailOffset = Math.max(0, stat.size - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { mtime: stat.mtime.getTime(), size: stat.size, head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

/**
 * Maximum length for a single filesystem path component (directory or file name).
 * Most filesystems (ext4, APFS, NTFS) limit individual components to 255 bytes.
 * We use 200 to leave room for the hash suffix and separator.
 */
export const MAX_SANITIZED_LENGTH = 200

/**
 * djb2 hash suffix for truncated path components. CC 2.1.224 binary-verified
 * (`GHg`/`hut`): the official ALWAYS uses `Math.abs(djb2(name)).toString(36)`
 * here — never Bun.hash (wyhash), which is runtime-specific and produced
 * different directory suffixes under Bun vs Node. djb2 is deterministic
 * across runtimes, so a directory created by one runtime is found by the
 * other without needing the content-verification fallback.
 */
function pathHashSuffix(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

/**
 * Makes a string safe for use as a directory or file name.
 * Replaces all non-alphanumeric characters with hyphens.
 * This ensures compatibility across all platforms, including Windows
 * where characters like colons are reserved.
 *
 * For deeply nested paths that would exceed filesystem limits (255 bytes),
 * truncates to MAX_SANITIZED_LENGTH and appends a djb2 hash suffix for
 * uniqueness — byte-for-byte the official `Gw` (CC 2.1.224).
 *
 * @param name - The string to make safe (e.g., '/Users/foo/my-project' or 'plugin:name:server')
 * @returns A safe name (e.g., '-Users-foo-my-project' or 'plugin-name-server')
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${pathHashSuffix(name)}`
}

// ---------------------------------------------------------------------------
// CLAUDE_CODE_PROJECT_DIR_NAME override (CC 2.1.234 binary-verified)
// ---------------------------------------------------------------------------

/**
 * Valid project-dir-name override pattern (CC 2.1.234 `afy`, byte-verified):
 * 1–64 chars of [A-Za-z0-9_-].
 */
const PROJECT_DIR_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Windows reserved device names rejected as override names
 * (CC 2.1.234 `lfy`, byte-verified).
 */
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * Validates a CLAUDE_CODE_PROJECT_DIR_NAME value (CC 2.1.234 `yws`,
 * byte-verified): returns the name when non-empty, matching the pattern, and
 * not a Windows reserved name; otherwise undefined.
 */
export function validateProjectDirName(
  name: string | undefined,
): string | undefined {
  if (!name || !PROJECT_DIR_NAME_PATTERN.test(name) || WINDOWS_RESERVED_NAMES.test(name)) {
    return undefined
  }
  return name
}

/**
 * Memoized CLAUDE_CODE_PROJECT_DIR_NAME override lookup (CC 2.1.234 `w8c`,
 * byte-verified semantics). The override only applies when CLAUDE_CONFIG_DIR
 * is set. The cache key is `${CLAUDE_CONFIG_DIR}\x00${CLAUDE_CODE_PROJECT_DIR_NAME}`
 * (CC 2.1.234 `cfy`), so env changes mid-process re-evaluate.
 */
const projectDirNameOverrideCache = new Map<string, string | undefined>()

export function getProjectDirNameOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!env.CLAUDE_CONFIG_DIR) return undefined
  const cacheKey = `${env.CLAUDE_CONFIG_DIR ?? ''}\x00${env.CLAUDE_CODE_PROJECT_DIR_NAME ?? ''}`
  if (projectDirNameOverrideCache.has(cacheKey)) {
    return projectDirNameOverrideCache.get(cacheKey)
  }
  const result = validateProjectDirName(env.CLAUDE_CODE_PROJECT_DIR_NAME)
  projectDirNameOverrideCache.set(cacheKey, result)
  return result
}

/** Test-only: clear the override memoization cache. */
export function clearProjectDirNameOverrideCacheForTesting(): void {
  projectDirNameOverrideCache.clear()
}

/**
 * The project directory NAME for a path (CC 2.1.234 `sN`, byte-verified
 * semantics): the CLAUDE_CODE_PROJECT_DIR_NAME override when active
 * (CLAUDE_CONFIG_DIR set + valid override value), else the default
 * sanitizePath(path) name.
 */
export function getProjectDirName(
  projectDir: string,
  env?: NodeJS.ProcessEnv,
): string {
  return getProjectDirNameOverride(env) ?? sanitizePath(projectDir)
}

// ---------------------------------------------------------------------------
// Project directory discovery (shared by listSessions & getSessionMessages)
// ---------------------------------------------------------------------------

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), getProjectDirName(projectDir))
}

/**
 * Resolves a directory path to its canonical form using realpath + NFC
 * normalization. Falls back to NFC-only if realpath fails (e.g., the
 * directory doesn't exist yet). Ensures symlinked paths (e.g.,
 * /tmp → /private/tmp on macOS) resolve to the same project directory.
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

/**
 * Content-verification for truncated project directories — port of the
 * official `gar` (CC 2.1.224, byte-verified). A prefix match on the directory
 * NAME alone is ambiguous: two different long paths share the same 200-char
 * sanitized prefix, and hash suffixes differ across writers/versions. The
 * official resolves the ambiguity by reading each `.jsonl` in the candidate
 * directory and checking its recorded working directory: the newest
 * `"type":"relocated"` entry's `relocatedCwd` wins, else the first `cwd`
 * field in the head. Both values are compared in sanitized
 * (non-alphanumeric → '-') form against the sanitized requested path.
 *
 * Returns true if any session file in `dir` was recorded for `projectPath`.
 */
export async function dirMatchesProjectPath(
  dir: string,
  projectPath: string,
  caseInsensitive = false,
): Promise<boolean> {
  const want = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  let dirents: Awaited<ReturnType<typeof readdir>>
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of dirents) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const lite = await readSessionLite(join(dir, entry.name))
    if (lite === null) continue
    const recordedCwd =
      extractLastTypedLineField(lite.tail, 'relocated', 'relocatedCwd') ??
      extractFirstLineField(lite.head, 'cwd')
    if (recordedCwd === undefined) continue
    const candidate = recordedCwd.replace(/[^a-zA-Z0-9]/g, '-')
    if (
      caseInsensitive
        ? candidate.toLowerCase() === want.toLowerCase()
        : candidate === want
    ) {
      return true
    }
  }
  return false
}

/**
 * Finds the project directory for a given path, tolerating hash mismatches
 * for long paths (>200 chars). Port of the official filesystem branch of
 * `uN` + `vXi` (CC 2.1.224, byte-verified): try the exact directory first;
 * for truncated names, scan the projects dir for directories starting with
 * the 200-char prefix + '-' and accept a candidate ONLY after the `gar`
 * content check confirms a session inside was recorded for this path. The
 * pre-2.1.224 prefix-only fallback could return a directory belonging to a
 * different project that shared the same 200-char prefix.
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | undefined> {
  const exact = getProjectDir(projectPath)
  try {
    await readdir(exact)
    return exact
  } catch {
    // Exact match failed — for short paths this means no sessions exist.
    // For long paths, try prefix matching with content verification.
    const sanitized = sanitizePath(projectPath)
    if (sanitized.length <= MAX_SANITIZED_LENGTH) {
      return undefined
    }
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    const projectsDir = getProjectsDir()
    try {
      const dirents = await readdir(projectsDir, { withFileTypes: true })
      for (const d of dirents) {
        if (!d.isDirectory() || !d.name.startsWith(prefix + '-')) continue
        const candidate = join(projectsDir, d.name)
        if (candidate === exact) continue
        if (await dirMatchesProjectPath(candidate, projectPath)) {
          return candidate
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Resolve a sessionId to its on-disk JSONL file path.
 *
 * When `dir` is provided: canonicalize it, look in that project's directory
 * (with findProjectDir fallback for Bun/Node hash mismatches), then fall back
 * to sibling git worktrees. `projectPath` in the result is the canonical
 * user-facing directory the file was found under.
 *
 * When `dir` is omitted: scan all project directories under ~/.claude/projects/.
 * `projectPath` is undefined in this case (no meaningful project path to report).
 *
 * Existence is checked by stat (operate-then-catch-ENOENT, no existsSync).
 * Zero-byte files are treated as not-found so callers continue searching past
 * a truncated copy to find a valid one in a sibling directory.
 *
 * `fileSize` is returned so callers (loadSessionBuffer) don't need to re-stat.
 *
 * Shared by getSessionInfoImpl and getSessionMessagesImpl — the caller
 * invokes its own reader (readSessionLite / loadSessionBuffer) on the
 * resolved path.
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<
  | { filePath: string; projectPath: string | undefined; fileSize: number }
  | undefined
> {
  const fileName = `${sessionId}.jsonl`

  if (dir) {
    const canonical = await canonicalizePath(dir)
    const projectDir = await findProjectDir(canonical)
    if (projectDir) {
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0)
          return { filePath, projectPath: canonical, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — keep searching
      }
    }
    // Worktree fallback — sessions may live under a different worktree root
    let worktreePaths: string[]
    try {
      worktreePaths = await getWorktreePathsPortable(canonical)
    } catch {
      worktreePaths = []
    }
    for (const wt of worktreePaths) {
      if (wt === canonical) continue
      const wtProjectDir = await findProjectDir(wt)
      if (!wtProjectDir) continue
      const filePath = join(wtProjectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0) return { filePath, projectPath: wt, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — keep searching
      }
    }
    return undefined
  }

  // No dir — scan all project directories
  const projectsDir = getProjectsDir()
  let dirents: string[]
  try {
    dirents = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const name of dirents) {
    const filePath = join(projectsDir, name, fileName)
    try {
      const s = await stat(filePath)
      if (s.size > 0)
        return { filePath, projectPath: undefined, fileSize: s.size }
    } catch {
      // ENOENT/ENOTDIR — not in this project, keep scanning
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Compact-boundary chunked read (shared by loadTranscriptFile & SDK getSessionMessages)
// ---------------------------------------------------------------------------

/** Chunk size for the forward transcript reader. 1 MB balances I/O calls vs buffer growth. */
const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024

/**
 * File size below which precompact filtering is skipped.
 * Large sessions (>5 MB) almost always have compact boundaries — they got big
 * because of many turns triggering auto-compact.
 */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

/** Marker bytes searched for when locating the boundary. Lazy: allocated on
 * first use, not at module load. Most sessions never resume. */
let _compactBoundaryMarker: Buffer | undefined
function compactBoundaryMarker(): Buffer {
  return (_compactBoundaryMarker ??= Buffer.from('"compact_boundary"'))
}

/**
 * Confirm a byte-matched line is a real compact_boundary (marker can appear
 * inside user content) and check for preservedSegment.
 */
function parseBoundaryLine(
  line: string,
): { hasPreservedSegment: boolean } | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: string
      subtype?: string
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') {
      return null
    }
    return {
      hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
    }
  } catch {
    return null
  }
}

/**
 * Single forward chunked read for the --resume load path. Attr-snap lines
 * are skipped at the fd level; compact boundaries truncate in-stream. Peak
 * is the output size, not the file size.
 *
 * The surviving (last) attr-snap is appended at EOF instead of in-place;
 * restoreAttributionStateFromSnapshots only reads [length-1] so position
 * doesn't matter.
 */

type Sink = { buf: Buffer; len: number; cap: number }

function sinkWrite(s: Sink, src: Buffer, start: number, end: number): void {
  const n = end - start
  if (n <= 0) return
  if (s.len + n > s.buf.length) {
    const grown = Buffer.allocUnsafe(
      Math.min(Math.max(s.buf.length * 2, s.len + n), s.cap),
    )
    s.buf.copy(grown, 0, 0, s.len)
    s.buf = grown
  }
  src.copy(s.buf, s.len, start, end)
  s.len += n
}

function hasPrefix(
  src: Buffer,
  prefix: Buffer,
  at: number,
  end: number,
): boolean {
  return (
    end - at >= prefix.length &&
    src.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0
  )
}

const ATTR_SNAP_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')
const LF = 0x0a
const LF_BYTE = Buffer.from([LF])
const BOUNDARY_SEARCH_BOUND = 256 // marker sits ~28 bytes in; 256 is slack

type LoadState = {
  out: Sink
  boundaryStartOffset: number
  hasPreservedSegment: boolean
  lastSnapSrc: Buffer | null // most-recent attr-snap, appended at EOF
  lastSnapLen: number
  lastSnapBuf: Buffer | undefined
  bufFileOff: number // file offset of buf[0]
  carryLen: number
  carryBuf: Buffer | undefined
  straddleSnapCarryLen: number // per-chunk; reset by processStraddle
  straddleSnapTailEnd: number
}

// Line spanning the chunk seam. 0 = fall through to concat.
function processStraddle(
  s: LoadState,
  chunk: Buffer,
  bytesRead: number,
): number {
  s.straddleSnapCarryLen = 0
  s.straddleSnapTailEnd = 0
  if (s.carryLen === 0) return 0
  const cb = s.carryBuf!
  const firstNl = chunk.indexOf(LF)
  if (firstNl === -1 || firstNl >= bytesRead) return 0
  const tailEnd = firstNl + 1
  if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
    s.straddleSnapCarryLen = s.carryLen
    s.straddleSnapTailEnd = tailEnd
    s.lastSnapSrc = null
  } else if (s.carryLen < ATTR_SNAP_PREFIX.length) {
    return 0 // too short to rule out attr-snap
  } else {
    if (hasPrefix(cb, SYSTEM_PREFIX, 0, s.carryLen)) {
      const hit = parseBoundaryLine(
        cb.toString('utf-8', 0, s.carryLen) +
          chunk.toString('utf-8', 0, firstNl),
      )
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
      }
    }
    sinkWrite(s.out, cb, 0, s.carryLen)
    sinkWrite(s.out, chunk, 0, tailEnd)
  }
  s.bufFileOff += s.carryLen + tailEnd
  s.carryLen = 0
  return tailEnd
}

// Strip attr-snaps, truncate on boundaries. Kept lines write as runs.
function scanChunkLines(
  s: LoadState,
  buf: Buffer,
  boundaryMarker: Buffer,
): { lastSnapStart: number; lastSnapEnd: number; trailStart: number } {
  let boundaryAt = buf.indexOf(boundaryMarker)
  let runStart = 0
  let lineStart = 0
  let lastSnapStart = -1
  let lastSnapEnd = -1
  let nl = buf.indexOf(LF)
  while (nl !== -1) {
    const lineEnd = nl + 1
    if (boundaryAt !== -1 && boundaryAt < lineStart) {
      boundaryAt = buf.indexOf(boundaryMarker, lineStart)
    }
    if (hasPrefix(buf, ATTR_SNAP_PREFIX, lineStart, lineEnd)) {
      sinkWrite(s.out, buf, runStart, lineStart)
      lastSnapStart = lineStart
      lastSnapEnd = lineEnd
      runStart = lineEnd
    } else if (
      boundaryAt >= lineStart &&
      boundaryAt < Math.min(lineStart + BOUNDARY_SEARCH_BOUND, lineEnd)
    ) {
      const hit = parseBoundaryLine(buf.toString('utf-8', lineStart, nl))
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true // don't truncate; preserved msgs already in output
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff + lineStart
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
        lastSnapStart = -1
        s.straddleSnapCarryLen = 0
        runStart = lineStart
      }
      boundaryAt = buf.indexOf(
        boundaryMarker,
        boundaryAt + boundaryMarker.length,
      )
    }
    lineStart = lineEnd
    nl = buf.indexOf(LF, lineStart)
  }
  sinkWrite(s.out, buf, runStart, lineStart)
  return { lastSnapStart, lastSnapEnd, trailStart: lineStart }
}

// In-buf snap wins over straddle (later in file). carryBuf still valid here.
function captureSnap(
  s: LoadState,
  buf: Buffer,
  chunk: Buffer,
  lastSnapStart: number,
  lastSnapEnd: number,
): void {
  if (lastSnapStart !== -1) {
    s.lastSnapLen = lastSnapEnd - lastSnapStart
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    buf.copy(s.lastSnapBuf, 0, lastSnapStart, lastSnapEnd)
    s.lastSnapSrc = s.lastSnapBuf
  } else if (s.straddleSnapCarryLen > 0) {
    s.lastSnapLen = s.straddleSnapCarryLen + s.straddleSnapTailEnd
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    s.carryBuf!.copy(s.lastSnapBuf, 0, 0, s.straddleSnapCarryLen)
    chunk.copy(s.lastSnapBuf, s.straddleSnapCarryLen, 0, s.straddleSnapTailEnd)
    s.lastSnapSrc = s.lastSnapBuf
  }
}

function captureCarry(s: LoadState, buf: Buffer, trailStart: number): void {
  s.carryLen = buf.length - trailStart
  if (s.carryLen > 0) {
    if (s.carryBuf === undefined || s.carryLen > s.carryBuf.length) {
      s.carryBuf = Buffer.allocUnsafe(s.carryLen)
    }
    buf.copy(s.carryBuf, 0, trailStart, buf.length)
  }
}

function finalizeOutput(s: LoadState): void {
  if (s.carryLen > 0) {
    const cb = s.carryBuf!
    if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
      s.lastSnapSrc = cb
      s.lastSnapLen = s.carryLen
    } else {
      sinkWrite(s.out, cb, 0, s.carryLen)
    }
  }
  if (s.lastSnapSrc) {
    if (s.out.len > 0 && s.out.buf[s.out.len - 1] !== LF) {
      sinkWrite(s.out, LF_BYTE, 0, 1)
    }
    sinkWrite(s.out, s.lastSnapSrc, 0, s.lastSnapLen)
  }
}

export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}> {
  const boundaryMarker = compactBoundaryMarker()
  const CHUNK_SIZE = TRANSCRIPT_READ_CHUNK_SIZE

  const s: LoadState = {
    out: {
      // Gated callers enter with fileSize > 5MB, so min(fileSize, 8MB) lands
      // in [5, 8]MB; large boundaryless sessions (24-31MB output) take 2
      // grows. Ungated callers (attribution.ts) pass small files too — the
      // min just right-sizes the initial buf, no grows.
      buf: Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024 * 1024)),
      len: 0,
      // +1: finalizeOutput may insert one LF between a non-LF-terminated
      // carry and the reordered last attr-snap (crash-truncated file).
      cap: fileSize + 1,
    },
    boundaryStartOffset: 0,
    hasPreservedSegment: false,
    lastSnapSrc: null,
    lastSnapLen: 0,
    lastSnapBuf: undefined,
    bufFileOff: 0,
    carryLen: 0,
    carryBuf: undefined,
    straddleSnapCarryLen: 0,
    straddleSnapTailEnd: 0,
  }

  const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
  const fd = await fsOpen(filePath, 'r')
  try {
    let filePos = 0
    while (filePos < fileSize) {
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(CHUNK_SIZE, fileSize - filePos),
        filePos,
      )
      if (bytesRead === 0) break
      filePos += bytesRead

      const chunkOff = processStraddle(s, chunk, bytesRead)

      let buf: Buffer
      if (s.carryLen > 0) {
        const bufLen = s.carryLen + (bytesRead - chunkOff)
        buf = Buffer.allocUnsafe(bufLen)
        s.carryBuf!.copy(buf, 0, 0, s.carryLen)
        chunk.copy(buf, s.carryLen, chunkOff, bytesRead)
      } else {
        buf = chunk.subarray(chunkOff, bytesRead)
      }

      const r = scanChunkLines(s, buf, boundaryMarker)
      captureSnap(s, buf, chunk, r.lastSnapStart, r.lastSnapEnd)
      captureCarry(s, buf, r.trailStart)
      s.bufFileOff += r.trailStart
    }
    finalizeOutput(s)
  } finally {
    await fd.close()
  }

  return {
    boundaryStartOffset: s.boundaryStartOffset,
    postBoundaryBuf: s.out.buf.subarray(0, s.out.len),
    hasPreservedSegment: s.hasPreservedSegment,
  }
}
