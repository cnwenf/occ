import { describe, expect, test } from 'bun:test'
import dataviz from '../dataviz.js'

/**
 * Claude Code 2.1.216 #38: "Updated the bundled dataviz skill: reordered
 * the default chart palette and fixed guidance that suggested direct
 * labels for four-series charts".
 *
 * RECON VERDICT: SKIP (already-absent). OCC ships dataviz as a
 * `/dataviz` slash COMMAND (a prompt in `src/commands/dataviz.ts`), NOT
 * as the official bundled dataviz SKILL (which carries a validated
 * default chart palette in `references/palette.md` and four-series
 * direct-label guidance). OCC's dataviz artifact therefore has:
 *   (a) NO default chart palette to reorder, and
 *   (b) NO guidance suggesting direct labels specifically for
 *       four-series charts (the post-2.1.216 desired state).
 *
 * The equivalent of the official #38 fix is a no-op in OCC: there is no
 * palette array whose order could drift, and the four-series
 * direct-label guidance the official skill removed never existed here.
 * This test characterizes that state so a future port that DOES bundle
 * the official dataviz skill content will surface a regression here
 * rather than silently inheriting a stale palette / bad guidance.
 */

async function getDatavizPrompt(): Promise<string> {
  const blocks = await dataviz.getPromptForCommand('test request', {
    // Minimal context stub — the dataviz prompt builder does not read
    // any context fields; it only interpolates the user request.
  } as never)
  return blocks.map(b => (b as { text: string }).text).join('\n')
}

describe('2.1.216 #38 — dataviz skill content (palette + four-series guidance)', () => {
  test('OCC dataviz has no default chart palette to reorder', async () => {
    const prompt = await getDatavizPrompt()
    // The official skill's #38 change reorders a default chart palette.
    // OCC's dataviz is a prompt command and defines no palette: assert
    // no categorical chart palette (a hex-color sequence) is present.
    expect(prompt).not.toMatch(/default\s+chart\s+palette/i)
    // No ordered list of categorical chart colors (a run of #rrggbb
    // hex codes that would constitute a swappable palette).
    expect(prompt).not.toMatch(/#[0-9a-fA-F]{6}(.*#[0-9a-fA-F]{6}){2,}/s)
  })

  test('OCC dataviz has no four-series direct-label guidance (post-2.1.216 state)', async () => {
    const prompt = await getDatavizPrompt()
    // The official #38 fix removed guidance that suggested direct labels
    // specifically for four-series charts. OCC never had that guidance;
    // assert it is absent now (the desired post-fix state).
    expect(prompt).not.toMatch(/four[- ]series/i)
    // General "direct labels" accessibility guidance IS present and fine
    // (the official skill kept general direct-label advice; it only
    // removed the four-series-specific suggestion). Assert the general
    // accessibility guidance remains.
    expect(prompt).toMatch(/direct label/i)
  })

  test('OCC dataviz remains a prompt command (no skill palette file)', async () => {
    // Characterize the structural divergence from the official skill:
    // OCC dataviz is a builtin prompt command, not a skill with bundled
    // reference files. This is why #38's palette reordering does not
    // apply here.
    expect(dataviz.type).toBe('prompt')
    expect(dataviz.source).toBe('builtin')
  })
})
