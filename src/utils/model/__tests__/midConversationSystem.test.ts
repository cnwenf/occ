// Unit tests for the 2.1.207 #4 mid-conversation-system instruction gate
// (mirrors official binary b8t/zkd). These UTs are the done-gate for the GATE
// LOGIC; the system-prompt wiring (prompts.ts) is verified by reading + the
// behavioral smoke (the instruction is emitted for fable-5 on firstParty).

import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  shouldUseMidConversationSystemInstruction,
  supportsMidConversationSystem,
  isOpus48Model,
  MID_CONVERSATION_SYSTEM_INSTRUCTION,
} from '../midConversationSystem.js'

// Provider env vars that getAPIProvider() consults (see providers.ts).
const PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of PROVIDER_ENV_VARS) saved[k] = process.env[k]
  // Default: clear all provider env → firstParty.
  for (const k of PROVIDER_ENV_VARS) delete process.env[k]
})

afterEach(() => {
  for (const k of PROVIDER_ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('MID_CONVERSATION_SYSTEM_INSTRUCTION is binary-verbatim (the 207#4 discriminator)', () => {
  // Exact string recovered from the 2.1.210 binary (count 2 in 210, 0 in 206).
  // Never invented — assert the load-bearing text verbatim.
  expect(MID_CONVERSATION_SYSTEM_INSTRUCTION).toBe(
    'The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.',
  )
})

test('isOpus48Model: true only for claude-opus-4-8 (case/provider-suffix safe)', () => {
  // Arrange — canonical, versioned, provider-suffixed, 1m-suffixed forms.
  expect(isOpus48Model('claude-opus-4-8')).toBe(true)
  expect(isOpus48Model('us.anthropic.claude-opus-4-8')).toBe(true)
  expect(isOpus48Model('claude-opus-4-8[1m]')).toBe(true)
  expect(isOpus48Model('Claude-Opus-4-8')).toBe(true)
  // Arrange — non-opus-4-8 models must NOT match.
  expect(isOpus48Model('claude-opus-4-7')).toBe(false)
  expect(isOpus48Model('claude-sonnet-5')).toBe(false)
  expect(isOpus48Model('claude-fable-5')).toBe(false)
  expect(isOpus48Model('')).toBe(false)
})

// ── supportsMidConversationSystem (= binary b8t) ─────────────────────────

test('supportsMidConversationSystem: false for legacy models that predate the feature', () => {
  // Arrange — binary b8t explicit-false list (claude-3-x is a substring match).
  const legacy = [
    'claude-3-5-sonnet',
    'claude-3-7-sonnet',
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-sonnet-4-0',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]
  // Act + Assert
  for (const m of legacy) {
    expect(supportsMidConversationSystem(m)).toBe(false)
  }
})

test('supportsMidConversationSystem: true for Fable 5 / Mythos 5 on firstParty', () => {
  // Arrange — default env = firstParty (binary EW fallback + fable branch).
  // Act + Assert — both the fable and mythos codenames.
  expect(supportsMidConversationSystem('claude-fable-5')).toBe(true)
  expect(supportsMidConversationSystem('claude-mythos-5')).toBe(true)
  expect(supportsMidConversationSystem('us.anthropic.claude-fable-5')).toBe(true)
})

test('supportsMidConversationSystem: CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM forces true even for legacy models', () => {
  // Arrange — legacy model + force-override env (binary b8t guard #2).
  process.env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM = '1'
  // Act + Assert
  expect(supportsMidConversationSystem('claude-opus-4-7')).toBe(true)
  expect(supportsMidConversationSystem('claude-3-5-sonnet')).toBe(true)
})

test('supportsMidConversationSystem: Fable 5 / Mythos 5 is true on any provider (binary explicit check precedes fallback)', () => {
  // Arrange — binary b8t checks `r==="claude-mythos-5"` (step 5) BEFORE the
  // provider fallback EW(wb(e)) (step 6), so the fable/mythos model supports
  // mid-conversation system regardless of provider.
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  expect(supportsMidConversationSystem('claude-fable-5')).toBe(true)
  expect(supportsMidConversationSystem('claude-mythos-5')).toBe(true)
  delete process.env.CLAUDE_CODE_USE_BEDROCK

  process.env.CLAUDE_CODE_USE_VERTEX = '1'
  expect(supportsMidConversationSystem('claude-fable-5')).toBe(true)
  delete process.env.CLAUDE_CODE_USE_VERTEX
})

test('supportsMidConversationSystem: Opus 4.8 on firstParty is true (fallback), Sonnet 5 is true (fallback)', () => {
  // Arrange — default firstParty. These pass b8t via the EW provider fallback.
  // Act + Assert
  expect(supportsMidConversationSystem('claude-opus-4-8')).toBe(true)
  expect(supportsMidConversationSystem('claude-sonnet-5')).toBe(true)
})

// ── shouldUseMidConversationSystemInstruction (= binary zkd) ─────────────

test('shouldUseMidConversationSystemInstruction: true for Fable 5 on firstParty (DFy shown)', () => {
  // Act + Assert — zkd = b8t && !Vjn && !xic → fable-5: true && !false && !false
  expect(shouldUseMidConversationSystemInstruction('claude-fable-5')).toBe(true)
  expect(shouldUseMidConversationSystemInstruction('claude-mythos-5')).toBe(true)
})

test('shouldUseMidConversationSystemInstruction: false for Opus 4.8 (excluded by xic, keeps regular reminder)', () => {
  // Act + Assert — opus-4-8: b8t=true(fallback) but xic=true → zkd=false
  expect(shouldUseMidConversationSystemInstruction('claude-opus-4-8')).toBe(false)
})

test('shouldUseMidConversationSystemInstruction: false for Sonnet 5 (excluded by Vjn, keeps regular reminder)', () => {
  // Act + Assert — sonnet-5: b8t=true(fallback) but Vjn=true → zkd=false
  expect(shouldUseMidConversationSystemInstruction('claude-sonnet-5')).toBe(false)
})

test('shouldUseMidConversationSystemInstruction: false for legacy models (b8t=false)', () => {
  // Act + Assert
  expect(shouldUseMidConversationSystemInstruction('claude-opus-4-7')).toBe(false)
  expect(shouldUseMidConversationSystemInstruction('claude-sonnet-4-6')).toBe(false)
  expect(shouldUseMidConversationSystemInstruction('claude-haiku-4-5')).toBe(false)
  expect(shouldUseMidConversationSystemInstruction('claude-3-5-sonnet')).toBe(false)
})

test('shouldUseMidConversationSystemInstruction: Fable 5 on bedrock is still true (provider-independent)', () => {
  // Arrange
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  // Act + Assert — b8t=true (fable explicit) → zkd=true (not sonnet5/opus48)
  expect(shouldUseMidConversationSystemInstruction('claude-fable-5')).toBe(true)
})

test('shouldUseMidConversationSystemInstruction: force-env still excludes Sonnet 5 / Opus 4.8', () => {
  // Arrange — force makes b8t true, but zkd's Vjn/xic guards still apply.
  process.env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM = '1'
  // Act + Assert
  expect(shouldUseMidConversationSystemInstruction('claude-sonnet-5')).toBe(false)
  expect(shouldUseMidConversationSystemInstruction('claude-opus-4-8')).toBe(false)
  // Fable 5 stays true under force-env.
  expect(shouldUseMidConversationSystemInstruction('claude-fable-5')).toBe(true)
})
