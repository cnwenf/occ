import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_NAME } from "../../../tools/AgentTool/constants";
import { TASK_STOP_TOOL_NAME } from "../../../tools/TaskStopTool/prompt";
import { normalizeLegacyToolName } from "../permissionRuleParser";

/**
 * CC 2.1.299 (#043) — record-keyed lookup regression for the legacy tool-name
 * alias table.
 *
 * `LEGACY_TOOL_NAME_ALIASES` is a plain object. The pre-fix
 * `ALIASES[name] ?? name` read for `name === "constructor"` (or "toString",
 * "valueOf", …) returned the INHERITED Object.prototype member — a function,
 * not nullish — so `??` never fired and the "normalized" tool name became a
 * function object. Permission rules parsed through that path silently never
 * matched (over-prompting; same fail-safe-but-broken symptom class as the
 * official #043 constructor/toString-named MCP server fix). The fix is an
 * own-property read.
 */
describe("CC 2.1.299 normalizeLegacyToolName own-property read (#043)", () => {
  test("Object.prototype-named rules pass through unchanged (never an inherited member)", () => {
    expect(normalizeLegacyToolName("constructor")).toBe("constructor");
    expect(normalizeLegacyToolName("prototype")).toBe("prototype");
    expect(normalizeLegacyToolName("toString")).toBe("toString");
    expect(normalizeLegacyToolName("valueOf")).toBe("valueOf");
    expect(normalizeLegacyToolName("hasOwnProperty")).toBe("hasOwnProperty");
    expect(normalizeLegacyToolName("__proto__")).toBe("__proto__");
  });

  test("MCP fully-qualified rule names pass through unchanged", () => {
    expect(normalizeLegacyToolName("mcp__constructor__tool")).toBe(
      "mcp__constructor__tool",
    );
    expect(normalizeLegacyToolName("mcp__toString")).toBe("mcp__toString");
  });

  test("real legacy aliases still resolve to the canonical name", () => {
    expect(normalizeLegacyToolName("Task")).toBe(AGENT_TOOL_NAME);
    expect(normalizeLegacyToolName("KillShell")).toBe(TASK_STOP_TOOL_NAME);
  });

  test("ordinary names pass through unchanged", () => {
    expect(normalizeLegacyToolName("Bash")).toBe("Bash");
    expect(normalizeLegacyToolName("")).toBe("");
  });
});
