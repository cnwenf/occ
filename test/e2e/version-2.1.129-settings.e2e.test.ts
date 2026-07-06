import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * Settings-gap e2e for 4 gaps ported toward the official claude-code 2.1.200
 * binary. Each gap is verified via source-grep (the schema field + exact
 * binary-confirmed wording) plus a runtime import (TDZ/parse check) of the
 * new settings helpers.
 *
 * Gaps covered:
 *   C2  (2.1.129) — skillOverrides setting (on/name-only/user-invocable-only/off)
 *                   + override lookup helper
 *   C3  (2.1.169) — disableBundledSkills setting + CLAUDE_CODE_DISABLE_BUNDLED_SKILLS env
 *   A6  (2.1.175) — enforceAvailableModels: default-model constraint + cascade-trust
 *   A11 (2.1.187+2.1.196) — org-configured model restrictions + 'Org default' label
 *
 * Exact wording verified against /tmp/occ-audit/claude.strings (2.1.200).
 */

const TYPES = `${REPO_ROOT}/src/utils/settings/types.ts`
const SETTINGS = `${REPO_ROOT}/src/utils/settings/settings.ts`
const MODEL = `${REPO_ROOT}/src/utils/model/model.ts`

// ---------------------------------------------------------------------------
// C2 (2.1.129) — skillOverrides setting + override lookup
// Binary: skillOverrides:z.record(z.string(),z.enum(["on","name-only",
//         "user-invocable-only","off"])).optional().describe('Per-skill listing
//         overrides keyed by skill name. "name-only" lists the skill without its
//         description; "user-invocable-only" hides it from the model but keeps
//         /name; "off" hides it from both. Absent = on.')
// ---------------------------------------------------------------------------
describe('C2 (2.1.129) skillOverrides setting (e2e)', () => {
  test('types.ts declares the skillOverrides enum + exact describe', async () => {
    const src = await Bun.file(TYPES).text()
    expect(src).toContain('skillOverrides:')
    // Exact enum values from the binary.
    expect(src).toContain("'on'")
    expect(src).toContain("'name-only'")
    expect(src).toContain("'user-invocable-only'")
    expect(src).toContain("'off'")
    // Exact describe fragment (binary-confirmed wording).
    expect(src).toContain('Per-skill listing overrides keyed by skill name')
    expect(src).toContain('"user-invocable-only" hides it from the model but keeps /name')
    expect(src).toContain('Absent = on.')
  })

  test('settings.ts exposes getSkillOverride lookup helper', async () => {
    const src = await Bun.file(SETTINGS).text()
    expect(src).toContain('export function getSkillOverride(')
    expect(src).toContain("overrides[name] ??")
    // The helper reads merged skillOverrides (official c=a.skillOverrides?.[e.name]).
    expect(src).toContain('getInitialSettings().skillOverrides')
  })
})

