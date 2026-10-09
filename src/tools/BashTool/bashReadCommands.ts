import type { ToolPermissionContext } from '../../Tool.js'
import { detectFileEncoding } from '../../utils/file.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath } from '../../utils/path.js'
import {
  filterControlOperators,
  splitCommandWithOperators,
} from '../../utils/bash/commands.js'
import { isFileReadDenied } from '../../utils/permissions/readDeny.js'

/**
 * CC 2.1.293 changelog #29 — "Path-scoped rules + nested CLAUDE.md not loading
 * when Claude views a file with a single-file cat/head/tail/sed -n/grep command
 * in the Bash tool instead of Read".
 *
 * Byte-verbatim port of the official 2.1.293 (vver) Bash post-exec read
 * recorder. The compiled ELF is the source of truth (aligning-with-official-binary
 * skill); minified official identifiers are kept in comments for traceability:
 *
 *   TBr  @216611223 -> parseBashReadCommands   (top-level condition set)
 *   EBr             -> parseSed                (sed -n '<a,b>p' / '<a>p')
 *   CBr + RBr       -> parseCatFamily          (cat/nl/bat/batcat)
 *   xBr + gRn       -> parseHead               (head, default 10 lines)
 *   ABr + gRn       -> parseTail               (tail, default 10 lines)
 *   NBr             -> parseGrepFamily         (grep/egrep/fgrep/rg)
 *   FBr  @216614918 -> sliceBashReadContent    (tail / start-end line slicing)
 *   _Rn  @216615382 -> recordBashReadFiles     (6-param post-exec recorder)
 *   cRn  @216615924 -> fireNestedMemoryTrigger (trigger fire, read-deny gated)
 *   AH   @208866471 -> isFileReadDenied        (read-deny predicate)
 *   Ou              -> tokenizeSegment         (quote-aware tokenizer)
 *   kd              -> splitSegments           (control-operator segment split)
 *   Je              -> expandPath              (path resolver)
 *   se              -> getFsImplementation     (fs impl)
 *   MH              -> triggers.add            (nested-memory trigger insert)
 *
 * THE 292 BUG (why #29 exists): the pre-fix recorder's already-recorded
 * early-return path did NOT fire the nested-memory trigger, so a file Claude
 * had ALREADY read via Bash (or Read) never (re)injected its nested CLAUDE.md /
 * path-scoped rules when viewed again with cat/head/tail. vver fires
 * `cRn(h,z)` on BOTH the early-return path and the fresh-read path.
 *
 * FIDELITY: parser tightening (which commands are recognized) and trigger
 * wiring (firing nestedMemoryAttachmentTriggers) land together — recognition is
 * never widened without the trigger seam.
 *
 * OCC divergences (documented, behavior-preserving):
 * - The official threads `permissions` as a thunk on ToolUseContext
 *   (`e.permissions()` in cRn); OCC has no `permissions()` method on
 *   ToolUseContext, so the call site supplies `() => getAppState()
 *   .toolPermissionContext`. BashReadTriggerContext.permissions is that thunk.
 * - The official sanitizer `Ih` (content massaging before slicing) is
 *   collision-ambiguous in the binary; OCC follows its existing
 *   detectFileEncoding+readFile pattern (same as FileReadTool and the pre-#29
 *   BashTool recorder) rather than force an ambiguous port.
 * - The official `_Rn` persists `contentNotInModelContext` on the FileState
 *   entry. OCC's FileState type has no such field and nothing consumes it
 *   (fileStateGuard.ts:46), so the flag is threaded for signature fidelity but
 *   NOT persisted.
 */

// ─── constants (verbatim: kBr/SBr/bBr/wBr/vBr before TBr @216611100) ─────────

/** kBr — head default line count. */
const HEAD_DEFAULT_LINES = 10
/** SBr — tail default line count. */
const TAIL_DEFAULT_LINES = 10
/** bBr — sed `N,Mp` range. */
const SED_RANGE_RE = /^(\d+),(\d+)p$/
/** wBr — sed `Np` single line. */
const SED_LINE_RE = /^(\d+)p$/
/** vBr — benign leading commands allowed to co-occur in a multi-segment chain. */
const BENIGN_SEGMENT_RE = /^\s*(echo|printf|true|:)\b/

/** 10 MiB — the official `_Rn` stat-size cap (`V.size>10485760`). */
export const BASH_READ_MAX_FILE_BYTES = 10_485_760

