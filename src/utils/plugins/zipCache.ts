/**
 * Plugin Zip Cache Module
 *
 * Manages plugins as ZIP archives in a mounted directory (e.g., Filestore).
 * When CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE is enabled and CLAUDE_CODE_PLUGIN_CACHE_DIR
 * is set, plugins are stored as ZIPs in that directory and extracted to a
 * session-local temp directory at startup.
 *
 * Limitations:
 * - Only headless mode is supported
 * - All settings sources are used (same as normal plugin flow)
 * - Only github, git, and url marketplace sources are supported
 * - Only strict:true marketplace entries are supported
 * - Auto-update is non-blocking (background, does not affect current session)
 *
 * Directory structure of the zip cache:
 * /mnt/plugins-cache/
 *   ├── known_marketplaces.json
 *   ├── installed_plugins.json
 *   ├── marketplaces/
 *   │   ├── official-marketplace.json
 *   │   └── company-marketplace.json
 *   └── plugins/
 *       ├── official-marketplace/
 *       │   └── plugin-a/
 *       │       └── 1.0.0.zip
 *       └── company-marketplace/
 *           └── plugin-b/
 *               └── 2.1.3.zip
 */

import { randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { logForDebugging } from '../debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { isEnvTruthy } from '../envUtils.js'
import { getFsImplementation } from '../fsOperations.js'
import { expandTilde } from '../permissions/pathValidation.js'
import type { MarketplaceSource } from './schemas.js'

/**
 * Check if the plugin zip cache mode is enabled.
 */
export function isPluginZipCacheEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE)
}

/**
 * Get the path to the zip cache directory.
 * Requires CLAUDE_CODE_PLUGIN_CACHE_DIR to be set.
 * Returns undefined if zip cache is not enabled.
 */
export function getPluginZipCachePath(): string | undefined {
  if (!isPluginZipCacheEnabled()) {
    return undefined
  }
  const dir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  return dir ? expandTilde(dir) : undefined
}

/**
 * Get the path to known_marketplaces.json in the zip cache.
 */
export function getZipCacheKnownMarketplacesPath(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'known_marketplaces.json')
}

/**
 * Get the path to installed_plugins.json in the zip cache.
 */
export function getZipCacheInstalledPluginsPath(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'installed_plugins.json')
}

/**
 * Get the marketplaces directory within the zip cache.
 */
export function getZipCacheMarketplacesDir(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'marketplaces')
}

/**
 * Get the plugins directory within the zip cache.
 */
export function getZipCachePluginsDir(): string {
  const cachePath = getPluginZipCachePath()
  if (!cachePath) {
    throw new Error('Plugin zip cache is not enabled')
  }
  return join(cachePath, 'plugins')
}

// Session plugin cache: a temp directory on local disk (NOT in the mounted zip cache)
// that holds extracted plugins for the duration of the session.
let sessionPluginCachePath: string | null = null
let sessionPluginCachePromise: Promise<string> | null = null

/**
 * Get or create the session plugin cache directory.
 * This is a temp directory on local disk where plugins are extracted for the session.
 */
export async function getSessionPluginCachePath(): Promise<string> {
  if (sessionPluginCachePath) {
    return sessionPluginCachePath
  }
  if (!sessionPluginCachePromise) {
    sessionPluginCachePromise = (async () => {
      const suffix = randomBytes(8).toString('hex')
      const dir = join(tmpdir(), `claude-plugin-session-${suffix}`)
      await getFsImplementation().mkdir(dir)
      sessionPluginCachePath = dir
      logForDebugging(`Created session plugin cache at ${dir}`)
      return dir
    })()
  }
  return sessionPluginCachePromise
}

/**
 * Clean up the session plugin cache directory.
 * Should be called when the session ends.
 */
export async function cleanupSessionPluginCache(): Promise<void> {
  if (!sessionPluginCachePath) {
    return
  }
  try {
    await rm(sessionPluginCachePath, { recursive: true, force: true })
    logForDebugging(
      `Cleaned up session plugin cache at ${sessionPluginCachePath}`,
    )
  } catch (error) {
    logForDebugging(`Failed to clean up session plugin cache: ${error}`)
  } finally {
    sessionPluginCachePath = null
    sessionPluginCachePromise = null
  }
}

