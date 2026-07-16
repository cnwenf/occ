import { feature } from 'src/utils/featureFlags.js'
import { basename, join, resolve } from 'path'
import { Lexer } from 'marked'
import { getFsImplementation } from '../utils/fsOperations.js'
import { FRONTMATTER_REGEX } from '../utils/frontmatterParser.js'
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemPath,
  isAutoMemoryEnabled,
} from './paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('./teamMemPaths.js') as typeof import('./teamMemPaths.js'))
  : null

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memoryTypes.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

// Regex matching HTML comments (<!--...-->), including multi-line. Mirrors
// the binary's b5i inner regex n=/<!--[\s\S]*?-->/g.
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g

/**
 * Strip non-loaded content (frontmatter + HTML comments) from a MEMORY.md
 * payload so the over-limit guard measures only what is actually loaded into
 * the system prompt. Mirrors the 2.1.211 binary's refinement:
 * `lwt(vXc(Zm(content).content).content)` — `Zm` parses frontmatter and
 * returns `.content` (without the `---\n...\n---` block), then `vXc` uses the
 * marked Lexer to strip HTML comments from HTML tokens (preserving code-block
 * content), then `lwt` measures the result.
 *
 * The frontmatter block is stripped via FRONTMATTER_REGEX (same regex used by
 * parseFrontmatter). HTML comments are stripped via the marked Lexer — only
 * from `html`-type tokens — so `<!--` inside fenced code blocks is preserved.
 * If the content has no `<!--`, the lexer is skipped (short-circuit matching
 * the binary's `vXc` early return).
 */
export function stripNonLoadedContent(raw: string): string {
  // 1. Strip frontmatter block (---\n...\n---) from the start.
  const withoutFrontmatter = FRONTMATTER_REGEX.test(raw)
    ? raw.replace(FRONTMATTER_REGEX, '')
    : raw

  // 2. Strip HTML comments. Short-circuit when no comment markers exist
  //    (matches the binary's `vXc` early return).
  if (!withoutFrontmatter.includes('<!--')) {
    return withoutFrontmatter
  }

  // Use the marked Lexer (gfm:false, matching the binary's C9({gfm:false}))
  // to tokenize, then strip HTML comments from html-type tokens only.
  const lexer = new Lexer({ gfm: false })
  const tokens = lexer.lex(withoutFrontmatter)
  let result = ''
  for (const token of tokens) {
    if (token.type === 'html') {
      const rawToken = token.raw ?? ''
      const trimmedStart = rawToken.trimStart()
      if (
        trimmedStart.startsWith('<!--') &&
        rawToken.includes('-->')
      ) {
        // Strip the comment portion; keep any non-comment residue in the
        // same HTML token (matches the binary's b5i: replace n, keep if
        // non-empty after trim).
        const stripped = rawToken.replace(HTML_COMMENT_REGEX, '')
        if (stripped.trim().length > 0) {
          result += stripped
        }
        continue
      }
    }
    // Non-html tokens and non-comment html tokens: keep raw.
    result += token.raw ?? ''
  }
  return result
}

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * Shared by buildMemoryPrompt and claudemd getMemoryFiles (previously
 * duplicated the line-only logic).
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * ----------------------------------------------------------------------------
 * 2.1.210 #29 — write-time over-cap guard for the memory index.
 * ----------------------------------------------------------------------------
 * Memory writes that leave MEMORY.md over (or approaching) its read limit now
 * surface an explicit error as PostToolUse `additionalContext` so the model
 * trims the index. Previously the write succeeded silently and truncation only
 * happened on the next read (`truncateEntrypointContent` above). The write
 * itself is still NOT rejected — the message tells the model to compact.
 *
 * Mirrors the official 2.1.210 binary verbatim:
 *   - `meo`  → getMemoryIndexOverCapMessage (exact error/warning text)
 *   - `bVt`  → measureMemoryIndexContent (trim; lineCount = newlineCount + 1;
 *              byteCount = trimmed.length)
 *   - `YEu`  → checkMemoryEntrypointOverCap (only the auto-memory MEMORY.md;
 *              reads up to 4x the byte cap)
 * Constants: Sxg=0.8 (approaching threshold), KEu=0.7 (target fraction),
 *            z5n=4*Eme=100000 (guard read cap), Pee=200, Eme=25000.
 * The read-time `truncateEntrypointContent` warning STAYS as the fallback for
 * pre-existing over-limit files (confirmed present in the 2.1.210 binary).
 */
