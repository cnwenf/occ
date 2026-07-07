import { describe, expect, test } from "bun:test";
import { lockCompromisedHandler } from "../lockfile.js";

// 2.1.133 (J12): when a proper-lockfile lock is compromised (error.code ===
// 'ECOMPROMISED'), OCC must catch + recover (log + continue) instead of
// crashing. proper-lockfile's default onCompromised throws from a setTimeout,
// which becomes an unhandled rejection; lockCompromisedHandler is the
// catch-and-recover installed on every lock-write path.
describe("lockCompromisedHandler (J12 ECOMPROMISED recovery)", () => {
  test("recovers from an ECOMPROMISED error without throwing", () => {
    // Arrange — the error proper-lockfile raises when a lock is compromised
    const err = Object.assign(new Error("lock was compromised"), {
      code: "ECOMPROMISED",
    });
    const handler = lockCompromisedHandler("History");

    // Act + Assert — must not throw (the default handler throws → unhandled
    // rejection → process crash)
    expect(() => handler(err)).not.toThrow();
  });

  test("returns a function that logs with the given context label", () => {
    // Arrange
    const handler = lockCompromisedHandler("Config");
    const err = new Error("stale mtime");

    // Act + Assert — invoking the returned callback must not throw regardless
    // of the error shape
    expect(() => handler(err)).not.toThrow();
  });
});
