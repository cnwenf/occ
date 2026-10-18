/**
 * OCC-122 P3-4 — CI backstop for the /feedback e2e cleanup-first contract.
 *
 * The live e2e (commands-behavior.e2e.test.ts, "/feedback <text>") is gated
 * off CI (describe.skipIf(!!process.env.CI) — no model credentials there), so
 * the cleanup-first ordering that used to live INSIDE the test body had no CI
 * coverage: a refactor that moved the `gh issue close` after the assertions
 * (reintroducing the dangling-issue leak the OCC-121 fix closed) would ship
 * green. The logic now lives in the pure `extractAndCloseFeedbackIssue`
 * helper (helpers.ts) with an injectable closeFn — these tests pin the
 * contract in CI without gh, a live model, or a spawned CLI.
 *
 * Contract under test:
 *   1. URL present  → closeFn(issueNum) has ALREADY run by the time the
 *      helper returns the match (cleanup strictly before any caller
 *      assertion — the ordering IS the invariant).
 *   2. closeFn throws → the error is swallowed (best-effort cleanup never
 *      masks the caller's own assertions) and the match is still returned.
 *   3. No URL → closeFn is never called; null is returned (the caller then
 *      hard-asserts the null and fails AFTER cleanup was attempted).
 *
 * Mutation-verified: dropping the try/catch turns test 2 RED; skipping the
 * closeFn call (returning the match without closing) turns test 1 RED.
 */
import { describe, expect, test } from "bun:test";
import { FEEDBACK_ISSUE_URL_RE, extractAndCloseFeedbackIssue } from "./helpers";

describe("extractAndCloseFeedbackIssue — cleanup-first contract (CI backstop)", () => {
  test("closes the issue BEFORE returning the URL match", () => {
    // Arrange
    const events: string[] = [];
    const stdout =
      "Feedback received. Issue created: https://github.com/cnwenf/occ/issues/4242 — thanks!";
    // Act
    const match = extractAndCloseFeedbackIssue(stdout, (issueNum) => {
      events.push(`close:${issueNum}`);
    });
    // The invariant: by the time the caller receives the match (i.e. before
    // any caller assertion can run), the close has already happened.
    events.push("returned");
    // Assert
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("4242");
    expect(events).toEqual(["close:4242", "returned"]);
  });

  test("swallows a closeFn failure and still returns the match", () => {
    const stdout = "Filed ✅ https://github.com/cnwenf/occ/issues/99";
    let called = false;
    const match = extractAndCloseFeedbackIssue(stdout, () => {
      called = true;
      throw new Error("gh: network unreachable");
    });
    expect(called).toBe(true);
    expect(match?.[1]).toBe("99");
  });

  test("no URL in stdout → no close attempt, returns null", () => {
    let called = false;
    const match = extractAndCloseFeedbackIssue(
      "The model never got to filing the issue (run timed out).",
      () => {
        called = true;
      },
    );
    expect(match).toBeNull();
    expect(called).toBe(false);
  });

  test("regex only matches cnwenf/occ issue URLs (no over-broad capture)", () => {
    expect(
      "https://github.com/other/repo/issues/1".match(FEEDBACK_ISSUE_URL_RE),
    ).toBeNull();
    const m = "x https://github.com/cnwenf/occ/issues/7 y".match(
      FEEDBACK_ISSUE_URL_RE,
    );
    expect(m?.[1]).toBe("7");
  });

  test("multiple URLs → the first issue number is closed once", () => {
    const closed: string[] = [];
    const stdout =
      "https://github.com/cnwenf/occ/issues/10 and https://github.com/cnwenf/occ/issues/11";
    const match = extractAndCloseFeedbackIssue(stdout, (n) => closed.push(n));
    expect(match?.[1]).toBe("10");
    expect(closed).toEqual(["10"]);
  });
});
