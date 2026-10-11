// Repo-convention MACRO polyfill (harmless for this suite; keeps the file
// independent of load order in the shared test process).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getWorkflowSubagentModel,
  resolveWorkflowSubagentEffectiveModel,
} from '../workflowSubagentModel.js'
import { getAgentModel } from '../agent.js'
import { parseUserSpecifiedModel } from '../model.js'
import { setCachedSettingsForSource } from '../../settings/settingsCache.js'
import { _getProjectScopeBlockedEnvKeysForTesting } from '../../managedEnv.js'

/**
 * CC 2.1.296 (OCC-154 P2 #003): CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL.
 *
 * v296 adds a workflow-scoped subagent model override. Official surface
 * (all recovered verbatim from the 2.1.296 linux-x64 ELF):
 *
 * - Getter module `QTe` @215582922:
 *     function QTe(){let e=a.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL;
 *       if(!e||e.toLowerCase()==="inherit")return;
 *       if(a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE&&
 *          XFe("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL")?.trim()!==e)return;
 *       return e}
 *   i.e. unset/empty/'inherit' → undefined; under SUBAGENT_MODEL_FORCE the
 *   override is honored ONLY when the policy env composition
 *   (XFe(e)=Iko(M(),e), M()=ji().lastPolicyEnvComposition @209449416)
 *   carries the same value (trimmed) — a self-set env does not survive FORCE.
 *
 * - Resolver integration `YU` @216345215 region:
 *     Y=y?.inWorkflowRun?QTe():void 0;
 *     if([e,r]=Y!==void 0?[void 0,void 0]:rAt(e,r),r){...}
 *     ...
 *     let he=Y??jte(); if(he==="inherit")return S(); ...
 *   (jte()=CLAUDE_CODE_SUBAGENT_MODEL||"inherit") — inside a workflow run a
 *   defined Y voids BOTH the frontmatter (e) and tool-specified (r) models
 *   and outranks the general subagent env. Remote-path call site @228342056
 *   confirms the context shape `YU(...,{inWorkflowRun:p!==void 0})`.
 *
 * - Workflow runner `Bt` @228307864:
 *     function Bt(R){if(R)return R;let j=QTe();if(j!==void 0)return j;
 *       let G=jte();return G!=="inherit"?G:U.options.mainLoopModel}
 *   — explicit > workflow env > general env (≠inherit) > main loop.
 *
 * - agent() suppression @228311306 (two arms in v296; v295 had the FORCE
 *   arm only, with the wording "...FORCE is set" @227975827 — v296 rewords
 *   it to "...FORCE is on"):
 *     let kt=QTe()!==void 0?"CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL is set"
 *       :a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE
 *         ?"CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on":void 0;
 *     if(J?.model!==void 0&&kt!==void 0)
 *       t(`Workflow agent model "${J.model}" ignored: ${kt}`),J.model=void 0;
 *
 * - Scrubber allowlist `obr` @211233225: the token is added to the managed
 *   key set behind `ee(e)` in the settings-env scrubber `m(e,n,i,E)` — the
 *   v295 set (@210502979 tail) ends at CLAUDE_CODE_ENABLE_CFC, v296 appends
 *   CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL. Project/local settings cannot set
 *   it. OCC counterpart: PROJECT_SCOPE_BLOCKED_ENV_KEYS (managedEnv.ts).
 *
 * OCC adaptations (documented, not invented):
 * - XFe/M() policy composition → getSettingsForSource('policySettings').env
 *   (the source OCC's managedEnv applies to process.env last).
 * - The FORCE checks use isEnvTruthy, consistent with OCC's Gap-113b FORCE
 *   handling (the official uses raw env-string truthiness).
 * - inWorkflowRun signal → runAgent's querySource === 'workflow' (the value
 *   WorkflowTool/primitives.ts already passes when spawning).
 *
 * Policy-env seeding follows disableWebFetch285.test.ts
 * (setCachedSettingsForSource public cache API, reset to null after).
 */

const WORKFLOW_ENV = 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL'
const GENERAL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'

