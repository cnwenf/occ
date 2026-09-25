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
import {
  getFsImplementation,
  resolveWritePathDescriptor,
} from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  macosNetworkMountDenyMessage,
  shouldDenyMacosNetworkMountPath,
} from '../../utils/macosKernelPaths.js'
import { validateNullByteFreeFields } from '../../utils/nullByteValidation.js'
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
  checkLeafSymlinkWriteDeny,
  checkWritePermissionForTool,
  expandPathForWriteDescriptor,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import {
  assertSymlinkResolutionsUnchangedForWrite,
  stashCheckTimeResolutions,
} from '../../utils/permissions/symlinkResolutionStash.js'
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
 * Official Claude Code v2.1.280 (byte-verified @198306051 `fxn`/`bZe` in the
 * v280 linux-x64 ELF): misnamed-parameter repair for the Write tool. The model
 * sometimes calls Write with `file_text`/`file_content` instead of `content`,
 * `path` instead of `file_path`, or an extra `description` param. Each repair
 * is recorded as a shapeClass tag (comma-joined, binary `r.join(",")`) and a
 * note sentence; the sentences (space-joined, binary `s.join(" ")`) fill the
 * resultNote template (binary, byte-exact):
 *
 *   `Note: ${En}'s parameters are named \`file_path\` and \`content\`. ${s.join(" ")}`
 *
 * with `En="Write"` (@192662800). Coercion rules, byte-verified from `bZe`:
 * - `path` → `file_path`: only when `file_path` is NOT an own key and
 *   `typeof path === "string"`. Sentence: "`path` was read as `file_path`."
 * - `file_text`/`file_content` → `content`: only when EXACTLY ONE of the two
 *   is an own key (`g.length===1`), `content` is NOT an own key, and the value
 *   is a string. Precedence: an own `content` key always wins (no coercion —
 *   the misnamed key stays and strictObject rejects it); both misnamed keys
 *   present → no coercion. Sentence: "`<key>` was read as `content`."
 * - `description`: dropped whenever present (own key). Sentence:
 *   "`description` was ignored." shapeClass tag: `drop_description`.
 * Returns null when nothing changed (binary: `return r.length?...:null`).
 * Operates on a shallow copy — the original API-bound input is never mutated.
 */
const MISNAMED_CONTENT_KEYS = ['file_text', 'file_content']

/**
 * CC 2.1.281 changelog #041 — full alias table for the duplicate-alias dedup
 * pass. Byte-verified against the v281 ELF @201115780 (`ett()` + `Rvn`/`Zet`):
 *
 *   Zet=["file_text","file_content"],
 *   Rvn={file_path:["path","file"],
 *        content:[...Zet,"new_text","body","text","contents"]}
 *
 * The v281 COERCION stage is unchanged from v280 (still Zet-only for
 * content); the NEW dedup loop walks the full Rvn table: an alias whose value
 * EQUALS the canonical value is a harmless model repeat — it is deleted
 * (shapeClass `repeated_<alias>`, note "`<alias>` repeated `<canonical>` and
 * was ignored.") so the call SUCCEEDS. Aliases with CONFLICTING values are
 * left in place → strictObject rejects the call.
 */
