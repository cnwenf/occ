/**
 * Claude Code 2.1.296 (OCC-154 #050): Git-Bash/Cygwin drive-letter
 * translation for the dangerous-removal analyzer.
 *
 * Official surface (v296 ELF, md5 3c8749470f70a26efadf982b587e1548):
 *   - The 367-byte fix block `zwr`/`Xun`/`qwr`/`wwe` @218709361 (NEW in
 *     v296 — zero v295 hits), wired at the rm analyzer's critical-path
 *     check (`mce(Ce)` -> `wwe(Pe)`), its workspace-dir/ancestor check
 *     (`Xun(Pe, …)`), and the rootish variable-value checks in `S3e`
 *     (`wwe(Ld(n))`/`wwe(Ld(r))`).
 *   - `qpt` @207109251 — the UNC device-path normalizer `qwr` consults
 *     first (`\\\\?\\C:\\x`, `\\\\localhost\\C$\\x` -> `C:\\x`).
 *
 * Changelog entry 50: "Windows: Fixed `rm -rf /c/Users/<name>` in Git Bash
 * not asking in bypass permissions mode." In v295 the analyzer tested only
 * the raw target string against the critical-path predicate, so Git-Bash
 * forms (`/c/…`, `\\c\\…`, `/cygdrive/c/…`) never matched Windows-form
 * critical paths and the dangerousRemoval ask never fired. v296 translates
 * then re-tests (official `Xun` shape: original first — short-circuit; then
 * the translated form only when translation produced one).
 *
 * `qpt` and the `zwr` regex below are byte-verbatim from the official
 * binary (param names mechanically renamed t/e/n -> path/match/rest);
 * `translateGitBashPathToWindows` preserves `qwr`'s exact structure
 * including the platform guard, the qpt pre-step short-circuit, the
 * uppercased drive letter, and the empty-rest -> `\\` arm. Unlike OCC's
 * `posixPathToWindowsPath` (utils/windowsPaths.ts), qwr has NO slash-flip
 * fallback: anything that does not match returns undefined, so benign
 * POSIX paths are never reshaped before the predicate re-test.
 *
 * The bypass-immunity half of entry 50 lives at the call sites: the
 * critical-path ask now carries the official
 * `circuitBreaker:"dangerousRemoval"` shape (BashTool/pathValidation.ts +
 * bashPermissions.ts maybeSuppressForBypass exemption).
 */
import { getPlatform } from '../platform.js'
import { isDangerousRemovalPath } from './pathValidation.js'

/** Official `zwr` @218709361 (byte-verbatim). */
const GIT_BASH_DRIVE_REGEX = /^[\\/](?:cygdrive[\\/])?([A-Za-z])(?=[\\/]|$)/i

/**
 * Official `qpt` @207109251 (byte-verbatim body): normalize UNC device
 * paths (`\\\\?\\C:\\…`, `\\\\.\\C:\\…`, `\\\\localhost\\C$\\…`,
 * `\\\\127.0.0.1\\C$\\…`) to `C:\\…`; returns the input unchanged when it
 * does not match.
 */
function normalizeUncDevicePath(path: string): string {
  let match=/^[\\/]{2}(?:[?.][\\/]([A-Za-z]):|(?:localhost|127\.0\.0\.1)[\\/]([A-Za-z])\$)(?=$|[\\/])/i.exec(path);if(match===null)return path;let rest=path.slice(match[0].length);return`${match[1]??match[2]}:${rest===""?"\\":rest}`
}

/**
 * Official `qwr` @218709361 (verbatim structure): translate a Git-Bash/
 * Cygwin drive-letter path to its Windows form. Returns undefined when the
 * platform is not Windows or the path does not match any translated form
 * (official: `if(O()!=="windows")return` / `if(r===null)return`).
 */
export function translateGitBashPathToWindows(
  path: string,
): string | undefined {
  if (getPlatform() !== 'windows') {
    return undefined
  }
  const uncNormalized = normalizeUncDevicePath(path)
  if (uncNormalized !== path) {
    return uncNormalized
  }
  const match = GIT_BASH_DRIVE_REGEX.exec(path)
  if (match === null) {
    return undefined
  }
  const rest = path.slice(match[0].length).replace(/\//g, '\\')
  return `${match[1]!.toUpperCase()}:${rest === '' ? '\\' : rest}`
}

/**
 * Official `Xun(e,n)` @218709361 (verbatim): test the predicate against the
 * original path first (short-circuit), then — only when translation produced
 * a different Windows form — against the translated path.
 */
export function checkWithGitBashTranslation(
  path: string,
  predicate: (candidate: string) => boolean,
): boolean {
  if (predicate(path)) {
    return true
  }
  const translated = translateGitBashPathToWindows(path)
  return translated !== undefined && predicate(translated)
}

/**
 * Official `wwe(e)` @218709361 (verbatim): `Xun(e, yLe)` — the
 * critical-path dangerous-removal predicate with Git-Bash translation.
 * Drop-in windows-aware replacement for `isDangerousRemovalPath` at the
 * official v296 call sites (identical behavior on non-Windows platforms —
 * the translation arm is platform-gated to undefined).
 */
export function isDangerousRemovalPathWindowsAware(path: string): boolean {
  return checkWithGitBashTranslation(path, isDangerousRemovalPath)
}
