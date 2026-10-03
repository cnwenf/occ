import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.287 (OCC-105 cluster D2 #2): "Fixed hooks configured with asyncRewake
 * waking Claude over and over with 'found issues' notifications when the hook's
 * script file is missing; the broken hook is now reported once."
 *
 * Official v287 `QLe` (asyncRewake exit-2 handler), recovered verbatim in
 * docs/gap-research-287/cluster-d2-misc.md #2:
 *
 *   let Ae=Se.code===2?await Bit({stdout:Ee,stderr:Ce,scriptPaths:G??[]}):void 0;
 *   if(Hit(Uit.of(U().host),`${h}\n${S}`,Ae?.output)){t(`Hooks: asyncRewake
 *     hook "${h}" (${S}) exited 2 again because ${Ae?.scriptPath} cannot be
 *     opened; already reported, not waking the model`,{level:"warn"});return}
 *   if(Se.code===2){let Pe,Fe,Ne;if(Ae!==void 0)Pe=`${h} hook could not run:
 *     ${Ae.scriptPath} cannot be opened, so its command exited with code 2
 *     without doing any work. This is a broken hook installation, not feedback
 *     on your work; it is reported this once and identical repeats are dropped.
 *     Interpreter output:`,Fe=`${g} hook could not open ${uWt(Ae.scriptPath)}`,
 *     Ne=Ae.output;else Pe=H??`Stop hook blocking error from command "${h}":`,
 *     Fe=xe??j??"Stop hook feedback",Ne=Ce||Ee;FMt({summary:Fe,body:`${Pe} ${Ne}`,
 *     priority:"next",stopHookActive:!0,turnAttribution:"inherit"})}
 *
 * `Bit` (missing-script detector) and `uWt` (path redaction) bodies were NOT
 * recovered — see the PARTIAL notes in hooks.ts. The message STRINGS above are
 * byte-exact and are what these tests pin.
 */

// --- Leak-free debug.js shim (repo convention: attachBridgePolicyWatcher286 /
// updateNullLookup277). Capture the real namespace BY VALUE before mocking;
// gate on mockActive so every other test in the shared bun worker passes
// through to the real logger; restore in afterAll (mock.restore() does NOT undo
// mock.module). ---
const actualDebug = { ...(await import('../../debug.js')) }
const actualLogForDebugging = actualDebug.logForDebugging
let mockActive = false
const debugLines: Array<{ line: string; opts?: unknown }> = []
mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (line: string, opts?: unknown) => {
    if (!mockActive) {
      actualLogForDebugging(line, opts as never)
      return
    }
    debugLines.push({ line, opts })
  },
}))

const {
  detectMissingHookScript,
  handleAsyncRewakeExit2,
  _resetReportedMissingHookScriptsForTesting,
} = await import('../../hooks.js')
const {
  resetCommandQueue,
  getCommandQueueSnapshot,
} = await import('../../messageQueueManager.js')
const { wrapInSystemReminder } = await import('../../messages.js')

afterAll(() => {
  // Restore the real debug namespace so the shim cannot leak into other files
  // sharing this test worker.
  mock.module('../../debug.js', () => ({ ...actualDebug }))
})

// --- Fixtures (real interpreter shape) ---
const PY_SCRIPT_PATH = '/home/user/.claude/hooks/check.py'
const PY_STDERR = `python3: can't open file '${PY_SCRIPT_PATH}': [Errno 2] No such file or directory`
const PY_COMMAND = `python3 ${PY_SCRIPT_PATH}`
const HOOK_NAME = 'Stop'

// Official v287 `QLe` strings — byte-exact from the report (h=HOOK_NAME,
// Ae.scriptPath=PY_SCRIPT_PATH, Ne=Ae.output=PY_STDERR, body=`${Pe} ${Ne}`).
const EXPECTED_MISSING_BODY = `${HOOK_NAME} hook could not run: ${PY_SCRIPT_PATH} cannot be opened, so its command exited with code 2 without doing any work. This is a broken hook installation, not feedback on your work; it is reported this once and identical repeats are dropped. Interpreter output: ${PY_STDERR}`
const EXPECTED_REPEAT_WARN = `Hooks: asyncRewake hook "${HOOK_NAME}" (${PY_COMMAND}) exited 2 again because ${PY_SCRIPT_PATH} cannot be opened; already reported, not waking the model`

beforeEach(() => {
  mockActive = true
  debugLines.length = 0
  resetCommandQueue()
  _resetReportedMissingHookScriptsForTesting()
})

afterEach(() => {
  mockActive = false
  resetCommandQueue()
})

