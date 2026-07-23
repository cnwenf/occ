import { describe, test, expect } from 'bun:test'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

/**
 * CC 2.1.216 #4: AskUserQuestion told Claude to "continue" even when the
 * user's answer asked it to wait/explain first. Free-text answers (the user
 * selected "Other" and typed custom text) now get NEUTRAL wording that does
 * NOT tell Claude to continue, while multiple-choice answers keep the
 * "continue" directive.
 *
 * Official binary wording (from strings recon):
 *   MC:    `Your questions have been answered: ${s}. You can now continue with these answers in mind.`
 *   Free:  `The user answered: ${s}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`
 *   None:  `The user did not answer the questions.`
 */

describe('AskUserQuestion: neutral wording for free-text answers', () => {
  test('multiple-choice answer uses "continue" directive', () => {
    const questions = [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'React desc' },
          { label: 'Vue', description: 'Vue desc' },
        ],
        multiSelect: false,
      },
    ]
    // User selected "React" — a known option label
    const answers = { 'Which framework?': 'React' }

    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      { questions, answers } as never,
      'toolu_test1',
    )

    expect(result.type).toBe('tool_result')
    const content = result.content as string
    // MC answers get the "continue" directive
    expect(content).toContain('You can now continue')
    expect(content).toContain('Your questions have been answered')
  })

  test('free-text answer (Other) uses neutral wording without "continue"', () => {
    const questions = [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'React desc' },
          { label: 'Vue', description: 'Vue desc' },
        ],
        multiSelect: false,
      },
    ]
    // User typed custom free-text answer — NOT a known option label
    const answers = {
      'Which framework?': 'Actually, let me explain my concern first',
    }

    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      { questions, answers } as never,
      'toolu_test2',
    )

    expect(result.type).toBe('tool_result')
    const content = result.content as string
    // Free-text answers get NEUTRAL wording — NO "continue" directive
    expect(content).not.toContain('You can now continue')
    expect(content).toContain('The user answered')
    expect(content).toContain('Read the answers carefully')
  })

  test('mixed answers (one MC, one free-text) uses neutral wording', () => {
    const questions = [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'd' },
          { label: 'Vue', description: 'd' },
        ],
        multiSelect: false,
      },
      {
        question: 'What language?',
        header: 'Language',
        options: [
          { label: 'TypeScript', description: 'd' },
          { label: 'Python', description: 'd' },
        ],
        multiSelect: false,
      },
    ]
    // One MC answer, one free-text
    const answers = {
      'Which framework?': 'React',
      'What language?': 'I prefer Rust actually',
    }

    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      { questions, answers } as never,
      'toolu_test3',
    )

    const content = result.content as string
    // Any free-text answer → neutral wording
    expect(content).not.toContain('You can now continue')
    expect(content).toContain('The user answered')
  })

  test('multi-select answer where all parts are known options uses "continue"', () => {
    const questions = [
      {
        question: 'Which features?',
        header: 'Features',
        options: [
          { label: 'Auth', description: 'd' },
          { label: 'Logging', description: 'd' },
          { label: 'Analytics', description: 'd' },
        ],
        multiSelect: true,
      },
    ]
    // User selected Auth and Logging — comma-separated known options
    const answers = { 'Which features?': 'Auth, Logging' }

    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      { questions, answers } as never,
      'toolu_test4',
    )

    const content = result.content as string
    expect(content).toContain('You can now continue')
    expect(content).toContain('Your questions have been answered')
  })

  test('multi-select with one free-text option uses neutral wording', () => {
    const questions = [
      {
        question: 'Which features?',
        header: 'Features',
        options: [
          { label: 'Auth', description: 'd' },
          { label: 'Logging', description: 'd' },
        ],
        multiSelect: true,
      },
    ]
    // User selected Auth and typed custom text
    const answers = { 'Which features?': 'Auth, something custom' }

    const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
      { questions, answers } as never,
      'toolu_test5',
    )

    const content = result.content as string
    expect(content).not.toContain('You can now continue')
    expect(content).toContain('The user answered')
  })
})
