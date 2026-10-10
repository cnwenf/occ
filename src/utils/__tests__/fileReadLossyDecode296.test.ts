import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isLossyUtf8Decode, readFileSyncWithMetadata } from '../fileRead.js'

/**
 * CC 2.1.296 changelog #032 (P0): "Fixed Edit and NotebookEdit replacing
 * every non-ASCII character in files that are not valid UTF-8
 * (Windows-1252, Shift-JIS, GBK); such edits are now refused"
 *
 * Layer 1 of the port — the encoding/validity leaf (fileRead.ts).
 *
 * Binary evidence (official ELF v296, never executed; strings + mmap.find):
 * - Encoding module `chunk-yngqe5v3` @208689628, export list @208693021:
 *   `export{uPe,UIs,fRr,l9,z1,TGn,IAo,twe,OAo,AGn,MAo,qF,E_,nwe}`.
 *   `TGn(bytes)` = BOM sniff (FF FE → utf16le, EF BB BF/default → utf8) —
 *   OCC mirror: detectEncodingForResolvedPath (already aligned).
 *   `AGn` = CRLF/LF detect — OCC mirror: detectLineEndingsForString.
 * - NEW in v296 (v295: zero `lossyDecode` hits): `IAo(n,e)=e==="utf8"&&!d(n)`
 *   where `d` = `isUtf8` from node:buffer — the validity check fires ONLY
 *   for utf8-decoded bytes; utf16le (BOM-detected) content is never lossy.
 *   Async reader `nwe` returns
 *   `{content:o.replaceAll("\r\n","\n"),encoding:s,lineEndings:c,
 *     ...IAo(i,s)&&{lossyDecode:!0}}` — a single byte read decoded once,
 *   with the lossy flag conditionally spread in.
 * - NUL and C0 control bytes ARE valid UTF-8 (isUtf8 true) — binary files
 *   made only of those are not flagged; the flag tracks decode lossiness,
 *   not "binary-ness".
 */

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-lossy-296-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Fixture byte sets (verified with node:buffer isUtf8 semantics).
const CP1252_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9]) // "café" in Windows-1252
const SHIFT_JIS_KA = Buffer.from([0x82, 0xa9]) // "か" in Shift-JIS
const GBK_ZHONG = Buffer.from([0xd6, 0xd0]) // "中" in GBK
const TRUNCATED_2BYTE = Buffer.from([0xc3]) // dangling 2-byte lead
const UTF16LE_BOM_A = Buffer.from([0xff, 0xfe, 0x41, 0x00]) // BOM + "A"
const UTF8_ZHONG = Buffer.from([0xe4, 0xb8, 0xad]) // "中" in UTF-8

describe('CC 2.1.296 #032 isLossyUtf8Decode (official IAo)', () => {
  test('valid UTF-8 (ASCII + CJK) is never lossy', () => {
    // Arrange / Act / Assert
    expect(isLossyUtf8Decode(Buffer.from('hello', 'utf8'), 'utf8')).toBe(false)
    expect(isLossyUtf8Decode(UTF8_ZHONG, 'utf8')).toBe(false)
  })

  test('legacy-encoding bytes decoded as utf8 are lossy', () => {
    expect(isLossyUtf8Decode(CP1252_CAFE, 'utf8')).toBe(true)
    expect(isLossyUtf8Decode(SHIFT_JIS_KA, 'utf8')).toBe(true)
    expect(isLossyUtf8Decode(GBK_ZHONG, 'utf8')).toBe(true)
    expect(isLossyUtf8Decode(TRUNCATED_2BYTE, 'utf8')).toBe(true)
  })

  test('utf16le-decoded bytes are never lossy (official `e==="utf8"&&` gate)', () => {
    // The same bytes flagged under utf8 must pass under utf16le — the
    // validity check is encoding-conditional, mirroring IAo exactly.
    expect(isLossyUtf8Decode(UTF16LE_BOM_A, 'utf16le')).toBe(false)
    expect(isLossyUtf8Decode(CP1252_CAFE, 'utf16le')).toBe(false)
  })

  test('empty buffer is not lossy', () => {
    expect(isLossyUtf8Decode(Buffer.alloc(0), 'utf8')).toBe(false)
  })

  test('NUL / C0 control bytes are valid UTF-8 — not lossy (flag tracks decode loss, not binary-ness)', () => {
    expect(isLossyUtf8Decode(Buffer.from([0x00, 0x01, 0x1f]), 'utf8')).toBe(
      false,
    )
  })
})

