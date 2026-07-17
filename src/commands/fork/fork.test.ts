import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { Message } from '../../types/message.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

// --- Mocks for fork.ts's external dependencies -------------------------------

const saveCustomTitleMock = mock(
  async (_sessionId: string, _title: string, _path?: string, _source?: string) => {},
)
const getTranscriptPathForSessionMock = mock((id: string) => `/tmp/${id}.jsonl`)
const writeForkPointerMock = mock(async () => {})

// sessionStorage mock (must match fork.ts import path).
mock.module('../../utils/sessionStorage.js', () => ({
  getTranscriptPathForSession: getTranscriptPathForSessionMock,
  saveCustomTitle: saveCustomTitleMock,
}))

// bootstrap/state mock.
mock.module('../../bootstrap/state.js', () => ({
  getSessionId: () => 'parent-session-id',
  getOriginalCwd: () => '/cwd',
}))

// pointer mock — fork.ts imports writeForkPointer from ./pointer.js.
mock.module('./pointer.js', () => ({
  writeForkPointer: writeForkPointerMock,
}))

// --- Load the fork call after mocks are registered ----------------------------

const { call } = await import('./fork.js')

// --- Helpers -----------------------------------------------------------------

function userMessage(text: string): Message {
  return {
    type: 'user',
    uuid: 'msg-1' as never,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function makeContext(
  messages: Message[],
): { context: LocalJSXCommandContext; onDone: LocalJSXCommandOnDone; output: string[] } {
  const output: string[] = []
  const onDone: LocalJSXCommandOnDone = (msg: string) => {
    output.push(msg)
  }
  const context = {
    messages,
    agentId: 'agent-1',
  } as unknown as LocalJSXCommandContext
  return { context, onDone, output }
}

// --- Tests -------------------------------------------------------------------

describe('/fork call (2.1.212 delta)', () => {
  beforeEach(() => {
    saveCustomTitleMock.mockClear()
    getTranscriptPathForSessionMock.mockClear()
    writeForkPointerMock.mockClear()
  })

  test('outputs "Forked session <id> (fork)" with the 2.1.212 suffix', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([userMessage('hi')])

    // Act
    await call(onDone, context, 'do the thing')

    // Assert
    expect(output).toHaveLength(1)
    expect(output[0]).toMatch(/^Forked session [0-9a-f-]{36} \(fork\)$/)
  })

  test('writes the fork-context-ref pointer', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('hi')])

    // Act
    await call(onDone, context, 'directive')

    // Assert
    expect(writeForkPointerMock).toHaveBeenCalledTimes(1)
    const arg = writeForkPointerMock.mock.calls[0][0] as {
      forkedSessionId: string
      parentSessionId: string
      parentLastUuid: string
      agentId?: string
    }
    expect(arg.parentSessionId).toBe('parent-session-id')
    expect(arg.parentLastUuid).toBe('msg-1')
    expect(arg.agentId).toBe('agent-1')
    expect(arg.forkedSessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('writes a custom-title named after the directive (source=auto)', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('inherited')])

    // Act
    await call(onDone, context, 'refactor auth')

    // Assert
    expect(saveCustomTitleMock).toHaveBeenCalledTimes(1)
    const [sessionId, title, path, source] =
      saveCustomTitleMock.mock.calls[0] as [string, string, string, string]
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(title).toBe('refactor auth')
    expect(path).toBe(`/tmp/${sessionId}.jsonl`)
    expect(source).toBe('auto')
  })

  test('names the fork after the first prompt when directive is empty', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('inherited first prompt')])

    // Act
    await call(onDone, context, '')

    // Assert
    expect(saveCustomTitleMock).toHaveBeenCalledTimes(1)
    const title = (saveCustomTitleMock.mock.calls[0] as [string, string])[1]
    expect(title).toBe('inherited first prompt')
  })

  test('errors when there are no chain messages (no first turn)', async () => {
    // Arrange — only progress messages, no chain participant
    const { context, onDone, output } = makeContext([
      { type: 'progress', uuid: 'p1' } as unknown as Message,
    ])

    // Act
    await call(onDone, context, 'directive')

    // Assert
    expect(output).toEqual(['Cannot fork before the first conversation turn'])
    expect(writeForkPointerMock).not.toHaveBeenCalled()
    expect(saveCustomTitleMock).not.toHaveBeenCalled()
  })

  test('errors when the messages array is empty', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([])

    // Act
    await call(onDone, context, 'directive')

    // Assert
    expect(output).toEqual(['Cannot fork before the first conversation turn'])
    expect(writeForkPointerMock).not.toHaveBeenCalled()
    expect(saveCustomTitleMock).not.toHaveBeenCalled()
  })

  test('writes pointer before the custom-title (pointer creates the file)', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('hi')])
    const order: string[] = []
    writeForkPointerMock.mockImplementation(async () => {
      order.push('pointer')
    })
    saveCustomTitleMock.mockImplementation(async () => {
      order.push('title')
    })

    // Act
    await call(onDone, context, 'directive')

    // Assert
    expect(order).toEqual(['pointer', 'title'])

    // Cleanup — restore default no-op impls
    writeForkPointerMock.mockImplementation(async () => {})
    saveCustomTitleMock.mockImplementation(async () => {})
  })
})
