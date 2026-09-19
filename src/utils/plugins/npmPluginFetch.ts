/**
 * npm plugin fetch subsystem (v2.1.275 security alignment)
 *
 * Port of the official Claude Code 2.1.275+ npm-source plugin fetch pipeline
 * (binary subsystem `L6n`/`Wnr`/`RPs`/`znr` @200294300-200299900 in the
 * 2.1.276 ELF). The v2.1.274 behavior OCC previously carried ran a plain
 * `npm install` for npm-source plugins, which executes npm lifecycle scripts
 * (preinstall/install/postinstall) of untrusted packages — an RCE vector.
 *
 * The official replacement pipeline, ported here:
 *  1. `resolveNpmPackage`   — `npm view --json <pkg>@<range>` (60s timeout)
 *     resolves version + `dist.tarball` + `dist.integrity`/`dist.shasum`.
 *  2. `packNpmTarball`      — `npm pack --ignore-scripts --loglevel=error`
 *     (300s timeout) with env `npm_config_ignore_scripts:"true"`; the packed
 *     tarball is capped at 256 MiB.
 *  3. `verifyNpmTarball`    — SRI verification against `dist.integrity`
 *     trying sha512 → sha384 → sha256 → sha1; refuses (byte-exact official
 *     strings) on missing integrity or hash mismatch; shasum fallback only
 *     when integrity is not required.
 *  4. `unpackNpmTarball`    — script-free custom tar reader (gunzip with a
 *     512 MiB output cap, 256 MiB per-entry cap, 100000-entry cap, no
 *     links/devices/FIFOs, path-traversal containment, duplicate-path and
 *     exclusive-create guards). No tar CLI, no lifecycle hooks, ever.
 *  5. `verifyUnpackedPackageManifest` — the unpacked package.json must call
 *     itself what the registry resolved.
 *
 * The unpacked layout is then validated against OCC's existing plugin
 * manifest schema by `cachePlugin` (pluginLoader.ts), unchanged.
 *
 * User-facing refusal strings are byte-exact vs the official binary; helper
 * names in comments reference the official minified identifiers.
 */

import { createHash } from 'crypto'
import { chmod, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, posix } from 'path'
import { maxSatisfying, satisfies, validRange } from 'semver'
import { promisify } from 'util'
import { gunzip } from 'zlib'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'

const gunzipAsync = promisify(gunzip)

// --- Official constants (byte-exact values) ---------------------------------

/** Official `JAs` — `npm view` timeout. */
export const NPM_VIEW_TIMEOUT_MS = 60000
/** Official `ePs` — `npm pack` timeout. */
export const NPM_PACK_TIMEOUT_MS = 300000
/** Official `tPs` — exec maxBuffer. */
export const NPM_EXEC_MAX_BUFFER = 8388608
/** Official `OUe` — 1 MiB. */
const MEBIBYTE = 1048576
/** Official `DSt` (nPs=256) — packed tarball download cap. */
export const MAX_TARBALL_BYTES = 256 * MEBIBYTE
/** Official `Inr` (rPs=512) — gunzipped output cap. */
export const MAX_UNPACKED_BYTES = 512 * MEBIBYTE
/** Official `Dnr` (oPs=256) — single tar entry cap. */
export const MAX_TAR_ENTRY_BYTES = 256 * MEBIBYTE
/** Official `Nnr` — tar entry count cap. */
export const MAX_TAR_ENTRIES = 100000
/** Official `sPs` — npm error summary truncation. */
const ERROR_SUMMARY_MAX_LENGTH = 300
/** Official `iPs` — name truncation in messages (`ON`). */
const NAME_TRUNCATE_LENGTH = 120
/** Official `aPs` — typeflag truncation in messages. */
const TYPEFLAG_TRUNCATE_LENGTH = 4
/** Official `m7` — tar block size. */
const TAR_BLOCK_SIZE = 512
/** Official `lPs` — file mode mask for chmod. */
const FILE_MODE_MASK = 0o755
/** Official `cPs` — executable-bit mask. */
const EXEC_MODE_BITS = 0o111
/** Official `$nr` — space byte (checksum padding / pax separator). */
const SPACE_BYTE = 0x20
/** Official `uPs` — base-256 numeric marker in tar header fields. */
const BASE256_MARKER = 0x80

