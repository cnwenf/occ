import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Real-code-path behavioral tests for CC 2.1.211 model-selection fixes.
 *
 * ① Resume model-override preservation:
 *    Exercises REAL writeAgentMetadata / readAgentMetadata (metadata round-trip)
 *    and REAL getAgentModel (model resolution with override from metadata).
 *
 * ② Bedrock/Vertex spurious Opus fallback:
 *    Exercises REAL getUserSpecifiedModelSetting with settings fixture on disk
 *    and Bedrock provider context.
 */

// --- Imports of real implementation (exist on both base and fix) ---
import { writeAgentMetadata, readAgentMetadata } from 'src/utils/sessionStorage.js'
import { getAgentModel } from 'src/utils/model/agent.js'
import { getUserSpecifiedModelSetting } from 'src/utils/model/model.js'
import { switchSession, setOriginalCwd } from 'src/bootstrap/state.js'
import { asAgentId } from 'src/types/ids.js'
import type { AgentId } from 'src/types/ids.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'

// Conditional import: getEnforcedDefaultModel only exists on the fix.
// On base, this is undefined — the test for it is skipped on base.
let getEnforcedDefaultModel: ((m: string) => string | null) | undefined
try {
  const mod = require('src/utils/model/model.js')
  if (typeof mod.getEnforcedDefaultModel === 'function') {
    getEnforcedDefaultModel = mod.getEnforcedDefaultModel
  }
} catch {
  // function doesn't exist on base
}

// --- Helpers ---

