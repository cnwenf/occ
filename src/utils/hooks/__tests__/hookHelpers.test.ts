import { describe, expect, test } from "bun:test";
import { hookResponseSchema } from "../hookHelpers.js";

/**
 * D8: the goal Stop-hook evaluator accepts a third state `impossible` (the
 * goal cannot be achieved, distinct from "not yet met"). Mirrors official
 * `O.impossible` → "Goal could not be achieved" panel.
 */
describe("hookResponseSchema (goal impossible state, D8)", () => {
  test("accepts {ok: true}", () => {
    expect(hookResponseSchema().safeParse({ ok: true }).success).toBe(true);
  });

  test("accepts {ok: false, reason}", () => {
    const r = hookResponseSchema().safeParse({ ok: false, reason: "not yet" });
    expect(r.success).toBe(true);
  });

  test("accepts {ok: false, impossible: true, reason}", () => {
    const r = hookResponseSchema().safeParse({
      ok: false,
      impossible: true,
      reason: "the goal contradicts itself",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.impossible).toBe(true);
      expect(r.data.reason).toBe("the goal contradicts itself");
    }
  });

  test("rejects missing ok", () => {
    expect(hookResponseSchema().safeParse({ reason: "x" }).success).toBe(false);
  });
});
