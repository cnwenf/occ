/**
 * occ162-01 — official 2.1.302 vim-indicator gate (byte-verified).
 *
 * Official binary evidence (linux-x64 ELF of
 * `@anthropic-ai/claude-code-linux-x64@2.1.302`, md5
 * 39885c1377a0f0d922b73bf8653a6c3f):
 *
 *   `grep -aboF '!=="NORMAL"'` @267020535 — footer-left renderer:
 *     `let Pr=ve!==void 0&&!_e&&ve!=="NORMAL"&&!Et`
 *     ``rr=eo===void 0?void 0:eo-(Pr?ie(`-- ${ve} --`)+1:0)-(Et?Or+1:0)``
 *     `ns=Pr?e(s,{flexShrink:0,children:r(n,{dimColor:!0,
 *          children:["-- ",ve," --"]})},"vim-indicator"):null`
 *
 *   @267046486 — the footer parent reads the setting with a false default:
 *     `const gr=er?.hideVimModeIndicator??!1`, passed down as the prop
 *     `hideVimModeIndicator:gr` (er = the statusLine settings object).
 *
 * Semantics: the pill renders for EVERY non-NORMAL vim mode (INSERT *and*
 * VISUAL / VISUAL LINE), suppressed by `_e` = statusLine.hideVimModeIndicator
 * OR by `Et` = active history search (ctrl-r). `ve!==void 0` IS the
 * vim-enabled check — OCC mirrors it: PromptInput passes
 * `isVimModeEnabled() ? vimMode : undefined` (PromptInput.tsx:2599).
 *
 * Pre-fix OCC gate was `isVimModeEnabled() && vimMode === "INSERT" &&
 * !isSearching` → INSERT-only, hardcoded `-- INSERT --` text, no
 * hideVimModeIndicator setting (GAP occ162-01, ledger §2A.2 of
 * docs/upstream-version-gap-occ162-2026-10.md).
 */
import { describe, expect, test } from 'bun:test'
import type { VimMode } from 'src/types/textInputTypes.js'
import {
  shouldRenderVimIndicator,
  vimIndicatorText,
} from '../PromptInputFooterLeftSide.js'

const NON_NORMAL_MODES: VimMode[] = ['INSERT', 'VISUAL', 'VISUAL LINE']

describe('official Pr gate — ve!==void 0 (vim disabled → no pill)', () => {
  test('undefined vimMode never renders, regardless of other inputs', () => {
    expect(
      shouldRenderVimIndicator({
        vimMode: undefined,
        hideVimModeIndicator: false,
        isSearching: false,
      }),
    ).toBe(false)
  })
})

describe('official Pr gate — ve!=="NORMAL" (every non-NORMAL mode renders)', () => {
  test('NORMAL renders no pill', () => {
    expect(
      shouldRenderVimIndicator({
        vimMode: 'NORMAL',
        hideVimModeIndicator: false,
        isSearching: false,
      }),
    ).toBe(false)
  })

  test('INSERT, VISUAL and VISUAL LINE all render the pill', () => {
    for (const vimMode of NON_NORMAL_MODES) {
      expect(
        shouldRenderVimIndicator({
          vimMode,
          hideVimModeIndicator: false,
          isSearching: false,
        }),
      ).toBe(true)
    }
  })
})

describe('official Pr gate — !_e (hideVimModeIndicator suppression)', () => {
  test('setting=true suppresses the pill in every non-NORMAL mode', () => {
    for (const vimMode of NON_NORMAL_MODES) {
      expect(
        shouldRenderVimIndicator({
          vimMode,
          hideVimModeIndicator: true,
          isSearching: false,
        }),
      ).toBe(false)
    }
  })

  test('setting=true is a no-op in NORMAL mode (already suppressed)', () => {
    expect(
      shouldRenderVimIndicator({
        vimMode: 'NORMAL',
        hideVimModeIndicator: true,
        isSearching: false,
      }),
    ).toBe(false)
  })
})

describe('official Pr gate — !Et (history-search dual suppression)', () => {
  test('active history search suppresses the pill in every non-NORMAL mode', () => {
    for (const vimMode of NON_NORMAL_MODES) {
      expect(
        shouldRenderVimIndicator({
          vimMode,
          hideVimModeIndicator: false,
          isSearching: true,
        }),
      ).toBe(false)
    }
  })

  test('both suppressors together stay suppressed (AND semantics)', () => {
    expect(
      shouldRenderVimIndicator({
        vimMode: 'INSERT',
        hideVimModeIndicator: true,
        isSearching: true,
      }),
    ).toBe(false)
  })
})

describe('official pill composition — `-- ${ve} --`', () => {
  test('text is the composed template of the ACTIVE mode', () => {
    // Official: children:["-- ",ve," --"] + width term ie(`-- ${ve} --`).
    expect(vimIndicatorText('INSERT')).toBe('-- INSERT --')
    expect(vimIndicatorText('VISUAL')).toBe('-- VISUAL --')
    expect(vimIndicatorText('VISUAL LINE')).toBe('-- VISUAL LINE --')
    // NORMAL is composable but unreachable through the gate.
    expect(vimIndicatorText('NORMAL')).toBe('-- NORMAL --')
  })

  test('both describe-text pill spellings appear verbatim', () => {
    // The official setting describe names exactly these two literals.
    expect(vimIndicatorText('INSERT')).toContain('-- INSERT --')
    expect(vimIndicatorText('VISUAL')).toContain('-- VISUAL --')
  })
})
