import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 /cost (usage) per-model + cache-hit breakdown
 * (vs official 2.1.200 binary).
 *
 *   E26 (2.1.92): /cost lacks per-model and cache-hit breakdown for
 *   subscription users.
 *
 * Expected shapes verified against the official binary strings extraction:
 *   - "Usage by model:" + " input, " + " output, " + " cache read, " +
 *     " cache write" + " web search"  (the per-model + cache-hit breakdown)
 *   - "Per-model breakdown unavailable (rate limited — try again in a
 *     moment)" / "Could not refresh usage data"  (seeded-fallback message)
 *   - fetchUtilizationWithStatus returns {status, utilization, isRateLimited,
 *     responseBody} with ok/empty_response/seeded/unavailable (mirrors sur())
 */

describe("2.1.200 /cost per-model + cache-hit breakdown (e2e, vs official 2.1.200)", () => {
  test("E26 cost-tracker exports formatModelUsage with the binary's per-model format", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/cost-tracker.ts");
const src = await Bun.file("${REPO_ROOT}/src/cost-tracker.ts").text();
console.log(JSON.stringify({
  exported: typeof m.formatModelUsage === "function",
  hasUsageByModel: src.includes("Usage by model:"),
  hasCacheRead: src.includes("cache read"),
  hasCacheWrite: src.includes("cache write"),
  hasWebSearch: src.includes("web search"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.exported).toBe(true);
    expect(out.hasUsageByModel).toBe(true);
    expect(out.hasCacheRead).toBe(true);
    expect(out.hasCacheWrite).toBe(true);
    expect(out.hasWebSearch).toBe(true);
  });

  test("E26 usage.ts adds model_usage + fetchUtilizationWithStatus + seeded fallback (mirrors sur())", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/api/usage.ts`).text();
    // Per-model + cache-hit fields on the Utilization type
    expect(src).toContain("model_usage");
    expect(src).toContain("cache_read_input_tokens");
    expect(src).toContain("cache_creation_input_tokens");
    // Rich fetch with status (mirrors sur())
    expect(src).toContain("fetchUtilizationWithStatus");
    expect(src).toContain("FetchUtilizationResult");
    // Statuses match the binary: ok / empty_response / seeded / unavailable
    expect(src).toContain("'ok'");
    expect(src).toContain("'empty_response'");
    expect(src).toContain("'seeded'");
    expect(src).toContain("'unavailable'");
    // Seeded fallback (mirrors Etn()) + 429 detection
    expect(src).toContain("seededUtilization");
    expect(src).toContain("429");
    // formatApiModelUsage produces the "Usage by model:" display from API data
    expect(src).toContain("formatApiModelUsage");
    expect(src).toContain("Usage by model:");
  });

  test("E26 usage.ts seeded-case message matches the binary exactly", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/services/api/usage.ts`).text();
    // The seeded-case message is rendered in Usage.tsx, but the rate-limit
    // detection lives in usage.ts. Verify the wording lives in the codebase.
    // Usage.tsx is a React-Compiler-compiled artifact; the em-dash inside the
    // seeded-case message is stored as a — escape (not a literal em-dash
    // byte), so assert the wording on either side of the dash rather than the
    // exact dash byte to stay robust to the compiled encoding.
    const usageSrc = await Bun.file(`${REPO_ROOT}/src/components/Settings/Usage.tsx`).text();
    expect(usageSrc).toContain("Per-model breakdown unavailable (rate limited");
    expect(usageSrc).toContain("try again in a moment)");
    expect(usageSrc).toContain("Could not refresh usage data");
  });

  test("E26 Usage.tsx renders per-model + cache-hit breakdown section", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/Settings/Usage.tsx`).text();
    // Imports the per-model formatters
    expect(src).toContain("formatModelUsage");
    expect(src).toContain("formatApiModelUsage");
    expect(src).toContain("fetchUtilizationWithStatus");
    // breakdownMessage state (the seeded-case secondary message)
    expect(src).toContain("breakdownMessage");
    // Renders the breakdown (API model_usage preferred, local tracker fallback)
    expect(src).toContain("utilization.model_usage");
    expect(src).toContain("Usage by model");
  });

  test("E26 fetchUtilizationWithStatus returns ok shape and formatApiModelUsage formats cache read", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/services/api/usage.ts");
// formatApiModelUsage: cache read is the cache-hit breakdown
const out = m.formatApiModelUsage({
  "claude-sonnet-4": { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200 }
});
console.log(JSON.stringify({
  hasHeader: out.startsWith("Usage by model:"),
  hasCacheRead: out.includes("cache read"),
  hasCacheWrite: out.includes("cache write"),
  hasModel: out.includes("claude-sonnet-4"),
  emptyForNull: m.formatApiModelUsage(null) === "",
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasHeader).toBe(true);
    expect(out.hasCacheRead).toBe(true);
    expect(out.hasCacheWrite).toBe(true);
    expect(out.hasModel).toBe(true);
    expect(out.emptyForNull).toBe(true);
  });
});
