import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  setIsInteractive,
  setClientType,
} from '../../bootstrap/state.js'
import {
  BACKGROUND_DEADLINE_DEFAULT_MS,
  backgroundDeadlineCapMs,
  backgroundTimeoutUsageNote,
  computeBackgroundDeadlineMs,
  isBackgroundDeadlineCapable,
  isBackgroundDeadlineEnabled,
  isUnattendedSession,
  runInBackgroundDescription,
  setBackgroundDeadlineDisabled,
} from '../../tasks/LocalShellTask/backgroundDeadline.js'

/**
 * Official Claude Code 2.1.288 changelog #75: "Changed the background command
 * time limit to apply only in unattended sessions (-p, Agent SDK, CI, cloud);
 * terminal, desktop app and VS Code sessions have no limit."
 *
 * Binary evidence (v288 linux-x64 ELF, /tmp/cc-diff-288 — verified byte-level
 * this round; the official binary was NEVER executed, only strings/grep/dd):
 *
 * ```js
 * // v287 gate (@205351519):
 * function Cdn(){return!CC().backgroundDeadlineDisabled}
 * // v288 gate (@206424268) — the unattended predicate joins the capability:
 * function ufn(){return Fz()&&!XE().backgroundDeadlineDisabled}
 *
 * // Fz decoded (v288):
 * function ke(){return!n().host.launchOptions.isInteractive()}   // @199440774
 * var r=new Set(["claude-desktop","claude-desktop-3p","local-agent"]) // @199656365
 * function _(){let e=mv();return e!==void 0&&r.has(e)}           // @199657084
 * function mv(){return n().entrypoint}                           // @199659758
 * function Yu(){return _()&&!n().childSession}                   // @199660395
 * function gv(){let e=n();return e.entrypoint==="claude-vscode"
 *   &&!e.childSession&&!e.claudecode}                            // @199660844
 * function Fz(e=ke()){let t=Yu()&&!n().claudecode;
 *   return e&&!t&&!gv()}                                         // @199660938
 *
 * // v288 description/usage-note fns now consult the FULL gate ufn()
 * // (v287 Rdn() consulted Cdn() capability-only):
 * function pfn(){return ufn()?`Set to true to run this command in the
 *   background. With it, \`timeout\` limits ...`:"Set to true to run this
 *   command in the background."}                                 // @206424476
 * function ffn(){return ufn()?` With \`run_in_background\` the timeout is
 *   instead ...`:""}                                             // @206424744
 * ```
 *
 * i.e. deadline applies only when non-interactive AND NOT a desktop-app host
 * session AND NOT a VS Code session — exactly the changelog.
 *
 * OCC mapping (documented divergences live in backgroundDeadline.ts):
 * - `ke()` → `getIsNonInteractiveSession()` (src/bootstrap/state.ts:1083).
 * - `mv()`/entrypoint → `getClientType()` (src/bootstrap/state.ts:1107;
 *   main.tsx:864 derives it from CLAUDE_CODE_ENTRYPOINT — 'claude-desktop',
 *   'local-agent', 'claude-vscode', 'cli', 'sdk-*', 'github-action', 'remote').
 * - OCC has no `childSession` / `claudecode` host-context flags — those
 *   conjuncts drop (an OCC session is never a desktop-spawned child session).
 *
 * REGRESSION CONSTRAINT (勿回退): the OCC-102 #85 reap machinery must stay —
 * unattended sessions still arm the 30-minute default deadline.
 */

// Deterministic bash timeout env (floor/cap math reads process.env per call).
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.BASH_DEFAULT_TIMEOUT_MS = process.env.BASH_DEFAULT_TIMEOUT_MS
  savedEnv.BASH_MAX_TIMEOUT_MS = process.env.BASH_MAX_TIMEOUT_MS
  delete process.env.BASH_DEFAULT_TIMEOUT_MS
  delete process.env.BASH_MAX_TIMEOUT_MS
})