/** Official `mPs` — `npm view` requested fields. */
const NPM_VIEW_FIELDS = [
  'name',
  'version',
  'dist.tarball',
  'dist.integrity',
  'dist.shasum',
  'dist-tags.latest',
] as const

/** Official `gPs` — SRI algorithm preference order. */
export const SRI_ALGORITHMS = ['sha512', 'sha384', 'sha256', 'sha1'] as const

/** Official `hPs` — dist-tag shape. */
const DIST_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i

/** Official `MM` — tar ustar header field offsets. */
const TAR_FIELDS = {
  name: [0, 100],
  mode: [100, 8],
  size: [124, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  magic: [257, 6],
  prefix: [345, 155],
} as const

const CHECKSUM_FIELD_START = TAR_FIELDS.checksum[0]
const CHECKSUM_FIELD_END = TAR_FIELDS.checksum[0] + TAR_FIELDS.checksum[1]

// --- Types ------------------------------------------------------------------

/** Official resolution result (validated shape of `L6n` output). */
export interface NpmResolution {
  name: string
  version: string
  tarballUrl: string
  integrity?: string
  shasum?: string
}

export interface NpmFetchOptions {
  /** Working directory for npm subprocesses and the packed tarball. */
  workDir: string
  /** Optional registry override (`--registry`). */
  registry?: string
}

/** Test-only overrides for the byte/entry caps (defaults are official). */
export interface TarUnpackLimits {
  maxUnpackedBytes?: number
  maxEntryBytes?: number
  maxEntries?: number
}

type TarEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; data: Buffer; mode: number }

interface ViewOutputEntry {
  version: string
  name?: string
  tarballUrl?: string
  integrity?: string
  shasum?: string
  latestTag?: string
}

/**
 * Error carrying the official `Yw(message, reason)` shape (message for users,
 * reason for logs/telemetry). Plain Error subclass — compatible with OCC's
 * existing error surfaces (`errorMessage`, cachePlugin rethrow).
 */
export class NpmPluginFetchError extends Error {
  readonly reason: string

  constructor(message: string, reason: string) {
    super(message)
    this.name = 'NpmPluginFetchError'
    this.reason = reason
  }
}

// --- Small helpers (official `wn`/`st`/`Xs`/`USt` equivalents) --------------

/**
 * Official `ON` = `wn(value, 120)`: NFC-normalize, fold backtick lookalikes
 * to "'", strip control characters, truncate with an ellipsis.
 */
function truncateName(value: string, max: number = NAME_TRUNCATE_LENGTH): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[\u0060\uff40\u02cb\u1fef\u2035]/g, "'")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0/DEL control chars from untrusted registry-provided names before they reach user-facing messages (official wn sanitizer behavior).
    .replace(/[\u0000-\u001f\u007f]/g, '')
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

/** Official `st(value, sep)` — cut at first occurrence of sep. */
function cutAt(value: string, separator: string): string {
  const index = value.indexOf(separator)
  return index === -1 ? value : value.slice(0, index)
}

/** Official `Xs` — drop undefined-valued keys. */
function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) {
      result[key] = value[key]
    }
  }
  return result
}

/** Official `USt` — whole MiB for messages. */
function formatMiB(bytes: number): number {
  return Math.floor(bytes / MEBIBYTE)
}

/** Official `Yw` — construct the fetch error. */
function npmFetchError(message: string, reason: string): NpmPluginFetchError {
  return new NpmPluginFetchError(message, reason)
}

