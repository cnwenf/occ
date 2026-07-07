import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.154 e2e (K1/K2/K3):
 *   K1 — lean system prompt default (lean_prompt capability)
 *   K2 — streaming tool execution always enabled (gate removed)
 *   K3 — ultracode keyword + /workflows command + dynamic workflow discovery
 *
 * Runtime imports double as the parse/TDZ check (NO TDZ on import). Source
 * strings are grepped verbatim against the 2.1.200 binary.
 */

const read = (p: string): string =>
  readFileSync(`${REPO_ROOT}/${p}`, "utf-8");

// -- K1: lean system prompt --------------------------------------------------

describe("2.1.154 K1 lean system prompt (e2e)", () => {
  test("lean_prompt is the default for lean-capable models; full at higher effort", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/effort/leanPrompt.ts`);
    // lean is the default for lean_prompt-capable models
    expect(m.modelHasLeanPrompt("claude-sonnet-5")).toBe(true);
    expect(m.modelHasLeanPrompt("claude-opus-4-8")).toBe(true);
    expect(m.modelHasLeanPrompt("claude-fable-5")).toBe(true);
    expect(m.shouldUseLeanPrompt("claude-sonnet-5")).toBe(true);
    // full prompt is opt-in at higher effort (xhigh / max)
    expect(m.shouldUseLeanPrompt("claude-sonnet-5", "xhigh")).toBe(false);
    expect(m.shouldUseLeanPrompt("claude-sonnet-5", "max")).toBe(false);
    // older models without the capability never use the lean prompt
    expect(m.shouldUseLeanPrompt("claude-opus-4-7")).toBe(false);
    expect(m.shouldUseFullSystemPrompt("claude-opus-4-7")).toBe(true);
    expect(m.shouldUseFullSystemPrompt("claude-sonnet-5")).toBe(false);
  });

  test("source exposes the lean_prompt capability key + model list", () => {
    const src = read("src/utils/effort/leanPrompt.ts");
    expect(src).toContain("LEAN_PROMPT_CAPABILITY = 'lean_prompt'");
    expect(src).toContain("claude-sonnet-5");
    expect(src).toContain("claude-opus-4-8");
    expect(src).toContain("claude-mythos-5");
  });

  test("context layer wires the lean prompt decision", () => {
    const src = read("src/context.ts");
    expect(src).toContain("shouldUseLeanSystemPrompt");
    expect(src).toContain("leanPrompt");
  });
});

// -- K2: streaming tool execution always enabled -----------------------------

describe("2.1.154 K2 streaming tool execution (e2e)", () => {
  test("gate removed — streamingToolExecution is unconditionally true", () => {
    const src = read("src/query/config.ts");
    expect(src).toContain("streamingToolExecution: true");
    // the removed Statsig gate string must not gate the value
    expect(src).not.toMatch(
      /checkStatsigFeatureGate_CACHED_MAY_BE_STALE\(\s*['"]tengu_streaming_tool_execution2/,
    );
  });

  test("buildQueryConfig returns streamingToolExecution=true", async () => {
    const m = await import(`${REPO_ROOT}/src/query/config.ts`);
    const cfg = m.buildQueryConfig();
    expect(cfg.gates.streamingToolExecution).toBe(true);
  });
});

// -- K3: ultracode keyword + /workflows + discovery --------------------------

describe("2.1.154 K3 ultracode (e2e)", () => {
  test("keyword detection + session activation + reminder text", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    // keyword detection (word boundary, case-insensitive)
    expect(m.detectUltracodeKeyword("please ultracode this task")).toBe(true);
    expect(m.detectUltracodeKeyword("ULTRACODE now")).toBe(true);
    expect(m.detectUltracodeKeyword("no keyword here")).toBe(false);
    expect(m.detectUltracodeKeyword("ultracodex")).toBe(false); // not a word boundary
    // keyword trigger defaults to on
    expect(m.isUltracodeKeywordTriggerEnabled()).toBe(true);
    // should fire on a fresh prompt containing the keyword
    m.resetUltracode();
    expect(m.shouldTriggerUltracodeFromPrompt("ultracode please")).toBe(true);
    // session activation
    m.resetUltracode();
    expect(m.isUltracodeEnabled()).toBe(false);
    m.enableUltracodeForSession();
    expect(m.isUltracodeEnabled()).toBe(true);
    // reminder variants (verbatim binary strings)
    expect(m.getUltracodeReminder("full")).toContain("Ultracode is on:");
    expect(m.getUltracodeReminder("full")).toContain(
      "Use the Workflow tool on every substantive task",
    );
    expect(m.getUltracodeReminder("still")).toContain("Ultracode is still on");
    // reminder object is isMeta
    expect(m.getUltracodeReminderObject("full").isMeta).toBe(true);
    m.resetUltracode();
  });

  test("source carries the verbatim ultracode strings", () => {
    const src = read("src/utils/effort/ultracode.ts");
    expect(src).toContain("ULTRACODE_KEYWORD = 'ultracode'");
    expect(src).toContain("ultracodeKeywordTrigger");
    expect(src).toContain(
      "xhigh effort + dynamic workflows for maximum thoroughness",
    );
    expect(src).toContain("Ultracode is on: optimize for the most exhaustive");
    expect(src).toContain("Ultracode is still on");
    expect(src).toContain("dynamic-workflow orchestration");
  });

  test("/effort ultracode is wired into the effort command", () => {
    const src = read("src/commands/effort/effort.tsx");
    expect(src).toMatch(/normalized === ['"]ultracode['"]/);
    expect(src).toContain("enableUltracodeForSession");
    // the description string is imported from the ultracode module
    expect(src).toContain("ULTRACODE_EFFORT_DESCRIPTION");
    expect(src).toContain("ULTRACODE_ACTIVATION_MESSAGE");
    // help text lists ultracode
    expect(src).toContain("ultracode");
  });
});

describe("2.1.154 K3 /workflows command + discovery (e2e)", () => {
  test("command descriptor matches the binary", () => {
    const src = read("src/commands/workflows/index.ts");
    expect(src).toContain("name: 'workflows'");
    expect(src).toContain("aliases: []");
    expect(src).toContain("Browse running and completed workflows");
    expect(src).toContain("isEnabled: () => isWorkflowsEnabled()");
    expect(src).toContain("immediate: true");
  });

  test("dynamic workflow discovery from .claude/workflows/", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/effort/workflowDiscovery.ts`);
    expect(m.isWorkflowsEnabled()).toBe(true);
    // discoverWorkflows returns an array (empty when no dir)
    expect(Array.isArray(m.discoverWorkflows())).toBe(true);
    // resolveWorkflowScript returns null for unknown names
    expect(m.resolveWorkflowScript("definitely-not-a-workflow-xyz")).toBe(null);
  });

  test("source carries the workflows dir + script resolution", () => {
    const src = read("src/utils/effort/workflowDiscovery.ts");
    expect(src).toContain(".claude/workflows");
    expect(src).toContain("resolveWorkflowScript");
    expect(src).toContain("discoverWorkflows");
  });

  test("Workflow tool name constant matches the binary", () => {
    const src = read("src/tools/WorkflowTool/constants.ts");
    expect(src).toMatch(/WORKFLOW_TOOL_NAME.*['"]Workflow['"]/);
  });
});
