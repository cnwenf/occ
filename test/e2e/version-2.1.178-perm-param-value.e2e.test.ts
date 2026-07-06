import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.178 e2e: Tool(param:value) permission-rule syntax.
 *
 * A rule like `Agent(model:opus)` denies an Agent tool call whose `model`
 * input parameter equals `opus`; `Bash(run_in_background:true)` likewise
 * matches the `run_in_background` param. The parser already captures the
 * parenthesised content as `ruleContent`; this gap adds:
 *   - parseParamValueRuleContent / matchesToolInputParam (param:value matching)
 *   - validatePermissionRuleValue (:* placement + MCP pattern validation)
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   deny Agent(model:opus) or ask Bash(run_in_background:true)
 *   "MCP rules do not support patterns in parentheses"
 *   "The :* pattern must be at the end"
 */
describe("2.1.178 Tool(param:value) permission-rule syntax (e2e)", () => {
  const parserPath = `${REPO_ROOT}/src/utils/permissions/permissionRuleParser.ts`;
  const src = readFileSync(parserPath, "utf8");

  test("source-grep: param:value parser + matcher present", () => {
    expect(src).toContain("parseParamValueRuleContent");
    expect(src).toContain("matchesToolInputParam");
    // Binary-exact validation error messages.
    expect(src).toContain("MCP rules do not support patterns in parentheses");
    expect(src).toContain("The :* pattern must be at the end");
  });

  test("runtime: parse + match Agent(model:opus)", async () => {
    const script = `
import { parseParamValueRuleContent, matchesToolInputParam, validatePermissionRuleValue, permissionRuleValueFromString } from "${parserPath}";
const parsed = permissionRuleValueFromString("Agent(model:opus)");
console.log(JSON.stringify({
  ruleValue: parsed,
  pv: parseParamValueRuleContent(parsed.ruleContent),
  matchOpus: matchesToolInputParam(parsed.ruleContent, { model: "opus" }),
  matchSonnet: matchesToolInputParam(parsed.ruleContent, { model: "sonnet" }),
  bashBg: matchesToolInputParam("run_in_background:true", { run_in_background: true }),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.pv).toEqual({ param: "model", value: "opus" });
    expect(out.matchOpus).toBe(true);
    expect(out.matchSonnet).toBe(false);
    expect(out.bashBg).toBe(true);
  });

  test("runtime: :* placement + MCP validation", async () => {
    const script = `
import { validatePermissionRuleValue } from "${parserPath}";
console.log(JSON.stringify({
  mcp: validatePermissionRuleValue({ toolName: "mcp__serv__tool", ruleContent: "foo" }),
  starMid: validatePermissionRuleValue({ toolName: "Bash", ruleContent: "npm:*:install" }),
  starEnd: validatePermissionRuleValue({ toolName: "Bash", ruleContent: "npm:*" }),
  ok: validatePermissionRuleValue({ toolName: "Bash", ruleContent: "npm install" }),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.mcp.valid).toBe(false);
    expect(out.mcp.error).toBe("MCP rules do not support patterns in parentheses");
    expect(out.starMid.valid).toBe(false);
    expect(out.starMid.error).toBe("The :* pattern must be at the end");
    expect(out.starEnd.valid).toBe(true);
    expect(out.ok.valid).toBe(true);
  });
});
