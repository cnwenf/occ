import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Out } from '../BashTool.js'

// Snapshot the REAL namespace into a plain object BEFORE registering the
// mock: bun's mock.module live-patches already-imported namespace objects,
// so a delegating closure over `import * as ns` would recurse into the mock
// itself (sandboxLocalBinding281 lesson).
const actualStateModule = await import('../../../bootstrap/state.js')
const actualStateExports = { ...actualStateModule }
const realGetIsNonInteractiveSession =
  actualStateExports.getIsNonInteractiveSession as () => boolean

/**
 * CC 2.1.300 #41 — "Fixed Claude polling a background command's output file
 * or sleeping while it runs."
 *
 * Byte evidence (official linux-x64 ELFs at /tmp/cc-diff-300/{v299,v300}):
 *
 * 1. Result-message builder v300 `qpr` @228322900 (v299 `_dr` @227098700 has
 *    NO K-gate — both dd-verified):
 *      K=!r&&!s&&!h&&y===void 0&&!S&&Vbr()
 *      V=S?"If it exits while you are still working…":r?void 0
 *        :K?"You will be notified when it completes — do not poll that file
 *           or sleep while waiting."           (@228323540, v299: 0 hits)
 *         :"You will be notified when it completes."
 *      be=r?void 0
 *        :K?`${w} the file only if the user asks for progress, or if you need
 *            a line it prints before you can go on, such as a server's ready
 *            line or port.`                    (@228323847 region, v299: 0)
 *         :`To check interim output, use ${w} on that file path.`
 *      return [H,V,Se,be].filter(Boolean).join(" ")
 *    with H (generic) = "Command running in background with ID: ${e}.
 *    Output is being written to: ${n}." (trailing period) and H (manual) =
 *    "Command was manually backgrounded by user with ID: ${e}. Output is
 *    being written to: ${n}." (trailing period). r=backgroundedByUser,
 *    s=backgroundedToDeliverMessage, h=backgroundedByTurnAbort,
 *    y=timedOutAfterMs, S=reapedAtFinalResponse, w=readToolName ("Read").
 *    s/h/S have no OCC counterpart (separate subsystems; existed unchanged
 *    in v299 — not part of the 299→300 diff) and stay staged.
 *
 * 2. Tool-description builder v300 @225820817 (dd-verified; v299 @224632474
 *    lacks the sentence — "You will be notified when it exits" 299:0, 300:1):
 *      if(Vbr())be+=" You will be notified when it exits — do not poll its
 *      output file while waiting.";
 *    appended to the run_in_background bullet.
 *
 * 3. Gate v300 @223329653: `function Vbr(){return pse()&&!pW()}` with
 *    `function pse(){return!wh().backgroundCompletionNoticeDisabled}`
 *    @223329591 (host-runtime capability — OCC has no host runtime
 *    registration → arm constant-true) and `pW(e=we())` @216270987:
 *    `e&&!t&&!jy()`, t=Pp()&&!claudecode (desktop-family host entrypoints,
 *    S() @216266464), jy()=claude-vscode entrypoint @216270893 — neither
 *    exists in OCC, so pW collapses to we(). we() is unresolvable from
 *    strings alone; the observable contract (notifications only exist when
 *    a later turn can receive them — cf. the official reapedAtFinalResponse
 *    text "…no notification can follow that…" and the #41 changelog
 *    targeting interactive CLI sessions) is mirrored in OCC via
 *    !getIsNonInteractiveSession(). See backgroundCompletionNoticeEnabled()
 *    in ../prompt.ts for the full derivation.
 *
 * 'do not poll' raw byte occurrences: v299=9 → v300=11 (+2 = the two
 * sentences above).
 */

let mocksActive = false
let nonInteractiveSession = true

mock.module('../../../bootstrap/state.js', () => ({
  ...actualStateExports,
  getIsNonInteractiveSession: () =>
    mocksActive ? nonInteractiveSession : realGetIsNonInteractiveSession(),
}))

afterAll(() => {
  mocksActive = false
  mock.module('../../../bootstrap/state.js', () => ({
    ...actualStateExports,
  }))
})

const { BashTool } = await import('../BashTool.js')
const { getSimplePrompt, backgroundCompletionNoticeEnabled } = await import(
  '../prompt.js'
)
const { getTaskOutputPath } = await import('../../../utils/task/diskOutput.js')

const ANTI_POLL_RESULT_SENTENCE =
  'You will be notified when it completes — do not poll that file or sleep while waiting.'
const RESTRICTIVE_READ_HINT =
  "Read the file only if the user asks for progress, or if you need a line it prints before you can go on, such as a server's ready line or port."
const PLAIN_NOTICE_SENTENCE = 'You will be notified when it completes.'
const GENERIC_INTERIM_HINT = 'To check interim output, use Read on that file path.'
const ANTI_POLL_DESCRIPTION_SENTENCE =
  'You will be notified when it exits — do not poll its output file while waiting.'

type MappedResult = { content: string; is_error: boolean }

