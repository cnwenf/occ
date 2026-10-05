/**
 * OCC-108 self-acceptance — manual-mode footer cycle-hint suppression.
 *
 * Live tmux parity observation (official 2.1.289 linux-x64 ELF vs OCC 2.1.370,
 * same playground, same idle state):
 *
 *   official: `⏸ manual mode on · ? for shortcuts · ← for agents`
 *   OCC:      `⏸ manual mode on (shift+tab to cycle)`
 *
 * Every NON-default mode matches on both sides (`⏵⏵ accept edits on
 * (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`, `⏵⏵ auto
 * mode on (shift+tab to cycle)`) — the divergence is specific to
 * default/manual mode, where the official suppresses the cycle hint.
 *
 * Official binary evidence (workdir/official-strings.txt dump of the
 * 2.1.289 linux-x64 ELF):
 *
 *   @36621715 region — footer-left renderer, non-loading branch:
 *     `Gn=!CQo(An)` where `An=E?.mode` (the active permission mode)
 *     `vs=sr<2&&…` where `sr=(Qo||Gn?1:0)+(rs?1:0)` (primary-item count)
 *     mode chip:
 *       `es=An&&Is?e(s,{flexShrink:0,children:e(Ix,{mode:An,
 *          children:Gn&&vs&&r(n,{dimColor:!0,children:[" ",
 *            e(B,{chord:Nt,action:"cycle",parens:!0,format:{keyCase:"lower"}})]})})},"mode"):null`
 *     → the `(shift+tab to cycle)` child renders ONLY when `Gn` (non-default
 *       mode) AND `vs` (fewer than 2 primary items + width headroom).
 *
 *   `function CQo(e){return e==="default"||e===void 0}` — is-default-mode
 *   predicate; OCC's existing `isDefaultMode()` is byte-equivalent.
 *
 *   Same renderer, shortcuts-hint fallback (official does NOT exclude the
 *   mode chip from the empty-check):
 *     `if(ds.length===0&&!Qr&&!(An&&Is&&Gn)&&!Ir&&is.length===0&&!vr&&N){
 *        if(!wn)ds.push(e(n,{dimColor:!0,children:"? for shortcuts"},"shortcuts-hint"))}`
 *     `ds` is the post-mode-chip parts list — the mode chip (`es`) renders
 *     regardless, so in manual mode the official footer is
 *     `⏸ manual mode on · ? for shortcuts …`. OCC's current gate
 *     `parts.length === 0 && !tasksPart && !modePart` wrongly suppresses
 *     "? for shortcuts" whenever the mode chip is present (i.e. always,
 *     since 2.1.203 shows the chip in default mode too).
 *
 * Previously staged as cosmetic (occ118 §4 item 1, occ139 §4 item 4 — "官方
 * 页脚由段过滤器拼装，状态机需逐点反编译才可信"). The gate is now
 * decompiled and byte-verified, so the ambiguity that justified STOP is
 * resolved: `Gn&&!vs`-style width terms stay staged, but the mode-based
 * cycle-hint gate and the shortcuts-hint empty-check are unambiguous.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionMode } from 'src/types/permissions.js'
import {
  shouldRenderModeCycleHint,
  shouldRenderShortcutsHint,
} from '../PromptInputFooterLeftSide.js'

describe('official CQo — isDefaultMode equivalence class', () => {
  test('default and undefined are the manual-mode class (hint suppressed)', () => {
    // Official: Gn=!CQo(An); CQo(e){return e==="default"||e===void 0}
    expect(shouldRenderModeCycleHint('default', 0)).toBe(false)
    expect(shouldRenderModeCycleHint(undefined, 0)).toBe(false)
    // Suppressed even with a single primary item and zero other footer content.
    expect(shouldRenderModeCycleHint('default', 1)).toBe(false)
  })

  test('every non-default mode keeps the hint below 2 primary items', () => {
    const nonDefaultModes: PermissionMode[] = [
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
      'dontAsk',
    ]
    for (const mode of nonDefaultModes) {
      expect(shouldRenderModeCycleHint(mode, 0)).toBe(true)
      expect(shouldRenderModeCycleHint(mode, 1)).toBe(true)
    }
  })

  test('hint hides at 2+ primary items regardless of mode (official vs=sr<2&&…)', () => {
    expect(shouldRenderModeCycleHint('acceptEdits', 2)).toBe(false)
    expect(shouldRenderModeCycleHint('plan', 3)).toBe(false)
  })
})

describe('official shortcuts-hint fallback — mode chip does NOT suppress it', () => {
  test('renders when parts/tasks are empty even with the MANUAL mode chip present', () => {
    // Official: `ds.length===0&&!Qr&&!(An&&Is&&Gn)&&…` — ds excludes the mode
    // chip (es), and the `!(An&&Is&&Gn)` term only fires for a NON-DEFAULT
    // mode chip (Gn=!CQo). Manual mode → Gn=false → fallback renders, giving
    // the live-verified official footer `⏸ manual mode on · ? for shortcuts`.
    // With the manual chip present (hasActiveModePart=false) …
    expect(shouldRenderShortcutsHint({ partsCount: 0, hasTasksPart: false, hasActiveModePart: false, showHint: true })).toBe(true)
    // … and with no chip at all — same verdict (the old `!modePart` term is gone).
    expect(shouldRenderShortcutsHint({ partsCount: 0, hasTasksPart: false, hasActiveModePart: false, showHint: true })).toBe(true)
  })

  test('suppressed by a NON-DEFAULT mode chip (official !(An&&Is&&Gn) term)', () => {
    // e.g. acceptEdits/plan/auto: the chip already carries
    // `(shift+tab to cycle)`, so the fallback stays hidden.
    expect(shouldRenderShortcutsHint({ partsCount: 0, hasTasksPart: false, hasActiveModePart: true, showHint: true })).toBe(false)
  })

  test('suppressed by any part, the tasks pill, or showHint=false', () => {
    expect(shouldRenderShortcutsHint({ partsCount: 1, hasTasksPart: false, hasActiveModePart: false, showHint: true })).toBe(false)
    expect(shouldRenderShortcutsHint({ partsCount: 0, hasTasksPart: true, hasActiveModePart: false, showHint: true })).toBe(false)
    expect(shouldRenderShortcutsHint({ partsCount: 0, hasTasksPart: false, hasActiveModePart: false, showHint: false })).toBe(false)
  })
})
