import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.183 e2e: destructive-command deny list (categories).
 *
 * The destructive-command matcher carries a stable `category` slug per pattern
 * (matching the official 2.1.200 `ujp` array + `H8e`/`dFa` accessors). The
 * category labels a matched destructive command for analytics/deny tracking.
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   {pattern:/\bgit\s+reset\s+--hard\b/,category:"git_reset_hard",warning:"Note: may discard uncommitted changes"}
 *   {pattern:/\bterraform\s+destroy\b/,category:"terraform_destroy",warning:"Note: may destroy Terraform infrastructure"}
 *   {pattern:/\bkubectl\s+delete\b/,category:"kubectl_delete",warning:"Note: may delete Kubernetes resources"}
 *   (and git_force_push, git_clean_force, git_checkout_dot, git_restore_dot,
 *    git_stash_drop, git_branch_force_delete, git_no_verify, git_commit_amend,
 *    rm_recursive_force, rm_recursive, rm_force, sql_drop_truncate, sql_delete_from)
 */
describe("2.1.183 destructive command deny list (e2e)", () => {
  const dcwPath = `${REPO_ROOT}/src/tools/BashTool/destructiveCommandWarning.ts`;
  const src = readFileSync(dcwPath, "utf8");

  test("source-grep: category field + binary-exact categories present", () => {
    expect(src).toContain("category: 'git_reset_hard'");
    expect(src).toContain("category: 'git_force_push'");
    expect(src).toContain("category: 'git_clean_force'");
    expect(src).toContain("category: 'git_checkout_dot'");
    expect(src).toContain("category: 'git_restore_dot'");
    expect(src).toContain("category: 'git_stash_drop'");
    expect(src).toContain("category: 'git_branch_force_delete'");
    expect(src).toContain("category: 'git_no_verify'");
    expect(src).toContain("category: 'git_commit_amend'");
    expect(src).toContain("category: 'rm_recursive_force'");
    expect(src).toContain("category: 'rm_recursive'");
    expect(src).toContain("category: 'rm_force'");
    expect(src).toContain("category: 'sql_drop_truncate'");
    expect(src).toContain("category: 'sql_delete_from'");
    expect(src).toContain("category: 'kubectl_delete'");
    expect(src).toContain("category: 'terraform_destroy'");
    // Accessors mirroring dFa / H8e.
    expect(src).toContain("getDestructiveCommandCategory");
    expect(src).toContain("findDestructiveCommand");
  });

  test("source-grep: binary-exact warnings present", () => {
    expect(src).toContain("Note: may discard uncommitted changes");
    expect(src).toContain("Note: may overwrite remote history");
    expect(src).toContain("Note: may destroy Terraform infrastructure");
    expect(src).toContain("Note: may delete Kubernetes resources");
    expect(src).toContain("Note: may recursively force-remove files");
  });

  test("runtime: getDestructiveCommandCategory matches destructive commands", async () => {
    const script = `
import { getDestructiveCommandCategory, getDestructiveCommandWarning, findDestructiveCommand } from "${dcwPath}";
console.log(JSON.stringify({
  reset: getDestructiveCommandCategory("git reset --hard HEAD~3"),
  forcePush: getDestructiveCommandCategory("git push --force origin main"),
  clean: getDestructiveCommandCategory("git clean -fdx"),
  tf: getDestructiveCommandCategory("terraform destroy"),
  kubectl: getDestructiveCommandCategory("kubectl delete pod foo"),
  rm: getDestructiveCommandCategory("rm -rf /tmp/x"),
  sql: getDestructiveCommandCategory("DROP TABLE users"),
  amend: getDestructiveCommandCategory("git commit --amend"),
  safe: getDestructiveCommandCategory("ls -la"),
  warnTf: getDestructiveCommandWarning("terraform destroy"),
  warnReset: getDestructiveCommandWarning("git reset --hard"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.reset).toBe("git_reset_hard");
    expect(out.forcePush).toBe("git_force_push");
    expect(out.clean).toBe("git_clean_force");
    expect(out.tf).toBe("terraform_destroy");
    expect(out.kubectl).toBe("kubectl_delete");
    expect(out.rm).toBe("rm_recursive_force");
    expect(out.sql).toBe("sql_drop_truncate");
    expect(out.amend).toBe("git_commit_amend");
    expect(out.safe).toBeNull();
    expect(out.warnTf).toBe("Note: may destroy Terraform infrastructure");
    expect(out.warnReset).toBe("Note: may discard uncommitted changes");
  });
});
