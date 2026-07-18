import { describe, expect, test } from "bun:test";
import { injectModifiedFrontmatter } from "../memorySaveNormalizer";

/**
 * M11 (Claude Code 2.1.214): ISO `modified` timestamp injected/updated in
 * memory file frontmatter on save. Pure-function TDD for injectModifiedFrontmatter.
 *
 * `modified` value = ISO 8601 via new Date().toISOString() (binary-verified:
 * official 2.1.214 strings show `new Date(...).toISOString()`).
 */

const ISO = "2026-07-18T14:30:47.123Z";

describe("M11 (2.1.214): injectModifiedFrontmatter (pure)", () => {
  test("no frontmatter block → creates one with modified", () => {
    const out = injectModifiedFrontmatter("just body text", ISO);
    expect(out).toBe(`---\nmodified: ${ISO}\n---\n\njust body text`);
  });

  test("frontmatter without modified → inserts modified line", () => {
    const raw = "---\nname: a-name\ndescription: some fact\n---\nbody";
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toContain(`modified: ${ISO}`);
    // other keys preserved byte-for-byte
    expect(out).toContain("name: a-name");
    expect(out).toContain("description: some fact");
    // still valid frontmatter shape
    expect(out.startsWith("---\n")).toBe(true);
  });

  test("frontmatter with modified: old → replaces value, preserves other keys", () => {
    const raw = "---\nmodified: 2000-01-01T00:00:00.000Z\nname: a-name\n---\nbody";
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toContain(`modified: ${ISO}`);
    expect(out).not.toContain("2000-01-01");
    expect(out).toContain("name: a-name");
  });

  test("quoted modified value → keeps quotes, swaps value", () => {
    const raw = `---\nmodified: "old"\n---\nbody`;
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toContain(`modified: "${ISO}"`);
  });

  test("modified with trailing # comment → preserves comment", () => {
    const raw = "---\nmodified: old # keep this comment\n---\nbody";
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toContain(`modified: ${ISO} # keep this comment`);
  });

  test("idempotent: modified already === iso → unchanged", () => {
    const raw = `---\nmodified: ${ISO}\nname: x\n---\nbody`;
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toBe(raw);
  });

  test("other # values (M10) preserved, not touched", () => {
    const raw = "---\ndescription: uses # for comments\nmodified: old\n---\nbody";
    const out = injectModifiedFrontmatter(raw, ISO);
    expect(out).toContain("description: uses # for comments");
    expect(out).toContain(`modified: ${ISO}`);
  });

  test("delimiters + body bytes preserved (only modified line changes)", () => {
    const raw = "---\nname: x\nmodified: old\n---\nbody line 1\nbody line 2";
    const out = injectModifiedFrontmatter(raw, ISO);
    // body untouched
    expect(out).toContain("body line 1\nbody line 2");
    // frontmatter still closes cleanly
    expect(out.match(/---\n[\s\S]*?\n---\n/)).toBeTruthy();
  });
});
