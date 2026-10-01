import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { ChildProcess } from 'child_process'
import type { HooksSettings } from '../../settings/types.js'

/**
 * CC 2.1.285 real-child integration coverage for the execCommandHook
 * completion rework (review finding static-findings-tests:test-05):
 *
 *   1. completion keyed on the process 'exit' event + settleHookStreams quiet
 *      window (NOT stream 'end'/'close') — the 2.1.285 changelog fix for
 *      "hook hangs while a background daemon keeps the pipe open";
 *   2. the completion-payload spreads that POPULATE the new stdio flags:
 *        `...(code !== null && { exitedNormally: true })`
 *        `...(!(stdoutEnded && stderrEnded) && { stdioIncomplete: true })`
 *        `...(stdioClosedWithoutEnd && { stdioClosedWithoutEnd: true })`
 *      (hooks.ts ~2238-2240);
 *   3. the threading of `result.stdioIncomplete` / `result.stdioClosedWithoutEnd`
 *      from execCommandHook into `looksLikeMissingHookScript` at the
 *      executeHooks call site (hooks.ts ~3958) — the fail-closed refusal that
 *      keeps a blocking Stop/TeammateIdle/TaskCompleted hook from flipping to
 *      a "Hook script appears to be missing" non-blocking no-op when the
 *      capture may be partial.
 *
 * Everything here drives REAL child processes (spawned shell scripts) through
 * the REAL production chain (executeStopHooks / executeTeammateIdleHooks →
 * executeHooks → execCommandHook). No stream or flag population is mocked.
 *
 * Why the assertions are BEHAVIORAL: execCommandHook is module-private and its
 * stdio flags are consumed at exactly one production site — the
 * looksLikeMissingHookScript guard, which only runs for `status === 2`. The
 * externally observable difference between "flag populated" and "flag dropped"
 * is therefore: blocking error (fail-closed refusal fired) vs
 * hook_non_blocking_error "Hook script appears to be missing" (fail-open).
 * A daemon-held pipe + exit 2 + empty stdout + "can't open" stderr is the
 * minimal shape that distinguishes them.
 *
 * Empirically pinned flag outcomes on the Bun runtime (probe: real children,
 * execCommandHook's exact listener wiring):
 *   - daemon `(sleep N &)` holding both pipes, child exits 2:
 *       exit fires; NO 'end'/'close' before settle resolves →
 *       exitedNormally=true, stdioIncomplete=true, stdioClosedWithoutEnd unset.
 *   - plain child (no daemon), exit 2: 'end' then 'close' on both streams →
 *       exitedNormally=true, NO stdio flags (missing-script heuristic fires).
 *   - Bun ALWAYS emits 'end' before 'close' on pipe EOF (SIGKILLed writers,
 *       fd-closing children, group kills — all probed). Stream 'close'
 *       WITHOUT 'end' is only producible by a parent-side `destroy()` — the
 *     real-world Node mechanism (kill under backpressure, aborted pipelines)
 *       the official `Sr` flag defends against. Test 5 reproduces it by
 *       destroying the REAL stdout stream mid-settle (child + streams are
 *       real; only a reference is captured via a pass-through spawn spy).
 *       Note: close-without-end implies that stream never ended, so
 *       stdioIncomplete is ALWAYS set whenever stdioClosedWithoutEnd is —
 *       the official guard's `h===!0` branch is belt-and-braces and cannot be
 *       pinned in isolation behaviorally on this runtime.
 *
 * Mutation pins (verified — see the test-05 report):
 *   - Deleting the `stdioIncomplete` spread (hooks.ts:2239) flips tests 1/2
 *     from blocking to the fail-open missing-script no-op → they FAIL.
 *     (Test 5 survives: destroying stdout also sets stdioClosedWithoutEnd,
 *     which alone refuses the guard — flag co-occurrence, see above.)
 *   - Deleting the flag threading at the executeHooks call site
 *     (hooks.ts:3958-3959) fails tests 1/2/5 — every flag-observing test.
 *   - Deleting the `stdioClosedWithoutEnd` spread alone is unobservable (see
 *     co-occurrence note above) — reported, not a test gap we can close
 *     without violating the real-child rule.
 */

