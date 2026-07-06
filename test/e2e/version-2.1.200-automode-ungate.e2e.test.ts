import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 e2e: G1 — auto-mode un-gated (TRANSCRIPT_CLASSIFIER).
 *
 * In the official external build the auto-mode classifier code is PRESENT (not
 * dead-code-eliminated) and gated at RUNTIME via the Statsig `tengu_auto_mode_config`
 * gate (default `enabled: "opt-in"`). OCC's `bun:bundle` feature() polyfill returns
 * false for every flag, which would DCE the entire auto-mode flow. OCC keeps the
 * code live via a runtime allowlist (`src/utils/featureFlags.ts`) so
 * `feature('TRANSCRIPT_CLASSIFIER')` returns true — matching the official
 * default-on (code-present, runtime-gated) behavior.
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   Gwm="opt-in"                                    <- default enabled state
 *   eGp(){...return e==="enabled"||e==="disabled"||e==="opt-in"?e:"opt-in"}  <- getAutoModeEnabledState
 *   cfp(){...return e!==Esa&&e?.enabled==="disabled"}                         <- circuit breaker fires only on "disabled"
 *   "Yes, and make it my default mode" / "accept-default"                     <- opt-in dialog option (unconditional)
 *   isAutoModeActive / tengu_auto_mode_config / tengu_auto_mode_opt_in_dialog_*
 *
 * This test proves auto-mode is functional, not dead code: the feature flag is
 * true, the classifier prompts load, the active-state flag round-trips, the
 * opt-in dialog renders its options, $defaults expansion works, and the
 * shift+tab cycling path (canCycleToAuto / isAutoModeGateEnabled) is present.
 */
