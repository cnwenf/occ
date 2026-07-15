import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.210 #4 (e2e):
 *   "Fixed the `ultracode` keyword opt-in firing on non-human-originated input
 *   such as webhook payloads and relayed PR comments."
 *
 * The 2.1.210 binary gates the workflow_keyword_request (ultracode keyword)
 * opt-in behind `isHumanTypedPrompt`, computed as
 *   isHumanTypedPrompt = isRegularUserPrompt && UVn(origin)
 * where `UVn(e){return e?.kind==="human"}` and `origin` is a `{kind}` object
 * carrying `kind:"human"` only for claude_code_cli / claude_code_vscode
 * platforms (interactive REPL, `occ -p`, SDK). Programmatic / relayed input
 * (webhook payloads, relayed PR comments, auto-continuations, task
 * notifications, peer messages) carries a non-"human" kind (or no origin), so
 * the opt-in must NOT fire on it.
 *
 * These tests assert the guard both at the decision function
 * (shouldTriggerUltracodeFromPrompt) and at the prompt-processing call site
 * (processTextPrompt): a non-human origin containing the keyword must NOT
 * enable ultracode nor emit tengu_ultracode_keyword_triggered.
 */

describe("2.1.210 #4 ultracode human-origin guard (e2e)", () => {
  test("isHumanTypedPrompt mirrors UVn(origin) = origin?.kind === 'human'", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    // human-typed prompt origins
    expect(m.isHumanTypedPrompt({ kind: "human" })).toBe(true);
    // non-human origins (webhook payloads, relayed PR comments, etc.)
    expect(m.isHumanTypedPrompt({ kind: "webhook" })).toBe(false);
    expect(m.isHumanTypedPrompt({ kind: "relay" })).toBe(false);
    expect(m.isHumanTypedPrompt({ kind: "auto-continuation" })).toBe(false);
    expect(m.isHumanTypedPrompt({ kind: "task-notification" })).toBe(false);
    expect(m.isHumanTypedPrompt({ kind: "peer" })).toBe(false);
    // undefined origin is NOT human (matches UVn(undefined) === false)
    expect(m.isHumanTypedPrompt(undefined)).toBe(false);
    expect(m.isHumanTypedPrompt(null)).toBe(false);
  });

  test("shouldTriggerUltracodeFromPrompt blocks non-human origins carrying the keyword", async () => {
    const m = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    m.resetUltracode();
    // human-typed prompt with the keyword → fires
    expect(m.shouldTriggerUltracodeFromPrompt("please ultracode this task")).toBe(true);
    // explicit human origin → fires
    expect(
      m.shouldTriggerUltracodeFromPrompt("please ultracode this task", {
        kind: "human",
      }),
    ).toBe(true);
    m.resetUltracode();
    // non-human origins carrying the keyword → must NOT fire (CC 2.1.210 #4)
    expect(
      m.shouldTriggerUltracodeFromPrompt("please ultracode this task", {
        kind: "webhook",
      }),
    ).toBe(false);
    expect(
      m.shouldTriggerUltracodeFromPrompt("please ultracode this task", {
        kind: "relay",
      }),
    ).toBe(false);
    expect(
      m.shouldTriggerUltracodeFromPrompt("please ultracode this task", {
        kind: "auto-continuation",
      }),
    ).toBe(false);
    // Note: omitting origin defaults to human (the REPL / `occ -p` / SDK are
    // human-typed callers), so the trigger still fires — matching the binary
    // where claude_code_cli / claude_code_vscode carry kind:"human". The raw
    // UVn(undefined) === false behavior is covered by isHumanTypedPrompt above.
    expect(m.shouldTriggerUltracodeFromPrompt("please ultracode this task")).toBe(true);
    m.resetUltracode();
  });

  test("processTextPrompt: non-human origin does NOT enable ultracode nor emit the keyword-trigger event", async () => {
    const uc = await import(`${REPO_ROOT}/src/utils/effort/ultracode.ts`);
    const analytics = await import(
      `${REPO_ROOT}/src/services/analytics/index.ts`
    );
    const { processTextPrompt } = await import(
      `${REPO_ROOT}/src/utils/processUserInput/processTextPrompt.ts`
    );

    const captured: { name: string; meta: Record<string, unknown> }[] = [];
    analytics._resetForTesting();
    analytics.attachAnalyticsSink({
      logEvent: (name, meta) => captured.push({ name, meta }),
      logEventAsync: async (name, meta) => captured.push({ name, meta }),
    });

    // Non-human origin (a relayed PR comment) containing the keyword.
    uc.resetUltracode();
    expect(uc.isUltracodeEnabled()).toBe(false);
    processTextPrompt(
      "please ultracode this task for me",
      [],
      [],
      [],
      undefined,
      undefined,
      undefined,
      { kind: "relay" },
    );
    // ultracode must NOT be enabled on non-human input
    expect(uc.isUltracodeEnabled()).toBe(false);
    // and the keyword-trigger telemetry must NOT have fired
    expect(
      captured.some((e) => e.name === "tengu_ultracode_keyword_triggered"),
    ).toBe(false);

    // Contrast: a human-typed prompt with the keyword still opts in.
    uc.resetUltracode();
    captured.length = 0;
    processTextPrompt(
      "please ultracode this task for me",
      [],
      [],
      [],
      undefined,
      undefined,
      undefined,
      { kind: "human" },
    );
    expect(uc.isUltracodeEnabled()).toBe(true);
    expect(
      captured.some((e) => e.name === "tengu_ultracode_keyword_triggered"),
    ).toBe(true);

    uc.resetUltracode();
    analytics._resetForTesting();
  });
});
