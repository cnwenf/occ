import { afterEach, describe, expect, test } from "bun:test";
import { getAutoUpdaterDisabledReason } from "../config";

/**
 * claude-code 2.1.118: DISABLE_UPDATES blocks ALL update paths (auto + manual),
 * stricter than DISABLE_AUTOUPDATER (auto only).
 */
const SAVED_U = process.env.DISABLE_UPDATES;
const SAVED_A = process.env.DISABLE_AUTOUPDATER;
afterEach(() => {
  for (const [k, v] of Object.entries({
    DISABLE_UPDATES: SAVED_U,
    DISABLE_AUTOUPDATER: SAVED_A,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("2.1.118 DISABLE_UPDATES", () => {
  test("DISABLE_UPDATES blocks (returns env reason)", () => {
    delete process.env.DISABLE_AUTOUPDATER;
    process.env.DISABLE_UPDATES = "1";
    const r = getAutoUpdaterDisabledReason();
    expect(r).not.toBeNull();
    expect(r?.type).toBe("env");
    expect(r?.envVar).toBe("DISABLE_UPDATES");
  });

  test("DISABLE_UPDATES takes precedence over DISABLE_AUTOUPDATER", () => {
    process.env.DISABLE_UPDATES = "1";
    process.env.DISABLE_AUTOUPDATER = "1";
    const r = getAutoUpdaterDisabledReason();
    expect(r?.envVar).toBe("DISABLE_UPDATES");
  });

  test("DISABLE_AUTOUPDATER still works when DISABLE_UPDATES is unset", () => {
    delete process.env.DISABLE_UPDATES;
    process.env.DISABLE_AUTOUPDATER = "1";
    const r = getAutoUpdaterDisabledReason();
    expect(r?.envVar).toBe("DISABLE_AUTOUPDATER");
  });
});
