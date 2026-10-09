import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { PassThrough } from 'stream'
import * as React from 'react'
import { Ansi, render } from '../../ink.js'

/**
 * CC 2.1.295 — bold drawn directly after dim must keep BOTH attributes.
 *
 * Official evidence (v294 `XGe` / v295 `wqe` styled-text emitter, identical
 * across versions): `if(i.bold)e=ge.bold(e); if(i.dim)e=ge.dim(e)` — bold and
 * dim COEXIST (bold first, dim outermost); the official SGR parser maps 1→bold
 * and 2→dim independently and 22→clears both ('sgr identical: True' across
 * v294/v295). OCC's StyledText previously treated them as mutually exclusive
 * and DROPPED bold whenever dim was set, so in piped output bold text
 * directly following dim text rendered faint.
 *
 * Painter path: render-node-to-output → applyTextStyles (chalk) — so the
 * frame assertions need chalk.level ≥ 1; level 3 is pinned here (same pattern
 * as thinkingPointerInactive287.test.tsx / tabsNoColorCursor281.test.tsx).
 */

const ESC = '\x1b'
const SYNC_ON = `${ESC}[?2026h`
const SYNC_OFF = `${ESC}[?2026l`

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const mounted: Array<{ unmount: () => void }> = []

afterEach(async () => {
  for (const instance of mounted.splice(0)) {
    instance.unmount()
    await delay(10)
  }
})

let originalLevel: typeof chalk.level
beforeAll(() => {
  originalLevel = chalk.level
  chalk.level = 3
})
afterAll(() => {
  chalk.level = originalLevel
})

/** captureFrame harness — same shape as textNormalization289Frames.test.tsx. */
async function captureFrame(node: React.ReactNode): Promise<string> {
  const chunks: string[] = []
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    chunks.push(chunk.toString())
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  mounted.push(instance)
  await delay(60)
  return chunks
    .join('')
    .split(SYNC_ON)
    .join('')
    .split(SYNC_OFF)
    .join('')
}

describe('CC 2.1.295 — Ansi bold+dim coexistence (official wqe emitter)', () => {
  test('bold directly after dim carries BOTH attributes in the frame', async () => {
    // SGR 2 (dim) then SGR 1 (bold added, dim retained — official parser is
    // cumulative) then reset.
    const frame = await captureFrame(
      <Ansi>{`${ESC}[2mdim${ESC}[1mboldboth${ESC}[0m`}</Ansi>,
    )
    const boldIdx = frame.indexOf('boldboth')
    expect(boldIdx).toBeGreaterThanOrEqual(0)
    const prefix = frame.slice(0, boldIdx)
    expect(prefix).toContain(`${ESC}[1m`)
    expect(prefix).toContain(`${ESC}[2m`)
  })

  test('dim-only span keeps exactly dim', async () => {
    const frame = await captureFrame(<Ansi>{`${ESC}[2monlydim${ESC}[0m`}</Ansi>)
    const idx = frame.indexOf('onlydim')
    expect(idx).toBeGreaterThanOrEqual(0)
    const prefix = frame.slice(0, idx)
    expect(prefix).toContain(`${ESC}[2m`)
    expect(prefix).not.toContain(`${ESC}[1m`)
  })

  test('bold-only span keeps exactly bold', async () => {
    const frame = await captureFrame(<Ansi>{`${ESC}[1monlybold${ESC}[0m`}</Ansi>)
    const idx = frame.indexOf('onlybold')
    expect(idx).toBeGreaterThanOrEqual(0)
    const prefix = frame.slice(0, idx)
    expect(prefix).toContain(`${ESC}[1m`)
    expect(prefix).not.toContain(`${ESC}[2m`)
  })

  test('SGR 22 after bold+dim clears both', async () => {
    const frame = await captureFrame(
      <Ansi>{`${ESC}[2m${ESC}[1mboth${ESC}[22mplain`}</Ansi>,
    )
    const idx = frame.indexOf('plain')
    expect(idx).toBeGreaterThanOrEqual(0)
    // Between 'both' and 'plain' the frame must reset bold AND dim
    // (chalk emits \x1b[22m for each close — both closes present).
    const between = frame.slice(frame.indexOf('both') + 'both'.length, idx)
    // SGR 22 clears BOTH bold and dim in a single code (official sgr table:
    // 22 → normal intensity, clears 1 and 2) — the painter may coalesce the
    // two chalk closes into one \x1b[22m.
    expect(between).toContain(`${ESC}[22m`)
  })
})