/**
 * Reset the session plugin cache path (for testing).
 */
export function resetSessionPluginCache(): void {
  sessionPluginCachePath = null
  sessionPluginCachePromise = null
}

/**
 * Write data to a file in the zip cache atomically.
 * Writes to a temp file in the same directory, then renames.
 */
export async function atomicWriteToZipCache(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(targetPath)
  await getFsImplementation().mkdir(dir)

  const tmpName = `.${basename(targetPath)}.tmp.${randomBytes(4).toString('hex')}`
  const tmpPath = join(dir, tmpName)

  try {
    if (typeof data === 'string') {
      await writeFile(tmpPath, data, { encoding: 'utf-8' })
    } else {
      await writeFile(tmpPath, data)
    }
    await rename(tmpPath, targetPath)
  } catch (error) {
    // Clean up tmp file on failure
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // ignore cleanup errors
    }
    throw error
  }
}

// fflate's ZippableFile tuple form: [data, opts]. Using the tuple lets us
// store {os, attrs} so parseZipModes can recover exec bits on extraction.
type ZipEntry = [Uint8Array, { os: number; attrs: number }]

/**
 * Create a ZIP archive from a directory.
 * Resolves symlinks to actual file contents (replaces symlinks with real data).
 * Stores Unix mode bits in external_attr so extractZipToDirectory can restore
 * +x — otherwise the round-trip (git clone → zip → extract) loses exec bits.
 *
 * @param sourceDir - Directory to zip
 * @returns ZIP file as Uint8Array
 */
export async function createZipFromDirectory(
  sourceDir: string,
): Promise<Uint8Array> {
  const files: Record<string, ZipEntry> = {}
  const visited = new Set<string>()
  await collectFilesForZip(sourceDir, '', files, visited)

  const { zipSync } = await import('fflate')
  const zipData = zipSync(files, { level: 6 })
  logForDebugging(
    `Created ZIP from ${sourceDir}: ${Object.keys(files).length} files, ${zipData.length} bytes`,
  )
  return zipData
}

/**
 * Recursively collect files from a directory for zipping.
 * Uses lstat to detect symlinks and tracks visited inodes for cycle detection.
 */
async function collectFilesForZip(
  baseDir: string,
  relativePath: string,
  files: Record<string, ZipEntry>,
  visited: Set<string>,
): Promise<void> {
  const currentDir = relativePath ? join(baseDir, relativePath) : baseDir
  let entries: string[]
  try {
    entries = await readdir(currentDir)
  } catch {
    return
  }

  // Track visited directories by dev+ino to detect symlink cycles.
  // bigint: true is required — on Windows NTFS, the file index packs a 16-bit
  // sequence number into the high bits. Once that sequence exceeds ~32 (very
  // common on a busy CI runner that churns through temp files), the value
  // exceeds Number.MAX_SAFE_INTEGER and two adjacent directories round to the
  // same JS number, causing subdirs to be silently skipped as "cycles". This
  // broke the round-trip test on Windows CI when sharding shuffled which tests
  // ran first and pushed MFT sequence numbers over the precision cliff.
  // See also: markdownConfigLoader.ts getFileIdentity, anthropics/claude-code#13893
  try {
    const dirStat = await stat(currentDir, { bigint: true })
    // ReFS (Dev Drive), NFS, some FUSE mounts report dev=0 and ino=0 for
    // everything. Fail open: skip cycle detection rather than skip the
    // directory. We already skip symlinked directories unconditionally below,
    // so the only cycle left here is a bind mount, which we accept.
    if (dirStat.dev !== 0n || dirStat.ino !== 0n) {
      const key = `${dirStat.dev}:${dirStat.ino}`
      if (visited.has(key)) {
        logForDebugging(`Skipping symlink cycle at ${currentDir}`)
        return
      }
      visited.add(key)
    }
  } catch {
    return
  }

  for (const entry of entries) {
    // Skip hidden files that are git-related
    if (entry === '.git') {
      continue
    }

    const fullPath = join(currentDir, entry)
    const relPath = relativePath ? `${relativePath}/${entry}` : entry

    let fileStat
    try {
      fileStat = await lstat(fullPath)
    } catch {
      continue
    }

    // Skip symlinked directories (follow symlinked files)
    if (fileStat.isSymbolicLink()) {
      try {
        const targetStat = await stat(fullPath)
        if (targetStat.isDirectory()) {
          continue
        }
        // Symlinked file — read its contents below
        fileStat = targetStat
      } catch {
        continue // broken symlink
      }
    }

    if (fileStat.isDirectory()) {
      await collectFilesForZip(baseDir, relPath, files, visited)
    } else if (fileStat.isFile()) {
      try {
        const content = await readFile(fullPath)
        // os=3 (Unix) + st_mode in high 16 bits of external_attr — this is
        // what parseZipModes reads back on extraction. fileStat is already
        // in hand from the lstat/stat above, so no extra syscall.
        files[relPath] = [
          new Uint8Array(content),
          { os: 3, attrs: (fileStat.mode & 0xffff) << 16 },
        ]
      } catch (error) {
        logForDebugging(`Failed to read file for zip: ${relPath}: ${error}`)
      }
    }
  }
}

