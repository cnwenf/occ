import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.94 e2e (Docker): UserPromptSubmit hooks can set the session
 * title via hookSpecificOutput.sessionTitle (same effect as /rename).
 */
describe("2.1.94 UserPromptSubmit sessionTitle (e2e)", () => {
  test("processHookJSONOutput extracts sessionTitle from a UserPromptSubmit hook", async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = processHookJSONOutput({
  command: "echo",
  hookName: "UserPromptSubmit",
  toolUseID: "tu-1",
  hookEvent: "UserPromptSubmit",
  expectedHookEvent: "UserPromptSubmit",
  json: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx", sessionTitle: "My Bug Hunt" } },
});
console.log(JSON.stringify({ sessionTitle: r.sessionTitle, additionalContext: r.additionalContext }));
`;
    const result = await $`bun -e ${script}`.quiet();
    const out = JSON.parse(result.stdout.toString().trim());
    expect(out.sessionTitle).toBe("My Bug Hunt");
    expect(out.additionalContext).toBe("ctx");
  });

  test("sessionTitle is undefined when the hook omits it", async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = processHookJSONOutput({
  command: "echo",
  hookName: "UserPromptSubmit",
  toolUseID: "tu-1",
  hookEvent: "UserPromptSubmit",
  expectedHookEvent: "UserPromptSubmit",
  json: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" } },
});
console.log(JSON.stringify({ sessionTitle: r.sessionTitle }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.sessionTitle).toBeUndefined();
  });
});
