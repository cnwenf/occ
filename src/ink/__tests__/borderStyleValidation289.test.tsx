import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import cliBoxes from 'cli-boxes'
import { BaseBox, BaseText, render } from '../../ink.js'
import { CUSTOM_BORDER_STYLES, resolveBorderStyle } from '../render-border.js'

/**
 * CC 2.1.289 changelog #11 — "Fixed a freeze or forced quit at launch when a
 * plugin drew a Box with a border style the terminal does not know."
 *
 * Root cause (v288 official + OCC today): the border-style lookup
 *   `CUSTOM_BORDER_STYLES[style] ?? cliBoxes[style]`
 * returns `undefined` for an unrecognized string, and render-border then reads
 * `box.topLeft` → `TypeError: undefined is not an object` inside the ink render
 * loop → the frame never paints → freeze / forced quit. An incomplete custom
 * style OBJECT does not crash but paints literal "undefined" where corner glyphs
 * are missing.
 *
 * Official v289 fix (byte-verified in /tmp/cc-diff-289/v289/package/claude):
 *   - validating resolver `Dvn` @203025539:
 *       var m=["top","left","right","bottom","topLeft","topRight","bottomLeft","bottomRight"];
 *       var p=(t)=>N(t)&&m.every((r)=>typeof t[r]==="string");
 *       var o={...R.default,...n};                    // cli-boxes ∪ {dashed,quote}
 *       function Dvn(t){let i=typeof t==="string"&&Object.hasOwn(o,t)?o[t]:t;return p(i)?i:void 0}
 *     where `N` (chunk-q75vj0vh @200117203) = (e)=>typeof e==="object"&&e!==null&&!Array.isArray(e)
 *   - render caller `eC` @213691631:
 *       let g=Dvn(f.style.borderStyle);if(g!==void 0){...draw border...}
 *     → unknown/invalid style draws NO border and never throws.
 *
 * These e2e cases render through the real ink pipeline (NODE_ENV=test drives the
 * synchronous onImmediateRender path, reconciler.ts:300-308) so a render-time
 * throw surfaces synchronously and is captured here.
 *
 * ORDERING NOTE: pre-fix, the unknown-STRING case throws during React's commit
 * phase, which corrupts the shared reconciler and blanks every later render in
 * the same process. It is therefore placed in the LAST test so the regression
 * guards above it render cleanly and produce unambiguous RED evidence.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const CONTENT = 'hello'

/**
 * Style-agnostic border detector: strip the known content, then trim. A drawn
 * border leaves non-whitespace remnants (box glyphs, arrows, or ASCII `+ - |`);
 * a skipped border leaves only content + padding whitespace.
 */
function borderRemnants(frame: string): string {
  return frame.split(CONTENT).join('').trim()
}

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  while (mounted.length > 0) {
    const m = mounted.pop()
    try {
      m?.unmount()
    } catch {
      // already unmounted
    }
  }
})

/**
 * Render `node` offscreen into a PassThrough and return the stripped frame plus
 * any error thrown during the (synchronous, in test-env) first render.
 */
async function renderToFrame(node: React.ReactNode): Promise<{
  frame: string
  error: unknown
}> {
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

  let error: unknown = null
  try {
    const instance = await render(node, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    })
    mounted.push(instance)
    await delay(30)
  } catch (thrown) {
    error = thrown
  }
  return { frame: stripAnsi(chunks.join('')), error }
}

function helloBox(borderStyle: unknown) {
  return (
    <BaseBox borderStyle={borderStyle as never}>
      <BaseText>{CONTENT}</BaseText>
    </BaseBox>
  )
}