afterEach(() => {
  // Restore session-global singletons + env for other test files.
  setIsInteractive(false)
  setClientType('cli')
  setBackgroundDeadlineDisabled(false)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

/** Session-shape helper mirroring the official host-context combinations. */
function setSessionShape(interactive: boolean, clientType: string): void {
  setIsInteractive(interactive)
  setClientType(clientType)
}

describe('2.1.288 #75 — isUnattendedSession (official Fz)', () => {
  test('interactive terminal session is attended (deadline must NOT apply)', () => {
    setSessionShape(true, 'cli')
    expect(isUnattendedSession()).toBe(false)
  })

  test('non-interactive cli session (-p / CI) is unattended', () => {
    setSessionShape(false, 'cli')
    expect(isUnattendedSession()).toBe(true)
  })

  test.each([
    'claude-desktop',
    'claude-desktop-3p',
    'local-agent',
  ])('non-interactive desktop-host clientType %s is attended (Yu arm)', (clientType) => {
    setSessionShape(false, clientType)
    expect(isUnattendedSession()).toBe(false)
  })

  test('non-interactive claude-vscode session is attended (gv arm)', () => {
    setSessionShape(false, 'claude-vscode')
    expect(isUnattendedSession()).toBe(false)
  })

  test.each(['sdk-typescript', 'sdk-python', 'sdk-cli', 'github-action', 'remote'])(
    'non-interactive unattended clientType %s stays unattended',
    (clientType) => {
      setSessionShape(false, clientType)
      expect(isUnattendedSession()).toBe(true)
    },
  )
})

describe('2.1.288 #75 — deadline gate (official ufn = Fz && !backgroundDeadlineDisabled)', () => {
  test('interactive session: enabled=false and no deadline is armed (the live-bug fix)', () => {
    setSessionShape(true, 'cli')
    expect(isBackgroundDeadlineCapable()).toBe(true)
    expect(isBackgroundDeadlineEnabled()).toBe(false)
    expect(computeBackgroundDeadlineMs()).toBeUndefined()
    expect(computeBackgroundDeadlineMs(400)).toBeUndefined()
  })

  test('non-interactive cli: 30-minute default deadline still applies (OCC-102 勿回退)', () => {
    setSessionShape(false, 'cli')
    expect(isBackgroundDeadlineEnabled()).toBe(true)
    expect(computeBackgroundDeadlineMs()).toBe(BACKGROUND_DEADLINE_DEFAULT_MS)
  })

  test('non-interactive cli: requested timeout is honored and capped (calculator unchanged)', () => {
    setSessionShape(false, 'cli')
    expect(computeBackgroundDeadlineMs(60_000)).toBe(60_000)
    expect(computeBackgroundDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(backgroundDeadlineCapMs())
  })

  test('desktop/vscode host sessions arm no deadline even when non-interactive', () => {
    for (const clientType of ['claude-desktop', 'claude-desktop-3p', 'local-agent', 'claude-vscode']) {
      setSessionShape(false, clientType)
      expect(isBackgroundDeadlineEnabled()).toBe(false)
      expect(computeBackgroundDeadlineMs()).toBeUndefined()
    }
  })

  test('capability arm preserved: unattended + backgroundDeadlineDisabled → no deadline', () => {
    setSessionShape(false, 'cli')
    setBackgroundDeadlineDisabled(true)
    expect(isBackgroundDeadlineCapable()).toBe(false)
    expect(isBackgroundDeadlineEnabled()).toBe(false)
    expect(computeBackgroundDeadlineMs()).toBeUndefined()
  })
})

describe('2.1.288 #75 — schema description/usage note follow the full gate (official pfn/ffn → ufn)', () => {
  test('interactive session gets the short description (no lifetime semantics)', () => {
    setSessionShape(true, 'cli')
    expect(runInBackgroundDescription()).toBe(
      'Set to true to run this command in the background. Use Read to read the output later.',
    )
    expect(backgroundTimeoutUsageNote()).toBe('')
  })

  test('unattended session gets the official long description + usage note', () => {
    setSessionShape(false, 'cli')
    const description = runInBackgroundDescription()
    expect(description).toContain('`timeout` limits how long the command may run in the background')
    expect(description).toContain(`default ${BACKGROUND_DEADLINE_DEFAULT_MS} ms`)
    expect(description).toContain(`max ${backgroundDeadlineCapMs()} ms`)
    const note = backgroundTimeoutUsageNote()
    expect(note).toContain('With `run_in_background` the timeout is instead how long')
    expect(note).toContain(`max ${backgroundDeadlineCapMs()}ms / ${backgroundDeadlineCapMs() / 3600000} hours`)
  })

  test('non-interactive vscode/desktop sessions get the short description too', () => {
    setSessionShape(false, 'claude-vscode')
    expect(runInBackgroundDescription()).not.toContain('`timeout` limits')
    expect(backgroundTimeoutUsageNote()).toBe('')
  })
})
