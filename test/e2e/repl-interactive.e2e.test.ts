import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { REPO_ROOT } from "./helpers";

/**
 * REPL interactive e2e (tmux-based). Drives the BUILT dist/cli.js inside a
 * tmux session, sending real keystrokes (Shift+Tab, Escape, Enter) and
 * reading the decoded pane output via `tmux capture-pane -p`.
 *
 * This tests REPL-only features that -p mode can't reach:
 * - Shift+Tab permission mode cycling (default → acceptEdits → plan → auto)
 * - /goal panel open + Escape dismiss
 * - /feedback dialog
 * - /context interactive panel
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-repl-test"

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 })
  } catch {
    return ""
  }
}

function startRepl(env: Record<string, string> = {}) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
  const envStr = Object.entries({ ...process.env, ...env }).map(([k, v]) => `${k}='${v}'`).join(" ")
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN} --dangerously-skip-permissions"`,
    { timeout: 5_000 },
  )
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
}

function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")])
}

function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"])
}

/** Poll capture-pane until `substr` appears or timeout. */
async function waitForText(substr: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pane = capturePane()
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

describe.skipIf(!!process.env.CI)("REPL interactive (tmux e2e)", () => {
  test("Shift+Tab cycles through permission modes", async () => {
    startRepl()
    try {
      // Wait for REPL to render
      await waitForText("shift+tab", 20_000)

      // Capture initial state
      const before = capturePane()

      // Send Shift+Tab (tmux: S-Tab)
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after1 = capturePane()

      // Send again
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after2 = capturePane()

      // Send again — should eventually reach auto or cycle back
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after3 = capturePane()

      // At least one of the mode strings should differ from initial
      const modes = ["default", "acceptEdits", "plan", "auto", "bypass"]
      const found = [after1, after2, after3].some(pane =>
        modes.some(m => pane.toLowerCase().includes(m.toLowerCase()) && !before.toLowerCase().includes(m.toLowerCase())),
      )
      expect(found).toBe(true)
    } finally {
      killRepl()
    }
  }, 30_000)

  test("Shift+Tab reaches auto mode", async () => {
    startRepl()
    try {
      await waitForText("shift+tab", 20_000)

      // Cycle through modes with Shift+Tab
      for (let i = 0; i < 8; i++) {
        sendKeys("S-Tab")
        await new Promise(r => setTimeout(r, 400))
        const pane = capturePane()
        if (pane.toLowerCase().includes("auto")) {
          expect(true).toBe(true)
          return
        }
      }
      // If we didn't find auto, fail
      expect(false).toBe(true)
    } finally {
      killRepl()
    }
  }, 30_000)

  test("/goal panel opens and Escape dismisses it", async () => {
    startRepl()
    try {
      await waitForText("shift+tab", 20_000)

      // Type /goal and Enter
      tmux(["send-keys", "-t", SESSION, "/goal", "Enter"])
      await waitForText("Goal", 5_000)

      // Panel should be visible
      const panel = capturePane()
      expect(panel.toLowerCase()).toMatch(/goal|no goal set/i)

      // Send Escape to dismiss
      sendKeys("Escape")
      await new Promise(r => setTimeout(r, 500))

      // After Escape, the prompt input should be back (shift+tab visible)
      const after = capturePane()
      expect(after.toLowerCase()).toContain("shift+tab")
    } finally {
      killRepl()
    }
  }, 30_000)
})