/**
 * Official 2.1.269 (E42): plugin-zip extraction hardening.
 *
 * The official release hardened plugin-zip extraction so a hostile archive
 * cannot leave setuid/setgid or group/other-writable files on disk, and so a
 * re-extraction clears stale files instead of overlaying them. Byte-verified
 * against js269.txt:
 *   - `var w$=493` (0o755)                                       @849721
 *   - `rfe` per-entry chmod `if(P&&P&73)await Uko(A,P&w$)`        @1429098 / @1429374
 *   - `swo` sweep `if((n&18)===0)…d.isFile()&&d.nlink===1…s.chmod(d.mode&w$)` @1430917…@1431132
 *   - `nDt` staging names `.staging-`/`.previous-` + `N1s(4).toString("hex")` @5043426 / @5043654 / @5043689
 *   - `oDt` in-place fallback warning                             @5044761 / @5045508
 */
const EXTRACTED_MODE_MASK = 0o755 // Official `w$=493`: keep rwxr-xr-x, strip setuid/setgid/sticky + group/other write.
const EXEC_MODE_BITS = 0o111 // Official `73`: rfe chmods only entries carrying an exec bit.
const GROUP_OTHER_WRITE_BITS = 0o22 // Official `18`: swo's group/other-write gate.

// Official `oDt`/`_js` @5044761: the rename-swap can fail when the target (or
// its staged copy) is held open, or when the swap races a non-empty target.
// Deviation (documented): the official retries ENOTEMPTY/EEXIST through a
// per-dir seq registry (`Xot()`) and gates EPERM/EACCES/EBUSY on Windows only;
// OCC has neither that registry nor a Windows rename path for its ephemeral
// session cache, so all four errnos fall back straight to in-place extraction.
const IN_PLACE_FALLBACK_ERRNOS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EEXIST'])

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isInPlaceFallbackError(error: unknown): boolean {
  const code = errnoCode(error)
  return code !== undefined && IN_PLACE_FALLBACK_ERRNOS.has(code)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Official `Eke` @js269.txt: `try{return(await sD(e)).isDirectory()}catch{return!1}`
async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// Official `Soe` @js269.txt: `await sc(e).catch((n)=>{t(`Failed to remove the
// extraction tree ${e}: ${l(n)}`,{level:"warn"})})`
async function removeExtractionTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(error => {
    logForDebugging(
      `Failed to remove the extraction tree ${path}: ${errorText(error)}`,
      { level: 'warn' },
    )
  })
}

/**
 * Official 2.1.269 (E42) `swo` @js269.txt 1430917 — per-file integrity sweep.
 * Byte-verified logic (file case, `r=false`):
 *   if((n&18)===0)return!0;                              // no group/other write → skip the open
 *   let s=await ewo(e,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);   // O_NOFOLLOW: fail on a swapped-in symlink
 *   let d=await s.stat();
 *   if(!(d.isFile()&&d.nlink===1))return!1;              // require a single-link regular file
 *   if((d.mode&18)!==0)await s.chmod(d.mode&w$);         // strip group/other write (+ any high bits)
 *   await s.close();
 * `diskMode` is the on-disk mode from lstat (the official passes it from the
 * walker's `hpn`/lstat). Non-regular entries — a symlink swapped in after
 * writeFile (O_NOFOLLOW → ELOOP), a directory, or a hardlink (nlink>1) — are
 * safely skipped rather than followed. This does not duplicate the path-traversal
 * guard already applied by validateZipFile inside unzipFile.
 */
