import { dirname, isAbsolute, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
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
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { perforceReadOnlyError } from '../../utils/perforce.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import {
  checkEditFileStateAtCall,
  editWouldApplyToTelemetry,
  FileStateError,
  FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE,
  FILE_NOT_READ_MESSAGE,
  FILE_STATE_CURRENT_NOTE,
  fileStateMatchesDisk,
  getGuardModel,
  getModelBucket,
  isCoveredByReadDenyRule,
  isFullReadOfFileState,
  isOldModel,
  normalizeForComparison,
  READ_DENY_EDIT_MESSAGE,
  stripBom,
  wouldReadBeAutoAllowed,
} from '../../utils/permissions/fileStateGuard.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import {
  assertSymlinkResolutionsUnchangedForWrite,
  stashCheckTimeResolutions,
} from '../../utils/permissions/symlinkResolutionStash.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import {
  areFileEditsInputsEquivalent,
  checkEditWouldApply,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
} from './utils.js'

/** Fda — old_string contains a literal \uXXXX escape sequence. */
const UNICODE_ESCAPE_PATTERN = /\\u[0-9a-fA-F]{4}/
/** Uda — old_string contains a non-ASCII BMP character. */
const NON_ASCII_PATTERN = /[\u0080-\uffff]/

/**
 * bvp — when true, the errorCode-8 message adds the escape-swapping note
 * (2.1.228 binary shape).
 */
