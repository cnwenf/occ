import { describe, expect, test } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers'

/**
 * Behavioral e2e for the 2.1.208 #25 fix: the workflow save dialog must show
 * the CLAUDE_CONFIG_DIR location (not a hardcoded ~/.claude/workflows/) for
 * user-scope saves, AND the file must land there.
 *
 * Flow (real tmux REPL, real model call to the Workflow tool):
 *   1. Seed a project workflow script (.claude/workflows/e2esave.js) + a
 *      fresh HOME + CLAUDE_CONFIG_DIR (+ .claude.json/settings in BOTH, since
 *      CLAUDE_CONFIG_DIR relocates where OCC reads its config).
 *   2. Start the REPL via a wrapper script (robust env passthrough — tmux does
 *      NOT inherit the parent shell env) with --dangerously-skip-permissions.
 *   3. Accept the bypass-permissions confirmation (Down + Enter).
 *   4. Ask the model to run the workflow by name → a local_workflow task with
 *      scriptPath = the on-disk script is created + completes.
 *   5. /workflows → Down (past the disabled header) → Enter (select run) →
 *      's' (save dialog) → Tab (toggle to User scope).
 *   6. capture-pane: assert the subtitle shows the CLAUDE_CONFIG_DIR temp
 *      path (User scope · <tmp>/workflows/e2esave.js), NOT ~/.claude.
 *   7. Enter → assert the file landed under CLAUDE_CONFIG_DIR/workflows.
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`
const SESSION = 'occ-wf-save-test'

const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? ''
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? ''
const MODEL = process.env.ANTHROPIC_MODEL ?? 'glm-5.2'
const SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? MODEL

const SCRIPT_SOURCE = `export const meta = { name: 'e2esave', description: 'e2e save test', phases: ['run'] };
export default async ({ log }) => { log('e2e-save-test'); return 'done' };
`

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return ''
  }
}

/** Type text char-by-char with a delay to avoid React state-batching drops. */
async function typeText(text: string, delayMs = 50): Promise<void> {
  for (const ch of text) {
    tmux(['send-keys', '-t', SESSION, '-l', ch])
    await new Promise(r => setTimeout(r, delayMs))
  }
}

function sendKey(key: string): void {
  tmux(['send-keys', '-t', SESSION, key])
}

function capturePane(): string {
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-'])
}

async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pane = capturePane()
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

function killRepl(): void {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
}

/** Seed .claude.json + settings in BOTH HOME and CLAUDE_CONFIG_DIR (the
 * config dir is where OCC reads from when CLAUDE_CONFIG_DIR is set). */
function seedDirs(home: string, configDir: string, projectDir: string): void {
  for (const d of [home, configDir]) {
    mkdirSync(join(d, '.claude'), { recursive: true })
    writeFileSync(
      join(d, '.claude.json'),
      JSON.stringify({
        numStartups: 1,
        firstStartTime: '2026-07-06T00:00:00.000Z',
        migrationVersion: 11,
        userID: 'occ-wf-save-0000000000000000000000000000000000000000000000aa',
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.200',
        lastReleaseNotesSeen: '2.1.200',
        projects: { [projectDir]: { hasTrustDialogAccepted: true } },
      }),
    )
    writeFileSync(
      join(d, '.claude', 'settings.json'),
      JSON.stringify({ skipDangerousModePermissionPrompt: true, disableAllHooks: true }),
    )
  }
}

/** Write a wrapper script so the env reliably reaches the OCC process (tmux
 * does NOT re-export the parent shell env). */
function writeWrapper(
  home: string,
  configDir: string,
  projectDir: string,
): string {
  const wrapper = `${projectDir}/.occ-run-wf.sh`
  const lines = [
    '#!/bin/bash',
    `export HOME='${home}'`,
    `export CLAUDE_CONFIG_DIR='${configDir}'`,
    `export ANTHROPIC_AUTH_TOKEN='${TOKEN}'`,
    `export ANTHROPIC_BASE_URL='${BASE_URL}'`,
    `export ANTHROPIC_MODEL='${MODEL}'`,
    `export ANTHROPIC_DEFAULT_SONNET_MODEL='${SONNET_MODEL}'`,
    // Bypass the root/sudo block on --dangerously-skip-permissions (setup.ts
    // gate). The USER_TYPE==='ant' sandbox/internet check does not apply.
    `export CLAUDE_CODE_BUBBLEWRAP='1'`,
    `export CLAUDE_CODE_MAX_RETRIES='3'`,
    `export CLAUDE_CODE_UNATTENDED_RETRY='0'`,
    // NOTE: do NOT set ANTHROPIC_API_KEY — it triggers the "Detected a custom
    // API key" confirmation dialog. The auth token via settings/env suffices.
    `exec '${BIN}' --dangerously-skip-permissions`,
  ]
  writeFileSync(wrapper, lines.join('\n') + '\n', { mode: 0o755 })
  return wrapper
}

