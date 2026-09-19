/**
 * CC 2.1.276 (ITEM 5) — plugin reload previews must not replace a running
 * session's extracted plugin files.
 *
 * Verifies the port of the official `Urr` (@200401744) preview extraction in
 * `zipCache.ts`:
 *   - `preview: true` extracts to `<targetDir>.preview-<first 32 hex of
 *     sha256(zip bytes)>` and NEVER touches the live cache dir;
 *   - an existing preview dir for identical content is reused as-is
 *     (official `if(await Jue(y))return y` — no re-extraction);
 *   - `preview` omitted/false keeps the existing staging + rename-swap into
 *     the live path (official switch `Grr` @200406306
 *     `if(B)Pe=await Urr(Pe,Me,De);else Ue=await Skt(Pe,Le),Pe=De`);
 *   - a corrupt archive rejects without leaving a preview dir or touching
 *     the live dir (official `catch(O){throw await mH(w),O}`).
 *
 * Documented deviations under test (see zipCache.ts docblocks): OCC has no
 * per-dir seq/archiveHash registry, so reuse keys off the directory existing
 * (same end state for identical content); the official Urr logs nothing and
 * none is added.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { strToU8, zipSync } from 'fflate'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  extractZipToDirectory,
  extractZipToPreviewDirectory,
} from '../zipCache.js'

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
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
  const base = await mkdtemp(join(tmpdir(), 'occ-item5-276-'))
  tempRoots.push(base)
  const targetDir = join(base, 'plugin')
  let seq = 0
  const writeZip = async (
    entries: Array<[string, number]>,
  ): Promise<{ zipPath: string; zipBytes: Buffer }> => {
    const zipBytes = buildZip(entries)
    const zipPath = join(base, `archive-${seq++}.zip`)
    await writeFile(zipPath, zipBytes)
    return { zipPath, zipBytes }
  }
  return { base, parentDir: base, targetDir, writeZip }
}

/** Official preview dir name: `${target}.preview-${sha256(bytes).slice(0,32)}`. */
function expectedPreviewDir(targetDir: string, zipBytes: Buffer): string {
  const hash = createHash('sha256').update(zipBytes).digest('hex')
  return `${targetDir}.preview-${hash.slice(0, 32)}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function readEntries(dir: string): Promise<Record<string, string>> {
  const names = await readdir(dir, { recursive: true })
  const out: Record<string, string> = {}
  for (const name of names) {
    const full = join(dir, String(name))
    const st = await lstat(full)
    if (st.isFile()) {
      out[String(name)] = (await readFile(full)).toString('utf8')
    }
  }
  return out
}

describe('ITEM 5 (2.1.276): preview extraction goes to the content-hashed dir', () => {
  test('preview:true returns <target>.preview-<sha256_32> and leaves the live dir uncreated', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const { zipPath, zipBytes } = await writeZip([['plugin.json', 0o100644]])

    const result = await extractZipToDirectory(zipPath, targetDir, {
      preview: true,
    })

    const previewDir = expectedPreviewDir(targetDir, zipBytes)
    expect(result).toBe(previewDir)
    expect(basename(previewDir)).toMatch(/^plugin\.preview-[0-9a-f]{32}$/)
    expect(await exists(previewDir)).toBe(true)
    expect(await readEntries(previewDir)).toEqual({
      'plugin.json': 'content of plugin.json',
    })
    // The live cache dir was never created — a running session's files are safe.
    expect(await exists(targetDir)).toBe(false)
  })

  test('extractZipToPreviewDirectory matches the dispatch path byte-for-byte', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const { zipPath, zipBytes } = await writeZip([['a.txt', 0o100644]])

    const result = await extractZipToPreviewDirectory(zipPath, targetDir)

    expect(result).toBe(expectedPreviewDir(targetDir, zipBytes))
    expect(await exists(result)).toBe(true)
  })

  test('preview extraction leaves no .staging- siblings behind', async () => {
    const { parentDir, targetDir, writeZip } = await makeExtraction()
    const { zipPath } = await writeZip([['a.txt', 0o100644]])

    await extractZipToDirectory(zipPath, targetDir, { preview: true })

    const siblings = await readdir(parentDir)
    expect(siblings.filter(n => n.includes('.staging-'))).toEqual([])
    expect(siblings.filter(n => n.includes('.previous-'))).toEqual([])
  })
})

describe('ITEM 5 (2.1.276): live cache is untouched by previews', () => {
  test('previewing a DIFFERENT archive leaves the live cache byte-identical', async () => {
    const { targetDir, writeZip } = await makeExtraction()

    // Live cache extracted from zip1 (non-preview, the existing swap path).
    const { zipPath: zip1 } = await writeZip([
      ['keep.txt', 0o100644],
      ['live.txt', 0o100644],
    ])
    const liveResult = await extractZipToDirectory(zip1, targetDir)
    expect(liveResult).toBe(targetDir)
    const liveBefore = await readEntries(targetDir)

    // A reload preview of zip2 (different content) must not disturb it.
    const { zipPath: zip2, zipBytes: zip2Bytes } = await writeZip([
      ['keep.txt', 0o100644],
      ['updated.txt', 0o100644],
    ])
    const previewResult = await extractZipToDirectory(zip2, targetDir, {
      preview: true,
    })

    expect(previewResult).toBe(expectedPreviewDir(targetDir, zip2Bytes))
    expect(previewResult).not.toBe(targetDir)
    // Live dir byte-identical: same files, same contents (live.txt still there,
    // updated.txt NOT leaked in).
    expect(await readEntries(targetDir)).toEqual(liveBefore)
    expect(liveBefore).toEqual({
      'keep.txt': 'content of keep.txt',
      'live.txt': 'content of live.txt',
    })
    // The preview holds the NEW content.
    expect(await readEntries(previewResult)).toEqual({
      'keep.txt': 'content of keep.txt',
      'updated.txt': 'content of updated.txt',
    })
  })

  test('non-preview extraction still swaps into the live path and clears stale files', async () => {
    const { targetDir, writeZip } = await makeExtraction()

    const { zipPath: zip1 } = await writeZip([
      ['keep.txt', 0o100644],
      ['stale.txt', 0o100644],
    ])
    await extractZipToDirectory(zip1, targetDir)

    const { zipPath: zip2 } = await writeZip([['keep.txt', 0o100644]])
    const result = await extractZipToDirectory(zip2, targetDir)

    expect(result).toBe(targetDir)
    expect(await exists(join(targetDir, 'keep.txt'))).toBe(true)
    expect(await exists(join(targetDir, 'stale.txt'))).toBe(false)
  })

  test('preview:false behaves exactly like the omitted option', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const { zipPath } = await writeZip([['a.txt', 0o100644]])

    const result = await extractZipToDirectory(zipPath, targetDir, {
      preview: false,
    })

    expect(result).toBe(targetDir)
    expect(await exists(join(targetDir, 'a.txt'))).toBe(true)
  })
})

describe('ITEM 5 (2.1.276): sha256 suffix is deterministic per zip content', () => {
  test('same bytes → same preview dir, reused WITHOUT re-extraction (official Jue check)', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const { zipPath, zipBytes } = await writeZip([['a.txt', 0o100644]])
    const previewDir = expectedPreviewDir(targetDir, zipBytes)

    const first = await extractZipToPreviewDirectory(zipPath, targetDir)
    expect(first).toBe(previewDir)

    // Delete a file inside the preview dir; the official reuse check returns
    // the existing dir as-is (no re-extraction), so the file must STAY deleted.
    await rm(join(previewDir, 'a.txt'))
    const second = await extractZipToPreviewDirectory(zipPath, targetDir)

    expect(second).toBe(previewDir)
    expect(await exists(join(previewDir, 'a.txt'))).toBe(false)
  })

  test('different bytes → different preview dirs side by side', async () => {
    const { targetDir, writeZip } = await makeExtraction()
    const { zipPath: zipA, zipBytes: bytesA } = await writeZip([
      ['a.txt', 0o100644],
    ])
    const { zipPath: zipB, zipBytes: bytesB } = await writeZip([
      ['b.txt', 0o100644],
    ])

    const previewA = await extractZipToPreviewDirectory(zipA, targetDir)
    const previewB = await extractZipToPreviewDirectory(zipB, targetDir)

    expect(previewA).toBe(expectedPreviewDir(targetDir, bytesA))
    expect(previewB).toBe(expectedPreviewDir(targetDir, bytesB))
    expect(previewA).not.toBe(previewB)
    expect(await exists(previewA)).toBe(true)
    expect(await exists(previewB)).toBe(true)
  })
})

describe('ITEM 5 (2.1.276): corrupt archive failure path', () => {
  test('rejects, leaves no preview dir, and never touches the live dir', async () => {
    const { parentDir, targetDir, writeZip } = await makeExtraction()

    // Live cache from a good archive.
    const { zipPath: goodZip } = await writeZip([['live.txt', 0o100644]])
    await extractZipToDirectory(goodZip, targetDir)
    const liveBefore = await readEntries(targetDir)

    // Corrupt archive (not a zip at all).
    const corruptPath = join(parentDir, 'corrupt.zip')
    await writeFile(corruptPath, Buffer.from('this is not a zip archive'))

    await expect(
      extractZipToDirectory(corruptPath, targetDir, { preview: true }),
    ).rejects.toThrow()

    // No .preview- dir was created for the corrupt bytes, and the live cache
    // is byte-identical.
    const siblings = await readdir(parentDir)
    expect(siblings.filter(n => n.includes('.preview-'))).toEqual([])
    expect(siblings.filter(n => n.includes('.staging-'))).toEqual([])
    expect(await readEntries(targetDir)).toEqual(liveBefore)
  })
})
