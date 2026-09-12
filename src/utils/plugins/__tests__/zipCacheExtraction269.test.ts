import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { extractZipToDirectory } from '../zipCache.js'

/**
 * Official 2.1.269 (E42): plugin-zip extraction hardening. Verifies the port in
 * `zipCache.ts` `extractZipToDirectory` — mode masking (`rfe` exec chmod `&w$`),
 * the per-file `swo` integrity sweep (group/other-write strip), and the staging
 * + rename-swap that clears stale files on re-extraction (`nDt`/`oDt`).
 *
 * Byte-verified against js269.txt: `var w$=493` @849721; `rfe` chmod
 * `if(P&&P&73)await Uko(A,P&w$)` @1429374; `swo` @1430917…@1431132; `nDt`
 * `.staging-`/`.previous-` @5043654/@5043689; `oDt` @5044761.
 */

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

let savedUmask = 0o022

beforeEach(() => {
  // Force a permissive umask so writeFile would land 0o666 on disk. The `swo`
  // sweep must be what strips it to 0o644 — proving the port, not the ambient
  // umask, does the hardening.
  savedUmask = process.umask(0)
})

afterEach(() => {
  process.umask(savedUmask)
})

/** Build a ZIP whose entries carry the given Unix st_mode in external_attr. */
function buildZip(entries: Array<[string, number]>): Buffer {
  const files: Record<string, [Uint8Array, { os: number; attrs: number }]> = {}
  for (const [name, mode] of entries) {
    // os:3 = Unix; attrs holds st_mode in the high 16 bits (matches
    // collectFilesForZip in zipCache.ts and read back by parseZipModes).
    files[name] = [
      strToU8(`content of ${name}`),
      { os: 3, attrs: (mode & 0xffff) << 16 },
    ]
  }
  return Buffer.from(zipSync(files, { level: 0 }))
}

async function makeExtraction() {
  const base = await mkdtemp(join(tmpdir(), 'occ-e42-'))
  tempRoots.push(base)
  const targetDir = join(base, 'plugin')
  let seq = 0
  const writeZip = async (
    entries: Array<[string, number]>,
  ): Promise<string> => {
    const zipPath = join(base, `archive-${seq++}.zip`)
    await writeFile(zipPath, buildZip(entries))
    return zipPath
  }
  return { base, parentDir: base, targetDir, writeZip }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function permBits(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777
}

describe('E42 (2.1.269): extracted mode hardening', () => {
  test('a 0o666 entry lands as 0o644 (swo strips group/other write)', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const zipPath = await writeZip([['plain.txt', 0o100666]])

    await extractZipToDirectory(zipPath, targetDir)

    // umask is 0 here, so writeFile alone would leave 0o666; the swo sweep
    // (mode & 0o22 !== 0 → fchmod mode & 0o755) must reduce it to 0o644.
    expect((await permBits(join(targetDir, 'plain.txt'))).toString(8)).toBe(
      '644',
    )
  })

  test('a setuid 0o4755 entry lands as 0o755 (setuid + high bits stripped)', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const zipPath = await writeZip([['bin/tool', 0o104755]])

    await extractZipToDirectory(zipPath, targetDir)

    const st = await lstat(join(targetDir, 'bin', 'tool'))
    // rfe exec gate (mode & 0o111 !== 0) chmods to mode & 0o755 → setuid gone.
    expect(st.mode & 0o777).toBe(0o755)
    expect(st.mode & 0o7000).toBe(0)
  })

  test('an exec 0o777 entry lands as 0o755 (group/other write stripped, exec kept)', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const zipPath = await writeZip([['run.sh', 0o100777]])

    await extractZipToDirectory(zipPath, targetDir)

    expect((await permBits(join(targetDir, 'run.sh'))).toString(8)).toBe('755')
  })

  test('a plain 0o644 entry is left at 0o644 (no over-stripping)', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const zipPath = await writeZip([['doc.md', 0o100644]])

    await extractZipToDirectory(zipPath, targetDir)

    expect((await permBits(join(targetDir, 'doc.md'))).toString(8)).toBe('644')
  })
})

describe('E42 (2.1.269): staging + rename-swap clears stale files', () => {
  test('re-extracting over an existing dir removes files dropped from the archive', async () => {
    const { targetDir, writeZip } = await makeExtraction()

    // First extraction ships two files.
    const zip1 = await writeZip([
      ['keep.txt', 0o100644],
      ['stale.txt', 0o100644],
    ])
    await extractZipToDirectory(zip1, targetDir)
    expect(await exists(join(targetDir, 'stale.txt'))).toBe(true)

    // Second extraction ships only keep.txt — the swap replaces the whole tree,
    // so stale.txt (present in the old dir) must be gone.
    const zip2 = await writeZip([['keep.txt', 0o100644]])
    await extractZipToDirectory(zip2, targetDir)

    expect(await exists(join(targetDir, 'keep.txt'))).toBe(true)
    expect(await exists(join(targetDir, 'stale.txt'))).toBe(false)
  })

  test('a clean swap leaves no .staging-/.previous- siblings behind', async () => {
    const { parentDir, targetDir, writeZip } = await makeExtraction()
    const zipPath = await writeZip([['a.txt', 0o100644]])

    await extractZipToDirectory(zipPath, targetDir)

    const siblings = await readdir(parentDir)
    expect(siblings.filter(n => n.includes('.staging-'))).toEqual([])
    expect(siblings.filter(n => n.includes('.previous-'))).toEqual([])
    expect(siblings).toContain(basename(targetDir))
  })
})
