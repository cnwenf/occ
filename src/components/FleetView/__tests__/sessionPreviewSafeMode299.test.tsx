import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { BackgroundTaskState } from '../../../tasks/types.js'
import { renderToStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import { SessionPreview } from '../SessionPreview.js'

/**
 * CC 2.1.299 (#010): "Added a 'safe mode' line to the agents view peek panel
 * for background sessions started with `--safe-mode`."
 *
 * Official forensics (v299 ELF, /tmp/cc-diff-299 — offsets into
 * package/claude):
 *   - gate @234501483: `rt=!K&&kp(h.state.respawnFlags)` with
 *     `function kp(h){return h.includes("--safe-mode")}` (@234438281).
 *   - row @234504400 region (fleetview_peek component):
 *     `so>0&&<Box paddingLeft={2}><Text wrap="truncate">[je&&<Text
 *     color=…>waiting …</Text>, rt&&<Text dimColor>safe mode</Text>,
 *     rt&&<Text dimColor>customizations are off</Text>]</Text></Box>` —
 *     the two dim items joined by the dim " · " separator; `so=je||rt?1:0`.
 *
 * OCC adaptation (documented in SessionPreview.tsx): BackgroundTaskState
 * carries no respawnFlags — OCC spawns fleet sessions in-process — so the
 * gate reduces to this process's isSafeMode() (CLAUDE_CODE_SAFE_MODE env /
 * --safe-mode argv). These tests render the real component through ink and
 * assert the line's presence, exact wording, dim placement after the peek
 * content, and absence when safe mode is off.
 */

const SAFE_MODE_ENV = 'CLAUDE_CODE_SAFE_MODE'
let savedEnv: string | undefined

function makeAgentTask(
  overrides: Record<string, unknown> = {},
): BackgroundTaskState {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'port the fixes',
    startTime: Date.now() - 60_000,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-1',
    prompt: 'test',
    agentType: 'general-purpose',
    recentActivity: [],
    ...overrides,
  } as unknown as BackgroundTaskState
}

function renderPreview(): Promise<string> {
  return renderToStringIsolated(
    <SessionPreview task={makeAgentTask()} now={Date.now()} />,
    100,
  )
}

beforeEach(() => {
  savedEnv = process.env[SAFE_MODE_ENV]
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[SAFE_MODE_ENV]
  } else {
    process.env[SAFE_MODE_ENV] = savedEnv
  }
})

describe('CC 2.1.299 #010: SessionPreview safe-mode line', () => {
  test('safe mode on → the official dim line renders verbatim', async () => {
    process.env[SAFE_MODE_ENV] = '1'
    const output = await renderPreview()
    expect(output).toContain('safe mode · customizations are off')
  })

  test('safe mode off → the line is absent', async () => {
    delete process.env[SAFE_MODE_ENV]
    const output = await renderPreview()
    expect(output).not.toContain('safe mode')
    expect(output).not.toContain('customizations are off')
  })

  test('falsy env value does not show the line (isEnvTruthy gate)', async () => {
    process.env[SAFE_MODE_ENV] = '0'
    const output = await renderPreview()
    expect(output).not.toContain('safe mode')
  })

  test('the line renders after the peek content', async () => {
    process.env[SAFE_MODE_ENV] = '1'
    const output = await renderPreview()
    const contentIdx = output.indexOf(
      'No activity yet — waiting for the first tool call.',
    )
    const safeModeIdx = output.indexOf('safe mode · customizations are off')
    expect(contentIdx).toBeGreaterThan(-1)
    expect(safeModeIdx).toBeGreaterThan(contentIdx)
  })
})
