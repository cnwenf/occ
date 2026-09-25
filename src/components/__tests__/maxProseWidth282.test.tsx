import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { type AppState, AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { Markdown, StreamingMarkdown } from '../Markdown.js'

/**
 * 2.1.282 PORT: maxProseWidth render-seam clamp.
 *
 * Official binary evidence (v2.1.282 linux-x64):
 * - Ei wrapper @216869295: `const m=o.capProseWidth?i.maxProseWidth:void 0` —
 *   the setting is read ONLY when the caller passes capProseWidth:!0.
 * - Lr renderer @216867926+: prose blocks pushed with
 *   `maxWidth:G==="prose"?k:void 0`; fenced code special-cased
 *   (`if(k!==void 0&&K.type==="code")` → kind "code", NO maxWidth); tables
 *   pushed as kind "block" (NO maxWidth); lists capped (zo `maxWidth:R`);
 *   blockquotes capped (`maxWidth:k`).
 * - Capped call sites: assistant text (za @220213403 `capProseWidth:!0`),
 *   streaming chunks (Ge/nXn @216874918+ `skipTokenCache:!0,capProseWidth:!0`),
 *   thinking (xs @220216483, transcript/verbose branch only).
 *
 * OCC seam: MarkdownBody batches all non-table tokens into one ANSI string.
 * The port keeps that batch (wrapped in <Box maxWidth>) for prose, and splits
 * fenced code tokens out as their own uncapped <Ansi> elements when the cap is
 * active. With the setting unset (default) rendering is byte-identical to the
 * pre-282 behavior — pinned by the equivalence test below.
 */

const COLUMNS = 100
const CAP = 50

// 199 chars of prose → wraps at ~100 uncapped, at ≤50 capped.
const PROSE = `proseword ${'proseword '.repeat(19)}`.trimEnd()
// A 59-char contiguous prose run: impossible on any line when capped at 50,
// present when uncapped at 100.
const PROSE_RUN = 'proseword '.repeat(6).trimEnd()
// 66 visible chars of code — fits in 100 columns (never wraps), exceeds the
// 50-column cap (would wrap if code were wrongly capped).
const CODE_LINE = 'const sentinelCodeLine = "CODEFULLWIDTH_0123456789_0123456789";'
const CONTENT = [
  PROSE,
  '',
  '```js',
  CODE_LINE,
  '```',
  '',
  '| column-one-header | column-two-header | column-three-header |',
  '| ----------------- | ------------------ | ------------------- |',
  '| cell-a-1          | cell-b-1           | cell-c-1            |',
].join('\n')

function stateWith(maxProseWidth?: number): AppState {
  const base = getDefaultAppState()
  if (maxProseWidth === undefined) return base
  return {
    ...base,
    settings: { ...base.settings, maxProseWidth },
  } as AppState
}

function renderMarkdown(
  node: React.ReactNode,
  maxProseWidth?: number,
): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={stateWith(maxProseWidth)}>
      {node}
    </AppStateProvider>,
    COLUMNS,
  )
}

/** Visible width of the widest output line containing `needle`. */
function widestLineWith(out: string, needle: string): number {
  return Math.max(
    0,
    ...out
      .split('\n')
      .filter(line => line.includes(needle))
      .map(line => line.trimEnd().length),
  )
}

describe('2.1.282 maxProseWidth render clamp', () => {
  test('capped: prose wraps at the setting width', async () => {
    const out = await renderMarkdown(
      <Markdown capProseWidth={true}>{CONTENT}</Markdown>,
      CAP,
    )
    expect(out).not.toContain(PROSE_RUN)
    expect(widestLineWith(out, 'proseword')).toBeLessThanOrEqual(CAP)
  })

  test('capped: fenced code keeps the full terminal width', async () => {
    const out = await renderMarkdown(
      <Markdown capProseWidth={true}>{CONTENT}</Markdown>,
      CAP,
    )
    // Official Lr special-cases code tokens → no maxWidth. The 66-char line
    // must survive intact (would be wrapped mid-line if capped at 50).
    expect(out).toContain(CODE_LINE)
  })

  test('capped: tables keep the full terminal width', async () => {
    const out = await renderMarkdown(
      <Markdown capProseWidth={true}>{CONTENT}</Markdown>,
      CAP,
    )
    // Official Lr pushes tables as kind "block" (no maxWidth).
    expect(out).toContain('column-one-header')
    const border = out
      .split('\n')
      .find(line => line.includes('─') || line.includes('+--'))
    expect(border).toBeDefined()
    expect((border ?? '').trimEnd().length).toBeGreaterThan(CAP)
  })

  test('unset (default): prose uses the full terminal width even with capProseWidth', async () => {
    const out = await renderMarkdown(
      <Markdown capProseWidth={true}>{CONTENT}</Markdown>,
      undefined,
    )
    // Unset = full terminal width (100): the 59-char run fits on one line.
    expect(out).toContain(PROSE_RUN)
    expect(widestLineWith(out, 'proseword')).toBeGreaterThan(CAP)
  })

  test('opt-out: without capProseWidth the setting is NOT read (official Ei gate)', async () => {
    const out = await renderMarkdown(<Markdown>{CONTENT}</Markdown>, CAP)
    // `o.capProseWidth?i.maxProseWidth:void 0` — callers that don't opt in
    // render full width regardless of the setting.
    expect(out).toContain(PROSE_RUN)
    expect(widestLineWith(out, 'proseword')).toBeGreaterThan(CAP)
  })

  test('default renders byte-identically to the pre-282 no-prop path', async () => {
    const withProp = await renderMarkdown(
      <Markdown capProseWidth={true}>{CONTENT}</Markdown>,
      undefined,
    )
    const withoutProp = await renderMarkdown(<Markdown>{CONTENT}</Markdown>, undefined)
    expect(withProp).toBe(withoutProp)
  })

  test('streaming path caps prose (official Ge/nXn always pass capProseWidth:!0)', async () => {
    const out = await renderMarkdown(
      <StreamingMarkdown>{`${PROSE}\n`}</StreamingMarkdown>,
      CAP,
    )
    expect(out).not.toContain(PROSE_RUN)
    expect(widestLineWith(out, 'proseword')).toBeLessThanOrEqual(CAP)
  })
})
