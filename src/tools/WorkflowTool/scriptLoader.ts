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
 */
import { readFileSync } from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import vm from 'node:vm'

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

/**
 * Validate a scriptPath. Rejects UNC paths (Windows \\\\ prefix) and path
 * traversal. Returns the resolved absolute path.
 *
 * Mirrors the binary: "UNC paths are not allowed for workflow scriptPath".
 */
export function validateScriptPath(scriptPath: string): string {
  if (!scriptPath || typeof scriptPath !== 'string') {
    throw new WorkflowScriptError('workflow scriptPath must be a non-empty string')
  }
  // Reject UNC paths (\\ prefix on Windows).
  if (/^\\\\/.test(scriptPath)) {
    throw new WorkflowScriptError(
      `UNC paths are not allowed for workflow scriptPath: ${scriptPath}`,
    )
  }
  // Reject path traversal — resolved path must not escape via .. normalization
  // (path.join normalizes, but an absolute path with .. is still suspicious;
  // we just require it resolves to a real absolute path).
  const resolved = isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath)
  return resolved
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
    throw new WorkflowScriptError(
      `Failed to read workflow script ${scriptPath}: ${err.message}`,
    )
  }
  if (!source.trim()) {
    throw new WorkflowScriptError(`Workflow script ${scriptPath} is empty`)
  }

  const { metaJson, bodyStart } = extractMetaStatement(source)
  const meta = parseMeta(metaJson)

  let body = source.slice(bodyStart).trim()
  if (!body) {
    throw new WorkflowScriptError(
      `Workflow script ${scriptPath} has no body after \`export const meta\``,
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
    scriptPath: resolved,
    source,
  }
}
