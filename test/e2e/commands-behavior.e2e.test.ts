import { describe, expect, test } from "bun:test";
import { runOcc, tempDir } from "./helpers";

/**
 * Slash-command behavior e2e: drives the BUILT `dist/cli.js` in `-p` mode and
 * asserts the output matches the OFFICIAL claude-code 2.1.200 binary (verified
 * by running `/tmp/cc-200/package/claude -p '/<cmd>'` and capturing its output).
 * Per the aligning-with-official-binary skill: assert only official behavior;
 * if OCC diverges, fix OCC to match the official, don't relax the assertion.
 *
 * Gated out of CI (no model credentials there).
 */

describe.skipIf(!!process.env.CI)("slash command behavior (e2e, real model)", () => {
  test("/cost — matches official output format", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/cost", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Total cost:");
      expect(res.stdout).toContain("Total duration (API):");
      expect(res.stdout).toContain("Total code changes:");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/context — matches official output format", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/context", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("## Context Usage");
      expect(res.stdout).toContain("Model:");
      expect(res.stdout).toContain("Tokens:");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/goal (no args, no active goal) — matches official", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/goal", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("No goal set. Usage: `/goal <condition>`");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/goal clear (no active goal) — matches official", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/goal clear", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("No goal set");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/files — ant-only, unknown in non-ant env (matches official)", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/files", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      // Official: "Unknown command: /files" (the command is ant-only and not
      // registered for non-ant users). OCC must match.
      expect(res.stdout).toContain("Unknown command: /files");
    } finally {
      cleanup();
    }
  }, 90_000);

  // /feedback is an OCC customization (creates a GitHub issue on cnwenf/occ,
  // not Anthropic-bound like the official). Only the no-args usage path is
  // asserted here — the issue-creation path is verified manually (it would
  // spam the repo if run in e2e).
  test("/feedback (no args) — returns usage", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/feedback", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Usage: /feedback");
      expect(res.stdout).toContain("cnwenf/occ");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/model (local-jsx in -p) — matches official 'isn't available'", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/model", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      // Official 2.1.200: "/model isn't available in this environment."
      expect(res.stdout).toContain("/model isn't available in this environment.");
    } finally {
      cleanup();
    }
  }, 90_000);
});
