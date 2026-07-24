import { basename } from 'node:path'

/**
 * The canonical OCC binary name — the `bin` entry in package.json.
 * Used as the fallback when the runtime invocation path doesn't yield a
 * recognizable binary name (e.g. dev mode running the `.tsx` entry directly,
 * or the bundled `dist/cli.js`).
 */
export const OCC_BIN_NAME = 'occ'

/**
 * Internal entry-point basenames that don't represent a user-facing binary
 * name. When `process.argv[1]` resolves to one of these (after stripping
 * extensions), we fall back to {@link OCC_BIN_NAME} rather than printing
 * `cli --resume …` in user-facing copy.
 *
 * `claude` (and its extended forms) is included defensively: OCC is a fork
 * of Claude Code and the upstream name lingers in paths and fallbacks, so
 * we never want it to surface in OCC's user-facing copy.
 */
const GENERIC_ENTRY_NAMES = new Set([
  'cli',
  'main',
  'cli.tsx',
  'cli.js',
  'claude',
  'claude.js',
  'claude.cjs',
  'claude.mjs',
])

/**
 * Derive the user-facing CLI binary name for the current invocation.
 *
 * OCC ships as the `occ` bin, but the process may also be launched via the
 * bundled `dist/cli.js` or directly through the `.tsx` entry in dev mode.
 * We read `process.argv[1]` (the entry path), strip common extensions, and
 * fall back to {@link OCC_BIN_NAME} when the result is a generic entry name
 * or otherwise unrecognized.
 *
 * This keeps user-facing copy — the exit "Resume this session with:" banner,
 * shell-completion hints, error messages — consistent with whatever binary
 * the user actually invoked, while never showing the upstream `claude` name.
 *
 * @returns the binary name to display in user-facing copy (e.g. `occ`).
 */
export function getCliName(): string {
  const entry = process.argv[1]
  if (!entry) {
    return OCC_BIN_NAME
  }

  const base = basename(entry).replace(/\.(?:cjs|mjs|js|tsx|ts)$/u, '')
  if (!base || GENERIC_ENTRY_NAMES.has(base)) {
    return OCC_BIN_NAME
  }
  return base
}

/**
 * Memoized accessor for code paths that read the name repeatedly (e.g. the
 * exit banner). `process.argv[1]` is constant for the lifetime of the
 * process, so the derived name is stable.
 */
let cachedName: string | undefined

/** @returns the memoized CLI binary name (see {@link getCliName}). */
export function getCliNameCached(): string {
  if (cachedName === undefined) {
    cachedName = getCliName()
  }
  return cachedName
}
