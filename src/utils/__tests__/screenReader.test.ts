import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  screenReader,
  isScreenReaderEnabled,
  getScreenReaderAnnouncement,
  getScreenReaderEnv,
  hasArgvFlag,
  pushScreenReaderAnnouncement,
  drainScreenReaderAnnouncements,
  resetScreenReaderAnnouncements,
} from '../screenReader.js'
import { isFullscreenActive } from '../fullscreen.js'
import { subprocessEnv } from '../subprocessEnv.js'
import {
  createNode,
  createTextNode,
  appendChildNode,
} from '../../ink/dom.js'
import {
  serializeNode,
  ScreenReaderDiffState,
  renderScreenReaderDiff,
} from '../../ink/screen-reader-render.js'
import { resetSettingsCache } from '../settings/settingsCache.js'

const SAVED_ARGV = process.argv.slice()
const SAVED_ENV = { ...process.env }
let tmpConfigDir: string | undefined

function restoreEnv(): void {
  process.argv = SAVED_ARGV.slice()
  delete process.env.CLAUDE_AX_SCREEN_READER
  delete process.env.INK_SCREEN_READER
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
  if (tmpConfigDir) {
    rmSync(tmpConfigDir, { recursive: true, force: true })
    tmpConfigDir = undefined
  }
}

/** Seed a temp CLAUDE_CONFIG_DIR with a user settings.json (disk-read path). */
function seedUserSettings(settings: object): void {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-sr-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  writeFileSync(join(tmpConfigDir, 'settings.json'), JSON.stringify(settings))
}

beforeEach(() => {
  screenReader.reset()
  resetSettingsCache()
  resetScreenReaderAnnouncements()
  process.argv = ['/bin/occ', 'repl']
  delete process.env.CLAUDE_AX_SCREEN_READER
  delete process.env.INK_SCREEN_READER
})

afterEach(() => {
  screenReader.reset()
  resetSettingsCache()
  resetScreenReaderAnnouncements()
  restoreEnv()
})

describe('2.1.208 screen reader: hasArgvFlag (binary f5l)', () => {
  test('returns true when flag present before --', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader', 'repl']
    expect(hasArgvFlag('--ax-screen-reader')).toBe(true)
  })
  test('returns false when flag only after --', () => {
    process.argv = ['/bin/occ', '--', '--ax-screen-reader']
    expect(hasArgvFlag('--ax-screen-reader')).toBe(false)
  })
  test('skips the value of a value-consuming flag (does not false-match)', () => {
    // --settings consumes its next arg; a value equal to a flag name must not match.
    process.argv = ['/bin/occ', '--settings', '--ax-screen-reader']
    expect(hasArgvFlag('--ax-screen-reader')).toBe(false)
  })
})

describe('2.1.208 screen reader: toggle resolution order (binary jhc.isEnabled)', () => {
  test('flag source wins over env and settings', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader']
    process.env.CLAUDE_AX_SCREEN_READER = '0'
    seedUserSettings({ axScreenReader: false })
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('flag')
  })
  test('env source wins over settings when no flag', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    seedUserSettings({ axScreenReader: false })
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('env')
  })
  test('settings source applies when no flag and no env', () => {
    seedUserSettings({ axScreenReader: true })
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('settings')
  })
  test('disabled when nothing sets it', () => {
    expect(isScreenReaderEnabled()).toBe(false)
    expect(screenReader.activationSource()).toBeUndefined()
  })
  test('env falsy value disables and clears source', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '0'
    expect(isScreenReaderEnabled()).toBe(false)
    expect(screenReader.activationSource()).toBeUndefined()
  })
  test('feature gate defaults on (allowlisted) so flag/env/setting take effect', () => {
    // tengu_ax_screen_reader is in FEATURE_ALLOWLIST → feature() returns true
    // → `true ?? true` = true (matches official). Without the allowlist entry,
    // `false ?? true` = false would permanently disable SR.
    process.argv = ['/bin/occ', '--ax-screen-reader']
    expect(isScreenReaderEnabled()).toBe(true)
  })
})

