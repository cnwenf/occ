import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../types";

/**
 * claude-code 2.1.110: `autoScrollEnabled` config to disable conversation
 * auto-scroll in fullscreen mode.
 */
describe("2.1.110 autoScrollEnabled setting", () => {
  test("accepts true", () => {
    expect(
      SettingsSchema().safeParse({ autoScrollEnabled: true }).success,
    ).toBe(true);
  });
  test("accepts false", () => {
    expect(
      SettingsSchema().safeParse({ autoScrollEnabled: false }).success,
    ).toBe(true);
  });
  test("accepts omitted", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
  test("rejects non-boolean", () => {
    expect(
      SettingsSchema().safeParse({ autoScrollEnabled: "yes" }).success,
    ).toBe(false);
  });
});
