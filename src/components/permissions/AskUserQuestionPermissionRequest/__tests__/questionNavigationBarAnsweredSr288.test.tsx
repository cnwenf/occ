import * as React from 'react'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import figures from 'figures'
import { render, useApp } from '../../../../ink.js'
import {
  screenReader,
  isScreenReaderEnabled,
} from '../../../../utils/screenReader.js'
import type { Question } from '../../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { renderToStringIsolated } from '../../../CustomSelect/__tests__/renderIsolated280.js'
import { QuestionNavigationBar } from '../QuestionNavigationBar.js'

/**
 * v2.1.288 gap entry #67 — Screen reader: question dialogs now say "answered"
 * beside the checkbox for answered questions.
 *
 * Official v288 (binary @229288327): `var iXe="answered ";` (TRAILING SPACE).
 * Tab renderer (binary @~229289600):
 *   let bo=Qo?.key&&!!H[Qo.key];            // isAnswered
 *   let vo=bo?Z.checkboxOn:Z.checkboxOff;
 *   ...children:[vo," ",Pe&&bo?iXe:"",un]   // Pe=Ye() = isScreenReaderEnabled()
 * The label is a sibling text node between the checkbox and the display text,
 * gated on the component-scope SR flag. Official added `Pe` to BOTH memo dep
 * arrays (cache w(38)→w(41)); OCC mirrors with `srEnabled` in both memo blocks
 * (_c(39)→_c(41)).
 *
 * SR-ON cases assert on the SR flat-render serialization (what a screen reader
 * consumes); SR-OFF asserts the visible-mode layout is unchanged.
 */

// ── helpers ──────────────────────────────────────────────────────────────

function setSR(on: boolean): void {
  if (on) process.env.CLAUDE_AX_SCREEN_READER = '1'
  else delete process.env.CLAUDE_AX_SCREEN_READER
  screenReader.reset()
}

/**
 * Hold the instance open before exiting — the SR flat-render frame flushes on
 * a later tick than the normal screen-buffer blit (same finding as the
 * searchBoxScreenReader287 harness).
 *
 * `shouldExit` (optional) makes the hold CONDITION-based: exit as soon as the
 * predicate sees the expected frame in the accumulated stdout, with `ms` as a
 * hard deadline. Fixed-margin holds flaked under full-gauntlet parallel load
 * (re-render frame flush exceeded the margin); polling the actual output is
 * load-independent and still fails honestly at the deadline when the memo
 * cache is genuinely stale.
 */
function Hold({ ms, shouldExit }: { ms: number; shouldExit?: () => boolean }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const deadline = setTimeout(exit, ms)
    let poll: ReturnType<typeof setInterval> | undefined
    if (shouldExit) {
      poll = setInterval(() => {
        if (shouldExit()) {
          if (poll) clearInterval(poll)
          // grace tick so the rest of the frame's writes land before exit
          setTimeout(exit, 15)
        }
      }, 10)
    }
    return () => {
      clearTimeout(deadline)
      if (poll) clearInterval(poll)
    }
  }, [exit, ms, shouldExit])
  return null
}

/** Render under SR (or not) and return the STRIPPED flat output. */
async function renderSrStripped(
  node: React.ReactNode,
  holdMs = 30,
  exitWhen?: (output: string) => boolean,
): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  // Fake TTY stdin (same shape as renderIsolated280): isTTY=true satisfies
  // App.isRawModeSupported(); no-op setRawMode/ref/unref for the enable path.
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream
  // Strip ANSI before matching so the predicate sees the same text the
  // assertion will (the raw stream carries color escapes around the label).
  const shouldExit = exitWhen
    ? () => exitWhen(stripAnsi(output))
    : undefined
  const instance = await render(
    <>
      {node}
      <Hold ms={holdMs} shouldExit={shouldExit} />
    </>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
  )
  await instance.waitUntilExit()
  return stripAnsi(output)
}

/**
 * Re-render driver: mounts with `answers={}`, then swaps in the answered map
 * after `changeMs`. Guards the memo-cache slot renumbering — a stale-cache bug
 * shows as the "answered " label NOT appearing after the answers prop changes.
 */
