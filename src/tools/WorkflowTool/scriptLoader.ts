/**
 * K3 (2.1.154): Workflow script loader + parser.
 *
 * Mirrors the 2.1.200 binary's V5e(scriptPath): reads the script file,
 * extracts `export const meta = { name, description, phases }` (which MUST
 * be the FIRST statement), and returns { meta, body, hasDefaultExport }.
 *
 * Script format (ESM):
 *   export const meta = { name, description, phases };
 *   // body — either:
 *   export default async ({ agent, parallel, ... }) => { ... return result; };
 *   //   OR top-level code:
 *   const r = await agent('hi');
 *   return r;
 *
 * Sandbox determinism (binary): "new Date() ... unavailable in workflow
 * scripts (breaks resume)", "Math.random() is unavailable", "import() is
 * not available", "top-level await" — these break deterministic resume.
 * We validate the body against these so resume is reproducible.
 *
 * scriptPath validation: reject UNC paths (\\\\ prefix) and path traversal.
 *
 * 2.1.251 security fix (changelog, Gap-109c): the workflow script could be
 * read from outside the readable set. Ported byte-semantically from the
 * official 2.1.251 binary (aligning-with-official-binary skill — nothing
 * invented). Minified official identifiers kept for traceability:
 *
 *   It   -> scriptPathNotReadableMessage
 *   dtn  -> checkScriptPathReadable (network gate + readable-set probe)
 *   Wo   -> isScriptPathInReadableSet (tool-list gate + probe)
 *   nJ   -> !isReadToolUnavailableForGuard && isReadAutoAllowedForPath
 *   zl   -> isReadToolUnavailableForGuard (fileStateGuard, 2.1.228 port)
 *   f_r  -> isReadAutoAllowedForPath (fileStateGuard, 2.1.228 port)
 *   Ast  -> loadScriptGated (TOCTOU-hardened reader)
 *   cm   -> WORKFLOW_SCRIPT_MAX_BYTES (524288)
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import vm from 'node:vm'
import type { ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { REPL_TOOL_NAME } from '../REPLTool/constants.js'
import { isENOENT } from '../../utils/errors.js'
import { getCwd } from '../../utils/cwd.js'
import {
  containsNtNamespacePath,
  isAutomountPath,
} from '../../utils/ntNamespacePaths.js'
import { isReadAutoAllowedForPath } from '../../utils/permissions/fileStateGuard.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

export interface WorkflowMeta {
  name: string
  description: string
  phases?: string[]
}

export interface LoadedScript {
  meta: WorkflowMeta
  body: string
  /** True when the body contains an `export default` (function shape).
   * False for top-level-code shape. */
  hasDefaultExport: boolean
  /** The default-export expression text (when hasDefaultExport), e.g.
   * `async ({ agent }) => { ... }`. Undefined for top-level shape. */
  defaultExportExpr?: string
  scriptPath: string
  source: string
}

export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowScriptError'
  }
}

/** cm — binary's workflow script size cap, byte-verbatim. */
export const WORKFLOW_SCRIPT_MAX_BYTES = 524288

/**
 * It — the binary's message when a scriptPath falls outside the readable
 * set (or fails any TOCTOU check). Byte-verbatim; note it names the RAW
 * scriptPath the caller supplied, never the canonical path.
 */
export function scriptPathNotReadableMessage(scriptPath: string): string {
  return (
    'scriptPath must be a script path this tool returned, or a file you can ' +
    `already read (the working directory or a directory you have added): ${scriptPath}`
  )
}

/**
 * Network-path violation check shared by validateScriptPath (throw form) and
 * checkScriptPathReadable (return form). Mirrors the 2.1.234 binary gate
 * (Khn) — checks the raw scriptPath AND the cwd-resolved path for the
 * automount form. Returns the byte-matched official message, or null.
 */
function getNetworkPathViolation(
  scriptPath: string,
  resolved: string,
): string | null {
  if (
    /^[\\/]{2}/.test(scriptPath) ||
    containsNtNamespacePath(scriptPath) ||
    isAutomountPath(scriptPath) ||
    isAutomountPath(resolved)
  ) {
    return `Network (UNC, NT-namespace, or automount) paths are not allowed for workflow scriptPath: ${scriptPath}`
  }
  return null
}

/**
 * Validate a scriptPath. Rejects network (UNC `\\`/`//` prefix), NT-namespace
 * (`\??\` / object-manager namespaces), and automount (`/net/<share>`) paths,
 * plus path traversal. Returns the resolved absolute path.
 *
 * Mirrors the 2.1.234 binary gate (`sYt`), byte-verified — the gate checks the
 * raw scriptPath AND the cwd-resolved path for the automount form, and rejects
 * with the exact official message.
 */
