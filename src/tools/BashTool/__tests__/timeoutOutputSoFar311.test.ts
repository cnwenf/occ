import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { setIsInteractive } from '../../../bootstrap/state.js'
import { generateTaskId } from '../../../Task.js'
import {
  isTerminal,
  makeHarness,
  makeToolContext,
  waitFor,
} from '../../../tasks/LocalShellTask/__tests__/shellWiringHarness042.js'
import {
  computeBackgroundDeadlineMs,
  setBackgroundDeadlineDisabled,
} from '../../../tasks/LocalShellTask/backgroundDeadline.js'
import { formatDuration } from '../../../utils/format.js'
import { clearCommandQueue } from '../../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../../utils/task/diskOutput.js'
import { BashTool, readBackgroundOutputSoFar, type Out } from '../BashTool.js'

/**
 * CC 2.1.311 #56 (WP-Q): "shell command timeout: show output-so-far and that
 * it's still running."
 *
 * Byte evidence — official linux-x64 ELF binaries at /tmp/cc-diff-311/{v310,
 * v311}/package/claude (READ-ONLY, never executed; grep -aboF + dd):
 *
 * - Message builder `OLr` @ v311:251496383. Timeout branch composes, in order,
 *   join(' '): [Q base, notice, deadline line?, still-running line, no-output
 *   warning?, interim-output hint]. Manual (backgroundedByUser) branch =
 *   [Q base, deadline line?] only. Generic branch = [Q base, notice, hint]
 *   (NO deadline line — ve=false ⇒ Oe undefined).
 * - Still-running line: v310=0 → v311=2 occurrences @124557352 (string pool,
 *   ends "stop it with " + ${Yl}) and @251498022 (code copy).
 *   Verbatim: "It is running now: do not start a second copy while it runs.
 *   If it is no longer needed, stop it with TaskStop."  (Yl="TaskStop" @246947125)
 * - No-output warning: v310=0 → v311=2 @124557792 (pool) / @251498557 (code).
 *   Verbatim: "No output had been read from it when it was moved. A program
 *   that buffers its output, or a pipe into one such as tail, can keep the
 *   output file empty until the command finishes."
 * - Caller-side output re-read (NEW in v311) @253224774:
 *   `Ge={...Ge,stdout:await qFr(Ge.backgroundTaskId,S_e)}` when
 *   `backgroundTaskId!==undefined && timedOutAfterMs!==undefined &&
 *   innerCall!==true`. v310 has NO such re-read (its 2 timedOutAfterMs!==
 *   hits @251688271/@262900412 are analytics only).
 * - `qFr` @253153111 → `aVe` @245245798 (raw tail read, ≤ S_e=2000 bytes
 *   @246927100, UTF-8 continuation-byte skip, ENOENT ⇒ "") → `sLe` @248625671
 *   (cap zSt=12000 chars @248622655 via `bl` @238638620; omission header
 *   "[… earlier output omitted; full output: ${path}]"; v310=0 → v311=1 for
 *   "earlier output omitted; full output"). First line of the tail is dropped
 *   when omittedBytes>0 (it may be partial). Unreadable ⇒ warn log
 *   "LocalShellTask ${id}: output so far unreadable: …" + "" (v310=0 → v311=2).
 * - timedOutAfterMs schema description @253209733 — pre-existing 3× in BOTH
 *   v310 and v311 (OCC already byte-identical; asserted here as a lock).
 * - subagentCapApplied: only rendered when the async-subagent foreground cap
 *   applies (S param of OLr). OCC has no such cap ⇒ field must stay absent.
 */

// Verbatim official strings (byte-identical to v311 — see header evidence).
const STILL_RUNNING_LINE =
  'It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with TaskStop.'
const NO_OUTPUT_WARNING =
  'No output had been read from it when it was moved. A program that buffers its output, or a pipe into one such as tail, can keep the output file empty until the command finishes.'
const PLAIN_NOTICE = 'You will be notified when it completes.'
const GENERIC_INTERIM_HINT = 'To check interim output, use Read on that file path.'
const OMISSION_HEADER_PREFIX = '[… earlier output omitted; full output: '

type MappedResult = { content: string; is_error: boolean }

function mapResult(over: Partial<Out> = {}): MappedResult {
  const full = {
    stdout: '',
    stderr: '',
    interrupted: false,
    ...over,
  } as unknown as Out
  return (BashTool as {
    mapToolResultToToolResultBlockParam: (r: Out, id: string) => MappedResult
  }).mapToolResultToToolResultBlockParam(full, 'tu-test-56')
}

/** Official Oe line, computed from the live deadline subsystem (mirrors OLr). */
function deadlineLine(): string | undefined {
  const ms = computeBackgroundDeadlineMs()
  if (ms === undefined) {
    return undefined
  }
  return `If it is still running after ${formatDuration(ms, { hideTrailingZeros: true })} in the background, it will be stopped and you will be notified.`
}

function timeoutBase(taskId: string, seconds: number): string {
  return `Command did not complete within its ${seconds}s timeout and was moved to the background (ID: ${taskId}). Output is being written to: ${getTaskOutputPath(taskId)}.`
}

