import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../../../utils/settings/types";
import { forceRefreshRemoteManagedSettingsOrFailClosed } from "../index";

/**
 * claude-code 2.1.92: forceRemoteSettingsRefresh policy — block startup until
 * remote managed settings are freshly fetched; exit (fail-closed) on failure.
 */
describe("2.1.92 forceRemoteSettingsRefresh: schema", () => {
  test("accepts forceRemoteSettingsRefresh: true", () => {
    expect(
      SettingsSchema().safeParse({ forceRemoteSettingsRefresh: true }).success,
    ).toBe(true);
  });
  test("accepts omitting it", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
});

describe("forceRefreshRemoteManagedSettingsOrFailClosed", () => {
  test("returns valid:true when not eligible (no backend configured)", async () => {
    // In the test env there's no remote-managed-settings backend, so the
    // fresh-fetch short-circuits to "nothing to fetch" — not a failure.
    const result = await forceRefreshRemoteManagedSettingsOrFailClosed();
    expect(result.valid).toBe(true);
    expect(typeof result.message).toBe("string");
  });
});
