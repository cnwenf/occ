/**
 * CC 2.1.288 #3 — recovery for a prompt cleared with Ctrl+C.
 *
 * "Added recovery for a prompt cleared with Ctrl+C: pressing Up on the empty
 * prompt brings the draft back, including pasted text and images."
 *
 * Byte-faithful port of the official v2.1.288 prompt-draft store methods (all
 * offsets into /tmp/cc-diff-288/v288/package/claude, verified with `dd`; the
 * store class is the one that already owns `stash`/`popStash`):
 *
 *   @228665940 —
 *     `holdCleared=()=>{let{value:h,mode:E,pastedContents:N}=this.#i;`
 *     `  if(h.trim()!==""){let H=this.#e.getState().launchWarning;`
 *     `    this.#S={text:h,mode:E,pastedContents:N,launchWarning:H??void 0}}};`
 *     `restoreCleared=()=>{let h=this.#S;`
 *     `  if(h===null||this.#i.value!=="")return!1;`   // EMPTY prompt only
 *     `  if(this.#S=null,                             // single-shot
 *     `     this.#y(h.text,h.text.length,"input"),    // value + cursor at end
 *     `     this.#f({pastedContents:h.pastedContents,mode:h.mode}),`
 *     `     h.launchWarning)VDn(this.#e,h.launchWarning);`
 *     `  return!0};`
 *
 *   `#S` is a SEPARATE slot from the Ctrl+S `stash` slot (`popStash` 5 → 5 hits,
 *   unchanged v287→v288), so hold-cleared and stash never clobber each other.
 *
 * Call sites:
 *   - arm  @228993610 (Ctrl+C branch, BEFORE the clear runs):
 *       `if(Ad.ctrl&&Ad.key==="c"&&(X_===0||eT))N.holdCleared();`
 *     → src/hooks/useTextInput.ts handleCtrlC first-press → PromptInput's
 *       `onHoldCleared`.
 *   - restore @228991419 (TOP of history-up, minified `Iy`):
 *       `if(pg.length>1){return}`                       // suggestions open
 *       `let Xv=N.value.indexOf("\n");`
 *       `if(Xv!==-1&&N.cursorOffset>Xv){return}`        // cursor past line 1
 *       `if(N.restoreCleared()){wn(Py(N.value));return}`// ← NEW: draft first
 *       `… ph()`                                        // real history
 *     → PromptInput.handleHistoryUp, after the `suggestions.length > 1` and
 *       `isCursorOnFirstLine` guards and BEFORE the queued-command branch.
 *     History-DOWN (`_b`) has no `restoreCleared` call — the restore is
 *     Up-only, matching the changelog.
 *
 * OCC divergences (documented — no invented behavior):
 *   - Official's slot also carries `launchWarning` (restored via
 *     `VDn(this.#e, …)`). `launchWarning` has ZERO hits in the OCC source tree
 *     (NO-SURFACE), so the OCC slot holds `{text, mode, pastedContents}` only.
 *   - Official's `restoreCleared` returns a boolean and applies the state
 *     itself (the draft store owns the editor state). OCC's editor state lives
 *     in React, so the OCC `restoreCleared` returns the held draft (or `null`
 *     for the official `!1`) and the caller applies it through
 *     `applyHeldClearedDraft` (below), which drives the React editor sinks in
 *     the official order. The decision logic — refuse unless the slot is
 *     filled AND the prompt is strictly empty, single-shot — is identical.
 *   - The official slot is per prompt-draft-store instance; OCC has one prompt
 *     input, so a module-level singleton (`heldClearedDraft`) is the faithful
 *     equivalent. The factory is exported for isolated unit tests.
 */

import type { PromptInputMode } from '../types/textInputTypes.js'
import type { PastedContent } from './config.js'

/** The held draft — official `{text:h,mode:E,pastedContents:N}` @228665940. */
export type HeldClearedDraft = {
  readonly text: string
  readonly mode: PromptInputMode
  readonly pastedContents: Record<number, PastedContent>
}

/** The draft-editor snapshot `holdCleared` reads — official `this.#i`. */
export type ClearedDraftSource = {
  readonly value: string
  readonly mode: PromptInputMode
  readonly pastedContents: Record<number, PastedContent>
}

export type HeldClearedDraftStore = {
  /** Official `holdCleared` @228665940. */
  holdCleared: (source: ClearedDraftSource) => void
  /**
   * Official `restoreCleared` @228665940 — returns the held draft, or `null`
   * for the official `!1`.
   */
  restoreCleared: (currentValue: string) => HeldClearedDraft | null
  /** Read the slot without consuming it (test/diagnostic affordance). */
  peek: () => HeldClearedDraft | null
  /** Drop the slot without restoring (test/reset affordance). */
  clear: () => void
}

export function createHeldClearedDraftStore(): HeldClearedDraftStore {
  let held: HeldClearedDraft | null = null

  return {
    holdCleared(source: ClearedDraftSource): void {
      // Official: `if(h.trim()!==""){ … this.#S={text:h,mode:E,pastedContents:N} }`
      // — whitespace-only drafts are skipped, and a skipped hold leaves any
      // earlier hold intact.
      if (source.value.trim() !== '') {
        held = Object.freeze({
          text: source.value,
          mode: source.mode,
          pastedContents: source.pastedContents,
        })
      }
    },

    restoreCleared(currentValue: string): HeldClearedDraft | null {
      // Official: `if(h===null||this.#i.value!=="")return!1; this.#S=null; …`
      if (held === null || currentValue !== '') {
        return null
      }
      const restored = held
      held = null
      return restored
    },

    peek(): HeldClearedDraft | null {
      return held
    },

    clear(): void {
      held = null
    },
  }
}

/** The REPL-wide slot — mirrors the official per-store `#S`. */
export const heldClearedDraft: HeldClearedDraftStore =
  createHeldClearedDraftStore()

/**
 * The editor-state sinks `applyHeldClearedDraft` writes through — the OCC
 * analogue of the official store's own `#y` (value + cursor) and `#f`
 * (pastedContents + mode) setters.
 */
export type ClearedDraftSinks = {
  readonly setValue: (value: string) => void
  readonly setCursorOffset: (offset: number) => void
  readonly setPastedContents: (
    pastedContents: Record<number, PastedContent>,
  ) => void
  readonly setMode: (mode: PromptInputMode) => void
}

/**
 * The application half of official `restoreCleared` @228665940:
 *   `this.#y(h.text,h.text.length,"input"),`   // value + cursor at END
 *   `this.#f({pastedContents:h.pastedContents,mode:h.mode})`
 *
 * Order matters and is pinned by the tests: value, then cursor, then
 * pastedContents, then mode. `pastedContents` is handed over wholesale (same
 * object reference) — that is the "including pasted text and images" half of
 * the changelog.
 *
 * The official `h.launchWarning` branch (`VDn(this.#e,h.launchWarning)`) is
 * omitted: `launchWarning` is NO-SURFACE in OCC (zero hits in the tree).
 */
export function applyHeldClearedDraft(
  held: HeldClearedDraft,
  sinks: ClearedDraftSinks,
): void {
  sinks.setValue(held.text)
  sinks.setCursorOffset(held.text.length)
  sinks.setPastedContents(held.pastedContents)
  sinks.setMode(held.mode)
}
