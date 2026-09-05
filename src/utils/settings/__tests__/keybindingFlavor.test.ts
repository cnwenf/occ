import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../types";

/**
 * `keybindingFlavor` settings schema field. Introduced in 2.1.238 (binary
 * `Pr(tBu)` where `tBu = ["classic", "readline"]`, `.optional().catch(void 0)`).
 *
 * 2.1.261: DEPRECATED — the setting is retained in the schema purely so existing
 * settings files still parse, but it no longer has any effect. Upstream deleted
 * the classic word-editing methods; the prompt's word-editing keys now always
 * follow Bash (readline) conventions. The enum + `.optional().catch(undefined)`
 * shape is unchanged (byte-verified), so these parsing assertions still hold.
 */
describe("keybindingFlavor setting (deprecated 2.1.261)", () => {
  test("accepts 'classic'", () => {
    const result = SettingsSchema().safeParse({ keybindingFlavor: "classic" });
    expect(result.success).toBe(true);
  });

  test("accepts 'readline' and passes the value through", () => {
    const result = SettingsSchema().safeParse({ keybindingFlavor: "readline" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keybindingFlavor).toBe("readline");
    }
  });

  test("accepts omitted key", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });

  test("catches an invalid enum value to undefined (does not reject)", () => {
    // Mirrors the official `.catch(void 0)` — unknown values are neutralized to
    // undefined rather than failing settings validation. Since 2.1.261 the value
    // is ignored entirely, so this only asserts the schema stays permissive.
    const result = SettingsSchema().safeParse({ keybindingFlavor: "emacs" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keybindingFlavor).toBeUndefined();
    }
  });
});