describe.skipIf(
  !!process.env.CI || !TOKEN || !BASE_URL,
)('WorkflowSaveDialog: CLAUDE_CONFIG_DIR user-scope save (2.1.208 #25)', () => {
  test('shows CLAUDE_CONFIG_DIR path + saves the file there', async () => {
    const home = mkdtempSync(join(tmpdir(), 'occ-wf-save-home-'))
    const configDir = mkdtempSync(join(tmpdir(), 'occ-wf-save-cfg-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'occ-wf-save-proj-'))
    mkdirSync(join(projectDir, '.claude', 'workflows'), { recursive: true })
    writeFileSync(join(projectDir, '.claude', 'workflows', 'e2esave.js'), SCRIPT_SOURCE, 'utf8')
    seedDirs(home, configDir, projectDir)
    const wrapper = writeWrapper(home, configDir, projectDir)

    killRepl()
    execSync(
      `tmux new-session -d -s ${SESSION} -x 200 -y 50 -c ${projectDir} ${wrapper}`,
      { timeout: 5_000 },
    )

    try {
      // Wait for the bypass-permissions dialog OR the prompt.
      for (let i = 0; i < 45; i++) {
        const pane = capturePane()
        if (pane.toLowerCase().includes('yes, i accept')) {
          sendKey('Down')
          await new Promise(r => setTimeout(r, 300))
          sendKey('Enter')
        }
        if (await waitForText('shift+tab', 1_000)) break
      }
      expect(await waitForText('shift+tab', 10_000)).toBe(true)

      // Drive the model to run the workflow by name. Char-by-char avoids the
      // React state-batching burst-drop failure mode. The model is
      // non-deterministic, so retry the prompt once if the run doesn't appear.
      const promptText = 'Call the Workflow tool with input {"name":"e2esave"}. Run it now, no explanation.'
      let done = false
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        if (attempt > 0) {
          // Clear any prior partial input + retype.
          sendKey('Enter')
          await new Promise(r => setTimeout(r, 500))
        }
        await typeText(promptText)
        await new Promise(r => setTimeout(r, 300))
        sendKey('Enter')
        // The tool renders "● done" on success. Generous timeout for the model
        // turn + engine run.
        done = await waitForText('● done', 30_000)
      }
      if (!done) {
        console.error('PANE at workflow-done failure:\n' + capturePane())
      }
      expect(done).toBe(true)

      // Open the workflows browser; Down past the disabled header; Enter selects.
      await typeText('/workflows', 40)
      await new Promise(r => setTimeout(r, 300))
      sendKey('Enter')
      expect(await waitForText('background dynamic workflow', 10_000)).toBe(true)
      sendKey('Down')
      await new Promise(r => setTimeout(r, 300))
      sendKey('Enter')
      await new Promise(r => setTimeout(r, 800))

      // Detail view: press 's' to open the save dialog.
      sendKey('s')
      expect(await waitForText('Save dynamic workflow', 5_000)).toBe(true)

      // Default scope is project; Tab toggles to User scope.
      sendKey('Tab')
      await new Promise(r => setTimeout(r, 600))

      // ASSERT (c): the subtitle shows the CLAUDE_CONFIG_DIR temp path,
      // NOT a hardcoded ~/.claude/workflows/.
      const pane = capturePane()
      expect(pane).toContain('User scope')
      expect(pane).toContain(configDir)
      expect(pane).toContain('workflows/e2esave.js')
      expect(pane).not.toContain('~/.claude/workflows/')

      // Enter → save at user scope.
      sendKey('Enter')
      await new Promise(r => setTimeout(r, 800))

      // ASSERT (d): the file actually landed under CLAUDE_CONFIG_DIR/workflows.
      const savedPath = join(configDir, 'workflows', 'e2esave.js')
      expect(existsSync(savedPath)).toBe(true)
      expect(readFileSync(savedPath, 'utf8')).toBe(SCRIPT_SOURCE)
    } finally {
      killRepl()
      rmSync(home, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  }, 120_000)
})
