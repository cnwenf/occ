/**
 * CC 2.1.288 #3 — "Added recovery for a prompt cleared with Ctrl+C: pressing Up
 * on the empty prompt brings the draft back, including pasted text and images."
 *
 * Official binary evidence (offsets into /tmp/cc-diff-288/v288/package/claude,
 * verified with dd — the prompt-draft store class that already owns
 * `stash`/`popStash`):
 *
 *   @228665940 —
 *     `holdCleared=()=>{let{value:h,mode:E,pastedContents:N}=this.#i;`
 *     `  if(h.trim()!==""){let H=this.#e.getState().launchWarning;`
 *     `    this.#S={text:h,mode:E,pastedContents:N,launchWarning:H??void 0}}};`
 *     `restoreCleared=()=>{let h=this.#S;`
 *     `  if(h===null||this.#i.value!=="")return!1;`        // EMPTY prompt only
 *     `  if(this.#S=null,                                 // single-shot
 *     `     this.#y(h.text,h.text.length,"input"),        // value + cursor at end
 *     `     this.#f({pastedContents:h.pastedContents,mode:h.mode}),`
 *     `     h.launchWarning)VDn(this.#e,h.launchWarning);`
 *     `  return!0};`
 *
 *   @228993610 — the arming site, the Ctrl+C branch, BEFORE the clear runs:
 *     `if(Ad.ctrl&&Ad.key==="c"&&(X_===0||eT))N.holdCleared();`
 *
 *   @228991419 — the restore site, at the TOP of history-up (minified `Iy`):
 *     `function Iy(){ if(pg.length>1){return}`                        // suggestions open
 *       `let Xv=N.value.indexOf("\n"); if(Xv!==-1&&N.cursorOffset>Xv){return}`  // cursor past line 1
 *       `if(N.restoreCleared()){wn(Py(N.value));return}`              // ← NEW: draft first
 *       `… ph() }`                                                    // fall through to real history
 *
 *   History-DOWN (`_b`, same region) has NO `restoreCleared` call — the restore
 *   is Up-only, matching the changelog.
 *
 * Key facts this suite pins:
 *   - `#S` is a SEPARATE slot from the Ctrl+S `stash` slot (`popStash` 5 → 5
 *     unchanged v287→v288), so hold-cleared and stash never clobber each other.
 *   - whitespace-only drafts are NOT held (`h.trim()!==""`).
 *   - the restore only fires on a strictly EMPTY prompt (`this.#i.value!==""`).
 *   - `pastedContents` is restored wholesale — the "including pasted text and
 *     images" half of the changelog.
 *
 * OCC divergence (documented, no invented behavior): official's slot also
 * carries `launchWarning` (restored via `VDn(this.#e, …)`). `launchWarning` has
 * ZERO hits in the OCC source tree — NO-SURFACE — so the OCC slot holds
 * `{text, mode, pastedContents}` only.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../config.js'
import {
  applyHeldClearedDraft,
  createHeldClearedDraftStore,
  heldClearedDraft,
  type HeldClearedDraft,
} from '../heldClearedDraft.js'

const pastedImage: PastedContent = {
  id: 1,
  type: 'image',
  content: 'iVBORw0KGgoAAAANSUhEUg==',
  mediaType: 'image/png',
  filename: 'screenshot.png',
}

const pastedText: PastedContent = {
  id: 2,
  type: 'text',
  content: 'a very long pasted log that was chipped',
}

describe('CC 2.1.288 #3 — holdCleared', () => {
  let store: ReturnType<typeof createHeldClearedDraftStore>

  beforeEach(() => {
    store = createHeldClearedDraftStore()
  })

  test('holds a non-empty draft with its mode and pasted contents', () => {
    store.holdCleared({
      value: 'fix the parser',
      mode: 'prompt',
      pastedContents: { 1: pastedImage },
    })

    expect(store.peek()).toEqual({
      text: 'fix the parser',
      mode: 'prompt',
      pastedContents: { 1: pastedImage },
    })
  })

  test('skips an empty draft (`h.trim()!==""`)', () => {
    store.holdCleared({ value: '', mode: 'prompt', pastedContents: {} })

    expect(store.peek()).toBeNull()
  })

  test('skips a whitespace-only draft (`h.trim()!==""`)', () => {
    store.holdCleared({ value: '   \n\t ', mode: 'prompt', pastedContents: {} })

    expect(store.peek()).toBeNull()
  })

  test('preserves the raw text including surrounding whitespace', () => {
    store.holdCleared({ value: '  padded  ', mode: 'prompt', pastedContents: {} })

    expect(store.peek()?.text).toBe('  padded  ')
  })

  test('holds the bash mode so the restore can put it back', () => {
    store.holdCleared({ value: 'ls -la', mode: 'bash', pastedContents: {} })

    expect(store.peek()?.mode).toBe('bash')
  })

  test('a second Ctrl+C overwrites the first hold (single slot)', () => {
    store.holdCleared({ value: 'first draft', mode: 'prompt', pastedContents: {} })
    store.holdCleared({ value: 'second draft', mode: 'prompt', pastedContents: {} })

    expect(store.peek()?.text).toBe('second draft')
  })

  test('a whitespace-only Ctrl+C does NOT wipe an earlier hold', () => {
    store.holdCleared({ value: 'keep me', mode: 'prompt', pastedContents: {} })
    store.holdCleared({ value: '   ', mode: 'prompt', pastedContents: {} })

    expect(store.peek()?.text).toBe('keep me')
  })

  test('holds pasted text AND images together', () => {
    store.holdCleared({
      value: 'look at this [image 1] and [text 2]',
      mode: 'prompt',
      pastedContents: { 1: pastedImage, 2: pastedText },
    })

    expect(store.peek()?.pastedContents).toEqual({
      1: pastedImage,
      2: pastedText,
    })
  })
})

describe('CC 2.1.288 #3 — restoreCleared', () => {
  let store: ReturnType<typeof createHeldClearedDraftStore>

  beforeEach(() => {
    store = createHeldClearedDraftStore()
  })

  test('returns the held draft when the prompt is empty', () => {
    store.holdCleared({
      value: 'fix the parser',
      mode: 'prompt',
      pastedContents: { 1: pastedImage },
    })

    const restored: HeldClearedDraft | null = store.restoreCleared('')

    expect(restored).toEqual({
      text: 'fix the parser',
      mode: 'prompt',
      pastedContents: { 1: pastedImage },
    })
  })

  test('refuses when the prompt is NOT empty (`this.#i.value!==""`)', () => {
    store.holdCleared({ value: 'fix the parser', mode: 'prompt', pastedContents: {} })

    expect(store.restoreCleared('something typed')).toBeNull()
    // The slot survives a refused restore — Up on a non-empty prompt must not
    // burn the recovery.
    expect(store.peek()?.text).toBe('fix the parser')
  })

  test('refuses on a whitespace-only (but non-empty) prompt', () => {
    store.holdCleared({ value: 'fix the parser', mode: 'prompt', pastedContents: {} })

    expect(store.restoreCleared('   ')).toBeNull()
    expect(store.peek()?.text).toBe('fix the parser')
  })

  test('refuses when nothing was ever held (`h===null`)', () => {
    expect(store.restoreCleared('')).toBeNull()
  })

  test('is single-shot — `this.#S=null` on success', () => {
    store.holdCleared({ value: 'fix the parser', mode: 'prompt', pastedContents: {} })

    expect(store.restoreCleared('')?.text).toBe('fix the parser')
    expect(store.peek()).toBeNull()
    expect(store.restoreCleared('')).toBeNull()
  })

  test('carries the pasted contents through wholesale', () => {
    store.holdCleared({
      value: 'draft',
      mode: 'prompt',
      pastedContents: { 1: pastedImage, 2: pastedText },
    })

    expect(store.restoreCleared('')?.pastedContents).toEqual({
      1: pastedImage,
      2: pastedText,
    })
  })

  test('carries the mode through', () => {
    store.holdCleared({ value: 'ls -la', mode: 'bash', pastedContents: {} })

    expect(store.restoreCleared('')?.mode).toBe('bash')
  })

  test('the returned draft is a frozen copy — mutating it cannot reach the store', () => {
    store.holdCleared({
      value: 'draft',
      mode: 'prompt',
      pastedContents: { 1: pastedImage },
    })

    const restored = store.restoreCleared('')
    expect(restored).not.toBeNull()
    expect(Object.isFrozen(restored)).toBe(true)
  })
})

describe('CC 2.1.288 #3 — slot isolation and the shared store', () => {
  beforeEach(() => {
    heldClearedDraft.clear()
  })

  test('the module-level store is a working singleton for the REPL', () => {
    heldClearedDraft.holdCleared({
      value: 'shared draft',
      mode: 'prompt',
      pastedContents: {},
    })

    expect(heldClearedDraft.restoreCleared('')?.text).toBe('shared draft')
    expect(heldClearedDraft.peek()).toBeNull()
  })

  test('clear() empties the slot without restoring', () => {
    heldClearedDraft.holdCleared({
      value: 'draft',
      mode: 'prompt',
      pastedContents: {},
    })
    heldClearedDraft.clear()

    expect(heldClearedDraft.peek()).toBeNull()
  })

  test('separate stores never clobber each other (`#S` is its own slot)', () => {
    const a = createHeldClearedDraftStore()
    const b = createHeldClearedDraftStore()

    a.holdCleared({ value: 'a draft', mode: 'prompt', pastedContents: {} })
    b.holdCleared({ value: 'b draft', mode: 'bash', pastedContents: {} })

    expect(a.restoreCleared('')?.text).toBe('a draft')
    expect(b.restoreCleared('')?.mode).toBe('bash')
  })
})

/**
 * The application half of official `restoreCleared` @228665940:
 *   `this.#y(h.text,h.text.length,"input"),`   // value + cursor at END
 *   `this.#f({pastedContents:h.pastedContents,mode:h.mode})`
 * OCC's editor state lives in React rather than in the draft store, so the
 * store returns the held draft and the caller applies it through these sinks.
 * The ORDER is pinned because official applies value+cursor before mode.
 */
