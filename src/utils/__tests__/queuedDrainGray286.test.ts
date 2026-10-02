/**
 * CC 2.1.286 (item 55) — queued-drain gray gate WIRING tests (review G3 fix).
 *
 * The pure gate (`shouldAwaitModelForDispatch`, `awaitModelForMessages` flag
 * semantics) is covered by src/state/__tests__/promptsAwaitingModel286.test.ts.
 * This file covers the PRODUCTION DISPATCH CHAIN that was missing: the queued
 * drain must reach the turn-append registration with `isQueuedDispatch=true`,
 * while the typed/idle submit must not.
 *
 * Official v286 semantics (offsets into /tmp/cc-diff-286/v286/package/claude):
 *   - turn-append gray gate `L&&mt` @225818516; `mt` = run's NEW 15th param
 *     (`run=async(h,v,L,...,dt,mt=!1)` @225815961)
 *   - dispatcher `xZe` computes `ht=Ge==="queued"` @225767067 (`Ge` =
 *     inputSource) and threads it at `await gt(...,so,ht)` @225772771
 *   - queued drain is the only caller with `inputSource:"queued"` @225759170;
 *     typed submit falls back to `inputSource:h.inputSource??"typed"`
 *     @225766364 → mt=false → normal color right away
 *   - applyEvent attachment branch `if(h.type==="attachment")
 *     this.stream.awaitModelFor([h])` is byte-identical v285 @224558227 /
 *     v286 @225813406 → queued_command attachments always gray.
 *
 * OCC chain under test (queued drain):
 *   useQueueProcessor effect (src/hooks/useQueueProcessor.ts:60)
 *   → processQueueIfReady (src/utils/queueProcessor.ts)
 *   → executeQueuedInput (src/screens/REPL.tsx:4086) — passes
 *     makeQueuedDispatchOnQuery(onQuery) as handlePromptSubmit's onQuery
 *   → handlePromptSubmit queued branch (src/utils/handlePromptSubmit.ts:150)
 *   → executeUserInput → onQuery(...8 args) (handlePromptSubmit.ts:560-571)
 *   → wrapper appends 9th arg `true` → REPL onQuery (REPL.tsx:3059)
 *   → awaitModelForMessages(newMessages, isQueuedDispatch === true)
 *     (REPL.tsx turn-append, official `L&&mt`).
 *
 * handlePromptSubmit's onQuery call site is a fixed 8-arg call shared by the
 * typed and queued paths, so the flag cannot travel through it as data; the
 * queued drain instead passes a WRAPPED callback (the OCC analog of the
 * official dispatcher appending `ht` as run's final argument).
 *
 * Mock plumbing: processUserInput is stubbed via the delegation+mockActive
 * pattern (exemplar: sessionStorage.parallelTRRecovery286.test.ts) — bun's
 * mock.module() is permanent per process, so the shim delegates to the real
 * implementation when inactive and afterAll re-pins the captured real
 * reference.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import {
  _resetPromptsAwaitingModelForTesting,
  awaitModelForMessages,
  getPromptsAwaitingModelSnapshot,
} from '../../state/promptsAwaitingModel.js'
import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE the module under test is imported.
// ---------------------------------------------------------------------------

const actualProcessUserInput = await import(
  '../processUserInput/processUserInput.js'
)
const actualProcessUserInputFn = actualProcessUserInput.processUserInput

let mockActive = true
let nextResultMessages: Message[] = []

mock.module('../processUserInput/processUserInput.js', () => ({
  ...actualProcessUserInput,
  processUserInput: (params: unknown) => {
    if (!mockActive) {
      return actualProcessUserInputFn(params as never)
    }
    return Promise.resolve({
      messages: nextResultMessages,
      shouldQuery: true,
      allowedTools: undefined,
      model: undefined,
      effort: undefined,
      nextInput: undefined,
      submitNextInput: undefined,
    })
  },
}))

afterAll(() => {
  // Leak guard: re-pin the REAL function reference captured pre-mock.
  mockActive = false
  mock.module('../processUserInput/processUserInput.js', () => ({
    ...actualProcessUserInput,
    processUserInput: actualProcessUserInputFn,
  }))
})

const { handlePromptSubmit } = await import('../handlePromptSubmit.js')
const { QueryGuard } = await import('../QueryGuard.js')
const { makeQueuedDispatchOnQuery } = await import('../messageQueueManager.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUserFixture(): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: 'prompt fixture' },
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

function makeQueuedCommandAttachmentFixture(): Message {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    attachment: { type: 'queued_command', content: 'do the thing' },
  } as unknown as Message
}

function awaitingKeyOf(message: Message): string {
  return (message.uuid as unknown as string).slice(0, 24)
}

type DispatchCall = {
  argCount: number
  newMessages: Message[]
  isQueuedDispatch: boolean | undefined
}

/**
 * Records the dispatch and mirrors the production turn-append registration
 * (REPL.tsx onQuery): `awaitModelForMessages(newMessages, isQueuedDispatch === true)`.
 */
