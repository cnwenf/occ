import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../types";
import { EXTERNAL_PERMISSION_MODES } from "../../../types/permissions";

/**
 * claude-code 2.1.91: "Fixed JSON schema validation for
 * `permissions.defaultMode: "auto"` in settings.json." 'auto' was missing
 * from the user-addressable enum (EXTERNAL_PERMISSION_MODES) — the runtime
 * already handled it, only the schema rejected it.
 */
describe("2.1.91 defaultMode: auto validates", () => {
  test("EXTERNAL_PERMISSION_MODES includes 'auto'", () => {
    expect(EXTERNAL_PERMISSION_MODES).toContain("auto");
  });

  test("SettingsSchema accepts permissions.defaultMode: 'auto'", () => {
    const result = SettingsSchema().safeParse({
      permissions: { defaultMode: "auto" },
    });
    expect(result.success).toBe(true);
  });

  test("SettingsSchema still accepts the other modes (regression)", () => {
    for (const mode of [
      "acceptEdits",
      "bypassPermissions",
      "default",
      "dontAsk",
      "plan",
    ]) {
      expect(
        SettingsSchema().safeParse({ permissions: { defaultMode: mode } })
          .success,
      ).toBe(true);
    }
  });

  test("SettingsSchema rejects an unknown defaultMode", () => {
    expect(
      SettingsSchema().safeParse({
        permissions: { defaultMode: "not-a-real-mode" },
      }).success,
    ).toBe(false);
  });
});