describe('CC 2.1.288 #3 — applyHeldClearedDraft', () => {
  function makeSinks() {
    const calls: string[] = []
    return {
      calls,
      sinks: {
        setValue: (value: string) => {
          calls.push(`value:${value}`)
        },
        setCursorOffset: (offset: number) => {
          calls.push(`cursor:${offset}`)
        },
        setPastedContents: (contents: Record<number, PastedContent>) => {
          calls.push(`pasted:${Object.keys(contents).join(',')}`)
        },
        setMode: (nextMode: PromptInputMode) => {
          calls.push(`mode:${nextMode}`)
        },
      },
    }
  }

  test('applies value, cursor-at-end, pastedContents and mode in the official order', () => {
    const { calls, sinks } = makeSinks()

    applyHeldClearedDraft(
      {
        text: 'fix the parser',
        mode: 'prompt',
        pastedContents: { 1: pastedImage, 2: pastedText },
      },
      sinks,
    )

    expect(calls).toEqual([
      'value:fix the parser',
      'cursor:14',
      'pasted:1,2',
      'mode:prompt',
    ])
  })

  test('cursor offset is text.length — including trailing whitespace and newlines', () => {
    const { calls, sinks } = makeSinks()

    applyHeldClearedDraft(
      { text: 'line one\nline two  ', mode: 'prompt', pastedContents: {} },
      sinks,
    )

    expect(calls[1]).toBe(`cursor:${'line one\nline two  '.length}`)
  })

  test('empty pastedContents still fires (the sink is unconditional)', () => {
    const { calls, sinks } = makeSinks()

    applyHeldClearedDraft(
      { text: 'x', mode: 'bash', pastedContents: {} },
      sinks,
    )

    expect(calls).toEqual(['value:x', 'cursor:1', 'pasted:', 'mode:bash'])
  })

  test('past the same object reference through (pastedContents restored wholesale)', () => {
    const contents = { 1: pastedImage }
    let seen: Record<number, PastedContent> | undefined
    applyHeldClearedDraft(
      { text: 'draft', mode: 'prompt', pastedContents: contents },
      {
        setValue: () => {},
        setCursorOffset: () => {},
        setPastedContents: (next) => {
          seen = next
        },
        setMode: () => {},
      },
    )

    expect(seen).toBe(contents)
  })

  test('hold → restore → apply round-trips the original draft through the singleton', () => {
    heldClearedDraft.clear()
    heldClearedDraft.holdCleared({
      value: 'check the pasted image',
      mode: 'bash',
      pastedContents: { 1: pastedImage },
    })

    const { calls, sinks } = makeSinks()
    const held = heldClearedDraft.restoreCleared('')

    expect(held).not.toBeNull()
    applyHeldClearedDraft(held!, sinks)

    expect(calls).toEqual([
      'value:check the pasted image',
      'cursor:22',
      'pasted:1',
      'mode:bash',
    ])
  })
})
