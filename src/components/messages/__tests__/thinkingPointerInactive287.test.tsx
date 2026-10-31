/**
 * CC 2.1.287 (#25) — rtt pointer color: v286 "subtle" → v287 "inactive".
 *
 * Official v287 rtt (@~222068923): the non-brief, non-selected pointer
 * renders `color:y?"suggestion":"inactive"` where v286 had `"subtle"`.
 * HighlightedThinkingText's brief-layout branch is unchanged upstream
 * (`_=y?"suggestion":x?"subtle":"text"`) and is NOT touched by the port.
 *
 * Render-seam assertion: with the default (providerless) 'dark' theme, the
 * pointer must carry the theme's `inactive` color rgb(153,153,153) and must
 * NOT carry the old `subtle` color rgb(80,80,80). Both are distinguishable
 * 24-bit SGR sequences with chalk.level forced to 3.
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { HighlightedThinkingText } from '../HighlightedThinkingText.js'
import { renderToAnsiStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'

// Dark theme (ThemeProvider DEFAULT_THEME, used providerless):
const DARK_INACTIVE_SGR = '38;2;153;153;153' // theme.inactive
const DARK_SUBTLE_SGR = '38;2;80;80;80' // theme.subtle (the v286 pointer color)

async function renderPointer(): Promise<string> {
  const originalLevel = chalk.level
  try {
    chalk.level = 3 // truecolor — same pattern as tabsNoColorCursor281.test.tsx
    return await renderToAnsiStringIsolated(
      <HighlightedThinkingText text="ultrathink about this" />,
      80,
    )
  } finally {
    chalk.level = originalLevel
  }
}

describe('2.1.287 #25: rtt non-selected pointer color (subtle → inactive)', () => {
  test('pointer renders with the theme "inactive" color', async () => {
    const out = await renderPointer()
    expect(out).toContain(DARK_INACTIVE_SGR)
  })

  test('pointer no longer renders with the old "subtle" color', async () => {
    const out = await renderPointer()
    // Body color is "text" (not dimmed/queued), so the only possible source
    // of the subtle SGR would be a regressed pointer branch.
    expect(out).not.toContain(DARK_SUBTLE_SGR)
  })

  test('the pointer glyph + text still render, rainbow-pinned (review P2-3)', async () => {
    const out = await renderPointer()
    // CC 2.1.316 (OCC-139): ULTRATHINK is now allowlisted (official ships the
    // ultrathink gate ON - ePt @276986161), so the rtt trigger branch renders
    // "ultrathink" with per-char rainbow SGR codes interleaved.
    //
    // Review P2-3: an ANSI-strip containment check alone passes whether the
    // rainbow is per-char SGR or a collapsed single color run - pin the RAW
    // output shape too. Measured truth for this renderer (chalk.level=3,
    // renderToAnsiStringIsolated): 13 SGR sequences total - pointer
    // 38;2;153;153;153 open, 10 per-char `38;2;r;g;b` opens over
    // [u,l,t,r,a,t,h,i,n,k], body 38;2;255;255;255 open, single trailing
    // ESC[39m reset. Per-char opens are NOT open+close pairs, so the
    // review's >=20 open+close floor does not fit this renderer; its per-char
    // alternative is pinned below (a collapsed single-run render would emit
    // ~3 opens and zero per-char interleaves - both pins would fail).
    //
    // Strip check first: the plain-text content is unchanged.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI-strip - the regex intentionally matches the ESC (\u001b) control character to remove the per-char rainbow SGR codes (same pattern as rawHyperlinkSanitize295).
    const plain = out.replace(/\u001b\[[0-9;]*m/g, '')
    expect(plain).toContain('ultrathink about this')

    // Rainbow pin 1: each of the 10 trigger chars is preceded by its own
    // 24-bit color-open SGR (per-char interleaving - the v2.1.316 shape).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rainbow pin - intentionally matches the ESC (\u001b) control character to assert the per-char SGR interleaving of the ultrathink trigger (review P2-3 regression pin).
    const perChar = out.match(/(?:\u001b\[38;2;\d+;\d+;\d+m[ultrahink]){10}/)
    expect(perChar).not.toBeNull()

    // Rainbow pin 2: >=12 truecolor opens overall (pointer + 10 chars + body).
    // A collapsed single-run render would emit ~3 and fail this floor.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rainbow pin - intentionally matches the ESC (\u001b) control character to count per-char color opens (review P2-3 regression pin).
    const colorOpens = out.match(/\u001b\[38;2;\d+;\d+;\d+m/g) ?? []
    expect(colorOpens.length).toBeGreaterThanOrEqual(12)
  })
})
