import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { PassThrough } from 'stream'
import * as React from 'react'
import type { InputEvent, Key } from '../../ink.js'
import { render } from '../../ink.js'
import { AppStoreContext } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { _clearMatcherCacheForTesting } from '../../utils/permissions/filesystem.js'
import { _clearPhysicalTwinsForTesting } from '../../utils/permissions/symlinkEquivalences.js'
import { usePasteHandler } from '../usePasteHandler.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.311 (ITEM 31): paste image-path validation went per-line.
 *
 * v310 (and OCC's current handler) flattened the whole paste with
 * `text.split(/ (?=\/|[A-Za-z]:\\)/).flatMap(part => part.split('\n'))` and
 * attached EVERY line that looked like an image path — even when it sat next
 * to prose on the same line. Official v311 `M()` (byte-verified @259374500 in
 * the 2.1.311 linux-x64 binary) instead:
 *
 *   for(let I of J.split("\n")){
 *     let V=I.split(Mr).filter((N)=>N.trim());
 *     if(V.length>1 && !V.every((N)=>{let re=N.trim();
 *        return Ir.test(re)||Wr.test(re)&&(!Dr.test(re)||BEo(re))})){
 *       ie.push(I); continue }                    // whole RAW line stays text
 *     for(let N of V)
 *       if(BEo(N)) ie.push(q.length), q.push(N);  // image path
 *       else ie.push(N)                           // raw token stays text
 *   }
 *
 * i.e. a multi-token line only yields image attachments when EVERY token on
 * that line is itself a path shape (quoted `Ir`, or absolute `Wr` without an
 * unescaped space unless it IS an image path `BEo`). Otherwise the entire raw
 * line is preserved as text — per-line granularity, not a whole-paste flatten.
 * Failed/unreadable paths are re-emitted as text via the `ie` reconstruction
 * (`Te` @259376890) instead of being dropped.
 *
 * These tests drive the REAL hook through a REAL ink mount (same discipline
 * as usePasteHandlerDeny291).
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type Recorded = {
  images: Array<{ base64: string; sourcePath?: string }>
  texts: string[]
}

type HandlerBox = {
  current: ((input: string, key: Key, event: InputEvent) => void) | null
}

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeStore(toolPermissionContext: ToolPermissionContext) {
  return {
    getState: () => ({ toolPermissionContext }),
    setState: () => {},
    subscribe: () => () => {},
  } as unknown as React.ContextType<typeof AppStoreContext>
}

function Harness({
  box,
  recorded,
  store,
}: {
  box: HandlerBox
  recorded: Recorded
  store: React.ContextType<typeof AppStoreContext>
}) {
  const { wrappedOnInput } = usePasteHandler({
    onPaste: text => {
      recorded.texts.push(text)
    },
    onInput: () => {},
    onImagePaste: (base64, _mediaType, _filename, _dimensions, sourcePath) => {
      recorded.images.push({ base64, sourcePath })
    },
  })
  box.current = wrappedOnInput
  return null
}

async function drivePaste(pastedText: string): Promise<Recorded> {
  const recorded: Recorded = { images: [], texts: [] }
  const box: HandlerBox = { current: null }
  const store = makeStore(makePermissionContext())
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  stdout.on('data', () => {})
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  if (typeof stdin.ref !== 'function') stdin.ref = () => {}
  if (typeof stdin.unref !== 'function') stdin.unref = () => {}

  const harness = <Harness box={box} recorded={recorded} store={store} />
  const instance = await render(
    <AppStoreContext.Provider value={store}>{harness}</AppStoreContext.Provider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
  )

  try {
    expect(box.current).not.toBeNull()
    box.current?.(
      pastedText,
      { name: undefined, sequence: pastedText } as unknown as Key,
      { keypress: { isPasted: true } } as unknown as InputEvent,
    )
    // The handler defers through a 100ms paste-completion timer, then a
    // Promise.all over the guarded reads.
    await new Promise(resolve => setTimeout(resolve, 400))
  } finally {
    instance.unmount()
  }
  return recorded
}

let farm: string
let imgA: string
let imgB: string
let missing: string

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-pastehandler311-'))
  const farmReal = realpathSync(farm)
  const dir = join(farmReal, 'imgs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.png'), Buffer.from(PNG_BASE64, 'base64'))
  writeFileSync(join(dir, 'b.png'), Buffer.from(PNG_BASE64, 'base64'))
  imgA = join(dir, 'a.png')
  imgB = join(dir, 'b.png')
  missing = join(dir, 'missing.png')
})

afterAll(() => {
  rmSync(farm, { recursive: true, force: true })
})

describe('CC 2.1.311 ITEM 31 — per-line image-path paste validation', () => {
  test('multi-line paste where every line is an existing image path attaches all images', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    const recorded = await drivePaste(`${imgA}\n${imgB}`)

    expect(recorded.images.map(image => image.sourcePath)).toEqual([imgA, imgB])
    expect(recorded.texts).toEqual([])
  })

  test('a line with a non-path token stays text (no image extracted from it)', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    // v310 flatten-split attached imgA here and pasted the leftover "! open"
    // fragment. v311: the line has >1 token and "! open" is not a path shape,
    // so the WHOLE raw line stays text.
    const line = `! open ${imgA}`
    const recorded = await drivePaste(line)

    expect(recorded.images).toEqual([])
    expect(recorded.texts).toEqual([line])
  })

  test('per-line granularity: clean image line attaches, prose line stays verbatim text', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    // v310 attached BOTH images (flattening line 2's tokens). v311 attaches
    // only imgA; line 2 fails per-line qualification and is re-emitted raw.
    const proseLine = `/review look at ${imgB}`
    const recorded = await drivePaste(`${imgA}\n${proseLine}`)

    expect(recorded.images.map(image => image.sourcePath)).toEqual([imgA])
    expect(recorded.texts).toEqual([proseLine])
  })

  test('space-separated image paths on one line all attach', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    const recorded = await drivePaste(`${imgA} ${imgB}`)

    expect(recorded.images.map(image => image.sourcePath)).toEqual([imgA, imgB])
    expect(recorded.texts).toEqual([])
  })

  test('a missing image path is kept as text while the existing one attaches', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    // v310 dropped the unreadable path entirely (nonImageLines filtered by
    // isImageFilePath, and the read returned null). v311's reconstruction
    // re-emits failed paths as text.
    const recorded = await drivePaste(`${missing}\n${imgA}`)

    expect(recorded.images.map(image => image.sourcePath)).toEqual([imgA])
    expect(recorded.texts).toEqual([missing])
  })

  test('plain multi-line text pastes through untouched', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()

    const text = 'hello world\nsecond line of prose'
    const recorded = await drivePaste(text)

    expect(recorded.images).toEqual([])
    expect(recorded.texts).toEqual([text])
  })
})