/** Official `dR` — tar refusal with the fixed prefix. */
function tarRefused(detail: string): NpmPluginFetchError {
  return npmFetchError(
    `The npm package was not installed: ${detail}`,
    'npm tarball refused',
  )
}

/** Official `Hnr` — tolerant JSON parse. */
function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text.trim() || 'null')
  } catch {
    return null
  }
}

/** Official `jnr` — one-line npm error summary for user-facing messages. */
function npmErrorSummary(stdout: string, stderr: string): string {
  const parsed = parseJsonSafe(stdout) as {
    error?: { summary?: unknown; code?: unknown }
  } | null
  const summary = parsed?.error?.summary
  const code = parsed?.error?.code
  const codePrefix = typeof code === 'string' ? `${code} ` : ''
  if (typeof summary === 'string' && summary.length > 0) {
    return truncateName(`${codePrefix}${summary}`, ERROR_SUMMARY_MAX_LENGTH)
  }
  const stderrLine = stderr
    .split('\n')
    .map(line => line.replace(/^npm (ERR!|error) ?/, '').trim())
    .find(line => line.length > 0)
  return truncateName(
    stderrLine ?? 'npm exited with an error',
    ERROR_SUMMARY_MAX_LENGTH,
  )
}

/** Official `wPs` — npm env with lifecycle scripts disabled. */
function npmIgnoreScriptsEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_ignore_scripts: 'true' }
}

/** Official `Bnr` — shared npm exec options (cwd/timeout/maxBuffer/stdin/env). */
function npmExecOptions(workDir: string, timeout: number) {
  return {
    cwd: workDir,
    timeout,
    maxBuffer: NPM_EXEC_MAX_BUFFER,
    stdin: 'ignore' as const,
    env: npmIgnoreScriptsEnv(),
  }
}

/** Official `Unr` — registry flag. */
function registryArgs(registry: string | undefined): string[] {
  return registry ? ['--registry', registry] : []
}

// --- Step 1: metadata resolution (official `L6n`) ---------------------------

/** Official `SPs`/`kPs` — version spec must be a version, range or dist-tag. */
function validateVersionSpec(
  packageName: string,
  versionSpec: string | undefined,
): void {
  if (versionSpec === undefined || validRange(versionSpec) !== null) {
    return
  }
  if (DIST_TAG_PATTERN.test(versionSpec)) {
    return
  }
  throw npmFetchError(
    `${packageName} was not resolved: "${truncateName(versionSpec)}" is not a version, a semver range or a dist-tag`,
    'npm version spec is not a version, range or tag',
  )
}

/** Official `xPs` — extract one version record from `npm view --json` output. */
function parseViewEntry(raw: unknown): ViewOutputEntry | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const readString = (key: string): string | undefined => {
    const value = Reflect.get(record, key)
    return typeof value === 'string' ? value : undefined
  }
  const version = readString('version')
  if (version === undefined) {
    return undefined
  }
  return {
    version,
    ...compactObject({
      name: readString('name'),
      tarballUrl: readString('dist.tarball'),
      integrity: readString('dist.integrity'),
      shasum: readString('dist.shasum'),
      latestTag: readString('dist-tags.latest'),
    }),
  }
}

/** Official `TPs` — normalize view output (object | array | null) to entries. */
function parseViewOutput(stdout: string): ViewOutputEntry[] {
  const parsed = parseJsonSafe(stdout)
  const records = Array.isArray(parsed)
    ? parsed
    : parsed === null
      ? []
      : [parsed]
  return records.flatMap(raw => {
    const entry = parseViewEntry(raw)
    return entry ? [entry] : []
  })
}

/** Official `vPs` — tolerant semver.satisfies. */
function satisfiesRange(version: string, range: string): boolean {
  try {
    return satisfies(version, range)
  } catch {
    return false
  }
}