describe('2.1.208 screen reader: announce format (binary Ghc)', () => {
  test('on via flag → "[Screen Reader Mode: on via flag]"', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader']
    expect(getScreenReaderAnnouncement()).toBe('[Screen Reader Mode: on via flag]')
  })
  test('on via env → "[Screen Reader Mode: on via env]"', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    expect(getScreenReaderAnnouncement()).toBe('[Screen Reader Mode: on via env]')
  })
  test('on via settings → "[Screen Reader Mode: on via settings]"', () => {
    seedUserSettings({ axScreenReader: true })
    expect(getScreenReaderAnnouncement()).toBe('[Screen Reader Mode: on via settings]')
  })
  test('off → null', () => {
    expect(getScreenReaderAnnouncement()).toBeNull()
  })
})

describe('2.1.208 screen reader: env propagation (binary QXe)', () => {
  test('on → { CLAUDE_AX_SCREEN_READER: "1" }', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader']
    expect(getScreenReaderEnv()).toEqual({ CLAUDE_AX_SCREEN_READER: '1' })
  })
  test('off → {}', () => {
    expect(getScreenReaderEnv()).toEqual({})
  })
  test('subprocessEnv propagates CLAUDE_AX_SCREEN_READER when SR on via flag', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader']
    delete process.env.CLAUDE_AX_SCREEN_READER
    expect(subprocessEnv().CLAUDE_AX_SCREEN_READER).toBe('1')
  })
  test('subprocessEnv does not add the var when SR off', () => {
    delete process.env.CLAUDE_AX_SCREEN_READER
    expect(subprocessEnv().CLAUDE_AX_SCREEN_READER).toBeUndefined()
  })
})

describe('2.1.208 screen reader: fullscreen gate (binary qi K2)', () => {
  test('isFullscreenActive() returns false when SR enabled', () => {
    process.argv = ['/bin/occ', '--ax-screen-reader']
    // Even if the env would otherwise enable fullscreen, SR wins.
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    expect(isFullscreenActive()).toBe(false)
  })
})

describe('2.1.208 screen reader: flat-render serializer (binary mPr/iHh)', () => {
  test('serializes text nodes flatly', () => {
    const root = createNode('ink-root')
    const box = createNode('ink-box')
    const text = createTextNode('hello')
    appendChildNode(box, text)
    appendChildNode(root, box)
    expect(serializeNode(root)).toBe('hello')
  })
  test('column flex joins children with newline; row with space', () => {
    const root = createNode('ink-root')
    const col = createNode('ink-box')
    col.style.flexDirection = 'column'
    const a = createNode('ink-box')
    appendChildNode(a, createTextNode('aa'))
    const b = createNode('ink-box')
    appendChildNode(b, createTextNode('bb'))
    appendChildNode(col, a)
    appendChildNode(col, b)
    appendChildNode(root, col)
    expect(serializeNode(root)).toBe('aa\nbb')
  })
  test('accessibility.label replaces child text; role is prefixed', () => {
    const root = createNode('ink-root')
    const box = createNode('ink-box')
    box.accessibility = { role: 'button', label: 'Submit' }
    appendChildNode(box, createTextNode('ignored child'))
    appendChildNode(root, box)
    expect(serializeNode(root)).toBe('button: Submit')
  })
  test('accessibility.hidden skips the subtree', () => {
    const root = createNode('ink-root')
    const hidden = createNode('ink-box')
    hidden.accessibility = { hidden: true }
    appendChildNode(hidden, createTextNode('invisible'))
    const visible = createNode('ink-box')
    appendChildNode(visible, createTextNode('visible'))
    appendChildNode(root, hidden)
    appendChildNode(root, visible)
    expect(serializeNode(root)).toBe('visible')
  })
  test('accessibility.state truthy flags are prefixed in parens (role outermost)', () => {
    const root = createNode('ink-root')
    const box = createNode('ink-box')
    box.accessibility = { role: 'checkbox', label: 'Accept', state: { checked: true, disabled: false } }
    appendChildNode(root, box)
    // Binary mPr: state prefix applied first (`(checked) Accept`), then role
    // outermost (`checkbox: (checked) Accept`).
    expect(serializeNode(root)).toBe('checkbox: (checked) Accept')
  })
})

