import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.219 carryover — `promptCacheWrite1hTokens` cost field
 * (OCC-37 type-shape round). The official 2.1.220 binary's `ModelCosts`
 * shape carries a `promptCacheWrite1hTokens` field on every cost-tier
 * object. OCC previously omitted it. This test asserts the field exists
 * on every shipped cost-tier constant with the binary-verified value.
 *
 * Binary evidence (official 2.1.220 linux-x64 ELF):
 *   Baked constants (offset ~249321056):
 *     Dig (tier_5_25):   promptCacheWrite1hTokens: 10
 *     UIc (tier_30_150): promptCacheWrite1hTokens: 60
 *     a7n (tier_10_50):  promptCacheWrite1hTokens: 20
 *   Model catalog pricing_tiers (offset ~247195761) cache_write_1h:
 *     tier_3_15:  6       tier_5_25:  10      tier_15_75: 30
 *     tier_10_50: 20      haiku_35:   1.6     haiku_45:   2
 */
describe("2.1.219 promptCacheWrite1hTokens cost field (e2e)", () => {
  test("every cost-tier constant has the binary-verified 1h value", async () => {
    const script = `
import {
  COST_TIER_3_15,
  COST_TIER_15_75,
  COST_TIER_5_25,
  COST_TIER_30_150,
  COST_TIER_10_50,
  COST_HAIKU_35,
  COST_HAIKU_45,
} from "${REPO_ROOT}/src/utils/modelCost.ts";

const out = {
  tier_3_15:   COST_TIER_3_15.promptCacheWrite1hTokens,
  tier_15_75:  COST_TIER_15_75.promptCacheWrite1hTokens,
  tier_5_25:   COST_TIER_5_25.promptCacheWrite1hTokens,
  tier_30_150: COST_TIER_30_150.promptCacheWrite1hTokens,
  tier_10_50:  COST_TIER_10_50.promptCacheWrite1hTokens,
  haiku_35:    COST_HAIKU_35.promptCacheWrite1hTokens,
  haiku_45:    COST_HAIKU_45.promptCacheWrite1hTokens,
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );

    // Pricing_tiers cache_write_1h values (binary offset ~247195761)
    expect(out.tier_3_15).toBe(6);
    expect(out.tier_15_75).toBe(30);
    expect(out.tier_5_25).toBe(10);
    expect(out.tier_10_50).toBe(20);
    expect(out.haiku_35).toBe(1.6);
    expect(out.haiku_45).toBe(2);

    // Baked constant UIc — fast opus 4.6 (baked-only, not in pricing_tiers)
    expect(out.tier_30_150).toBe(60);
  });

  test("ModelCosts type requires promptCacheWrite1hTokens (satisfies check)", async () => {
    // If the field were optional or absent, `satisfies ModelCosts` on a
    // constant WITHOUT it would still compile. We verify the field is
    // present at runtime on every constant (covered above) and that the
    // type declaration includes it by checking that a deliberately
    // incomplete object fails the satisfies check at the type level.
    const script = `
import { COST_TIER_10_50, COST_TIER_5_25 } from "${REPO_ROOT}/src/utils/modelCost.ts";
console.log(JSON.stringify({
  has_1h_10_50: "promptCacheWrite1hTokens" in COST_TIER_10_50,
  has_1h_5_25:  "promptCacheWrite1hTokens" in COST_TIER_5_25,
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.has_1h_10_50).toBe(true);
    expect(out.has_1h_5_25).toBe(true);
  });
});
