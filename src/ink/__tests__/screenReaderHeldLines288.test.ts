import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createNode, createTextNode, appendChildNode } from '../dom.js'
import type { DOMElement } from '../dom.js'
import {
  ScreenReaderDiffState,
  renderScreenReaderDiff,
} from '../screen-reader-render.js'
import {
  pushScreenReaderAnnouncement,
  resetScreenReaderAnnouncements,
  endScreenReaderAnnouncementHold,
  isScreenReaderAnnouncementHoldActive,
  consumeScreenReaderAnnouncementHoldMs,
} from '../../utils/screenReader.js'

/**
 * v2.1.288 Item #66 — "Screen reader short announcements (e.g. the deleted
 * word when pressing Ctrl+W) now stay on screen until the next keypress
 * instead of vanishing on the following render."
 *
 * Official renderer fields (binary @213409894):
 *   srAnnouncementHoldTimer=null;srHeldAnnouncements=[];srRewriteHeldAnnouncement=Z8o();
 * and `resetScreenReaderDiffState()` does NOT clear them.
 *
 * Official held-lines core (binary @213430744):
 *   let H=-1,F=o9o().map(se=>Us(se)).filter(se=>se!=="");
 *   if(F.length>0||this.isExiting)this.srHeldAnnouncements=F;
 *   let k=x.length;
 *   for(let se of this.srHeldAnnouncements)for(let le of se.split("\n")){
 *     if(H===-1&&F.length>0)H=x.length;
 *     if(le==="")x.push("");
 *     else{let ve=Du(le,m,{trim:!1,hard:!0});for(let Me of ve.split("\n"))x.push(Me.trimEnd())}}
 *   let L=t9o();
 *   let B=this.prevScreenReaderLines,j=x.length-k,
 *       Q=j>Math.min(FC,Math.floor(this.terminalRows/4));          // FC=3 @213406306
 *   if(Q)this.srHeldAnnouncements=[];
 *   if(F.length===0&&j>0&&(Q||!this.srRewriteHeldAnnouncement&&
 *       (B.length!==x.length||x.some((se,le)=>le<k&&se!==B[le]))))
 *     this.srHeldAnnouncements=[],x.length=k;
 *
 * Top guard (binary @213429748):
 *   if(this.srAnnouncementHoldTimer!==null){if(r9o()&&!this.isExiting)return;
 *     clearTimeout(this.srAnnouncementHoldTimer),this.srAnnouncementHoldTimer=null}
 *
 * Arm after write (binary @213434144):
 *   if(this.writeContent(...),H!==-1&&L>0&&!this.isExiting)
 *     n9o(L),this.srAnnouncementHoldTimer=setTimeout(()=>{
 *       this.srAnnouncementHoldTimer=null,this.onRender()},L);
 */

const SAVED_ENV = { ...process.env }

function makeTree(text: string): DOMElement {
  const root = createNode('ink-root')
  const box = createNode('ink-box')
  appendChildNode(box, createTextNode(text) as unknown as DOMElement)
  appendChildNode(root, box)
  return root
}

function collector(): { written: string[]; write: (data: string) => void } {
  const written: string[] = []
  return { written, write: (data: string) => void written.push(data) }
}

beforeEach(() => {
  resetScreenReaderAnnouncements()
  delete process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS
  delete process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT
})