// ─── types ─────────────────────────────────────────────────────────────────

/**
 * A recognized single-file read spec (the official handler return shape).
 * `startLine`/`endLine` drive FBr's start-end branch; `tailLines` drives its
 * tail branch; `requiresExitZero` gates grep-family on exit code 0;
 * `contentNotInModelContext` marks grep-family (content shown as matches, not
 * the whole file) — threaded for fidelity, not persisted by OCC (see header).
 */
export type BashReadSpec = {
  filePath: string
  startLine: number | undefined
  endLine: number | undefined
  tailLines?: number
  requiresExitZero?: boolean
  contentNotInModelContext?: boolean
}

/**
 * The trigger seam (official `{triggers, permissions}` object built at the
 * `_Rn` call site). `permissions` is a thunk to match the official
 * `cRn`'s `e.permissions()` call.
 */
export type BashReadTriggerContext = {
  triggers: Set<string>
  permissions: () => ToolPermissionContext
}

// ─── Ou: quote-aware tokenizer (moved verbatim from BashTool.tokenizeArgs) ───

/**
 * Ou — best-effort quote-aware tokenizer for a single sub-command segment.
 * Splits on whitespace but honors single/double quotes and backslash escapes.
 * Used only to extract candidate file paths from argv — never for execution, so
 * a naive tokenizer is safe; the on-disk stat/read filters out non-files.
 */
function tokenizeSegment(command: string): string[] {
  const tokens: string[] = []
  let i = 0
  const len = command.length
  while (i < len) {
    while (i < len && /\s/.test(command[i])) i++
    if (i >= len) break
    let token = ''
    while (i < len && !/\s/.test(command[i])) {
      const ch = command[i]
      if (ch === '"' || ch === "'") {
        const quote = ch
        i++
        while (i < len && command[i] !== quote) {
          token += command[i]
          i++
        }
        if (i < len) i++ // skip closing quote
      } else if (ch === '\\') {
        i++
        if (i < len) {
          token += command[i]
          i++
        }
      } else {
        token += ch
        i++
      }
    }
    if (token !== '') tokens.push(token)
  }
  return tokens
}

/**
 * kd — split a command into its control-operator-delimited segments (operators
 * removed). OCC equivalent: filterControlOperators(splitCommandWithOperators()).
 * TBr only calls this AFTER rejecting any command containing `|`, `<`, or `>`,
 * so the surviving separators are `&&`/`||`/`;`/`;;`.
 */
function splitSegments(command: string): string[] {
  return filterControlOperators(splitCommandWithOperators(command))
}

// ─── EBr: sed -n '<a,b>p' / '<a>p' FILE ──────────────────────────────────────

function parseSed(segment: string): BashReadSpec | null {
  let tokens: string[]
  try {
    tokens = tokenizeSegment(segment)
  } catch {
    return null
  }
  if (tokens[0] !== 'sed') return null
  let quiet = false // -n / --quiet / --silent
  let script: string | null = null
  let file: string | null = null
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) {
      if (tok.startsWith('--')) {
        if (tok === '--in-place' || tok.startsWith('--in-place=')) return null
        if (tok === '--expression') return null
        if (tok === '--quiet' || tok === '--silent') quiet = true
      } else {
        if (tok.includes('i')) return null // in-place
        if (tok === '-e') return null // expression (script not a line-range)
        if (tok.includes('n')) quiet = true
      }
      continue
    }
    if (script === null) script = tok
    else if (file === null) file = tok
    else return null // more than script+file
  }
  if (!quiet || script === null || file === null) return null
  const range = SED_RANGE_RE.exec(script)
  if (range) {
    return {
      filePath: file,
      startLine: Number(range[1]),
      endLine: Number(range[2]),
    }
  }
  const single = SED_LINE_RE.exec(script)
  if (single) {
    const line = Number(single[1])
    return { filePath: file, startLine: line, endLine: line }
  }
  return null
}

// ─── CBr + RBr: cat / nl / bat / batcat FILE ─────────────────────────────────

/** RBr — allowed flags per cat-family command. */
const CAT_FAMILY_FLAGS = new Map<string, Set<string>>([
  ['cat', new Set(['-n', '--number'])],
  ['nl', new Set<string>()],
  ['bat', new Set(['-n', '--number', '-p', '--plain'])],
  ['batcat', new Set(['-n', '--number', '-p', '--plain'])],
])

