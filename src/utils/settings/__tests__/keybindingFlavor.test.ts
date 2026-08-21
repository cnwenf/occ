import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../types";

/**
 * 2.1.238 `keybindingFlavor` settings schema field (binary `Pr(tBu)` where
 * `tBu = ["classic", "readline"]`, `.optional().catch(void 0)`). Selects the
 * prompt's Ctrl+W convention: "readline" kills back to the previous whitespace,
 * "classic" (default) kills the previous word.
 */
describe("2.1.238 keybindingFlavor setting", () => {
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
    // undefined rather than failing settings validation, so the reader falls
    // back to the "classic" default.
    const result = SettingsSchema().safeParse({ keybindingFlavor: "emacs" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keybindingFlavor).toBeUndefined();
    }
  });
});
