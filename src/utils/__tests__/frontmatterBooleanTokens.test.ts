import { describe, expect, test } from "bun:test";
import { parseBooleanFrontmatter } from "../frontmatterParser";

/**
 * Claude Code 2.1.218: "Added `yes`/`no`/`on`/`off`/`1`/`0` (case-insensitive)
 * as accepted values for skill and plugin frontmatter booleans, alongside
 * `true`/`false`."
 *
 * Binary-verified: the feature is introduced in 2.1.218 (absent in 2.1.217).
 * OCC's YAML parser yields `yes`/`no`/`on`/`off` as strings and `1`/`0` as
 * numbers, so parseBooleanFrontmatter must coerce all of them.
 *
 * Red: before the fix, `yes`/`on`/`1`/`"1"` returned false (only literal
 * `true`/`"true"` were truthy).
 */

describe("2.1.218: frontmatter boolean tokens (yes/no/on/off/1/0)", () => {
  const truthy: unknown[] = [
    true,
    "true",
    "True",
    "TRUE",
    "yes",
    "Yes",
    "YES",
    "on",
    "On",
    "ON",
    1,
    "1",
  ];
  const falsy: unknown[] = [
    false,
    "false",
    "False",
    "FALSE",
    "no",
    "No",
    "NO",
    "off",
    "Off",
    "OFF",
    0,
    "0",
  ];

  for (const v of truthy) {
    test(`${JSON.stringify(v)} → true`, () => {
      expect(parseBooleanFrontmatter(v)).toBe(true);
    });
  }

  for (const v of falsy) {
    test(`${JSON.stringify(v)} → false`, () => {
      expect(parseBooleanFrontmatter(v)).toBe(false);
    });
  }

  test("unknown / empty values → false (not truthy)", () => {
    for (const v of [undefined, null, "", "maybe", "2", 2, {}, []]) {
      expect(parseBooleanFrontmatter(v)).toBe(false);
    }
  });

  test("whitespace-padded tokens are accepted (trimmed, case-insensitive)", () => {
    expect(parseBooleanFrontmatter("  yes  ")).toBe(true);
    expect(parseBooleanFrontmatter(" off")).toBe(false);
  });
});

describe("2.1.218: skill frontmatter boolean tokens flow through the loader", () => {
  // Exercise the real parseSkillFrontmatter + parseSkillFrontmatterFields
  // path so the new tokens are verified end-to-end at the skill-load boundary,
  // not just at the primitive.
  test("`user-invocable: yes/on/1` loads as user-invocable (true); `no/off/0` as false", async () => {
    const { parseSkillFrontmatter, parseSkillFrontmatterFields } = await import(
      "../../skills/loadSkillsDir"
    );
    const cases: Array<[string, boolean]> = [
      ["yes", true],
      ["on", true],
      ["1", true],
      ["YES", true],
      ["no", false],
      ["off", false],
      ["0", false],
      ["true", true],
      ["false", false],
    ];
    for (const [raw, expected] of cases) {
      const md = `---\nname: demo\nuser-invocable: ${raw}\n---\nbody`;
      const { frontmatter, content } = parseSkillFrontmatter(md, "x/SKILL.md", {
        normalizeKeys: true,
      });
      const parsed = parseSkillFrontmatterFields(frontmatter, content, "demo");
      expect(parsed.userInvocable).toBe(expected);
    }
  });
});
