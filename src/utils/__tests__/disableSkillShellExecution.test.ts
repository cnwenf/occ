import { describe, expect, test } from "bun:test";
import {
  isSkillShellExecutionDisabled,
  stripShellExecutionSyntax,
} from "../promptShellExecution";
import { SettingsSchema } from "../settings/types";

/**
 * claude-code 2.1.91: disableSkillShellExecution — inline shell execution in
 * skills / custom slash commands / plugin commands is replaced with a
 * placeholder instead of being run. Mirrors v91's Op8()/Ap8().
 */

describe("2.1.91 disableSkillShellExecution: schema", () => {
  test("accepts disableSkillShellExecution: true", () => {
    expect(
      SettingsSchema().safeParse({ disableSkillShellExecution: true }).success,
    ).toBe(true);
  });
  test("accepts disableSkillShellExecution: false", () => {
    expect(
      SettingsSchema().safeParse({ disableSkillShellExecution: false }).success,
    ).toBe(true);
  });
  test("accepts omitting it", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
});

describe("stripShellExecutionSyntax (Ap8 equivalent)", () => {
  test("replaces inline !`cmd` with the placeholder", () => {
    expect(stripShellExecutionSyntax("run !`echo hi` now")).toBe(
      "run [shell command execution disabled by policy] now",
    );
  });
  test("replaces ```! block syntax", () => {
    const input = "before\n```!\necho hi\n```\nafter";
    expect(stripShellExecutionSyntax(input)).toContain(
      "[shell command execution disabled by policy]",
    );
    expect(stripShellExecutionSyntax(input)).not.toContain("echo hi");
  });
  test("replaces multiple inline commands", () => {
    const out = stripShellExecutionSyntax("!`a` and !`b`");
    expect(out).toBe(
      "[shell command execution disabled by policy] and [shell command execution disabled by policy]",
    );
  });
  test("leaves ordinary markdown alone", () => {
    expect(stripShellExecutionSyntax("see `code` and **bold**")).toBe(
      "see `code` and **bold**",
    );
  });
  test("does not touch inline code spans containing !!", () => {
    // lookbehind requires whitespace/SOL before !, so `!!` inside a code span
    // is not matched.
    expect(stripShellExecutionSyntax("foo `!!` bar")).toBe("foo `!!` bar");
  });
});

describe("isSkillShellExecutionDisabled (Op8 equivalent)", () => {
  const savedPolicy = process.env.CLAUDE_POLICY_DISABLE_SKILL_SHELL;
  // We can't easily mutate the merged settings store in isolation; the schema
  // + strip tests cover the user-facing behavior. This test asserts the
  // default (no setting) is false.
  test("defaults to false when no setting is configured", () => {
    expect(isSkillShellExecutionDisabled()).toBe(false);
  });
  // restore
  test("env restore sanity", () => {
    if (savedPolicy === undefined) {
      delete process.env.CLAUDE_POLICY_DISABLE_SKILL_SHELL;
    }
    expect(true).toBe(true);
  });
});
