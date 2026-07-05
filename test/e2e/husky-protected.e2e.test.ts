import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.90: .husky added to protected (dangerous) directories so
 * acceptEdits mode won't auto-edit git hooks. This e2e runs the real OCC
 * filesystem permission helper inside the Docker container and asserts
 * .husky/pre-commit is classified as dangerous to auto-edit.
 */
describe("2.1.90 .husky protected directory (e2e, Docker)", () => {
  test("isDangerousFilePathToAutoEdit blocks .husky/pre-commit", async () => {
    const script = `
import { isDangerousFilePathToAutoEdit, DANGEROUS_DIRECTORIES } from "${REPO_ROOT}/src/utils/permissions/filesystem.ts";
console.log(JSON.stringify({
  huskyBlocked: isDangerousFilePathToAutoEdit("/repo/.husky/pre-commit"),
  huskyNested: isDangerousFilePathToAutoEdit("/repo/.husky/scripts/lint.sh"),
  ordinary: isDangerousFilePathToAutoEdit("/repo/src/index.ts"),
  includesHusky: DANGEROUS_DIRECTORIES.includes(".husky"),
}));
`;
    const result = await $`bun -e ${script}`.quiet();
    const parsed = JSON.parse(result.stdout.toString().trim());
    expect(parsed.includesHusky).toBe(true);
    expect(parsed.huskyBlocked).toBe(true);
    expect(parsed.huskyNested).toBe(true);
    expect(parsed.ordinary).toBe(false);
  });
});
