import { describe, expect, test } from "bun:test";
import {
  DANGEROUS_DIRECTORIES,
  isDangerousFilePathToAutoEdit,
} from "../filesystem";

describe("DANGEROUS_DIRECTORIES (claude-code 2.1.90: .husky protected)", () => {
  test("includes .husky", () => {
    expect(DANGEROUS_DIRECTORIES).toContain(".husky");
  });

  test("still includes the pre-2.1.90 set", () => {
    expect(DANGEROUS_DIRECTORIES).toEqual([
      ".git",
      ".vscode",
      ".idea",
      ".claude",
      ".husky",
    ]);
  });
});

describe("isDangerousFilePathToAutoEdit: .husky", () => {
  test("blocks a file directly under .husky/", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.husky/pre-commit")).toBe(true);
  });

  test("blocks a nested file under .husky/", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.husky/scripts/lint.sh")).toBe(
      true,
    );
  });

  test("is case-insensitive against .husky", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.HUSKY/pre-commit")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/repo/.HuSkY/pre-commit")).toBe(true);
  });

  test("still blocks .git paths (regression)", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.git/config")).toBe(true);
  });

  test("does not block an ordinary source path", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/src/index.ts")).toBe(false);
  });

  test("does not block a file merely named like .husky (segment match only)", () => {
    // A file named ".husky" at the root is a segment match → blocked.
    // But a file whose *name* contains husky but isn't in a .husky dir is fine.
    expect(isDangerousFilePathToAutoEdit("/repo/husky-config.json")).toBe(false);
  });
});
