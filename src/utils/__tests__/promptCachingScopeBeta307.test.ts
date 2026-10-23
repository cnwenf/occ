import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setIsInteractive } from '../../bootstrap/state.js'
import { PROMPT_CACHING_SCOPE_BETA_HEADER } from '../../constants/betas.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  clearBetasCaches,
  getAllModelBetas,
  shouldIncludeFirstPartyOnlyBetas,
  shouldIncludePromptCachingScopeBeta,
} from '../betas.js'
import { resetSettingsCache } from '../settings/settingsCache.js'

/**
 * CC 2.1.307 (A4): the prompt-caching-scope beta gets its OWN gate (official
 * `D8`), replacing the shared firstPartyOnlyBetas gate at the betas.ts push
 * site. Byte-verified from the v307 ELF text dump (new307.txt):
 *
 *   function D8(){if(!Qy())return!1;if(!Ni())return!1;let e=Re();return e==="firstParty"||e==="anthropicAws"}   @42238989
 *   function Qy(){return $Y()&&!L1()}                                          @35197174
 *   function $Y(){let e=Re();return e==="firstParty"||WL(e)||e==="foundry"}    @35196965 (WL: anthropicAws|anthropicGoogleCloud)
 *   function L1(){return a.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS||N1()}       (N1: hipaa taint)
 *   function Ni(){if(Qce())return!0;return Hu()}                               @23761084 (≡ isFirstPartyAnthropicBaseUrl)
 *   beta table entry: {beta:J2e,when:()=>D8()}                                 @42239857
 *   J2e = "prompt-caching-scope-2026-01-05"                                    @35194481
 *
 * Net effect vs v306: the header is suppressed behind a custom
 * ANTHROPIC_BASE_URL gateway (Ni false) and on Foundry (provider arm), where
 * it has no effect.
 *
 * D8 reduces to: provider ∈ {firstParty, anthropicAws} (the $Y set ∩ the D8
 * provider arm; foundry and anthropicGoogleCloud drop out) AND NOT
 * DISABLE_EXPERIMENTAL_BETAS AND NOT hipaa-taint AND first-party base url.
 * OCC mapping notes:
 * - 'anthropicAws' → OCC provider 'anthropic_aws' (CLAUDE_CODE_USE_ANTHROPIC_AWS).
 *   OCC's shouldIncludeFirstPartyOnlyBetas() predates that provider and omits
 *   it, so this predicate inlines the DISABLE_EXPERIMENTAL_BETAS arm instead of
 *   reusing it — otherwise D8's anthropicAws arm would be dead, diverging from
 *   the official.
 * - Official D8 excludes anthropicGoogleCloud; OCC folds googleCloud into
 *   firstParty (no separate provider surface) — documented acceptable divergence.
 * - The hipaa arm of L1 is omitted — OCC has no classifier taint registry
 *   (same documented omission as shouldSendExtendedCacheTtlBeta).
 */

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'USER_TYPE',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'USE_API_CONTEXT_MANAGEMENT',
  'USE_CONNECTOR_TEXT_SUMMARIZATION',
  'DISABLE_INTERLEAVED_THINKING',
  'ANTHROPIC_BETAS',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpConfigDir: string
let prevConfigDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Deterministic firstParty + API-key auth (assume-first-party keeps
  // isFirstPartyAnthropicBaseUrl() true unless a test overrides the base url).
  setIsInteractive(false)
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-prompt-caching-scope-307-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  clearBetasCaches()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  clearBetasCaches()
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

describe('CC 2.1.307 A4 — shouldIncludePromptCachingScopeBeta (official D8)', () => {
  test('true on stock firstParty (assume-first-party flag, no disable)', () => {
    // Assert — Arrange is beforeEach
    expect(shouldIncludePromptCachingScopeBeta()).toBe(true)
  })

  test('true on plain firstParty without the assume flag (no base url set)', () => {
    // Arrange — Ni()/Hu(): unset ANTHROPIC_BASE_URL → first-party
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(true)
  })

  test('false behind a custom ANTHROPIC_BASE_URL gateway (official Ni/Hu)', () => {
    // Arrange — the v306 gate kept sending the header here; v307 D8 suppresses
    // it because the gateway may reject unknown betas.
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(false)
  })

  test('true when base url is api.anthropic.com explicitly', () => {
    // Arrange
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(true)
  })

  test('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL overrides a custom gateway (official Qce)', () => {
    // Arrange — assume flag set in beforeEach, gateway base url added here
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(true)
  })

  test('false on foundry (v307 drops foundry from this beta; v306 sent it)', () => {
    // Arrange — D8 provider arm: e==="firstParty"||e==="anthropicAws"; foundry
    // is in $Y (so Qy passes) but NOT in D8's final arm.
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(false)
    // The v306 gate would still have sent it — proves this is a real delta.
    expect(shouldIncludeFirstPartyOnlyBetas()).toBe(true)
  })

  test('true on anthropic_aws (official D8 arm: e==="anthropicAws")', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(true)
    // OCC's older firstPartyOnly gate OMITS this provider — the divergence A4
    // must not inherit.
    expect(shouldIncludeFirstPartyOnlyBetas()).toBe(false)
  })

  test('false on bedrock', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(false)
  })

  test('false on vertex', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_VERTEX = '1'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(false)
  })

  test('false when CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set (official L1)', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'

    // Act & Assert
    expect(shouldIncludePromptCachingScopeBeta()).toBe(false)
  })
})

describe('CC 2.1.307 A4 — getAllModelBetas push site uses the D8 gate', () => {
  test('header present on stock firstParty', () => {
    // Act
    const betas = getAllModelBetas('claude-sonnet-4-6')

    // Assert
    expect(betas).toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('header suppressed behind a custom base url gateway', () => {
    // Arrange
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
    clearBetasCaches()

    // Act
    const betas = getAllModelBetas('claude-sonnet-4-6')

    // Assert
    expect(betas).not.toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('header suppressed on foundry (v306 behavior changed)', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    clearBetasCaches()

    // Act
    const betas = getAllModelBetas('claude-sonnet-4-6')

    // Assert — foundry keeps its WEB_SEARCH beta but loses caching-scope
    expect(betas).not.toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('header present on anthropic_aws', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    clearBetasCaches()

    // Act
    const betas = getAllModelBetas('claude-sonnet-4-6')

    // Assert
    expect(betas).toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('header suppressed by CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    clearBetasCaches()

    // Act
    const betas = getAllModelBetas('claude-sonnet-4-6')

    // Assert
    expect(betas).not.toContain(PROMPT_CACHING_SCOPE_BETA_HEADER)
  })

  test('beta header value is the official prompt-caching-scope-2026-01-05', () => {
    // Assert — official J2e=k("prompt_caching_scope","prompt-caching-scope-2026-01-05") @35194481
    expect(PROMPT_CACHING_SCOPE_BETA_HEADER).toBe(
      'prompt-caching-scope-2026-01-05',
    )
  })
})

describe('CC 2.1.307 A4 — global-cache second push site (claude.ts) untouched', () => {
  test('claude.ts still gates its compensating push on shouldUseGlobalCacheScope, not the D8 gate', () => {
    // Arrange — the official v307 second site is UNCHANGED (byte-verified: it
    // still rides the global-cache-scope feature, not D8), so OCC must not
    // rewire it. Source-level guard: the gate text survives and the new
    // predicate never leaked into claude.ts.
    const source = readFileSync(
      join(import.meta.dir, '../../services/api/claude.ts'),
      'utf8',
    )

    // Act & Assert
    expect(source).toContain(
      'useGlobalCacheFeature &&\n    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)',
    )
    expect(source).not.toContain('shouldIncludePromptCachingScopeBeta')
  })
})
