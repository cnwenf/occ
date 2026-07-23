import { describe, expect, test } from "bun:test";
import { runOcc, tempDir } from "./helpers";

/**
 * OCC-12: `/verify` reachability for non-`ant` users.
 *
 * Official Claude Code 2.1.215 registers `/verify` unconditionally (no
 * USER_TYPE gate, no `isEnabled`) — verified against the official binary:
 * `Lu({name:"verify",description:...,userInvocable:!0,disableModelInvocation:!0,...})`
 * called from the init-once `GXo()` skill-registration list with no USER_TYPE
 * guard. OCC previously early-returned `if (USER_TYPE !== 'ant') return` in
 * `registerVerifySkill()`, so non-ant users got `Unknown command: /verify`.
 *
 * This e2e drives the BUILT `dist/cli.js` in `-p` mode as a non-ant user
 * (USER_TYPE='external') and asserts the official reachability contract:
 *   1. `/verify` is no longer "Unknown command" (the skill loads),
 *   2. an empty-context invocation produces a reasonable response (the
 *      ported official skill body drives the model to a structured SKIP),
 *   3. a manual trigger runs (exit 0).
 *
 * Per aligning-with-official-binary: assert only official behavior; per
 * behavior-driven-done: this is a behavioral (not source-grep) gate.
 * Gated out of CI (no model credentials there).
 */

describe.skipIf(!!process.env.CI)("/verify reachability for non-ant users (e2e, real model)", () => {
  test("non-ant user: /verify loads (not 'Unknown command'), empty context is reasonable, runs to exit 0", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // USER_TYPE='external' simulates a normal (non-ant) user. Before the
      // OCC-12 fix this returned "Unknown command: /verify"; the official
      // binary exposes /verify to every user.
      //
      // `/verify` drives a heavy multi-tool-call turn (the model lists the
      // workdir, probes git, etc.), so on a flaky proxy it needs the same
      // retry budget a real interactive session uses. runOcc caps retries to
      // fail fast; inherit the runner's retry config here so the behavioral
      // assertion isn't masked by transient proxy flakiness.
      const env: Record<string, string> = {
        OCC_CWD: dir,
        USER_TYPE: "external",
      };
      if (process.env.CLAUDE_CODE_MAX_RETRIES)
        env.CLAUDE_CODE_MAX_RETRIES = process.env.CLAUDE_CODE_MAX_RETRIES;
      if (process.env.CLAUDE_CODE_UNATTENDED_RETRY)
        env.CLAUDE_CODE_UNATTENDED_RETRY = process.env.CLAUDE_CODE_UNATTENDED_RETRY;
      const res = await runOcc(
        ["-p", "/verify", "--dangerously-skip-permissions"],
        env,
        180_000,
      );

      // (3) manual trigger runs to completion.
      expect(res.code).toBe(0);

      // (1) the skill loaded — /verify is no longer an unknown command.
      expect(res.stdout).not.toContain("Unknown command");
      expect(res.stdout.toLowerCase()).not.toContain("unknown command: /verify");

      // (2) empty-context response is reasonable: the model drove the ported
      // official verify skill body and discussed verification (it always
      // mentions the verify/verification scope, and in an empty dir reaches a
      // structured SKIP per the skill's "No repo -> say so, stop" guidance).
      const out = res.stdout.toLowerCase();
      expect(out).toContain("verif");
      // The official skill body's runtime-surface / scope guidance surfaces:
      // the model either asks for a change to point at, or states there is
      // nothing to verify. Either is a reasonable empty-context prompt.
      const reasonable =
        out.includes("nothing to verify") ||
        (out.includes("no ") && out.includes("runtime surface")) ||
        out.includes("skip") ||
        out.includes("point me") ||
        out.includes("scope");
      expect(reasonable).toBe(true);
    } finally {
      cleanup();
    }
  }, 200_000);
});
