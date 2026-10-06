import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * CC 2.1.290 changelog (security) — cluster B1 (paste/drag half).
 *
 * Official v290 handler `T3e` @220574120 (≡ 289 `Kqe` @217756679 plus the
 * guard) wires the permission context into the image read:
 *
 *   Promise.all(K.map((me)=>iLo(me,Oe,(we)=>sgs(we,()=>{
 *     let he=o?.getState().toolPermissionContext;
 *     return he?[he,igs(he)]:[]},(he,xe)=>Jhn(he,xe,"person")))))
 *     .then((me)=>{ let we=me.includes("refused"), ...
 *       xe=me.filter((be)=>be!==null&&be!=="refused");
 *       if(xe.length>0){...} else if(Q&&H&&!we&&he)z();
 *       else p("input_image_drag",we?"read_withheld":"read_failed"),I(Z),B() })
 *
 * i.e. BOTH the live context and the persisted-deny-only view (`igs`) are
 * consulted, a `"refused"` result withholds the image, disables the
 * temp-screenshot clipboard fallback, and reports `read_withheld` (289 only
 * had `read_failed`).
 *
 * These tests drive the REAL hook through a REAL ink mount so the production
 * wiring is load-bearing (same discipline as useMainLoopModelWiring280).
 * Telemetry is asserted through `CLAUDE_CODE_DIAGNOSTICS_FILE` — OCC's
 * PII-free diagnostics sink, the testable stand-in for official `p(event,
 * reason)` (its OTel counter no-ops under NODE_ENV=test).
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

function makePermissionContext(
  opts: { deny?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
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

async function drivePaste(
  pastedText: string,
  store: React.ContextType<typeof AppStoreContext> | null,
): Promise<Recorded> {
  const recorded: Recorded = { images: [], texts: [] }
  const box: HandlerBox = { current: null }
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
    store === null ? (
      harness
    ) : (
      <AppStoreContext.Provider value={store}>{harness}</AppStoreContext.Provider>
    ),
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
    // OCC's ink fork does not resolve `waitUntilExit()` on an explicit
    // unmount (verified: the promise hangs), so unmount is the teardown.
    instance.unmount()
  }
  return recorded
}

function readDiagnostics(): string[] {
  const file = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  if (!file) return []
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
  } catch {
    return []
  }
}

let farm: string
let farmReal: string
let secretDir: string
let openDir: string
let diagnosticsFile: string
let savedDiagnosticsEnv: string | undefined

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-pastehandler291-'))
  farmReal = realpathSync(farm)
  secretDir = join(farmReal, 'secret')
  openDir = join(farmReal, 'open')
  mkdirSync(secretDir, { recursive: true })
  mkdirSync(openDir, { recursive: true })
  writeFileSync(join(secretDir, 'a.png'), Buffer.from(PNG_BASE64, 'base64'))
  writeFileSync(join(openDir, 'b.png'), Buffer.from(PNG_BASE64, 'base64'))
  savedDiagnosticsEnv = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  diagnosticsFile = join(farmReal, 'diagnostics.jsonl')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagnosticsFile
})

afterAll(() => {
  if (savedDiagnosticsEnv === undefined) {
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  } else {
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = savedDiagnosticsEnv
  }
  rmSync(farm, { recursive: true, force: true })
})

describe('CC 2.1.290 B1 — usePasteHandler withholds denied image paths', () => {
  test('denied path → no image attached, text pasted, telemetry read_withheld', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()
    writeFileSync(diagnosticsFile, '')
    const denied = join(secretDir, 'a.png')

    const recorded = await drivePaste(
      denied,
      makeStore(makePermissionContext({ deny: [`Read(/${secretDir}/**)`] })),
    )

    expect(recorded.images).toEqual([])
    expect(recorded.texts).toEqual([denied])
    const lines = readDiagnostics().filter(line =>
      line.includes('input_image_drag'),
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.at(-1)).toContain('read_withheld')
  })

  test('allowed path → image attached, no read_withheld telemetry', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()
    writeFileSync(diagnosticsFile, '')
    const allowed = join(openDir, 'b.png')

    const recorded = await drivePaste(allowed, makeStore(makePermissionContext()))

    expect(recorded.images).toHaveLength(1)
    expect(recorded.images[0]?.sourcePath).toBe(allowed)
    expect(recorded.texts).toEqual([])
    expect(readDiagnostics().some(line => line.includes('read_withheld'))).toBe(
      false,
    )
  })

  test('no app store in context → fail-closed, image withheld', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()
    writeFileSync(diagnosticsFile, '')

    const recorded = await drivePaste(join(openDir, 'b.png'), null)

    expect(recorded.images).toEqual([])
    expect(readDiagnostics().some(line => line.includes('read_withheld'))).toBe(
      true,
    )
  })

  test('mixed paste: denied image withheld, allowed image still attached', async () => {
    _clearMatcherCacheForTesting()
    _clearPhysicalTwinsForTesting()
    writeFileSync(diagnosticsFile, '')
    const denied = join(secretDir, 'a.png')
    const allowed = join(openDir, 'b.png')

    const recorded = await drivePaste(
      `${denied} ${allowed}`,
      makeStore(makePermissionContext({ deny: [`Read(/${secretDir}/**)`] })),
    )

    expect(recorded.images).toHaveLength(1)
    expect(recorded.images[0]?.sourcePath).toBe(allowed)
    // Official: when at least one image survived, no read_failed/read_withheld
    // counter is emitted for the gesture.
    expect(readDiagnostics().some(line => line.includes('input_image_drag'))).toBe(
      false,
    )
  })
})
