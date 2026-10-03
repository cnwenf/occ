/**
 * CC 2.1.287 (#11) — reduce-motion wiring.
 *
 * GAP 1: AssistantThinkingMessage's streaming branch rendered
 * <InlineThinkingSpinner /> without the `reducedMotion` prop, so the spinner
 * animated even with the "Reduce motion" setting on. The port threads
 * `settings.prefersReducedMotion ?? false` through (same access pattern as
 * Spinner.tsx). Pinned here via a prop-capture mock of InlineThinkingSpinner.
 *
 * GAP 2: BashPermissionRequest's ClassifierCheckingSubtitle passed a hardcoded
 * `false` as useShimmerAnimation's third arg (`isStalled`), so the classifier
 * shimmer animated regardless of the setting. The port passes
 * `settings.prefersReducedMotion ?? false` there. ClassifierCheckingSubtitle
 * is NOT exported and the full permission dialog has no cheap render harness,
 * so the wiring is covered by pinning the hook mechanism it relies on:
 * isStalled=true → glimmerIndex -100 (shimmer frozen, no highlighted char);
 * isStalled=false → the animated baseline (-10 at clock time 0).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { type AppState, AppStateProvider, getDefaultAppState } from '../../../state/AppState.js'
import { Text } from '../../../ink.js'
import { renderToStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import { useShimmerAnimation } from '../../Spinner/useShimmerAnimation.js'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE importing the module under test
// (OCC-97/129 convention, same as desktopDeepLink276.test.ts).
// ---------------------------------------------------------------------------

const actualSpinnerModule = await import('../../Spinner/InlineThinkingSpinner.js')
const capturedSpinnerProps: Array<{ reducedMotion?: boolean }> = []

mock.module('../../Spinner/InlineThinkingSpinner.js', () => ({
  ...actualSpinnerModule,
  InlineThinkingSpinner: (props: { reducedMotion?: boolean }) => {
    capturedSpinnerProps.push({ reducedMotion: props.reducedMotion })
    return null
  },
}))

const { AssistantThinkingMessage } = await import('../AssistantThinkingMessage.js')

afterAll(() => {
  // Leak guard: re-pin the real module.
  mock.module('../../Spinner/InlineThinkingSpinner.js', () => actualSpinnerModule)
})

beforeEach(() => {
  capturedSpinnerProps.length = 0
})

function stateWithSettings(settingsPatch: Record<string, unknown>): AppState {
  const base = getDefaultAppState()
  return {
    ...base,
    settings: { ...base.settings, ...settingsPatch },
  } as AppState
}

function renderThinking(settingsPatch: Record<string, unknown>): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={stateWithSettings(settingsPatch)}>
      <AssistantThinkingMessage
        param={{ type: 'thinking', thinking: 'deep thought' }}
        addMargin={false}
        isTranscriptMode={false}
        verbose={true}
        isStreaming={true}
      />
    </AppStateProvider>,
    80,
  )
}

describe('2.1.287 #11 GAP 1: AssistantThinkingMessage → InlineThinkingSpinner reducedMotion', () => {
  test('prefersReducedMotion=true is threaded to the spinner', async () => {
    await renderThinking({ prefersReducedMotion: true })
    expect(capturedSpinnerProps.length).toBeGreaterThan(0)
    expect(capturedSpinnerProps[capturedSpinnerProps.length - 1]!.reducedMotion).toBe(true)
  })

  test('prefersReducedMotion=false is threaded as false', async () => {
    await renderThinking({ prefersReducedMotion: false })
    expect(capturedSpinnerProps.length).toBeGreaterThan(0)
    expect(capturedSpinnerProps[capturedSpinnerProps.length - 1]!.reducedMotion).toBe(false)
  })

  test('setting unset defaults to false (Spinner.tsx `?? false` pattern)', async () => {
    await renderThinking({})
    expect(capturedSpinnerProps.length).toBeGreaterThan(0)
    expect(capturedSpinnerProps[capturedSpinnerProps.length - 1]!.reducedMotion).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GAP 2 mechanism: useShimmerAnimation isStalled semantics with the exact
// BashPermissionRequest arguments (mode "requesting", CHECKING_TEXT).
// No ClockContext provider → clock is null → time frozen at 0, which makes
// the non-stalled baseline deterministic (-10) and distinguishable from the
// stalled freeze (-100).
// ---------------------------------------------------------------------------

const CHECKING_TEXT = 'Attempting to auto-approve…'

function ShimmerProbe({ isStalled }: { isStalled: boolean }) {
  const [, glimmerIndex] = useShimmerAnimation('requesting', CHECKING_TEXT, isStalled)
  return <Text>{`glimmer:${glimmerIndex}`}</Text>
}

describe('2.1.287 #11 GAP 2: useShimmerAnimation stall mechanism (BashPermissionRequest wiring)', () => {
  test('isStalled=true (Reduce motion on) freezes the shimmer at glimmerIndex -100', async () => {
    const out = await renderToStringIsolated(<ShimmerProbe isStalled={true} />, 80)
    expect(out).toContain('glimmer:-100')
  })

  test('isStalled=false keeps the animated baseline (glimmerIndex -10 at clock 0)', async () => {
    const out = await renderToStringIsolated(<ShimmerProbe isStalled={false} />, 80)
    expect(out).toContain('glimmer:-10')
    expect(out).not.toContain('glimmer:-100')
  })
})
