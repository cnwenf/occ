import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  pushScreenReaderAnnouncement,
  drainScreenReaderAnnouncements,
  resetScreenReaderAnnouncements,
  consumeScreenReaderAnnouncementHoldMs,
  startScreenReaderAnnouncementHold,
  endScreenReaderAnnouncementHold,
  isScreenReaderAnnouncementHoldActive,
  shouldRewriteHeldScreenReaderAnnouncement,
} from '../screenReader.js'

/**
 * v2.1.288 Item #66 — SR short announcements stay on screen until the next
 * keypress. Official announcement-queue module (binary offset ~201612200,
 * class `E` + module fns `QW`/`t9o`/`n9o`/`zWe`/`r9o`/`o9o`/`Z8o`):
 *
 *   queueAnnouncement(e,n=!1){if(this.#e.push(e),n)this.#t=!0;
 *     if(this.#e.length>m)this.#e.splice(0,this.#e.length-m)}   // m=16
 *   takeHoldRequest(){let e=this.#t;return this.#t=!1,e}
 *   startHold(e){this.#a=e}
 *   endHold(){this.#a=0,this.#t=!1}
 *   holdActive(e){return e<this.#a}
 *   reset(){…,#e.length=0,this.#t=!1,this.#a=0}
 *
 *   function QW(e,n){r().queueAnnouncement(e,n?.hold===!0)}
 *   function t9o(){if(r().takeHoldRequest())
 *     return Math.min(a.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS??1000,1e4);return 0}
 *   function n9o(e){r().startHold(Date.now()+e)}
 *   function zWe(){r().endHold()}
 *   function r9o(){return r().holdActive(Date.now())}
 *   function Z8o(){return a.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT??!1}
 *
 * OCC keeps the queue at module level (existing `srAnnounceQueue` port from
 * the 2.1.210 subsystem) instead of on the toggle singleton; the hold state
 * (`#t` hold-requested flag, `#a` hold-until timestamp) lives beside it.
 */

const SAVED_ENV = { ...process.env }

function restoreEnv(): void {
  delete process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS
  delete process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT
  for (const k of Object.keys(SAVED_ENV)) {
    const v = SAVED_ENV[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  resetScreenReaderAnnouncements()
  delete process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS
  delete process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT
})

afterEach(() => {
  resetScreenReaderAnnouncements()
  restoreEnv()
})

describe('pushScreenReaderAnnouncement hold option (official QW)', () => {
  test('plain push does not raise a hold request', () => {
    pushScreenReaderAnnouncement('hello')
    expect(drainScreenReaderAnnouncements()).toEqual(['hello'])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })

  test('push with {hold:true} raises a one-shot hold request (official #t flag)', () => {
    pushScreenReaderAnnouncement('[auto mode on]', { hold: true })
    expect(drainScreenReaderAnnouncements()).toEqual(['[auto mode on]'])
    // Official t9o: takeHoldRequest() consumes the flag → default 1000ms.
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    // Second consume: flag already taken → 0.
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })

  test('hold request survives a drain (flag is set at push time)', () => {
    pushScreenReaderAnnouncement('a', { hold: true })
    // Consume BEFORE draining — official flag is independent of the queue.
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    expect(drainScreenReaderAnnouncements()).toEqual(['a'])
  })

  test('{hold:false} behaves like a plain push', () => {
    pushScreenReaderAnnouncement('b', { hold: false })
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })

  test('queue still caps at 16 entries (official m=16) with hold pushes', () => {
    for (let i = 0; i < 20; i++) {
      pushScreenReaderAnnouncement(`msg-${i}`, { hold: i === 19 })
    }
    const drained = drainScreenReaderAnnouncements()
    expect(drained.length).toBe(16)
    expect(drained[0]).toBe('msg-4')
    expect(drained[15]).toBe('msg-19')
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
  })
})

describe('consumeScreenReaderAnnouncementHoldMs (official t9o)', () => {
  test('CLAUDE_AX_ANNOUNCEMENT_HOLD_MS overrides the 1000ms default', () => {
    process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS = '250'
    pushScreenReaderAnnouncement('x', { hold: true })
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(250)
  })

  test('value is capped at 10000ms (official Math.min(…,1e4))', () => {
    process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS = '20000'
    pushScreenReaderAnnouncement('x', { hold: true })
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(10000)
  })

  test('non-numeric value falls back to the 1000ms default', () => {
    process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS = 'abc'
    pushScreenReaderAnnouncement('x', { hold: true })
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
  })
})

describe('hold window (official n9o/zWe/r9o)', () => {
  test('startHold(ms) opens the window; holdActive is true inside it', () => {
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
    startScreenReaderAnnouncementHold(5000)
    expect(isScreenReaderAnnouncementHoldActive()).toBe(true)
  })

  test('endHold closes the window', () => {
    startScreenReaderAnnouncementHold(5000)
    endScreenReaderAnnouncementHold()
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })

  test('endHold also discards a pending hold request (official endHold sets #t=!1)', () => {
    pushScreenReaderAnnouncement('x', { hold: true })
    endScreenReaderAnnouncementHold()
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })

  test('a 0ms hold window is immediately inactive', () => {
    startScreenReaderAnnouncementHold(0)
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })

  test('the window expires with time (official holdActive: now < #a)', async () => {
    startScreenReaderAnnouncementHold(20)
    expect(isScreenReaderAnnouncementHoldActive()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })
})

describe('resetScreenReaderAnnouncements (official class reset)', () => {
  test('reset clears queue, pending hold request, and active hold window', () => {
    pushScreenReaderAnnouncement('x', { hold: true })
    startScreenReaderAnnouncementHold(5000)
    resetScreenReaderAnnouncements()
    expect(drainScreenReaderAnnouncements()).toEqual([])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
  })
})

describe('shouldRewriteHeldScreenReaderAnnouncement (official Z8o)', () => {
  test('defaults to false (official ??!1)', () => {
    expect(shouldRewriteHeldScreenReaderAnnouncement()).toBe(false)
  })

  test('CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT=1 enables it', () => {
    process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT = '1'
    expect(shouldRewriteHeldScreenReaderAnnouncement()).toBe(true)
  })

  test('CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT=0 keeps it off', () => {
    process.env.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT = '0'
    expect(shouldRewriteHeldScreenReaderAnnouncement()).toBe(false)
  })
})
