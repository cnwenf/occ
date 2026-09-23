import * as React from 'react'
import { useLayoutEffect } from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { render, useApp } from '../../../ink.js'

// Isolated render helper for the 2.1.280 port tests.
//
// src/utils/staticRender.tsx's renderToString renders against the real
// process.stdin. That works for static components, but interactive ones
// (SelectMulti / ChooseRepoStep / FastModePicker) mount ink's useInput, whose
// layout effect calls setRawMode(true) → App.handleSetRawMode throws
// "Raw mode is not supported on the current process.stdin" on a non-TTY stdin.
// The error boundary re-renders ErrorOverview, the unmounting child's
// setRawMode(false) cleanup throws again → error loop → waitUntilExit never
// resolves → bun test timeout.
//
// This helper mirrors staticRender (RenderOnceAndExit + first-frame
// extraction) but passes a PassThrough stdin with isTTY=true and a no-op
// setRawMode, which is exactly the shape ink's isRawModeSupported() checks
// (`this.props.stdin.isTTY`). No process-global mutation, so nothing leaks
// into other test files.

function RenderOnceAndExit({ children }: { children: React.ReactNode }) {
  const { exit } = useApp()
  useLayoutEffect(() => {
    const timer = setTimeout(exit, 0)
    return () => clearTimeout(timer)
  }, [exit])
  return <>{children}</>
}

// DEC synchronized update markers used by terminals
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractFirstFrame(output: string): string {
  const startIndex = output.indexOf(SYNC_START)
  if (startIndex === -1) return output
  const contentStart = startIndex + SYNC_START.length
  const endIndex = output.indexOf(SYNC_END, contentStart)
  if (endIndex === -1) return output
  return output.slice(contentStart, endIndex)
}

export async function renderToAnsiStringIsolated(node: React.ReactNode, columns?: number): Promise<string> {
  let output = ''

  const stdout = new PassThrough()
  if (columns !== undefined) {
    ;(stdout as unknown as { columns: number }).columns = columns
  }
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  // Fake TTY stdin: isTTY=true satisfies App.isRawModeSupported().
  // App.handleSetRawMode's enable path also calls stdin.ref() /
  // stdin.setRawMode(true) / addListener('readable', ...) — Bun's
  // PassThrough lacks ref/unref, so polyfill them as no-ops alongside the
  // no-op setRawMode. No data ever arrives, so useInput handlers simply
  // never fire — we only assert the first frame.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  if (typeof stdin.ref !== 'function') {
    stdin.ref = () => {}
  }
  if (typeof stdin.unref !== 'function') {
    stdin.unref = () => {}
  }

  const instance = await render(<RenderOnceAndExit>{node}</RenderOnceAndExit>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })

  await instance.waitUntilExit()
  return extractFirstFrame(output)
}

export async function renderToStringIsolated(node: React.ReactNode, columns?: number): Promise<string> {
  const output = await renderToAnsiStringIsolated(node, columns)
  return stripAnsi(output)
}