function AnswersChangeDriver({
  questions,
  newAnswers,
  changeMs,
}: {
  questions: Question[]
  newAnswers: Record<string, string>
  changeMs: number
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    const timer = setTimeout(() => setAnswers(newAnswers), changeMs)
    return () => clearTimeout(timer)
  }, [newAnswers, changeMs])
  return (
    <QuestionNavigationBar
      questions={questions}
      currentQuestionIndex={0}
      answers={answers}
    />
  )
}

// ── fixtures ─────────────────────────────────────────────────────────────

const q1: Question = {
  question: 'Which auth method should we use?',
  header: 'Auth',
  options: [
    { label: 'OAuth', description: 'Token-based OAuth flow.' },
    { label: 'API key', description: 'Static API key.' },
  ],
  multiSelect: false,
}

const q2: Question = {
  question: 'Which library should we use for date formatting?',
  header: 'Lib',
  options: [
    { label: 'date-fns', description: 'Lightweight.' },
    { label: 'dayjs', description: 'Moment-like.' },
  ],
  multiSelect: false,
}

const TWO_QUESTIONS = [q1, q2]

// Official label — verbatim `iXe="answered ";` with trailing space. Adjacency
// assertions bake the trailing space in: "answered" + " " + displayText.
const ANSWERED_ON = `${figures.checkboxOn} answered Auth`
const ANSWERED_ON_2 = `${figures.checkboxOn} answered Lib`

describe('v2.1.288 #67: QuestionNavigationBar SR "answered" label', () => {
  beforeEach(() => setSR(false))
  afterEach(() => setSR(false))

  test('SR ON + answered question → label sits between checkbox and display text', async () => {
    // Arrange
    setSR(true)
    expect(isScreenReaderEnabled()).toBe(true)

    // Act — selected tab (index 0), answered.
    const out = await renderSrStripped(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth' }}
      />,
    )

    // Assert — checkboxOn, then "answered " (trailing space preserved by the
    // adjacent display text), then the tab text.
    expect(out).toContain(ANSWERED_ON)
  })

  test('SR ON + unanswered question → no "answered" in its tab', async () => {
    // Arrange — q1 answered, q2 NOT answered.
    setSR(true)

    // Act
    const out = await renderSrStripped(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth' }}
      />,
    )

    // Assert — exactly one label (the answered tab); the unanswered tab keeps
    // the bare checkboxOff + display text.
    expect(out).toContain(ANSWERED_ON)
    expect(out).not.toContain(`answered Lib`)
    expect(out.match(/answered/g)?.length ?? 0).toBe(1)
  })

  test('SR OFF + answered question → no "answered" anywhere (visible layout unchanged)', async () => {
    // Arrange
    setSR(false)
    expect(isScreenReaderEnabled()).toBe(false)

    // Act — normal (non-SR) frame via the shared isolated harness.
    const out = await renderToStringIsolated(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth', [q2.question]: 'date-fns' }}
      />,
    )

    // Assert
    expect(out).not.toContain('answered')
    expect(out).toContain(figures.checkboxOn)
    expect(out).toContain('Auth')
    expect(out).toContain('Lib')
  })

  test('SR ON → both the selected tab and an unselected answered tab show the label', async () => {
    // Arrange — ≥2 questions, currentQuestionIndex=0, question 2 answered too.
    setSR(true)

    // Act
    const out = await renderSrStripped(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth', [q2.question]: 'date-fns' }}
      />,
    )

    // Assert — selected (backgroundColor="permission") branch AND unselected
    // branch both carry the label.
    expect(out).toContain(ANSWERED_ON)
    expect(out).toContain(ANSWERED_ON_2)
  })

  test('memo-cache sanity: label appears after the answers prop changes on a live instance', async () => {
    // Arrange — first render has NO answers; at +20ms the answers prop changes.
    // If the memo slot renumbering is broken (stale $[k] pairing), the t4/t5
    // memos return the cached children and the label never appears.
    setSR(true)
    const newAnswers = { [q1.question]: 'OAuth' }

    // Act — condition-based hold: exit as soon as the answered frame appears,
    // 3s hard deadline (fixed 120ms margin flaked under gauntlet load).
    const out = await renderSrStripped(
      <AnswersChangeDriver
        questions={TWO_QUESTIONS}
        newAnswers={newAnswers}
        changeMs={20}
      />,
      3000,
      o => o.includes(ANSWERED_ON),
    )

    // Assert
    expect(out).toContain(ANSWERED_ON)
  })
})