/** Official `EPs` — pick the version npm would install. */
function chooseVersion(
  entries: ViewOutputEntry[],
  versionSpec: string | undefined,
): ViewOutputEntry | undefined {
  const [first] = entries
  if (!first || entries.length === 1) {
    return first
  }
  const versions = entries.map(entry => entry.version)
  const latestTag = first.latestTag
  const useLatestTag =
    latestTag !== undefined &&
    versionSpec !== undefined &&
    versions.includes(latestTag) &&
    satisfiesRange(latestTag, versionSpec)
  const chosen = useLatestTag
    ? latestTag
    : (maxSatisfying(versions, versionSpec ?? '*') ?? versions.at(-1))
  return entries.find(entry => entry.version === chosen)
}

/**
 * Official `L6n` — resolve `<package>@<spec>` via `npm view --json`
 * (60s timeout, lifecycle scripts disabled). Returns the resolved name,
 * version, tarball URL and integrity metadata.
 */
export async function resolveNpmPackage(
  packageName: string,
  versionSpec: string | undefined,
  options: NpmFetchOptions,
): Promise<NpmResolution> {
  const spec = `${packageName}@${versionSpec ?? 'latest'}`
  validateVersionSpec(packageName, versionSpec)
  const result = await execFileNoThrowWithCwd(
    'npm',
    [
      'view',
      '--json',
      ...registryArgs(options.registry),
      '--',
      spec,
      ...NPM_VIEW_FIELDS,
    ],
    npmExecOptions(options.workDir, NPM_VIEW_TIMEOUT_MS),
  )
  if (result.code !== 0) {
    throw npmFetchError(
      `Could not resolve ${spec} from the npm registry: ${npmErrorSummary(result.stdout, result.stderr)}`,
      'npm view failed',
    )
  }
  const chosen = chooseVersion(parseViewOutput(result.stdout), versionSpec)
  if (!chosen) {
    throw npmFetchError(
      `Could not resolve ${spec} from the npm registry: no version matches`,
      'npm view returned no versions',
    )
  }
  if (chosen.tarballUrl === undefined) {
    throw npmFetchError(
      `Could not resolve ${spec} from the npm registry: the registry did not report a tarball URL`,
      'npm view returned no tarball',
    )
  }
  return {
    name: chosen.name ?? packageName,
    version: chosen.version,
    tarballUrl: chosen.tarballUrl,
    ...compactObject({
      integrity: chosen.integrity,
      shasum: chosen.shasum,
    }),
  }
}

// --- Step 2: tarball download (official `Wnr`) ------------------------------

export interface NpmPackOptions extends NpmFetchOptions {
  /** Spec shown in errors (defaults to the tarball URL). */
  displaySpec?: string
  /** Test-only override for the packed-tarball size cap. */
  maxTarballBytes?: number
}

/**
 * Official `Wnr` — fetch the tarball with `npm pack --ignore-scripts
 * --loglevel=error` (300s timeout, env `npm_config_ignore_scripts:"true"`),
 * then read it back capped at 256 MiB. npm never runs package scripts.
 */
export async function packNpmTarball(
  tarballUrl: string,
  options: NpmPackOptions,
): Promise<Buffer> {
  const displaySpec = options.displaySpec ?? tarballUrl
  const result = await execFileNoThrowWithCwd(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--loglevel=error',
      ...registryArgs(options.registry),
      '--',
      tarballUrl,
    ],
    npmExecOptions(options.workDir, NPM_PACK_TIMEOUT_MS),
  )
  if (result.code !== 0) {
    throw npmFetchError(
      `Could not download ${displaySpec} from the npm registry: ${npmErrorSummary(result.stdout, result.stderr)}`,
      'npm pack failed',
    )
  }
  const entries = await readdir(options.workDir)
  const tarballName = entries.find(entry => entry.endsWith('.tgz'))
  if (tarballName === undefined) {
    throw npmFetchError(
      `Could not download ${displaySpec}: npm pack finished without writing a tarball`,
      'npm pack wrote no tarball',
    )
  }
  const maxBytes = options.maxTarballBytes ?? MAX_TARBALL_BYTES
  const tarball = await getFsImplementation().readFileBytes(
    join(options.workDir, tarballName),
    maxBytes + 1,
  )
  if (tarball.length > maxBytes) {
    throw npmFetchError(
      `${displaySpec} is larger than ${formatMiB(maxBytes)} MB and was not installed`,
      'npm tarball too large',
    )
  }
  return tarball
}

