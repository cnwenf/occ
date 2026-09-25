import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'

/**
 * CC 2.1.275 changelog item 6 (SECURITY): npm-source plugins must be fetched
 * with `npm pack --ignore-scripts` + SRI integrity verification, replacing the
 * v2.1.274 plain `npm install` (which ran untrusted lifecycle scripts — RCE).
 *
 * Ported official subsystem (2.1.276 binary @200294300-200299900):
 *   L6n  = resolveNpmPackage        (`npm view --json`, 60s)
 *   Wnr  = packNpmTarball           (`npm pack --ignore-scripts`, 300s)
 *   RPs  = verifyNpmTarball         (SRI sha512→sha384→sha256→sha1)
 *   PPs/znr = parseTarEntries/unpackNpmTarball (script-free tar reader)
 *   BPs  = verifyUnpackedPackageManifest
 *
 * exec is mocked at the module boundary (mock.module spreading the real
 * module, restored in afterAll); unpack tests run against the real fs in
 * throwaway temp dirs.
 */

// --- module-boundary mocks (registered BEFORE importing the module under test)

const realExecModule = await import('../../execFileNoThrow.js')

interface ExecCall {
  file: string
  args: string[]
  opts: Record<string, unknown>
}
const execCalls: ExecCall[] = []
let execHandler:
  | ((call: ExecCall) => Promise<{ stdout: string; stderr: string; code: number }>)
  | null = null

// Capture real function values BEFORE mock.module registration: Bun patches
// live ESM namespaces, so calling realModule.fn() inside the factory would
// recurse into the mock itself.
const realExecFileNoThrowWithCwd = realExecModule.execFileNoThrowWithCwd
type ExecOpts = Parameters<typeof realExecFileNoThrowWithCwd>[2]

mock.module('../../execFileNoThrow.js', () => ({
  ...realExecModule,
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    const call = { file, args, opts }
    execCalls.push(call)
    if (execHandler) {
      return execHandler(call)
    }
    return realExecFileNoThrowWithCwd(file, args, opts as ExecOpts)
  },
}))

const realFsOps = await import('../../fsOperations.js')
const realGetFsImplementation = realFsOps.getFsImplementation
let readFileBytesHandler:
  | ((path: string, maxBytes?: number) => Promise<Buffer>)
  | null = null

mock.module('../../fsOperations.js', () => ({
  ...realFsOps,
  getFsImplementation: () => {
    const real = realGetFsImplementation()
    if (!readFileBytesHandler) {
      return real
    }
    const handler = readFileBytesHandler
    return {
      ...real,
      readFileBytes: (path: string, maxBytes?: number) => handler(path, maxBytes),
    }
  },
}))

const {
  MAX_TARBALL_BYTES,
  NPM_EXEC_MAX_BUFFER,
  NPM_PACK_TIMEOUT_MS,
  NPM_VIEW_TIMEOUT_MS,
  SRI_ALGORITHMS,
  installNpmPluginPackage,
  matchesSri,
  packNpmTarball,
  parseTarEntries,
  resolveNpmPackage,
  unpackNpmTarball,
  verifyNpmTarball,
  verifyUnpackedPackageManifest,
} = await import('../npmPluginFetch.js')

// --- temp dirs ----------------------------------------------------------------

const tempRoots: string[] = []

async function makeTempDir(prefix = 'occ-npm275-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  // Heal the seams first: mock.restore() does NOT undo mock.module, and no
  // beforeEach runs after this file — with the handlers left at the last
  // test's values, leaked closures would keep serving them to every later
  // file in the shared process. Null handlers make the leaked closures
  // delegate to the real implementations (OCC-96).
  execHandler = null
  readFileBytesHandler = null
  execCalls.length = 0
  mock.restore()
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

beforeEach(() => {
  execCalls.length = 0
  execHandler = null
  readFileBytesHandler = null
})

// --- tar builder helpers ------------------------------------------------------

const TAR_BLOCK = 512

function writeOctalField(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'utf8')
  header.writeUInt8(0, offset + length - 1)
}