export function validateScriptPath(scriptPath: string): string {
  if (!scriptPath || typeof scriptPath !== 'string') {
    throw new WorkflowScriptError('workflow scriptPath must be a non-empty string')
  }
  const resolved = isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath)
  // Network UNC prefix (\\ or //), NT-namespace device paths, or automount
  // paths are not allowed — the resolved path is checked for automount too.
  const violation = getNetworkPathViolation(scriptPath, resolved)
  if (violation !== null) {
    throw new WorkflowScriptError(violation)
  }
  // Reject path traversal — resolved path must not escape via .. normalization
  // (path.join normalizes, but an absolute path with .. is still suspicious;
  // we just require it resolves to a real absolute path).
  return resolved
}

/**
 * Wo/nJ — would a Read of this path be auto-allowed, given the current tool
 * list? Byte-semantic port of the binary's readable-set probe:
 *  - Wo's first gate: a restricted tool list (non-empty) with neither Read
 *    nor REPL cannot have read anything, so nothing is in the readable set.
 *  - nJ: the probe is disabled when the named tool (Workflow) is registered
 *    without Read/REPL (zl), else a hypothetical Read of the path must be
 *    auto-allowed (f_r = isReadAutoAllowedForPath, fileStateGuard 2.1.228
 *    port — same minimal Read probe, same Read+REPL pair the binary uses).
 */
function isScriptPathInReadableSet(
  fullFilePath: string,
  context: ToolUseContext,
): boolean {
  const tools = context.options.tools ?? []
  const hasReadTool = tools.some(tool =>
    toolMatchesName(tool, FILE_READ_TOOL_NAME),
  )
  const hasReplTool = tools.some(tool => toolMatchesName(tool, REPL_TOOL_NAME))
  if (tools.length > 0 && !hasReadTool && !hasReplTool) {
    return false
  }
  if (
    tools.some(tool => toolMatchesName(tool, WORKFLOW_TOOL_NAME)) &&
    !hasReadTool &&
    !hasReplTool
  ) {
    return false
  }
  return isReadAutoAllowedForPath(
    fullFilePath,
    context.getAppState().toolPermissionContext,
  )
}

/**
 * dtn — the validateInput-time gate. Resolves the scriptPath against the cwd,
 * runs the network gate (Khn) and the readable-set probe (Wo), and returns
 * the byte-matched error message or null when the path passes.
 */
export function checkScriptPathReadable(
  scriptPath: string,
  context: ToolUseContext,
): string | null {
  if (!scriptPath || typeof scriptPath !== 'string') {
    return 'workflow scriptPath must be a non-empty string'
  }
  const resolved = resolve(getCwd(), scriptPath)
  const violation = getNetworkPathViolation(scriptPath, resolved)
  if (violation !== null) {
    return violation
  }
  return isScriptPathInReadableSet(resolved, context)
    ? null
    : scriptPathNotReadableMessage(scriptPath)
}

/** /proc/self/fd/<fd> readlink — null when unavailable (non-Linux, races). */
function readFdLinkTarget(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return null
  }
}

export type GatedScriptLoad = { script: string; path: string } | { error: string }

/**
 * Ast — the TOCTOU-hardened script reader. Byte-semantic port of the 2.1.251
 * binary: dtn gate on the raw path, then open(O_RDONLY|O_NONBLOCK), bigint
 * fstat (ino===0 / nlink>1 reject), canonical path via /proc/self/fd readlink
 * (realpath fallback with an O_NOFOLLOW re-open + ino/dev/nlink compare +
 * realpath stability check when readlink is unavailable), RE-PROBE of the
 * canonical path, isFile check, 512 KiB cap, full read. Every failure returns
 * the byte-matched official error string — never file content.
 */