// --- Step 3: SRI verification (official `RPs`/`Gnr`/`APs`/`Lnr`) ------------

/** Official `Gnr` — does the data match any hash in the SRI string? */
export function matchesSri(data: Buffer, integrity: string): boolean {
  const hashes = integrity.split(/\s+/).filter(hash => hash.includes('-'))
  const algorithm = SRI_ALGORITHMS.find(algo =>
    hashes.some(hash => cutAt(hash, '-') === algo),
  )
  if (!algorithm) {
    return false
  }
  const digest = createHash(algorithm).update(data).digest('base64')
  return hashes.includes(`${algorithm}-${digest}`)
}

/** Official `APs` — sha1 hex (shasum fallback). */
function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

/** Official `Lnr` — mismatch refusal (byte-exact message). */
function integrityMismatchError(
  displaySpec: string,
  what: string,
): NpmPluginFetchError {
  return npmFetchError(
    `${displaySpec} was not installed: the downloaded tarball does not match the ${what} the registry reported`,
    `npm tarball ${cutAt(what, ' ')} mismatch`,
  )
}

export interface VerifyTarballOptions {
  /**
   * Official `needsIntegrity` (npm-marketplace lane): refuse when the
   * registry reported no integrity value instead of falling back to
   * shasum / unverified install.
   */
  needsIntegrity: boolean
}

/** Official `RPs` — verify the packed tarball against registry metadata. */
export function verifyNpmTarball(
  tarball: Buffer,
  resolution: Pick<NpmResolution, 'name' | 'version' | 'integrity' | 'shasum'>,
  options: VerifyTarballOptions,
): void {
  const displaySpec = `${resolution.name}@${resolution.version}`
  if (resolution.integrity) {
    if (!matchesSri(tarball, resolution.integrity)) {
      throw integrityMismatchError(
        displaySpec,
        `integrity (${truncateName(resolution.integrity)})`,
      )
    }
    return
  }
  if (resolution.shasum && !options.needsIntegrity) {
    if (sha1Hex(tarball) !== resolution.shasum.toLowerCase()) {
      throw integrityMismatchError(displaySpec, 'shasum')
    }
    return
  }
  if (options.needsIntegrity) {
    throw npmFetchError(
      `${displaySpec} was not installed: the registry reported no integrity value to verify the download against`,
      'npm registry reported no integrity',
    )
  }
  logForDebugging(
    `npm: no integrity reported for ${displaySpec}; installing the packed tarball unverified`,
    { level: 'warn' },
  )
}

/** Official `CPs` — pack + verify in one step. */
export async function fetchAndVerifyNpmTarball(
  resolution: NpmResolution,
  options: NpmPackOptions & VerifyTarballOptions,
): Promise<Buffer> {
  const tarball = await packNpmTarball(resolution.tarballUrl, {
    ...options,
    displaySpec: `${resolution.name}@${resolution.version}`,
  })
  verifyNpmTarball(tarball, resolution, {
    needsIntegrity: options.needsIntegrity,
  })
  return tarball
}

// --- Step 4: script-free tar unpacker (official `znr`/`PPs` and helpers) ----

/** Official `LPs` — end-of-archive zero block. */
function isZeroBlock(block: Buffer): boolean {
  return block.every(byte => byte === 0)
}

