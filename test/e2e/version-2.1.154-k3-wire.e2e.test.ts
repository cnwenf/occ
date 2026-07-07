import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.154 K3-wire (followup) e2e:
 *
 *   Wires the ultracode system-reminder + lean-prompt DECISION LOGIC (already
 *   in src/utils/effort/ultracode.ts + leanPrompt.ts + src/context.ts) into
 *   the actual query loop:
 *     (a) When ultracode is active, the verbatim "Ultracode is on…" reminder
 *         is injected as a per-turn isMeta system-reminder at the callModel
 *         site (src/query.ts), consuming getUltracodeSystemReminder() from
 *         src/context.ts. The "ultracode" keyword in a user prompt opts the
 *         session in via processTextPrompt (src/utils/processUserInput/).
 *     (b) When shouldUseLeanSystemPrompt(model) is true, the lean system
 *         prompt is used (non-essential expanded sections — e.g. the
 *         opus-4-6-specific thinking_guidance — are stripped) in
 *         src/constants/prompts.ts.
 *
 * Runtime imports double as the parse/TDZ check (NO TDZ on import). Source
 * strings are grepped verbatim against the 2.1.200 binary.
 */

const read = (p: string): string =>
  readFileSync(`${REPO_ROOT}/${p}`, "utf-8");

// -- (a) Ultracode reminder wired into the query loop ------------------------

describe("2.1.154 K3-wire ultracode reminder in query loop (e2e)", () => {
  test("src/query.ts imports + consumes getUltracodeSystemReminder", () => {
    const src = read("src/query.ts");
    // imports the context-layer wrapper (no duplicated reminder text)
    expect(src).toMatch(/from ['"]\.\/context\.js['"]/);
    expect(src).toContain("getUltracodeSystemReminder");
    // injects the reminder as a per-turn isMeta system-reminder at callModel
    expect(src).toContain("ultracodeReminder");
    expect(src).toMatch(/isMeta:\s*true/);
  });

  test("the verbatim 'Ultracode is on…' reminder text is NOT duplicated in query.ts", () => {
    const src = read("src/query.ts");
    // the reminder text lives only in src/utils/effort/ultracode.ts — query.ts
    // consumes it via the helper, never inlined.
    expect(src).not.toContain("Ultracode is on: optimize for the most");
  });

  test("reminder injection mirrors the binary's ultra_effort_enter shape", () => {
    const src = read("src/query.ts");
    // null when ultracode is off → non-ultracode path unchanged
    expect(src).toMatch(/ultracodeReminder !== null/);
    // prepended ahead of prependUserContext so it is its own meta message
    expect(src).toMatch(/prependUserContext\(messagesForQuery, userContext\)/);
  });

  test("runtime: getUltracodeSystemReminder() returns null off, isMeta reminder on", async () => {
    const ctx = await import(`${REPO_ROOT}/src/context.ts`);
    const uc = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    uc.resetUltracode();
    expect(ctx.getUltracodeSystemReminder()).toBe(null);
    uc.enableUltracodeForSession();
    const r = ctx.getUltracodeSystemReminder();
    expect(r).not.toBe(null);
    expect(r!.isMeta).toBe(true);
    expect(r!.content).toContain("Ultracode is on:");
    expect(r!.content).toContain("Use the Workflow tool on every substantive task");
    uc.resetUltracode();
  });
});

// -- (a) keyword trigger wired into prompt processing ------------------------

describe("2.1.154 K3-wire ultracode keyword trigger in processTextPrompt (e2e)", () => {
  test("processTextPrompt imports the keyword-trigger helpers", () => {
    const src = read("src/utils/processUserInput/processTextPrompt.ts");
    expect(src).toMatch(/from ['"]\.\.\/effort\/ultracode\.js['"]/);
    expect(src).toContain("shouldTriggerUltracodeFromPrompt");
    expect(src).toContain("enableUltracodeForSession");
  });

  test("processTextPrompt enables ultracode when the keyword is present", () => {
    const src = read("src/utils/processUserInput/processTextPrompt.ts");
    // the trigger fires on the user prompt text and enables the session
    expect(src).toMatch(/shouldTriggerUltracodeFromPrompt\(userPromptText\)/);
    expect(src).toMatch(/enableUltracodeForSession\(\)/);
  });

  test("runtime: keyword trigger → isUltracodeEnabled flips true", async () => {
    const uc = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    uc.resetUltracode();
    expect(uc.isUltracodeEnabled()).toBe(false);
    // keyword present + trigger enabled + not already active → fires
    expect(uc.shouldTriggerUltracodeFromPrompt("please ultracode this task")).toBe(true);
    uc.enableUltracodeForSession();
    expect(uc.isUltracodeEnabled()).toBe(true);
    // already active → trigger does not re-fire
    expect(uc.shouldTriggerUltracodeFromPrompt("ultracode again")).toBe(false);
    uc.resetUltracode();
  });
});

// -- (b) Lean system prompt wired into the prompt builder --------------------

describe("2.1.154 K3-wire lean system prompt in getSystemPrompt (e2e)", () => {
  test("src/constants/prompts.ts imports + consumes shouldUseLeanSystemPrompt", () => {
    const src = read("src/constants/prompts.ts");
    // imports the context-layer wrapper (cycle-safe: context.ts does not
    // import this module)
    expect(src).toMatch(/from ['"]\.\.\/context\.js['"]/);
    expect(src).toContain("shouldUseLeanSystemPrompt");
    // computes a lean flag and uses it to strip non-essential sections
    expect(src).toMatch(/shouldUseLeanSystemPrompt\(model\)/);
    expect(src).toMatch(/\blean\b/);
  });

  test("lean strips the opus-4-6-specific thinking_guidance section", () => {
    const src = read("src/constants/prompts.ts");
    // the thinking_guidance section is gated behind !lean
    expect(src).toMatch(/thinking_guidance/);
    // lean branch omits the section (...(lean ? [] : [systemPromptSection('thinking_guidance', …)]))
    expect(src).toMatch(/lean\s*\?\s*\[\s*\]/);
  });

  test("runtime: shouldUseLeanSystemPrompt true for lean-capable models", async () => {
    const ctx = await import(`${REPO_ROOT}/src/context.ts`);
    // lean_prompt-capable models get the lean prompt by default
    expect(ctx.shouldUseLeanSystemPrompt("claude-sonnet-5")).toBe(true);
    expect(ctx.shouldUseLeanSystemPrompt("claude-opus-4-8")).toBe(true);
    expect(ctx.shouldUseLeanSystemPrompt("claude-fable-5")).toBe(true);
    // full prompt is opt-in at higher effort (xhigh / max)
    expect(ctx.shouldUseLeanSystemPrompt("claude-sonnet-5", "xhigh")).toBe(false);
    expect(ctx.shouldUseLeanSystemPrompt("claude-sonnet-5", "max")).toBe(false);
    // older models without the lean_prompt capability never use the lean prompt
    expect(ctx.shouldUseLeanSystemPrompt("claude-opus-4-7")).toBe(false);
  });

  test("getSystemPrompt parses (no TDZ) — import resolves cleanly", async () => {
    // The import itself is the parse/TDZ check: prompts.ts now imports
    // shouldUseLeanSystemPrompt from ../context.js, and context.ts does NOT
    // import prompts.ts, so there is no module-init cycle. We do NOT invoke
    // getSystemPrompt here (it pulls in the command/auth graph which needs an
    // API key); the parse check is sufficient per the gap's verify contract.
    const m = await import(`${REPO_ROOT}/src/constants/prompts.ts`);
    expect(typeof m.getSystemPrompt).toBe("function");
  });
});
