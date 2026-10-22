// OCC-126 (CC 2.1.305/306) — container-level render of the official
// `security-warnings` banner-registry entry through the real Ink reconciler:
// StatusNotices receives the securityWarnings prop (fed from the REPL via
// Messages → LogoHeader) and renders each row as a status:"warning"
// NoticeLine under the logo — transient JSX, never a message, never
// persisted to the transcript. Modeled on statusNoticesContainer278.test.tsx
// (the `use()`-suspended getMemoryFiles promise needs the same flush dance).

import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { getMemoryFiles } from '../../utils/claudemd.js'
import { StatusNotices } from '../StatusNotices.js'

const ROW = 'Deny rule Glob(path:src/**) never matches · use Read(…)'

async function renderNotices(props: { securityWarnings?: string[] }) {
  let output = ''
  const stream = new PassThrough()
  stream.on('data', chunk => {
    output += chunk.toString()
  })
  const instance = await render(
    <React.Suspense fallback={null}>
      <StatusNotices {...props} />
    </React.Suspense>,
    { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  try {
    await getMemoryFiles()
    await new Promise(resolve => setTimeout(resolve, 300))
  } finally {
    instance.unmount()
  }
  return stripAnsi(output)
}

test('securityWarnings rows render as warning banner lines through the real Ink reconciler', async () => {
  const text = await renderNotices({ securityWarnings: [ROW] })
  expect(text).toContain('Deny rule Glob(path:src/**) never matches')
  // The warning icon renders at column 0 (NoticeLine width-2 icon cell,
  // official container has no paddingLeft).
  const row = text
    .split('\n')
    .find(line => line.includes('Deny rule Glob(path:src/**)'))
  expect(row).toBeDefined()
  expect(row!.startsWith(' ')).toBe(false)
  expect(row!).toContain('⚠')
}, 15_000)

test('empty/absent securityWarnings render no banner rows (official isActive gate)', async () => {
  const text = await renderNotices({ securityWarnings: [] })
  expect(text).not.toContain('Deny rule')
  const absent = await renderNotices({})
  expect(absent).not.toContain('Deny rule')
}, 15_000)