describe('CC 2.1.296 #032 readFileSyncWithMetadata.lossyDecode (official nwe)', () => {
  test('Windows-1252 file on disk → lossyDecode true, utf8 decode shows U+FFFD', async () => {
    // Arrange
    const filePath = join(tmpDir, 'cafe-cp1252.txt')
    await writeFile(filePath, CP1252_CAFE)

    // Act
    const meta = readFileSyncWithMetadata(filePath)

    // Assert — the decoded content holds exactly the replacement char the
    // refusal messages warn about; a whole-file UTF-8 save would persist it.
    expect(meta.encoding).toBe('utf8')
    expect(meta.lossyDecode).toBe(true)
    expect(meta.content).toBe('caf�')
  })

  test('Shift-JIS and GBK files → lossyDecode true', async () => {
    // Arrange
    const sjis = join(tmpDir, 'ka-sjis.txt')
    const gbk = join(tmpDir, 'zhong-gbk.txt')
    await writeFile(sjis, SHIFT_JIS_KA)
    await writeFile(gbk, GBK_ZHONG)

    // Act / Assert
    expect(readFileSyncWithMetadata(sjis).lossyDecode).toBe(true)
    expect(readFileSyncWithMetadata(gbk).lossyDecode).toBe(true)
  })

  test('valid UTF-8 file (CJK) → lossyDecode false, content intact', async () => {
    // Arrange
    const filePath = join(tmpDir, 'zhong-utf8.txt')
    await writeFile(filePath, UTF8_ZHONG)

    // Act
    const meta = readFileSyncWithMetadata(filePath)

    // Assert
    expect(meta.lossyDecode).toBe(false)
    expect(meta.content).toBe('中')
  })

  test('UTF-16LE BOM file → encoding utf16le, lossyDecode false', async () => {
    // Arrange
    const filePath = join(tmpDir, 'a-utf16le.txt')
    await writeFile(filePath, UTF16LE_BOM_A)

    // Act
    const meta = readFileSyncWithMetadata(filePath)

    // Assert — BOM sniff (TGn mirror) picks utf16le, so IAo's encoding gate
    // keeps the flag off even though the bytes are invalid utf8.
    expect(meta.encoding).toBe('utf16le')
    expect(meta.lossyDecode).toBe(false)
  })

  test('empty file → lossyDecode false', async () => {
    // Arrange
    const filePath = join(tmpDir, 'empty.txt')
    await writeFile(filePath, Buffer.alloc(0))

    // Act / Assert
    expect(readFileSyncWithMetadata(filePath).lossyDecode).toBe(false)
  })

  test('CRLF UTF-8 file → lineEndings CRLF preserved, lossyDecode false (occ153-F4 regression pin)', async () => {
    // Arrange — the lossy flag must not disturb the 2.1.295-era CRLF
    // round-trip fix: content stays \n-normalized, lineEndings stays CRLF.
    const filePath = join(tmpDir, 'crlf.txt')
    await writeFile(filePath, 'line one\r\nline two\r\n')

    // Act
    const meta = readFileSyncWithMetadata(filePath)

    // Assert
    expect(meta.lineEndings).toBe('CRLF')
    expect(meta.content).toBe('line one\nline two\n')
    expect(meta.lossyDecode).toBe(false)
  })
})