interface TarEntrySpec {
  name: string
  /** Default '0' (regular file). '5' dir, '2' symlink, '1' hardlink, '3' chardev... */
  typeflag?: string
  content?: Buffer
  mode?: number
  prefix?: string
  /** Write a different numeric size into the header than the real content. */
  declaredSize?: number
  /** Write raw text into the size field (e.g. '-5' for the negative-size case). */
  sizeText?: string
  corruptChecksum?: boolean
  /** Truncate the emitted data blocks (simulates a truncated archive). */
  truncateDataTo?: number
}

function buildTarBlock(entry: TarEntrySpec): Buffer {
  const content = entry.content ?? Buffer.alloc(0)
  const header = Buffer.alloc(TAR_BLOCK)
  header.write(entry.name, 0, 100, 'utf8')
  writeOctalField(header, 100, 8, entry.mode ?? 0o644)
  writeOctalField(header, 108, 8, 0)
  writeOctalField(header, 116, 8, 0)
  if (entry.sizeText !== undefined) {
    header.write(entry.sizeText, 124, 11, 'utf8')
    header.writeUInt8(0, 135)
  } else {
    writeOctalField(header, 124, 12, entry.declaredSize ?? content.length)
  }
  writeOctalField(header, 136, 12, 0)
  header.write(entry.typeflag ?? '0', 156, 1, 'utf8')
  header.write('ustar', 257, 5, 'utf8')
  header.writeUInt8(0, 262)
  header.write('00', 263, 2, 'utf8')
  if (entry.prefix) {
    header.write(entry.prefix, 345, Math.min(entry.prefix.length, 155), 'utf8')
  }
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) {
    sum += byte
  }
  if (entry.corruptChecksum) {
    sum += 1
  }
  writeOctalField(header, 148, 8, sum)

  const dataBlocks =
    Math.ceil((entry.truncateDataTo ?? content.length) / TAR_BLOCK) * TAR_BLOCK
  const block = Buffer.alloc(TAR_BLOCK + dataBlocks)
  header.copy(block, 0)
  content.subarray(0, entry.truncateDataTo ?? content.length).copy(block, TAR_BLOCK)
  return block
}

function buildTar(entries: TarEntrySpec[]): Buffer {
  return Buffer.concat([
    ...entries.map(buildTarBlock),
    Buffer.alloc(2 * TAR_BLOCK),
  ])
}

function buildTarGz(entries: TarEntrySpec[]): Buffer {
  return gzipSync(buildTar(entries))
}

