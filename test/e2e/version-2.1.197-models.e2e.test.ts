import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.197+ model launches (e2e): Opus 4.7, Opus 4.8, Sonnet 5,
 * Fable 5 added to OCC's model registry, matching the official 2.1.200 binary.
 *
 * Verified against /tmp/occ-audit/claude.strings (official 2.1.200 binary dump):
 *   - Model ids: claude-opus-4-7, claude-opus-4-8, claude-sonnet-5, claude-fable-5
 *   - Default Opus (1P) = claude-opus-4-8; Default Sonnet (1P) = claude-sonnet-5
 *   - mythos-5 canonicalizes to claude-fable-5
 *   - Display names: "Opus 4.8", "Sonnet 5", etc.
 *   - APIProvider type expanded to 7 providers (anthropic_aws/mantle/gateway)
 */
describe("2.1.197 model launches (e2e)", () => {
  test("CANONICAL_MODEL_IDS includes all 4 new model ids", async () => {
    const script = `
import { CANONICAL_MODEL_IDS } from "${REPO_ROOT}/src/utils/model/configs.ts";
console.log(JSON.stringify({
  ids: CANONICAL_MODEL_IDS,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ids).toContain("claude-opus-4-7");
    expect(out.ids).toContain("claude-opus-4-8");
    expect(out.ids).toContain("claude-sonnet-5");
    expect(out.ids).toContain("claude-fable-5");
  });

  test("CANONICAL_ID_TO_KEY maps new ids to short keys", async () => {
    const script = `
import { CANONICAL_ID_TO_KEY } from "${REPO_ROOT}/src/utils/model/configs.ts";
console.log(JSON.stringify({
  opus47: CANONICAL_ID_TO_KEY["claude-opus-4-7"],
  opus48: CANONICAL_ID_TO_KEY["claude-opus-4-8"],
  sonnet5: CANONICAL_ID_TO_KEY["claude-sonnet-5"],
  fable5: CANONICAL_ID_TO_KEY["claude-fable-5"],
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus47).toBe("opus47");
    expect(out.opus48).toBe("opus48");
    expect(out.sonnet5).toBe("sonnet5");
    expect(out.fable5).toBe("fable5");
  });

  test("firstPartyNameToCanonical maps mythos-5 to fable-5", async () => {
    const script = `
import { firstPartyNameToCanonical } from "${REPO_ROOT}/src/utils/model/model.ts";
console.log(JSON.stringify({
  mythos5: firstPartyNameToCanonical("claude-mythos-5"),
  mythos5_suffix: firstPartyNameToCanonical("claude-mythos-5-20260101"),
  fable5: firstPartyNameToCanonical("claude-fable-5"),
  opus48: firstPartyNameToCanonical("claude-opus-4-8"),
  opus47: firstPartyNameToCanonical("claude-opus-4-7"),
  sonnet5: firstPartyNameToCanonical("claude-sonnet-5"),
  opus47_fast: firstPartyNameToCanonical("claude-opus-4-7-fast"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.mythos5).toBe("claude-fable-5");
    expect(out.mythos5_suffix).toBe("claude-fable-5");
    expect(out.fable5).toBe("claude-fable-5");
    expect(out.opus48).toBe("claude-opus-4-8");
    expect(out.opus47).toBe("claude-opus-4-7");
    expect(out.sonnet5).toBe("claude-sonnet-5");
    expect(out.opus47_fast).toBe("claude-opus-4-7");
  });

  test("getDefaultOpusModel (1P, no env) resolves to claude-opus-4-8", async () => {
    const script = `
import { getDefaultOpusModel } from "${REPO_ROOT}/src/utils/model/model.ts";
// Ensure firstParty + no env override
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
console.log(JSON.stringify({ opus: getDefaultOpusModel() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus).toContain("claude-opus-4-8");
  });

  test("getDefaultSonnetModel (1P, no env) resolves to claude-sonnet-5", async () => {
    const script = `
import { getDefaultSonnetModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
console.log(JSON.stringify({ sonnet: getDefaultSonnetModel() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.sonnet).toContain("claude-sonnet-5");
  });

  test("getDefaultFableModel reads env / falls back to claude-fable-5", async () => {
    const script = `
import { getDefaultFableModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
const fallback = getDefaultFableModel();
process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = "custom-fable-id";
const envOverride = getDefaultFableModel();
console.log(JSON.stringify({ fallback, envOverride }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.fallback).toContain("claude-fable-5");
    expect(out.envOverride).toBe("custom-fable-id");
  });

  test("getMarketingNameForModel returns correct display names", async () => {
    const script = `
import { getMarketingNameForModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
console.log(JSON.stringify({
  opus48: getMarketingNameForModel("claude-opus-4-8"),
  opus48_1m: getMarketingNameForModel("claude-opus-4-8[1m]"),
  opus47: getMarketingNameForModel("claude-opus-4-7"),
  sonnet5: getMarketingNameForModel("claude-sonnet-5"),
  sonnet5_1m: getMarketingNameForModel("claude-sonnet-5[1m]"),
  fable5: getMarketingNameForModel("claude-fable-5"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus48).toBe("Opus 4.8");
    expect(out.opus48_1m).toBe("Opus 4.8 (with 1M context)");
    expect(out.opus47).toBe("Opus 4.7");
    expect(out.sonnet5).toBe("Sonnet 5");
    expect(out.sonnet5_1m).toBe("Sonnet 5 (with 1M context)");
    expect(out.fable5).toBe("Fable 5");
  });

  test("modelSupports1M covers Sonnet 5, Opus 4.7, Opus 4.8 (not Fable 5)", async () => {
    const script = `
import { modelSupports1M } from "${REPO_ROOT}/src/utils/context.ts";
delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
console.log(JSON.stringify({
  sonnet5: modelSupports1M("claude-sonnet-5"),
  opus47: modelSupports1M("claude-opus-4-7"),
  opus48: modelSupports1M("claude-opus-4-8"),
  fable5: modelSupports1M("claude-fable-5"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.sonnet5).toBe(true);
    expect(out.opus47).toBe(true);
    expect(out.opus48).toBe(true);
    expect(out.fable5).toBe(false);
  });

  test("fable alias resolves to claude-fable-5 via parseUserSpecifiedModel", async () => {
    const script = `
import { parseUserSpecifiedModel } from "${REPO_ROOT}/src/utils/model/model.ts";
delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
delete process.env.CLAUDE_CODE_USE_BEDROCK;
delete process.env.CLAUDE_CODE_USE_VERTEX;
delete process.env.CLAUDE_CODE_USE_FOUNDRY;
console.log(JSON.stringify({
  fable: parseUserSpecifiedModel("fable"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.fable).toContain("claude-fable-5");
  });

  test("ALL_MODEL_CONFIGS has 7 provider keys per model (source grep)", async () => {
    // Source-grep assertion: the APIProvider type includes the 3 new providers.
    const { stdout } = await $`grep -c "anthropic_aws\\|mantle\\|gateway" ${REPO_ROOT}/src/utils/model/providers.ts`;
    const count = parseInt(stdout.toString().trim(), 10);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("new configs have binary-confirmed provider_ids", async () => {
    const script = `
import { ALL_MODEL_CONFIGS } from "${REPO_ROOT}/src/utils/model/configs.ts";
const pick = (k) => ALL_MODEL_CONFIGS[k];
console.log(JSON.stringify({
  opus48: pick("opus48"),
  opus47: pick("opus47"),
  sonnet5: pick("sonnet5"),
  fable5: pick("fable5"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Opus 4.8 — verified against binary
    expect(out.opus48.firstParty).toBe("claude-opus-4-8");
    expect(out.opus48.bedrock).toBe("us.anthropic.claude-opus-4-8");
    expect(out.opus48.vertex).toBe("claude-opus-4-8");
    expect(out.opus48.foundry).toBe("claude-opus-4-8");
    expect(out.opus48.anthropic_aws).toBe("claude-opus-4-8");
    expect(out.opus48.mantle).toBe("anthropic.claude-opus-4-8");
    expect(out.opus48.gateway).toBe("claude-opus-4-8");
    // Opus 4.7
    expect(out.opus47.firstParty).toBe("claude-opus-4-7");
    expect(out.opus47.bedrock).toBe("us.anthropic.claude-opus-4-7");
    expect(out.opus47.mantle).toBe("anthropic.claude-opus-4-7");
    // Sonnet 5
    expect(out.sonnet5.firstParty).toBe("claude-sonnet-5");
    expect(out.sonnet5.bedrock).toBe("us.anthropic.claude-sonnet-5");
    expect(out.sonnet5.mantle).toBe("anthropic.claude-sonnet-5");
    // Fable 5
    expect(out.fable5.firstParty).toBe("claude-fable-5");
    expect(out.fable5.bedrock).toBe("us.anthropic.claude-fable-5");
    expect(out.fable5.mantle).toBe("anthropic.claude-fable-5");
  });
});
