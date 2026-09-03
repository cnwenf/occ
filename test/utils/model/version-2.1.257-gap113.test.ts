import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Gap-113 tests — OCC version catch-up 2.1.252 → 2.1.258
 * (issue OCC-113, round 2026-09-03).
 *
 * Gap-113a: Fable 5.1 launch registration (official 2.1.257, 104 changelog
 *   entries) — model catalog, canonicalization order, display names,
 *   knowledge cutoffs, pricing tier, Vertex region table, context-management
 *   beta, 3P fallback suggestions, commit-attribution sanitization.
 * Gap-113b: CLAUDE_CODE_SUBAGENT_MODEL_FORCE (official 2.1.257) — forces
 *   every subagent onto the inherited session model.
 * Gap-113c: removal of the Ctrl+E permission explainer subsystem
 *   (official 2.1.257 changelog entry 096).
 *
 * All byte-verified values below were extracted from the official 2.1.258
 * linux-x64 ELF (see docs/upstream-version-gap-occ113.md for offsets).
 */

import {
  ALL_MODEL_CONFIGS,
  CLAUDE_FABLE_5_1_CONFIG,
} from '../../../src/utils/model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultFableModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
} from '../../../src/utils/model/model.js'
import { getModelStrings } from '../../../src/utils/model/modelStrings.js'
import {
  COST_TIER_10_50,
  COST_TIER_10_50_CACHE_READ_0_25,
  MODEL_COSTS,
} from '../../../src/utils/modelCost.js'
import { getVertexRegionForModel } from '../../../src/utils/envUtils.js'
import { modelSupportsContextManagement } from '../../../src/utils/betas.js'
import { sanitizeModelName } from '../../../src/utils/commitAttribution.js'
import { getAgentModel } from '../../../src/utils/model/agent.js'
import { isProviderManagedEnvVar } from '../../../src/utils/managedEnvConstants.js'

const SRC = join(process.cwd(), 'src')

// Env hygiene: every test that touches model resolution must see a clean
// provider env regardless of run order.
const ENV_KEYS = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
  'VERTEX_REGION_CLAUDE_FABLE_5_1',
  'VERTEX_REGION_CLAUDE_FABLE_5',
  'VERTEX_REGION_CLAUDE_4_8_OPUS',
] as const

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

// ============================================================================
// Gap-113a — Fable 5.1 catalog registration
// ============================================================================

describe('Gap-113a: Fable 5.1 model catalog', () => {
  test('CLAUDE_FABLE_5_1_CONFIG carries the byte-verified per-provider ids', () => {
    // Official 2.1.258 ELF catalog entry (offset 12973373): display_name
    // "Fable 5.1", fallback_3p "claude-fable-5", pricing
    // "tier_10_50_cache_read_0_25", default_effort "high".
    const config = CLAUDE_FABLE_5_1_CONFIG as Record<string, string>
    expect(config.firstParty).toBe('claude-fable-5-1')
    expect(config.vertex).toBe('claude-fable-5-1')
    expect(config.foundry).toBe('claude-fable-5-1')
    expect(config.anthropic_aws).toBe('claude-fable-5-1')
    expect(config.gateway).toBe('claude-fable-5-1')
    expect(config.bedrock).toBe('us.anthropic.claude-fable-5-1')
    expect(config.mantle).toBe('anthropic.claude-fable-5-1')
  })

  test('fable51 is registered in ALL_MODEL_CONFIGS', () => {
    expect(Object.keys(ALL_MODEL_CONFIGS)).toContain('fable51')
    expect(ALL_MODEL_CONFIGS.fable51).toBe(CLAUDE_FABLE_5_1_CONFIG)
  })

  test('model strings auto-derive fable51 from the catalog', () => {
    // MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) — registering fable51
    // extends getModelStrings() everywhere (picker, aliases, defaults).
    expect(getModelStrings().fable51).toBe('claude-fable-5-1')
    expect(getModelStrings().fable5).toBe('claude-fable-5')
  })
})

