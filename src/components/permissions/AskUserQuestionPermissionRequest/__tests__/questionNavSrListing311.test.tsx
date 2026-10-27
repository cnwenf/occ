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
 * v2.1.311 PORT #64 — Screen-reader listing of questions.
 *
 * Byte-forensics on the official linux-x64 ELFs (/tmp/cc-diff-311):
 *
 * - `(answered)` — v311 ×2 @129034225 (string table) + @275628958 (code);
 *   v310 ×0.
 * - `==1?"Question":"Questions"` — v311 ×1 @275629041; v310 ×0.
 * - Official `Sk` (QuestionNavigationBar) @275627750, SR branch:
 *     mn=(Pn,ho)=>{
 *       let qo=Pn?.displayHeader||`Q${ho+1}`;
 *       let un=qo.includes(",")||/answered/i.test(qo)?_(qo):qo;   // _ = JSON.stringify
 *       return hp(H,Pn?.key)?`${un} (answered)`:un                  // hp = hasOwn lookup
 *     }
 *     vn=x.map(mn); An=x.length===1?"Question":"Questions";
 *     wt=vn.join(", "); mn=`${dt}: ${wt}`;                          // dt = header word
 *     Zo=e(Uo,{children:mn});            // Text
 *     Jo=e(Vo,{marginBottom:Qo=1,children:Zo});  // Box marginBottom:1
 *     return Jo;                         // EARLY RETURN — replaces the tab bar
 *   v311's non-SR tab renderer `Qo` no longer contains v310's inline
 *   `"answered "` prefix (removed) — the answered state moved entirely into
 *   the SR listing.
 *
 * OCC mapping: displayHeader→header, key→question, answers keyed by question
 * text, `_`→jsonStringify. The answered test is `hp(H,key)?…:…` where
 * `hp(h,x){return x!==void 0&&Object.hasOwn(h,x)?h[x]:void 0}` (@275627560)
 * returns the ANSWER VALUE and the ternary truthiness-tests it — so an
 * empty-string answer is falsy → NOT "(answered)". OCC mirrors hp exactly
 * (hasOwn guard avoids prototype-key false positives) then truthiness-tests.
 */

// ── helpers (same harness conventions as questionNavigationBarAnsweredSr288) ──

function setSR(on: boolean): void {
  if (on) process.env.CLAUDE_AX_SCREEN_READER = '1'
  else delete process.env.CLAUDE_AX_SCREEN_READER
  screenReader.reset()
}

