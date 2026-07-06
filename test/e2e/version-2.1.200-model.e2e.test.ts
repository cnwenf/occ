import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 model-domain gaps (e2e):
 *   A5  (2.1.166): multi-ordered fallbackModel (up to 3, dedup, 'default' expand)
 *   A10 (2.1.126): gateway /v1/models discovery in the /model picker
 *   A18 (2.1.172): doubled [1m] suffix de-duplication
 *   A19 (2.1.142): usage-policy refusal no longer suggests stale sonnet
 *
 * Source-grep + behavior checks. Env (`NODE_ENV=test`, dummy API key) is set
 * inside each script so auth-gated default-model resolution doesn't abort.
 */

const ENV = {
  NODE_ENV: "test",
  ANTHROPIC_API_KEY: "sk-test-e2e",
};

// ---------------------------------------------------------------------------
// A5: multi-ordered fallback
// ---------------------------------------------------------------------------
describe("A5 (2.1.166) multi-ordered fallbackModel", () => {
  test("source: normalizeFallbackModels + cap 3 + 'default' expand", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/utils/model/fallbackModel.ts"),
      "utf-8",
    );
    expect(src).toContain("normalizeFallbackModels");
    expect(src).toContain("getOrderedFallbackModels");
    expect(src).toContain("MAX_FALLBACK_MODELS = 3"); // binary ufp=3
    expect(src).toContain('"default"'); // per-element default expansion
    expect(src).toContain("split(',')"); // CLI comma-separated
  });

  test("behavior: CLI comma-split + dedup + cap 3", async () => {
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
const { normalizeFallbackModels } = await import("${REPO_ROOT}/src/utils/model/fallbackModel.ts");
// 5 distinct custom models → capped at 3, order preserved
const capped = normalizeFallbackModels("claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5,claude-opus-4-7,claude-fable-5", undefined);
console.log(JSON.stringify({ len: capped?.length, first: capped?.[0], third: capped?.[2] }));
// dedup: duplicate opus-4-8 collapses
const dedup = normalizeFallbackModels("claude-opus-4-8,claude-opus-4-8,claude-sonnet-5", undefined);
console.log(JSON.stringify({ dedupLen: dedup?.length }));
`;
    const lines = (await $`bun -e ${script}`.quiet().env(ENV)).stdout
      .toString()
      .trim()
      .split("\n");
    const capped = JSON.parse(lines[0]);
    const dedup = JSON.parse(lines[1]);
    expect(capped.len).toBe(3);
    expect(capped.first).toBe("claude-opus-4-8");
    expect(capped.third).toBe("claude-haiku-4-5");
    expect(dedup.dedupLen).toBe(2);
  });

  test("behavior: 'default' expands to the main-loop default model", async () => {
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
const { normalizeFallbackModels } = await import("${REPO_ROOT}/src/utils/model/fallbackModel.ts");
const r = normalizeFallbackModels("default", undefined);
console.log(JSON.stringify({ len: r?.length, isString: typeof r?.[0] }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.len).toBe(1);
    expect(out.isString).toBe("string");
  });

  test("behavior: getOrderedFallbackModels excludes the main model", async () => {
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
const { getOrderedFallbackModels } = await import("${REPO_ROOT}/src/utils/model/fallbackModel.ts");
const o = getOrderedFallbackModels("claude-opus-4-8", ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
console.log(JSON.stringify({ len: o.length, hasMain: o.includes("claude-opus-4-8"), first: o[0] }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.len).toBe(2);
    expect(out.hasMain).toBe(false);
    expect(out.first).toBe("claude-sonnet-5");
  });

  test("source: query.ts iterates an ordered fallback list (multi-ordered runtime)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/query.ts"), "utf-8");
    expect(src).toContain("getOrderedFallbackModels");
    expect(src).toContain("fallbackModelList");
    expect(src).toContain("fallbackModelIndex");
    expect(src).toContain("nextFallbackModel");
  });
});

// ---------------------------------------------------------------------------
// A10: gateway /v1/models discovery
// ---------------------------------------------------------------------------
describe("A10 (2.1.126) gateway model discovery", () => {
  test("source: gate + cache + fetch against /v1/models?limit=1000", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/utils/model/gatewayModelDiscovery.ts"),
      "utf-8",
    );
    expect(src).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
    expect(src).toContain("/v1/models?limit=1000");
    expect(src).toContain("gateway-models.json");
    expect(src).toContain('"From gateway"');
    expect(src).toContain("/^(claude|anthropic)/i");
  });

  test("source: picker appends gateway options + bootstrap fetches", () => {
    const picker = readFileSync(
      join(REPO_ROOT, "src/utils/model/modelOptions.ts"),
      "utf-8",
    );
    expect(picker).toContain("readGatewayModelOptions");
    const bootstrap = readFileSync(
      join(REPO_ROOT, "src/services/api/bootstrap.ts"),
      "utf-8",
    );
    expect(bootstrap).toContain("fetchAndCacheGatewayModels");
  });

  test("behavior: disabled by default; enabled with env + base URL + firstParty", async () => {
    const script = `
const { isGatewayModelDiscoveryEnabled, readGatewayModelOptions } = await import("${REPO_ROOT}/src/utils/model/gatewayModelDiscovery.ts");
const disabled = isGatewayModelDiscoveryEnabled();
process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
process.env.ANTHROPIC_BASE_URL = "https://gateway.example.test";
// re-import with fresh memoize cache by clearing the module cache is not needed;
// isGatewayModelDiscoveryEnabled reads env live.
const enabled = isGatewayModelDiscoveryEnabled();
const empty = readGatewayModelOptions().length;
console.log(JSON.stringify({ disabled, enabled, empty }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.disabled).toBe(false);
    expect(out.enabled).toBe(true);
    expect(out.empty).toBe(0);
  });

  test("behavior: cache roundtrip — write {baseUrl,models} → read maps to options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "occ-gw-"));
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(dir)};
process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
process.env.ANTHROPIC_BASE_URL = "https://gateway.example.test";
const { readGatewayModelOptions, getGatewayModelsCachePath, fetchAndCacheGatewayModels } = await import("${REPO_ROOT}/src/utils/model/gatewayModelDiscovery.ts");
const { writeFile, mkdir } = await import("node:fs/promises");
const { dirname } = await import("node:path");
const cache = { baseUrl: "https://gateway.example.test", models: [
  { id: "claude-opus-4-8", display_name: "Gateway Opus" },
  { id: "claude-sonnet-5" },
  { id: "non-claude-thing" },   // filtered out
]};
await mkdir(dirname(getGatewayModelsCachePath()), { recursive: true });
await writeFile(getGatewayModelsCachePath(), JSON.stringify(cache), { mode: 0o600 });
const opts = readGatewayModelOptions();
console.log(JSON.stringify({ count: opts.length, first: opts[0] }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.count).toBe(2); // non-claude filtered out
    expect(out.first.value).toBe("claude-opus-4-8");
    expect(out.first.label).toBe("Gateway Opus");
    expect(out.first.description).toBe("From gateway");
  });
});

