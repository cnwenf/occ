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
 * v2.1.288 gap entry #67 — Screen reader: question dialogs now surface which
 * questions are answered.
 *
 * SUPERSEDED IN v2.1.311 (PORT #64). v288 official rendered an inline
 * `iXe="answered "` label between the checkbox and the display text
 * (binary @229288327, tab renderer @~229289600). In v311 the official
 * QuestionNavigationBar (`Sk` @275627750) REPLACED that surface: when SR is
 * on it EARLY-RETURNS a single listing —
 *   `Questions: Auth (answered), Lib` —
 * INSTEAD of the tab bar (`return Jo`), and v311's non-SR tab renderer no
 * longer contains the inline prefix. Evidence: `(answered)` v310=0 → v311=2
 * (@129034225, @275628958); the v310 `"answered "` tab-prefix string is gone
 * from the v311 tab renderer. See questionNavSrListing311.test.tsx for the
 * full listing contract (singular/plural, quoting, Q-fallback).
 *
 * These tests therefore assert the v311 SR listing on the SR-ON path, and
 * keep the v288 SR-OFF guarantee: the visible-mode tab bar never shows
 * "answered" anywhere.
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
 * after `changeMs`. Guards the SR listing memo slots — a stale-cache bug shows
 * as the " (answered)" suffix NOT appearing after the answers prop changes.
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

// v311 listing strings (binary `Sk` @275627750): header word + ", "-joined
// labels; answered labels get the " (answered)" suffix (@275628958).
const LISTING_ONE_ANSWERED = 'Questions: Auth (answered), Lib'
const LISTING_BOTH_ANSWERED = 'Questions: Auth (answered), Lib (answered)'

describe('v2.1.288 #67 → v2.1.311 #64: QuestionNavigationBar SR "answered" surface', () => {
  beforeEach(() => setSR(false))
  afterEach(() => setSR(false))

  test('SR ON + answered question → the listing marks it "(answered)"', async () => {
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
      2000,
      o => o.includes(LISTING_ONE_ANSWERED),
    )

    // Assert — v311 SR listing; the tab bar (and its checkboxes) is replaced.
    expect(out).toContain(LISTING_ONE_ANSWERED)
    expect(out).not.toContain(figures.checkboxOn)
  })

  test('SR ON + unanswered question → no "(answered)" suffix for it', async () => {
    // Arrange — q1 answered, q2 NOT answered.
    setSR(true)

    // Act
    const out = await renderSrStripped(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth' }}
      />,
      2000,
      o => o.includes(LISTING_ONE_ANSWERED),
    )

    // Assert — exactly one suffix (the answered question); the unanswered one
    // keeps its bare label.
    expect(out).toContain(LISTING_ONE_ANSWERED)
    expect(out.match(/\(answered\)/g)?.length ?? 0).toBe(1)
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

  test('SR ON → every answered question gets the suffix in the listing', async () => {
    // Arrange — ≥2 questions, both answered.
    setSR(true)

    // Act
    const out = await renderSrStripped(
      <QuestionNavigationBar
        questions={TWO_QUESTIONS}
        currentQuestionIndex={0}
        answers={{ [q1.question]: 'OAuth', [q2.question]: 'date-fns' }}
      />,
      2000,
      o => o.includes(LISTING_BOTH_ANSWERED),
    )

    // Assert
    expect(out).toContain(LISTING_BOTH_ANSWERED)
  })

  test('memo-cache sanity: the listing updates after the answers prop changes on a live instance', async () => {
    // Arrange — first render has NO answers; at +20ms the answers prop changes.
    // If the SR listing memo pairing is broken (stale $[k] slots), the cached
    // listing without "(answered)" is returned and the suffix never appears.
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
      o => o.includes(LISTING_ONE_ANSWERED),
    )

    // Assert
    expect(out).toContain(LISTING_ONE_ANSWERED)
  })
})