const ENV_KEYS = [
  WORKFLOW_ENV,
  GENERAL_ENV,
  FORCE_ENV,
  'USER_TYPE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

afterAll(() => {
  setCachedSettingsForSource('policySettings', null)
})

/** Seed the policy-env composition surface (official M() counterpart). */
function seedPolicyEnv(env: Record<string, string> | undefined): void {
  setCachedSettingsForSource(
    'policySettings',
    env === undefined ? null : ({ env } as never),
  )
}

// --- (a) getter: ≡ official QTe ---------------------------------------------

describe('getWorkflowSubagentModel (≡QTe @215582922)', () => {
  test('unset → undefined', () => {
    expect(getWorkflowSubagentModel()).toBeUndefined()
  })

  test('empty string → undefined (!e arm)', () => {
    process.env[WORKFLOW_ENV] = ''
    expect(getWorkflowSubagentModel()).toBeUndefined()
  })

  test('"inherit" → undefined (case-insensitive toLowerCase check)', () => {
    process.env[WORKFLOW_ENV] = 'inherit'
    expect(getWorkflowSubagentModel()).toBeUndefined()
    process.env[WORKFLOW_ENV] = 'INHERIT'
    expect(getWorkflowSubagentModel()).toBeUndefined()
    process.env[WORKFLOW_ENV] = 'Inherit'
    expect(getWorkflowSubagentModel()).toBeUndefined()
  })

  test('concrete model → returned verbatim', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    expect(getWorkflowSubagentModel()).toBe('claude-haiku-4-5')
  })

  test('FORCE on + no policy env → undefined (guard: undefined?.trim() !== e)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[FORCE_ENV] = '1'
    seedPolicyEnv(undefined)
    expect(getWorkflowSubagentModel()).toBeUndefined()
  })

  test('FORCE on + policy env equal → value honored (policy-provided)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[FORCE_ENV] = '1'
    seedPolicyEnv({ [WORKFLOW_ENV]: 'claude-haiku-4-5' })
    expect(getWorkflowSubagentModel()).toBe('claude-haiku-4-5')
  })

  test('FORCE on + policy env equal after trim → value honored (?.trim() !== e)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[FORCE_ENV] = '1'
    seedPolicyEnv({ [WORKFLOW_ENV]: '  claude-haiku-4-5  ' })
    expect(getWorkflowSubagentModel()).toBe('claude-haiku-4-5')
  })

  test('FORCE on + policy env differs → undefined (self-set env does not survive FORCE)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[FORCE_ENV] = '1'
    seedPolicyEnv({ [WORKFLOW_ENV]: 'claude-opus-5' })
    expect(getWorkflowSubagentModel()).toBeUndefined()
  })

  test('FORCE unset → guard skipped, no policy needed', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    seedPolicyEnv(undefined)
    expect(getWorkflowSubagentModel()).toBe('claude-haiku-4-5')
  })
})

// --- (b) resolver: ≡ official YU Y-arm ---------------------------------------

describe('getAgentModel inWorkflowRun (≡YU: [e,r]=Y!==void 0?[void 0,void 0], he=Y??jte())', () => {
  const PARENT = 'claude-sonnet-4-5'

  test('inWorkflowRun + override → override wins, tool+frontmatter voided', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    const resolved = getAgentModel(
      'claude-opus-5', // frontmatter (e) — voided when Y defined
      PARENT,
      'sonnet', // tool-specified (r) — voided when Y defined
      'default',
      true,
    )
    expect(resolved).toBe('claude-haiku-4-5')
  })

  test('inWorkflowRun + override beats general SUBAGENT_MODEL env (he=Y??jte())', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[GENERAL_ENV] = 'claude-opus-5'
    const resolved = getAgentModel(undefined, PARENT, undefined, 'default', true)
    expect(resolved).toBe('claude-haiku-4-5')
  })

  test('inWorkflowRun + override="inherit" → QTe filter → frontmatter honored', () => {
    process.env[WORKFLOW_ENV] = 'inherit'
    const resolved = getAgentModel(
      'claude-haiku-4-5',
      PARENT,
      undefined,
      'default',
      true,
    )
    expect(resolved).toBe('claude-haiku-4-5')
  })

  test('inWorkflowRun + override="inherit" + general env → general env applies', () => {
    process.env[WORKFLOW_ENV] = 'INHERIT'
    process.env[GENERAL_ENV] = 'claude-opus-5'
    const resolved = getAgentModel(
      'claude-haiku-4-5',
      PARENT,
      undefined,
      'default',
      true,
    )
    expect(resolved).toBe('claude-opus-5')
  })

  test('inWorkflowRun + only general env → existing env-first branch unchanged', () => {
    process.env[GENERAL_ENV] = 'claude-opus-5'
    const resolved = getAgentModel(
      'claude-haiku-4-5',
      PARENT,
      undefined,
      'default',
      true,
    )
    expect(resolved).toBe('claude-opus-5')
  })

  test('NOT inWorkflowRun → override env is inert (frontmatter honored)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    const resolved = getAgentModel('claude-opus-5', PARENT, undefined, 'default')
    expect(resolved).toBe('claude-opus-5')
  })

  test('NOT inWorkflowRun (explicit false) → override inert, no env → tool model', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    const resolved = getAgentModel(undefined, PARENT, 'haiku', 'default', false)
    // Tool-model branch resolves the alias through the normal path — the
    // workflow override must not have intercepted it.
    expect(resolved).toBe(parseUserSpecifiedModel('haiku'))
    expect(resolved).not.toBe('claude-haiku-4-5')
  })
})