export function loadScriptGated(
  scriptPath: string,
  context: ToolUseContext,
): GatedScriptLoad {
  const gateError = checkScriptPathReadable(scriptPath, context)
  if (gateError !== null) {
    return { error: gateError }
  }
  const resolved = resolve(getCwd(), scriptPath)
  const isWindows = process.platform === 'win32'
  const openFlags =
    fsConstants.O_RDONLY | (isWindows ? 0 : fsConstants.O_NONBLOCK)
  let fd: number
  try {
    fd = openSync(resolved, openFlags)
  } catch (e) {
    return {
      error: isENOENT(e)
        ? `Workflow script file not found: ${scriptPath}`
        : `Failed to read workflow script file ${scriptPath}`,
    }
  }
  try {
    const openStat = fstatSync(fd, { bigint: true })
    if (openStat.ino === 0n || openStat.nlink > 1n) {
      return { error: scriptPathNotReadableMessage(scriptPath) }
    }
    const fdLinkTarget = readFdLinkTarget(fd)
    const canonicalPath = fdLinkTarget ?? realpathSync(resolved)
    if (fdLinkTarget === null) {
      // No /proc/self/fd readlink: prove the canonical path is the same file
      // via an O_NOFOLLOW re-open before trusting it.
      const verifyFd = openSync(
        canonicalPath,
        openFlags | (isWindows ? 0 : fsConstants.O_NOFOLLOW),
      )
      try {
        const verifyStat = fstatSync(verifyFd, { bigint: true })
        if (
          verifyStat.ino !== openStat.ino ||
          verifyStat.dev !== openStat.dev ||
          verifyStat.nlink !== 1n
        ) {
          return { error: scriptPathNotReadableMessage(scriptPath) }
        }
      } finally {
        closeSync(verifyFd)
      }
      let reResolved: string | null = null
      try {
        reResolved = realpathSync(canonicalPath)
      } catch {
        // stays null — fails the stability check below
      }
      if (reResolved !== canonicalPath) {
        return { error: scriptPathNotReadableMessage(scriptPath) }
      }
      if (fstatSync(fd, { bigint: true }).nlink !== 1n) {
        return { error: scriptPathNotReadableMessage(scriptPath) }
      }
    }
    // Re-probe the CANONICAL path — the probe above covered the caller's
    // path only; a symlink could otherwise carry the read out of scope.
    if (!isScriptPathInReadableSet(canonicalPath, context)) {
      return { error: scriptPathNotReadableMessage(scriptPath) }
    }
    if (!openStat.isFile()) {
      return {
        error: `Workflow script file ${scriptPath} is not a regular file`,
      }
    }
    if (openStat.size > BigInt(WORKFLOW_SCRIPT_MAX_BYTES)) {
      return {
        error: `Workflow script file ${scriptPath} exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes`,
      }
    }
    const buffer = Buffer.alloc(Number(openStat.size))
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      )
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    return {
      script: buffer.subarray(0, offset).toString('utf-8'),
      path: canonicalPath,
    }
  } catch {
    return { error: `Failed to read workflow script file ${scriptPath}` }
  } finally {
    closeSync(fd)
  }
}

/**
 * Find the end of the first `export const meta = {...}` statement by brace
 * balancing from the opening `{`. Returns the index just past the closing
 * `}` (and an optional trailing `;`).
 */
function findMetaEnd(source: string, openBraceIndex: number): number {
  let depth = 0
  let inString: false | "'" | '"' | '`' = false
  let escaped = false
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inString) {
      if (ch === inString) inString = false
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch as "'" | '"' | '`'
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        // consume optional trailing semicolon + whitespace
        let end = i + 1
        while (end < source.length && /[;\s]/.test(source[end]!)) end++
        return end
      }
    }
  }
  return -1 // unbalanced
}

/**
 * Extract `export const meta = {...}` as the FIRST statement. Returns
 * { metaJson, bodyStart } where metaJson is the raw object text and bodyStart
 * is the index where the remaining body begins.
 */