function parseCatFamily(segment: string): BashReadSpec | null {
  let tokens: string[]
  try {
    tokens = tokenizeSegment(segment)
  } catch {
    return null
  }
  const allowed = CAT_FAMILY_FLAGS.get(tokens[0] ?? '')
  if (allowed === undefined) return null
  let file: string | null = null
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-') && tok !== '-') {
      if (!allowed.has(tok)) return null
      continue
    }
    if (file !== null) return null // more than one file
    file = tok
  }
  if (file === null || file === '-') return null
  return { filePath: file, startLine: undefined, endLine: undefined }
}

// ─── gRn: head/tail line-count parser (shared) ───────────────────────────────

function parseLineCount(
  tokens: string[],
  defaultCount: number,
): { count: number; filePath: string } | null {
  let count: number | null = null
  let file: string | null = null
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '-n' || tok === '--lines') {
      const next = tokens[++i]
      if (next === undefined) return null
      if (!/^\d+$/.test(next)) return null
      count = Number(next)
      continue
    }
    if (tok.startsWith('--lines=')) {
      const value = tok.slice(8)
      if (!/^\d+$/.test(value)) return null
      count = Number(value)
      continue
    }
    if (/^-n\d+$/.test(tok)) {
      count = Number(tok.slice(2))
      continue
    }
    if (/^-\d+$/.test(tok)) {
      count = Number(tok.slice(1))
      continue
    }
    if (tok.startsWith('-')) return null
    if (file !== null) return null // more than one file
    file = tok
  }
  if (file === null || file === '-') return null
  if (count === 0) return null // head -0 / tail -0
  return { count: count ?? defaultCount, filePath: file }
}

// ─── xBr: head FILE (startLine 1, endLine count) ─────────────────────────────

function parseHead(segment: string): BashReadSpec | null {
  let tokens: string[]
  try {
    tokens = tokenizeSegment(segment)
  } catch {
    return null
  }
  if (tokens[0] !== 'head') return null
  const parsed = parseLineCount(tokens, HEAD_DEFAULT_LINES)
  if (parsed === null) return null
  return {
    filePath: parsed.filePath,
    startLine: 1,
    endLine: parsed.count,
  }
}

// ─── ABr: tail FILE (tailLines count) ────────────────────────────────────────

function parseTail(segment: string): BashReadSpec | null {
  let tokens: string[]
  try {
    tokens = tokenizeSegment(segment)
  } catch {
    return null
  }
  if (tokens[0] !== 'tail') return null
  const parsed = parseLineCount(tokens, TAIL_DEFAULT_LINES)
  if (parsed === null) return null
  return {
    filePath: parsed.filePath,
    startLine: undefined,
    endLine: undefined,
    tailLines: parsed.count,
  }
}

// ─── NBr + constants: grep / egrep / fgrep / rg PATTERN FILE ─────────────────

/** PBr — `-A<N>` / `-B<N>` / `-C<N>` (glued context count). */
const CONTEXT_GLUED_RE = /^-[ABC]\d+$/
/** MBr — `--after-context=N` etc. (long glued context count). */
const CONTEXT_LONG_RE = /^--(?:after-context|before-context|context)=\d+$/
/** IBr — grep-family short flags. */
const GREP_SHORT_RE = /^-[niwxEFGPHh]+$/
/** OBr — grep-family long flags. */
const GREP_LONG = new Set([
  '--line-number',
  '--ignore-case',
  '--word-regexp',
  '--line-regexp',
  '--extended-regexp',
  '--fixed-strings',
  '--basic-regexp',
  '--perl-regexp',
  '--with-filename',
  '--no-filename',
  '--color=never',
  '--color=auto',
])
/** DBr — rg short flags. */
const RG_SHORT_RE = /^-[iSswxFnNHUP]+$/
/** LBr — rg long flags. */
const RG_LONG = new Set([
  '--ignore-case',
  '--smart-case',
  '--case-sensitive',
  '--word-regexp',
  '--line-regexp',
  '--fixed-strings',
  '--line-number',
  '--no-line-number',
  '--with-filename',
  '--no-filename',
  '--multiline',
  '--pcre2',
])