export const MEMORY_INDEX_APPROACHING_THRESHOLD = 0.8 // Sxg
export const MEMORY_INDEX_TARGET_FRACTION = 0.7 // KEu
// Guard reads up to 4x the byte cap (z5n = 4 * Eme) so it can measure the true
// size of an over-cap index without loading a multi-MB file wholesale.
const WRITE_GUARD_READ_LIMIT = 4 * MAX_ENTRYPOINT_BYTES

export type MemoryIndexOverCapResult = {
  text: string
  overCap: boolean
}

export type MemoryIndexSizeInfo = {
  byteCount: number
  lineCount: number
}

/**
 * Measure MEMORY.md content the way the official 2.1.210 guard (bVt) does:
 * trim, then lineCount = (number of newlines in trimmed) + 1, byteCount =
 * trimmed.length (char count — matches the binary's bVt.byteCount and OCC's
 * existing read-time truncateEntrypointContent semantics).
 */
export function measureMemoryIndexContent(raw: string): MemoryIndexSizeInfo {
  const trimmed = raw.trim()
  const lineCount = trimmed.length === 0 ? 1 : trimmed.split('\n').length
  return { byteCount: trimmed.length, lineCount }
}

/**
 * Build the over-cap / approaching-cap message for a memory index write.
 * Mirrors the official 2.1.210 `meo` exactly:
 *  - returns null when the worst dimension is under APPROACHING_THRESHOLD (0.8)
 *  - returns {text, overCap:true} when over the cap (text starts with "Error:")
 *  - returns {text, overCap:false} when approaching (0.8 <= frac < 1.0)
 * The worst dimension (bytes vs lines, whichever fraction is higher) drives
 * the message. The exact text — including the em-dash and "The write succeeded,
 * but everything past the limit is silently dropped …" — is copied verbatim
 * from the binary's `meo` function.
 */
export function getMemoryIndexOverCapMessage(params: {
  label: string
  displayPath: string
  sizeBytes: number
  byteCap: number
  lineCount?: number
  lineCap?: number
}): MemoryIndexOverCapResult | null {
  const { label, displayPath, sizeBytes, byteCap, lineCount, lineCap } = params
  const dimensions = [
    {
      frac: sizeBytes / byteCap,
      over: sizeBytes > byteCap,
      sizeDesc: formatFileSize(sizeBytes),
      capDesc: formatFileSize(byteCap),
      targetDesc: formatFileSize(Math.floor(byteCap * MEMORY_INDEX_TARGET_FRACTION)),
    },
  ]
  if (lineCap !== undefined && lineCount !== undefined) {
    dimensions.push({
      frac: lineCount / lineCap,
      over: lineCount > lineCap,
      sizeDesc: `${lineCount} lines`,
      capDesc: `${lineCap}-line`,
      targetDesc: `${Math.floor(lineCap * MEMORY_INDEX_TARGET_FRACTION)} lines`,
    })
  }
  const worst = dimensions.reduce((acc, d) => (d.frac > acc.frac ? d : acc))
  if (worst.frac < MEMORY_INDEX_APPROACHING_THRESHOLD) {
    return null
  }
  const text = `${worst.over
    ? `Error: this write left the ${label} at ${displayPath} at ${worst.sizeDesc}, over its ${worst.capDesc} read limit. The write succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end are already invisible to readers. Rewrite it`
    : `The ${label} at ${displayPath} is ${worst.sizeDesc}, approaching the ${worst.capDesc} read limit. Compact it`
  } to under ${worst.targetDesc} now: keep one line per entry, move detail into topic files, and merge or drop stale entries.`
  return { text, overCap: worst.over }
}

