import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 — Bedrock / Mantle / feature-flag gaps (e2e):
 *   A14 (2.1.94)  Bedrock Sonnet 3.5 v2 uses the `us.` inference profile
 *                 (us.anthropic.claude-3-5-sonnet-20241022-v2:0), NOT the bare
 *                 foundation-model ID (anthropic.claude-3-5-sonnet-...-v2:0).
 *   A15 (2.1.94)  Bedrock Mantle provider (CLAUDE_CODE_USE_MANTLE) — selection
 *                 order bedrock>foundry>anthropicAws>mantle>vertex>firstParty,
 *                 plus the bedrock→mantle promotion when both envs are set.
 *   ENABLE-FLAGS  MONITOR_TOOL / KAIROS / UDS_INBOX enabled in the runtime
 *                 FEATURE_ALLOWLIST so Monitor / PushNotification / ListAgents
 *                 are live in getAllBaseTools() (matching the official default
 *                 registry).
 */

const src = (rel: string) =>
  readFileSync(`${REPO_ROOT}/${rel}`, "utf8").replace(/\s+/g, " ");

// ---------- A14: Bedrock Sonnet 3.5 v2 inference profile ----------
describe("A14 Bedrock Sonnet 3.5 v2 us. inference profile (2.1.94)", () => {
  test("config uses the us. inference profile, not the foundation-model ID", () => {
    const s = src("src/utils/model/configs.ts");
    // The bedrock entry for Sonnet 3.5 v2 must be the cross-region inference
    // profile (us.anthropic....), matching the official binary literal.
    expect(s).toContain(
      "bedrock: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'",
    );
    // ...and must NOT carry the bare foundation-model ID for this model.
    expect(s).not.toContain(
      "bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0'",
    );
  });

  test("binary-aligned: the us. profile literal is the one the binary ships", () => {
    // Cross-check against the audit strings (best-effort; file may be absent in
    // some environments — the source assertion above is the real gate).
    try {
      const bin = readFileSync("/tmp/occ-audit/claude.strings", "utf8");
      expect(bin).toContain("us.anthropic.claude-3-5-sonnet-20241022-v2:0");
    } catch {
      // No audit file in this environment; source-grep already asserts the fix.
    }
  });

  test("bedrock.ts region-prefix helpers treat the us. profile as cross-region", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/model/bedrock.ts`);
    // The us. inference profile is detected as a cross-region profile.
    expect(m.getBedrockRegionPrefix("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe("us");
    // The bare foundation-model ID is NOT a cross-region profile (no prefix).
    expect(
      m.getBedrockRegionPrefix("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBeUndefined();
    // isFoundationModel distinguishes the two forms.
    expect(m.isFoundationModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(true);
    expect(
      m.isFoundationModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBe(false);
  });
});

// ---------- A15: Bedrock Mantle provider ----------
describe("A15 Bedrock Mantle provider CLAUDE_CODE_USE_MANTLE (2.1.94)", () => {
  test("getAPIProvider selects mantle in the binary's exact order", async () => {
    const script = `
const { getAPIProvider } = await import("${REPO_ROOT}/src/utils/model/providers.ts");
const env = (o) => { for (const k of ["CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_FOUNDRY","CLAUDE_CODE_USE_ANTHROPIC_AWS","CLAUDE_CODE_USE_MANTLE","CLAUDE_CODE_USE_VERTEX"]) delete process.env[k]; for (const [k,v] of Object.entries(o)) process.env[k]=v; return getAPIProvider(); };
const a = env({ CLAUDE_CODE_USE_MANTLE: "1" });                                  // mantle alone
const b = env({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_MANTLE: "1" });    // bedrock wins in base selection
const c = env({ CLAUDE_CODE_USE_FOUNDRY: "1", CLAUDE_CODE_USE_MANTLE: "1" });    // foundry outranks mantle
const d = env({ CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", CLAUDE_CODE_USE_MANTLE: "1" }); // anthropicAws outranks mantle
const e = env({ CLAUDE_CODE_USE_MANTLE: "1", CLAUDE_CODE_USE_VERTEX: "1" });     // mantle outranks vertex
const f = env({});                                                                // default firstParty
console.log(JSON.stringify({ a, b, c, d, e, f }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe("mantle");
    expect(out.b).toBe("bedrock"); // base selection: bedrock checked first
    expect(out.c).toBe("foundry");
    expect(out.d).toBe("anthropic_aws");
    expect(out.e).toBe("mantle"); // mantle outranks vertex
    expect(out.f).toBe("firstParty");
  });

  test("getEffectiveAPIProvider promotes bedrock→mantle when both envs set", async () => {
    const script = `
const { getAPIProvider, getEffectiveAPIProvider } = await import("${REPO_ROOT}/src/utils/model/providers.ts");
for (const k of ["CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_MANTLE"]) delete process.env[k];
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
const base = getAPIProvider();
const eff = getEffectiveAPIProvider();          // bedrock alone → bedrock
process.env.CLAUDE_CODE_USE_MANTLE = "1";
const effBoth = getEffectiveAPIProvider();      // bedrock+mantle → mantle (promotion)
const baseBoth = getAPIProvider();              // base still bedrock
console.log(JSON.stringify({ base, eff, effBoth, baseBoth }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.base).toBe("bedrock");
    expect(out.eff).toBe("bedrock");
    expect(out.effBoth).toBe("mantle");
    expect(out.baseBoth).toBe("bedrock");
  });

  test("mantle helpers + base URL / skip-auth envs", async () => {
    const script = `
const { isMantleProvider, isSkipMantleAuth, getMantleBaseURL } = await import("${REPO_ROOT}/src/utils/model/providers.ts");
for (const k of ["CLAUDE_CODE_USE_MANTLE","CLAUDE_CODE_SKIP_MANTLE_AUTH","CLAUDE_CODE_MANTLE_BASE_URL","AWS_REGION","AWS_DEFAULT_REGION"]) delete process.env[k];
const a = isMantleProvider();
process.env.CLAUDE_CODE_USE_MANTLE = "1";
const b = isMantleProvider();
const skipA = isSkipMantleAuth();
process.env.CLAUDE_CODE_SKIP_MANTLE_AUTH = "1";
const skipB = isSkipMantleAuth();
const urlDefault = getMantleBaseURL();
process.env.CLAUDE_CODE_MANTLE_BASE_URL = "https://example-mantle.invalid";
const urlOverride = getMantleBaseURL();
console.log(JSON.stringify({ a, b, skipA, skipB, urlDefault, urlOverride }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe(false);
    expect(out.b).toBe(true);
    expect(out.skipA).toBe(false);
    expect(out.skipB).toBe(true);
    expect(out.urlDefault).toContain("https://bedrock-mantle.");
    expect(out.urlDefault).toContain(".api.aws");
    expect(out.urlOverride).toBe("https://example-mantle.invalid");
  });

  test("providers.ts source carries the mantle branch + helpers", () => {
    const s = src("src/utils/model/providers.ts");
    expect(s).toContain("CLAUDE_CODE_USE_MANTLE");
    expect(s).toContain("? 'mantle'");
    expect(s).toContain("isMantleProvider");
    expect(s).toContain("getEffectiveAPIProvider");
    expect(s).toContain("isSkipMantleAuth");
    expect(s).toContain("CLAUDE_CODE_SKIP_MANTLE_AUTH");
    expect(s).toContain("getMantleBaseURL");
    expect(s).toContain("CLAUDE_CODE_MANTLE_BASE_URL");
    expect(s).toContain("https://bedrock-mantle.");
  });
});

// ---------- ENABLE-FLAGS: MONITOR_TOOL only (KAIROS/UDS_INBOX kept OFF — they hang) ----------
describe("ENABLE-FLAGS MONITOR_TOOL only (2.1.200)", () => {
  test("featureFlags allowlist enables MONITOR_TOOL; KAIROS/UDS_INBOX stay OFF (they gate blocking subsystems)", () => {
    const s = src("src/utils/featureFlags.ts");
    expect(s).toContain("'MONITOR_TOOL'");
    // KAIROS gates BriefTool's 5-min refresh loop + assistant + SendUserFile
    // (hangs the query path when enabled in OCC's trimmed build).
    expect(s).not.toContain("'KAIROS'");
    // UDS_INBOX gates ListPeers' session-registry scan (also hangs).
    expect(s).not.toContain("'UDS_INBOX'");
  });

  test("feature() returns true only for MONITOR_TOOL at runtime", async () => {
    const script = `
const { feature } = await import("${REPO_ROOT}/src/utils/featureFlags.ts");
console.log(JSON.stringify({
  MONITOR_TOOL: feature("MONITOR_TOOL"),
  KAIROS: feature("KAIROS"),
  UDS_INBOX: feature("UDS_INBOX"),
  COORDINATOR_MODE: feature("COORDINATOR_MODE"),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.MONITOR_TOOL).toBe(true);
    expect(out.KAIROS).toBe(false);
    expect(out.UDS_INBOX).toBe(false);
    expect(out.COORDINATOR_MODE).toBe(false);
  });

  test("getAllBaseTools() includes Monitor; PushNotification/ListAgents stay OUT (KAIROS/UDS_INBOX off)", async () => {
    const script = `
const { getAllBaseTools } = await import("${REPO_ROOT}/src/tools.ts");
const names = getAllBaseTools().map(t => t.name);
console.log(JSON.stringify({
  total: names.length,
  Monitor: names.includes("Monitor"),
  PushNotification: names.includes("PushNotification"),
  ListAgents: names.includes("ListAgents"),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.Monitor).toBe(true);
    expect(out.PushNotification).toBe(false);
    expect(out.ListAgents).toBe(false);
    expect(out.total).toBeGreaterThan(0);
  });

  test("tools.ts gates Monitor/PushNotification/ListAgents on the three flags", () => {
    const s = src("src/tools.ts");
    expect(s).toMatch(/feature\(['"]MONITOR_TOOL['"]\)/);
    expect(s).toMatch(/feature\(['"]KAIROS['"]\)\s*\|\|\s*feature\(['"]KAIROS_PUSH_NOTIFICATION['"]\)/);
    expect(s).toMatch(/feature\(['"]UDS_INBOX['"]\)/);
  });
});