describe('Gap-113a: canonicalization order', () => {
  test('claude-fable-5-1 canonicalizes to itself, not to claude-fable-5', () => {
    // Canonicalization trap: "claude-fable-5" is a substring of
    // "claude-fable-5-1", so the specific branch must precede the broad one.
    expect(firstPartyNameToCanonical('claude-fable-5-1')).toBe(
      'claude-fable-5-1',
    )
  })

  test('claude-mythos-5-1 canonicalizes to claude-fable-5-1', () => {
    expect(firstPartyNameToCanonical('claude-mythos-5-1')).toBe(
      'claude-fable-5-1',
    )
  })

  test('the broader fable-5 branches stay intact', () => {
    expect(firstPartyNameToCanonical('claude-fable-5')).toBe('claude-fable-5')
    expect(firstPartyNameToCanonical('claude-mythos-5')).toBe('claude-fable-5')
  })

  test('3P provider ids canonicalize to claude-fable-5-1', () => {
    expect(getCanonicalName('us.anthropic.claude-fable-5-1')).toBe(
      'claude-fable-5-1',
    )
    expect(getCanonicalName('anthropic.claude-fable-5-1')).toBe(
      'claude-fable-5-1',
    )
    // And 5 (not 5-1) for the pre-launch model.
    expect(getCanonicalName('us.anthropic.claude-fable-5')).toBe(
      'claude-fable-5',
    )
  })
})

describe('Gap-113a: display names', () => {
  test('public display name is "Fable 5.1"', () => {
    expect(getPublicModelDisplayName('claude-fable-5-1')).toBe('Fable 5.1')
  })

  test('marketing name is "Fable 5.1"', () => {
    expect(getMarketingNameForModel('claude-fable-5-1')).toBe('Fable 5.1')
    // The official binary carries no 1M-variant marketing name for Fable
    // models (byte-verified), so the [1m] form returns the plain name.
    expect(getMarketingNameForModel('claude-fable-5-1[1m]')).toBe('Fable 5.1')
  })
})

describe('Gap-113a: default fable model', () => {
  test('first-party default fable is fable51', () => {
    // Official getDefaultFableModel: gateway lags at fable5, everyone else
    // gets fable51 (2.1.257 launch default).
    expect(getDefaultFableModel()).toBe('claude-fable-5-1')
  })

  test('ANTHROPIC_DEFAULT_FABLE_MODEL overrides the default', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'my-custom-fable'
    expect(getDefaultFableModel()).toBe('my-custom-fable')
  })
})

describe('Gap-113a: pricing tiers', () => {
  test('fable51 uses tier_10_50_cache_read_0_25 (byte-verified values)', () => {
    // Official 2.1.258 ELF offset 12961200: {input:10, output:50,
    // cache_write_5m:12.5, cache_write_1h:20, cache_read:0.25, web:0.01}.
    expect(COST_TIER_10_50_CACHE_READ_0_25.inputTokens).toBe(10)
    expect(COST_TIER_10_50_CACHE_READ_0_25.outputTokens).toBe(50)
    expect(COST_TIER_10_50_CACHE_READ_0_25.promptCacheWriteTokens).toBe(12.5)
    expect(COST_TIER_10_50_CACHE_READ_0_25.promptCacheWrite1hTokens).toBe(20)
    expect(COST_TIER_10_50_CACHE_READ_0_25.promptCacheReadTokens).toBe(0.25)
    expect(COST_TIER_10_50_CACHE_READ_0_25.webSearchRequests).toBe(0.01)
    expect(MODEL_COSTS['claude-fable-5-1']).toBe(
      COST_TIER_10_50_CACHE_READ_0_25,
    )
  })

  test('fable5 uses tier_10_50 with cache_read 1', () => {
    // Official 2.1.258 ELF offset 12972407 (fable5 catalog entry carries
    // pricing:"tier_10_50").
    expect(COST_TIER_10_50.promptCacheReadTokens).toBe(1)
    expect(MODEL_COSTS['claude-fable-5']).toBe(COST_TIER_10_50)
  })
})

describe('Gap-113a: Vertex region table', () => {
  test('claude-fable-5-1 honors VERTEX_REGION_CLAUDE_FABLE_5_1', () => {
    // Official 2.1.258 ELF catalog: vertex_region_env_var
    // "VERTEX_REGION_CLAUDE_FABLE_5_1".
    process.env.VERTEX_REGION_CLAUDE_FABLE_5_1 = 'fable51-region'
    expect(getVertexRegionForModel('claude-fable-5-1')).toBe('fable51-region')
  })

  test('claude-fable-5 honors VERTEX_REGION_CLAUDE_FABLE_5', () => {
    process.env.VERTEX_REGION_CLAUDE_FABLE_5 = 'fable5-region'
    expect(getVertexRegionForModel('claude-fable-5')).toBe('fable5-region')
  })

  test('fable-5-1 does not leak into the fable-5 override (order matters)', () => {
    // startsWith prefix match: the -5-1 entry must precede the -5 entry.
    process.env.VERTEX_REGION_CLAUDE_FABLE_5_1 = 'r51'
    process.env.VERTEX_REGION_CLAUDE_FABLE_5 = 'r5'
    expect(getVertexRegionForModel('claude-fable-5-1')).toBe('r51')
    expect(getVertexRegionForModel('claude-fable-5')).toBe('r5')
  })

  test('the prior-round opus-4-8 drift fix resolves to its own env var', () => {
    process.env.VERTEX_REGION_CLAUDE_4_8_OPUS = 'opus48-region'
    expect(getVertexRegionForModel('claude-opus-4-8')).toBe('opus48-region')
  })
})