function hasUnicodeEscapesOrNonAscii(value: string): boolean {
  return UNICODE_ESCAPE_PATTERN.test(value) || NON_ASCII_PATTERN.test(value)
}

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return "Performs exact string replacement in a file."
  },
  async prompt() {
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.new_string}`
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
    // CC 2.1.251 (Gap-109a): stash the check-time symlink resolutions of
    // the target path, write lane (binary FileEditTool B_ stash site).
    stashCheckTimeResolutions(context, FileEditTool.getPath(input), 'write')
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)

    // Reject edits to team memory files that introduce secrets
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // 2.1.228 (binary cVt): a Read deny rule covering this path also blocks
    // editing it — the edit flow would otherwise refresh content the model
    // was denied reading.
    if (
      isCoveredByReadDenyRule(fullFilePath, appState.toolPermissionContext)
    ) {
      return {
        result: false,
        behavior: 'ask',
        message: READ_DENY_EDIT_MESSAGE,
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

    // Prevent OOM on multi-GB files + Perforce read-only check (2.1.98).
    try {
      const stats = await fs.stat(fullFilePath)
      if (stats.size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(stats.size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
      // 2.1.98: in Perforce mode, a read-only file (no owner-write bit) hasn't
      // been opened for edit — block the edit with a `p4 edit` hint instead of
      // silently overwriting it.
      const perforceError = perforceReadOnlyError(stats.mode)
      if (perforceError) {
        return {
          result: false,
          behavior: 'ask',
          message: perforceError,
          errorCode: 11,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      // Binary J9 shape: BOM-stripped + LF-normalized, the canonical form
      // readFileState stores, so stale-content comparisons line up.
      fileContent = normalizeForComparison(fileBuffer.toString(encoding))
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist
    if (fileContent === null) {
      // Empty old_string on nonexistent file means new file creation — valid
      if (old_string === '') {
        return { result: true }
      }
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // File exists with empty old_string — only valid if file is empty
    if (old_string === '') {
      // Only reject if the file has content (for file creation attempt)
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // Empty file with empty old_string is valid - we're replacing empty with content
      return {
        result: true,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    const lastRead = toolUseContext.readFileState.get(fullFilePath)
    const toolPermissionContext = appState.toolPermissionContext
    if (!lastRead || lastRead.isPartialView) {
      const model = getGuardModel(toolUseContext)
      // 2.1.228 (binary shape): newer models may edit an unread file when a
      // Read of it would have been auto-allowed anyway. Unlike Write there is
      // no notebook exemption here (.ipynb already returned errorCode 5) and
      // the skip also covers partial views.
      const guardSkipped =
        !isOldModel(model) &&
        wouldReadBeAutoAllowed(
          FILE_EDIT_TOOL_NAME,
          fullFilePath,
          toolUseContext,
          toolPermissionContext,
        )
      logEvent('tengu_edit_tool_not_read_hypothetical', {
        wouldHaveResult: editWouldApplyToTelemetry(
          checkEditWouldApply(fileContent, old_string, replace_all),
        ),
        isPartialView: lastRead?.isPartialView === true,
        // Deliberately the raw input (not expandPath'd), matching the binary.
        isFilePathAbsolute: String(isAbsolute(file_path)),
        guardSkipped,
        modelBucket: getModelBucket(model),
      })
      if (!guardSkipped) {
        return {
          result: false,
          behavior: 'ask',
          message: FILE_NOT_READ_MESSAGE,
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
          },
          errorCode: 6,
        }
      }
    }

    // Check if file exists and get its last modified time
    if (lastRead) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > lastRead.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives (binary
        // $ot + Exe shape).
        if (
          !(
            isFullReadOfFileState(lastRead) &&
            fileStateMatchesDisk(lastRead, fileContent)
          )
        ) {
          // claude-code 2.1.208 #13 / 2.1.228: the file changed after Read,
          // but the edit can still succeed when the target text matches
          // uniquely and a Read of the file would be auto-allowed (binary
          // Mwt predicate). Otherwise fall back to the stale-read error.
          const wouldApply = checkEditWouldApply(
            fileContent,
            old_string,
            replace_all,
          )
          const recovered =
            wouldApply === 'applies' &&
            wouldReadBeAutoAllowed(
              FILE_EDIT_TOOL_NAME,
              fullFilePath,
              toolUseContext,
              toolPermissionContext,
            )
          logEvent('tengu_edit_tool_stale_read', {
            wouldHaveResult: editWouldApplyToTelemetry(wouldApply),
            recovered,
          })
          if (!recovered) {
            return {
              result: false,
              behavior: 'ask',
              message: FILE_MODIFIED_SINCE_READ_VALIDATION_MESSAGE,
              errorCode: 7,
            }
          }
          // Recovered: fall through to the normal findActualString/uniqueness
          // validation, which will succeed because wouldApply === 'applies'.
        }
      }
    }

    const file = fileContent

    // Use findActualString to handle quote normalization
    const actualOldString = findActualString(file, old_string)
    if (!actualOldString) {
      // 2.1.228 (binary bvp): when old_string contains \uXXXX escapes or
      // non-ASCII characters, add the escape-swapping note.
      const escapeNote = hasUnicodeEscapesOrNonAscii(old_string)
        ? '\n(note: Edit also tried swapping \\uXXXX escapes and their characters; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)'
        : ''
      return {
        result: false,
        behavior: 'ask',
        message: `String to replace not found in file.\nString: ${old_string}${escapeNote}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    const matches = file.split(actualOldString).length - 1

    // Check if we have multiple matches but replace_all is false
    if (matches > 1 && !replace_all) {
      return {
        result: false,
        behavior: 'ask',
        message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          actualOldString,
        },
        errorCode: 9,
      }
    }

    // Additional validation for Claude settings files
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => {
        // Simulate the edit to get the final content using the exact same logic as the tool
        return replace_all
          ? file.replaceAll(actualOldString, new_string)
          : file.replace(actualOldString, new_string)
      },
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    return { result: true, meta: { actualOldString } }
  },
  inputsEquivalent(input1, input2) {
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  async call(
    input: FileEditInput,
    toolUseContext: ToolUseContext,
    _,
    parentMessage,
  ) {
    const { readFileState, userModified, updateFileHistoryState, dynamicSkillDirTriggers } =
      toolUseContext
    const { file_path, old_string, new_string, replace_all = false } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)
    // CC 2.1.251 (Gap-109a): TOCTOU gate — refuse if the symlink resolution
    // changed between checkPermissions and now (binary LC gate s()).
    assertSymlinkResolutionsUnchangedForWrite(toolUseContext, absoluteFilePath)
    const toolPermissionContext =
      toolUseContext.getAppState().toolPermissionContext

    // 2.1.228 (binary cVt): Read-deny-covered paths cannot be edited,
    // re-checked at call time because settings may have changed since
    // validateInput.
    if (isCoveredByReadDenyRule(absoluteFilePath, toolPermissionContext)) {
      throw new FileStateError(READ_DENY_EDIT_MESSAGE)
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state). Binary runs
      // fileHistory before the read/guard as well.
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state and confirm no changes since last read
    // Please avoid async operations between here and writing to disk to preserve atomicity
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    // 2.1.228 call-time guard (binary C8b): throws FileStateError when the
    // edit must not proceed; returns true when the file changed since the
    // last read but the edit still applies cleanly (staleRecovered).
    const staleRecovered =
      fileExists &&
      checkEditFileStateAtCall({
        absoluteFilePath,
        fileContents: originalFileContents,
        lastRead: readFileState.get(absoluteFilePath),
        oldString: old_string,
        replaceAll: replace_all,
        model: getGuardModel(toolUseContext),
        readNotAutoAllowed: () =>
          !wouldReadBeAutoAllowed(
            FILE_EDIT_TOOL_NAME,
            absoluteFilePath,
            toolUseContext,
            toolPermissionContext,
          ),
      })

    // 3. Use findActualString to handle quote normalization
    const actualOldString =
      findActualString(originalFileContents, old_string) || old_string

    // Preserve curly quotes in new_string when the file uses them
    const actualNewString = preserveQuoteStyle(
      old_string,
      actualOldString,
      new_string,
    )

    // 4. Generate patch
    const { patch, updatedFile } = getPatchForEdit({
      filePath: absoluteFilePath,
      fileContents: originalFileContents,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    // 5. Ensure parent directory exists, then write to disk (binary order:
    // patch → mkdir → write; from the guard above the write itself stays
    // synchronous).
    await fs.mkdir(dirname(absoluteFilePath))
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
      // didChange: Content has been modified
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // 6. Update read timestamp, to invalidate stale writes. Content stored
    // BOM-stripped (binary Hxe); line endings are preserved by Edit, so no
    // CRLF normalization here.
    readFileState.set(absoluteFilePath, {
      content: stripBom(updatedFile),
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 7. Log events
    if (absoluteFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }
    countLinesChanged(patch)

    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    logEvent('tengu_edit_string_lengths', {
      oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
      newStringBytes: Buffer.byteLength(new_string, 'utf8'),
      replaceAll: replace_all,
    })

    let gitDiff: ToolUseDiff | undefined
    // 2.1.228: the `tengu_quartz_lantern` flag gate is gone — diff is
    // computed whenever CLAUDE_CODE_REMOTE is set.
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(absoluteFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isEditTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // 8. Yield result
    const data = {
      filePath: file_path,
      oldString: actualOldString,
      newString: new_string,
      originalFile: originalFileContents,
      structuredPatch: patch,
      userModified: userModified ?? false,
      replaceAll: replace_all,
      ...(staleRecovered && { staleRecovered: true }),
      ...(gitDiff && { gitDiff }),
    }
    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, replaceAll, staleRecovered } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    // 2.1.228 (binary shape): stale-recovery disclosure takes precedence;
    // otherwise the "file state is current" note is appended unless the user
    // modified the edit.
    const trailingNote = staleRecovered
      ? ' (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding context.)'
      : userModified
        ? ''
        : FILE_STATE_CURRENT_NOTE

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${trailingNote}`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${trailingNote}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
