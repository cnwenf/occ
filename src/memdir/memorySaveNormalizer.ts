/**
 * M11 (Claude Code 2.1.214): programmatically inject/update an ISO `modified`
 * timestamp in a memory file's frontmatter when it is written/edited.
 *
 * OCC memory files are model-written via Write/Edit + buildMemoryPrompt; OCC
 * has no programmatic save/normalize path, so this adds one — a built-in
 * PostToolUse step (called inline from toolHooks.ts runPostToolUseHooks,
 * mirroring checkMemoryEntrypointOverCap) that re-writes the file in place.
 *
 * Safety (security-reviewer approved):
 *  - L1 (primary anti-loop): re-writes via DIRECT fs.writeFileSync, NOT the
 *    Write/Edit tool, so PostToolUse (a tool-lifecycle hook) does not re-fire.
 *  - L2 (idempotency): if the existing `modified:` value already === the ISO
 *    string about to be written, skip the write entirely (exact equality; no
 *    time window).
 *  - L3 (reentrance): a module-level Set of normalized-absolute paths, add/
 *    write/delete all SYNCHRONOUS (fs.writeFileSync is sync; no `await` between
 *    them so two concurrent handlers cannot both pass the add check),
 *    cleared in `finally`.
 *  - No overwrite of model frontmatter: in-place text edit — only the
 *    `modified:` line is touched (value token swapped, quotes + trailing
 *    `#` comment preserved); all other frontmatter is byte-for-byte preserved.
 *  - MEMORY.md (the entrypoint index) is never touched — its cap guard handles
 *    itself. Non-memory files are never touched.
 *  - Errors are swallowed + debug-logged; never block the tool (mirrors
 *    checkMemoryEntrypointOverCap).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, normalize, relative, resolve, sep } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { FRONTMATTER_REGEX } from '../utils/frontmatterParser.js'
import { getAutoMemEntrypoint } from './paths.js'

/** Pure: inject/update `modified:` in a memory file's raw content. Returns the
 * new content (or the input unchanged if already current). Exported for TDD. */
export function injectModifiedFrontmatter(raw: string, iso: string): string {
  const m = raw.match(FRONTMATTER_REGEX)
  if (!m || m.index === undefined) {
    // No frontmatter block. Official 2.1.214 "Added an ISO modified timestamp
    // to memory file frontmatter" — add the field, creating a block.
    return `---\nmodified: ${iso}\n---\n\n${raw}`
  }
  const fullBlock = m[0]
  const inner = m[1] ?? ''
  const newInner = replaceOrInsertModifiedLine(inner, iso)
  if (newInner === inner) {
    return raw // idempotent: `modified:` already === iso
  }
  // Preserve the exact `---` delimiters + trailing of the original block; only
  // the inner frontmatter text changes.
  const newBlock = fullBlock.replace(inner, newInner)
  return raw.slice(0, m.index) + newBlock + raw.slice(m.index + fullBlock.length)
}

/**
 * Within the frontmatter inner text, swap the value of the `modified:` line
 * (preserving leading whitespace, quote style, and any trailing ` #` comment),
 * or insert a `modified:` line at the top if absent.
 */
function replaceOrInsertModifiedLine(fmText: string, iso: string): string {
  const lines = fmText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*modified:\s*)(.*)$/)
    if (!m || m[1] === undefined || m[2] === undefined) {
      continue
    }
    const prefix = m[1]
    const rest = m[2]
    // Split value from a trailing YAML comment: ` #` or a leading `#`.
    let valuePart = rest
    let commentPart = ''
    const commentIdx = rest.startsWith('#')
      ? 0
      : rest.search(/\s#/)
    if (commentIdx >= 0) {
      valuePart = rest.slice(0, commentIdx)
      commentPart = rest.slice(commentIdx)
    }
    const trimmed = valuePart.trim()
    const isQuoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    const newValue = isQuoted ? `"${iso}"` : iso
    lines[i] = `${prefix}${newValue}${commentPart ? ` ${commentPart.trimStart()}` : ''}`
    return lines.join('\n')
  }
  // No `modified:` line — insert one at the top of the frontmatter.
  lines.unshift(`modified: ${iso}`)
  return lines.join('\n')
}

/** Paths currently being normalized (L3 reentrance guard). Keyed by normalized
 * absolute path. Add/write/delete are all synchronous. */
const normalizingPaths: Set<string> = new Set()

/** Is `filePath` a memory file this normalizer should touch? (Under the memory
 * dir, but NOT the MEMORY.md entrypoint.) */
function isMemoryFileToNormalize(filePath: string): boolean {
  try {
    const entrypoint = getAutoMemEntrypoint()
    const memDir = dirname(entrypoint)
    const abs = resolve(filePath)
    if (normalize(abs) === normalize(entrypoint)) {
      return false // MEMORY.md — cap guard handles itself
    }
    const rel = relative(memDir, abs)
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
  } catch {
    return false
  }
}

/**
 * Side-effectful: read the memory file, inject/update `modified:` to the current
 * ISO timestamp, write it back via direct fs write. No-op if the path is not a
 * memory file, is MEMORY.md, is already current (L2), or is already being
 * normalized (L3). Swallows errors (never throws) — mirrors
 * checkMemoryEntrypointOverCap's "don't block the tool on a guard failure".
 */
export function normalizeMemoryFileModified(filePath: string): void {
  if (!filePath || !isMemoryFileToNormalize(filePath)) {
    return
  }
  const key = normalize(resolve(filePath))
  if (normalizingPaths.has(key)) {
    return // L3: already mid-normalize for this path
  }
  normalizingPaths.add(key)
  try {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return // file gone/unreadable — nothing to stamp
    }
    const iso = new Date().toISOString()
    // L2 idempotency: if `modified:` already === iso, skip the write.
    if (hasCurrentModified(raw, iso)) {
      return
    }
    const next = injectModifiedFrontmatter(raw, iso)
    if (next === raw) {
      return
    }
    // L1: direct fs write — does NOT re-trigger PostToolUse (tool-lifecycle
    // hook), so no write loop.
    writeFileSync(filePath, next, 'utf8')
  } catch (error) {
    logForDebugging(
      `memory save-normalizer failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'debug' },
    )
  } finally {
    normalizingPaths.delete(key)
  }
}

/** True iff the frontmatter's `modified:` value already exactly equals `iso`. */
function hasCurrentModified(raw: string, iso: string): boolean {
  const m = raw.match(FRONTMATTER_REGEX)
  if (!m || m[1] === undefined) {
    return false
  }
  const fmText = m[1]
  for (const line of fmText.split('\n')) {
    const lm = line.match(/^\s*modified:\s*(.*)$/)
    if (!lm || lm[1] === undefined) {
      continue
    }
    let rest = lm[1]
    const commentIdx = rest.startsWith('#') ? 0 : rest.search(/\s#/)
    if (commentIdx >= 0) {
      rest = rest.slice(0, commentIdx)
    }
    const trimmed = rest.trim()
    const unquoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ? trimmed.slice(1, -1)
        : trimmed
    return unquoted === iso
  }
  return false
}
