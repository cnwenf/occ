import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../frontmatterParser";

/**
 * M10 (Claude Code 2.1.214): memory frontmatter values were silently
 * truncated at an inline `#` (YAML comment marker). OCC's parseFrontmatter
 * only ran quoteProblematicValues on the parse-ERROR retry path, so a value
 * like `description: uses # for comments` parsed "successfully" (truncated to
 * `uses`) and was never quoted. Fix: pre-quote `#`-comment values on the
 * primary parse path.
 *
 * Red: before the fix, `uses # for comments` → `"uses"`.
 */

describe("M10 (2.1.214): frontmatter # truncation", () => {
  test("value with an inline ` #` is preserved (not truncated)", () => {
    const md = "---\ndescription: uses # for comments here\n---\nbody";
    const r = parseFrontmatter(md);
    expect(r.frontmatter?.description).toBe("uses # for comments here");
  });

  test("value starting with `#` is preserved", () => {
    const md = "---\nname: #hash-started-name\n---\nbody";
    const r = parseFrontmatter(md);
    expect(r.frontmatter?.name).toBe("#hash-started-name");
  });

  test("value with `#` but no preceding space (a#b) is unchanged", () => {
    // YAML does not treat a#b as a comment; ensure we don't over-quote.
    const md = "---\nname: a#b\n---\nbody";
    const r = parseFrontmatter(md);
    expect(r.frontmatter?.name).toBe("a#b");
  });

  test("plain value with no `#` is unchanged (regression)", () => {
    const md = "---\nname: plain-name\n---\nbody";
    const r = parseFrontmatter(md);
    expect(r.frontmatter?.name).toBe("plain-name");
  });

  test("already-quoted `#` value is preserved (regression)", () => {
    const md = '---\ndescription: "uses # quoted"\n---\nbody';
    const r = parseFrontmatter(md);
    expect(r.frontmatter?.description).toBe("uses # quoted");
  });
});