function manualBase(taskId: string): string {
  return `Command was manually backgrounded by user with ID: ${taskId}. Output is being written to: ${getTaskOutputPath(taskId)}.`
}

// Deterministic env: non-interactive (K=false ⇒ plain notice / generic hint)
// and background-deadline ENABLED (default cli state ⇒ deadline line present).
beforeEach(() => {
  setIsInteractive(false)
  setBackgroundDeadlineDisabled(false)
})

afterAll(() => {
  setIsInteractive(false)
  setBackgroundDeadlineDisabled(false)
  clearCommandQueue()
})

describe('2.1.311 #56 — timeout backgroundInfo mirrors official OLr', () => {
  test('composes the full official timeout message in order [Q, notice, deadline, still-running, warning, hint]', () => {
    // Arrange
    const dl = deadlineLine()
    expect(dl).toBeDefined() // guard: deadline enabled in test env
    // Act
    const { content } = mapResult({
      backgroundTaskId: 'bg56',
      timedOutAfterMs: 3000,
    })
    // Assert — exact composition, space-joined, official segment order.
    expect(content).toBe(
      [timeoutBase('bg56', 3), PLAIN_NOTICE, dl, STILL_RUNNING_LINE, NO_OUTPUT_WARNING, GENERIC_INTERIM_HINT]
        .filter(Boolean)
        .join(' '),
    )
  })

  test('emits the verbatim still-running TaskStop line (v310=0 → v311=2 @124557352/@251498022)', () => {
    const { content } = mapResult({ backgroundTaskId: 'bg56', timedOutAfterMs: 1500 })
    expect(content).toContain(STILL_RUNNING_LINE)
    expect(content).toContain('stop it with TaskStop.')
  })

  test('emits the verbatim no-output warning when nothing had been read (v310=0 → v311=2 @124557792/@251498557)', () => {
    const { content } = mapResult({ backgroundTaskId: 'bg56', timedOutAfterMs: 3000, stdout: '' })
    expect(content).toContain(NO_OUTPUT_WARNING)
  })

  test('inlines partial stdout ahead of the message and suppresses the no-output warning', () => {
    // Official mapper: noOutputSeenAtTimeout = G!==void 0 && !je (je = the
    // normalized-stdout emptiness check) — any stdout read so far ⇒ no warning.
    const { content } = mapResult({
      backgroundTaskId: 'bg56',
      timedOutAfterMs: 3000,
      stdout: 'wpq-partial-311\n',
    })
    expect(content.startsWith('wpq-partial-311')).toBe(true)
    expect(content).toContain(STILL_RUNNING_LINE)
    expect(content).not.toContain(NO_OUTPUT_WARNING)
  })

  test('omits the deadline line when the background deadline subsystem is disabled', () => {
    setBackgroundDeadlineDisabled(true)
    const { content } = mapResult({ backgroundTaskId: 'bg56', timedOutAfterMs: 3000 })
    expect(content).not.toContain('it will be stopped and you will be notified')
    // The rest of the composition is deadline-independent.
    expect(content).toContain(STILL_RUNNING_LINE)
    expect(content).toContain(NO_OUTPUT_WARNING)
  })

  test('manual branch gains ONLY the deadline line (official [Q, Oe] for r=true)', () => {
    // OLr: r=true ⇒ notice undefined, Ee undefined, warning excluded, De
    // undefined ⇒ manual = base + deadline line, nothing else.
    const dl = deadlineLine()
    const { content } = mapResult({ backgroundTaskId: 'bg56', backgroundedByUser: true })
    expect(content).toBe([manualBase('bg56'), dl].filter(Boolean).join(' '))
    expect(content).not.toContain(STILL_RUNNING_LINE)
    expect(content).not.toContain(PLAIN_NOTICE)
  })

  test('generic branch is unchanged — official has no deadline line when ve=false', () => {
    const { content } = mapResult({ backgroundTaskId: 'bg56' })
    expect(content).toBe(
      [
        `Command running in background with ID: bg56. Output is being written to: ${getTaskOutputPath('bg56')}.`,
        PLAIN_NOTICE,
        GENERIC_INTERIM_HINT,
      ].join(' '),
    )
    expect(content).not.toContain('it will be stopped and you will be notified')
    expect(content).not.toContain(STILL_RUNNING_LINE)
  })

  test('non-backgrounded results are untouched', () => {
    const { content } = mapResult({ stdout: 'plain output', timedOutAfterMs: 3000 })
    expect(content).not.toContain(STILL_RUNNING_LINE)
    expect(content).not.toContain(NO_OUTPUT_WARNING)
    expect(content).toContain('plain output')
  })
})

