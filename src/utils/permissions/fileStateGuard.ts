/**
 * File-state guard shared by the Write and Edit tools.
 *
 * Ported byte-semantically from the official Claude Code 2.1.228 binary
 * (aligning-with-official-binary skill: the compiled ELF is the source of
 * truth — nothing here is invented). Minified official identifiers are kept
 * in comments for traceability:
 *
 *   YMe  -> FileStateError
 *   nTo  -> FILE_NOT_READ_MESSAGE (validateInput + call-time share the text)
 *   Sws  -> READ_DENY_EDIT_MESSAGE
 *   vws  -> READ_DENY_WRITE_MESSAGE
 *   oTo  -> FILE_MODIFIED_SINCE_READ_CALL_MESSAGE
 *   fTo  -> FILE_STATE_CURRENT_NOTE
 *   z7d  -> isNotebookPathForGuard
 *   Qzt  -> isOldModel            (zGy = OLD_GUARD_MODELS)
 *   Pa   -> stripBracket1m
 *   jMo  -> getModelBucket
 *   cVt  -> isCoveredByReadDenyRule
 *   Mwt  -> wouldReadBeAutoAllowed
 *   FGS  -> isReadToolUnavailableForGuard
 *   Gxf  -> isReadAutoAllowedForPath
 *   $ot  -> isFullReadOfFileState
 *   Exe  -> fileStateMatchesDisk
 *   Hxe  -> stripBom
 *   J9   -> normalizeForComparison
 *   i3o  -> fileStateMatchesNormalized
 *   k2p  -> editWouldApplyToTelemetry
 *   Ssb  -> assertWriteFileStateFresh
 *   C8b  -> checkEditFileStateAtCall
 *
 * The 2.1.228 change (changelog: "Changed the Write tool so newer models can
 * overwrite an existing file they haven't read this session, matching the
 * Edit tool's rules; older models still require the read first"): the Write
 * read-before-write gate is skipped when a hypothetical Read of the same path
 * would have been auto-allowed by the permission system (Mwt). The Edit side,
 * the call-time guards, and the stale-recovery rule use the identical Mwt
 * predicate. The retired `tengu_velvet_mallet` flag from 2.1.227 was Write-only.
 *
 * OCC adaptations (documented, behavior-preserving):
 * - The official threads `permissionLayers` through RL(); OCC has no
 *   permission-layers subsystem, so the guard model is simply
 *   `context.options.mainLoopModel`.
 * - The official `contentHash` FileState fast path (Exe) is absent in OCC's
 *   FileState; the content-compare fallback is the official's own else-branch.
 * - The official `contentNotInModelContext` flag (h9e) is not tracked by
 *   OCC's FileState; nothing in OCC consumes it.
 * - `readNotAutoAllowed` is passed as a thunk exactly like the official
 *   call sites (`() => !Mwt(...)`), keeping the double negation out of the
 *   guard bodies.
 */
import { extname } from 'path'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { checkEditWouldApply } from '../../tools/FileEditTool/utils.js'
import { getFileModificationTime } from '../file.js'
import type { FileState } from '../fileStateCache.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { getCanonicalName } from '../model/model.js'
import { countCharInString } from '../stringUtils.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from './filesystem.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForToolName,
} from './permissions.js'

/** nTo — validateInput "not read" error and call-time FileStateError. */
export const FILE_NOT_READ_MESSAGE =
  'File has not been read yet. Read it first before writing to it.'

/** validateInput staleness error (Write errorCode 3 / Edit errorCode 7). */
export const FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE =
  'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'

/** oTo — call-time FileStateError staleness message. */
export const FILE_MODIFIED_SINCE_READ_CALL_MESSAGE =
  'File content has changed since it was last read. This commonly happens when a linter or formatter run via Bash rewrites the file. Call Read on this file to refresh, then retry the edit.'

/** Sws — Edit blocked by a Read deny rule. */
export const READ_DENY_EDIT_MESSAGE =
  'File is covered by a Read deny rule in your permission settings and cannot be edited.'

/** vws — Write blocked by a Read deny rule. */
export const READ_DENY_WRITE_MESSAGE =
  'File is covered by a Read deny rule in your permission settings and cannot be written.'

/** fTo — appended to Edit/Write tool results when file state is current. */
export const FILE_STATE_CURRENT_NOTE =
  ' (file state is current in your context — no need to Read it back)'

/** YMe */
export class FileStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileStateError'
  }
}

/**
 * zGy — models that still require an explicit Read before Write/Edit.
 * Byte-verbatim set from the 2.1.228 binary.
 */
const OLD_GUARD_MODELS = new Set([
  'claude-opus-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
])

/**
 * OCC's getCanonicalName returns 'claude-opus-4' / 'claude-sonnet-4' for the
 * bare 4.0 models; the official table (zGy) keys them with the '-0' suffix.
 */
const CANONICAL_TO_GUARD_NAME: Record<string, string> = {
  'claude-opus-4': 'claude-opus-4-0',
  'claude-sonnet-4': 'claude-sonnet-4-0',
}