async function hardenExtractedFileMode(
  filePath: string,
  diskMode: number,
): Promise<void> {
  if ((diskMode & GROUP_OTHER_WRITE_BITS) === 0) return
  let handle: FileHandle | undefined
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
    const fdStat = await handle.stat()
    if (!fdStat.isFile() || fdStat.nlink !== 1) return
    if ((fdStat.mode & GROUP_OTHER_WRITE_BITS) !== 0) {
      await handle.chmod(fdStat.mode & EXTRACTED_MODE_MASK)
    }
  } catch {
    // O_NOFOLLOW throws ELOOP on a swapped-in symlink; swallow so a failed sweep
    // never aborts extraction (we wrote a regular file moments ago).
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Official 2.1.269 (E42) `rfe` @js269.txt 1429098 — pure extraction into `destDir`.
 * Byte-verified per entry:
 *   if(_.endsWith("/")){await mkdir(gU(n,_));continue}       // directory entry
 *   let A=gU(n,_); await mkdir(fpn(A)); await qko(A,E);      // parent mkdir + writeFile
 *   let P=d[_]; if(P&&P&73)await Uko(A,P&w$).catch(()=>{})   // exec gate, mask 0o755
 * Deviation (documented): OCC folds the `swo` integrity sweep into this single
 * pass. The official runs `swo` from the `iwo` walker only after the `unzip`
 * binary fallback (`S0e`); OCC's fflate path IS `rfe`, so the sweep runs inline
 * per file to give the same umask-independent group/other-write guarantee.
 */
async function extractZipEntriesToDir(
  files: Record<string, Uint8Array>,
  modes: Record<string, number>,
  destDir: string,
): Promise<void> {
  await getFsImplementation().mkdir(destDir)
  for (const [relPath, data] of Object.entries(files)) {
    // Skip directory entries (trailing slash)
    if (relPath.endsWith('/')) {
      await getFsImplementation().mkdir(join(destDir, relPath))
      continue
    }

    const fullPath = join(destDir, relPath)
    await getFsImplementation().mkdir(dirname(fullPath))
    await writeFile(fullPath, data)
    const mode = modes[relPath]
    // Official `rfe`: `if(P&&P&73)await Uko(A,P&w$).catch(()=>{})` — chmod only
    // when the entry carries an exec bit, masking to 0o755 (strips setuid/setgid/
    // sticky + group/other write). Swallow EPERM/ENOTSUP (NFS root_squash, some
    // FUSE mounts): losing +x is better than aborting mid-extraction.
    if (mode && mode & EXEC_MODE_BITS) {
      await chmod(fullPath, mode & EXTRACTED_MODE_MASK).catch(() => {})
    }
    // Official `swo` sweep: strip any residual group/other write writeFile left
    // (its 0o666 default is umask-dependent) and reject non-regular swaps.
    const diskStat = await lstat(fullPath).catch(() => undefined)
    if (diskStat) await hardenExtractedFileMode(fullPath, diskStat.mode)
  }
}

/**
 * Extract a ZIP file to a target directory.
 *
 * Official 2.1.269 (E42): extraction runs into a sibling staging dir (`nDt`
 * @5043426) that is then rename-swapped into place (`oDt` @5044761) so a
 * re-extraction of the same plugin clears stale files instead of overlaying
 * them. If the swap fails because the target is held open / non-empty
 * (EBUSY/EPERM/ENOTEMPTY/EEXIST), it falls back to extracting in place with a
 * warning (official wording @5045508) — stale files are not cleared on that
 * degraded path. Extracted modes are hardened per `rfe`/`swo` (helpers above).
 *
 * @param zipPath - Path to the ZIP file
 * @param targetDir - Directory to extract into
 */
export async function extractZipToDirectory(
  zipPath: string,
  targetDir: string,
): Promise<void> {
  const zipBuf = await getFsImplementation().readFileBytes(zipPath)
  const files = await unzipFile(zipBuf)
  // fflate doesn't surface external_attr — parse the central directory so
  // exec bits survive extraction (hooks/scripts need +x to run via `sh -c`).
  const modes = parseZipModes(zipBuf)

  // Official `nDt` @5043426: sibling staging + previous names, random suffix.
  //   let s=N1s(4).toString("hex");
  //   return{extractDir:n,staging:`${n}.staging-${s}`,previousPrefix:`${n}.previous-${s}`}
  // OCC omits nDt's containment throw ("Refusing to extract a plugin archive
  // outside the session plugin cache"): pluginLoader derives targetDir from a
  // sanitized pluginId (join(sessionDir, pluginId.replace(/[^a-zA-Z0-9@\-_]/g,'-')))
  // so it cannot escape the session cache, and validateZipFile guards entry paths.
  const swapHex = randomBytes(4).toString('hex')
  const stagingDir = `${targetDir}.staging-${swapHex}`
  const previousDir = `${targetDir}.previous-${swapHex}`

  // Official `rDt`: extract the archive into the staging dir.
  await extractZipEntriesToDir(files, modes, stagingDir)

  // Official `oDt` @5044761: rename-swap staging into target, moving any existing
  // target aside first so stale files are cleared atomically.
  let movedAside = false
  try {
    if (await isExistingDirectory(targetDir)) {
      await rename(targetDir, previousDir)
      movedAside = true
    }
    await rename(stagingDir, targetDir)
    if (movedAside) await removeExtractionTree(previousDir)
  } catch (error) {
    // Restore the moved-aside target so we never leave the plugin dir missing.
    if (movedAside) await rename(previousDir, targetDir).catch(() => {})
    await removeExtractionTree(stagingDir)
    if (isInPlaceFallbackError(error)) {
      // Official in-place fallback warning @5045508 (byte-matched wording).
      logForDebugging(
        `Plugin extraction directory ${targetDir} or its staged copy is held open; extracting the archive in place, so files dropped from it are not cleared this time`,
        { level: 'warn' },
      )
      await extractZipEntriesToDir(files, modes, targetDir)
    } else {
      throw error
    }
  }

  logForDebugging(
    `Extracted ZIP to ${targetDir}: ${Object.keys(files).length} entries`,
  )
}

/**
 * Convert a plugin directory to a ZIP in-place: zip → atomic write → delete dir.
 * Both call sites (cacheAndRegisterPlugin, copyPluginToVersionedCache) need the
 * same sequence; getting it wrong (non-atomic write, forgetting rm) corrupts cache.
 */
export async function convertDirectoryToZipInPlace(
  dirPath: string,
  zipPath: string,
): Promise<void> {
  const zipData = await createZipFromDirectory(dirPath)
  await atomicWriteToZipCache(zipPath, zipData)
  await rm(dirPath, { recursive: true, force: true })
}

/**
 * Get the relative path for a marketplace JSON file within the zip cache.
 * Format: marketplaces/{marketplace-name}.json
 */
export function getMarketplaceJsonRelativePath(
  marketplaceName: string,
): string {
  const sanitized = marketplaceName.replace(/[^a-zA-Z0-9\-_]/g, '-')
  return join('marketplaces', `${sanitized}.json`)
}

/**
 * Check if a marketplace source type is supported by zip cache mode.
 *
 * Supported sources write to `join(cacheDir, name)` — syncMarketplacesToZipCache
 * reads marketplace.json from that installLocation, source-type-agnostic.
 * - github/git/url: clone to temp, rename into cacheDir
 * - settings: write synthetic marketplace.json directly to cacheDir (no fetch)
 *
 * Excluded: file/directory (installLocation is the user's path OUTSIDE cacheDir —
 * nonsensical in ephemeral containers), npm (node_modules bloat on Filestore mount).
 */
export function isMarketplaceSourceSupportedByZipCache(
  source: MarketplaceSource,
): boolean {
  return ['github', 'git', 'url', 'settings'].includes(source.source)
}
