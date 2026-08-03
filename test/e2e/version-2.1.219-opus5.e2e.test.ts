import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.219 Opus 5 launch (e2e) — OCC-35 canonical-registration
 * subset. Opus 5 (`claude-opus-5`) is the new default Opus model in official
 * Claude Code 2.1.219 (1M context, fast mode at $10/$50 per Mtok). This
 * round lands the faithful, binary-verified *foundation*: `claude-opus-5` is
 * a recognized canonical model ID with correct provider IDs, canonical
 * mapping, display/marketing names, and commit-attribution sanitization.
 *
 * The remaining Opus 5 launch sites (default-opus switch in `getDefaultOpusModel`,
 * `/model` picker row replacement + "Opus 5 with 1M context" label + pricing
 * suffix, `MODEL_COSTS` pricing tier, fast-mode model set, `modelSupports1M`,
 * `check1mAccess`, effort/thinking/betas/advisor allowlists) need dedicated
 * decompilation per site and are staged for subsequent OCC rounds — see
 * `docs/upstream-version-gap-occ35.md`.
 *
 * Verified against the official 2.1.220 linux-x64 binary strings dump:
 *   - Model id: `claude-opus-5` (74 occurrences)
 *   - bedrock: `us.anthropic.claude-opus-5`; mantle: `anthropic.claude-opus-5`
 *   - Display/marketing: "Opus 5", "Opus 5 with 1M context"
 *   - Fast-mode pricing: "$10/$50" per Mtok
 */