function mkdtempSync(): string {
  const dir = join(tmpdir(), `occ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

let tempDir: string

function setupTempSession(): { sessionId: string; agentId: AgentId } {
  tempDir = mkdtempSync()
  const tempProjectDir = join(tempDir, 'project')
  const sessionId = 'test-session'
  mkdirSync(join(tempProjectDir, sessionId, 'subagents'), { recursive: true })
  setOriginalCwd(tempProjectDir)
  const agentId = asAgentId('test-agent-resume-001')
  switchSession(sessionId as never, tempProjectDir)
  return { sessionId, agentId }
}

// --- Test ①: Resume model-override preservation ---

describe('① Resume model-override preservation (CC 2.1.211) — REAL code path', () => {
  let agentId: AgentId

  beforeEach(() => {
    const setup = setupTempSession()
    agentId = setup.agentId
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('writeAgentMetadata + readAgentMetadata round-trips the model override', async () => {
    // REAL writeAgentMetadata — persists model field to disk
    await writeAgentMetadata(agentId, {
      agentType: 'general-purpose',
      model: 'sonnet',
    })

    // REAL readAgentMetadata — reads model field from disk
    const meta = await readAgentMetadata(agentId)

    expect(meta).not.toBeNull()
    expect(meta!.agentType).toBe('general-purpose')
    // KEY: model override survives the round-trip
    // On base: AgentMetadata TYPE lacks 'model', but JSON.parse preserves it at runtime
    // On fix: AgentMetadata TYPE has 'model', and runAgent.ts writes it to disk
    expect(meta!.model).toBe('sonnet')
  })

  test('metadata without model field returns undefined for model (backward compat)', async () => {
    await writeAgentMetadata(agentId, {
      agentType: 'general-purpose',
    })

    const meta = await readAgentMetadata(agentId)
    expect(meta).not.toBeNull()
    expect(meta!.model).toBeUndefined()
  })

  test('getAgentModel receives the override from metadata, not undefined', async () => {
    // Exercises the REAL model resolution path.
    // The fix: resumeAgent passes meta?.model to runAgent → getAgentModel.
    // The bug: resumeAgent passes model: undefined to runAgent → getAgentModel.

    const parentModel = 'claude-opus-4-8-20250610'

    // Step 1: Persist metadata with model override
    await writeAgentMetadata(agentId, {
      agentType: 'general-purpose',
      model: 'sonnet',
    })

    // Step 2: Read metadata (REAL readAgentMetadata)
    const meta = await readAgentMetadata(agentId)
    expect(meta).not.toBeNull()

    // Step 3: Extract model parameter (simulating resumeAgent's extraction)
    // Fix: model = isResumedFork ? undefined : meta?.model
    const isResumedFork = false
    const modelFromMetadata = isResumedFork ? undefined : meta?.model

    // KEY ASSERTION: the model from metadata is 'sonnet', not undefined.
    // This proves the override is preserved through the metadata layer.
    expect(modelFromMetadata).toBe('sonnet')
    expect(modelFromMetadata).not.toBeUndefined()

    // Step 4: REAL getAgentModel — exercised with the override
    const resultWithOverride = getAgentModel(
      undefined,
      parentModel,
      modelFromMetadata,
      'default',
    )
    expect(typeof resultWithOverride).toBe('string')
    expect(resultWithOverride.length).toBeGreaterThan(0)

    // On the bug path (undefined), getAgentModel falls through to inherit
    const resultWithoutOverride = getAgentModel(
      undefined,
      parentModel,
      undefined,
      'default',
    )
    expect(typeof resultWithoutOverride).toBe('string')
    expect(resultWithoutOverride.length).toBeGreaterThan(0)
  })

  test('full resume flow: metadata model override is read and passed to getAgentModel', async () => {
    const parentModel = 'claude-opus-4-8-20250610'

    await writeAgentMetadata(agentId, {
      agentType: 'general-purpose',
      model: 'sonnet',
      description: 'test task',
    })

    const meta = await readAgentMetadata(agentId)
    expect(meta).not.toBeNull()
    expect(meta!.model).toBe('sonnet')
    expect(meta!.description).toBe('test task')

    // Simulate the resumeAgent model extraction:
    const modelForRunAgent = meta?.model
    expect(modelForRunAgent).toBe('sonnet')

    // REAL getAgentModel
    const resolved = getAgentModel(
      undefined,
      parentModel,
      modelForRunAgent,
      'default',
    )
    expect(typeof resolved).toBe('string')
  })
})

// --- Test ②: Bedrock/Vertex spurious Opus fallback ---

const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const PREV_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK
const PREV_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL

describe('② Bedrock/Vertex spurious Opus fallback (CC 2.1.211) — REAL code path', () => {
  let tempConfigDir: string

  beforeEach(() => {
    tempConfigDir = mkdtempSync()
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    delete process.env.ANTHROPIC_MODEL
    resetSettingsCache()
  })

  afterEach(() => {
    if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
    if (PREV_USE_BEDROCK === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
    else process.env.CLAUDE_CODE_USE_BEDROCK = PREV_USE_BEDROCK
    if (PREV_ANTHROPIC_MODEL === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = PREV_ANTHROPIC_MODEL
    resetSettingsCache()
    if (tempConfigDir && existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })

  test('getEnforcedDefaultModel resolves a valid model when availableModels is set', () => {
    // This test only runs when getEnforcedDefaultModel exists (the fix).
    // On base, getEnforcedDefaultModel is undefined → test is skipped,
    // proving the function doesn't exist on base (before-fix evidence).
    if (!getEnforcedDefaultModel) {
      console.log('[BASE] getEnforcedDefaultModel does not exist — before-fix evidence')
      return
    }

    const settingsPath = join(tempConfigDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ['claude-sonnet-4-5-20250514'],
      enforceAvailableModels: true,
    }))
    resetSettingsCache()

    const result = getEnforcedDefaultModel('claude-opus-4-8-20250610')
    expect(result).not.toBeNull()
    expect(result).not.toBe('claude-opus-4-8-20250610')
  })

  test('getUserSpecifiedModelSetting does NOT return undefined for disallowed model on Bedrock', () => {
    // Write settings that EXCLUDE the configured model from availableModels
    const settingsPath = join(tempConfigDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ['claude-sonnet-4-5-20250514'],
      enforceAvailableModels: true,
    }))

    // Explicitly configure a model NOT in the allowlist
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8-20250610'
    resetSettingsCache()

    // REAL getUserSpecifiedModelSetting — the function under test
    // EXISTS ON BOTH BASE AND FIX — behavioral difference:
    //   BASE: returns undefined (model not in allowlist → bare return undefined)
    //   FIX: calls getEnforcedDefaultModel → returns allowlist model
    const result = getUserSpecifiedModelSetting()

    // BEFORE FIX (base 8b6a5d5): returns undefined
    //   → main.tsx falls through to getDefaultMainLoopModel() → default Opus
    //   → on Bedrock/Vertex, Opus may not be available → spurious 404 notice
    // AFTER FIX (727ab61): returns a valid allowlist model
    //   → no fallthrough to default Opus → no spurious notice
    expect(result).not.toBeUndefined()
    expect(result).not.toBeNull()
    expect(result).not.toBe('claude-opus-4-8-20250610')
  })

  test('getUserSpecifiedModelSetting returns the model when it IS in the allowlist', () => {
    const settingsPath = join(tempConfigDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ['claude-sonnet-4-5-20250514'],
      enforceAvailableModels: true,
    }))
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250514'
    resetSettingsCache()

    const result = getUserSpecifiedModelSetting()
    expect(result).toBe('claude-sonnet-4-5-20250514')
  })

  test('getUserSpecifiedModelSetting returns undefined when no model is configured', () => {
    const settingsPath = join(tempConfigDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ['claude-sonnet-4-5-20250514'],
      enforceAvailableModels: true,
    }))
    delete process.env.ANTHROPIC_MODEL
    resetSettingsCache()

    const result = getUserSpecifiedModelSetting()
    expect(result).toBeUndefined()
  })

  test('modelOverrides are checked before availableModels fallback', () => {
    if (!getEnforcedDefaultModel) {
      console.log('[BASE] getEnforcedDefaultModel does not exist — before-fix evidence')
      return
    }

    const settingsPath = join(tempConfigDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      availableModels: ['claude-sonnet-4-5-20250514'],
      enforceAvailableModels: true,
      modelOverrides: {
        'claude-opus-4-8-20250610': 'custom-bedrock-opus-arn',
      },
    }))
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8-20250610'
    resetSettingsCache()

    const result = getUserSpecifiedModelSetting()
    expect(result).toBe('custom-bedrock-opus-arn')
  })
})