// --- (c) effective-model chain: ≡ official Bt --------------------------------

describe('resolveWorkflowSubagentEffectiveModel (≡Bt @228307864)', () => {
  const MAIN = 'claude-sonnet-4-5'

  test('explicit model wins over both envs (if(R)return R)', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[GENERAL_ENV] = 'claude-opus-5'
    expect(
      resolveWorkflowSubagentEffectiveModel('claude-fable-5', MAIN),
    ).toBe('claude-fable-5')
  })

  test('workflow env beats general env', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    process.env[GENERAL_ENV] = 'claude-opus-5'
    expect(resolveWorkflowSubagentEffectiveModel(undefined, MAIN)).toBe(
      'claude-haiku-4-5',
    )
  })

  test('general env (≠inherit) beats main loop', () => {
    process.env[GENERAL_ENV] = 'claude-opus-5'
    expect(resolveWorkflowSubagentEffectiveModel(undefined, MAIN)).toBe(
      'claude-opus-5',
    )
  })

  test('general env "inherit" → main loop (G!=="inherit" gate)', () => {
    process.env[GENERAL_ENV] = 'inherit'
    expect(resolveWorkflowSubagentEffectiveModel(undefined, MAIN)).toBe(MAIN)
  })

  test('no envs → main loop', () => {
    expect(resolveWorkflowSubagentEffectiveModel(undefined, MAIN)).toBe(MAIN)
  })

  test('empty explicit model falls through (official truthiness if(R))', () => {
    process.env[WORKFLOW_ENV] = 'claude-haiku-4-5'
    expect(resolveWorkflowSubagentEffectiveModel('', MAIN)).toBe(
      'claude-haiku-4-5',
    )
  })
})

// --- (d) wiring pins -----------------------------------------------------------

describe('2.1.296 #003 wiring', () => {
  test('scrubber blocklist gains the token (≡obr @211233225 addition)', () => {
    expect(
      _getProjectScopeBlockedEnvKeysForTesting().has(WORKFLOW_ENV),
    ).toBe(true)
  })

  test('runAgent threads inWorkflowRun from querySource (source-anchored pin)', () => {
    // runAgent.ts cannot be imported hermetically (huge module graph) —
    // pinned with source-anchored readFileSync assertions (established OCC
    // convention, see dangerousRm296.test.ts).
    const src = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'tools', 'AgentTool', 'runAgent.ts'),
      'utf8',
    )
    const threaded =
      /const resolvedAgentModel = getAgentModel\(\s*agentDefinition\.model,\s*toolUseContext\.options\.mainLoopModel,\s*model,\s*permissionMode,\s*(?:\/\/[^\n]*\n\s*)*querySource === 'workflow',\s*\)/g
    expect((src.match(threaded) ?? []).length).toBe(1)
  })

  test('primitives suppression is the official two-arm kt (source-anchored pin)', () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        'tools',
        'WorkflowTool',
        'primitives.ts',
      ),
      'utf8',
    )
    // v296 arm texts (byte-exact message fragments).
    expect(src).toContain('CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL is set')
    expect(src).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on')
    // The v295-era static FORCE wording must be gone.
    expect(src).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set')
    // The effective-model chain routes through the Bt counterpart.
    expect(src).toContain('resolveWorkflowSubagentEffectiveModel')
  })
})

// Absorbed from the OCC-113 track suite (R2 #003 switch — main's env
// registration coverage kept as incremental cases; the token lives in
// managedEnvConstants.ts on that track).
describe('2.1.296 #003 — env registration (managed-env + safe-env lists)', () => {
  test('isProviderManagedEnvVar recognizes WORKFLOW_SUBAGENT_MODEL (official @208771578)', async () => {
    const { isProviderManagedEnvVar } = await import(
      '../../managedEnvConstants.js'
    )
    expect(isProviderManagedEnvVar(WORKFLOW_ENV)).toBe(true)
  })

  test('SAFE_ENV_VARS includes WORKFLOW_SUBAGENT_MODEL (same class as SUBAGENT_MODEL)', async () => {
    const { SAFE_ENV_VARS } = await import('../../managedEnvConstants.js')
    expect(SAFE_ENV_VARS.has(WORKFLOW_ENV)).toBe(true)
    expect(SAFE_ENV_VARS.has('CLAUDE_CODE_SUBAGENT_MODEL')).toBe(true)
  })
})