describe('2.1.208 screen reader: render-diff (binary onRenderScreenReader)', () => {
  test('writes flat text on first frame, then only the appended tail', () => {
    const root = createNode('ink-root')
    appendChildNode(root, createTextNode('line one'))
    const state = new ScreenReaderDiffState()
    const written: string[] = []
    const write = (data: string) => {
      written.push(data)
    }
    // First frame: prev is empty → writes the text.
    renderScreenReaderDiff(root, 80, state, null, write)
    expect(written.join('')).toContain('line one')
    // Second frame with new content appended → writes the new tail.
    appendChildNode(root, createTextNode('more'))
    written.length = 0
    renderScreenReaderDiff(root, 80, state, null, write)
    expect(written.join('')).toContain('more')
  })
  test('no-op when content and park unchanged', () => {
    const root = createNode('ink-root')
    appendChildNode(root, createTextNode('stable'))
    const state = new ScreenReaderDiffState()
    // First frame writes (prev is empty); capture without throwing.
    let writeCount = 0
    renderScreenReaderDiff(root, 80, state, null, () => {
      writeCount++
    })
    expect(writeCount).toBe(1)
    // Second identical frame → no write (content + park unchanged).
    renderScreenReaderDiff(root, 80, state, null, () => {
      throw new Error('should not write on unchanged frame')
    })
    expect(writeCount).toBe(1)
  })
})

describe('2.1.210 #30 screen reader: announce queue (binary cxc/uxc/yAt)', () => {
  test('push then drain returns FIFO order', () => {
    pushScreenReaderAnnouncement('[manual mode on]')
    pushScreenReaderAnnouncement('[plan mode on]')
    const drained = drainScreenReaderAnnouncements()
    expect(drained).toEqual(['[manual mode on]', '[plan mode on]'])
    // Second drain is empty (buffer was drained).
    expect(drainScreenReaderAnnouncements()).toEqual([])
  })
  test('drain on empty queue returns []', () => {
    expect(drainScreenReaderAnnouncements()).toEqual([])
  })
  test('queue trims to max 16 entries (binary oxc)', () => {
    for (let i = 0; i < 20; i++) {
      pushScreenReaderAnnouncement(`announce ${i}`)
    }
    const drained = drainScreenReaderAnnouncements()
    expect(drained.length).toBe(16)
    // Oldest 4 are trimmed; first entry is announce 4.
    expect(drained[0]).toBe('announce 4')
    expect(drained[15]).toBe('announce 19')
  })
})

describe('2.1.210 #30 screen reader: announce in render-diff (binary uxc drain in onRenderScreenReader)', () => {
  test('announce string is appended and emitted on the next render', () => {
    const root = createNode('ink-root')
    appendChildNode(root, createTextNode('hello'))
    const state = new ScreenReaderDiffState()
    const written: string[] = []
    // First frame: writes "hello".
    renderScreenReaderDiff(root, 80, state, null, (d) => written.push(d))
    expect(written.join('')).toContain('hello')

    // Push an announce (simulates Shift+Tab mode-cycle).
    pushScreenReaderAnnouncement('[manual mode on]')

    // Second frame: content unchanged, but announce was pushed → should write
    // the announce line (appended after the serialized content).
    written.length = 0
    renderScreenReaderDiff(root, 80, state, null, (d) => written.push(d))
    expect(written.join('')).toContain('[manual mode on]')
  })
  test('announce is transient — appears on one frame, erased on the next', () => {
    const root = createNode('ink-root')
    appendChildNode(root, createTextNode('stable'))
    const state = new ScreenReaderDiffState()
    // First frame: writes "stable".
    renderScreenReaderDiff(root, 80, state, null, () => {})
    // Second frame: announce pushed + drained → appended to wrappedLines.
    pushScreenReaderAnnouncement('[plan mode on]')
    const written2: string[] = []
    renderScreenReaderDiff(root, 80, state, null, (d) => written2.push(d))
    expect(written2.join('')).toContain('[plan mode on]')
    // Third frame: queue is empty → announce line NOT in wrappedLines.
    // The diff sees prev has the announce line, current doesn't → erases it.
    // This is a write (the erase), not a no-op — the announce is transient.
    const written3: string[] = []
    renderScreenReaderDiff(root, 80, state, null, (d) => written3.push(d))
    // The erase body should contain cursor-up + erase-line sequences.
    expect(written3.length).toBeGreaterThan(0)
    // Fourth frame: now content + park truly unchanged → no write.
    renderScreenReaderDiff(root, 80, state, null, () => {
      throw new Error('should not write on unchanged frame with no announce')
    })
  })
})
