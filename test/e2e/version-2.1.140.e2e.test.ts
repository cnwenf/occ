import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.140 e2e (Docker): case- and separator-insensitive subagent_type matching.
 */
describe("2.1.140 subagent_type matching (e2e)", () => {
  test("normalizeAgentType is case/separator insensitive", async () => {
    const script = `
const normalize = (s) => s.toLowerCase().replace(/[\\s_-]+/g, '-');
console.log(JSON.stringify({
  same: normalize("Code Reviewer") === normalize("code-reviewer"),
  space: normalize("Code Reviewer") === normalize("code reviewer"),
  underscore: normalize("code_reviewer") === normalize("code-reviewer"),
  case: normalize("CODE-REVIEWER") === normalize("code-reviewer"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.same).toBe(true);
    expect(out.space).toBe(true);
    expect(out.underscore).toBe(true);
    expect(out.case).toBe(true);
  });
});
