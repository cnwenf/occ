import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { AppStateProvider } from '../../../state/AppState.js'
import { renderToStringIsolated } from '../../../components/CustomSelect/__tests__/renderIsolated280.js'
import { FastModePicker } from '../fast.js'

// CC 2.1.280 (#082): "Changed /fast's footer to name Space as the toggle key".
//
// Official binary evidence (win.py windows):
// - v278 @217624583: `Yhe=$v?e(L,{chord:"escape",action:"cancel"}):r(_e,{children:
//   [e(L,{chord:"tab",action:"toggle"}),e(L,{chord:"enter",action:"confirm"}),
//   e(L,{chord:"escape",action:"cancel"})]})`
// - v280 @217049014: identical except `chord:"space",action:"toggle"`.
// The St/$v unavailable-gate (escape-only footer) exists in BOTH versions, so
// the only 280 change is the chord label; OCC's isUnavailable ternary already
// mirrors that gate. The binding side was already correct in OCC
// (defaultBindings.ts maps space → 'confirm:toggle'); only the label needed
// the port (fast.tsx inputGuide t9).
//
// FastModePicker calls useAppState, which throws outside AppStateProvider, so
// the render tests wrap it in the provider (default state is fine — the footer
// label depends only on the unavailableReason prop and Dialog's exitState).

const noop = () => {}

function renderPicker(unavailableReason: string | null): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider>
      <FastModePicker onDone={noop} unavailableReason={unavailableReason} />
    </AppStateProvider>,
    100,
  )
}

describe('2.1.280 #082 /fast footer names Space as the toggle key', () => {
  test('available state: footer reads "Space to toggle · Enter to confirm · Esc to cancel"', async () => {
    // Act
    const out = await renderPicker(null)

    // Assert — v280 chord label present, v278 "tab" label gone
    expect(out).toContain('Space to toggle · Enter to confirm · Esc to cancel')
    expect(out).not.toContain('Tab to toggle')
  })

  test('unavailable state keeps the escape-only footer (gate unchanged in 278→280)', async () => {
    // Arrange — any non-null reason triggers the isUnavailable branch
    const out = await renderPicker('Fast mode is disabled by your organization')

    // Assert — reason shown, escape-only footer, no toggle hint
    expect(out).toContain('Fast mode is disabled by your organization')
    expect(out).toContain('Esc to cancel')
    expect(out).not.toContain('Space to toggle')
  })
})
