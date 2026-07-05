import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { SettingsSchema } from "../settings/types";
import { getLinkedGitWorktreePath } from "../worktree";
import { runWithCwdOverride } from "../cwd";

/**
 * claude-code 2.1.97: statusLine.refreshInterval setting + workspace.git_worktree
 * in the status line JSON (set when cwd is inside a linked git worktree).
 */

describe("2.1.97 statusLine.refreshInterval schema", () => {
  test("accepts a positive integer", () => {
    expect(
      SettingsSchema().safeParse({
        statusLine: { type: "command", command: "echo hi", refreshInterval: 5 },
      }).success,
    ).toBe(true);
  });
  test("rejects values below 1", () => {
    expect(
      SettingsSchema().safeParse({
        statusLine: { type: "command", command: "echo hi", refreshInterval: 0 },
      }).success,
    ).toBe(false);
  });
  test("optional (omitted is valid)", () => {
    expect(
      SettingsSchema().safeParse({
        statusLine: { type: "command", command: "echo hi" },
      }).success,
    ).toBe(true);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();
}

describe("2.1.97 getLinkedGitWorktreePath", () => {
  let workdir: string;
  let mainRepo: string;
  let linkedWorktree: string;

  test("returns the worktree root inside a linked worktree; null in the main repo", () => {
    workdir = mkdtempSync(join(tmpdir(), "wt-"));
    mainRepo = join(workdir, "main");
    mkdirSync(mainRepo, { recursive: true });
    git(mainRepo, "init", "--initial-branch=main");
    writeFileSync(join(mainRepo, "README.md"), "v1\n");
    git(mainRepo, "add", "README.md");
    git(mainRepo, "commit", "-m", "v1");
    linkedWorktree = join(workdir, "linked");
    git(mainRepo, "worktree", "add", linkedWorktree, "-b", "feature");

    try {
      // Inside the linked worktree → returns its root.
      expect(runWithCwdOverride(linkedWorktree, () => getLinkedGitWorktreePath())).toBe(
        linkedWorktree,
      );
      // Inside a subdir of the linked worktree → still returns its root.
      const sub = join(linkedWorktree, "sub");
      mkdirSync(sub, { recursive: true });
      expect(runWithCwdOverride(sub, () => getLinkedGitWorktreePath())).toBe(
        linkedWorktree,
      );
      // Inside the main repo → null (.git is a directory, not a gitdir file).
      expect(runWithCwdOverride(mainRepo, () => getLinkedGitWorktreePath())).toBeNull();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
