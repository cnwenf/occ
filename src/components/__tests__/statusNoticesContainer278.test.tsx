// Gap-133b (OCC-133) — container-level regression for the official 2.1.278
// status-notices warnings container: a bare <Box flexDirection="column"> with
// NO horizontal padding (decompiled container @217750300+; paddingLeft:1/2
// appear only in the announcement-slot and ant-notices branches, which OCC
// does not ship). Pre-fix OCC rendered t4=1, shifting every notice line one
// column right of the official render (live-verified side-by-side) — the
// element-tree tests in statusNoticeTemplates278 cannot catch that regression
// because the container lives in StatusNotices.tsx, which unwraps the memoized
// getMemoryFiles() promise via React `use()` and therefore throws outside a
// renderer. This test renders through the real Ink reconciler (ConcurrentRoot,
// src/ink/ink.tsx) inside the same <Suspense fallback={null}> boundary
// production uses (Messages.tsx) and asserts on the emitted frame.

import { afterAll, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { getMemoryFiles } from '../../utils/claudemd.js'
import { StatusNotices } from '../StatusNotices.js'

const PREV_ENV: Record<string, string | undefined> = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

afterAll(() => {
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('warnings container renders notice lines at column 0 (official 2.1.278 t4=0 — no paddingLeft)', async () => {
  // Seed the env-driven both-auth-methods notice so the container is
  // guaranteed to render at least one line (same dummies as
  // statusNoticeTemplates278; restored in afterAll).
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token-gap133b'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'

  let output = ''
  const stream = new PassThrough()
  stream.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = await render(
    <React.Suspense fallback={null}>
      <StatusNotices />
    </React.Suspense>,
    { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  try {
    // `use()` suspends until the memoized memory-files promise resolves;
    // awaiting the very same promise plus a macrotask tick lets the
    // post-suspense frame flush to the stream before we snapshot it.
    await getMemoryFiles()
    await new Promise(resolve => setTimeout(resolve, 300))
  } finally {
    instance.unmount()
  }

  const text = stripAnsi(output)
  // The seeded notice rendered somewhere in the frame stream (needle chosen
  // short enough to survive 80-column wrapping of the main template line).
  expect(text).toContain('Both ANTHROPIC_AUTH_TOKEN')

  const lines = text.split('\n').filter(line => line.trimEnd().length > 0)
  expect(lines.length).toBeGreaterThan(0)
  // First non-empty frame line = first line of the first active notice. Under
  // the official container it starts at column 0 with the warning icon; under
  // the pre-fix t4=1 it shifted one column right (' ⚠…'). Bullet lines below
  // legitimately carry the nested paddingLeft=2, so only the container's own
  // left edge is asserted here.
  const first = lines[0]!
  expect(first.startsWith(' ')).toBe(false)
  expect(first).toContain('⚠')
})
