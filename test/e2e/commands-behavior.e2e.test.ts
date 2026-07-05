import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  // M1: the Stop-hook continuation — the defining behavior. /goal <condition>
  // sets a session prompt-type Stop hook (addSessionHook) + triggers a turn;
  // execPromptHook evaluates each turn and blocks stopping until the condition
  // holds. Verifies the loop TERMINATES (exit 0, not timeout) when the goal
  // is achieved — the official architecture (sessionHooksRegistry), not a
  // bespoke evaluator.
  test("/goal <condition> — sets hook, works toward goal, terminates on achieve", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "/goal create a file named done.txt containing exactly GOAL_DONE", "--dangerously-skip-permissions"],
        { OCC_CWD: dir },
        120_000,
      );
      // Loop must terminate (not time out → code !== -1).
      expect(res.code).toBe(0);
      // The goal was achieved: the file exists with the requested content.
      const exists = existsSync(join(dir, "done.txt"));
      expect(exists).toBe(true);
      if (exists) {
        expect(readFileSync(join(dir, "done.txt"), "utf8")).toContain("GOAL_DONE");
      }
    } finally {
      cleanup();
    }
  }, 150_000);

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

  test("/config (no args) — matches official usage", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/config", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.stdout).toContain("Usage: /config key=value");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/config <unknown>=<v> — matches official rejection", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/config foo=bar", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.stdout).toContain("foo isn't a /config setting");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/config <valid>=<v> — sets the setting (matches official)", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/config verbose=true", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.stdout).toContain("Set verbose to true");
    } finally {
      cleanup();
    }
  }, 90_000);

  test("/config (no args) — lists the settings key set", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(["-p", "/config", "--dangerously-skip-permissions"], { OCC_CWD: dir }, 60_000);
      expect(res.stdout).toContain("Usage: /config key=value");
      expect(res.stdout).toContain("autoCompact=");
      expect(res.stdout).toContain("verbose=");
    } finally {
      cleanup();
    }
  }, 90_000);

  // Auto mode e2e: --permission-mode auto + a tool call. The classifier
  // (classifyYoloAction) should auto-approve a safe Write (file in the
  // working directory) WITHOUT manual approval. This is the core auto mode
  // behavior — previously dead code (feature('TRANSCRIPT_CLASSIFIER') was
  // DCE'd); now functional via src/utils/featureFlags.ts.
  test("auto mode — classifier auto-approves a safe Write tool call", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "Use the Write tool to create a file named auto.txt containing exactly AUTO_OK", "--permission-mode", "auto"],
        { OCC_CWD: dir, CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
        90_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "auto.txt"))).toBe(true);
      if (existsSync(join(dir, "auto.txt"))) {
        expect(readFileSync(join(dir, "auto.txt"), "utf8")).toContain("AUTO_OK");
      }
    } finally {
      cleanup();
    }
  }, 120_000);

  // Note: auto mode deny (destructive command not auto-approved) is
  // model-dependent — the classifier's decision depends on the model's
  // judgment. With GLM, the classifier may not be conservative enough to
  // deny `rm`. The official uses a Claude-tuned classifier. This scenario
  // is verified manually, not in e2e (model-quality, not code).
});
