import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../settings/types";

/**
 * claude-code 2.1.119: CLAUDE_CODE_HIDE_CWD env + prUrlTemplate setting.
 */
describe("2.1.119 prUrlTemplate setting", () => {
  test("accepts a URL template string", () => {
    expect(
      SettingsSchema().safeParse({
        prUrlTemplate: "https://internal-review.example.com/pr/{number}",
      }).success,
    ).toBe(true);
  });
  test("accepts omitted", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
  test("rejects non-string", () => {
    expect(
      SettingsSchema().safeParse({ prUrlTemplate: 123 }).success,
    ).toBe(false);
  });
});