/** Pa */
export function stripBracket1m(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

/** Qzt */
export function isOldModel(model: string): boolean {
  const stripped = stripBracket1m(model)
  const guardName = CANONICAL_TO_GUARD_NAME[stripped] ?? stripped
  return OLD_GUARD_MODELS.has(guardName)
}

/**
 * jMo — telemetry-safe model bucket. Strips the [1m] suffix and the
 * `claude-` prefix, converts dashes to underscores; anything that doesn't
 * fit ^[a-z0-9_]{1,40}$ is reported as 'nonconforming'.
 */
export function getModelBucket(model: string): string {
  const bucket = stripBracket1m(model)
    .replace(/^claude-/, '')
    .replaceAll('-', '_')
  return /^[a-z0-9_]{1,40}$/.test(bucket) ? bucket : 'nonconforming'
}

/**
 * RL + Do (OCC variant) — the canonical main-loop model the guards key on.
 * The official walks `permissionLayers` for a model-kind override; OCC has
 * no permission layers, so options.mainLoopModel is authoritative.
 */
export function getGuardModel(context: ToolUseContext): string {
  return getCanonicalName(context.options.mainLoopModel)
}

/** z7d — trailing dots/spaces are stripped before the .ipynb check. */
export function isNotebookPathForGuard(fullFilePath: string): boolean {
  return extname(fullFilePath.replace(/[. ]+$/, '')).toLowerCase() === '.ipynb'
}

/**
 * BGS — rule sources that narrow tools at runtime (CLI --allowedTools,
 * per-command narrowing). The official excludes them when scanning for a
 * bare `Read` deny: they restrict what the agent can invoke this turn but
 * do not express a settings-level "Read is denied" policy.
 */
const RUNTIME_NARROWING_RULE_SOURCES = new Set<string>([
  'toolsNarrowing',
  'cliArg',
  'command',
])

/**
 * cVt — true when a Read of this path is covered by a deny rule.
 * Two official paths:
 * 1. A bare `Read` deny rule (no ruleContent) from a settings source
 *    (hU over getDenyRules minus the runtime-narrowing sources).
 * 2. A content-specific `Read(<pattern>)` deny rule whose pattern matches
 *    the path (or its symlink-resolved forms).
 */
export function isCoveredByReadDenyRule(
  fullFilePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const bareReadDenied = getDenyRules(toolPermissionContext).some(
    rule =>
      !RUNTIME_NARROWING_RULE_SOURCES.has(rule.source) &&
      rule.ruleValue.ruleContent === undefined &&
      rule.ruleValue.toolName === FILE_READ_TOOL_NAME,
  )
  if (bareReadDenied) {
    return true
  }
  if (
    getRuleByContentsForToolName(
      toolPermissionContext,
      FILE_READ_TOOL_NAME,
      'deny',
    ).size === 0
  ) {
    return false
  }
  return getPathsForPermissionCheck(fullFilePath).some(
    pathToCheck =>
      matchingRuleForInput(
        pathToCheck,
        toolPermissionContext,
        'read',
        'deny',
      ) !== null,
  )
}

/**
 * Minimal Read-tool probe used to ask the permission system "would a Read of
 * this path be auto-allowed?". Mirrors the official cFe: name + getPath only
 * (the permission checkers never touch any other Tool surface).
 */
const READ_PROBE = {
  name: FILE_READ_TOOL_NAME,
  mcpInfo: undefined,
  getPath: (input: { file_path?: unknown }) => String(input.file_path),
} as unknown as Tool

/**
 * FGS — the guard is skipped only when Read/REPL would actually be usable.
 * True when the writing tool itself is registered but neither Read nor REPL
 * is available (tool-search / deferred-tools environments): there, a
 * hypothetical Read could not have happened, so skipping the gate is unsafe.
 */
function isReadToolUnavailableForGuard(
  writingToolName: string,
  context: ToolUseContext,
): boolean {
  const tools = context.options.tools ?? []
  return (
    tools.some(tool => toolMatchesName(tool, writingToolName)) &&
    !tools.some(tool => toolMatchesName(tool, FILE_READ_TOOL_NAME)) &&
    !tools.some(tool => toolMatchesName(tool, REPL_TOOL_NAME))
  )
}

/**
 * Gxf — would a Read of this path be auto-allowed (no user prompt)?
 * Bare Read deny/ask rules block first; then the real read-permission check
 * decides. An `ask` decision still counts as auto-allowed in bypassPermissions
 * mode unless an explicit ask rule produced it.
 *
 * Exported for reuse by the 2.1.251 Workflow scriptPath gate (Gap-109c):
 * the official binary's f_r is this exact predicate, run through the same
 * minimal Read probe (X_ there, READ_PROBE here).
 */
export function isReadAutoAllowedForPath(
  fullFilePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  if (
    getDenyRuleForTool(toolPermissionContext, READ_PROBE) !== null ||
    getAskRuleForTool(toolPermissionContext, READ_PROBE) !== null
  ) {
    return false
  }
  const decision = checkReadPermissionForTool(
    READ_PROBE,
    { file_path: fullFilePath },
    toolPermissionContext,
  )
  if (decision.behavior === 'allow') {
    return true
  }
  if (decision.behavior !== 'ask') {
    return false
  }
  if (toolPermissionContext.mode !== 'bypassPermissions') {
    return false
  }
  const reason = decision.decisionReason
  return !(reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask')
}

/**
 * Mwt — the skip/recovery predicate shared by Write and Edit: a hypothetical
 * Read of this path by this tool would have been auto-allowed.
 */
export function wouldReadBeAutoAllowed(
  writingToolName: string,
  fullFilePath: string,
  context: ToolUseContext,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  return (
    !isReadToolUnavailableForGuard(writingToolName, context) &&
    isReadAutoAllowedForPath(fullFilePath, toolPermissionContext)
  )
}

/**
 * $ot — the last read covered the whole file (and wasn't a partial view), so
 * its cached content can stand in for a fresh disk read in staleness checks.
 */
export function isFullReadOfFileState(state: FileState): boolean {
  if ((state.offset ?? 1) > 1 || state.isPartialView) {
    return false
  }
  if (state.limit === undefined) {
    return true
  }
  return state.content !== '' && countCharInString(state.content, '\n') + 1 < state.limit
}

/** Hxe */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/** J9 — the canonical form readFileState stores (BOM-stripped, LF-only). */
export function normalizeForComparison(content: string): string {
  return stripBom(content).replaceAll('\r\n', '\n')
}

/**
 * Exe — does the cached file state still match on-disk content? The official
 * compares a contentHash when present; OCC's FileState has no hash, so this
 * is the official's content-compare fallback.
 */
export function fileStateMatchesDisk(state: FileState, diskContent: string): boolean {
  return state.content === diskContent
}

/** i3o */
export function fileStateMatchesNormalized(
  state: FileState,
  rawContent: string,
): boolean {
  return fileStateMatchesDisk(state, normalizeForComparison(rawContent))
}

/** k2p — telemetry mapping for the editWouldApply classifier. */
export function editWouldApplyToTelemetry(
  result: 'applies' | 'no_match' | 'ambiguous',
): 'success' | 'errorCode8' | 'errorCode9' {
  switch (result) {
    case 'no_match':
      return 'errorCode8'
    case 'ambiguous':
      return 'errorCode9'
    case 'applies':
      return 'success'
  }
}

/**
 * Ssb — Write call-time guard. Throws FileStateError when the write must not
 * proceed; returns silently otherwise. `diskContent` is the LF-normalized
 * on-disk content (readFileSyncWithMetadata form: CRLF-normalized, BOM kept).
 */
export function assertWriteFileStateFresh(args: {
  fullFilePath: string
  diskContent: string
  lastRead: FileState | undefined
  model: string
  readNotAutoAllowed: () => boolean
}): void {
  const { fullFilePath, diskContent, lastRead, model, readNotAutoAllowed } =
    args
  if (!lastRead || lastRead.isPartialView) {
    if (
      !lastRead &&
      !isNotebookPathForGuard(fullFilePath) &&
      !isOldModel(model) &&
      !readNotAutoAllowed()
    ) {
      return
    }
    throw new FileStateError(FILE_NOT_READ_MESSAGE)
  }
  if (!(getFileModificationTime(fullFilePath) > lastRead.timestamp)) {
    return
  }
  if (isFullReadOfFileState(lastRead) && fileStateMatchesDisk(lastRead, stripBom(diskContent))) {
    return
  }
  throw new FileStateError(FILE_MODIFIED_SINCE_READ_CALL_MESSAGE)
}

/**
 * C8b — Edit call-time guard. Returns true when the file changed since the
 * last read but the edit still applies cleanly (staleRecovered); returns
 * false when no recovery bookkeeping is needed; throws FileStateError when
 * the edit must not proceed. `fileContents` is the LF-normalized on-disk
 * content (readFileForEdit form).
 */
export function checkEditFileStateAtCall(args: {
  absoluteFilePath: string
  fileContents: string
  lastRead: FileState | undefined
  oldString: string
  replaceAll: boolean
  model: string
  readNotAutoAllowed: () => boolean
}): boolean {
  const {
    absoluteFilePath,
    fileContents,
    lastRead,
    oldString,
    replaceAll,
    model,
    readNotAutoAllowed,
  } = args
  if (!lastRead) {
    if (!isOldModel(model) && !readNotAutoAllowed()) {
      return false
    }
    throw new FileStateError(FILE_NOT_READ_MESSAGE)
  }
  if (getFileModificationTime(absoluteFilePath) <= lastRead.timestamp) {
    return false
  }
  if (isFullReadOfFileState(lastRead) && fileStateMatchesDisk(lastRead, stripBom(fileContents))) {
    return false
  }
  if (
    checkEditWouldApply(fileContents, oldString, replaceAll) === 'applies' &&
    !readNotAutoAllowed()
  ) {
    return true
  }
  throw new FileStateError(FILE_MODIFIED_SINCE_READ_CALL_MESSAGE)
}
