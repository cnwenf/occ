import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./helpers";

/**
 * /goal REPL panel e2e (pty-based). Verifies the GoalStatus panel renders in
 * the interactive REPL — the official 2.1.200 shows a "Goal active" / "No goal
 * set" panel with condition + elapsed + turns + tokens when /goal is run with
 * no args. Drives the REPL via a pseudo-tty (`script`) since the panel is a
 * local-jsx React component (not reachable from -p text mode).
 *
 * Gated out of CI (no model creds / no pty there).
 */

describe.skipIf(!!process.env.CI)("/goal REPL panel (e2e, pty)", () => {
  test("/goal (no args) renders the status panel", async () => {
    const bin = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
    const out: string[] = [];
    await new Promise<void>((resolve) => {
      // `script` allocates a pty so the REPL renders its TUI.
      const child = spawn(
        "script",
        ["-qc", `${bin} --dangerously-skip-permissions`, "/dev/null"],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } },
      );
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += d.toString();
      });
      child.stderr!.on("data", (d) => {
        buf += d.toString();
      });
      // Send /goal + Enter after the REPL has rendered the banner.
      const sendGoal = setTimeout(() => {
        child.stdin!.write("/goal\r");
      }, 1500);
      const finish = setTimeout(() => {
        clearTimeout(sendGoal);
        try { child.stdin!.end(); } catch {}
        try { child.kill("SIGKILL"); } catch {}
        out.push(buf);
        resolve();
      }, 4500);
      child.on("exit", () => {
        clearTimeout(sendGoal);
        clearTimeout(finish);
        out.push(buf);
        resolve();
      });
    });
    const captured = out.join("");
    // Strip ANSI for matching.
    const stripped = captured.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    // The panel must render one of the status lines (no goal active here).
    expect(stripped).toMatch(/No goal set|Goal active|\/goal <condition>/);
  }, 20_000);
});
