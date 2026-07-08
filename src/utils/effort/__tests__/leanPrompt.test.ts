// Unit tests for the K1 lean-prompt decision logic (mirrors official eqd).
// GLM (the e2e model) is not lean_prompt-capable, so real-model e2e of the
// lean prompt isn't possible via the GLM proxy — these unit tests are the
// done-gate for the lean-prompt LOGIC, plus the gating in prompts.ts (the
// thinking_guidance section is stripped when lean) is verified by reading.

import { test, expect } from 'bun:test'
import {
  shouldUseLeanPrompt,
  shouldUseFullSystemPrompt,
  modelHasLeanPrompt,
} from '../leanPrompt.js'

// Arrange — the model registry capability arrays (lean_prompt carriers).
const LEAN_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5']
const OLD_MODELS = [
  'claude-3-5-sonnet',
  'claude-haiku-4-5',
  'claude-sonnet-4',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
]

test('modelHasLeanPrompt: true for lean_prompt-capable models', () => {
  for (const m of LEAN_MODELS) {
    expect(modelHasLeanPrompt(m)).toBe(true)
  }
})

test('modelHasLeanPrompt: true for display names derived from lean models', () => {
  // A versioned display name like claude-sonnet-5-20251001 still matches.
  expect(modelHasLeanPrompt('claude-sonnet-5-20251001')).toBe(true)
  expect(modelHasLeanPrompt('Claude-Opus-4-8')).toBe(true) // case-insensitive
})

test('modelHasLeanPrompt: false for non-lean + older models', () => {
  expect(modelHasLeanPrompt('glm-5.2')).toBe(false)
  for (const m of OLD_MODELS) {
    expect(modelHasLeanPrompt(m)).toBe(false)
  }
})

test('shouldUseLeanPrompt: lean-capable models get lean by default', () => {
  for (const m of LEAN_MODELS) {
    expect(shouldUseLeanPrompt(m)).toBe(true)
  }
})

test('shouldUseLeanPrompt: xhigh/max effort opts into the full prompt', () => {
  expect(shouldUseLeanPrompt('claude-sonnet-5', 'xhigh')).toBe(false)
  expect(shouldUseLeanPrompt('claude-opus-4-8', 'max')).toBe(false)
})

test('shouldUseLeanPrompt: non-lean models never use the lean prompt', () => {
  expect(shouldUseLeanPrompt('glm-5.2')).toBe(false)
  expect(shouldUseLeanPrompt('claude-opus-4-7')).toBe(false)
  expect(shouldUseLeanPrompt('claude-haiku-4-5', 'xhigh')).toBe(false)
})

test('shouldUseFullSystemPrompt: false for lean-capable models', () => {
  for (const m of LEAN_MODELS) {
    expect(shouldUseFullSystemPrompt(m)).toBe(false)
  }
})

test('shouldUseFullSystemPrompt: true for older models (never lean)', () => {
  for (const m of OLD_MODELS) {
    expect(shouldUseFullSystemPrompt(m)).toBe(true)
  }
})

test('shouldUseFullSystemPrompt: external unknown models get full (mirrors !isInternal)', () => {
  // OCC ships only external builds (USER_TYPE !== 'ant') → unknown → full.
  expect(shouldUseFullSystemPrompt('glm-5.2')).toBe(true)
  expect(shouldUseFullSystemPrompt('some-unknown-model')).toBe(true)
})

test('shouldUseLeanPrompt + shouldUseFullSystemPrompt are complementary for lean models', () => {
  // For a lean-capable model at default effort: lean=true, full=false.
  expect(shouldUseLeanPrompt('claude-sonnet-5')).toBe(true)
  expect(shouldUseFullSystemPrompt('claude-sonnet-5')).toBe(false)
})
