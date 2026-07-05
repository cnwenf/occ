import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../types";

/**
 * claude-code 2.1.89: "Changed `cleanupPeriodDays: 0` in settings.json to be
 * rejected with a validation error — it previously silently disabled transcript
 * persistence." Schema moves from .nonnegative() (allowed 0) to .positive()
 * (rejects 0 with zod `too_small`).
 */
describe("2.1.89 cleanupPeriodDays: 0 is rejected", () => {
  test("rejects 0 with a too_small code", () => {
    const result = SettingsSchema().safeParse({ cleanupPeriodDays: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "cleanupPeriodDays",
      );
      expect(issue).toBeDefined();
      expect(issue!.code).toBe("too_small");
    }
  });

  test("rejects negative values", () => {
    expect(
      SettingsSchema().safeParse({ cleanupPeriodDays: -5 }).success,
    ).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(
      SettingsSchema().safeParse({ cleanupPeriodDays: 1.5 }).success,
    ).toBe(false);
  });

  test("accepts a positive integer", () => {
    expect(
      SettingsSchema().safeParse({ cleanupPeriodDays: 30 }).success,
    ).toBe(true);
  });

  test("accepts 1 (the minimum)", () => {
    expect(
      SettingsSchema().safeParse({ cleanupPeriodDays: 1 }).success,
    ).toBe(true);
  });

  test("accepts a large retention value", () => {
    expect(
      SettingsSchema().safeParse({ cleanupPeriodDays: 3650 }).success,
    ).toBe(true);
  });

  test("accepts undefined (falls back to default)", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
});