afterEach(() => {
  resetScreenReaderAnnouncements()
  endScreenReaderAnnouncementHold()
  for (const k of Object.keys(SAVED_ENV)) {
    const v = SAVED_ENV[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('2.1.288 #66: held announcements persist across frames', () => {
  test('drained announcement becomes a held line and survives the next unchanged frame', () => {
    const root = makeTree('base content')
    const state = new ScreenReaderDiffState()
    const f1 = collector()
    pushScreenReaderAnnouncement('deleted word')
    renderScreenReaderDiff(root, 80, state, null, f1.write)
    // Frame 1 wrote the announcement.
    expect(f1.written.join('')).toContain('deleted word')
    expect(state.heldAnnouncements).toEqual(['deleted word'])

    // Frame 2: base unchanged, no new announcements → held lines re-append,
    // frame is identical → early return with NO write (announcement stays on
    // screen — that is the fix; pre-288 it vanished here).
    const f2 = collector()
    renderScreenReaderDiff(root, 80, state, null, () => {
      throw new Error('should not write on unchanged held frame')
    })
    expect(f2.written).toEqual([])
    expect(state.heldAnnouncements).toEqual(['deleted word'])
  })

  test('held lines are dropped when the lines above change (default rewrite=false)', () => {
    const root = makeTree('base content')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('deleted word')
    renderScreenReaderDiff(root, 80, state, null, () => {})
    expect(state.heldAnnouncements).toEqual(['deleted word'])

    // Base content changes (lines above the held announcement) → held set is
    // invalidated and the announcement is NOT re-appended to the new frame.
    const changed = makeTree('different content')
    const f2 = collector()
    renderScreenReaderDiff(changed, 80, state, null, f2.write)
    expect(state.heldAnnouncements).toEqual([])
    const out = f2.written.join('')
    expect(out).toContain('different content')
    expect(out).not.toContain('deleted word')
  })

  test('CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT=1 keeps held lines across a base change', () => {
    process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT = '1'
    const state = new ScreenReaderDiffState() // captures the env at construction (official field init)
    expect(state.rewriteHeldAnnouncement).toBe(true)
    const root = makeTree('base content')
    pushScreenReaderAnnouncement('deleted word')
    renderScreenReaderDiff(root, 80, state, null, () => {})

    const changed = makeTree('different content')
    const f2 = collector()
    renderScreenReaderDiff(changed, 80, state, null, f2.write)
    expect(state.heldAnnouncements).toEqual(['deleted word'])
    expect(f2.written.join('')).toContain('deleted word')
  })

  test('keypress release: clearing heldAnnouncements drops the announcement on the next frame', () => {
    const root = makeTree('base content')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('deleted word')
    renderScreenReaderDiff(root, 80, state, null, () => {})
    expect(state.heldAnnouncements).toEqual(['deleted word'])

    // Official requestInputPriorityFrame: srHeldAnnouncements=[] then onRender.
    state.heldAnnouncements = []
    const f2 = collector()
    renderScreenReaderDiff(root, 80, state, null, f2.write)
    const out = f2.written.join('')
    // The held line is erased from the screen (diff removes the tail).
    expect(out).not.toContain('deleted word')
    expect(state.prevLines.join('\n')).not.toContain('deleted word')
  })

  test('too many held lines invalidates the hold (official Q = j > Math.min(3, floor(rows/4)))', () => {
    // terminalRows=8 → threshold min(3, 2) = 2 → an announcement producing
    // 3 wrapped lines is too many.
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('aaaaaaaaaa bbbbbbbbbb cccccccccc') // wraps to 3 lines at columns=10
    const f1 = collector()
    renderScreenReaderDiff(root, 10, state, null, f1.write, { terminalRows: 8 })
    // Written this frame (fresh drain), but the held set is invalidated so it
    // does not persist.
    expect(f1.written.join('')).toContain('aaaaaaaaaa')
    expect(state.heldAnnouncements).toEqual([])

    // Next frame: announcement is gone.
    const changed = makeTree('base2')
    const f2 = collector()
    renderScreenReaderDiff(changed, 10, state, null, f2.write, { terminalRows: 8 })
    expect(f2.written.join('')).not.toContain('aaaaaaaaaa')
  })

  test('a small held set within the threshold persists', () => {
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('word')
    renderScreenReaderDiff(root, 80, state, null, () => {}, { terminalRows: 8 })
    expect(state.heldAnnouncements).toEqual(['word'])
  })

  test('state.reset() does NOT clear held announcements or the hold timer (official resetScreenReaderDiffState)', () => {
    const state = new ScreenReaderDiffState()
    state.heldAnnouncements = ['kept']
    const timer = setTimeout(() => {}, 10_000)
    state.holdTimer = timer
    state.prevLines = ['x']
    state.reset()
    expect(state.prevLines).toEqual([])
    expect(state.heldAnnouncements).toEqual(['kept'])
    expect(state.holdTimer).toBe(timer)
    clearTimeout(timer)
  })
})

describe('2.1.288 #7/#66: hold timer (render freeze for {hold:true} pushes)', () => {
  test('plain announcement does not arm the hold timer', () => {
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('[manual mode on]')
    renderScreenReaderDiff(root, 80, state, null, () => {})
    expect(state.holdTimer).toBeNull()
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })

  test('{hold:true} announcement arms the timer + hold window and freezes renders', () => {
    process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS = '5000'
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('[plan mode on]', { hold: true })
    renderScreenReaderDiff(root, 80, state, null, () => {})
    expect(state.holdTimer).not.toBeNull()
    expect(isScreenReaderAnnouncementHoldActive()).toBe(true)

    // While the hold is active, a render is skipped entirely (top guard) —
    // even though the tree changed.
    const changed = makeTree('changed while frozen')
    renderScreenReaderDiff(changed, 80, state, null, () => {
      throw new Error('should not write during hold freeze')
    })
    expect(state.prevLines.join('\n')).not.toContain('changed while frozen')

    // Keypress release (official requestInputPriorityFrame): endHold → the
    // guard clears the timer and the render proceeds.
    endScreenReaderAnnouncementHold()
    const f3 = collector()
    renderScreenReaderDiff(changed, 80, state, null, f3.write)
    expect(state.holdTimer).toBeNull()
    expect(f3.written.join('')).toContain('changed while frozen')
  })

  test('hold timer expiry re-renders via requestRender and clears itself', async () => {
    process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS = '30'
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    let renderRequests = 0
    pushScreenReaderAnnouncement('[auto mode on]', { hold: true })
    renderScreenReaderDiff(root, 80, state, null, () => {}, {
      requestRender: () => {
        renderRequests++
      },
    })
    expect(state.holdTimer).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(renderRequests).toBe(1)
    expect(state.holdTimer).toBeNull()
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })

  test('hold request is consumed even when nothing is inserted (H===-1, no arm)', () => {
    // Official: `let L=t9o()` runs every frame before the arm check
    // `H!==-1&&L>0` — a hold push whose announcement sanitizes to empty
    // consumes the request without arming the freeze (H stays -1 because
    // the filtered drain F is empty).
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    renderScreenReaderDiff(root, 80, state, null, () => {})
    pushScreenReaderAnnouncement('', { hold: true })
    renderScreenReaderDiff(root, 80, state, null, () => {
      throw new Error('identical frame should early-return without writing')
    })
    expect(state.holdTimer).toBeNull()
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
    // The request was consumed by the frame (one-shot flag).
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })
})

describe('2.1.288 #66: held announcements interplay with forced re-emit', () => {
  test('fresh announcement forces re-emit from the insertion point even if the tail matches prev', () => {
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    // Frame 1: announce 'same' → written.
    pushScreenReaderAnnouncement('same')
    renderScreenReaderDiff(root, 80, state, null, () => {})
    // Release the held line so frame 2 starts from the bare base.
    state.heldAnnouncements = []
    renderScreenReaderDiff(root, 80, state, null, () => {})
    // Frame 3: push the identical string again — without the forced re-emit
    // (announceInsert) the diff would see an identical tail and stay silent.
    const f3 = collector()
    pushScreenReaderAnnouncement('same')
    renderScreenReaderDiff(root, 80, state, null, f3.write)
    expect(f3.written.join('')).toContain('same')
  })

  test('multi-line announcements are held as sanitized multi-line entries', () => {
    const root = makeTree('base')
    const state = new ScreenReaderDiffState()
    pushScreenReaderAnnouncement('line one\nline two')
    renderScreenReaderDiff(root, 80, state, null, () => {})
    expect(state.heldAnnouncements).toEqual(['line one\nline two'])
    // Held re-append splits on \n and wraps each part.
    const f2 = collector()
    const changed = makeTree('base2')
    renderScreenReaderDiff(changed, 80, state, null, f2.write)
    // Base changed → held invalidated (default rewrite=false).
    expect(state.heldAnnouncements).toEqual([])
  })
})