describe('Gap-113a: betas / context management', () => {
  test('fable family supports context management', () => {
    expect(modelSupportsContextManagement('claude-fable-5-1')).toBe(true)
    expect(modelSupportsContextManagement('claude-fable-5')).toBe(true)
    expect(
      modelSupportsContextManagement('us.anthropic.claude-fable-5-1'),
    ).toBe(true)
  })
})

describe('Gap-113a: commit attribution sanitization', () => {
  test('fable and mythos short names sanitize to their first-party ids', () => {
    expect(sanitizeModelName('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(sanitizeModelName('claude-fable-5')).toBe('claude-fable-5')
    expect(sanitizeModelName('claude-mythos-5-1')).toBe('claude-mythos-5-1')
    expect(sanitizeModelName('claude-mythos-5')).toBe('claude-mythos-5')
  })
})

describe('Gap-113a: knowledge cutoffs + latest-model-ids (source-verified)', () => {
  test('prompts.ts carries the specific-first cutoff branches', () => {
    const src = readFileSync(join(SRC, 'constants/prompts.ts'), 'utf-8')
    const fable51Idx = src.indexOf("fable-5-1")
    expect(fable51Idx).toBeGreaterThan(-1)
    // Byte-verified cutoffs: fable-5-1 June 2026, fable-5 January 2026.
    expect(src).toContain("'June 2026'")
    expect(src).toContain("'January 2026'")
    // The -5-1 cutoff branch must appear before the broader -5 branch
    // (substring trap, same as canonicalization).
    const cutoffSection = src.slice(src.indexOf('function getKnowledgeCutoff'))
    const idx51 = cutoffSection.indexOf('fable-5-1')
    const idx5 = cutoffSection.indexOf("'claude-fable-5'")
    expect(idx51).toBeGreaterThan(-1)
    expect(idx5).toBeGreaterThan(idx51)
  })

  test('CLAUDE_LATEST_MODEL_IDS advertises Fable 5.1 as the fable id', () => {
    const src = readFileSync(join(SRC, 'constants/prompts.ts'), 'utf-8')
    expect(src).toContain("fable: 'claude-fable-5-1'")
    expect(src).toContain("Fable 5.1: '${CLAUDE_LATEST_MODEL_IDS.fable}'")
  })

  test('the hooks schema example model ids moved to claude-sonnet-5', () => {
    const src = readFileSync(join(SRC, 'schemas/hooks.ts'), 'utf-8')
    expect(src).toContain('"claude-sonnet-5"')
    expect(src).not.toContain('"claude-sonnet-4-6"')
  })

  test('the /model picker row ports the official WZe wording', () => {
    const src = readFileSync(
      join(SRC, 'utils/model/modelOptions.ts'),
      'utf-8',
    )
    expect(src).toContain(
      'Fable 5.1 - most capable for your hardest and longest-running tasks',
    )
    expect(src).toContain(
      'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    )
  })
})

// ============================================================================
// Gap-113b — CLAUDE_CODE_SUBAGENT_MODEL_FORCE
// ============================================================================

describe('Gap-113b: CLAUDE_CODE_SUBAGENT_MODEL_FORCE semantics', () => {
  const PARENT = 'claude-fable-5-1'

  test('without FORCE the tool-specified model wins', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE
    const resolved = getAgentModel(undefined, PARENT, 'sonnet')
    expect(resolved).toBe('claude-sonnet-5')
  })

  test('FORCE voids the tool-specified model (falls back to parent)', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
    const resolved = getAgentModel(undefined, PARENT, 'sonnet')
    expect(resolved).toBe(PARENT)
  })

  test('FORCE voids the agent-definition model (falls back to parent)', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
    const resolved = getAgentModel('opus', PARENT)
    expect(resolved).toBe(PARENT)
  })

  test('without FORCE the agent-definition model wins', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE
    const resolved = getAgentModel('opus', PARENT)
    expect(resolved).toBe('claude-opus-5')
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL still outranks FORCE (env wins first)', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-4-5'
    const resolved = getAgentModel('opus', PARENT, 'sonnet')
    expect(resolved).toBe('claude-haiku-4-5')
  })

  test('falsy FORCE values do not force', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '0'
    const resolved = getAgentModel(undefined, PARENT, 'sonnet')
    expect(resolved).toBe('claude-sonnet-5')
  })
})