/** Official `HSt` — NUL-terminated UTF-8 string. */
function readNulTerminated(field: Buffer): string {
  const end = field.indexOf(0)
  return (end < 0 ? field : field.subarray(0, end)).toString('utf8')
}

/** Official `NSt` — string field at [offset, length]. */
function readStringField(header: Buffer, field: readonly [number, number]): string {
  const [start, length] = field
  return readNulTerminated(header.subarray(start, start + length))
}

/** Official `LSt` — numeric field: base-256 (0x80 marker) or trimmed octal. */
function readNumericField(
  header: Buffer,
  field: readonly [number, number],
): number {
  const [start, length] = field
  const raw = header.subarray(start, start + length)
  if ((raw.readUInt8(0) & BASE256_MARKER) !== 0) {
    return raw.subarray(1).reduce((acc, byte) => acc * 256 + byte, 0)
  }
  const text = readNulTerminated(raw).trim()
  if (text === '') {
    return 0
  }
  return Number.parseInt(text, 8) || 0
}

/** Official `FPs` — header checksum (checksum field counted as spaces). */
function headerChecksumValid(header: Buffer): boolean {
  const expected = readNumericField(header, TAR_FIELDS.checksum)
  let sum = 0
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    const inChecksumField =
      i >= CHECKSUM_FIELD_START && i < CHECKSUM_FIELD_END
    sum += inChecksumField ? SPACE_BYTE : header.readUInt8(i)
  }
  return sum === expected
}

/** Official `DPs` — typeflag byte as character ('0' when NUL). */
function readTypeflag(header: Buffer): string {
  const byte = header.readUInt8(TAR_FIELDS.typeflag[0])
  return byte === 0 ? '0' : String.fromCharCode(byte)
}

/** Official `MPs` — link type name. */
function linkTypeName(typeflag: string): string {
  return typeflag === '1' ? 'hard link' : 'symbolic link'
}

/** Official `OPs` — ustar prefix + name. */
function ustarPath(header: Buffer, name: string): string {
  const prefix = readStringField(header, TAR_FIELDS.magic).startsWith('ustar')
    ? readStringField(header, TAR_FIELDS.prefix)
    : ''
  return prefix ? `${prefix}/${name}` : name
}

/** Official `NPs` — strip the top-level `package/` folder; null = skip. */
function stripPackageFolder(path: string): string | null {
  const withoutDot = path.replace(/^\.\//, '')
  const slash = withoutDot.indexOf('/')
  if (slash < 0) {
    return null
  }
  const rest = withoutDot.slice(slash + 1).replace(/\/+$/, '')
  return rest === '' ? null : rest
}

/**
 * Official `Oee` — containment check: not absolute, no `..` segment
 * (including the `. .` / `.. ` obfuscations), and normalization must not
 * escape upward.
 */
function isContainedPath(path: string): boolean {
  if (isAbsolute(path)) {
    return false
  }
  for (const segment of path.split(/[/\\]/)) {
    if (/^\.\.[ .]*$/.test(segment)) {
      return false
    }
  }
  return !posix.normalize(path).split('/').includes('..')
}

/** Official `$Ps` — pax extended header records (`len key=value\n`). */
function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(SPACE_BYTE, offset)
    if (space < 0) {
      break
    }
    const length = Number.parseInt(
      data.subarray(offset, space).toString('utf8'),
      10,
    )
    if (!Number.isFinite(length) || length <= 0) {
      break
    }
    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1))
    }
    offset += length
  }
  return records
}

/** Official `IPs` — gunzip with the unpacked-size cap. */
async function gunzipTarball(
  tarball: Buffer,
  limits: TarUnpackLimits,
): Promise<Buffer> {
  const maxUnpackedBytes = limits.maxUnpackedBytes ?? MAX_UNPACKED_BYTES
  try {
    return await gunzipAsync(tarball, { maxOutputLength: maxUnpackedBytes })
  } catch (error) {
    const message =
      error instanceof RangeError
        ? `The npm package unpacks to more than ${formatMiB(maxUnpackedBytes)} MB and was not installed`
        : 'The npm package tarball is not valid gzip data and was not installed'
    throw npmFetchError(message, 'npm tarball gunzip failed')
  }
}