function makeRecordingDispatch(): {
  calls: DispatchCall[]
  onQuery: (...args: unknown[]) => Promise<void>
} {
  const calls: DispatchCall[] = []
  const onQuery = async (...args: unknown[]): Promise<void> => {
    const newMessages = args[0] as Message[]
    const isQueuedDispatch = args[8] as boolean | undefined
    calls.push({ argCount: args.length, newMessages, isQueuedDispatch })
    awaitModelForMessages(newMessages, isQueuedDispatch === true)
  }
  return { calls, onQuery }
}

function makeBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    helpers: {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    },
    queryGuard: new QueryGuard(),
    commands: [],
    onInputChange: () => {},
    setPastedContents: () => {},
    setToolJSX: () => {},
    getToolUseContext: () => ({}) as never,
    messages: [],
    mainLoopModel: 'claude-sonnet-4-5',
    ideSelection: undefined,
    querySource: 'repl_main_thread',
    setUserInputOnProcessing: () => {},
    setAbortController: () => {},
    setAppState: () => {},
    ...overrides,
  } as never
}

beforeEach(() => {
  mockActive = true
  nextResultMessages = []
  _resetPromptsAwaitingModelForTesting()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeQueuedDispatchOnQuery — official `ht=inputSource==="queued"` @225767067 analog', () => {
  test('forwards all 8 dispatch args unchanged and appends isQueuedDispatch=true as the 9th', async () => {
    // Arrange
    const seen: unknown[][] = []
    const wrapped = makeQueuedDispatchOnQuery(async (...args: unknown[]) => {
      seen.push(args)
    })
    const messages = [makeUserFixture()]
    const abortController = new AbortController()
    const beforeQuery = async () => true

    // Act — the exact 8-arg shape handlePromptSubmit.ts:560-571 calls with
    await wrapped(
      messages,
      abortController,
      true,
      ['Bash'],
      'model-x',
      beforeQuery,
      'input-x',
      undefined,
    )

    // Assert
    expect(seen.length).toBe(1)
    expect(seen[0]!.length).toBe(9)
    expect(seen[0]!.slice(0, 8)).toEqual([
      messages,
      abortController,
      true,
      ['Bash'],
      'model-x',
      beforeQuery,
      'input-x',
      undefined,
    ])
    expect(seen[0]![8]).toBe(true)
  })
})