function parseGrepFamily(segment: string): BashReadSpec | null {
  let tokens: string[]
  try {
    tokens = tokenizeSegment(segment)
  } catch {
    return null
  }
  const isRg = tokens[0] === 'rg'
  if (
    !isRg &&
    tokens[0] !== 'grep' &&
    tokens[0] !== 'egrep' &&
    tokens[0] !== 'fgrep'
  ) {
    return null
  }
  const shortRe = isRg ? RG_SHORT_RE : GREP_SHORT_RE
  const longSet = isRg ? RG_LONG : GREP_LONG
  let pattern: string | null = null
  let file: string | null = null
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-') && tok !== '-') {
      if (tok === '-A' || tok === '-B' || tok === '-C') {
        const next = tokens[++i]
        if (next === undefined || !/^\d+$/.test(next)) return null
        continue
      }
      if (
        isRg &&
        (tok === '--after-context' ||
          tok === '--before-context' ||
          tok === '--context')
      ) {
        const next = tokens[++i]
        if (next === undefined || !/^\d+$/.test(next)) return null
        continue
      }
      if (
        CONTEXT_GLUED_RE.test(tok) ||
        CONTEXT_LONG_RE.test(tok) ||
        shortRe.test(tok) ||
        longSet.has(tok)
      ) {
        continue
      }
      return null // unrecognized flag
    }
    if (pattern === null) pattern = tok
    else if (file === null) file = tok
    else return null // more than pattern+file
  }
  if (pattern === null || file === null || file === '-') return null
  if (/[*?[{]/.test(file)) return null // glob in the file arg
  return {
    filePath: file,
    startLine: undefined,
    endLine: undefined,
    requiresExitZero: true,
    contentNotInModelContext: true,
  }
}

// ─── TBr: top-level condition set ────────────────────────────────────────────

/**
 * TBr @216611223 — parse a Bash command into the list of single-file read
 * specs it performs. Returns [] when the command is not a recognized benign
 * read (or reads nothing). Verbatim structure:
 *
 *   if(/[|<>]/.test(e))return[];                 // any pipe/redirect → reject
 *   n = kd(e); if(n.length===0)return[];          // split into segments
 *   for(s of n){
 *     g = EBr(s)??CBr(s)??xBr(s)??ABr(s)??(n.length===1?NBr(s):null);
 *     if(g)r.push(g);
 *     else if(n.length>1 && !vBr.test(s))return[]; // non-benign extra → reject
 *   }
 *
 * grep-family (NBr) is only tried for a UNIQUE segment (n.length===1): in a
 * chain the grep segment matches nothing and, being non-benign, rejects all.
 */
export function parseBashReadCommands(command: string): BashReadSpec[] {
  if (/[|<>]/.test(command)) return []
  let segments: string[]
  try {
    segments = splitSegments(command)
  } catch {
    return []
  }
  if (segments.length === 0) return []
  const specs: BashReadSpec[] = []
  for (const segment of segments) {
    const spec =
      parseSed(segment) ??
      parseCatFamily(segment) ??
      parseHead(segment) ??
      parseTail(segment) ??
      (segments.length === 1 ? parseGrepFamily(segment) : null)
    if (spec) {
      specs.push(spec)
    } else if (segments.length > 1 && !BENIGN_SEGMENT_RE.test(segment)) {
      return []
    }
  }
  return specs
}

// ─── FBr: content slicing ────────────────────────────────────────────────────

/** The sliced result of FBr — content plus the readFileState offset/limit. */
export type BashReadSlice = {
  content: string
  offset: number | undefined
  limit: number | undefined
}

/**
 * FBr @216614918 — slice file content to the spec's window.
 *  - tailLines: last N lines (trailing empty line dropped first).
 *  - startLine: lines [startLine, endLine] (1-based, inclusive).
 *  - neither: the whole content.
 * Returns null when the window is empty (start beyond EOF, or a tail of an
 * empty file) — the recorder then skips the entry.
 */
export function sliceBashReadContent(
  content: string,
  spec: BashReadSpec,
): BashReadSlice | null {
  if (spec.tailLines !== undefined) {
    const lines = content.split('\n')
    if (lines.length > 0 && lines.at(-1) === '') lines.pop()
    if (lines.length === 0) return null
    const limit = Math.min(spec.tailLines, lines.length)
    const offset = lines.length - limit + 1
    return {
      content: lines.slice(offset - 1).join('\n'),
      offset,
      limit,
    }
  }
  if (spec.startLine === undefined) {
    return { content, offset: undefined, limit: undefined }
  }
  const lines = content.split('\n')
  const start = Math.max(1, spec.startLine)
  const end = Math.max(start, spec.endLine ?? start)
  if (start > lines.length) return null
  return {
    content: lines.slice(start - 1, end).join('\n'),
    offset: start,
    limit: end - start + 1,
  }
}

// ─── cRn: trigger fire (read-deny gated) ─────────────────────────────────────

/**
 * cRn @216615924 — `if(e && !AH(n, e.permissions())) MH(e.triggers, n)`.
 * Fire the nested-memory trigger for `absPath` UNLESS the path is read-denied
 * (AH ≡ isFileReadDenied). MH is a Set.add in OCC (the official MH@213105482
 * is an unrelated array-push name collision; OCC's triggers is a Set, matching
 * FileReadTool.ts:1437's `nestedMemoryAttachmentTriggers?.add(...)`).
 */
function fireNestedMemoryTrigger(
  triggerContext: BashReadTriggerContext | undefined,
  absPath: string,
): void {
  if (
    triggerContext &&
    !isFileReadDenied(absPath, triggerContext.permissions())
  ) {
    triggerContext.triggers.add(absPath)
  }
}

// ─── _Rn: the 6-param post-exec recorder ─────────────────────────────────────

/**
 * _Rn @216615382 — record every single-file read the command performed into
 * `readFileState`, and fire the nested-memory trigger for each. Verbatim
 * structure (params: command, readFileState, abortSignal, exitCode,
 * contentNotInModelContext, triggerContext):
 *
 *   S = TBr(command).filter(h => !h.requiresExitZero || exitCode===0);
 *   if(S.length===0) return;
 *   await Promise.all(S.map(async h => {
 *     z = Je(h.filePath);
 *     try {
 *       if(readFileState.get(z)) { cRn(ctx,z); return }   // ★ already-recorded
 *       V = await fs.stat(z); if(V.size>10485760) return;  //   path STILL fires
 *       if(signal.aborted) return;
 *       Y = await fs.readFile(z); slice = FBr(Ih(Y), h);
 *       if(slice===null) return;
 *       readFileState.set(z, {content, timestamp, offset, limit, …});
 *       cRn(ctx,z)
 *     } catch {}
 *   }))
 *
 * ★ THE 292 FIX: the already-recorded early-return fires cRn(ctx,z) — this is
 * the exact path the pre-fix recorder skipped, so re-viewing an already-read
 * file with cat/head/tail now (re)injects its nested CLAUDE.md / path rules.
 *
 * `contentNotInModelContext` (official param `g`) is threaded for signature
 * fidelity but NOT persisted — OCC's FileState has no such field and nothing
 * consumes it (fileStateGuard.ts:46). See the module header.
 */
export async function recordBashReadFiles(
  command: string,
  readFileState: FileStateCache,
  abortSignal: AbortSignal,
  exitCode: number,
  contentNotInModelContext: boolean,
  triggerContext?: BashReadTriggerContext,
): Promise<void> {
  const specs = parseBashReadCommands(command).filter(
    spec => !spec.requiresExitZero || exitCode === 0,
  )
  if (specs.length === 0) return
  const fs = getFsImplementation()
  await Promise.all(
    specs.map(async spec => {
      const absPath = expandPath(spec.filePath)
      try {
        // ★ Already recorded → fire the trigger and return WITHOUT re-reading.
        if (readFileState.get(absPath)) {
          fireNestedMemoryTrigger(triggerContext, absPath)
          return
        }
        const stat = await fs.stat(absPath)
        if (stat.size > BASH_READ_MAX_FILE_BYTES) return
        if (abortSignal.aborted) return
        const encoding = detectFileEncoding(absPath)
        const raw = await fs.readFile(absPath, { encoding })
        const slice = sliceBashReadContent(raw, spec)
        if (slice === null) return
        readFileState.set(absPath, {
          content: slice.content,
          timestamp: Math.floor(stat.mtimeMs),
          offset: slice.offset,
          limit: slice.limit,
        })
        fireNestedMemoryTrigger(triggerContext, absPath)
      } catch {
        // not a real file / unreadable / stat failed — skip
      }
    }),
  )
  // contentNotInModelContext is intentionally not persisted (see header).
  void contentNotInModelContext
}