describe('2.1.311 #56 — outputSchema lock', () => {
  type SchemaEntry = { description?: string; isOptional(): boolean }
  const shape = (
    BashTool as unknown as { outputSchema: { shape: Record<string, SchemaEntry> } }
  ).outputSchema.shape

  test('timedOutAfterMs carries the official description verbatim (@253209733)', () => {
    expect(shape.timedOutAfterMs?.description).toBe(
      'Set when the command hit its timeout and was auto-backgrounded; the timeout value in ms',
    )
    expect(shape.timedOutAfterMs?.isOptional()).toBe(true)
  })

  test('subagentCapApplied stays absent — OCC has no async-subagent foreground cap', () => {
    expect(shape.subagentCapApplied).toBeUndefined()
  })
})

describe('2.1.311 #56 — readBackgroundOutputSoFar (qFr/aVe/sLe mirror)', () => {
  const taskIds: string[] = []

  function freshTaskId(): string {
    const taskId = generateTaskId('local_bash')
    taskIds.push(taskId)
    return taskId
  }

  afterEach(async () => {
    for (const taskId of taskIds.splice(0)) {
      await rm(getTaskOutputPath(taskId), { force: true })
    }
  })

  test('returns the trimmed file content for a small output file', async () => {
    // Arrange
    const taskId = freshTaskId()
    const path = getTaskOutputPath(taskId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'wpq-line-1\nwpq-line-2\n\n')
    // Act + Assert — trimEnd, leading-newline strip, no omission header.
    expect(await readBackgroundOutputSoFar(taskId)).toBe('wpq-line-1\nwpq-line-2')
  })

  test('returns empty string when the output file does not exist (aVe ENOENT branch)', async () => {
    expect(await readBackgroundOutputSoFar('local_bash_wpq_missing')).toBe('')
  })

  test('returns empty string for an empty output file', async () => {
    const taskId = freshTaskId()
    const path = getTaskOutputPath(taskId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')
    expect(await readBackgroundOutputSoFar(taskId)).toBe('')
  })

  test('past the 2000-byte cap: drops the partial first line and adds the omission header', async () => {
    // Arrange — 60 lines × 50 bytes = 3000 bytes; S_e=2000 ⇒ window starts at
    // byte 1000, exactly on a line boundary. qFr still drops the first line of
    // the window when omittedBytes>0 (it may be partial), then sLe adds the
    // "[… earlier output omitted; full output: <path>]" header.
    const taskId = freshTaskId()
    const path = getTaskOutputPath(taskId)
    await mkdir(dirname(path), { recursive: true })
    const lines = Array.from({ length: 60 }, (_, i) => `wpq-${String(i).padStart(2, '0')}-${'x'.repeat(43)}`)
    await writeFile(path, lines.map(line => `${line}\n`).join(''))
    // Act
    const result = await readBackgroundOutputSoFar(taskId)
    // Assert
    expect(result.startsWith(`${OMISSION_HEADER_PREFIX}${path}]`)).toBe(true)
    expect(result).toContain('wpq-21-')
    expect(result).toContain('wpq-59-')
    expect(result).not.toContain('wpq-20-') // first (boundary) line dropped
    expect(result).not.toContain('wpq-00-')
  })

  test('skips UTF-8 continuation bytes at the tail boundary (aVe byte-level skip)', async () => {
    // Arrange — 700 × '€' (3 bytes each) = 2100 bytes; window starts at byte
    // 100, which is a continuation byte (100 % 3 === 1). aVe skips forward to
    // the next character boundary instead of emitting U+FFFD garbage.
    const taskId = freshTaskId()
    const path = getTaskOutputPath(taskId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '€'.repeat(700))
    // Act
    const result = await readBackgroundOutputSoFar(taskId)
    // Assert
    expect(result).toContain(OMISSION_HEADER_PREFIX)
    expect(result).not.toContain('�')
    expect(result.endsWith('€')).toBe(true)
  })
})

describe('2.1.311 #56 — call() inlines output-so-far on timeout (v311 caller re-read)', () => {
  afterEach(() => {
    clearCommandQueue()
  })

  test(
    'timeout auto-background returns partial stdout instead of empty string',
    async () => {
      // Arrange — printf writes immediately, then the command outlives the
      // 1500ms tool timeout but self-terminates at ~4s (coreutils `timeout`)
      // so the background task reaches a terminal state and the deadline
      // timer clears before the test ends.
      const harness = makeHarness()
      const context = makeToolContext(harness)
      // Act
      const { data } = await (
        BashTool as unknown as {
          call: (input: unknown, ctx: unknown) => Promise<{ data: Record<string, unknown> }>
        }
      ).call({ command: "printf 'wpq-early-311\\n'; timeout 4 sleep 30", timeout: 1500 }, context)
      // Assert — the official v311 caller re-read replaces stdout:'' with the
      // output-so-far; timedOutAfterMs marks the auto-background.
      expect(typeof data.backgroundTaskId).toBe('string')
      expect(data.timedOutAfterMs).toBe(1500)
      expect(String(data.stdout)).toContain('wpq-early-311')
      // Drain: wait for the self-terminating background task to go terminal.
      const taskId = String(data.backgroundTaskId)
      await waitFor(
        () => isTerminal(harness.getState().tasks?.[taskId]),
        10_000,
        'background task terminal',
      )
    },
    20_000,
  )
})