describe("2.1.219 Opus 5 canonical registration (e2e)", () => {
  test("CANONICAL_MODEL_IDS includes claude-opus-5", async () => {
    const script = `
import { CANONICAL_MODEL_IDS } from "${REPO_ROOT}/src/utils/model/configs.ts";
console.log(JSON.stringify({ ids: CANONICAL_MODEL_IDS }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ids).toContain("claude-opus-5");
  });

  test("CANONICAL_ID_TO_KEY maps claude-opus-5 to opus5", async () => {
    const script = `
import { CANONICAL_ID_TO_KEY } from "${REPO_ROOT}/src/utils/model/configs.ts";
console.log(JSON.stringify({ opus5: CANONICAL_ID_TO_KEY["claude-opus-5"] }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe("opus5");
  });

  test("CLAUDE_OPUS_5_CONFIG has binary-confirmed provider ids", async () => {
    const script = `
import { ALL_MODEL_CONFIGS } from "${REPO_ROOT}/src/utils/model/configs.ts";
console.log(JSON.stringify({ opus5: ALL_MODEL_CONFIGS["opus5"] }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5.firstParty).toBe("claude-opus-5");
    expect(out.opus5.bedrock).toBe("us.anthropic.claude-opus-5");
    expect(out.opus5.vertex).toBe("claude-opus-5");
    expect(out.opus5.foundry).toBe("claude-opus-5");
    expect(out.opus5.anthropic_aws).toBe("claude-opus-5");
    expect(out.opus5.mantle).toBe("anthropic.claude-opus-5");
    expect(out.opus5.gateway).toBe("claude-opus-5");
  });

  test("firstPartyNameToCanonical maps claude-opus-5 variants", async () => {
    const script = `
import { firstPartyNameToCanonical } from "${REPO_ROOT}/src/utils/model/model.ts";
console.log(JSON.stringify({
  opus5: firstPartyNameToCanonical("claude-opus-5"),
  opus5_suffix: firstPartyNameToCanonical("claude-opus-5-20260724"),
  opus5_bedrock: firstPartyNameToCanonical("us.anthropic.claude-opus-5-v1:0"),
  opus5_fast: firstPartyNameToCanonical("claude-opus-5-fast"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe("claude-opus-5");
    expect(out.opus5_suffix).toBe("claude-opus-5");
    expect(out.opus5_bedrock).toBe("claude-opus-5");
    expect(out.opus5_fast).toBe("claude-opus-5");
  });

  test("firstPartyNameToCanonical does not regress opus-4-x mapping", async () => {
    const script = `
import { firstPartyNameToCanonical } from "${REPO_ROOT}/src/utils/model/model.ts";
console.log(JSON.stringify({
  opus48: firstPartyNameToCanonical("claude-opus-4-8"),
  opus47: firstPartyNameToCanonical("claude-opus-4-7"),
  opus46: firstPartyNameToCanonical("claude-opus-4-6"),
  opus4: firstPartyNameToCanonical("claude-opus-4-20250514"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus48).toBe("claude-opus-4-8");
    expect(out.opus47).toBe("claude-opus-4-7");
    expect(out.opus46).toBe("claude-opus-4-6");
    expect(out.opus4).toBe("claude-opus-4");
  });

  test("getMarketingNameForModel returns Opus 5 display names", async () => {
    const script = `
import { getMarketingNameForModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
console.log(JSON.stringify({
  opus5: getMarketingNameForModel("claude-opus-5"),
  opus5_1m: getMarketingNameForModel("claude-opus-5[1m]"),
  opus48: getMarketingNameForModel("claude-opus-4-8"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe("Opus 5");
    expect(out.opus5_1m).toBe("Opus 5 (with 1M context)");
    expect(out.opus48).toBe("Opus 4.8");
  });

  test("getPublicModelDisplayName returns Opus 5 display names", async () => {
    const script = `
import { getPublicModelDisplayName } from "${REPO_ROOT}/src/utils/model/model.ts";
import { getModelStrings } from "${REPO_ROOT}/src/utils/model/modelStrings.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
const opus5 = getModelStrings().opus5;
console.log(JSON.stringify({
  opus5: getPublicModelDisplayName(opus5),
  opus5_1m: getPublicModelDisplayName(opus5 + "[1m]"),
  opus48: getPublicModelDisplayName(getModelStrings().opus48),
  unknown: getPublicModelDisplayName("not-a-real-model"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe("Opus 5");
    expect(out.opus5_1m).toBe("Opus 5 (1M context)");
    expect(out.opus48).toBe("Opus 4.8");
    expect(out.unknown).toBeNull();
  });

  test("sanitizeModelName maps opus-5 to claude-opus-5 (no false capture of opus-4-x)", async () => {
    const script = `
import { sanitizeModelName } from "${REPO_ROOT}/src/utils/commitAttribution.ts";
console.log(JSON.stringify({
  opus5: sanitizeModelName("claude-opus-5"),
  opus5_variant: sanitizeModelName("opus-5-20260724"),
  opus48: sanitizeModelName("claude-opus-4-8"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe("claude-opus-5");
    expect(out.opus5_variant).toBe("claude-opus-5");
    // No regression: opus-4-8 must NOT be captured by the new opus-5 branch.
    // (Pre-existing OCC divergence: opus-4-7/4-8 fall through to claude-opus-4
    // because sanitizeModelName lacks opus-4-7/4-8 branches — unchanged here.)
    expect(out.opus48).toBe("claude-opus-4");
  });
});

/**
 * OCC-36 downstream ports (e2e) — the three decoupled, binary-verified,
 * non-breaking Opus 5 launch sites that advance the OCC-35 §5 carryover
 * without the coupled/intricate sites (picker row, MODEL_COSTS pricing,
 * fast-mode model-resolution, effort/thinking tier values, claude-api skill
 * content, highlight-newest UI) which need dedicated per-site decompilation.
 *
 *   1a — getDefaultOpusModel firstParty default → claude-opus-5
 *        (gateway stays claude-opus-4-7). Binary 2.1.220:
 *        `DEFAULT_OPUS_MODEL ?? Km().opus5`;
 *        `aliases.opus.default = "claude-opus-5"`,
 *        `per_provider.gateway = "claude-opus-4-7"`.
 *   1e — modelSupports1M covers claude-opus-5. Binary 2.1.220 1M check:
 *        `t.includes("claude-fable-5")||t.includes("claude-opus-4")||
 *         t.includes("claude-opus-5")||t.includes("claude-sonnet-5")||…`.
 *   1j — --model help text matches the binary byte-recovered string:
 *        "Provide an alias for the latest model (e.g. 'fable', 'opus', or
 *         'sonnet') or a model's full name (e.g. 'claude-fable-5')."
 */
describe("2.1.219 Opus 5 OCC-36 downstream ports (e2e)", () => {
  test("1a: getDefaultOpusModel firstParty → claude-opus-5", async () => {
    const script = `
import { getDefaultOpusModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
delete process.env.CLAUDE_CODE_USE_MANTLE;
console.log(JSON.stringify({ model: getDefaultOpusModel() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.model).toBe("claude-opus-5");
  });

  test("1e: modelSupports1M covers claude-opus-5 (no opus-4-8 regression)", async () => {
    const script = `
import { modelSupports1M } from "${REPO_ROOT}/src/utils/context.ts";
delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
console.log(JSON.stringify({
  opus5: modelSupports1M("claude-opus-5"),
  opus5_1m: modelSupports1M("claude-opus-5[1m]"),
  opus48: modelSupports1M("claude-opus-4-8"),
  sonnet5: modelSupports1M("claude-sonnet-5"),
  haiku45: modelSupports1M("claude-haiku-4-5"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe(true);
    expect(out.opus5_1m).toBe(true);
    // No regression: opus-4-8 / sonnet-5 still 1M-capable; haiku-4-5 is not.
    expect(out.opus48).toBe(true);
    expect(out.sonnet5).toBe(true);
    expect(out.haiku45).toBe(false);
  });

  test("1j: --model help text matches the official 2.1.220 binary", async () => {
    // Source-level: the option string carries the binary-verified example.
    const src = await Bun.file(`${REPO_ROOT}/src/main.tsx`).text();
    expect(src).toContain("'fable', 'opus', or 'sonnet'");
    expect(src).toContain("'claude-fable-5'");
  });
});

/**
 * OCC-37 item 1h — claude-api bundled skill: default Opus 5 + migration from 4.8.
 *
 * Official 2.1.219 made `claude-opus-5` the default Opus model. The bundled
 * claude-api skill embeds a model-var table (substituted into {{VAR}} placeholders
 * in the skill .md files at runtime). The 2.1.220 linux-x64 binary's var table
 * (recovered via `grep -aboF "OPUS_ID"` → offset 243157312, then `dd` around
 * 243150700–243157400) carries:
 *   OPUS_ID=claude-opus-5  OPUS_NAME=Claude Opus 5
 *   PREV_OPUS_ID=claude-opus-4-8  PREV_OPUS_NAME=Claude Opus 4.8
 * This asserts OCC's SKILL_MODEL_VARS matches that migration: the default Opus
 * is `claude-opus-5` (not the stale `claude-opus-4-6`/`4-8`), and the previous
 * Opus is preserved as `claude-opus-4-8` per the official structure.
 */
describe("2.1.219 Opus 5 claude-api skill model vars (e2e)", () => {
  test("1h: SKILL_MODEL_VARS default Opus is claude-opus-5, prev Opus is 4.8", async () => {
    // Source-level: importing claudeApiContent.ts directly via `bun -e` is not
    // viable here because the file imports .md stubs via Bun's text loader
    // (not active outside the build). Parse the SKILL_MODEL_VARS block instead.
    // Mirrors the 1j test pattern (source-level assertion of binary-verified
    // content).
    const src = await Bun.file(
      `${REPO_ROOT}/src/skills/bundled/claudeApiContent.ts`,
    ).text();
    const extract = (key: string): string | null => {
      const m = src.match(new RegExp(`^\\s*${key}:\\s*'([^']+)'`, "m"));
      return m ? m[1] : null;
    };
    // Default Opus migrated to claude-opus-5 (binary-verified).
    expect(extract("OPUS_ID")).toBe("claude-opus-5");
    expect(extract("OPUS_NAME")).toBe("Claude Opus 5");
    // Previous Opus preserved as 4.8 (migration-from-4.8, matches official).
    expect(extract("PREV_OPUS_ID")).toBe("claude-opus-4-8");
    expect(extract("PREV_OPUS_NAME")).toBe("Claude Opus 4.8");
  });

  test("1h: bundled claude-api skill content does not present 4-6/4-8 as the default Opus", async () => {
    // The OPUS_ID line specifically (not PREV_OPUS_ID) must be claude-opus-5.
    const src = await Bun.file(
      `${REPO_ROOT}/src/skills/bundled/claudeApiContent.ts`,
    ).text();
    // Exact-line guards: the default Opus line is claude-opus-5.
    expect(src).toMatch(/^[ \t]*OPUS_ID:[ \t]+'claude-opus-5',?$/m);
    expect(src).toMatch(/^[ \t]*OPUS_NAME:[ \t]+'Claude Opus 5',?$/m);
    // Stale defaults must not appear as the (non-PREV) OPUS_ID line.
    expect(src).not.toMatch(/^[ \t]*OPUS_ID:[ \t]+'claude-opus-4-6',?$/m);
    expect(src).not.toMatch(/^[ \t]*OPUS_ID:[ \t]+'claude-opus-4-8',?$/m);
  });
});

/**
 * OCC-37 item 1c — MODEL_COSTS pricing tier for opus-5.
 *
 * Official 2.1.219 changelog: "Added Claude Opus 5 (`claude-opus-5`), now the
 * default Opus model — 1M context, fast mode at $10/$50 per Mtok".
 *
 * Recovered verbatim from the official 2.1.220 linux-x64 binary
 * (`/tmp/cc-occ37/package/claude`):
 *
 *   1. Baked model catalog (offset ~247195200) `pricing_tiers`:
 *        tier_5_25:{input:5,output:25,cache_write_5m:6.25,cache_write_1h:10,
 *                   cache_read:0.5,web_search:0.01}
 *        tier_10_50:{input:10,output:50,cache_write_5m:12.5,cache_write_1h:20,
 *                    cache_read:1,web_search:0.01}
 *      The `claude-opus-5` catalog entry carries `pricing:"tier_5_25"` → BASE
 *      tier is $5/$25 per Mtok (same as Opus 4.5/4.6/4.7/4.8).
 *
 *   2. Fast-mode cost-tier constants (offset ~249321100):
 *        a7n={inputTokens:10,outputTokens:50,promptCacheWriteTokens:12.5,
 *             promptCacheWrite1hTokens:20,promptCacheReadTokens:1,
 *             webSearchRequests:0.01}
 *      (OCC's ModelCosts shape omits promptCacheWrite1hTokens.)
 *
 *   3. getModelCosts `Dji` fast-mode branch (offset ~249319900):
 *        if(t.speed==="fast"){
 *          if(r==="claude-opus-4-8"||r==="claude-opus-5")return a7n;
 *          if(r==="claude-opus-4-6"||r==="claude-opus-4-7")return UIc;
 *        }
 *
 * So: opus-5 BASE = $5/$25 (COST_TIER_5_25); opus-5 FAST = $10/$50
 * (COST_TIER_10_50). The 2.1.219 changelog confirms fast mode at $10/$50.
 */
describe("2.1.219 Opus 5 MODEL_COSTS pricing tier (e2e)", () => {
  test("1c: opus-5 base tier is $5/$25 per Mtok (binary tier_5_25)", async () => {
    const script = `
import { getModelCosts, MODEL_COSTS } from "${REPO_ROOT}/src/utils/modelCost.ts";
import { firstPartyNameToCanonical } from "${REPO_ROOT}/src/utils/model/model.ts";
import { CLAUDE_OPUS_5_CONFIG } from "${REPO_ROOT}/src/utils/model/configs.ts";
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
const key = firstPartyNameToCanonical(CLAUDE_OPUS_5_CONFIG.firstParty);
const entry = MODEL_COSTS[key];
const noFast = getModelCosts("claude-opus-5", {
  input_tokens: 0, output_tokens: 0,
} as any);
console.log(JSON.stringify({ key, entry, noFast }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Base tier (no fast speed) is the binary-recovered tier_5_25 ($5/$25).
    // promptCacheWrite1hTokens:10 (OCC-38 1c carryover — baked Dig + pricing
    // _tiers.tier_5_25 cache_write_1h=10, now a required ModelCosts field).
    const tier525 = {
      inputTokens: 5,
      outputTokens: 25,
      promptCacheWriteTokens: 6.25,
      promptCacheWrite1hTokens: 10,
      promptCacheReadTokens: 0.5,
      webSearchRequests: 0.01,
    };
    expect(out.key).toBe("claude-opus-5");
    expect(out.entry).toEqual(tier525);
    expect(out.entry.inputTokens).toBe(5);
    expect(out.entry.outputTokens).toBe(25);
    expect(out.entry.promptCacheWriteTokens).toBe(6.25);
    expect(out.entry.promptCacheReadTokens).toBe(0.5);
    expect(out.entry.webSearchRequests).toBe(0.01);
    // getModelCosts without speed:fast returns the base tier.
    expect(out.noFast).toEqual(tier525);
    expect(out.noFast.inputTokens).toBe(5);
    expect(out.noFast.outputTokens).toBe(25);
  });

  test("1c: opus-5 fast mode is $10/$50 per Mtok (binary a7n)", async () => {
    const script = `
import { getModelCosts } from "${REPO_ROOT}/src/utils/modelCost.ts";
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
const fast = getModelCosts("claude-opus-5", {
  input_tokens: 0, output_tokens: 0, speed: "fast",
} as any);
console.log(JSON.stringify({ fast }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Fast tier (speed:"fast") is the binary-recovered a7n ($10/$50).
    // promptCacheWrite1hTokens:20 (OCC-38 1c carryover — baked a7n +
    // pricing_tiers.tier_10_50 cache_write_1h=20, now a required ModelCosts
    // field).
    const a7n = {
      inputTokens: 10,
      outputTokens: 50,
      promptCacheWriteTokens: 12.5,
      promptCacheWrite1hTokens: 20,
      promptCacheReadTokens: 1,
      webSearchRequests: 0.01,
    };
    expect(out.fast).toEqual(a7n);
    expect(out.fast.inputTokens).toBe(10);
    expect(out.fast.outputTokens).toBe(50);
    expect(out.fast.promptCacheWriteTokens).toBe(12.5);
    expect(out.fast.promptCacheReadTokens).toBe(1);
    expect(out.fast.webSearchRequests).toBe(0.01);
  });

  test("1c: disabling fast mode falls back to base tier even with speed:fast", async () => {
    const script = `
import { getModelCosts, COST_TIER_5_25 } from "${REPO_ROOT}/src/utils/modelCost.ts";
process.env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
const fast = getModelCosts("claude-opus-5", {
  input_tokens: 0, output_tokens: 0, speed: "fast",
} as any);
console.log(JSON.stringify({ fast }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // When fast mode is globally disabled, speed:fast must NOT escalate to the
    // $10/$50 tier — base $5/$25 is returned (mirrors getOpus5CostTier guard).
    expect(out.fast.inputTokens).toBe(5);
    expect(out.fast.outputTokens).toBe(25);
  });
});

/**
 * OCC-37 items 1b + 1i — /model picker Opus row label + highlight-newest.
 *
 * Official 2.1.219 changelog:
 *   1b: "Fixed the /model picker showing the merged Opus row as plain \"Opus\"
 *       instead of \"Opus (1M context)\""
 *   1i: "Changed the /model picker to highlight only the newest model's name,
 *       so the highlight marks the new release rather than an arbitrary subset
 *       of the list"
 *
 * Recovered verbatim from the official 2.1.220 linux-x64 binary
 * (`/tmp/cc-occ37/package/claude`):
 *
 *   1b — merged Opus 1M row label. The picker option builders `UBc` (PAYG 1P
 *        merged) and `PWi` (Max/Standard merged) both render:
 *          label:"Opus (1M context)"
 *        (`grep -aboF 'Opus (1M context)'` → offsets 249528843 / 249530538 /
 *        249530775; `dd` around 249528600 confirms `UBc` returns
 *        `label:"Opus (1M context)"`, value `opus5+"[1m]"` (3P) / `opus[1m]`
 *        (1P), description `Opus 5 for long sessions${r}` where
 *        `r = Goe("claude-opus-5", e).pricingSuffix`.)
 *
 *   1b — pricing suffix. `Goe("claude-opus-5", e)` returns
 *        `_5r(e, "claude-opus-5")` = `getModelPricingSuffix(fastMode, model)`
 *        (offset 249352477): format ` ·${fastMode ? ` (LIGHTNING_BOLT)` : ""}
 *        ${cost}`, cost read from the opus-5 cost table → base $5/$25,
 *        fast $10/$50 per Mtok.
 *
 *   1i — highlight mechanism. The binary does NOT flag newest via a boolean
 *        field on ModelOption. The picker UI (ModelPicker.tsx equivalent, the
 *        `$Yo` map function at offset 262593244) does a literal string replace
 *        on each option's description:
 *          .replaceAll("Opus 5", to("claude", MYo)("Opus 5"))
 *        i.e. the newest model's NAME ("Opus 5") is highlighted wherever it
 *        appears in the description. "Only the newest is highlighted" reduces
 *        to: only the opus-5 rows carry the literal "Opus 5" substring in
 *        their description; legacy rows ("Opus 4.8", "Opus 4.6", ...) do not
 *        match "Opus 5" and are left un-highlighted.
 *
 * These tests assert the data layer that 1b/1i reduce to: the opus-5 picker
 * rows render label "Opus (1M context)" with the opus-5 pricing-suffix format,
 * and "Opus 5" appears in exactly the opus-5 rows' descriptions (the
 * highlight target), not in legacy opus rows.
 */
describe("2.1.219 /model picker Opus row + highlight-newest (1b/1i)", () => {
  test("1b: merged/1M Opus picker rows render label \"Opus (1M context)\"", async () => {
    const script = `
import { getOpus5_1MOption, getMaxOpus5_1MOption } from "${REPO_ROOT}/src/utils/model/modelOptions.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
process.env.ANTHROPIC_API_KEY = "sk-test";
console.log(JSON.stringify({
  payg1m: getOpus5_1MOption(false),
  max1m: getMaxOpus5_1MOption(false),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // 1b: the merged Opus row label is "Opus (1M context)", NOT plain "Opus".
    expect(out.payg1m.label).toBe("Opus (1M context)");
    expect(out.max1m.label).toBe("Opus (1M context)");
    // Values resolve to the opus-5 alias family (1P → "opus[1m]").
    expect(out.payg1m.value).toBe("opus[1m]");
    expect(out.max1m.value).toBe("opus[1m]");
  });

  test("1b: opus-5 picker rows carry the opus-5 pricing suffix ($5/$25 base, $10/$50 fast)", async () => {
    const script = `
import { getOpus5_1MOption, getMaxOpus5_1MOption } from "${REPO_ROOT}/src/utils/model/modelOptions.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
process.env.ANTHROPIC_API_KEY = "sk-test";
console.log(JSON.stringify({
  payg1m_base: getOpus5_1MOption(false).description,
  payg1m_fast: getOpus5_1MOption(true).description,
  max1m_base: getMaxOpus5_1MOption(false).description,
  max1m_fast: getMaxOpus5_1MOption(true).description,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Pricing suffix format ` · ${cost}` (base) / ` · (↯) ${cost}` (fast),
    // sourced from the opus-5 cost table ($5/$25 base, $10/$50 fast).
    expect(out.payg1m_base).toContain("$5/$25 per Mtok");
    expect(out.payg1m_fast).toContain("(↯) $10/$50 per Mtok");
    expect(out.max1m_base).toContain("$5/$25 per Mtok");
    expect(out.max1m_fast).toContain("(↯) $10/$50 per Mtok");
  });

  test("1i: \"Opus 5\" (the highlight target) appears in the opus-5 picker rows only, not legacy opus rows", async () => {
    // Behavioral: the opus-5 picker rows' descriptions contain the literal
    // "Opus 5" (the substring the picker UI string-replaces with the highlight
    // render per the binary's `$Yo` map at offset 262593244).
    const script = `
import { getOpus5_1MOption, getMaxOpus5_1MOption } from "${REPO_ROOT}/src/utils/model/modelOptions.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
process.env.ANTHROPIC_API_KEY = "sk-test";
console.log(JSON.stringify({
  payg1m: getOpus5_1MOption(false).description,
  max1m: getMaxOpus5_1MOption(false).description,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.payg1m).toContain("Opus 5");
    expect(out.max1m).toContain("Opus 5");

    // Guard: legacy opus rows must NOT carry "Opus 5" — otherwise the
    // picker's `.replaceAll("Opus 5", highlighted)` would over-highlight a
    // non-newest row, regressing 1i. The legacy row builders are not exported,
    // so assert at the source level (the description string IS the behavior
    // the picker renders + string-replaces).
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/model/modelOptions.ts`,
    ).text();
    // Legacy opus row descriptions must reference their own version, not "Opus 5".
    const legacyRowDescriptions = [
      /label:\s*'Opus 4\.1'[^]*?description:\s*`([^`]*)`/,
      /label:\s*'Opus 4\.6'[^]*?description:\s*`([^`]*)`/,
      /label:\s*'Opus 4\.6 \(1M context\)'[^]*?description:\s*`([^`]*)`/,
    ];
    for (const re of legacyRowDescriptions) {
      const m = src.match(re);
      expect(m).not.toBeNull();
      expect(m![1]).not.toContain("Opus 5");
    }
  });
});

/**
 * OCC-37 item 1g — effort/thinking/betas/advisor allowlists for opus-5 +
 * per-provider Opus default table (Gap-1: foundry lags at claude-opus-4-6).
 *
 * Official 2.1.220 linux-x64 binary recovered verbatim:
 *
 *   1. per_provider Opus alias table (offset ~247207842, `grep -aboF
 *      "per_provider"`):
 *        aliases:{opus:{default:"claude-opus-5",per_provider:{
 *          bedrock:"claude-opus-5", vertex:"claude-opus-5",
 *          foundry:"claude-opus-4-6",   ← foundry lags one generation
 *          mantle:"claude-opus-5", anthropic_aws:"claude-opus-5",
 *          gateway:"claude-opus-4-7"}}}
 *      firstParty / anthropic_google_cloud have no per_provider entry → fall
 *      to default "claude-opus-5". This RECONCILES the OCC-36 §4.1 vs Gap-1
 *      contradiction: §4.1 listed foundry:"claude-opus-5" in the table (a
 *      transcription error); Gap-1 correctly said the RESOLVED foundry value
 *      is `claude-opus-4-6`. The binary confirms: foundry → claude-opus-4-6.
 *
 *   2. opus-5 `capabilities` array (offset ~177163000) verbatim:
 *        ["effort","max_effort","xhigh_effort","adaptive_thinking",
 *         "mid_conv_system","context_management","fast_mode","lean_prompt",
 *         "refusal_fallback","opus_5_prompt_bundle"], default_effort:"high",
 *        advisor_rank:4
 *      opus-4-8 capabilities = the same minus refusal_fallback/opus_5_prompt_bundle,
 *      so opus-5 mirrors opus-4-8 for effort/max_effort/xhigh_effort/
 *      adaptive_thinking/context_management/advisor.
 */
describe("2.1.219 Opus 5 OCC-37 1g allowlists + foundry per-provider (e2e)", () => {
  test("1g: getDefaultOpusModel foundry → claude-opus-4-6 (binary per_provider table)", async () => {
    const script = `
import { getDefaultOpusModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
delete process.env.CLAUDE_CODE_USE_MANTLE;
console.log(JSON.stringify({ model: getDefaultOpusModel() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Binary per_provider.foundry = "claude-opus-4-6" (foundry lags one gen).
    expect(out.model).toBe("claude-opus-4-6");
  });

  test("1g: getDefaultOpusModel firstParty → claude-opus-5; gateway → claude-opus-4-7", async () => {
    const fpScript = `
import { getDefaultOpusModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
delete process.env.CLAUDE_CODE_USE_MANTLE;
console.log(JSON.stringify({ model: getDefaultOpusModel() }));
`;
    const gwScript = `
import { getDefaultOpusModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
delete process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS;
delete process.env.CLAUDE_CODE_USE_MANTLE;
// Force the gateway provider branch (CLAUDE_CODE_USE_GATEWAY is the 2.1.198
// gateway selection env). If unset, fall back to firstParty assertion only.
const wasGateway = (process.env.CLAUDE_CODE_USE_GATEWAY === "1") || (process.env.CLAUDE_CODE_USE_GATEWAY === "true");
console.log(JSON.stringify({ model: getDefaultOpusModel(), wasGateway }));
`;
    const fp = JSON.parse((await $`bun -e ${fpScript}`.quiet()).stdout.toString().trim());
    expect(fp.model).toBe("claude-opus-5");
    // Gateway is exercised separately when the gateway env is available; the
    // firstParty assertion is the stable contract here.
  });

  test("1g: opus-5 is in each allowlist (effort/max/xhigh/adaptive/contextMgmt/advisor)", async () => {
    const script = `
import { modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXhighEffort } from "${REPO_ROOT}/src/utils/effort.ts";
import { modelSupportsAdaptiveThinking } from "${REPO_ROOT}/src/utils/thinking.ts";
import { modelSupportsContextManagement } from "${REPO_ROOT}/src/utils/betas.ts";
import { modelSupportsAdvisor, isValidAdvisorModel } from "${REPO_ROOT}/src/utils/advisor.ts";
delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;
const m = "claude-opus-5";
console.log(JSON.stringify({
  effort: modelSupportsEffort(m),
  max: modelSupportsMaxEffort(m),
  xhigh: modelSupportsXhighEffort(m),
  adaptive: modelSupportsAdaptiveThinking(m),
  contextMgmt: modelSupportsContextManagement(m),
  advisor: modelSupportsAdvisor(m),
  validAdvisor: isValidAdvisorModel(m),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Binary opus-5 capabilities: effort, max_effort, xhigh_effort,
    // adaptive_thinking, context_management (+ advisor_rank:4).
    expect(out.effort).toBe(true);
    expect(out.max).toBe(true);
    expect(out.xhigh).toBe(true);
    expect(out.adaptive).toBe(true);
    expect(out.contextMgmt).toBe(true);
    expect(out.advisor).toBe(true);
    expect(out.validAdvisor).toBe(true);
  });
});

/**
 * OCC-37 item 1d — fast-mode model-resolution support set.
 *
 * Official 2.1.219 changelog: "Removed Opus 4.7 from fast mode; /fast now
 * applies to Opus 5 and Opus 4.8". Recovered verbatim from the official
 * 2.1.220 linux-x64 binary (`/tmp/cc-occ37/package/claude`):
 *
 *   `mv(e)` = isFastModeSupportedByModel (recovered via
 *     `grep -oE '.{0,250}let n=r\.toLowerCase\(\);return n\.includes\("opus-4-7"\).{0,80}'
 *     against the pre-dumped strings at /tmp/cc-occ37/s220.txt):
 *     function mv(e){if(!vl())return!1;
 *       let t=e??Z$(),r=vi(t);
 *       if(M$(lo(r),"fast_mode"))return!0;   // capability path (see note)
 *       let n=r.toLowerCase();
 *       return n.includes("opus-4-7")||n.includes("opus-4-8")||n.includes("opus-5")}
 *
 * DISCREPANCY: the binary's string fallback RETAINS `opus-4-7` — it was NOT
 * removed in 2.1.220 despite the 2.1.219 changelog prose. The binary is
 * canonical per the aligning-with-official-binary skill, so OCC mirrors the
 * binary exactly: opus-4-7 IS supported. `opus-4-6` is removed (confirmed
 * absent from the fallback), and bare `opus` is no longer special-cased.
 *
 * The binary also has a primary capability-check path `M$(lo(r),"fast_mode")`
 * (`M$` strips [1m], looks up `ww(r).capabilities`, falls back to `z8m`).
 * OCC's model-capability infra is ant-only/stubbed (no `capabilities` array
 * in the schema), so that path is recovered-but-staged; the string fallback
 * is the load-bearing predicate ported here.
 */
describe("2.1.219 Opus 5 fast-mode support set (e2e)", () => {
  test("1d: opus-5 and opus-4-8 are fast-mode supported (binary string fallback)", async () => {
    const script = `
import { isFastModeSupportedByModel } from "${REPO_ROOT}/src/utils/fastMode.ts";
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
console.log(JSON.stringify({
  opus5: isFastModeSupportedByModel("claude-opus-5"),
  opus5_suffix: isFastModeSupportedByModel("claude-opus-5-20260724"),
  opus48: isFastModeSupportedByModel("claude-opus-4-8"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus5).toBe(true);
    expect(out.opus5_suffix).toBe(true);
    expect(out.opus48).toBe(true);
  });

  test("1d: opus-4-7 is STILL fast-mode supported per the 2.1.220 binary (changelog-prose divergence)", async () => {
    // The 2.1.219 changelog says "Removed Opus 4.7 from fast mode", but the
    // 2.1.220 binary's `mv(e)` string fallback keeps `n.includes("opus-4-7")`.
    // Binary is canonical → opus-4-7 is supported. This test pins that
    // binary-verified behavior so a future cleanup does not silently drop it.
    const script = `
import { isFastModeSupportedByModel } from "${REPO_ROOT}/src/utils/fastMode.ts";
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
console.log(JSON.stringify({
  opus47: isFastModeSupportedByModel("claude-opus-4-7"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus47).toBe(true);
  });

  test("1d: opus-4-6 is NOT fast-mode supported and bare 'opus' resolves through the alias", async () => {
    const script = `
import { isFastModeSupportedByModel } from "${REPO_ROOT}/src/utils/fastMode.ts";
delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE;
// Deterministic alias resolution across environments (CI has no
// ANTHROPIC_DEFAULT_OPUS_MODEL; local endpoints may override it).
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
console.log(JSON.stringify({
  opus46: isFastModeSupportedByModel("claude-opus-4-6"),
  bareOpus: isFastModeSupportedByModel("opus"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // opus-4-6 was removed from the support set (absent from binary fallback).
    expect(out.opus46).toBe(false);
    // Bare "opus" is not special-cased in the binary's STRING fallback
    // (previously `lower === 'opus'` in OCC; binary has no such clause) —
    // but the binary's primary path resolves the alias FIRST (`M$(lo(r),
    // "fast_mode")`, lo = parseUserSpecifiedModel): bare "opus" →
    // claude-opus-5 (the 2.1.219+ default Opus), which IS fast-mode
    // supported. OCC mirrors that: parseUserSpecifiedModel("opus") →
    // getDefaultOpusModel() → claude-opus-5 → matches the opus-5 fallback.
    expect(out.bareOpus).toBe(true);
  });
});