/**
 * Post-write guard for the auto-memory MEMORY.md index (2.1.210 #29).
 * Mirrors the official `YEu`: only acts on the auto-memory MEMORY.md path,
 * reads up to 4x the byte cap, measures the content, and returns the over-cap
 * message (or null when under the approaching threshold). The write itself is
 * not rejected — the caller surfaces `text` as PostToolUse additionalContext.
 *
 * Returns null when auto-memory is disabled, the path is not the memory index,
 * or the file cannot be read (e.g. just deleted) — matching the binary, which
 * swallows read errors and returns null rather than blocking the tool.
 */
export async function checkMemoryEntrypointOverCap(
  filePath: string,
): Promise<MemoryIndexOverCapResult | null> {
  if (!isAutoMemoryEnabled()) return null
  // Match the official: path resolves to the auto-memory MEMORY.md, OR the
  // basename is MEMORY.md and the path is inside the auto-memory directory.
  const isAutoMemIndex =
    resolve(filePath) === resolve(getAutoMemEntrypoint()) ||
    (basename(filePath) === ENTRYPOINT_NAME && isAutoMemPath(filePath))
  if (!isAutoMemIndex) return null

  const fs = getFsImplementation()
  let content: string
  try {
    content = fs.readFileSync(filePath, { encoding: 'utf-8' }) as string
  } catch {
    // File unreadable / just deleted — match the binary: return null, do not
    // block. The next read's truncateEntrypointContent handles real files.
    return null
  }
  // Bound the measurement at 4x the byte cap to mirror the binary's bounded
  // read (O7e with maxBytes z5n=4*Eme). For ASCII indexes (the common case)
  // a char-slice == a byte-slice; the over/approaching determination is
  // unchanged for files above the cap regardless.
  // 2.1.211: when the FULL file was read (not truncated by the guard read
  // cap), strip frontmatter + HTML comments before measuring so the guard
  // measures only loaded content. Mirrors the binary's condition
  // `u.bytesRead >= u.bytesTotal` → `lwt(vXc(Zm(u.content).content).content)`.
  // When the file IS truncated, measure raw (sliced) content — stripping
  // a truncated frontmatter/HTML-comment block would be unreliable.
  const wasTruncated = content.length > WRITE_GUARD_READ_LIMIT
  if (wasTruncated) {
    content = content.slice(0, WRITE_GUARD_READ_LIMIT)
  } else {
    content = stripNonLoadedContent(content)
  }
  const { byteCount, lineCount } = measureMemoryIndexContent(content)
  return getMemoryIndexOverCapMessage({
    label: 'memory index',
    displayPath: ENTRYPOINT_NAME,
    sizeBytes: byteCount,
    byteCap: MAX_ENTRYPOINT_BYTES,
    lineCount,
    lineCap: MAX_ENTRYPOINT_LINES,
  })
}

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPrompts = feature('TEAMMEM')
  ? (require('./teamMemPrompts.js') as typeof import('./teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.
 * Harness guarantees the directory exists via ensureMemoryDirExists().
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/**
 * Ensure a memory directory exists. Idempotent — called from loadMemoryPrompt
 * (once per session via systemPromptSection cache) so the model can always
 * write without checking existence first. FsOperations.mkdir is recursive
 * by default and already swallows EEXIST, so the full parent chain
 * (~/.claude/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir already handles EEXIST internally. Anything reaching here is
    // a real problem (EACCES/EPERM/EROFS) — log so --debug shows why. Prompt
    // building continues either way; the model's Write will surface the
    // real perm error (and FileWriteTool does its own mkdir of the parent).
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * Log memory directory file/subdir counts asynchronously.
 * Fire-and-forget — doesn't block prompt building.
 */
function logMemoryDirCounts(
  memoryDir: string,
  baseMetadata: Record<
    string,
    | number
    | boolean
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  >,
): void {
  const fs = getFsImplementation()
  void fs.readdir(memoryDir).then(
    dirents => {
      let fileCount = 0
      let subdirCount = 0
      for (const d of dirents) {
        if (d.isFile()) {
          fileCount++
        } else if (d.isDirectory()) {
          subdirCount++
        }
      }
      logEvent('tengu_memdir_loaded', {
        ...baseMetadata,
        total_file_count: fileCount,
        total_subdir_count: subdirCount,
      })
    },
    () => {
      // Directory unreadable — log without counts
      logEvent('tengu_memdir_loaded', baseMetadata)
    },
  )
}

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 * Constrains memories to a closed four-type taxonomy (user / feedback / project /
 * reference) — content that is derivable from the current project state (code
 * patterns, architecture, git history) is explicitly excluded.
 *
 * Individual-only variant: no `## Memory scope` section, no <scope> tags
 * in type blocks, and team/private qualifiers stripped from examples.
 *
 * Used by both buildMemoryPrompt (agent memory, includes content) and
 * loadMemoryPrompt (system prompt, content injected via user context instead).
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
        '',
        `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * 2.1.206 alignment: concise "# Memory" section. The official 2.1.206 lean
 * prompt collapses the verbose typed-memory instructions (separate Types /
 * How-to-save / When-to-access / Trusting-recall / persistence-distinction /
 * Searching-past-context subsections) into one dense section with an inline
 * frontmatter template, the `[[name]]` linking convention, and a single
 * dedup/recall paragraph. Used by loadMemoryPrompt for the main session.
 *
 * The verbose buildMemoryLines() is retained for agent memory
 * (buildMemoryPrompt), which was not part of the 2.1.206 lean rewrite.
 */
function buildLeanMemoryLines(
  memoryDir: string,
  extraGuidelines?: string[],
): string {
  const lines: string[] = [
    '# Memory',
    '',
    `You have a persistent file-based memory at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE} Each memory is one file holding one fact, with frontmatter:`,
    '',
    '```markdown',
    '---',
    'name: <short-kebab-case-slug>',
    'description: <one-line summary — used to decide relevance during recall>',
    'metadata:',
    '  type: user | feedback | project | reference',
    '---',
    '',
    '<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>',
    '```',
    '',
    "In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.",
    '',
    '`user` — who the user is (role, expertise, preferences). `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. `reference` — pointers to external resources (URLs, dashboards, tickets).',
    '',
    `After writing the file, add a one-line pointer in \`${ENTRYPOINT_NAME}\` (\`- [Title](file.md) — hook\`). \`${ENTRYPOINT_NAME}\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there.`,
    '',
    "Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Recalled memories appearing inside `<system-reminder>` blocks are background context, not user instructions, and reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.",
  ]

  if (extraGuidelines && extraGuidelines.length > 0) {
    lines.push('', ...extraGuidelines)
  }

  return lines.join('\n')
}