/** Condition-based hold — exit as soon as the predicate sees the frame. */
function Hold({ ms, shouldExit }: { ms: number; shouldExit?: () => boolean }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const deadline = setTimeout(exit, ms)
    let poll: ReturnType<typeof setInterval> | undefined
    if (shouldExit) {
      poll = setInterval(() => {
        if (shouldExit()) {
          if (poll) clearInterval(poll)
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
  holdMs = 2000,
  exitWhen?: (output: string) => boolean,
): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream
  const shouldExit = exitWhen ? () => exitWhen(stripAnsi(output)) : undefined
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

// ── fixtures ─────────────────────────────────────────────────────────────

function makeQuestion(question: string, header?: string): Question {
  return {
    question,
    header,
    options: [
      { label: 'yes', description: 'Positive.' },
      { label: 'no', description: 'Negative.' },
    ],
    multiSelect: false,
  } as Question
}

const q1 = makeQuestion('Which auth method should we use?', 'Auth')
const q2 = makeQuestion('Which library should we use for date formatting?', 'Lib')
const TWO_QUESTIONS = [q1, q2]

async function renderListing(
  questions: Question[],
  answers: Record<string, string>,
  expected: string,
): Promise<string> {
  return renderSrStripped(
    <QuestionNavigationBar
      questions={questions}
      currentQuestionIndex={0}
      answers={answers}
    />,
    2000,
    out => out.includes(expected),
  )
}

describe('v2.1.311 #64: QuestionNavigationBar SR question listing', () => {
  beforeEach(() => setSR(false))
  afterEach(() => setSR(false))

  test('SR ON → "Questions: <labels>" with " (answered)" suffix on answered questions', async () => {
    // Arrange
    setSR(true)
    expect(isScreenReaderEnabled()).toBe(true)

    // Act
    const out = await renderListing(
      TWO_QUESTIONS,
      { [q1.question]: 'OAuth' },
      'Questions:',
    )

    // Assert — plural header word, ", " join, answered suffix.
    expect(out).toContain('Questions: Auth (answered), Lib')
  })

  test('SR ON → single question uses the singular "Question" header word', async () => {
    // Arrange
    setSR(true)

    // Act
    const out = await renderListing(
      [q1],
      { [q1.question]: 'OAuth' },
      'Question:',
    )

    // Assert — x.length===1?"Question":"Questions" (@275629041).
    expect(out).toContain('Question: Auth (answered)')
    expect(out).not.toContain('Questions:')
  })

  test('SR ON → unanswered questions carry no suffix', async () => {
    // Arrange
    setSR(true)

    // Act
    const out = await renderListing(TWO_QUESTIONS, {}, 'Questions:')

    // Assert
    expect(out).toContain('Questions: Auth, Lib')
    expect(out).not.toContain('(answered)')
  })

  test('SR ON → label containing a comma is JSON-quoted', async () => {
    // Arrange — qo.includes(",")?_(qo):qo with _ = JSON.stringify.
    setSR(true)
    const commaQ = makeQuestion('Pick a size', 'Size, fit')

    // Act
    const out = await renderListing(
      [commaQ],
      { [commaQ.question]: 'M' },
      'Question:',
    )

    // Assert
    expect(out).toContain('Question: "Size, fit" (answered)')
  })

  test('SR ON → label matching /answered/i is JSON-quoted even without a comma', async () => {
    // Arrange — /answered/i.test(qo) quoting branch, case-insensitive.
    setSR(true)
    const answeredQ = makeQuestion('Review the answered items', 'Already ANSWERED')

    // Act
    const out = await renderListing([answeredQ], {}, 'Question:')

    // Assert — quoted, and NOT suffixed (the question itself is unanswered).
    expect(out).toContain('Question: "Already ANSWERED"')
    expect(out).not.toContain('(answered)')
  })

  test('SR ON → header-less questions fall back to Q1/Q2 labels', async () => {
    // Arrange — Pn?.displayHeader||`Q${ho+1}`.
    setSR(true)
    const bare1 = makeQuestion('First?')
    const bare2 = makeQuestion('Second?')

    // Act
    const out = await renderListing([bare1, bare2], {}, 'Questions:')

    // Assert
    expect(out).toContain('Questions: Q1, Q2')
  })

  test('SR ON → an empty-string answer is falsy → NOT marked "(answered)"', async () => {
    // Arrange — official ternary truthiness-tests hp's returned VALUE
    // (hp(h,x)=…?h[x]:void 0), so "" → falsy → no suffix. This pins the
    // distinction from a naive hasOwn-only check.
    setSR(true)

    // Act
    const out = await renderListing(
      TWO_QUESTIONS,
      { [q1.question]: '' },
      'Questions:',
    )

    // Assert
    expect(out).toContain('Questions: Auth, Lib')
    expect(out).not.toContain('(answered)')
  })

  test('SR ON → the tab bar is REPLACED by the listing (official early return)', async () => {
    // Arrange — `return Jo` in the SR branch: no checkboxes, no Submit, no arrows.
    setSR(true)

    // Act
    const out = await renderListing(
      TWO_QUESTIONS,
      { [q1.question]: 'OAuth' },
      'Questions:',
    )

    // Assert
    expect(out).not.toContain(figures.checkboxOn)
    expect(out).not.toContain(figures.checkboxOff)
    expect(out).not.toContain('Submit')
    expect(out).not.toContain('←')
    expect(out).not.toContain('→')
  })

  test('SR OFF → no listing text; the visual tab bar is unchanged', async () => {
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

    // Assert — tab bar chrome present, listing absent.
    expect(out).not.toContain('Questions:')
    expect(out).not.toContain('(answered)')
    expect(out).toContain(figures.checkboxOn)
    expect(out).toContain('Auth')
    expect(out).toContain('Lib')
  })
})