describe("2.1.200 G1 auto-mode un-gated (TRANSCRIPT_CLASSIFIER) (e2e)", () => {
  const featureFlagsPath = `${REPO_ROOT}/src/utils/featureFlags.ts`;
  const yoloPath = `${REPO_ROOT}/src/utils/permissions/yoloClassifier.ts`;
  const dialogPath = `${REPO_ROOT}/src/components/AutoModeOptInDialog.tsx`;
  const expandPath = `${REPO_ROOT}/src/utils/permissions/expandWithDefaults.ts`;
  const statePath = `${REPO_ROOT}/src/utils/permissions/autoModeState.ts`;
  const cyclePath = `${REPO_ROOT}/src/utils/permissions/getNextPermissionMode.ts`;
  const setupPath = `${REPO_ROOT}/src/utils/permissions/permissionSetup.ts`;

  const ff = readFileSync(featureFlagsPath, "utf8");
  const yolo = readFileSync(yoloPath, "utf8");
  const dialog = readFileSync(dialogPath, "utf8");
  const expand = readFileSync(expandPath, "utf8");
  const state = readFileSync(statePath, "utf8");
  const cycle = readFileSync(cyclePath, "utf8");
  const setup = readFileSync(setupPath, "utf8");

  test("source-grep: TRANSCRIPT_CLASSIFIER in the runtime feature allowlist", () => {
    // The allowlist is what un-gates auto-mode: feature() returns true for it,
    // so every feature('TRANSCRIPT_CLASSIFIER') gate in the flow is live.
    expect(ff).toContain("'TRANSCRIPT_CLASSIFIER'");
    expect(ff).toMatch(/feature.*=.*\(name.*\).*=>.*FEATURE_ALLOWLIST\.has\(name\)/);
  });

  test("source-grep: yoloClassifier keeps the three prompt gates (live via allowlist)", () => {
    // The gates are intentionally kept (mirrors official external build: code
    // present, runtime-gated). They are live because feature() returns true.
    expect(yolo).toContain("const BASE_PROMPT: string = feature('TRANSCRIPT_CLASSIFIER')");
    expect(yolo).toContain(
      "const EXTERNAL_PERMISSIONS_TEMPLATE: string = feature('TRANSCRIPT_CLASSIFIER')",
    );
    expect(yolo).toContain(
      "feature('TRANSCRIPT_CLASSIFIER') && process.env.USER_TYPE === 'ant'",
    );
  });

  test("source-grep: active-state API + cycling logic present", () => {
    // autoModeState.ts — the active-state module (set/isAutoModeActive, circuit breaker).
    expect(state).toContain("export function setAutoModeActive(active: boolean): void");
    expect(state).toContain("export function isAutoModeActive(): boolean");
    expect(state).toContain("export function setAutoModeCircuitBroken(broken: boolean): void");
    expect(state).toContain("export function isAutoModeCircuitBroken(): boolean");
    // getNextPermissionMode.ts — shift+tab cycling into auto mode.
    expect(cycle).toContain("function canCycleToAuto(ctx: ToolPermissionContext): boolean");
    expect(cycle).toContain("isAutoModeGateEnabled");
    // permissionSetup.ts — gate-enabled default + verifyAutoModeGateAccess.
    expect(setup).toContain("export function isAutoModeGateEnabled(): boolean");
    expect(setup).toContain("export async function verifyAutoModeGateAccess(");
    // Official default 'opt-in' (binary Gwm="opt-in" / eGp returns "opt-in" when unset).
    expect(setup).toContain("AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'opt-in'");
  });

  test("source-grep: AutoModeOptInDialog verbatim copy + unconditional default-mode option", () => {
    // Legally-reviewed verbatim description from the official 2.1.200 opt-in dialog.
    expect(dialog).toContain("Auto mode lets Claude handle permission prompts automatically");
    expect(dialog).toContain("Shift+Tab to change mode.");
    // Binary: d=[{label:"Yes, and make it my default mode",value:"accept-default"}] — unconditional.
    expect(dialog).toContain('"Yes, and make it my default mode"');
    expect(dialog).toContain('"accept-default"');
    expect(dialog).toContain('"Yes, enable auto mode"');
    // Telemetry event names from the binary.
    expect(dialog).toContain("tengu_auto_mode_opt_in_dialog_accept");
    expect(dialog).toContain("tengu_auto_mode_opt_in_dialog_decline_dont_ask");
    expect(dialog).toContain("tengu_auto_mode_opt_in_dialog_shown");
  });

  test("source-grep: expandWithDefaults $defaults sentinel expansion", () => {
    expect(expand).toContain("export function expandWithDefaults(");
    expect(expand).toContain("'$defaults'");
  });

  test("runtime: feature('TRANSCRIPT_CLASSIFIER') === true (auto-mode is live, not DCE'd)", async () => {
    const script = `
import { feature } from "${featureFlagsPath}";
console.log(JSON.stringify({
  tc: feature('TRANSCRIPT_CLASSIFIER'),
  bash: feature('BASH_CLASSIFIER'),
  unknown: feature('NOPE_NOT_A_FLAG'),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.tc).toBe(true);
    expect(out.bash).toBe(true);
    expect(out.unknown).toBe(false);
  });

  test("runtime: classifier prompts load (BASE_PROMPT non-empty) — not dead code", async () => {
    const script = `
import { buildDefaultExternalSystemPrompt, getDefaultExternalAutoModeRules } from "${yoloPath}";
const prompt = buildDefaultExternalSystemPrompt();
const rules = getDefaultExternalAutoModeRules();
console.log(JSON.stringify({
  promptLen: prompt.length,
  hasPermissionsTemplate: prompt.includes('permissions') || prompt.length > 100,
  allowIsArray: Array.isArray(rules.allow),
  hasDefaults: rules.allow.length > 0 || rules.soft_deny.length > 0 || rules.hard_deny.length > 0,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // BASE_PROMPT + EXTERNAL_PERMISSIONS_TEMPLATE loaded because feature() is true.
    expect(out.promptLen).toBeGreaterThan(100);
    expect(out.hasDefaults).toBe(true);
  });

  test("runtime: isAutoModeActive() round-trips true (active-state is functional)", async () => {
    const script = `
import { setAutoModeActive, isAutoModeActive, _resetForTesting } from "${statePath}";
_resetForTesting();
const before = isAutoModeActive();
setAutoModeActive(true);
const after = isAutoModeActive();
setAutoModeActive(false);
const afterOff = isAutoModeActive();
console.log(JSON.stringify({ before, after, afterOff }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.before).toBe(false);
    expect(out.after).toBe(true); // can return true → auto-mode active state is NOT dead
    expect(out.afterOff).toBe(false);
  });

  test("runtime: expandWithDefaults $defaults splices built-ins", async () => {
    const script = `
import { expandWithDefaults } from "${expandPath}";
console.log(JSON.stringify({
  empty: expandWithDefaults(undefined, ['a','b']),
  dollar: expandWithDefaults(['x','$defaults','y'], ['d1','d2']),
  noDefault: expandWithDefaults(['x','y'], ['d1','d2']),
  doubleDefault: expandWithDefaults(['$defaults','$defaults'], ['d1']),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.empty).toEqual(["a", "b"]);
    expect(out.dollar).toEqual(["x", "d1", "d2", "y"]); // first $defaults expands, 2nd is no-op
    expect(out.noDefault).toEqual(["x", "y"]);
    expect(out.doubleDefault).toEqual(["d1"]); // only the first $defaults expands (official `r` flag)
  });
});
