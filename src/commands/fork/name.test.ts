import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  deriveForkName,
  FORK_NAME_FALLBACK,
} from './name.js'

/**
 * Builds a user Message with the given content (string or content-block
 * array). Only the fields `deriveForkName` reads are populated.
 */
function userMessage(content: unknown): Message {
  return {
    type: 'user',
    uuid: 'uuid-1' as never,
    message: { role: 'user', content },
  } as unknown as Message
}

describe('deriveForkName', () => {
  test('prefers the directive when provided', () => {
    // Arrange
    const messages = [userMessage('inherited first prompt')]

    // Act
    const name = deriveForkName('refactor the auth module', messages)

    // Assert
    expect(name).toBe('refactor the auth module')
  })

  test('falls back to the first user message when directive is empty', () => {
    // Arrange
    const messages = [
      userMessage([{ type: 'text', text: 'fix the login bug' }]),
      userMessage('second prompt'),
    ]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe('fix the login bug')
  })

  test('falls back to the first user message when directive is whitespace', () => {
    // Arrange
    const messages = [userMessage('whitespace directive fallback')]

    // Act
    const name = deriveForkName('   \t  ', messages)

    // Assert
    expect(name).toBe('whitespace directive fallback')
  })

  test('handles string content on the first user message', () => {
    // Arrange
    const messages = [userMessage('a plain string first prompt')]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe('a plain string first prompt')
  })

  test('picks the first text block from array content', () => {
    // Arrange — image block first, then text
    const messages = [
      userMessage([
        { type: 'image', source: {} as never },
        { type: 'text', text: 'after an image' },
      ]),
    ]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe('after an image')
  })

  test('collapses multiline whitespace into a single space', () => {
    // Arrange
    const messages = [userMessage('line one\nline two\n\n  indented')]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe('line one line two indented')
  })

  test('truncates a long directive to the 100-char cap', () => {
    // Arrange
    const long = 'a'.repeat(250)
    const expected = 'a'.repeat(100)

    // Act
    const name = deriveForkName(long, [])

    // Assert
    expect(name).toBe(expected)
  })

  test('truncates a long first prompt to the 100-char cap', () => {
    // Arrange
    const long = 'b'.repeat(250)
    const messages = [userMessage(long)]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe('b'.repeat(100))
  })

  test('returns the fallback when directive and first prompt are both empty', () => {
    // Arrange — user message with no content
    const messages = [userMessage(undefined)]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe(FORK_NAME_FALLBACK)
  })

  test('returns the fallback when there are no user messages', () => {
    // Arrange — only assistant / progress messages
    const messages = [
      { type: 'assistant', uuid: 'a' } as unknown as Message,
      { type: 'progress', uuid: 'b' } as unknown as Message,
    ]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe(FORK_NAME_FALLBACK)
  })

  test('returns the fallback when the messages array is empty', () => {
    // Arrange
    const messages: Message[] = []

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe(FORK_NAME_FALLBACK)
  })

  test('returns the fallback when the first user message has no text block', () => {
    // Arrange — array content with only an image block
    const messages = [
      userMessage([{ type: 'image', source: {} as never }]),
    ]

    // Act
    const name = deriveForkName('', messages)

    // Assert
    expect(name).toBe(FORK_NAME_FALLBACK)
  })

  test('uses the first user message, not a later one, for the fallback', () => {
    // Arrange — first user message has no text, second has text
    const messages = [
      userMessage([{ type: 'image', source: {} as never }]),
      userMessage('should not be used'),
    ]

    // Act
    const name = deriveForkName('', messages)

    // Assert — first user message yields no text, so fallback
    expect(name).toBe(FORK_NAME_FALLBACK)
  })

  test('does not mutate the input messages array', () => {
    // Arrange
    const messages = [userMessage('original')]

    // Act
    deriveForkName('directive', messages)

    // Assert — array reference and contents unchanged
    expect(messages).toHaveLength(1)
    expect((messages[0] as { message: { content: string } }).message.content).toBe(
      'original',
    )
  })
})
