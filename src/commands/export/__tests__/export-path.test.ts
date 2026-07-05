import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveExportFilepath } from "../export";

/**
 * claude-code 2.1.98: /export honors absolute paths and ~, and no longer
 * rewrites a user-supplied extension to .txt.
 */
describe("2.1.98 resolveExportFilepath", () => {
  test("appends .txt when there is no extension", () => {
    const p = resolveExportFilepath("conversation");
    expect(p.endsWith("conversation.txt")).toBe(true);
  });

  test("preserves a user-supplied .md extension", () => {
    const p = resolveExportFilepath("notes.md");
    expect(p.endsWith("notes.md")).toBe(true);
    expect(p.endsWith(".txt")).toBe(false);
  });

  test("preserves a user-supplied .json extension", () => {
    const p = resolveExportFilepath("out.json");
    expect(p.endsWith("out.json")).toBe(true);
  });

  test("honors an absolute path", () => {
    const p = resolveExportFilepath("/tmp/occ-e2e-export/abs.md");
    expect(p).toBe("/tmp/occ-e2e-export/abs.md");
    expect(isAbsolute(p)).toBe(true);
  });

  test("honors ~ (home directory)", () => {
    const p = resolveExportFilepath("~/occ-export.md");
    expect(p).toBe(join(homedir(), "occ-export.md"));
  });

  test("honors ~ alone (home root) + appends .txt", () => {
    const p = resolveExportFilepath("~/conversation");
    expect(p).toBe(join(homedir(), "conversation.txt"));
  });

  test("a filename with a dot in a directory segment but no real extension still gets .txt", () => {
    // "foo.bar/baz" — last segment "baz" has no extension → append .txt
    const p = resolveExportFilepath("foo.bar/baz");
    expect(p.endsWith("foo.bar/baz.txt")).toBe(true);
  });
});