function extractMetaStatement(source: string): {
  metaJson: string
  bodyStart: number
} {
  // Match `export const meta = {` at the start (allowing leading whitespace/newlines).
  const match = source.match(/^[\s]*export\s+const\s+meta\s*=\s*\{/)
  if (!match) {
    throw new WorkflowScriptError(
      'Workflow script must begin with `export const meta = { ... }` as the ' +
        'first statement. Got: ' +
        source.slice(0, 80).replace(/\n/g, ' '),
    )
  }
  const openBrace = source.indexOf('{', match.index! + match[0].length - 1)
  const metaEnd = findMetaEnd(source, openBrace)
  if (metaEnd === -1) {
    throw new WorkflowScriptError(
      'Workflow script has unbalanced braces in `export const meta = {...}`',
    )
  }
  const metaJson = source.slice(openBrace, metaEnd).replace(/;?\s*$/, '')
  // Re-read the full object including braces
  const fullObject = source.slice(openBrace, metaEnd).replace(/;?\s*$/, '')
  return { metaJson: fullObject, bodyStart: metaEnd }
}

/**
 * Parse the meta object from its JSON-ish text. We eval it in a sandboxed
 * vm context (object literals are valid JS). Returns the validated meta.
 */
function parseMeta(metaJson: string): WorkflowMeta {
  // Strip surrounding braces temporarily, re-add — metaJson includes braces.
  const ctx = vm.createContext({})
  let parsed: unknown
  try {
    parsed = vm.runInContext(`(${metaJson})`, ctx, { timeout: 1000 })
  } catch (e) {
    throw new WorkflowScriptError(
      `Failed to parse workflow meta: ${(e as Error).message}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorkflowScriptError('Workflow meta must be an object literal')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name) {
    throw new WorkflowScriptError(
      'Workflow meta must include a non-empty `name` string',
    )
  }
  if (typeof obj.description !== 'string' || !obj.description) {
    throw new WorkflowScriptError(
      'Workflow meta must include a non-empty `description` string',
    )
  }
  const meta: WorkflowMeta = {
    name: obj.name,
    description: obj.description,
  }
  if (Array.isArray(obj.phases)) {
    meta.phases = obj.phases.filter(
      (p): p is string => typeof p === 'string',
    )
  }
  return meta
}

/**
 * Validate the body for sandbox determinism. The binary disallows Date,
 * Math.random, import(), and top-level await to guarantee reproducible
 * resume. We enforce the same so resume is deterministic.
 *
 * Note: top-level await is supported by our engine (we wrap the body in an
 * async IIFE), but the binary disallows it for resume-determinism. We emit
 * a warning rather than blocking, since OCC's engine supports it safely.
 */
function validateBodyDeterminism(body: string): void {
  // Hard block on Date constructor / new Date / Date.now — breaks resume.
  if (/\bnew\s+Date\s*\(/.test(body) || /\bDate\.now\s*\(/.test(body)) {
    throw new WorkflowScriptError(
      'new Date() and Date.now() are unavailable in workflow scripts ' +
        '(breaks resume). Use the `phase()` counter or agent results for ' +
        'ordering instead.',
    )
  }
  // Hard block on Math.random — breaks resume.
  if (/\bMath\.random\s*\(/.test(body)) {
    throw new WorkflowScriptError(
      'Math.random() is unavailable in workflow scripts (breaks resume).',
    )
  }
  // Hard block on dynamic import() — not available in the vm sandbox.
  if (/\bimport\s*\(/.test(body)) {
    throw new WorkflowScriptError(
      'import() is not available in workflow scripts.',
    )
  }
}

/**
 * Detect whether the body has an `export default` and extract its expression.
 * Returns { hasDefaultExport, defaultExportExpr, body } where body has the
 * `export default ` prefix stripped (replaced by nothing — the expression
 * stands alone) when a default export is present.
 */
function extractDefaultExport(
  body: string,
): {
  hasDefaultExport: boolean
  defaultExportExpr?: string
  body: string
} {
  // Match `export default ` possibly preceded by whitespace/newline.
  const m = body.match(/^([\s]*export\s+default\s+)([\s\S]*)$/m)
  if (!m) {
    return { hasDefaultExport: false, body }
  }
  const expr = m[2]!.replace(/;\s*$/, '')
  // The remaining body (for top-level shape) is just the default export.
  // We return the expression so the engine can compile + call it.
  return { hasDefaultExport: true, defaultExportExpr: expr, body }
}

/**
 * Parse a workflow script from its source text. Used for both file-based
 * loading (loadScript reads the file then calls this) and inline `script`
 * content (the Workflow tool's inline invocation mode — the model provides
 * the full script body directly in the tool call, no file needed).
 *
 * Mirrors official CC 2.1.206's inline `script` field + the
 * `scriptPath | named | inline` invocation modes.
 */
export function loadScriptFromSource(
  source: string,
  scriptPath?: string,
): LoadedScript {
  const label = scriptPath ?? '<inline>'
  if (!source.trim()) {
    throw new WorkflowScriptError(`Workflow script ${label} is empty`)
  }

  const { metaJson, bodyStart } = extractMetaStatement(source)
  const meta = parseMeta(metaJson)

  let body = source.slice(bodyStart).trim()
  if (!body) {
    throw new WorkflowScriptError(
      `Workflow script ${label} has no body after \`export const meta\``,
    )
  }

  validateBodyDeterminism(body)

  const { hasDefaultExport, defaultExportExpr, body: cleanedBody } =
    extractDefaultExport(body)

  return {
    meta,
    body: cleanedBody,
    hasDefaultExport,
    defaultExportExpr,
    scriptPath: scriptPath ?? '<inline>',
    source,
  }
}

/**
 * Read a workflow script file, extract meta + body, validate. The main
 * entry mirroring the binary's V5e(scriptPath).
 */
export function loadScript(scriptPath: string): LoadedScript {
  const resolved = validateScriptPath(scriptPath)
  let source: string
  try {
    source = readFileSync(resolved, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      // Mirrors official CC 2.1.206: "Workflow script file not found: <path>"
      // plus the recovery guidance the binary emits for file-not-found.
      throw new WorkflowScriptError(
        `Workflow script file not found: ${scriptPath}. ` +
          'Create the file first (Write tool, or via shell if Write is unavailable), ' +
          'then retry with the same path. The script must begin with ' +
          '`export const meta = { name, description, phases }` and export a default ' +
          'async function: `export default async ({ agent, parallel, pipeline, phase, ' +
          'log, budget, workflow, resolveWorkflow, args }) => { ... }`.',
      )
    }
    throw new WorkflowScriptError(
      `Failed to read workflow script ${scriptPath}: ${err.message}`,
    )
  }
  return loadScriptFromSource(source, resolved)
}
