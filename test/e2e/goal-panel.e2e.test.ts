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

    /** Visual strip: partial repaints emit spaces as cursor-forward
     * (`\x1b[<n>C`) — expand those to n spaces BEFORE dropping the remaining
     * ANSI sequences, otherwise "No goal set" collapses to "Nogoalset" and
     * the panel assertion misses text that is visually on screen. */
    const visual = (s: string): string =>
      s
        .replace(/\x1b\[(\d*)C/g, (_m, n) => " ".repeat(n === "" ? 1 : parseInt(n, 10)))
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

    const PANEL_RE = /No goal set|Goal active|\/goal <condition>/;
    // Drive by polling, not fixed timers: send /goal once the input box is up
    // (prompt caret / footer hint visible), then wait for the panel until the
    // deadline. The old fixed 1.5s-send / 4.5s-kill window was load-sensitive
    // — a slow boot missed it entirely.
    const deadline = Date.now() + 15_000;
    let goalSent = false;
    let matched = false;
    while (Date.now() < deadline) {
      const text = visual(buf);
      if (!goalSent && /❯|shift\+tab/i.test(text)) {
        goalSent = true;
        child.stdin!.write("/goal\r");
      }
      if (goalSent && PANEL_RE.test(text)) {
        matched = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    try { child.stdin!.end(); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    // The panel must render one of the status lines (no goal active here).
    expect(matched || PANEL_RE.test(visual(buf))).toBe(true);
  }, 20_000);
});
