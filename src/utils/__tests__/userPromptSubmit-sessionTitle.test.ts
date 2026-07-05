import { describe, expect, test } from "bun:test";
import { processHookJSONOutput } from "../hooks";

/**
 * claude-code 2.1.94: UserPromptSubmit hooks can set the session title via
 * hookSpecificOutput.sessionTitle ("same effect as /rename"). Verify the hook
 * JSON output processor extracts sessionTitle onto the HookResult.
 */
describe("2.1.94 UserPromptSubmit sessionTitle", () => {
  const base = {
    command: "echo",
    hookName: "UserPromptSubmit",
    toolUseID: "tu-1",
    hookEvent: "UserPromptSubmit" as const,
    expectedHookEvent: "UserPromptSubmit" as const,
  };

  test("extracts sessionTitle from a UserPromptSubmit hook output", () => {
    const result = processHookJSONOutput({
      ...base,
      json: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "ctx",
          sessionTitle: "My Bug Hunt",
        },
      },
    });
    expect(result.sessionTitle).toBe("My Bug Hunt");
    expect(result.additionalContext).toBe("ctx");
  });

  test("sessionTitle is undefined when the hook doesn't set it", () => {
    const result = processHookJSONOutput({
      ...base,
      json: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "ctx",
        },
      },
    });
    expect(result.sessionTitle).toBeUndefined();
  });

  test("sessionTitle alone (no additionalContext) is still extracted", () => {
    const result = processHookJSONOutput({
      ...base,
      json: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          sessionTitle: "Title-only",
        },
      },
    });
    expect(result.sessionTitle).toBe("Title-only");
  });

  test("empty-string sessionTitle is passed through (consumer trims)", () => {
    const result = processHookJSONOutput({
      ...base,
      json: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          sessionTitle: "",
        },
      },
    });
    expect(result.sessionTitle).toBe("");
  });
});