/** pax extended header record: "<len> key=value\n" where len counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) {
    length = String(length).length + body.length
  }
  return Buffer.from(`${length}${body}`, 'utf8')
}

function sriOf(algorithm: string, data: Buffer): string {
  return `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`
}

const RESOLUTION = { name: 'pkg', version: '1.0.0' }

// --- tests ---------------------------------------------------------------------

describe('npmPluginFetch: official v276 constant parity', () => {
  test('timeouts, caps and SRI order match the official binary values', () => {
    expect(NPM_VIEW_TIMEOUT_MS).toBe(60000)
    expect(NPM_PACK_TIMEOUT_MS).toBe(300000)
    expect(NPM_EXEC_MAX_BUFFER).toBe(8388608)
    expect(MAX_TARBALL_BYTES).toBe(256 * 1024 * 1024)
    expect([...SRI_ALGORITHMS]).toEqual(['sha512', 'sha384', 'sha256', 'sha1'])
  })
})

describe('npmPluginFetch: resolveNpmPackage (official L6n)', () => {
  const viewJson = (fields: Record<string, unknown>): string =>
    JSON.stringify(fields)

  test('runs npm view --json with the official fields, 60s timeout and ignore-scripts env', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: viewJson({
        name: 'pkg',
        version: '1.2.3',
        'dist.tarball': 'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',
        'dist.integrity': 'sha512-AAAA',
        'dist.shasum': 'abcd',
        'dist-tags.latest': '1.2.3',
      }),
      stderr: '',
      code: 0,
    })
    const resolution = await resolveNpmPackage('pkg', '1.2.3', { workDir })
    expect(resolution).toEqual({
      name: 'pkg',
      version: '1.2.3',
      tarballUrl: 'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',
      integrity: 'sha512-AAAA',
      shasum: 'abcd',
    })
    expect(execCalls).toHaveLength(1)
    const call = execCalls[0]
    expect(call.file).toBe('npm')
    expect(call.args).toEqual([
      'view',
      '--json',
      '--',
      'pkg@1.2.3',
      'name',
      'version',
      'dist.tarball',
      'dist.integrity',
      'dist.shasum',
      'dist-tags.latest',
    ])
    expect(call.opts.timeout).toBe(60000)
    expect(call.opts.cwd).toBe(workDir)
    expect(call.opts.maxBuffer).toBe(8388608)
    expect(call.opts.stdin).toBe('ignore')
    const env = call.opts.env as Record<string, string>
    expect(env.npm_config_ignore_scripts).toBe('true')
  })

  test('inserts --registry before the spec when a registry is configured', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: viewJson({
        version: '2.0.0',
        'dist.tarball': 'https://r/pkg-2.0.0.tgz',
      }),
      stderr: '',
      code: 0,
    })
    await resolveNpmPackage('pkg', undefined, {
      workDir,
      registry: 'https://r',
    })
    expect(execCalls[0].args.slice(0, 6)).toEqual([
      'view',
      '--json',
      '--registry',
      'https://r',
      '--',
      'pkg@latest',
    ])
  })

  test('picks the max satisfying version across multi-version view output', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: JSON.stringify([
        { version: '1.0.0', 'dist.tarball': 'https://r/a.tgz' },
        { version: '1.2.0', 'dist.tarball': 'https://r/b.tgz' },
        { version: '2.0.0', 'dist.tarball': 'https://r/c.tgz' },
      ]),
      stderr: '',
      code: 0,
    })
    const resolution = await resolveNpmPackage('pkg', '^1.0.0', { workDir })
    expect(resolution.version).toBe('1.2.0')
    expect(resolution.tarballUrl).toBe('https://r/b.tgz')
    // name falls back to the requested package name when the view omits it
    expect(resolution.name).toBe('pkg')
  })

  test('refuses an npm view failure with the registry error summary', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: '',
      stderr: 'npm ERR! code E404\nnpm error 404 Not Found - GET https://r/pkg',
      code: 1,
    })
    await expect(
      resolveNpmPackage('pkg', '1.0.0', { workDir }),
    ).rejects.toThrow(
      'Could not resolve pkg@1.0.0 from the npm registry: code E404',
    )
  })

  test('prefers the JSON error summary (code + summary) from npm view stdout', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: '{"error":{"code":"E404","summary":"Not Found - GET https://r/pkg"}}',
      stderr: '',
      code: 1,
    })
    await expect(
      resolveNpmPackage('pkg', '1.0.0', { workDir }),
    ).rejects.toThrow(
      'Could not resolve pkg@1.0.0 from the npm registry: E404 Not Found - GET https://r/pkg',
    )
  })

  test('refuses when no version matches / no tarball URL is reported', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({ stdout: '[]', stderr: '', code: 0 })
    await expect(
      resolveNpmPackage('pkg', '^9.0.0', { workDir }),
    ).rejects.toThrow(
      'Could not resolve pkg@^9.0.0 from the npm registry: no version matches',
    )

    execHandler = async () => ({
      stdout: viewJson({ version: '1.0.0' }),
      stderr: '',
      code: 0,
    })
    await expect(
      resolveNpmPackage('pkg', '1.0.0', { workDir }),
    ).rejects.toThrow(
      'Could not resolve pkg@1.0.0 from the npm registry: the registry did not report a tarball URL',
    )
  })

  test('refuses a version spec that is not a version, range or dist-tag', async () => {
    const workDir = await makeTempDir()
    await expect(
      resolveNpmPackage('pkg', 'not a version!', { workDir }),
    ).rejects.toThrow(
      'pkg was not resolved: "not a version!" is not a version, a semver range or a dist-tag',
    )
    expect(execCalls).toHaveLength(0)
  })

  test('accepts dist-tag specs', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: viewJson({ version: '3.0.0', 'dist.tarball': 'https://r/c.tgz' }),
      stderr: '',
      code: 0,
    })
    const resolution = await resolveNpmPackage('pkg', 'next', { workDir })
    expect(resolution.version).toBe('3.0.0')
  })
})

describe('npmPluginFetch: packNpmTarball (official Wnr)', () => {
  test('runs npm pack --ignore-scripts with the official env, 300s timeout, and returns the tarball bytes', async () => {
    const workDir = await makeTempDir()
    const tarball = buildTarGz([
      { name: 'package/package.json', content: Buffer.from('{}') },
    ])
    execHandler = async call => {
      await writeFile(join(call.opts.cwd as string, 'pkg-1.0.0.tgz'), tarball)
      return { stdout: '', stderr: '', code: 0 }
    }
    const packed = await packNpmTarball('https://r/pkg-1.0.0.tgz', {
      workDir,
      displaySpec: 'pkg@1.0.0',
    })
    expect(packed.equals(tarball)).toBe(true)
    expect(execCalls).toHaveLength(1)
    const call = execCalls[0]
    expect(call.args).toEqual([
      'pack',
      '--ignore-scripts',
      '--loglevel=error',
      '--',
      'https://r/pkg-1.0.0.tgz',
    ])
    expect(call.opts.timeout).toBe(300000)
    const env = call.opts.env as Record<string, string>
    expect(env.npm_config_ignore_scripts).toBe('true')
  })

  test('refuses when npm pack fails', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({
      stdout: '',
      stderr: 'npm error 401 Unauthorized',
      code: 1,
    })
    await expect(
      packNpmTarball('https://r/pkg-1.0.0.tgz', {
        workDir,
        displaySpec: 'pkg@1.0.0',
      }),
    ).rejects.toThrow(
      'Could not download pkg@1.0.0 from the npm registry: 401 Unauthorized',
    )
  })

  test('refuses when npm pack finishes without writing a tarball', async () => {
    const workDir = await makeTempDir()
    execHandler = async () => ({ stdout: '', stderr: '', code: 0 })
    await expect(
      packNpmTarball('https://r/pkg-1.0.0.tgz', {
        workDir,
        displaySpec: 'pkg@1.0.0',
      }),
    ).rejects.toThrow(
      'Could not download pkg@1.0.0: npm pack finished without writing a tarball',
    )
  })

  test('enforces the tarball size cap', async () => {
    const workDir = await makeTempDir()
    execHandler = async call => {
      await writeFile(
        join(call.opts.cwd as string, 'pkg-1.0.0.tgz'),
        Buffer.alloc(1.5 * 1024 * 1024),
      )
      return { stdout: '', stderr: '', code: 0 }
    }
    await expect(
      packNpmTarball('https://r/pkg-1.0.0.tgz', {
        workDir,
        displaySpec: 'pkg@1.0.0',
        maxTarballBytes: 1024 * 1024,
      }),
    ).rejects.toThrow('pkg@1.0.0 is larger than 1 MB and was not installed')
  })

  test('default cap reads at most 256 MiB + 1 and reports "256 MB"', async () => {
    const workDir = await makeTempDir()
    execHandler = async call => {
      await writeFile(
        join(call.opts.cwd as string, 'pkg-1.0.0.tgz'),
        Buffer.alloc(8),
      )
      return { stdout: '', stderr: '', code: 0 }
    }
    let requestedMaxBytes: number | undefined
    readFileBytesHandler = async (_path, maxBytes) => {
      requestedMaxBytes = maxBytes
      return { length: MAX_TARBALL_BYTES + 1 } as unknown as Buffer
    }
    await expect(
      packNpmTarball('https://r/pkg-1.0.0.tgz', {
        workDir,
        displaySpec: 'pkg@1.0.0',
      }),
    ).rejects.toThrow('pkg@1.0.0 is larger than 256 MB and was not installed')
    expect(requestedMaxBytes).toBe(MAX_TARBALL_BYTES + 1)
  })
})

describe('npmPluginFetch: SRI verification (official RPs/Gnr)', () => {
  const data = buildTarGz([
    { name: 'package/package.json', content: Buffer.from('{"name":"pkg"}') },
  ])

  test.each([...SRI_ALGORITHMS])(
    'verifies a matching %s integrity',
    algorithm => {
      expect(() =>
        verifyNpmTarball(
          data,
          { ...RESOLUTION, integrity: sriOf(algorithm, data) },
          { needsIntegrity: true },
        ),
      ).not.toThrow()
      expect(matchesSri(data, sriOf(algorithm, data))).toBe(true)
    },
  )

  test('prefers the strongest listed algorithm (sha512 over a wrong sha1)', () => {
    const integrity = `sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA ${sriOf('sha512', data)}`
    expect(matchesSri(data, integrity)).toBe(true)
    expect(() =>
      verifyNpmTarball(data, { ...RESOLUTION, integrity }, { needsIntegrity: true }),
    ).not.toThrow()
  })

  test('refuses an integrity mismatch with the byte-exact official string', () => {
    expect.assertions(2)
    try {
      verifyNpmTarball(
        data,
        { ...RESOLUTION, integrity: 'sha512-BADHASH' },
        { needsIntegrity: true },
      )
    } catch (error) {
      expect((error as Error).message).toBe(
        'pkg@1.0.0 was not installed: the downloaded tarball does not match the integrity (sha512-BADHASH) the registry reported',
      )
      expect((error as { reason: string }).reason).toBe(
        'npm tarball integrity mismatch',
      )
    }
  })

  test('refuses an unsupported-only integrity (e.g. md5)', () => {
    expect(matchesSri(data, 'md5-AAAAAAAAAAAAAAAAAAAAAA==')).toBe(false)
    expect(() =>
      verifyNpmTarball(
        data,
        { ...RESOLUTION, integrity: 'md5-AAAAAAAAAAAAAAAAAAAAAA==' },
        { needsIntegrity: true },
      ),
    ).toThrow('does not match the integrity')
  })

  test('falls back to shasum only when integrity is not required', () => {
    const shasum = createHash('sha1').update(data).digest('hex').toUpperCase()
    expect(() =>
      verifyNpmTarball(data, { ...RESOLUTION, shasum }, { needsIntegrity: false }),
    ).not.toThrow()
    expect(() =>
      verifyNpmTarball(
        data,
        { ...RESOLUTION, shasum: 'deadbeef' },
        { needsIntegrity: false },
      ),
    ).toThrow(
      'pkg@1.0.0 was not installed: the downloaded tarball does not match the shasum the registry reported',
    )
  })

  test('refuses missing integrity with the byte-exact official string when integrity is required', () => {
    expect.assertions(2)
    try {
      verifyNpmTarball(
        data,
        { ...RESOLUTION, shasum: createHash('sha1').update(data).digest('hex') },
        { needsIntegrity: true },
      )
    } catch (error) {
      expect((error as Error).message).toBe(
        'pkg@1.0.0 was not installed: the registry reported no integrity value to verify the download against',
      )
      expect((error as { reason: string }).reason).toBe(
        'npm registry reported no integrity',
      )
    }
  })

  test('warns and installs unverified when no integrity and not required', () => {
    expect(() =>
      verifyNpmTarball(data, { ...RESOLUTION }, { needsIntegrity: false }),
    ).not.toThrow()
  })
})

describe('npmPluginFetch: script-free tar unpacker (official PPs/znr)', () => {
  test('unpacks files and directories, strips the package/ folder, preserves exec bits', async () => {
    const dest = await makeTempDir()
    const tarball = buildTarGz([
      { name: 'loose-top-level.txt', content: Buffer.from('skipped') },
      { name: 'package/', typeflag: '5' },
      {
        name: 'package/package.json',
        content: Buffer.from('{"name":"pkg","version":"1.0.0"}'),
      },
      { name: 'package/commands/', typeflag: '5' },
      { name: 'package/commands/hi.md', content: Buffer.from('# hi\n') },
      {
        name: 'package/bin/run.sh',
        content: Buffer.from('#!/bin/sh\necho hi\n'),
        mode: 0o755,
      },
    ])
    const written = await unpackNpmTarball(tarball, dest)
    expect(written.sort()).toEqual([
      'bin/run.sh',
      'commands/hi.md',
      'package.json',
    ])
    expect(
      (await readFile(join(dest, 'package.json'), 'utf8')).includes('"pkg"'),
    ).toBe(true)
    expect(await readFile(join(dest, 'commands', 'hi.md'), 'utf8')).toBe('# hi\n')
    const runStat = await stat(join(dest, 'bin', 'run.sh'))
    expect(runStat.mode & 0o111).not.toBe(0)
    expect((await stat(join(dest, 'package.json'))).mode & 0o111).toBe(0)
    // top-level entries outside the package folder are skipped, not written
    await expect(stat(join(dest, 'loose-top-level.txt'))).rejects.toThrow()
  })

  test('honors ustar prefix + pax extended path + GNU long name entries', async () => {
    const dest = await makeTempDir()
    const paxPayload = paxRecord('path', 'package/pax-named.txt')
    const longName = Buffer.concat([
      Buffer.from('package/gnu-long-name.txt', 'utf8'),
      Buffer.alloc(1),
    ])
    const tarball = buildTarGz([
      { name: 'file.txt', prefix: 'package/deep', content: Buffer.from('a') },
      { name: 'PaxHeaders.0/x', typeflag: 'x', content: paxPayload },
      { name: 'package/ignored-by-pax.txt', content: Buffer.from('b') },
      { name: '././@LongLink', typeflag: 'L', content: longName },
      { name: 'package/ignored-by-gnu.txt', content: Buffer.from('c') },
    ])
    const written = await unpackNpmTarball(tarball, dest)
    expect(written.sort()).toEqual([
      'deep/file.txt',
      'gnu-long-name.txt',
      'pax-named.txt',
    ])
    expect(await readFile(join(dest, 'pax-named.txt'), 'utf8')).toBe('b')
    expect(await readFile(join(dest, 'gnu-long-name.txt'), 'utf8')).toBe('c')
  })

  test('rejects path traversal outside the package folder', async () => {
    const dest = await makeTempDir()
    const tarball = buildTarGz([
      { name: 'package/../../evil.js', content: Buffer.from('pwn') },
    ])
    await expect(unpackNpmTarball(tarball, dest)).rejects.toThrow(
      'The npm package was not installed: it contains an entry outside the package folder (package/../../evil.js)',
    )
    await expect(stat(join(dest, '..', 'evil.js'))).rejects.toThrow()
  })

  test('rejects backslash paths', async () => {
    const dest = await makeTempDir()
    const tarball = buildTarGz([
      { name: 'package/..\\evil.js', content: Buffer.from('pwn') },
    ])
    await expect(unpackNpmTarball(tarball, dest)).rejects.toThrow(
      'it contains an entry outside the package folder',
    )
  })

  test('rejects symlinks and hardlinks', async () => {
    const dest = await makeTempDir()
    await expect(
      unpackNpmTarball(
        buildTarGz([{ name: 'package/link', typeflag: '2' }]),
        dest,
      ),
    ).rejects.toThrow(
      'The npm package was not installed: it contains a symbolic link (package/link); links are not allowed in a plugin package',
    )
    await expect(
      unpackNpmTarball(
        buildTarGz([{ name: 'package/link', typeflag: '1' }]),
        dest,
      ),
    ).rejects.toThrow(
      'The npm package was not installed: it contains a hard link (package/link); links are not allowed in a plugin package',
    )
  })

  test('rejects device/FIFO entries and unsupported types', async () => {
    const dest = await makeTempDir()
    await expect(
      unpackNpmTarball(
        buildTarGz([{ name: 'package/dev', typeflag: '3' }]),
        dest,
      ),
    ).rejects.toThrow(
      'The npm package was not installed: it contains a device or FIFO entry',
    )
    await expect(
      unpackNpmTarball(
        buildTarGz([{ name: 'package/x', typeflag: 'A', content: Buffer.from('y') }]),
        dest,
      ),
    ).rejects.toThrow(
      'The npm package was not installed: it contains an entry of unsupported type "A"',
    )
  })

  test('rejects corrupt header checksums', async () => {
    const tar = buildTar([
      {
        name: 'package/a.txt',
        content: Buffer.from('data'),
        corruptChecksum: true,
      },
    ])
    await expect(
      unpackNpmTarball(gzipSync(tar), await makeTempDir()),
    ).rejects.toThrow(
      'The npm package was not installed: a header checksum does not match (corrupt tarball)',
    )
  })

  test('rejects negative sizes and truncated archives', async () => {
    expect(() =>
      parseTarEntries(
        buildTar([{ name: 'package/a.txt', sizeText: '-5', content: Buffer.alloc(0) }]),
      ),
    ).toThrow(
      'The npm package was not installed: an entry declares a negative size (corrupt tarball)',
    )
    const truncated = buildTar([
      {
        name: 'package/a.txt',
        content: Buffer.from('hello world'),
        declaredSize: 5000,
        truncateDataTo: 11,
      },
    ])
    expect(() => parseTarEntries(truncated)).toThrow(
      'The npm package was not installed: an entry runs past the end of the archive (truncated tarball)',
    )
  })

  test('enforces the per-entry size cap and the entry-count cap', async () => {
    const oversized = buildTar([
      { name: 'package/big.bin', content: Buffer.alloc(64), declaredSize: 11 },
    ])
    expect(() =>
      parseTarEntries(oversized, { maxEntryBytes: 10 }),
    ).toThrow(
      'The npm package was not installed: an entry is larger than 0 MB (package/big.bin)',
    )
    const many = buildTar([
      { name: 'package/a.txt', content: Buffer.from('a') },
      { name: 'package/b.txt', content: Buffer.from('b') },
    ])
    expect(() => parseTarEntries(many, { maxEntries: 1 })).toThrow(
      'The npm package was not installed: it contains more than 1 entries',
    )
  })

  test('rejects duplicate paths and file-less archives', async () => {
    expect(() =>
      parseTarEntries(
        buildTar([
          { name: 'package/dup.txt', content: Buffer.from('a') },
          { name: 'package/dup.txt', content: Buffer.from('b') },
        ]),
      ),
    ).toThrow(
      'The npm package was not installed: it contains the same path twice (package/dup.txt)',
    )
    expect(() =>
      parseTarEntries(buildTar([{ name: 'package/dir/', typeflag: '5' }])),
    ).toThrow('The npm package was not installed: it contains no files')
  })

  test('enforces the gunzip output cap and rejects non-gzip data', async () => {
    const tarball = buildTarGz([
      { name: 'package/a.txt', content: Buffer.alloc(4096, 0x41) },
    ])
    await expect(
      unpackNpmTarball(tarball, await makeTempDir(), { maxUnpackedBytes: 16 }),
    ).rejects.toThrow(
      'The npm package unpacks to more than 0 MB and was not installed',
    )
    await expect(
      unpackNpmTarball(Buffer.from('this is not gzip data'), await makeTempDir()),
    ).rejects.toThrow(
      'The npm package tarball is not valid gzip data and was not installed',
    )
  })
})

describe('npmPluginFetch: unpacked manifest identity (official BPs)', () => {
  async function unpackedWith(packageJson: string | null): Promise<string> {
    const dest = await makeTempDir()
    await mkdir(dest, { recursive: true })
    if (packageJson !== null) {
      await writeFile(join(dest, 'package.json'), packageJson)
    }
    return dest
  }

  test('passes when name and version match the resolution', async () => {
    const dest = await unpackedWith('{"name":"pkg","version":"1.0.0"}')
    await expect(
      verifyUnpackedPackageManifest(dest, RESOLUTION),
    ).resolves.toBeUndefined()
  })

  test('refuses and removes the destination on identity mismatch', async () => {
    const dest = await unpackedWith('{"name":"other","version":"9.9.9"}')
    await expect(
      verifyUnpackedPackageManifest(dest, RESOLUTION),
    ).rejects.toThrow(
      'pkg@1.0.0 was not installed: the downloaded package calls itself other@9.9.9',
    )
    await expect(stat(dest)).rejects.toThrow()
  })

  test('reports (no name)@(no version) when package.json is missing', async () => {
    const dest = await unpackedWith(null)
    await expect(
      verifyUnpackedPackageManifest(dest, RESOLUTION),
    ).rejects.toThrow(
      'pkg@1.0.0 was not installed: the downloaded package calls itself (no name)@(no version)',
    )
  })
})

describe('npmPluginFetch: end-to-end pipeline (official qnr npm lane)', () => {
  const packageJson = Buffer.from(
    JSON.stringify({ name: 'pkg', version: '1.0.0' }),
  )
  const tarball = buildTarGz([
    { name: 'package/package.json', content: packageJson },
    { name: 'package/commands/hi.md', content: Buffer.from('# hi\n') },
  ])

  function viewPayload(fields: Record<string, unknown>): string {
    return JSON.stringify({
      name: 'pkg',
      version: '1.0.0',
      'dist.tarball': 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      ...fields,
    })
  }

  test('resolve → pack --ignore-scripts → verify → unpack → identity check', async () => {
    const workDir = await makeTempDir()
    const dest = join(await makeTempDir(), 'plugin')
    execHandler = async call => {
      if (call.args[0] === 'view') {
        return {
          stdout: viewPayload({ 'dist.integrity': sriOf('sha512', tarball) }),
          stderr: '',
          code: 0,
        }
      }
      await writeFile(join(call.opts.cwd as string, 'pkg-1.0.0.tgz'), tarball)
      return { stdout: '', stderr: '', code: 0 }
    }
    const resolution = await installNpmPluginPackage(
      { packageName: 'pkg', versionSpec: '1.0.0', workDir },
      dest,
    )
    expect(resolution.version).toBe('1.0.0')
    expect(await readFile(join(dest, 'package.json'), 'utf8')).toContain('"pkg"')
    expect(await readFile(join(dest, 'commands', 'hi.md'), 'utf8')).toBe('# hi\n')
    // lifecycle scripts disabled on BOTH npm invocations
    for (const call of execCalls) {
      const env = call.opts.env as Record<string, string>
      expect(env.npm_config_ignore_scripts).toBe('true')
    }
    expect(execCalls[1].args).toContain('--ignore-scripts')
  })

  test('refuses a tampered tarball that fails SRI verification', async () => {
    const workDir = await makeTempDir()
    const dest = join(await makeTempDir(), 'plugin')
    execHandler = async call => {
      if (call.args[0] === 'view') {
        return {
          stdout: viewPayload({ 'dist.integrity': 'sha512-TAMPERED' }),
          stderr: '',
          code: 0,
        }
      }
      await writeFile(join(call.opts.cwd as string, 'pkg-1.0.0.tgz'), tarball)
      return { stdout: '', stderr: '', code: 0 }
    }
    await expect(
      installNpmPluginPackage(
        { packageName: 'pkg', versionSpec: '1.0.0', workDir },
        dest,
      ),
    ).rejects.toThrow(
      'pkg@1.0.0 was not installed: the downloaded tarball does not match the integrity (sha512-TAMPERED) the registry reported',
    )
    await expect(stat(dest)).rejects.toThrow()
  })

  test('refuses registry metadata with no integrity value', async () => {
    const workDir = await makeTempDir()
    const dest = join(await makeTempDir(), 'plugin')
    execHandler = async call => {
      if (call.args[0] === 'view') {
        return { stdout: viewPayload({}), stderr: '', code: 0 }
      }
      await writeFile(join(call.opts.cwd as string, 'pkg-1.0.0.tgz'), tarball)
      return { stdout: '', stderr: '', code: 0 }
    }
    await expect(
      installNpmPluginPackage(
        { packageName: 'pkg', versionSpec: '1.0.0', workDir },
        dest,
      ),
    ).rejects.toThrow(
      'pkg@1.0.0 was not installed: the registry reported no integrity value to verify the download against',
    )
  })

  test('refuses a tarball whose package.json calls itself something else', async () => {
    const workDir = await makeTempDir()
    const dest = join(await makeTempDir(), 'plugin')
    const impostor = buildTarGz([
      {
        name: 'package/package.json',
        content: Buffer.from('{"name":"impostor","version":"6.6.6"}'),
      },
      { name: 'package/a.txt', content: Buffer.from('a') },
    ])
    execHandler = async call => {
      if (call.args[0] === 'view') {
        return {
          stdout: viewPayload({ 'dist.integrity': sriOf('sha512', impostor) }),
          stderr: '',
          code: 0,
        }
      }
      await writeFile(join(call.opts.cwd as string, 'pkg-1.0.0.tgz'), impostor)
      return { stdout: '', stderr: '', code: 0 }
    }
    await expect(
      installNpmPluginPackage(
        { packageName: 'pkg', versionSpec: '1.0.0', workDir },
        dest,
      ),
    ).rejects.toThrow(
      'pkg@1.0.0 was not installed: the downloaded package calls itself impostor@6.6.6',
    )
    await expect(stat(dest)).rejects.toThrow()
  })
})
