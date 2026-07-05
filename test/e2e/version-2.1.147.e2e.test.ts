import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.147 e2e (Docker): /simplify renamed to /code-review (alias preserved).
 */
describe("2.1.147 /code-review rename (e2e)", () => {
  test("skill name is code-review with simplify alias", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/skills/bundled/simplify.ts").text();
console.log(JSON.stringify({
  hasCodeReview: src.includes("name: 'code-review'"),
  hasSimplifyAlias: src.includes("'simplify'"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasCodeReview).toBe(true);
    expect(out.hasSimplifyAlias).toBe(true);
  });
});
