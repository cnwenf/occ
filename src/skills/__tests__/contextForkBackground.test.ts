import { describe, expect, test } from "bun:test";
import {
  createSkillCommand,
  parseSkillFrontmatter,
  parseSkillFrontmatterFields,
} from "../loadSkillsDir";

/**
 * Claude Code 2.1.218 #35: "Changed skills with `context: fork` to run in the
 * background by default; opt out per skill with `background: false`."
 *
 * Default rule (parseSkillFrontmatterFields):
 * - context === 'fork' and no `background` key  → background === true
 * - context === 'fork' and `background: false`  → background === false
 * - context === 'fork' and `background: true`   → background === true
 * - context !== 'fork' (plain skill)             → background === undefined
 * - `background: false` without `context: fork`   → undefined (no-op)
 *
 * The resolved `background` is threaded through createSkillCommand onto the
 * Command so the SkillTool dispatch site can pick the background vs inline path.
 */

async function parseSkill(md: string, name = "demo") {
  const { frontmatter, content } = parseSkillFrontmatter(md, "x/SKILL.md", {
    normalizeKeys: true,
  });
  return parseSkillFrontmatterFields(frontmatter, content, name);
}

describe("2.1.218 #35: context:fork background default + background:false opt-out", () => {
  test("(a) context:fork with no background → background === true", async () => {
    const parsed = await parseSkill("---\ncontext: fork\n---\nbody");
    expect(parsed.executionContext).toBe("fork");
    expect(parsed.background).toBe(true);
  });

  test("(b) context:fork + background:false → background === false", async () => {
    const parsed = await parseSkill(
      "---\ncontext: fork\nbackground: false\n---\nbody",
    );
    expect(parsed.executionContext).toBe("fork");
    expect(parsed.background).toBe(false);
  });

  test("(c) context:fork + background:true → background === true", async () => {
    const parsed = await parseSkill(
      "---\ncontext: fork\nbackground: true\n---\nbody",
    );
    expect(parsed.executionContext).toBe("fork");
    expect(parsed.background).toBe(true);
  });

  test("(d) plain skill (no context) → background === undefined", async () => {
    const parsed = await parseSkill("---\ndescription: hi\n---\nbody");
    expect(parsed.executionContext).toBeUndefined();
    expect(parsed.background).toBeUndefined();
  });

  test("(e) background:false without context:fork is a no-op → undefined", async () => {
    const parsed = await parseSkill(
      "---\ndescription: hi\nbackground: false\n---\nbody",
    );
    expect(parsed.executionContext).toBeUndefined();
    expect(parsed.background).toBeUndefined();
  });

  test("background tokens (yes/no/on/off/1/0) coerce for fork skills", async () => {
    for (const [raw, expected] of [
      ["yes", true],
      ["on", true],
      ["1", true],
      ["no", false],
      ["off", false],
      ["0", false],
    ] as const) {
      const parsed = await parseSkill(
        `---\ncontext: fork\nbackground: ${raw}\n---\nbody`,
      );
      expect(parsed.background).toBe(expected);
    }
  });
});

describe("2.1.218 #35: createSkillCommand threads background onto the Command", () => {
  test("fork + default → command.background === true", async () => {
    const parsed = await parseSkill("---\ncontext: fork\n---\nbody");
    const cmd = createSkillCommand({
      ...parsed,
      skillName: "demo",
      markdownContent: "body",
      contentHash: "x",
      source: "userSettings" as never,
      baseDir: undefined,
      loadedFrom: "skills",
      paths: undefined,
    });
    expect(cmd.context).toBe("fork");
    expect(cmd.background).toBe(true);
  });

  test("fork + background:false → command.background === false", async () => {
    const parsed = await parseSkill(
      "---\ncontext: fork\nbackground: false\n---\nbody",
    );
    const cmd = createSkillCommand({
      ...parsed,
      skillName: "demo",
      markdownContent: "body",
      contentHash: "x",
      source: "userSettings" as never,
      baseDir: undefined,
      loadedFrom: "skills",
      paths: undefined,
    });
    expect(cmd.context).toBe("fork");
    expect(cmd.background).toBe(false);
  });

  test("plain skill → command.background === undefined", async () => {
    const parsed = await parseSkill("---\ndescription: hi\n---\nbody");
    const cmd = createSkillCommand({
      ...parsed,
      skillName: "demo",
      markdownContent: "body",
      contentHash: "x",
      source: "userSettings" as never,
      baseDir: undefined,
      loadedFrom: "skills",
      paths: undefined,
    });
    expect(cmd.context).toBeUndefined();
    expect(cmd.background).toBeUndefined();
  });
});
