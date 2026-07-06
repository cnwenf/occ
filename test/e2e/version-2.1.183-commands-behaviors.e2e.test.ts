import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * Behavior alignment e2e for 5 command-behavior gaps ported toward the
 * official claude-code 2.1.200 binary. Each gap is verified via source-grep
 * (the substantive behavior + exact binary-confirmed wording) and, where
 * practical, a runtime check.
 *
 * Gaps covered:
 *   E18 (2.1.153) — /model save-default + s keybinding
 *   E20 (2.1.163+2.1.187) — /btw c-to-copy + arrow nav
 *   E24 (2.1.183) — /config --help shorthand listing
 *   E33 (2.1.176) — /fast allowlist refusal
 *   E34 (2.1.174) — /advisor allowlist blocking
 *
 * Exact wording verified against /tmp/occ-audit/claude.strings (2.1.200).
 */

const MODEL_CMD = `${REPO_ROOT}/src/commands/model/model.tsx`;
const MODEL_PICKER = `${REPO_ROOT}/src/components/ModelPicker.tsx`;
const BTW_CMD = `${REPO_ROOT}/src/commands/btw/btw.tsx`;
const CONFIG_CMD = `${REPO_ROOT}/src/commands/config/config-noninteractive.ts`;
const CONFIG_JSX = `${REPO_ROOT}/src/commands/config/config.tsx`;
const FAST_CMD = `${REPO_ROOT}/src/commands/fast/fast.tsx`;
const ADVISOR_CMD = `${REPO_ROOT}/src/commands/advisor.ts`;

async function grepFiles(
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const entries = Object.entries(files)
    .map(
      ([k, path]) =>
        `"${k}": await Bun.file("${path}").text()`,
    )
    .join(",");
  const script = `console.log(JSON.stringify({ ${entries} }));`;
  const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim();
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// E18 (2.1.153) — /model save-default + s keybinding
// Binary: chord:"enter",action:"set as default" + chord:"s",action:"use this session only"
// Messages: "Set model to X and saved as your default for new sessions" /
//           "Set model to X for this session only" /
//           "Model reset to default for this session"
// ---------------------------------------------------------------------------
describe("E18 (2.1.153) /model save-default + s keybinding (e2e)", () => {
  test("model.tsx persists selection + uses save-default wording", async () => {
    const src = await Bun.file(MODEL_CMD).text();
    // E18: enter persists the model to user settings (save as default).
    expect(src).toContain("updateSettingsForSource");
    expect(src).toContain("and saved as your default for new sessions");
    // E18: 's' session-only path (not persisted).
    expect(src).toContain("for this session only");
    expect(src).toContain("handleSessionOnlySelect");
    // E18: NO_PREFERENCE reset wording.
    expect(src).toContain("Model reset to default for this session");
  });

  test("ModelPicker offers s 'use this session only' + Enter 'set as default'", async () => {
    const src = await Bun.file(MODEL_PICKER).text();
    expect(src).toContain("onSessionOnlySelect");
    expect(src).toContain("set as default");
    expect(src).toContain("use this session only");
    // The 's' keybinding is wired via useInput.
    expect(src).toContain("useInput");
  });
});

// ---------------------------------------------------------------------------
// E20 (2.1.163+2.1.187) — /btw c-to-copy + arrow nav
// Binary: chord:"c",action:"copy" + left/right "switch" + "(+N earlier /btw)"
// ---------------------------------------------------------------------------
describe("E20 (2.1.163+2.1.187) /btw c-to-copy + arrow nav (e2e)", () => {
  test("btw.tsx has c-to-copy + left/right arrow nav + history", async () => {
    const src = await Bun.file(BTW_CMD).text();
    // E20: 'c to copy' shortcut + success indicator.
    expect(src).toContain("c to copy");
    expect(src).toContain("Copied to clipboard");
    expect(src).toContain("copyRawMarkdownToClipboard");
    // E20: left/right arrow navigation to step through earlier answers.
    expect(src).toContain("'left'");
    expect(src).toContain("'right'");
    expect(src).toContain("to switch");
    // E20: session-level history + "(+N earlier /btw)" indicator.
    expect(src).toContain("btwHistory");
    expect(src).toContain("earlier /btw");
  });
});

// ---------------------------------------------------------------------------
// E24 (2.1.183) — /config --help shorthand listing
// Binary: --help/-h/help treated as no-args → "Usage: /config key=value [key=value ...]" + key list
// ---------------------------------------------------------------------------
describe("E24 (2.1.183) /config --help shorthand listing (e2e)", () => {
  test("config-noninteractive handles --help/-h/help as key listing", async () => {
    const src = await Bun.file(CONFIG_CMD).text();
    expect(src).toContain("COMMON_HELP_ARGS");
    // --help falls into the same branch as no-args (usage + key list).
    expect(src).toContain("Usage: /config key=value [key=value ...]");
  });

  test("interactive config.tsx shows --help inline instead of opening panel", async () => {
    const src = await Bun.file(CONFIG_JSX).text();
    expect(src).toContain("COMMON_HELP_ARGS");
    expect(src).toContain(
      "Run /config to open settings, or /config key=value to set one directly.",
    );
  });

  test("runtime: /config --help returns the usage + key list", async () => {
    const script = `
const mod = await import("${REPO_ROOT}/src/commands/config/config-noninteractive.ts");
const result = await mod.call("--help", { setAppState: () => {}, getAppState: () => ({}) } as any);
console.log(JSON.stringify({ value: result.value }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.value).toContain("Usage: /config key=value [key=value ...]");
    // The shorthand key list should include several known config keys.
    expect(out.value).toContain("model=");
    expect(out.value).toContain("theme=");
    expect(out.value).toContain("verbose=");
  });
});

// ---------------------------------------------------------------------------
// E33 (2.1.176) — /fast allowlist refusal
// Binary: `Fast mode unavailable: ${fastModel} is not in your organization's allowed models`
// ---------------------------------------------------------------------------
describe("E33 (2.1.176) /fast allowlist refusal (e2e)", () => {
  test("fast.tsx refuses when fast model is outside availableModels", async () => {
    const src = await Bun.file(FAST_CMD).text();
    expect(src).toContain("isModelAllowed");
    expect(src).toContain("is not in your organization's allowed models");
    // The check guards the enable path (Fast mode ON).
    expect(src).toContain("Fast mode unavailable");
  });
});

// ---------------------------------------------------------------------------
// E34 (2.1.174) — /advisor allowlist blocking
// Binary: `Model '<model>' is not available. Your organization restricts model selection.`
// ---------------------------------------------------------------------------
describe("E34 (2.1.174) /advisor allowlist blocking (e2e)", () => {
  test("advisor.ts blocks a model outside the availableModels allowlist", async () => {
    const src = await Bun.file(ADVISOR_CMD).text();
    expect(src).toContain("isModelAllowed");
    expect(src).toContain(
      "is not available. Your organization restricts model selection.",
    );
  });
});
