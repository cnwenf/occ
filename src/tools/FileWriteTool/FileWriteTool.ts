import { basename, dirname, isAbsolute, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { perforceReadOnlyError } from '../../utils/perforce.js'
import {
  assertWriteFileStateFresh,
  FileStateError,
  FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE,
  FILE_NOT_READ_MESSAGE,
  FILE_STATE_CURRENT_NOTE,
  fileStateMatchesNormalized,
  getGuardModel,
  getModelBucket,
  isCoveredByReadDenyRule,
  isFullReadOfFileState,
  isNotebookPathForGuard,
  isOldModel,
  normalizeForComparison,
  READ_DENY_WRITE_MESSAGE,
  wouldReadBeAutoAllowed,
} from '../../utils/permissions/fileStateGuard.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe(
        'Whether a new file was created or an existing file was updated',
      ),
    filePath: z.string().describe('The path to the file that was written'),
    content: z.string().describe('The content that was written to the file'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    originalFile: z
      .string()
      .nullable()
      .describe(
        'The original file content before the write (null for new files)',
      ),
    gitDiff: gitDiffSchema().optional(),
    userModified: z
      .boolean()
      .optional()
      .describe('Whether the user manually edited the file after the write'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

/**
 * Aligned to official Claude Code 2.1.228 Write tool (binary `vsb` /
 * validateInput ported via the aligning-with-official-binary skill; the
 * compiled ELF is the source of truth). The 2.1.228 change: the
 * read-before-write gate is skipped for newer models when a hypothetical
 * Read of the same path would have been auto-allowed — matching the Edit
 * tool's rules. The retired 2.1.227 `tengu_velvet_mallet` flag gate is gone.
 */
export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    // Transcript render shows either content (create, via HighlightedCode)
    // or a structured diff (update). The heuristic's 'content' allowlist key
    // would index the raw content string even in update mode where it's NOT
    // shown — phantom. Under-count: tool_use already indexes file_path.
    return ''
  },
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)
    const toolPermissionContext =
      toolUseContext.getAppState().toolPermissionContext

    // 2.1.228: subagents return findings as text, not report files.
    if (
      toolUseContext.agentId &&
      /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i.test(basename(fullFilePath))
    ) {
      logEvent('tengu_subagent_md_report_blocked', {
        contentBytes: Buffer.byteLength(content),
      })
      return {
        result: false,
        message:
          'Subagents should return findings as text, not write report files. Include this content in your final response instead.',
        errorCode: 5,
      }
    }

    // Reject writes to team memory files that contain secrets
    const secretError = checkTeamMemSecrets(fullFilePath, content)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // Check if path should be ignored based on permission settings
    const denyRule = matchingRuleForInput(
      fullFilePath,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // 2.1.228 (binary cVt): a Read deny rule covering this path also blocks
    // writing it — writing would let the model refresh content it was denied
    // reading.
    if (isCoveredByReadDenyRule(fullFilePath, toolPermissionContext)) {
      return {
        result: false,
        message: READ_DENY_WRITE_MESSAGE,
        errorCode: 13,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
      // 2.1.98: in Perforce mode, block writes to read-only files with a
      // `p4 edit` hint instead of silently overwriting them. 2.1.228: no
      // behavior field here (the official reports a plain validation error,
      // errorCode 6).
      const perforceError = perforceReadOnlyError(fileStat.mode)
      if (perforceError) {
        return {
          result: false,
          message: perforceError,
          errorCode: 6,
        }
      }
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    const lastRead = toolUseContext.readFileState.get(fullFilePath)
    if (!lastRead || lastRead.isPartialView) {
      const model = getGuardModel(toolUseContext)
      // 2.1.228 (binary Ssb-skip shape): newer models may overwrite an
      // unread file when a Read of it would have been auto-allowed anyway;
      // notebooks and old models still require the explicit read first.
      const guardSkipped =
        !lastRead &&
        !isNotebookPathForGuard(fullFilePath) &&
        !isOldModel(model) &&
        wouldReadBeAutoAllowed(
          FILE_WRITE_TOOL_NAME,
          fullFilePath,
          toolUseContext,
          toolPermissionContext,
        )
      logEvent('tengu_write_tool_not_read_hypothetical', {
        wouldHaveResult:
          lastRead && Math.floor(fileMtimeMs) > lastRead.timestamp
            ? 'errorCode3'
            : 'success',
        isPartialView: lastRead?.isPartialView === true,
        // Deliberately the raw input (not expandPath'd), matching the binary.
        isFilePathAbsolute: isAbsolute(file_path),
        guardSkipped,
        modelBucket: getModelBucket(model),
      })
      if (!guardSkipped) {
        return {
          result: false,
          message: FILE_NOT_READ_MESSAGE,
          errorCode: 2,
        }
      }
      return { result: true }
    }

    if (Math.floor(fileMtimeMs) > lastRead.timestamp) {
      // Timestamp says modified; for full reads compare content as a
      // fallback (mtime can move without content changes — cloud sync,
      // antivirus, Windows metadata writes). Binary $ot + i3o shape.
      let matchesDisk = false
      if (isFullReadOfFileState(lastRead)) {
        const diskBytes = await fs.readFileBytes(fullFilePath)
        matchesDisk = fileStateMatchesNormalized(
          lastRead,
          diskBytes.toString('utf8'),
        )
      }
      if (!matchesDisk) {
        return {
          result: false,
          message: FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE,
          errorCode: 3,
        }
      }
    }

    return { result: true }
  },
  async call({ file_path, content }, context, _, parentMessage) {
    const { readFileState, updateFileHistoryState, dynamicSkillDirTriggers } =
      context
    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)
    const toolPermissionContext = context.getAppState().toolPermissionContext

    // 2.1.228 (binary cVt): Read-deny-covered paths cannot be written,
    // re-checked at call time because settings may have changed since
    // validateInput.
    if (isCoveredByReadDenyRule(fullFilePath, toolPermissionContext)) {
      throw new FileStateError(READ_DENY_WRITE_MESSAGE)
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // Store discovered dirs for attachment display
      for (const discoveredDir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(discoveredDir)
      }
      // Don't await - let skill loading happen in the background
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // Activate conditional skills whose path patterns match this file
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    await diagnosticTracker.beforeFileEdited(fullFilePath)

    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state). Binary runs
      // fileHistory before the read/guard as well.
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullFilePath,
        parentMessage.uuid,
      )
    }

    // Load current state (LF-normalized, BOM kept — binary y2t shape).
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        meta = null
      } else {
        throw e
      }
    }

    // 2.1.228 call-time guard (binary Ssb): throws FileStateError when the
    // write must not proceed (unread file on old models / partial views, or
    // stale content that differs from disk).
    if (meta !== null) {
      assertWriteFileStateFresh({
        fullFilePath,
        diskContent: meta.content,
        lastRead: readFileState.get(fullFilePath),
        model: getGuardModel(context),
        readNotAutoAllowed: () =>
          !wouldReadBeAutoAllowed(
            FILE_WRITE_TOOL_NAME,
            fullFilePath,
            context,
            toolPermissionContext,
          ),
      })
    }

    // Ensure parent directory exists right before the write. The binary does
    // this after the guard; keep the write itself synchronous from here on
    // (no awaits between writeTextContent and the readFileState update).
    await getFsImplementation().mkdir(dir)

    // Write is a full content replacement — the model sent explicit line endings
    // in `content` and meant them. Do not rewrite them. Previously we preserved
    // the old file's line endings (or sampled the repo via ripgrep for new
    // files), which silently corrupted e.g. bash scripts with \r on Linux when
    // overwriting a CRLF file or when binaries in cwd poisoned the repo sample.
    writeTextContent(fullFilePath, content, meta?.encoding ?? 'utf8', 'LF')

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // didChange: Content has been modified
      lspManager.changeFile(fullFilePath, content).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file change for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    const oldContent = meta?.content ?? null

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(fullFilePath, oldContent, content)

    // Update read timestamp, to invalidate stale writes. Content stored in
    // the canonical readFileState form (binary J9: BOM-stripped, LF-only).
    readFileState.set(fullFilePath, {
      content: normalizeForComparison(content),
      timestamp: getFileModificationTime(fullFilePath),
      offset: undefined,
      limit: undefined,
    })

    // Log when writing to CLAUDE.md
    if (fullFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }

    let gitDiff: ToolUseDiff | undefined
    // 2.1.228: the `tengu_quartz_lantern` flag gate is gone — diff is
    // computed whenever CLAUDE_CODE_REMOTE is set.
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(fullFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isWriteTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    const userModified = context.userModified ?? false

    if (oldContent) {
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: content,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content,
        structuredPatch: patch,
        originalFile: oldContent,
        userModified,
        ...(gitDiff && { gitDiff }),
      }
      // Track lines added and removed for file updates, right before yielding result
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    const data = {
      type: 'create' as const,
      filePath: file_path,
      content,
      structuredPatch: [],
      originalFile: null,
      userModified,
      ...(gitDiff && { gitDiff }),
    }

    // For creation of new files, count all lines as additions, right before yielding the result
    countLinesChanged([], content)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  // 2.1.228 (binary shape): user-modified note, and the "file state is
  // current" note appended whenever the write succeeded without the user
  // touching the content.
  mapToolResultToToolResultBlockParam(
    { filePath, type, userModified },
    toolUseID,
  ) {
    const modifiedNote = userModified
      ? ' The user modified your proposed content before accepting it.'
      : ''
    const stateNote = userModified ? '' : FILE_STATE_CURRENT_NOTE
    switch (type) {
      case 'create':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath}${modifiedNote}${stateNote}`,
        }
      case 'update':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully.${modifiedNote}${stateNote}`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
