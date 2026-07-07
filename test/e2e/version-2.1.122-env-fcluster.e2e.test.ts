import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.122–2.1.153 F-env cluster (e2e):
 *   F15 (2.1.122) at_mention OTEL log after each @-mention resolution
 *   F31 (2.1.153) COLUMNS/LINES env passed to the statusline child process
 *   F24 (2.1.129) CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE gates the pm auto-updater
 *   F25 (2.1.136) CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL makes OTEL users eligible
 *   F29 (2.1.141) ANTHROPIC_WORKSPACE_ID → workspace_id on the OAuth authorize URL
 *
 * F24/F25/F29 have weak tmux e2e, so these unit/source tests are the done-gate.
 */

const src = (rel: string) =>
  readFileSync(`${REPO_ROOT}/${rel}`, "utf8").replace(/\s+/g, " ");

// ---------- F15: at_mention OTEL log ----------
describe("F15 at_mention OTEL log (2.1.122)", () => {
  test("emits claude_code.at_mention with mention_type + success after each resolution", () => {
    // Arrange
    const s = src("src/utils/attachments.ts");
    // Assert: the X$-equivalent helper emits the official event name + fields
    expect(s).toContain("logOTelEvent('at_mention'");
    expect(s).toContain("mention_type:");
    expect(s).toContain("success: String(success)");
    // directory + file + agent + mcp_resource resolution points are wired
    expect(s).toContain("logAtMentionOtel('directory', true)");
    expect(s).toContain("logAtMentionOtel('file', false)");
    expect(s).toContain("logAtMentionOtel('agent', false)");
    expect(s).toContain("logAtMentionOtel('mcp_resource', true)");
  });
});

// ---------- F31: COLUMNS/LINES env for statusline spawn ----------
describe("F31 COLUMNS/LINES env for statusline (2.1.153)", () => {
  test("hook spawn env forwards terminal columns/rows to the child", () => {
    // Arrange
    const s = src("src/utils/hooks.ts");
    // Assert: mirrors official {columns,rows}=process.stdout; P.COLUMNS/LINES
    expect(s).toContain("{ columns, rows } = process.stdout");
    expect(s).toContain("envVars.COLUMNS = String(columns)");
    expect(s).toContain("envVars.LINES = String(rows)");
  });
});

// ---------- F24: CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE ----------
describe("F24 CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE (2.1.129)", () => {
  test("is in SAFE_ENV_VARS + gates PackageManagerAutoUpdater.checkForUpdates", () => {
    // Arrange
    const managed = src("src/utils/managedEnvConstants.ts");
    const pm = src("src/components/PackageManagerAutoUpdater.tsx");
    // Assert
    expect(managed).toContain("'CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE'");
    expect(pm).toContain("isEnvTruthy");
    expect(pm).toContain(
      "process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
    );
  });

  test("gate is opt-in: truthy only when the env var is set to a truthy value", async () => {
    // Arrange + Act
    const script = `
const { isEnvTruthy } = await import("${REPO_ROOT}/src/utils/envUtils.ts");
delete process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE;
const unset = isEnvTruthy(process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE);
process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE = "1";
const on = isEnvTruthy(process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE);
process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE = "0";
const off = isEnvTruthy(process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE);
delete process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE;
console.log(JSON.stringify({ unset, on, off }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    // Assert: package-manager auto-update is dormant unless the flag is truthy
    expect(out.unset).toBe(false);
    expect(out.on).toBe(true);
    expect(out.off).toBe(false);
  });
});

// ---------- F25: CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL ----------
describe("F25 CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL (2.1.136)", () => {
  test("is in SAFE_ENV_VARS + bypasses isFeedbackSurveyDisabled for OTEL users", () => {
    // Arrange
    const managed = src("src/utils/managedEnvConstants.ts");
    const hook = src("src/components/FeedbackSurvey/useFeedbackSurvey.tsx");
    // Assert: allowlisted
    expect(managed).toContain(
      "'CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL'",
    );
    // Assert: the settings-based disable is suppressed when the OTEL flag is on
    // (official $re(){if($Se())return!1;return v_e()})
    expect(hook).toContain("CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL");
    expect(hook).toContain("isFeedbackSurveyDisabled() && !isEnvTruthy");
  });

  test("OTEL flag flips the suppression predicate (truthy ⇒ not suppressed)", async () => {
    // Arrange + Act
    const script = `
const { isEnvTruthy } = await import("${REPO_ROOT}/src/utils/envUtils.ts");
// Suppression = isFeedbackSurveyDisabled() && !isEnvTruthy(OTEL)
const suppressed = (disabled, otel) => disabled && !isEnvTruthy(otel);
delete process.env.CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL;
const a = suppressed(true, undefined);
process.env.CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL = "1";
const b = suppressed(true, process.env.CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL);
delete process.env.CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL;
console.log(JSON.stringify({ a, b }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    // Assert: disabled+no-OTEL → suppressed; disabled+OTEL → not suppressed (eligible)
    expect(out.a).toBe(true);
    expect(out.b).toBe(false);
  });
});

// ---------- F29: ANTHROPIC_WORKSPACE_ID → workspace_id ----------
describe("F29 ANTHROPIC_WORKSPACE_ID + workspace_id (2.1.141)", () => {
  test("ANTHROPIC_WORKSPACE_ID is in SAFE_ENV_VARS", () => {
    // Arrange + Assert
    expect(src("src/utils/managedEnvConstants.ts")).toContain(
      "'ANTHROPIC_WORKSPACE_ID'",
    );
  });

  test("buildAuthUrl appends workspace_id when set, omits when unset", async () => {
    // Arrange + Act
    const script = `
const { buildAuthUrl } = await import("${REPO_ROOT}/src/services/oauth/client.ts");
const base = {
  codeChallenge: "challenge",
  state: "state123",
  port: 5555,
  isManual: false,
};
const withWs = buildAuthUrl({ ...base, workspaceId: "wrkspc_01" });
const withoutWs = buildAuthUrl({ ...base });
const u1 = new URL(withWs);
const u2 = new URL(withoutWs);
console.log(JSON.stringify({
  has: u1.searchParams.get("workspace_id"),
  missing: u2.searchParams.has("workspace_id"),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    // Assert
    expect(out.has).toBe("wrkspc_01");
    expect(out.missing).toBe(false);
  });

  test("startOAuthFlow sources workspaceId from ANTHROPIC_WORKSPACE_ID (source)", () => {
    // Arrange + Assert
    const idx = src("src/services/oauth/index.ts");
    expect(idx).toContain("process.env.ANTHROPIC_WORKSPACE_ID");
    expect(idx).toContain("workspaceId: options?.workspaceId");
  });
});