describe('Gap-113b: provider-managed env set', () => {
  test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is provider-managed', () => {
    // Official 2.1.258 ELF `Tg` set member (offset 12579700).
    expect(isProviderManagedEnvVar('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')).toBe(
      true,
    )
    expect(isProviderManagedEnvVar('claude_code_subagent_model_force')).toBe(
      true,
    )
  })
})

describe('Gap-113b: FORCE sites in the subagent surfaces (source-verified)', () => {
  test('agent.ts ports the official Cbn FORCE voiding', () => {
    const src = readFileSync(join(SRC, 'utils/model/agent.ts'), 'utf-8')
    expect(src).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
    expect(src).toContain('isForcedSubagentModel')
  })

  test('workflow primitives ignore per-agent model under FORCE', () => {
    const src = readFileSync(
      join(SRC, 'tools/WorkflowTool/primitives.ts'),
      'utf-8',
    )
    // Byte-verified log message (official 2.1.258 ELF offset 7904700).
    expect(src).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set')
    expect(src).toContain('Workflow agent model "')
  })

  test('AgentTool omits the model parameter from its schema under FORCE', () => {
    // Official `bpn` wrapper (offset 18856900):
    // a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ? n.omit({model:!0}) : n
    const src = readFileSync(
      join(SRC, 'tools/AgentTool/AgentTool.tsx'),
      'utf-8',
    )
    expect(src).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
    expect(src).toContain('backgroundGated.omit({ model: true })')
  })
})

// ============================================================================
// Gap-113c — Ctrl+E permission explainer removal
// ============================================================================

describe('Gap-113c: permission explainer subsystem removed', () => {
  test('the explainer files are deleted', () => {
    expect(
      existsSync(join(SRC, 'components/permissions/PermissionExplanation.tsx')),
    ).toBe(false)
    expect(
      existsSync(join(SRC, 'utils/permissions/permissionExplainer.ts')),
    ).toBe(false)
  })

  test('Bash/PowerShell prompts no longer advertise ctrl+e', () => {
    const bash = readFileSync(
      join(
        SRC,
        'components/permissions/BashPermissionRequest/BashPermissionRequest.tsx',
      ),
      'utf-8',
    )
    const ps = readFileSync(
      join(
        SRC,
        'components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx',
      ),
      'utf-8',
    )
    expect(bash).not.toContain('ctrl+e to')
    expect(ps).not.toContain('ctrl+e to')
    expect(bash).not.toContain('usePermissionExplainerUI')
    expect(ps).not.toContain('usePermissionExplainerUI')
  })

  test('the confirm:toggleExplanation keybinding is gone', () => {
    // The Gap-113c removal comments still mention the action name by way of
    // documentation, so assert on the live-code patterns, not the bare name.
    const bindings = readFileSync(
      join(SRC, 'keybindings/defaultBindings.ts'),
      'utf-8',
    )
    const schema = readFileSync(join(SRC, 'keybindings/schema.ts'), 'utf-8')
    expect(bindings).not.toContain("'ctrl+e': 'confirm:toggleExplanation'")
    expect(schema).not.toContain("'confirm:toggleExplanation',")
  })

  test('the permissionExplainerEnabled config key is gone', () => {
    // Assert on the live-code patterns: the type field and the persisted-key
    // list entry. The Gap-113c removal comment still mentions the key name.
    const config = readFileSync(join(SRC, 'utils/config.ts'), 'utf-8')
    expect(config).not.toContain('permissionExplainerEnabled?:')
    expect(config).not.toContain("'permissionExplainerEnabled',")
  })

  test('no explainer_visible analytics fields remain', () => {
    // The Gap-113c removal comment still mentions the removed field name, so
    // assert on the live-code patterns (payload key + hook parameter).
    const feedback = readFileSync(
      join(SRC, 'components/permissions/useShellPermissionFeedback.ts'),
      'utf-8',
    )
    expect(feedback).not.toContain('explainer_visible:')
    expect(feedback).not.toContain('explainerVisible')
  })
})