function mapResult(over: Partial<Out> = {}): MappedResult {
  const full = {
    stdout: '',
    stderr: '',
    interrupted: false,
    ...over,
  } as unknown as Out
  return (
    BashTool as unknown as {
      mapToolResultToToolResultBlockParam: (
        r: Out,
        id: string,
      ) => MappedResult
    }
  ).mapToolResultToToolResultBlockParam(full, 'tu-test-41')
}

beforeEach(() => {
  mocksActive = true
  nonInteractiveSession = false
  delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
})

describe('CC 2.1.300 #41 — backgroundCompletionNoticeEnabled (official Vbr mirror)', () => {
  test('is true for interactive sessions (notification can be delivered)', () => {
    nonInteractiveSession = false
    expect(backgroundCompletionNoticeEnabled()).toBe(true)
  })

  test('is false for non-interactive sessions (no later turn to receive it)', () => {
    nonInteractiveSession = true
    expect(backgroundCompletionNoticeEnabled()).toBe(false)
  })
})

describe('CC 2.1.300 #41 — generic background result variant (official qpr K-branch)', () => {
  test('gate ON: full official byte-verified generic message', () => {
    // Arrange — interactive session (Vbr-mirror true), plain background run.
    nonInteractiveSession = false
    const outputPath = getTaskOutputPath('bg41')
    // Act
    const result = mapResult({ backgroundTaskId: 'bg41' })
    // Assert — [H, V(K), be(K)].join(" "), byte-verified v300 @228322900.
    expect(result.content).toBe(
      `Command running in background with ID: bg41. Output is being written to: ${outputPath}. ${ANTI_POLL_RESULT_SENTENCE} ${RESTRICTIVE_READ_HINT}`,
    )
  })

  test('gate OFF: plain notice + generic interim-output hint (v299 shape)', () => {
    // Arrange — non-interactive session (Vbr-mirror false).
    nonInteractiveSession = true
    const outputPath = getTaskOutputPath('bg41')
    // Act
    const result = mapResult({ backgroundTaskId: 'bg41' })
    // Assert
    expect(result.content).toBe(
      `Command running in background with ID: bg41. Output is being written to: ${outputPath}. ${PLAIN_NOTICE_SENTENCE} ${GENERIC_INTERIM_HINT}`,
    )
    expect(result.content).not.toContain('do not poll')
  })
})

describe('CC 2.1.300 #41 — variants the official K-gate EXCLUDES (no blanket-add)', () => {
  test('backgroundedByUser (official r): no notice clause at all, trailing period on H', () => {
    // Official v300: V=r?void 0:… and be=r?void 0:… — the manual variant
    // gets NEITHER the anti-poll sentence NOR any notice/interim clause.
    nonInteractiveSession = false
    const outputPath = getTaskOutputPath('bgU')
    const result = mapResult({
      backgroundTaskId: 'bgU',
      backgroundedByUser: true,
    })
    expect(result.content).toBe(
      `Command was manually backgrounded by user with ID: bgU. Output is being written to: ${outputPath}.`,
    )
    expect(result.content).not.toContain('do not poll')
    expect(result.content).not.toContain('will be notified')
  })

  test('timedOutAfterMs (official y!==void 0 → K false): no anti-poll clause even with gate ON', () => {
    nonInteractiveSession = false
    const result = mapResult({
      backgroundTaskId: 'bgT',
      timedOutAfterMs: 3000,
    })
    expect(result.content).toContain('3s timeout')
    expect(result.content).toContain(PLAIN_NOTICE_SENTENCE)
    expect(result.content).toContain(GENERIC_INTERIM_HINT)
    expect(result.content).not.toContain('do not poll')
    expect(result.content).not.toContain(RESTRICTIVE_READ_HINT)
  })

  test('assistantAutoBackgrounded (OCC-specific variant — no official counterpart): unchanged, no anti-poll clause', () => {
    // "assistant-mode blocking budget" has 0 hits in the official v300 ELF —
    // this variant is OCC-specific, so the official K-gate has nothing to
    // mirror onto it. It must not gain the clause (no blanket-add).
    nonInteractiveSession = false
    const result = mapResult({
      backgroundTaskId: 'bgA',
      assistantAutoBackgrounded: true,
    })
    expect(result.content).toContain('assistant-mode blocking budget')
    expect(result.content).not.toContain('do not poll')
  })
})

describe('CC 2.1.300 #41 — tool description run_in_background bullet (official if(Vbr()) append)', () => {
  test('gate ON: description contains the anti-poll sentence', () => {
    nonInteractiveSession = false
    const prompt = getSimplePrompt()
    expect(prompt).toContain(ANTI_POLL_DESCRIPTION_SENTENCE)
  })

  test('gate OFF: description omits the anti-poll sentence', () => {
    nonInteractiveSession = true
    const prompt = getSimplePrompt()
    expect(prompt).not.toContain(ANTI_POLL_DESCRIPTION_SENTENCE)
    expect(prompt).not.toContain('do not poll its output file')
  })
})
