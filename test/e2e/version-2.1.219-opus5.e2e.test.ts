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