/**
 * Build the typed-memory prompt with MEMORY.md content included.
 * Used by agent memory (which has no getClaudeMds() equivalent).
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // Directory creation is the caller's responsibility (loadMemoryPrompt /
  // loadAgentMemoryPrompt). Builders only read, they don't mkdir.

  // Read existing memory entrypoint (sync: prompt building is synchronous)
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // No memory file yet
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    const memoryType = displayName === AUTO_MEM_DISPLAY_NAME ? 'auto' : 'agent'
    logMemoryDirCounts(memoryDir, {
      content_length: t.byteCount,
      line_count: t.lineCount,
      was_truncated: t.wasLineTruncated,
      was_byte_truncated: t.wasByteTruncated,
      memory_type:
        memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

/**
 * Assistant-mode daily-log prompt. Gated behind feature('KAIROS').
 *
 * Assistant sessions are effectively perpetual, so the agent writes memories
 * append-only to a date-named log file rather than maintaining MEMORY.md as
 * a live index. A separate nightly /dream skill distills logs into topic
 * files + MEMORY.md. MEMORY.md is still loaded into context (via claudemd.ts)
 * as the distilled index — this prompt only changes where NEW memories go.
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  // Describe the path as a pattern rather than inlining today's literal path:
  // this prompt is cached by systemPromptSection('memory', ...) and NOT
  // invalidated on date change. The model derives the current date from the
  // date_change attachment (appended at the tail on midnight rollover) rather
  // than the user-context message — the latter is intentionally left stale to
  // preserve the prompt cache prefix across midnight.
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system found at: \`${memoryDir}\``,
    '',
    "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file:",
    '',
    `\`${logPathPattern}\``,
    '',
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    '',
    'Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.',
    '',
    '## What to log',
    '- User corrections and preferences ("use bun, not npm"; "stop summarizing diffs")',
    '- Facts about the user, their role, or their goals',
    '- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)',
    '- Pointers to external systems (dashboards, Linear projects, Slack channels)',
    '- Anything the user explicitly asks you to remember',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...(skipIndex
      ? []
      : [
          `## ${ENTRYPOINT_NAME}`,
          `\`${ENTRYPOINT_NAME}\` is the distilled index (maintained nightly from your logs) and is loaded into your context automatically. Read it for orientation, but do not edit it directly — record new information in today's log instead.`,
          '',
        ]),
    ...buildSearchingPastContextSection(memoryDir),
  ]

  return lines.join('\n')
}

/**
 * Build the "Searching past context" section if the feature gate is enabled.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // Ant-native builds alias grep to embedded ugrep and remove the dedicated
  // Grep tool, so give the model a real shell invocation there.
  // In REPL mode, both Grep and Bash are hidden from direct use — the model
  // calls them from inside REPL scripts, so the grep shell form is what it
  // will write in the script anyway.
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memSearch = embedded
    ? `grep -rn "<search term>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${autoMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your memory directory:',
    '```',
    memSearch,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}

/**
 * Load the unified memory prompt for inclusion in the system prompt.
 * Dispatches based on which memory systems are enabled:
 *   - auto + team: combined prompt (both directories)
 *   - auto only: memory lines (single directory)
 * Team memory requires auto memory (enforced by isTeamMemoryEnabled), so
 * there is no team-only branch.
 *
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )

  // KAIROS daily-log mode takes precedence over TEAMMEM: the append-only
  // log paradigm does not compose with team sync (which expects a shared
  // MEMORY.md that both sides read + write). Gating on `autoEnabled` here
  // means the !autoEnabled case falls through to the tengu_memdir_disabled
  // telemetry block below, matching the non-KAIROS path.
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    logMemoryDirCounts(getAutoMemPath(), {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // Cowork injects memory-policy text via env var; thread into all builders.
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths!.getTeamMemPath()
      // Harness guarantees these directories exist so the model can write
      // without checking. The prompt text reflects this ("already exists").
      // Only creating teamDir is sufficient: getTeamMemPath() is defined as
      // join(getAutoMemPath(), 'team'), so recursive mkdir of the team dir
      // creates the auto dir as a side effect. If the team dir ever moves
      // out from under the auto dir, add a second ensureMemoryDirExists call
      // for autoDir here.
      await ensureMemoryDirExists(teamDir)
      logMemoryDirCounts(autoDir, {
        memory_type:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logMemoryDirCounts(teamDir, {
        memory_type:
          'team' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return teamMemPrompts!.buildCombinedMemoryPrompt(
        extraGuidelines,
        skipIndex,
      )
    }
  }

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // Harness guarantees the directory exists so the model can write without
    // checking. The prompt text reflects this ("already exists").
    await ensureMemoryDirExists(autoDir)
    logMemoryDirCounts(autoDir, {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    // 2.1.206 alignment: main session uses the concise "# Memory" lean section
    // (buildLeanMemoryLines) matching official CC 2.1.206. The verbose
    // buildMemoryLines path is retained for agent memory only.
    return buildLeanMemoryLines(autoDir, extraGuidelines)
  }

  logEvent('tengu_memdir_disabled', {
    disabled_by_env_var: isEnvTruthy(
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ),
    disabled_by_setting:
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) &&
      getInitialSettings().autoMemoryEnabled === false,
  })
  // Gate on the GB flag directly, not isTeamMemoryEnabled() — that function
  // checks isAutoMemoryEnabled() first, which is definitionally false in this
  // branch. We want "was this user in the team-memory cohort at all."
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)) {
    logEvent('tengu_team_memdir_disabled', {})
  }
  return null
}
