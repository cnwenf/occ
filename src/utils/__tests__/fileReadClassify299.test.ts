/**
 * CC 2.1.299 #126 — encoding classifier + BOM-preservation unit tests.
 *
 * Official evidence (v299 ELF, never executed; grep -aboF + dd):
 *   rae @215108500: BOM sniff on the first 4096 bytes — FF FE → utf16le,
 *     everything else → utf8.
 *   zMo: `n.subarray(0,8000).includes(0)` — NUL scan of the first 8 KB.
 *   Rgt @215109534: `let e=rae(n.subarray(0,f));if(e!=="utf8")return{encoding:e};
 *     if(n.byteLength>=2&&n[0]===254&&n[1]===255)return{encoding:e,notText:"utf16be"};
 *     if(zMo(n))return{encoding:e,notText:"nul"};
 *     return p(n)?{encoding:e}:{encoding:e,notText:"not_utf8"}` (p = isUtf8).
 *   UMr: `function UMr(n,e){return e!==""&&n?.charCodeAt(0)===65279&&
 *     e.charCodeAt(0)!==65279?`\uFEFF${e}`:e}` — BOM preservation on rewrite.
 *   sEe @215110800 (readExisting): decodes with the Rgt encoding, keeps the
 *     BOM in `content`, CRLF→LF, and rides `...s&&{notText:s}` along.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyFileBytes,
  detectEncodingFromBytes,
  preserveBomOnRewrite,
  readFileSyncWithMetadata,
} from '../fileRead.js'

// "café" encoded in GBK/Windows-1252-style invalid UTF-8 (0xE9 trailing byte).
const NOT_UTF8_BYTES = Buffer.from([0x63, 0x61, 0x66, 0xe9])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

describe('CC 2.1.299 #126: detectEncodingFromBytes (official rae)', () => {
  test('empty buffer → utf8', () => {
    expect(detectEncodingFromBytes(Buffer.alloc(0))).toBe('utf8')
  })

  test('FF FE → utf16le', () => {
    expect(detectEncodingFromBytes(UTF16LE_BOM)).toBe('utf16le')
  })

  test('FE FF is NOT utf16le at the sniff level (Rgt flags it utf16be)', () => {
    expect(detectEncodingFromBytes(UTF16BE_BOM)).toBe('utf8')
  })

  test('EF BB BF → utf8', () => {
    expect(detectEncodingFromBytes(UTF8_BOM)).toBe('utf8')
  })
})

describe('CC 2.1.299 #126: classifyFileBytes (official Rgt)', () => {
  test('UTF-16LE + BOM → encoding utf16le, never notText', () => {
    const buffer = Buffer.concat([
      UTF16LE_BOM,
      Buffer.from('hello', 'utf16le'),
    ])
    expect(classifyFileBytes(buffer)).toEqual({ encoding: 'utf16le' })
  })

  test('FE FF head → notText utf16be', () => {
    expect(
      classifyFileBytes(Buffer.concat([UTF16BE_BOM, Buffer.from('hi')])),
    ).toEqual({ encoding: 'utf8', notText: 'utf16be' })
  })

  test('NUL in the first 8000 bytes → notText nul', () => {
    const buffer = Buffer.concat([Buffer.from('a'), Buffer.alloc(1, 0)])
    expect(classifyFileBytes(buffer)).toEqual({
      encoding: 'utf8',
      notText: 'nul',
    })
  })

  test('NUL beyond the 8000-byte scan window → not flagged (official subarray(0,b))', () => {
    // A NUL inside the window fires 'nul'; the SAME buffer with the NUL at
    // offset 8000 (outside subarray(0,8000)) stays clean — NUL is a valid
    // UTF-8 code unit, so isUtf8 passes too.
    const inWindow = Buffer.concat([
      Buffer.alloc(7999, 0x61),
      Buffer.alloc(1, 0),
    ])
    expect(classifyFileBytes(inWindow)).toEqual({
      encoding: 'utf8',
      notText: 'nul',
    })
    const outOfWindow = Buffer.concat([
      Buffer.alloc(8000, 0x61),
      Buffer.alloc(1, 0),
    ])
    expect(classifyFileBytes(outOfWindow)).toEqual({ encoding: 'utf8' })
  })

  test('NUL at exactly offset 8000 escapes the scan (official subarray(0,b))', () => {
    // subarray(0,8000) covers offsets 0..7999; a NUL at 8000 is invisible to
    // zMo, and the rest is valid UTF-8 → NO notText at all.
    const buffer = Buffer.concat([
      Buffer.alloc(8000, 0x61),
      Buffer.alloc(1, 0),
      Buffer.from('b'),
    ])
    // The whole buffer IS valid UTF-8 (NUL is a legal UTF-8 code unit), so
    // isUtf8 passes and the classification is clean.
    expect(classifyFileBytes(buffer)).toEqual({ encoding: 'utf8' })
  })

  test('invalid UTF-8 (legacy encoding) → notText not_utf8', () => {
    expect(classifyFileBytes(NOT_UTF8_BYTES)).toEqual({
      encoding: 'utf8',
      notText: 'not_utf8',
    })
  })

  test('clean UTF-8 (with or without BOM) → no notText', () => {
    expect(classifyFileBytes(Buffer.from('plain text', 'utf8'))).toEqual({
      encoding: 'utf8',
    })
    expect(
      classifyFileBytes(Buffer.concat([UTF8_BOM, Buffer.from('bom text')])),
    ).toEqual({ encoding: 'utf8' })
  })
})

describe('CC 2.1.299 #126: preserveBomOnRewrite (official UMr)', () => {
  test('old BOM + new content without BOM → BOM re-prefixed', () => {
    expect(preserveBomOnRewrite('\uFEFFold', 'new')).toBe('\uFEFFnew')
  })

  test('new content already starts with BOM → unchanged', () => {
    expect(preserveBomOnRewrite('\uFEFFold', '\uFEFFnew')).toBe('\uFEFFnew')
  })

  test('old content without BOM → unchanged', () => {
    expect(preserveBomOnRewrite('old', 'new')).toBe('new')
  })

  test('empty new content → unchanged (official e!=="" guard)', () => {
    expect(preserveBomOnRewrite('\uFEFFold', '')).toBe('')
  })

  test('null/undefined old content (new file) → unchanged', () => {
    expect(preserveBomOnRewrite(null, 'new')).toBe('new')
    expect(preserveBomOnRewrite(undefined, 'new')).toBe('new')
  })
})

describe('CC 2.1.299 #126: readFileSyncWithMetadata notText + encoding', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-fileread-299-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('UTF-16LE+BOM file decodes correctly (was garbled as utf8 before)', () => {
    // Arrange — the #126 Read bug: "Read garbles UTF-16LE+BOM".
    const filePath = join(tmpDir, 'utf16le.txt')
    const bytes = Buffer.concat([
      UTF16LE_BOM,
      Buffer.from('héllo\r\nworld', 'utf16le'),
    ])
    writeFileSync(filePath, bytes)

    // Act
    const meta = readFileSyncWithMetadata(filePath)

    // Assert — decoded via utf16le; the BOM CHAR survives in content (sEe
    // keeps it); CRLF normalized to LF; no notText; not lossy.
    expect(meta.encoding).toBe('utf16le')
    expect(meta.content).toBe('\uFEFFhéllo\nworld')
    expect(meta.lineEndings).toBe('CRLF')
    expect(meta.notText).toBeUndefined()
    expect(meta.lossyDecode).toBe(false)
  })

  test('legacy-encoding file → notText not_utf8 + lossyDecode', async () => {
    const filePath = join(tmpDir, 'gbk.txt')
    await writeFile(filePath, NOT_UTF8_BYTES)

    const meta = readFileSyncWithMetadata(filePath)

    expect(meta.encoding).toBe('utf8')
    expect(meta.notText).toBe('not_utf8')
    expect(meta.lossyDecode).toBe(true)
  })

  test('clean UTF-8 file → no notText', async () => {
    const filePath = join(tmpDir, 'clean.txt')
    await writeFile(filePath, 'just text')

    const meta = readFileSyncWithMetadata(filePath)

    expect(meta.notText).toBeUndefined()
    expect(meta.lossyDecode).toBe(false)
    expect(meta.content).toBe('just text')
  })

  test('UTF-8 BOM file → utf8 encoding, BOM char kept in content', async () => {
    const filePath = join(tmpDir, 'bom.txt')
    await writeFile(filePath, Buffer.concat([UTF8_BOM, Buffer.from('text')]))

    const meta = readFileSyncWithMetadata(filePath)

    expect(meta.encoding).toBe('utf8')
    expect(meta.content).toBe('\uFEFFtext')
    expect(meta.notText).toBeUndefined()
  })
})