describe('CC 2.1.289 #11: resolveBorderStyle — official `Dvn`/`p`/`N` semantics (unit)', () => {
  test('a known cli-boxes string resolves to its style object', () => {
    expect(resolveBorderStyle('single')).toEqual(cliBoxes.single)
    expect(resolveBorderStyle('single')?.topLeft).toBe('┌')
  })

  test('the custom "dashed" string resolves', () => {
    expect(resolveBorderStyle('dashed')).toEqual(CUSTOM_BORDER_STYLES.dashed)
  })

  test('the custom "quote" string resolves (official parity, byte-recovered)', () => {
    // Official v289 `n` includes quote:{...left:"▎"...} (@203025405).
    expect(resolveBorderStyle('quote')).toEqual(CUSTOM_BORDER_STYLES.quote)
    expect(resolveBorderStyle('quote')?.left).toBe('▎')
  })

  test('an unknown string resolves to undefined (never throws)', () => {
    expect(resolveBorderStyle('totally-unknown-style')).toBeUndefined()
    expect(resolveBorderStyle('')).toBeUndefined()
    expect(resolveBorderStyle('SINGLE')).toBeUndefined() // case-sensitive, like Object.hasOwn
  })

  test('nullish / primitive / array inputs resolve to undefined', () => {
    expect(resolveBorderStyle(undefined)).toBeUndefined()
    expect(resolveBorderStyle(null)).toBeUndefined()
    expect(resolveBorderStyle(42)).toBeUndefined()
    // Official `N` excludes arrays: `!Array.isArray(e)`.
    expect(
      resolveBorderStyle([
        'top',
        'left',
        'right',
        'bottom',
        'topLeft',
        'topRight',
        'bottomLeft',
        'bottomRight',
      ]),
    ).toBeUndefined()
  })

  test('a complete custom style OBJECT passes through unchanged', () => {
    const custom = {
      top: '*',
      left: '|',
      right: '|',
      bottom: '-',
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
    }
    expect(resolveBorderStyle(custom)).toBe(custom)
  })

  test('an incomplete style OBJECT fails the `p` shape check → undefined', () => {
    // Missing the four corner keys.
    expect(
      resolveBorderStyle({ top: '=', left: '|', right: '|', bottom: '-' }),
    ).toBeUndefined()
    // Empty object.
    expect(resolveBorderStyle({})).toBeUndefined()
  })

  test('a style OBJECT with a non-string glyph fails `p` → undefined', () => {
    expect(
      resolveBorderStyle({
        top: '*',
        left: '|',
        right: '|',
        bottom: '-',
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: 123, // not a string
      }),
    ).toBeUndefined()
  })
})

describe('CC 2.1.289 #11: known styles + complete custom objects still draw (regression)', () => {
  const KNOWN_STYLES = [
    'single',
    'double',
    'round',
    'bold',
    'classic',
    'arrow',
    'dashed',
  ] as const

  for (const style of KNOWN_STYLES) {
    test(`known borderStyle "${style}" draws a border`, async () => {
      const { frame, error } = await renderToFrame(helloBox(style))

      expect(error).toBeNull()
      expect(frame).toContain(CONTENT)
      // A recognized style paints a border (remnants survive content-stripping).
      expect(borderRemnants(frame)).not.toBe('')
    })
  }

  test('a complete custom borderStyle OBJECT passes through and draws', async () => {
    const custom = {
      top: '*',
      left: '|',
      right: '|',
      bottom: '-',
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
    }
    const { frame, error } = await renderToFrame(helloBox(custom))

    expect(error).toBeNull()
    expect(frame).toContain(CONTENT)
    // The custom glyphs are drawn verbatim.
    expect(frame).toContain('+')
    expect(frame).toContain('*')
    expect(borderRemnants(frame)).not.toBe('')
  })
})

describe('CC 2.1.289 #11: invalid borderStyle draws NO border and never crashes', () => {
  // Runs before the throwing case: an incomplete object does NOT crash pre-fix
  // (it paints literal "undefined" garbage), so it does not corrupt the reconciler.
  test('an incomplete custom borderStyle OBJECT is rejected (no border, no "undefined" garbage)', async () => {
    // Missing required corner keys → official `p(i)` shape check fails.
    const partial = { top: '=', left: '|', right: '|', bottom: '-' }
    const { frame, error } = await renderToFrame(helloBox(partial))

    expect(error).toBeNull()
    expect(frame).toContain(CONTENT)
    // Pre-fix the missing corners coerce to the literal string "undefined" and the
    // '=' top edge is painted; post-fix the whole border is skipped.
    expect(frame).not.toContain('undefined')
    expect(borderRemnants(frame)).toBe('')
  })

  // LAST: pre-fix this throws `TypeError: undefined is not an object
  // (evaluating 'box.topLeft')` during commit, corrupting later renders.
  test('an unknown borderStyle STRING draws content with NO border and does not throw', async () => {
    const { frame, error } = await renderToFrame(
      helloBox('totally-unknown-style'),
    )

    expect(error).toBeNull()
    // Content still paints (the box is drawn with no border — official `if(g!==void 0)` skip).
    expect(frame).toContain(CONTENT)
    // No border was emitted for the unrecognized style.
    expect(borderRemnants(frame)).toBe('')
  })
})