/**
 * Official `PPs` — parse tar entries from gunzipped bytes. Refuses links,
 * devices/FIFOs, unsupported types, oversized entries, path traversal,
 * duplicate paths and over-long archives. No scripts are ever executed;
 * this is a pure data reader.
 */
export function parseTarEntries(
  data: Buffer,
  limits: TarUnpackLimits = {},
): TarEntry[] {
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_TAR_ENTRY_BYTES
  const maxEntries = limits.maxEntries ?? MAX_TAR_ENTRIES
  const entries: TarEntry[] = []
  const seenPaths = new Set<string>()
  /** Official `g` — pending pax extended path. */
  let paxPath: string | undefined
  /** Official `h` — pending GNU long name. */
  let gnuLongName: string | undefined
  let offset = 0
  while (offset + TAR_BLOCK_SIZE <= data.length) {
    const header = data.subarray(offset, offset + TAR_BLOCK_SIZE)
    if (isZeroBlock(header)) {
      break
    }
    if (!headerChecksumValid(header)) {
      throw tarRefused('a header checksum does not match (corrupt tarball)')
    }
    const rawName = readStringField(header, TAR_FIELDS.name)
    const size = readNumericField(header, TAR_FIELDS.size)
    const dataStart = offset + TAR_BLOCK_SIZE
    const dataEnd = dataStart + size
    if (size < 0) {
      throw tarRefused('an entry declares a negative size (corrupt tarball)')
    }
    if (size > maxEntryBytes) {
      throw tarRefused(
        `an entry is larger than ${formatMiB(maxEntryBytes)} MB (${truncateName(rawName)})`,
      )
    }
    if (dataEnd > data.length) {
      throw tarRefused(
        'an entry runs past the end of the archive (truncated tarball)',
      )
    }
    const content = data.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    const typeflag = readTypeflag(header)
    const pendingName = paxPath ?? gnuLongName
    switch (typeflag) {
      case 'x':
        paxPath = parsePaxRecords(content).get('path') ?? paxPath
        continue
      case 'L':
        gnuLongName = readNulTerminated(content)
        continue
      case 'g':
      case 'K':
        continue
      case '1':
      case '2':
        throw tarRefused(
          `it contains a ${linkTypeName(typeflag)} (${truncateName(pendingName ?? rawName)}); links are not allowed in a plugin package`,
        )
      case '3':
      case '4':
      case '6':
        throw tarRefused('it contains a device or FIFO entry')
      case '0':
      case '7':
      case '5':
        break
      default:
        throw tarRefused(
          `it contains an entry of unsupported type "${truncateName(typeflag, TYPEFLAG_TRUNCATE_LENGTH)}"`,
        )
    }
    const fullPath = pendingName ?? ustarPath(header, rawName)
    paxPath = undefined
    gnuLongName = undefined
    const path = stripPackageFolder(fullPath)
    if (path === null) {
      continue
    }
    if (!isContainedPath(path) || path.includes('\\')) {
      throw tarRefused(
        `it contains an entry outside the package folder (${truncateName(fullPath)})`,
      )
    }
    if (entries.length >= maxEntries) {
      throw tarRefused(`it contains more than ${maxEntries} entries`)
    }
    if (seenPaths.has(path)) {
      throw tarRefused(
        `it contains the same path twice (${truncateName(fullPath)})`,
      )
    }
    seenPaths.add(path)
    if (typeflag === '5') {
      entries.push({ kind: 'directory', path })
    } else {
      entries.push({
        kind: 'file',
        path,
        data: content,
        mode: readNumericField(header, TAR_FIELDS.mode),
      })
    }
  }
  if (!entries.some(entry => entry.kind === 'file')) {
    throw tarRefused('it contains no files')
  }
  return entries
}

