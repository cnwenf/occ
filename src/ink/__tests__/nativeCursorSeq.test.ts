import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import Ink from '../ink.js'
import { HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'

/**
 * Official 2.1.269 (E23): native-cursor re-assertion on alt-screen
 * enter/exit.
 *
 * Binary evidence (s269.txt @3023727):
 *   `get nativeCursorSeq(){if(this.accessibilityMode||this.isScreenReaderEnabled)return"";
 *    return this.nativeCursorVisible?qk:Vk}`
 * with qk = decset(CURSOR_VISIBLE) = `\x1b[?25h` (SHOW_CURSOR) and
 * Vk = decreset(CURSOR_VISIBLE) = `\x1b[?25l` (HIDE_CURSOR)
 * (s269.txt @26073764), plus `get hasUnmounted(){return this.isUnmounted}`
 * used by <AlternateScreen>'s exit-cleanup guard (s269.txt @19106858).
 *
 * These tests cover the Ink-side getters. The AlternateScreen enter/exit
 * write sequences themselves (`enter + mouse + nativeCursorSeq` /
 * `exit-mouse + exit-alt + (hasUnmounted ? "" : nativeCursorSeq)`) are
 * asserted structurally via the constants below — the component writes
 * raw strings through TerminalWriteContext and needs a full Ink render
 * pass to exercise, which is out of scope for this unit test.
 */

const ENV_KEYS = [
  'CLAUDE_CODE_ACCESSIBILITY',
  'CLAUDE_CODE_NATIVE_CURSOR',
  'INK_SCREEN_READER',
] as const

type MockStdout = NodeJS.WriteStream & { writes: string[] }

function makeMockStdout(): MockStdout {
  const emitter = new EventEmitter() as EventEmitter & {
    columns: number
    rows: number
    isTTY: boolean
    writes: string[]
    write: (chunk: string) => boolean
  }
  emitter.columns = 80
  emitter.rows = 24
  // Non-TTY: skips the constructor's resize/SIGCONT listener registration
  // and unmount()'s writeSync cleanup block, keeping the instance hermetic.
  emitter.isTTY = false
  emitter.writes = []
  emitter.write = (chunk: string): boolean => {
    emitter.writes.push(String(chunk))
    return true
  }
  return emitter as unknown as MockStdout
}

function makeMockStdin(): NodeJS.ReadStream {
  const emitter = new EventEmitter() as EventEmitter & {
    isTTY: boolean
    setEncoding: () => void
    setRawMode: () => void
    resume: () => void
    pause: () => void
    read: () => null
    unref: () => void
    ref: () => void
  }
  emitter.isTTY = false
  emitter.setEncoding = (): void => {}
  emitter.setRawMode = (): void => {}
  emitter.resume = (): void => {}
  emitter.pause = (): void => {}
  emitter.read = (): null => null
  emitter.unref = (): void => {}
  emitter.ref = (): void => {}
  return emitter as unknown as NodeJS.ReadStream
}

function makeInk(isScreenReaderEnabled = false): {
  ink: Ink
  stdout: MockStdout
} {
  const stdout = makeMockStdout()
  const ink = new Ink({
    stdout,
    stdin: makeMockStdin(),
    stderr: makeMockStdout(),
    exitOnCtrlC: false,
    patchConsole: false,
    isScreenReaderEnabled,
  })
  return { ink, stdout }
}

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('Ink.nativeCursorSeq (Official 2.1.269 E23)', () => {
  test('constants match official qk/Vk (decset/decreset 25)', () => {
    // s269.txt @26073764: qk = G0($m.CURSOR_VISIBLE) = `CSI ?25h`,
    // Vk = FV($m.CURSOR_VISIBLE) = `CSI ?25l`.
    expect(SHOW_CURSOR).toBe('\x1b[?25h')
    expect(HIDE_CURSOR).toBe('\x1b[?25l')
  })

  test('returns HIDE_CURSOR by default (native cursor not requested)', () => {
    const { ink } = makeInk()
    try {
      expect(ink.nativeCursorSeq).toBe(HIDE_CURSOR)
    } finally {
      ink.unmount()
    }
  })

  test('returns SHOW_CURSOR when CLAUDE_CODE_NATIVE_CURSOR is truthy', () => {
    process.env.CLAUDE_CODE_NATIVE_CURSOR = '1'
    const { ink } = makeInk()
    try {
      expect(ink.nativeCursorSeq).toBe(SHOW_CURSOR)
    } finally {
      ink.unmount()
    }
  })

  test('returns empty string when screen reader is enabled', () => {
    // Official getter: `if(this.accessibilityMode||this.isScreenReaderEnabled)
    // return""` — SR implies nativeCursorVisible internally, but the getter
    // must still short-circuit to "" (never touch the native cursor).
    process.env.CLAUDE_CODE_NATIVE_CURSOR = '1'
    const { ink } = makeInk(true)
    try {
      expect(ink.nativeCursorSeq).toBe('')
    } finally {
      ink.unmount()
    }
  })

  test('returns empty string in accessibility mode', () => {
    process.env.CLAUDE_CODE_ACCESSIBILITY = '1'
    const { ink } = makeInk()
    try {
      expect(ink.nativeCursorSeq).toBe('')
    } finally {
      ink.unmount()
    }
  })
})

describe('Ink.hasUnmounted (Official 2.1.269 E23)', () => {
  test('is false while mounted and true after unmount', () => {
    const { ink } = makeInk()
    expect(ink.hasUnmounted).toBe(false)
    ink.unmount()
    expect(ink.hasUnmounted).toBe(true)
  })
})
