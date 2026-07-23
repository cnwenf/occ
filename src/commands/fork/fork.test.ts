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

// sessionStorage mock (must match fork.ts import path). Spread the REAL
// module's exports so co-located test files that import other members of
// sessionStorage (e.g. getProjectDir) are not clobbered by this narrow mock.
const realSessionStorage = await import('../../utils/sessionStorage.js')
mock.module('../../utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  getTranscriptPathForSession: getTranscriptPathForSessionMock,
  saveCustomTitle: saveCustomTitleMock,
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

  test('outputs the 2.1.216 #30 one-line confirmation with name + attach id + shares-checkout note', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([userMessage('hi')])

    // Act — deriveForkName('do the thing') === 'do-the-thing'
    await call(onDone, context, 'do the thing')

    // Assert — one line: name, claude attach id, shares-checkout note
    expect(output).toHaveLength(1)
    expect(output[0]).toMatch(
      /^Forked session do-the-thing \(claude attach [0-9a-f-]{36}\) \(shares your checkout\)$/,
    )
    expect(output[0].includes('\n')).toBe(false)
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
    expect(arg.parentSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(arg.parentLastUuid).toBe('msg-1')
    expect(arg.agentId).toBe('agent-1')
    expect(arg.forkedSessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('writes a custom-title named via uwd(directive) with source=user (GAP-3/GAP-5)', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('inherited')])

    // Act — uwd('refactor auth') = 'refactor-auth'
    await call(onDone, context, 'refactor auth')

    // Assert
    expect(saveCustomTitleMock).toHaveBeenCalledTimes(1)
    const [sessionId, title, path, source] =
      saveCustomTitleMock.mock.calls[0] as [string, string, string, string]
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(title).toBe('refactor-auth')
    expect(path).toBe(`/tmp/${sessionId}.jsonl`)
    expect(source).toBe('user')
  })

  test('names the fork via uwd for a multi-word directive (deploy-to-staging)', async () => {
    // Arrange
    const { context, onDone } = makeContext([userMessage('inherited')])

    // Act — uwd('Deploy to staging') = 'deploy-to-staging'
    await call(onDone, context, 'Deploy to staging')

    // Assert
    const title = (saveCustomTitleMock.mock.calls[0] as [string, string])[1]
    expect(title).toBe('deploy-to-staging')
  })

  test('GAP-4: empty directive prints Usage and exits before any fork work', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([userMessage('hi')])

    // Act
    await call(onDone, context, '')

    // Assert — official iNy: `if(!n) return Usage` runs first
    expect(output).toEqual(['Usage: /fork <directive>'])
    expect(writeForkPointerMock).not.toHaveBeenCalled()
    expect(saveCustomTitleMock).not.toHaveBeenCalled()
  })

  test('GAP-4: whitespace-only directive prints Usage and exits', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([userMessage('hi')])

    // Act
    await call(onDone, context, '   \t  ')

    // Assert
    expect(output).toEqual(['Usage: /fork <directive>'])
    expect(writeForkPointerMock).not.toHaveBeenCalled()
    expect(saveCustomTitleMock).not.toHaveBeenCalled()
  })

  test('GAP-4: undefined directive (no args) prints Usage and exits', async () => {
    // Arrange
    const { context, onDone, output } = makeContext([userMessage('hi')])

    // Act
    await call(onDone, context, undefined as unknown as string)

    // Assert
    expect(output).toEqual(['Usage: /fork <directive>'])
    expect(writeForkPointerMock).not.toHaveBeenCalled()
    expect(saveCustomTitleMock).not.toHaveBeenCalled()
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