describe('detectMissingHookScript (official v287 `Bit` port — PARTIAL)', () => {
  test("detects a python3 \"can't open file\" stderr and returns {scriptPath, output}", () => {
    const result = detectMissingHookScript({ stdout: '', stderr: PY_STDERR })
    expect(result).toBeDefined()
    expect(result!.scriptPath).toBe(PY_SCRIPT_PATH)
    // output mirrors the official else-branch convention (stderr || stdout)
    expect(result!.output).toBe(PY_STDERR)
  })

  test('prefers a caller-supplied scriptPaths entry referenced by the error', () => {
    const result = detectMissingHookScript({
      stdout: '',
      stderr: PY_STDERR,
      scriptPaths: ['/elsewhere/other.py', PY_SCRIPT_PATH],
    })
    expect(result!.scriptPath).toBe(PY_SCRIPT_PATH)
  })

  test('returns undefined for genuine blocking feedback (no missing-script signature)', () => {
    expect(
      detectMissingHookScript({
        stdout: '',
        stderr: 'ERROR: 3 assertions failed',
      }),
    ).toBeUndefined()
  })

  test('returns undefined when the signature is present but no path is extractable (fail-safe to generic wake)', () => {
    expect(
      detectMissingHookScript({ stdout: '', stderr: "can't open the thing" }),
    ).toBeUndefined()
  })
})

describe('handleAsyncRewakeExit2 (official v287 `QLe` port)', () => {
  test('missing script, first call → rewake enqueued with the official body + priority next', () => {
    handleAsyncRewakeExit2({
      hookName: HOOK_NAME,
      command: PY_COMMAND,
      stdout: '',
      stderr: PY_STDERR,
    })

    const snap = getCommandQueueSnapshot()
    expect(snap).toHaveLength(1)
    const queued = snap[0]!
    expect(queued.mode).toBe('task-notification')
    // official FMt priority:"next" (the field exists on OCC's QueuedCommand)
    expect(queued.priority).toBe('next')
    // byte-exact official body, wrapped in OCC's system reminder
    expect(queued.value).toBe(wrapInSystemReminder(EXPECTED_MISSING_BODY))
  })

  test('missing script, second identical call → NOT enqueued again, warn logged', () => {
    const args = {
      hookName: HOOK_NAME,
      command: PY_COMMAND,
      stdout: '',
      stderr: PY_STDERR,
    }

    handleAsyncRewakeExit2(args)
    expect(getCommandQueueSnapshot()).toHaveLength(1)

    // Identical repeat: deduped — queue unchanged, model NOT woken again.
    handleAsyncRewakeExit2(args)
    expect(getCommandQueueSnapshot()).toHaveLength(1)

    const warn = debugLines.find(d =>
      d.line.includes('already reported, not waking the model'),
    )
    expect(warn).toBeDefined()
    expect(warn!.line).toBe(EXPECTED_REPEAT_WARN)
    expect(warn!.opts).toEqual({ level: 'warn' })
  })

  test('dedup key is hookName\\ncommand — a different command reports separately', () => {
    handleAsyncRewakeExit2({
      hookName: HOOK_NAME,
      command: PY_COMMAND,
      stdout: '',
      stderr: PY_STDERR,
    })
    handleAsyncRewakeExit2({
      hookName: HOOK_NAME,
      command: 'python3 /other/hook.py',
      stdout: '',
      stderr:
        "python3: can't open file '/other/hook.py': [Errno 2] No such file or directory",
    })
    // Distinct dedup keys → both reported.
    expect(getCommandQueueSnapshot()).toHaveLength(2)
  })

  test('generic exit-2 (no missing-script signature) → existing behavior unchanged', () => {
    const stderr = 'ERROR: tests failed — 3 assertions broke'
    handleAsyncRewakeExit2({
      hookName: HOOK_NAME,
      command: 'npm test',
      stdout: '',
      stderr,
    })

    const snap = getCommandQueueSnapshot()
    expect(snap).toHaveLength(1)
    const queued = snap[0]!
    expect(queued.mode).toBe('task-notification')
    // Existing default priority (NOT the missing-script 'next').
    expect(queued.priority).toBe('later')
    // Byte-identical to the pre-287 OCC wake (== official else-branch body).
    expect(queued.value).toBe(
      wrapInSystemReminder(
        `Stop hook blocking error from command "${HOOK_NAME}": ${stderr}`,
      ),
    )
  })

  test('generic exit-2 is NOT deduped — repeats keep waking (existing behavior)', () => {
    const args = {
      hookName: HOOK_NAME,
      command: 'npm test',
      stdout: '',
      stderr: 'still failing',
    }
    handleAsyncRewakeExit2(args)
    handleAsyncRewakeExit2(args)
    expect(getCommandQueueSnapshot()).toHaveLength(2)
  })
})
