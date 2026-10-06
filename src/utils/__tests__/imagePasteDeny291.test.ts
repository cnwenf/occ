import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.290 changelog (security) — cluster B1 (paste/drag half):
 *   "Fixed Read deny rules not applying to image paths pasted or dragged into
 *    the prompt"
 *
 * Official v290 `iLo` @216794877 (≡ 289 `tAo` @214030139 plus the guard):
 * the reader callback became a parameter, and its result gained the
 * `"refused"` / `"absent"` sentinels:
 *
 *   async function iLo(e,o,r){ ... i = await r(s) ...
 *     if(i==="refused")return"refused";
 *     if(!i||i==="absent")return null;
 *     if(i.length===0) ... }
 *
 * so a denied paste propagates `"refused"` up to the handler (which withholds
 * the image and reports `read_withheld`) and never reaches the decoder.
 * OCC port: `tryReadImageFromPath(text, readPastedFile)` — the reader is
 * REQUIRED, so an unguarded call site is a type error.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

const { tryReadImageFromPath } = await import('../imagePaste.js')

let farm: string
let imagePath: string

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-imagepaste291-'))
  const farmReal = realpathSync(farm)
  imagePath = join(farmReal, 'pic.png')
})

afterAll(() => {
  rmSync(farm, { recursive: true, force: true })
})

describe('CC 2.1.290 B1 — tryReadImageFromPath honours the guarded reader', () => {
  test('"refused" from the guard propagates as the refused sentinel', async () => {
    const result = await tryReadImageFromPath(imagePath, async () => 'refused')

    expect(result).toBe('refused')
  })

  test('"absent" from the guard yields null (no image, no refusal)', async () => {
    const result = await tryReadImageFromPath(imagePath, async () => 'absent')

    expect(result).toBeNull()
  })

  test('undefined from the guard yields null', async () => {
    const result = await tryReadImageFromPath(imagePath, async () => undefined)

    expect(result).toBeNull()
  })

  test('a throwing guard yields null (existing catch arm preserved)', async () => {
    const result = await tryReadImageFromPath(imagePath, async () => {
      throw new Error('EACCES')
    })

    expect(result).toBeNull()
  })

  test('an empty buffer yields null', async () => {
    const result = await tryReadImageFromPath(
      imagePath,
      async () => Buffer.alloc(0),
    )

    expect(result).toBeNull()
  })

  test('bytes from the guard are decoded into the image attachment', async () => {
    const result = await tryReadImageFromPath(imagePath, async () => PNG_BYTES)

    expect(result).not.toBeNull()
    expect(result).not.toBe('refused')
    if (result !== null && result !== 'refused') {
      expect(result.path).toBe(imagePath)
      expect(result.mediaType).toBe('image/png')
      expect(result.base64.length).toBeGreaterThan(0)
      expect(result.dimensions).toBeDefined()
    }
  })

  test('the guard receives the cleaned absolute path', async () => {
    const seen: string[] = []

    await tryReadImageFromPath(`"${imagePath}"`, async p => {
      seen.push(p)
      return PNG_BYTES
    })

    expect(seen).toEqual([imagePath])
  })

  test('non-image text never reaches the guard', async () => {
    let called = 0

    const result = await tryReadImageFromPath('just some text', async () => {
      called += 1
      return PNG_BYTES
    })

    expect(result).toBeNull()
    expect(called).toBe(0)
  })
})