/**
 * Official `znr` — write parsed entries to `destPath`. Files are created
 * exclusively (`wx`); a collision refuses (same-file-on-filesystem). Only
 * executable-bit files get a chmod (masked to 0o755). Returns written paths.
 */
export async function unpackNpmTarball(
  tarball: Buffer,
  destPath: string,
  limits: TarUnpackLimits = {},
): Promise<string[]> {
  const entries = parseTarEntries(await gunzipTarball(tarball, limits), limits)
  await mkdir(destPath, { recursive: true })
  const written: string[] = []
  for (const entry of entries) {
    const target = join(destPath, entry.path)
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, entry.data, { flag: 'wx' })
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST') {
        throw tarRefused(
          `two entries name the same file on this filesystem (${truncateName(entry.path)})`,
        )
      }
      throw error
    }
    if (entry.mode & EXEC_MODE_BITS) {
      await chmod(target, entry.mode & FILE_MODE_MASK).catch(() => {})
    }
    written.push(entry.path)
  }
  logForDebugging(`Unpacked npm tarball to ${destPath}: ${written.length} files`)
  return written
}

// --- Step 5: unpacked manifest check (official `BPs`/`Knr`) -----------------

/** Official `Knr` — read {name, version} from the unpacked package.json. */
async function readUnpackedPackageManifest(
  destPath: string,
): Promise<{ name?: string; version?: string }> {
  try {
    const raw = await getFsImplementation().readFile(
      join(destPath, 'package.json'),
      { encoding: 'utf8' },
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const name = Reflect.get(Object(parsed), 'name')
    const version = Reflect.get(Object(parsed), 'version')
    return compactObject({
      name: typeof name === 'string' ? name : undefined,
      version: typeof version === 'string' ? version : undefined,
    })
  } catch {
    return {}
  }
}

/**
 * Official `BPs` — the unpacked package must call itself what the registry
 * resolved; on mismatch the destination is removed and the install refused.
 */
export async function verifyUnpackedPackageManifest(
  destPath: string,
  resolution: Pick<NpmResolution, 'name' | 'version'>,
): Promise<void> {
  const manifest = await readUnpackedPackageManifest(destPath)
  if (manifest.name === resolution.name && manifest.version === resolution.version) {
    return
  }
  await rm(destPath, { recursive: true, force: true }).catch(() => {})
  throw npmFetchError(
    `${resolution.name}@${resolution.version} was not installed: the downloaded package calls itself ${truncateName(`${manifest.name ?? '(no name)'}@${manifest.version ?? '(no version)'}`)}`,
    'npm tarball manifest does not match the resolution',
  )
}

// --- Top-level pipeline (official `qnr`, npm lane) --------------------------

export interface InstallNpmPluginPackageParams extends NpmFetchOptions {
  packageName: string
  versionSpec?: string
}

/**
 * Official `qnr` (npm-source lane): resolve → pack --ignore-scripts → verify
 * SRI → script-free unpack → manifest identity check. `needsIntegrity` is
 * always true for OCC (marketplace/npm lane) — a registry that reports no
 * integrity value refuses the install.
 */
export async function installNpmPluginPackage(
  params: InstallNpmPluginPackageParams,
  destPath: string,
): Promise<NpmResolution> {
  const { packageName, versionSpec } = params
  const resolution = await resolveNpmPackage(packageName, versionSpec, params)
  logForDebugging(
    `npm: ${packageName}@${versionSpec ?? 'latest'} resolved to ${resolution.name}@${resolution.version} from ${resolution.tarballUrl}`,
  )
  const tarball = await fetchAndVerifyNpmTarball(resolution, {
    ...params,
    needsIntegrity: true,
  })
  await unpackNpmTarball(tarball, destPath)
  await verifyUnpackedPackageManifest(destPath, resolution)
  return resolution
}
