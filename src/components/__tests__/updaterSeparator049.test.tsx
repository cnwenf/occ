// Official v299 (#049) — the fullscreen "Update installed" notice must render
// BESIDE other status chrome (e.g. the idle "/clear to save tokens" hint),
// not on a competing row. Mechanical pieces under test:
//   1. the withSeparator separator markup — byte-faithful to the decompiled
//      `T===void 0?null:e(n,{dimColor:!0,children:T?" \xB7":""})`
//   2. the AutoUpdater null guard (extracted pure predicate).
// Separator output is asserted through the real Ink reconciler (same
// PassThrough + stripAnsi pattern as statusNoticesContainer278.test.tsx).

import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { shouldRenderAutoUpdater } from '../autoUpdaterVisibility.js'
import { UpdaterSeparator } from '../UpdaterSeparator.js'

async function renderToText(node: React.ReactNode): Promise<string> {
  let output = ''
  const stream = new PassThrough()
  stream.on('data', chunk => {
    output += chunk.toString()
  })
  const instance = await render(node, {
    stdout: stream as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 120))
  } finally {
    instance.unmount()
  }
  return stripAnsi(output)
}

describe('UpdaterSeparator (#049 withSeparator markup)', () => {
  test('renders the dim " ·" divider when withSeparator=true', async () => {
    const text = await renderToText(<UpdaterSeparator withSeparator={true} />)
    expect(text).toContain(' \xB7')
  })

  test('renders no glyph when withSeparator=false (gap spacer only)', async () => {
    const text = await renderToText(<UpdaterSeparator withSeparator={false} />)
    expect(text).not.toContain('\xB7')
  })

  test('renders nothing at all when withSeparator is undefined (legacy standalone)', async () => {
    const withSep = await renderToText(<UpdaterSeparator withSeparator={true} />)
    const without = await renderToText(<UpdaterSeparator />)
    // undefined → the component returns null; frame carries no separator text
    // where the true-variant frame does (both frames are already ANSI-stripped).
    expect(withSep).toContain('\xB7')
    expect(without).not.toContain('\xB7')
  })
})

describe('shouldRenderAutoUpdater (#049 official null guard)', () => {
  const base = {
    verbose: false,
    isUpdating: false,
    autoUpdaterResult: null,
    showSuccessMessage: false,
    updateSemver: null,
  }

  test('hides when idle with no result (the guard default)', () => {
    expect(shouldRenderAutoUpdater(base)).toBe(false)
  })

  test('renders while verbose', () => {
    expect(shouldRenderAutoUpdater({ ...base, verbose: true })).toBe(true)
  })

  test('renders while updating', () => {
    expect(shouldRenderAutoUpdater({ ...base, isUpdating: true })).toBe(true)
  })

  test('renders success only with showSuccessMessage AND a semver', () => {
    const success = { version: '2.0.0', status: 'success' } as const
    expect(shouldRenderAutoUpdater({ ...base, autoUpdaterResult: success })).toBe(false)
    expect(
      shouldRenderAutoUpdater({ ...base, autoUpdaterResult: success, showSuccessMessage: true }),
    ).toBe(false)
    expect(
      shouldRenderAutoUpdater({
        ...base,
        autoUpdaterResult: success,
        showSuccessMessage: true,
        updateSemver: '2.0.0',
      }),
    ).toBe(true)
  })

  test('renders install_failed and no_permissions unconditionally', () => {
    expect(
      shouldRenderAutoUpdater({
        ...base,
        autoUpdaterResult: { version: '2.0.0', status: 'install_failed' },
      }),
    ).toBe(true)
    expect(
      shouldRenderAutoUpdater({
        ...base,
        autoUpdaterResult: { version: '2.0.0', status: 'no_permissions' },
      }),
    ).toBe(true)
  })

  test('OCC adaptation: notice-only status also renders', () => {
    expect(
      shouldRenderAutoUpdater({
        ...base,
        autoUpdaterResult: { version: '2.0.0', status: 'notice' },
      }),
    ).toBe(true)
  })
})