// ---------------------------------------------------------------------------
// A18: doubled [1m] suffix de-duplication
// ---------------------------------------------------------------------------
describe("A18 (2.1.172) doubled [1m] suffix dedup", () => {
  test("source: dedup1mSuffix strips one-or-more trailing [1m] (binary WF)", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/utils/model/model.ts"),
      "utf-8",
    );
    expect(src).toContain("dedup1mSuffix");
    // /(\[1m\])+$/i  — the capturing group + `+` quantifier is the dedup fix
    // (the old single-strip /\[1m\]$/i left a doubled suffix in place).
    expect(src).toContain("(\\[1m\\])+$");
  });

  test("behavior: dedup1mSuffix collapses [1m][1m] and [1M][1m] → single [1m]", async () => {
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
const { dedup1mSuffix, parseUserSpecifiedModel } = await import("${REPO_ROOT}/src/utils/model/model.ts");
const cases = [
  ["claude-opus-4-8[1m][1m]", "claude-opus-4-8[1m]"],
  ["claude-opus-4-8[1M][1m]", "claude-opus-4-8[1m]"],   // mixed case
  ["claude-opus-4-8[1m]", "claude-opus-4-8[1m]"],
];
const dedupOk = cases.every(([i, e]) => dedup1mSuffix(i) === e);
// parseUserSpecifiedModel dedups a doubled suffix on a custom model
const parsed = parseUserSpecifiedModel("my-custom-deploy[1M][1m]");
console.log(JSON.stringify({ dedupOk, parsed, parsedOk: parsed === "my-custom-deploy[1m]" }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.dedupOk).toBe(true);
    expect(out.parsedOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A19: usage-policy refusal no longer suggests stale sonnet
// ---------------------------------------------------------------------------
describe("A19 (2.1.142) refusal no stale sonnet suggestion", () => {
  test("source: errors.ts has no /model claude-sonnet-4-20250514 suggestion", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/services/api/errors.ts"),
      "utf-8",
    );
    expect(src).not.toContain("/model claude-sonnet-4-20250514");
    expect(src).not.toContain("try running /model claude-sonnet");
    expect(src).toContain("change your model");
    expect(src).toContain("double press esc");
  });

  test("behavior: refusal message omits stale sonnet; uses generic hint", async () => {
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
const { getErrorMessageIfRefusal } = await import("${REPO_ROOT}/src/services/api/errors.ts");
// Non-interactive (bun -e is non-interactive): generic "change your model" hint.
const ni = getErrorMessageIfRefusal("refusal", "claude-opus-4-8");
const blocks = ni?.message?.content;
const txt = Array.isArray(blocks) ? blocks.map(b => b.text || "").join(" ") : String(blocks ?? "");
console.log(JSON.stringify({
  noStaleSonnet: !txt.includes("claude-sonnet-4-20250514"),
  noModelSuggestion: !txt.includes("/model claude-sonnet"),
  hasChangeModel: txt.includes("change your model"),
  hasUsagePolicy: txt.includes("Usage Policy"),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.noStaleSonnet).toBe(true);
    expect(out.noModelSuggestion).toBe(true);
    expect(out.hasChangeModel).toBe(true);
    expect(out.hasUsagePolicy).toBe(true);
  });
});
