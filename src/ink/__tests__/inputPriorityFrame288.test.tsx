import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { Box, render, Text, useInput } from '../../ink.js'
import Ink from '../ink.js'
import instances from '../instances.js'
import {
  screenReader,
  pushScreenReaderAnnouncement,
  resetScreenReaderAnnouncements,
  endScreenReaderAnnouncementHold,
  isScreenReaderAnnouncementHoldActive,
} from '../../utils/screenReader.js'

/**
 * v2.1.288 Item #66 — SR short announcements stay on screen until the next
 * keypress. This file covers the Ink/App WIRING of the release path (the
 * renderer core is covered by screenReaderHeldLines288.test.ts).
 *
 * Official keyreader (binary @213339384):
 *   `if(n.some(Bd))this.props.onInputPriorityFrame()` runs BEFORE the
 *   discreteUpdates render — Bd = paste||key, excluding wheelup/wheeldown
 *   and mouse names. OCC's ParsedInput has no 'paste' kind, so the
 *   predicate is key-only (documented divergence).
 *
 * Official requestInputPriorityFrame (binary @213420280):
 *   `requestInputPriorityFrame=()=>{this.inputPriorityUntil=this.pacerNow()+Hyo;
 *    let n=!1;if(this.srAnnouncementHoldTimer!==null)zWe(),n=!0;
 *    if(this.isScreenReaderEnabled&&this.srHeldAnnouncements.length>0)
 *      this.srHeldAnnouncements=[],n=!0;if(n)this.onRender()};`
 *   (the pacer half is NO-SURFACE in OCC — no frame pacer exists.)
 *
 * Official unmount (binary @213455138): sets isExiting and clears
 * srAnnouncementHoldTimer before the final onRender.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** SGR wheelup mouse report — parses to ParsedKey name 'wheelup'. */
const WHEELUP_SEQUENCE = '\x1b[<64;5;5M'

function setSrEnabled(enabled: boolean) {
  if (enabled) {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
  } else {
    delete process.env.CLAUDE_AX_SCREEN_READER
  }
  screenReader.reset()
}

async function setupInteractive(node: React.ReactNode) {
  const chunks: string[] = []
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    chunks.push(chunk.toString())
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  // Per-property casts: ReadStream's declared setRawMode/ref/unref signatures
  // (`this`-returning) conflict with no-op polyfill assignments otherwise.
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
  ;(stdin as unknown as { ref: () => void }).ref = () => {}
  ;(stdin as unknown as { unref: () => void }).unref = () => {}
  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  return {
    instance,
    stdin,
    stdout,
    output: () => stripAnsi(chunks.join('')),
  }
}

/** Every keypress bumps state so React schedules a render (SR frame runs). */
function Counter() {
  const [n, setN] = React.useState(0)
  useInput(() => setN(v => v + 1))
  return (
    <Box>
      <Text>count {n}</Text>
    </Box>
  )
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
  resetScreenReaderAnnouncements()
  endScreenReaderAnnouncementHold()
  setSrEnabled(false)
})

describe('2.1.288 #66: keypresses request an input-priority frame', () => {
  test('a key calls requestInputPriorityFrame; a wheel report does not', async () => {
    // autoBind(this) binds prototype methods at construction → patch the
    // prototype BEFORE render so the bound copy is the spy.
    const original = Ink.prototype.requestInputPriorityFrame
    let calls = 0
    Ink.prototype.requestInputPriorityFrame = function (this: Ink) {
      calls++
      return original.call(this)
    }
    try {
      const { instance, stdin } = await setupInteractive(<Counter />)
      mounted.push(instance)
      await delay(30)

      stdin.write('a')
      await delay(30)
      expect(calls).toBe(1)

      stdin.write(WHEELUP_SEQUENCE)
      await delay(30)
      // Official Bd predicate excludes wheelup/wheeldown/mouse names.
      expect(calls).toBe(1)
    } finally {
      Ink.prototype.requestInputPriorityFrame = original
    }
  })
})

describe('2.1.288 #66: keypress releases the held announcement (SR e2e)', () => {
  test('hold arms on the announce frame and the next keypress clears it', async () => {
    setSrEnabled(true)
    resetScreenReaderAnnouncements()
    const { instance, stdin, stdout, output } = await setupInteractive(
      <Counter />,
    )
    mounted.push(instance)
    await delay(30)
    const ink = instances.get(stdout as unknown as NodeJS.WriteStream)
    expect(ink).toBeDefined()
    const srState = (ink as unknown as {
      screenReaderState: {
        holdTimer: ReturnType<typeof setTimeout> | null
        heldAnnouncements: string[]
      }
    }).screenReaderState

    // A held push lands while nothing else renders.
    pushScreenReaderAnnouncement('[plan mode on]', { hold: true })
    // The keypress render drains it: frame writes the announcement AND arms
    // the hold (freeze until timeout / next keypress).
    stdin.write('a')
    await delay(30)
    expect(output()).toContain('[plan mode on]')
    expect(srState.heldAnnouncements).toEqual(['[plan mode on]'])
    expect(isScreenReaderAnnouncementHoldActive()).toBe(true)
    expect(srState.holdTimer).not.toBeNull()

    // Next keypress → requestInputPriorityFrame releases the hold and drops
    // the held lines, then re-renders (announcement erased).
    stdin.write('b')
    await delay(50)
    expect(isScreenReaderAnnouncementHoldActive()).toBe(false)
    expect(srState.heldAnnouncements).toEqual([])
    expect(srState.holdTimer).toBeNull()
  })

  test('unmount clears the SR hold timer', async () => {
    setSrEnabled(true)
    resetScreenReaderAnnouncements()
    const { instance, stdin, stdout } = await setupInteractive(<Counter />)
    await delay(30)
    const ink = instances.get(stdout as unknown as NodeJS.WriteStream)
    const srState = (ink as unknown as {
      screenReaderState: { holdTimer: ReturnType<typeof setTimeout> | null }
    }).screenReaderState

    pushScreenReaderAnnouncement('[auto mode on]', { hold: true })
    stdin.write('a')
    await delay(30)
    expect(srState.holdTimer).not.toBeNull()

    // Official unmount @213455138: isExiting=true + clearTimeout(holdTimer).
    instance.unmount()
    expect(srState.holdTimer).toBeNull()
  })
})