const WRITE_PARAM_ALIASES: Record<string, readonly string[]> = {
  file_path: ['path', 'file'],
  content: [...MISNAMED_CONTENT_KEYS, 'new_text', 'body', 'text', 'contents'],
}
const WRITE_CANONICAL_PARAMS = ['file_path', 'content'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function coerceWriteInput(raw: unknown): {
  input: Record<string, unknown>
  shapeClass: string
  resultNote: string
} | null {
  if (!isRecord(raw)) return null
  const n: Record<string, unknown> = { ...raw }
  const shapeClasses: string[] = []
  const sentences: string[] = []
  if (!Object.hasOwn(n, 'file_path') && typeof n.path === 'string') {
    n.file_path = n.path
    delete n.path
    shapeClasses.push('path')
    sentences.push('`path` was read as `file_path`.')
  }
  const present = MISNAMED_CONTENT_KEYS.filter(key => Object.hasOwn(n, key))
  const [first] = present
  if (
    first !== undefined &&
    present.length === 1 &&
    !Object.hasOwn(n, 'content') &&
    typeof n[first] === 'string'
  ) {
    n.content = n[first]
    delete n[first]
    shapeClasses.push(first)
    sentences.push(`\`${first}\` was read as \`content\`.`)
  }
  if (Object.hasOwn(n, 'description')) {
    delete n.description
    shapeClasses.push('drop_description')
    sentences.push('`description` was ignored.')
  }
  // CC 2.1.281 #041 (official ett() dedup loop @201115780, byte-faithful):
  //   for(let _ of["file_path","content"])
  //     for(let w of Rvn[_])
  //       if(typeof n[_]==="string"&&n[w]===n[_])
  //         delete n[w],r.push(`repeated_${w}`),
  //         s.push(`\`${w}\` repeated \`${_}\` and was ignored.`)
  // An alias carrying the SAME value as its canonical param is a harmless
  // model repeat — drop it so the call succeeds. A conflicting value stays
  // and the strictObject schema rejects the call.
  for (const canonical of WRITE_CANONICAL_PARAMS) {
    for (const alias of WRITE_PARAM_ALIASES[canonical] ?? []) {
      if (typeof n[canonical] === 'string' && n[alias] === n[canonical]) {
        delete n[alias]
        shapeClasses.push(`repeated_${alias}`)
        sentences.push(`\`${alias}\` repeated \`${canonical}\` and was ignored.`)
      }
    }
  }
  return shapeClasses.length
    ? {
        input: n,
        shapeClass: shapeClasses.join(','),
        resultNote: `Note: ${FILE_WRITE_TOOL_NAME}'s parameters are named \`file_path\` and \`content\`. ${sentences.join(' ')}`,
      }
    : null
}

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
  // Official v2.1.280 Write-tool def (byte-verified @198309000):
  // `coerceInputBeforePluginHooks:!0,coerceInput(e){let n=bZe(e);return
  // n!==null&&yxn()&&vZe().safeParse(n.input).success?n:null}` — the repair is
  // only returned when the COERCED input passes the full input schema, so a
  // partial repair (e.g. `path`→`file_path` but still no `content`) yields
  // null and validation proceeds on the original input (no note either).
  // `yxn()` is the statsig gate `x("tengu_noble_mountain",!0)` (@198308036) —
  // DEFAULT-TRUE; per the port decision a default-true gate ≡ always on, so
  // OCC omits the gate call (documented in the gap notes).
  coerceInputBeforePluginHooks: true,
  coerceInput(input) {
    const repair = coerceWriteInput(input)
    return repair !== null && inputSchema().safeParse(repair.input).success
      ? repair
      : null
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
    // CC 2.1.280 (changelog #005): official Write-tool wiring @198310186:
    // `let s=et(n.file_path),g=da(s);
    //  e.session.writePermissionStash.stash(r.toolUseId,s,g.spellings);
    //  let h=D_(LS,n,e.permissions(),g);
    //  return h.behavior==="deny"?h:XZe(s,g)??h`
    // A rule DENY from the main write check wins; otherwise the leaf-symlink
    // deny (XZe) overrides even an allow result.
    const expandedPath = expandPathForWriteDescriptor(
      FileWriteTool.getPath(input),
    )
    const descriptor = resolveWritePathDescriptor(expandedPath)
    // CC 2.1.251 (Gap-109a): stash the check-time symlink resolutions of
    // the target path, write lane (binary FileWriteTool Ky stash site);
    // since 2.1.280 the stashed set is the descriptor's spellings.
    stashCheckTimeResolutions(
      context,
      FileWriteTool.getPath(input),
      'write',
      descriptor.spellings,
    )
    const appState = context.getAppState()
    const result = checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
      undefined,
      descriptor,
    )
    if (result.behavior === 'deny') {
      return result
    }
    return checkLeafSymlinkWriteDeny(expandedPath, descriptor) ?? result
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
    // CC 2.1.281 #040 (official fy(vn,[["file_path",g]]) @201120196): a null
    // byte in file_path is a per-call validation error (errorCode 2) BEFORE
    // expandPath — the expandPath throw would otherwise end the whole turn.
    const nullByteCheck = validateNullByteFreeFields(FILE_WRITE_TOOL_NAME, [
      ['file_path', file_path],
    ])
    if (nullByteCheck !== null) {
      return nullByteCheck
    }
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
      // Official 2.1.269 (E29): binary v269 FileWriteTool
      // `{result:!1,message:Iit,errorCode:1,deniedByPermissionRule:!0}`.
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
        deniedByPermissionRule: true,
      }
    }

    // 2.1.228 (binary cVt): a Read deny rule covering this path also blocks
    // writing it — writing would let the model refresh content it was denied
    // reading.
    if (isCoveredByReadDenyRule(fullFilePath, toolPermissionContext)) {
      // Official 2.1.269 (E29): `{result:!1,message:HFn,errorCode:13,
      // deniedByPermissionRule:!0}`.
      return {
        result: false,
        message: READ_DENY_WRITE_MESSAGE,
        errorCode: 13,
        deniedByPermissionRule: true,
      }
    }

    // CC 2.1.281 #033 (security): on macOS, deny automount (/net, /Network)
    // and kernel-resolved (/.vol, /.file, /.nofollow, /.resolve) prefixes
    // before any filesystem operation — stat/lstat on these can trigger a
    // directory-service lookup and mount to a remote host. Darwin-gated no-op
    // elsewhere. Official deny sentence @97322030.
    if (shouldDenyMacosNetworkMountPath(fullFilePath)) {
      return {
        result: false,
        message: macosNetworkMountDenyMessage(file_path),
        errorCode: 1,
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
      // 2.1.277: a Write whose target is an existing directory (or any other
      // non-regular file) previously fell through to the permission prompt and
      // silently ended the turn as DECLINED PERMISSION. Surface a clear
      // validation error instead. Messages + errorCodes are byte-copied from
      // the binary; the interpolated path is the raw input (not expandPath'd),
      // matching the official `${g}`.
      if (fileStat.isDirectory()) {
        return {
          result: false,
          message: `${file_path} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
          errorCode: 17,
        }
      }
      if (!fileStat.isFile()) {
        return {
          result: false,
          message: `${file_path} exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.`,
          errorCode: 18,
        }
      }
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
    // CC 2.1.251 (Gap-109a): TOCTOU gate — refuse if the symlink resolution
    // changed between checkPermissions and now (binary LC gate s()).
    assertSymlinkResolutionsUnchangedForWrite(context, fullFilePath)
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
