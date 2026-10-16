import { describe, expect, test } from 'bun:test'
import { BINARY_EXTENSIONS } from '../../../constants/files.js'
import { FileReadTool } from '../FileReadTool.js'

// CC 2.1.301 (occ160 WP-F): "Fixed the Read tool reading binary files such as
// .xlsm, .parquet, .epub and .heic as text." The official 2.1.301 ELF expands
// the Read-tool binary-extension Set from 94 → 121 entries
// (`var be=new Set([...])` @224955508; 2.1.300 counterpart @224062630). The
// consuming gate is unchanged in shape — `if(YPe(H)&&!dJe(H))` → refusal
// (@229305959 region) — and the refusal message literal is byte-identical
// between 2.1.300 and 2.1.301, so OCC keeps its 291-era wording (errorCode 4).
// .heic/.heif/.avif land on the REFUSAL side: the official native-image
// whitelist `Wln=new Set(["png","jpg","jpeg","gif","webp"])` + pdf exception
// (@219232101) is identical in both versions.

function contextWithNoRules() {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

const BINARY_MESSAGE = (ext: string) =>
  `This tool cannot read binary files. The file appears to be a binary ${ext} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.`

// The 27 extensions added in official 2.1.301 (byte-exact diff of the two
// Set literals; zero removals).
const ADDED_IN_301 = [
  '.heic',
  '.heif',
  '.avif',
  '.zst',
  '.lz4',
  '.whl',
  '.dmg',
  '.apk',
  '.docm',
  '.dotx',
  '.dotm',
  '.xlsm',
  '.xlsb',
  '.xltx',
  '.xltm',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.potx',
  '.potm',
  '.numbers',
  '.epub',
  '.parquet',
  '.feather',
  '.npy',
  '.npz',
  '.pickle',
]

describe('FileReadTool binary-extension gate (CC 2.1.301 WP-F)', () => {
  test.each([
    ['budget.xlsm', '.xlsm'],
    ['events.parquet', '.parquet'],
    ['book.epub', '.epub'],
    ['photo.heic', '.heic'],
  ])('rejects %s with the official binary refusal message', async (file, ext) => {
    const result = await FileReadTool.validateInput(
      { file_path: file } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(4)
    expect(result.message).toBe(BINARY_MESSAGE(ext))
  })

  test('rejects every extension added in official 2.1.301', async () => {
    for (const ext of ADDED_IN_301) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
      const result = await FileReadTool.validateInput(
        { file_path: `/tmp/sample${ext}` } as never,
        contextWithNoRules(),
      )
      expect(result.result).toBe(false)
      expect(result.errorCode).toBe(4)
      expect(result.message).toBe(BINARY_MESSAGE(ext))
    }
  })

  test('matches the official 2.1.301 Set size (121 entries)', () => {
    expect(BINARY_EXTENSIONS.size).toBe(121)
  })

  test('.heic is refused as binary, not routed to the native image path', async () => {
    // The official native-image whitelist (png/jpg/jpeg/gif/webp) is unchanged
    // in 301 — .heic is in the binary Set but NOT in the whitelist, so the
    // gate refuses it with errorCode 4 rather than rendering it as an image.
    const result = await FileReadTool.validateInput(
      { file_path: 'IMG_0001.heic' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(4)
  })

  test.each(['png', 'jpg', 'gif', 'webp'])(
    'natively supported image extension .%s is unaffected by the gate',
    async (ext) => {
      const result = await FileReadTool.validateInput(
        { file_path: `/tmp/picture.${ext}` } as never,
        contextWithNoRules(),
      )
      expect(result.result).toBe(true)
    },
  )

  test('pdf remains excluded from the binary refusal', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/tmp/report.pdf' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })

  test.each(['md', 'ts'])('text extension .%s is unaffected by the gate', async (ext) => {
    const result = await FileReadTool.validateInput(
      { file_path: `/tmp/notes.${ext}` } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })

  test('uppercase new-in-301 extension is lowercased before the refusal', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/tmp/Macro.XLSM' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.message).toBe(BINARY_MESSAGE('.xlsm'))
  })
})
