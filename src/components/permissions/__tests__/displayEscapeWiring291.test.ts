import { describe, expect, test } from 'bun:test'

// CC 2.1.291 (G#9): smoke-load the four permission-prompt components that now
// import escapeControlCharsAsEntities and wrap their title/subtitle display
// values. Biome confirms they parse; this confirms each module EVALUATES at
// runtime (the displayEscape import path resolves through every convention —
// `src/utils/...` alias, `../../../utils/...`, and `../utils/...`) and exports
// its component function. The display-value assertion itself is the doc's e2e
// (tmux capture) case, deferred per OCC-11; the escaper is unit-proven in
// src/utils/__tests__/displayEscape.test.ts and wired end-to-end through a real
// code path in dirPathEscape291.test.ts.

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

describe('G#9 permission components load with the display escaper wired', () => {
  test('FileEditPermissionRequest exports a component function', async () => {
    const mod = await import(
      '../FileEditPermissionRequest/FileEditPermissionRequest.js'
    )
    expect(typeof mod.FileEditPermissionRequest).toBe('function')
  })

  test('FileWritePermissionRequest exports a component function', async () => {
    const mod = await import(
      '../FileWritePermissionRequest/FileWritePermissionRequest.js'
    )
    expect(typeof mod.FileWritePermissionRequest).toBe('function')
  })

  test('SedEditPermissionRequest exports a component function', async () => {
    const mod = await import(
      '../SedEditPermissionRequest/SedEditPermissionRequest.js'
    )
    expect(typeof mod.SedEditPermissionRequest).toBe('function')
  })

  test('ShowInIDEPrompt exports a component function', async () => {
    const mod = await import('../../ShowInIDEPrompt.js')
    expect(typeof mod.ShowInIDEPrompt).toBe('function')
  })
})