// --- Mock seams (OCC-97: Bun's mock.module leaks across test files in the
// same worker — spread the real module, override narrowly, restore below). ---

const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
let mockedHooksConfig: HooksSettings | null = null
mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

// Pass-through spawn spy: calls the REAL child_process.spawn (real children,
// real streams — nothing mocked about the processes) and only captures the
// returned ChildProcess so the close-without-end test can destroy the real
// stdout stream mid-settle. Restored in afterAll.
const actualChildProcess = await import('child_process')
// Snapshot the REAL exports by value BEFORE mock.module patches the live
// namespace bindings — calling `actualChildProcess.spawn` after mocking would
// recurse into the spy (Maximum call stack size exceeded), and restoring
// from the patched namespace in afterAll would leak the spy.
const pristineChildProcess = { ...actualChildProcess }
const realSpawn = pristineChildProcess.spawn
const capturedChildren: ChildProcess[] = []
const passthroughSpawn = ((...args: unknown[]) => {
  const child = (realSpawn as (...a: unknown[]) => ChildProcess)(...args)
  capturedChildren.push(child)
  return child
}) as typeof actualChildProcess.spawn
mock.module('child_process', () => ({
  ...pristineChildProcess,
  spawn: passthroughSpawn,
}))
mock.module('node:child_process', () => ({
  ...pristineChildProcess,
  spawn: passthroughSpawn,
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('child_process', () => ({ ...pristineChildProcess }))
  mock.module('node:child_process', () => ({ ...pristineChildProcess }))
})

const { executeStopHooks, executeTeammateIdleHooks } = await import(
  '../../hooks.js'
)
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')

// --- Real-child fixtures (inline shell commands — the hook config `command`
// is passed to /bin/sh -c verbatim, exactly like production). Unique
// fractional sleep durations double as pkill markers so no stray daemon can
// outlive the suite. ---

const DAEMON_NAP_1 = '6.301'
const DAEMON_NAP_2 = '6.302'
const DAEMON_NAP_3 = '6.303'
const DAEMON_NAP_5 = '6.305'

/** 2.1.285 changelog bug shape: hook exits while a daemon keeps the pipe. */
function daemonHoldMissingScriptCommand(nap: string): string {
  // `(sleep N &)` backgrounds a grandchild that inherits BOTH stdio pipes;
  // the hook then emits a shell "can't open" error on stderr and exits 2 —
  // the missing-script heuristic's trigger shape with an untrustworthy
  // (pipe-held) capture.
  return `(sleep ${nap} &); echo "bash: /gone/hook.sh: can't open" >&2; exit 2`
}

/** Changelog happy path: hook prints its JSON answer, then exits while a daemon holds the pipe. */
function daemonHoldJsonBlockCommand(nap: string): string {
  return `(sleep ${nap} &); echo '{"decision":"block","reason":"daemon-hold-285"}'`
}

/** Control: identical trigger shape, but NO daemon — both streams reach EOF ('end') before completion. */
const CLEAN_MISSING_SCRIPT_COMMAND =
  `echo "bash: /gone/hook.sh: can't open" >&2; exit 2`

function stopConfig(command: string): HooksSettings {
  return {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

function teammateIdleConfig(command: string): HooksSettings {
  return {
    TeammateIdle: [{ matcher: '', hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

beforeAll(() => {
  // Interactive-mode trust gate (shouldSkipHookDueToTrust) — session trust
  // latches true for the whole process.
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
  capturedChildren.length = 0
})

afterAll(() => {
  // Reap any fixture daemons so `bun test` exits cleanly. pkill exits 1 when
  // nothing matched — that is the success case, ignore the status.
  try {
    Bun.spawnSync(['pkill', '-f', 'sleep 6.30'])
  } catch {
    // best-effort cleanup only
  }
})

/** Drains an executeHooks-family generator, returning results + wall time. */
async function drain(
  gen: AsyncGenerator<{ message?: any; blockingError?: any; outcome?: string }>,
): Promise<{ results: any[]; elapsedMs: number }> {
  const results: any[] = []
  const startedAt = Date.now()
  for await (const item of gen) {
    results.push(item)
  }
  return { results, elapsedMs: Date.now() - startedAt }
}

function attachmentStderrs(results: any[]): string[] {
  return results
    .map(r => r.message?.attachment)
    .filter(a => a !== undefined && a !== null)
    .map(a => String(a.stderr ?? ''))
}

function missingScriptNoOpFired(results: any[]): boolean {
  return attachmentStderrs(results).some(s =>
    s.includes('Hook script appears to be missing'),
  )
}

function blockingErrors(results: any[]): string[] {
  return results
    .filter(r => r.blockingError !== undefined)
    .map(r => String(r.blockingError?.blockingError ?? ''))
}

// Completion budget: the settle quiet window is 500ms after 'exit', so the
// whole hook must resolve ~0.5-1s after spawn — assert well under the daemon
// nap (6.3s) and orders of magnitude under the 10-min hook timeout / 10s
// settle cap. Generous ceiling avoids CI flake while still failing hard on
// any "wait for the daemon" regression (v284 hang shape).
const COMPLETION_BUDGET_MS = 4_000

describe('2.1.285 execCommandHook stdio flags — real-child integration (test-05)', () => {
  test('Stop hook: daemon-held pipe completes on exit+settle and stays BLOCKING (stdioIncomplete populated + threaded, fail-closed)', async () => {
    // Arrange — the exact 2.1.285 changelog bug shape on a blocking event:
    // the hook exits 2 with a "can't open" stderr while a backgrounded
    // grandchild keeps BOTH pipes open, so neither 'end' nor 'close' fires
    // before completion. Populate requires stdioIncomplete=true at resolve;
    // threading requires the executeHooks call site to pass it into
    // looksLikeMissingHookScript, whose refusal keeps the exit-2 block.
    mockedHooksConfig = stopConfig(daemonHoldMissingScriptCommand(DAEMON_NAP_1))

    // Act
    const { results, elapsedMs } = await drain(executeStopHooks())

    // Assert — completed on 'exit' + quiet-window settle, NOT when the
    // daemon dies (6.3s) and not via the v284 wait-for-'end' hang.
    expect(elapsedMs).toBeLessThan(COMPLETION_BUDGET_MS)
    // Fail-closed: a REAL blocking error carries the hook stderr.
    const blocking = blockingErrors(results)
    expect(blocking.length).toBe(1)
    expect(blocking[0]).toContain("can't open")
    // The missing-script fail-open no-op must NOT fire — its refusal was
    // disarmed by the REAL stdioIncomplete flag from the REAL child.
    expect(missingScriptNoOpFired(results)).toBe(false)
  })

  test('TeammateIdle hook: daemon-held pipe keeps the event blocking (second entry point, reviewer mutation shape)', async () => {
    // Arrange — TeammateIdle is in MISSING_SCRIPT_HOOK_EVENTS; this is the
    // event the reviewer's mutation flipped from blocking to non-blocking
    // no-op when the stdioIncomplete population was deleted.
    mockedHooksConfig = teammateIdleConfig(
      daemonHoldMissingScriptCommand(DAEMON_NAP_2),
    )

    // Act
    const { results, elapsedMs } = await drain(
      executeTeammateIdleHooks('worker-285', 'team-285'),
    )

    // Assert
    expect(elapsedMs).toBeLessThan(COMPLETION_BUDGET_MS)
    expect(blockingErrors(results).length).toBe(1)
    expect(blockingErrors(results)[0]).toContain("can't open")
    expect(missingScriptNoOpFired(results)).toBe(false)
  })

  test('Stop hook: daemon-held JSON answer is fully captured and honored (exit-keyed completion, exitedNormally shape)', async () => {
    // Arrange — the changelog's user-visible bug: a hook that prints its
    // JSON result and exits 0 while a daemon (`some-daemon &`) holds the
    // pipe. Pre-285 this hung until the hook timeout; post-285 the hook
    // finishes shortly after its own process exits WITH its stdout captured
    // (the settle quiet window drains the already-written JSON).
    mockedHooksConfig = stopConfig(daemonHoldJsonBlockCommand(DAEMON_NAP_3))

    // Act
    const { results, elapsedMs } = await drain(executeStopHooks())

    // Assert — fast completion despite the pipe-holding daemon...
    expect(elapsedMs).toBeLessThan(COMPLETION_BUDGET_MS)
    // ...and the JSON decision survived the truncated stdio capture
    // (status 0 → exitedNormally=true, JSON parsed → blocking decision).
    const blocking = blockingErrors(results)
    expect(blocking.length).toBe(1)
    expect(blocking[0]).toBe('daemon-hold-285')
    expect(missingScriptNoOpFired(results)).toBe(false)
  })

  test('control: clean missing-script hook (streams reach end) still reports the non-blocking missing-script no-op', async () => {
    // Arrange — identical trigger shape (exit 2, empty stdout, "can't open"
    // stderr) but WITHOUT a daemon: both streams hit EOF, 'end' fires before
    // completion, so NO stdio flag is populated and the heuristic must fire.
    // This pins the negative direction end-to-end: the flags are not
    // over-populated on clean captures, and the observed blocking in the
    // daemon tests really comes from the flags (not from the heuristic being
    // dead/broken across the board).
    mockedHooksConfig = stopConfig(CLEAN_MISSING_SCRIPT_COMMAND)

    // Act
    const { results, elapsedMs } = await drain(executeStopHooks())

    // Assert
    expect(elapsedMs).toBeLessThan(COMPLETION_BUDGET_MS)
    expect(blockingErrors(results).length).toBe(0)
    expect(missingScriptNoOpFired(results)).toBe(true)
    expect(attachmentStderrs(results).join('\n')).toContain(
      'Treating as non-blocking',
    )
  })

  test('Stop hook: real stdout destroyed mid-settle (close without end) still fails closed (stdioClosedWithoutEnd path)', async () => {
    // Arrange — daemon-held pipe + exit 2 + "can't open" stderr again, but
    // the REAL parent-side stdout readable is destroyed after 'exit' and
    // before the settle window elapses. On Bun this is the ONLY way to make
    // a stream emit 'close' without 'end' (natural EOF always ends first —
    // probed with SIGKILL, fd-close, and group-kill shapes); it mirrors the
    // real-world Node condition the official `Sr`/stdioClosedWithoutEnd flag
    // exists for. The production once('close') handler (hooks.ts ~2118) sets
    // stdioClosedWithoutEnd on the REAL stream; the completion spread
    // (~2240) then carries it into the missing-script refusal. Nothing about
    // the flag population is mocked — only a reference to the real child is
    // captured via the pass-through spawn spy.
    mockedHooksConfig = stopConfig(daemonHoldMissingScriptCommand(DAEMON_NAP_5))
    const captureIndex = capturedChildren.length

    // Act — destroy the real stdout ~120ms after the child exits, inside the
    // 500ms settle quiet window (production resolves at ~500ms).
    const run = drain(executeStopHooks())
    const child = await waitForCapture(captureIndex, 3_000)
    await waitForExit(child, 3_000)
    await delay(120)
    child.stdout?.destroy()
    const { results, elapsedMs } = await run

    // Assert — completion still prompt; still fail-closed BLOCKING (with
    // both stdio flags populated — close-without-end implies the stream
    // never ended, so stdioIncomplete co-occurs by construction); never the
    // missing-script no-op.
    expect(elapsedMs).toBeLessThan(COMPLETION_BUDGET_MS)
    expect(blockingErrors(results).length).toBe(1)
    expect(blockingErrors(results)[0]).toContain("can't open")
    expect(missingScriptNoOpFired(results)).toBe(false)
  })
})

// --- small async helpers (no mocking, just event plumbing) ---

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Waits for the child to exit by POLLING exitCode/signalCode — a `once('exit')`
 * listener races: the fixture shell exits within milliseconds of spawn, often
 * before waitForCapture's poll returns, so the event can be missed entirely.
 */
async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the hook child process to exit')
    }
    await delay(2)
  }
}

/** Waits until the pass-through spy has captured the child spawned at/after `index`. */
async function waitForCapture(
  index: number,
  timeoutMs: number,
): Promise<ChildProcess> {
  const deadline = Date.now() + timeoutMs
  while (capturedChildren.length <= index) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the hook child process to spawn')
    }
    await delay(5)
  }
  return capturedChildren[index]!
}