// ---------------------------------------------------------------------------
// C3 (2.1.169) — disableBundledSkills setting + env var
// Binary: disableBundledSkills:z.boolean().optional().describe("Disable the
//         skills and workflows that ship with Claude Code: bundled skills and
//         workflows are removed entirely; built-in slash commands stay typable
//         but are hidden from the model. Plugins, .claude/skills/, and
//         .claude/commands/ are unaffected. Equivalent to
//         CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1.")
//         Mz: env OR setting === true
// ---------------------------------------------------------------------------
describe('C3 (2.1.169) disableBundledSkills setting + env (e2e)', () => {
  test('types.ts declares disableBundledSkills + exact describe', async () => {
    const src = await Bun.file(TYPES).text()
    expect(src).toContain('disableBundledSkills: z')
    expect(src).toContain('Disable the skills and workflows that ship with Claude Code')
    expect(src).toContain('bundled skills and workflows are removed entirely')
    expect(src).toContain('Equivalent to CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1.')
  })

  test('settings.ts isDisableBundledSkills honors env + setting (Mz)', async () => {
    const src = await Bun.file(SETTINGS).text()
    expect(src).toContain('export function isDisableBundledSkills()')
    expect(src).toContain('CLAUDE_CODE_DISABLE_BUNDLED_SKILLS')
    expect(src).toContain('disableBundledSkills === true')
  })

  test('runtime: env var flips isDisableBundledSkills to true', async () => {
    const script = `
process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
const { isDisableBundledSkills } = await import("${SETTINGS}");
console.log(JSON.stringify({ env: isDisableBundledSkills() }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.env).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A6 (2.1.175) — enforceAvailableModels: default-model constraint + cascade-trust
// Binary describe: "When true and availableModels is a non-empty array, the
//   Default model selection is also constrained: if the default model for the
//   user tier is not in availableModels, Default resolves to the first allowed
//   availableModels entry instead. Has no effect when availableModels is unset
//   or an empty array. Typically set in managed settings by enterprise
//   administrators."
// ---------------------------------------------------------------------------
describe('A6 (2.1.175) enforceAvailableModels default-model constraint (e2e)', () => {
  test('types.ts describe matches binary wording exactly', async () => {
    const src = await Bun.file(TYPES).text()
    expect(src).toContain('enforceAvailableModels: z')
    expect(src).toContain(
      'When true and availableModels is a non-empty array',
    )
    expect(src).toContain(
      'Default resolves to the first allowed availableModels entry instead',
    )
    expect(src).toContain(
      'Has no effect when availableModels is unset or an empty array',
    )
    expect(src).toContain(
      'Typically set in managed settings by enterprise administrators',
    )
  })

  test('settings.ts exposes getEnforceAvailableModels (cascade-trust noted)', async () => {
    const src = await Bun.file(SETTINGS).text()
    expect(src).toContain('export function getEnforceAvailableModels()')
    expect(src).toContain('enforceAvailableModels === true')
    // Cascade-trust policy-failure refusal documented as a follow-up.
    expect(src).toContain('cascade-trust')
  })

  test('model.ts wires the default-model constraint (first allowed entry)', async () => {
    const src = await Bun.file(MODEL).text()
    expect(src).toContain('enforceDefaultModelAllowlist')
    expect(src).toContain('getEnforceAvailableModels()')
    expect(src).toContain('isModelAllowed(setting)')
    expect(src).toContain('availableModels[0]')
  })

  test('runtime: getEnforceAvailableModels defaults to false (no setting)', async () => {
    const script = `
delete process.env.CLAUDE_CODE_ENFORCE_AVAILABLE_MODELS;
const { getEnforceAvailableModels } = await import("${SETTINGS}");
console.log(JSON.stringify({ flag: getEnforceAvailableModels() }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.flag).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A11 (2.1.187+2.1.196) — org-configured model restrictions + 'Org default' label
// Binary: qFa() => " \xB7 Org default"; m5()=>eue()=>zVr() reads
//         orgModelDefaultCache ({name,updated_at,data_source,
//         override_user_selection}); restriction reason: "...is not permitted
//         by the org model restrictions (availableModels allowlist or
//         model_access entitlement)". NOTE: the binary has NO "Role default"
//         (only "Org default" + "tier default").
// ---------------------------------------------------------------------------
describe("A11 (2.1.187+2.1.196) org model restrictions + 'Org default' label (e2e)", () => {
  test('settings.ts exposes the Org default label + restriction reason', async () => {
    const src = await Bun.file(SETTINGS).text()
    // Exact label suffix from the binary qFa().
    expect(src).toContain("export const ORG_DEFAULT_MODEL_LABEL = ' · Org default'")
    expect(src).toContain('export function getOrgDefaultModel()')
    expect(src).toContain('orgModelDefaultCache')
    // Exact restriction-reason fragment from the binary.
    expect(src).toContain(
      'is not permitted by the org model restrictions (availableModels allowlist or model_access entitlement)',
    )
  })

  test('runtime: ORG_DEFAULT_MODEL_LABEL matches binary qFa() exactly', async () => {
    const script = `
const { ORG_DEFAULT_MODEL_LABEL, getOrgDefaultModel } = await import("${SETTINGS}");
console.log(JSON.stringify({ label: ORG_DEFAULT_MODEL_LABEL, def: getOrgDefaultModel() }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    // qFa() in the binary returns " \xB7 Org default" (\xB7 = middot).
    expect(out.label).toBe(' · Org default')
    // OCC has no orgModelDefaultCache yet → null until server plumbing lands.
    expect(out.def).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TDZ / parse check: importing the settings module must not throw.
// ---------------------------------------------------------------------------
describe('settings module parse/TDZ check (e2e)', () => {
  test('importing settings.ts + types.ts does not throw', async () => {
    const script = `
await import("${TYPES}");
const s = await import("${SETTINGS}");
const ok = typeof s.getSkillOverride === "function" && typeof s.isDisableBundledSkills === "function" && typeof s.getEnforceAvailableModels === "function" && typeof s.getOrgDefaultModel === "function";
console.log(JSON.stringify({ ok }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.ok).toBe(true)
  })
})