describe('queued drain through handlePromptSubmit — official xZe({inputSource:"queued"}) @225759170', () => {
  test('wrapped onQuery registers a plain user prompt as awaiting (gray)', async () => {
    // Arrange — executeQueuedInput shape: queuedCommands + wrapped onQuery
    const userMessage = makeUserFixture()
    nextResultMessages = [userMessage]
    const { calls, onQuery } = makeRecordingDispatch()
    const queuedCommand: QueuedCommand = {
      value: 'queued prompt',
      mode: 'prompt',
    }

    // Act
    await handlePromptSubmit(
      makeBaseParams({
        onQuery: makeQueuedDispatchOnQuery(onQuery),
        queuedCommands: [queuedCommand],
      }),
    )

    // Assert — the 9th arg arrived true and the prompt registered gray
    expect(calls.length).toBe(1)
    expect(calls[0]!.argCount).toBe(9)
    expect(calls[0]!.isQueuedDispatch).toBe(true)
    expect(
      getPromptsAwaitingModelSnapshot().promptsAwaitingModel.has(
        awaitingKeyOf(userMessage),
      ),
    ).toBe(true)
  })

  test('pre-fix control: RAW onQuery (1-arg shipping call at turn-append) never registers a normal user prompt', async () => {
    // Arrange — the shipped-before-G3-fix shape: executeQueuedInput passed
    // onQuery unwrapped, so the turn-append saw the 8-arg default (flag
    // false). This is the reviewer's probe, kept as the causality control.
    const userMessage = makeUserFixture()
    nextResultMessages = [userMessage]
    const { calls, onQuery } = makeRecordingDispatch()
    const queuedCommand: QueuedCommand = {
      value: 'queued prompt',
      mode: 'prompt',
    }

    // Act
    await handlePromptSubmit(
      makeBaseParams({ onQuery, queuedCommands: [queuedCommand] }),
    )

    // Assert
    expect(calls.length).toBe(1)
    expect(calls[0]!.argCount).toBe(8)
    expect(calls[0]!.isQueuedDispatch).toBeUndefined()
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })
})

describe('typed/idle submit through handlePromptSubmit — official inputSource??"typed" @225766364', () => {
  test('raw onQuery dispatches with 8 args and does NOT register (normal color right away)', async () => {
    // Arrange — REPL onSubmit shape: input + raw onQuery, guard idle
    const userMessage = makeUserFixture()
    nextResultMessages = [userMessage]
    const { calls, onQuery } = makeRecordingDispatch()

    // Act
    await handlePromptSubmit(
      makeBaseParams({ onQuery, input: 'typed while idle', mode: 'prompt' }),
    )

    // Assert
    expect(calls.length).toBe(1)
    expect(calls[0]!.argCount).toBe(8)
    expect(calls[0]!.isQueuedDispatch).toBeUndefined()
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })
})

describe('queued_command attachment — applyEvent branch unconditional (v285 @224558227 = v286 @225813406)', () => {
  test('1-arg shipping call (REPL onQueryEvent shape) still registers the attachment', () => {
    // Arrange / Act — mirrors REPL.tsx onQueryEvent:
    // `awaitModelForMessages([event])` with no flag, for any dispatch source
    const attachment = makeQueuedCommandAttachmentFixture()
    awaitModelForMessages([attachment])

    // Assert
    expect(
      getPromptsAwaitingModelSnapshot().promptsAwaitingModel.has(
        awaitingKeyOf(attachment),
      ),
    ).toBe(true)
  })
})

describe('REPL.tsx production wiring (source pin)', () => {
  test('turn-append passes the flag, executeQueuedInput wraps onQuery, typed onSubmit stays raw', async () => {
    // Arrange
    const replSource = await Bun.file(
      `${import.meta.dir}/../../screens/REPL.tsx`,
    ).text()

    // Assert — turn-append registration threads the queued flag (official
    // `L&&mt` @225818516); the onQuery callback accepts it as the 9th param
    // (official `mt=!1` @225815961); ONLY the queued drain wraps (official
    // `ht=Ge==="queued"` @225767067); the typed submit keeps the raw callback
    // (official `inputSource??"typed"` @225766364 → mt=false).
    expect(replSource).toContain(
      'awaitModelForMessages(newMessages, isQueuedDispatch === true)',
    )
    expect(replSource).toContain('isQueuedDispatch?: boolean')
    expect(replSource).toContain('makeQueuedDispatchOnQuery(onQuery)')
    const wrappedHits = replSource
      .split('\n')
      .filter(line => line.includes('makeQueuedDispatchOnQuery('))
    expect(wrappedHits.length).toBe(1)
  })
})
