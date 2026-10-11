import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.296 #006 — FileReadTool `allow_large` (Slice B).
 *
 * Upstream evidence (v296 linux-x64 ELF, md5 3c8749470f70a26efadf982b587e1548):
 *   - Constants @209662501: `rt="Read"`, `hue="allow_large"`.
 *   - Coefficients @219148327: `sOr=0.7` (room fraction), `iOr=2` (bytes-per-
 *     token floor divisor), `aOr=3` (raised bytes multiplier), `jgo=128`
 *     (rough length:token ratio) @210495482.
 *   - Messages @210495482-210496323: `Aws` (fits-after-raise), `Bgo` (exceeds
 *     room), `Cws` (unavailable).
 *   - Room calc `lOr` @219148327, telemetry `Chn` @219148814, msg selector
 *     `Ave` @219148986, error transformer `_hn` @219149198, token counter
 *     `khn` @219149776, text path `dOr` @219156400-219161350.
 *   - `d` wrapper = fromEnum = identity (chunk-wkmq9ht0.js @207051783) —
 *     outcome strings pass through raw.
 *
 * Repo mock.module template (readTool281.test.ts): snapshot actuals BEFORE
 * mocking, dynamic-import the modules under test AFTER registration, restore
 * in afterAll — mock.module leaks across files in the same worker.
 */

const actualTokenEstimation = {
  ...(await import('../../../services/tokenEstimation.js')),
}
const actualAnalytics = {
  ...(await import('../../../services/analytics/index.js')),
}

let roughOverride: ((content: string, ext: string) => number) | null = null
let apiOverride: ((content: string) => Promise<number | null>) | null = null
let apiCalls: string[] = []
let events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []

mock.module('../../../services/tokenEstimation.js', () => ({
  ...actualTokenEstimation,
  roughTokenCountEstimationForFileType: (content: string, ext: string) =>
    roughOverride
      ? roughOverride(content, ext)
      : actualTokenEstimation.roughTokenCountEstimationForFileType(content, ext),
  countTokensWithAPI: (content: string) => {
    apiCalls.push(content)
    return apiOverride
      ? apiOverride(content)
      : actualTokenEstimation.countTokensWithAPI(content)
  },
}))

mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (eventName: string, metadata: Record<string, unknown>) => {
    events.push({ eventName, metadata })
  },
}))

const {
  FileReadTool,
  MaxFileReadTokenExceededError,
  transformReadError,
  countReadTokensForRead,
} = await import('../FileReadTool.js')
const {
  ALLOW_LARGE_FIELD_NAME,
  ALLOW_LARGE_FITS_MESSAGE,
  ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE,
  ALLOW_LARGE_UNAVAILABLE_MESSAGE,
  PARTIAL_VIEW_PREFIX,
  ROOM_FRACTION,
  RAISED_BYTES_PER_TOKEN_MULTIPLIER,
  BYTES_PER_TOKEN_FLOOR_DIVISOR,
  ROUGH_LENGTH_TOKEN_RATIO,
  computeAllowLargeRoom,
  selectAllowLargeMessage,
  buildTokenCapPartialView,
  countNewlines,
} = await import('../allowLarge.js')
const { FileTooLargeError, SelectedRangeTooLargeError } = await import(
  '../../../utils/readFileInRange.js'
)
const { stashCheckTimeResolutions } = await import(
  '../../../utils/permissions/symlinkResolutionStash.js'
)

// ── Fixtures ──

const LINE = 'x'.repeat(39)
const FIXTURE_LINES = 1000
const FIXTURE_CONTENT = Array.from({ length: FIXTURE_LINES }, () => LINE).join(
  '\n',
) // 39999 chars, 1000 lines

let tmpDir: string
let bigFile: string
let savedSimpleEnv: string | undefined
let toolUseCounter = 0

beforeAll(async () => {
  savedSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-allow-large-296-'))
  bigFile = join(tmpDir, 'big.txt')
  await writeFile(bigFile, FIXTURE_CONTENT, 'utf8')
})

afterAll(async () => {
  mock.restore()
  if (savedSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = savedSimpleEnv
  }
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  roughOverride = null
  apiOverride = null
  apiCalls = []
  events = []
})

type FakeRoom = {
  threshold: number
  held: () => number
  claimed: () => number
  claim: (tokens: number) => void
}

function makeRoom(
  threshold: number,
  held: number,
  claimed: number,
  claimCalls?: number[],
): FakeRoom {
  return {
    threshold,
    held: () => held,
    claimed: () => claimed,
    claim: (tokens: number) => {
      claimCalls?.push(tokens)
    },
  }
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    toolUseId: `toolu_test_${++toolUseCounter}`,
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    options: { mainLoopModel: 'claude-opus-5' },
    ...overrides,
  }
}

function callRead(
  filePath: string,
  input: Record<string, unknown>,
  context: ReturnType<typeof makeContext>,
) {
  stashCheckTimeResolutions(context as never, filePath, 'read')
  return FileReadTool.call(
    { file_path: filePath, ...input } as never,
    context as never,
  )
}

function allowLargeEvents() {
  return events.filter(e => e.eventName === 'tengu_file_read_allow_large')
}

function sessionReadEvents() {
  return events.filter(e => e.eventName === 'tengu_session_file_read')
}

// ── Constants & messages (byte-exact from the v296 ELF) ──

describe('allow_large constants + messages (CC 2.1.296 #006)', () => {
  test('coefficients match the official sOr/iOr/aOr/jgo', () => {
    expect(ROOM_FRACTION).toBe(0.7)
    expect(BYTES_PER_TOKEN_FLOOR_DIVISOR).toBe(2)
    expect(RAISED_BYTES_PER_TOKEN_MULTIPLIER).toBe(3)
    expect(ROUGH_LENGTH_TOKEN_RATIO).toBe(128)
    expect(ALLOW_LARGE_FIELD_NAME).toBe('allow_large')
  })

  test('Aws fits-after-raise message is byte-exact', () => {
    expect(ALLOW_LARGE_FITS_MESSAGE).toBe(
      ' To read it anyway, up to what still fits in your context, call Read again with allow_large: true — only if you genuinely need all of it or the user asked for the whole file.',
    )
  })

  test('Bgo exceeds-room message is byte-exact', () => {
    expect(ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE).toBe(
      ' Even with allow_large, this is more than fits in the context you have left this turn (other large reads in the same turn share that room).',
    )
  })

  test('Cws unavailable message is byte-exact', () => {
    expect(ALLOW_LARGE_UNAVAILABLE_MESSAGE).toBe(
      ' allow_large is not available where this read runs; read it in parts with offset and limit.',
    )
  })

  test('PARTIAL_VIEW_PREFIX kept byte-exact', () => {
    expect(PARTIAL_VIEW_PREFIX).toBe('[Truncated: PARTIAL view — ')
  })
})

// ── Ave: message selector ──

describe('selectAllowLargeMessage (official Ave @219148986)', () => {
  test('roomTokens undefined + opted in → Cws', () => {
    expect(
      selectAllowLargeMessage({ roomTokens: undefined }, true, {}),
    ).toBe(ALLOW_LARGE_UNAVAILABLE_MESSAGE)
  })

  test('roomTokens undefined + not opted in → empty string', () => {
    expect(selectAllowLargeMessage({ roomTokens: undefined }, false, {})).toBe(
      '',
    )
  })

  test('opted in with room → Bgo regardless of raised', () => {
    expect(
      selectAllowLargeMessage(
        { roomTokens: 5000, raised: { maxTokens: 5000, maxSizeBytes: 1e9 } },
        true,
        { bytes: 10 },
      ),
    ).toBe(ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE)
  })

  test('not opted in + raised undefined → Bgo', () => {
    expect(selectAllowLargeMessage({ roomTokens: 5000 }, false, {})).toBe(
      ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE,
    )
  })

  test('not opted in + fits raised byte and token caps → Aws', () => {
    expect(
      selectAllowLargeMessage(
        { roomTokens: 5000, raised: { maxTokens: 600, maxSizeBytes: 9000 } },
        false,
        { bytes: 9000, tokens: 600 },
      ),
    ).toBe(ALLOW_LARGE_FITS_MESSAGE)
  })

  test('not opted in + exceeds raised bytes → Bgo', () => {
    expect(
      selectAllowLargeMessage(
        { roomTokens: 5000, raised: { maxTokens: 600, maxSizeBytes: 9000 } },
        false,
        { bytes: 9001 },
      ),
    ).toBe(ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE)
  })

  test('not opted in + exceeds raised tokens → Bgo', () => {
    expect(
      selectAllowLargeMessage(
        { roomTokens: 5000, raised: { maxTokens: 600, maxSizeBytes: 9000 } },
        false,
        { tokens: 601 },
      ),
    ).toBe(ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE)
  })
})

// ── lOr: room computation ──

describe('computeAllowLargeRoom (official lOr @219148327)', () => {
  const base = { maxSizeBytes: 1000, maxTokens: 100 }

  function contextWithRoom(room: FakeRoom | undefined) {
    return {
      options: { mainLoopModel: 'claude-opus-5' },
      contextRoom: room === undefined ? undefined : () => room,
    } as never
  }

  test('no contextRoom on the context → room unavailable', () => {
    const ctx = { options: { mainLoopModel: 'claude-opus-5' } } as never
    expect(computeAllowLargeRoom(ctx, undefined, base)).toEqual({
      roomTokens: undefined,
      raised: undefined,
    })
  })

  test('contextRoom() returns undefined → room unavailable', () => {
    expect(
      computeAllowLargeRoom(contextWithRoom(undefined), undefined, base),
    ).toEqual({ roomTokens: undefined, raised: undefined })
  })

  test('room fits under base maxTokens → no raise', () => {
    // w = max(0, 200) + 0 = 200; H = floor((300-200)*0.7) = 70 ≤ 100
    const result = computeAllowLargeRoom(
      contextWithRoom(makeRoom(300, 200, 0)),
      undefined,
      base,
    )
    expect(result).toEqual({ roomTokens: 70, raised: undefined })
  })

  test('room above base maxTokens → raised limits with 3× bytes-per-token', () => {
    // w = max(0,200)+50 = 250; H = floor((1000-250)*0.7) = 525 > 100
    // opus-5 bytesPerToken = 3 → maxSizeBytes = max(1000, 525*3*3) = 4725
    const result = computeAllowLargeRoom(
      contextWithRoom(makeRoom(1000, 200, 50)),
      undefined,
      base,
    )
    expect(result).toEqual({
      roomTokens: 525,
      raised: { maxTokens: 525, maxSizeBytes: 4725 },
    })
  })

  test('parentMessage usage dominates held()', () => {
    // usage input sum 600 > 0 → S = 600+50 = 650 > held 200
    // H = floor((2000-650)*0.7) = floor(944.9999999999999) = 944 (IEEE —
    // the official runs the identical float op); maxSizeBytes = 944*9 = 8496
    const parentMessage = {
      message: {
        usage: {
          input_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
      },
    } as never
    const result = computeAllowLargeRoom(
      contextWithRoom(makeRoom(2000, 200, 0)),
      parentMessage,
      base,
    )
    expect(result).toEqual({
      roomTokens: 944,
      raised: { maxTokens: 944, maxSizeBytes: 8496 },
    })
  })

  test('negative room floors at zero', () => {
    expect(
      computeAllowLargeRoom(
        contextWithRoom(makeRoom(100, 500, 0)),
        undefined,
        base,
      ),
    ).toEqual({ roomTokens: 0, raised: undefined })
  })

  test('claimed tokens shrink the room', () => {
    // w = max(0,0)+300; H = floor((1000-300)*0.7) = floor(489.999...) = 489
    // (IEEE — identical float op in the official binary)
    const result = computeAllowLargeRoom(
      contextWithRoom(makeRoom(1000, 0, 300)),
      undefined,
      base,
    )
    expect(result.roomTokens).toBe(489)
    expect(result.raised).toEqual({
      maxTokens: 489,
      maxSizeBytes: Math.max(1000, 489 * 3 * 3),
    })
  })
})

// ── _hn: error transformer ──

describe('transformReadError (official _hn @219149198)', () => {
  const fitsRoom = {
    roomTokens: 5000,
    raised: { maxTokens: 600, maxSizeBytes: 10_000_000 },
  }

  test('FileTooLargeError with matching maxSizeBytes gets suffix + telemetry', () => {
    const original = new FileTooLargeError(5000, 1000)
    const room = { roomTokens: 10, raised: { maxTokens: 20, maxSizeBytes: 999 } }
    const result = transformReadError(original, {
      room: () => room,
      optedIn: true,
      readMaxSizeBytes: 1000,
      ext: 'txt',
    })
    expect(result).toBeInstanceOf(FileTooLargeError)
    expect(result).not.toBe(original)
    const err = result as FileTooLargeError
    expect(err.sizeInBytes).toBe(5000)
    expect(err.maxSizeBytes).toBe(1000)
    // bytes 5000 > raised 999 → Bgo
    expect(err.message.endsWith(ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE)).toBe(true)
    expect(allowLargeEvents()).toEqual([
      {
        eventName: 'tengu_file_read_allow_large',
        metadata: {
          outcome: 'too_large',
          lifted: true,
          roomTokens: 10,
          totalBytes: 5000,
          ext: 'txt',
        },
      },
    ])
  })

  test('FileTooLargeError with mismatched maxSizeBytes passes through', () => {
    const original = new FileTooLargeError(5000, 1000)
    const result = transformReadError(original, {
      room: () => fitsRoom,
      optedIn: true,
      readMaxSizeBytes: 2000,
      ext: 'txt',
    })
    expect(result).toBe(original)
    expect(allowLargeEvents()).toEqual([])
  })

  test('opted-out error still gets the Aws discovery suffix, no telemetry', () => {
    const original = new FileTooLargeError(5000, 1000)
    const result = transformReadError(original, {
      room: () => fitsRoom,
      optedIn: false,
      readMaxSizeBytes: 1000,
    })
    expect((result as FileTooLargeError).message.endsWith(ALLOW_LARGE_FITS_MESSAGE)).toBe(
      true,
    )
    expect(allowLargeEvents()).toEqual([])
  })

  test('opted-in without room → Cws suffix + unavailable telemetry, no roomTokens key', () => {
    const original = new SelectedRangeTooLargeError(2000, 1000)
    const result = transformReadError(original, {
      room: () => ({ roomTokens: undefined, raised: undefined }),
      optedIn: true,
      readMaxSizeBytes: 1000,
    })
    expect(result).toBeInstanceOf(SelectedRangeTooLargeError)
    expect(
      (result as SelectedRangeTooLargeError).message.endsWith(
        ALLOW_LARGE_UNAVAILABLE_MESSAGE,
      ),
    ).toBe(true)
    const [event] = allowLargeEvents()
    expect(event?.metadata).toEqual({
      outcome: 'unavailable',
      lifted: false,
      totalBytes: 2000,
    })
    expect(event?.metadata).not.toHaveProperty('roomTokens')
  })

  test('MaxFileReadTokenExceededError gets tokens-based suffix', () => {
    const original = new MaxFileReadTokenExceededError(500, 100)
    const result = transformReadError(original, {
      room: () => fitsRoom,
      optedIn: true,
      readMaxSizeBytes: 1000,
    })
    expect(result).toBeInstanceOf(MaxFileReadTokenExceededError)
    // Opted-in reads ALWAYS get Bgo (official Ave: `if(n||e.raised===void 0)
    // return Bgo` — the caps were already raised and it STILL overflowed).
    expect(
      (result as MaxFileReadTokenExceededError).message.endsWith(
        ALLOW_LARGE_EXCEEDS_ROOM_MESSAGE,
      ),
    ).toBe(true)
    expect(allowLargeEvents()[0]?.metadata).toEqual(
      expect.objectContaining({
        outcome: 'too_large',
        lifted: true,
        roomTokens: 5000,
        tokens: 500,
      }),
    )
  })

  test('unrelated errors pass through untouched', () => {
    const original = new Error('boom')
    expect(
      transformReadError(original, {
        room: () => fitsRoom,
        optedIn: true,
        readMaxSizeBytes: 1000,
      }),
    ).toBe(original)
    expect(allowLargeEvents()).toEqual([])
  })
})

// ── khn: token counter ──

describe('countReadTokensForRead (official khn @219149776)', () => {
  test('small estimate returns without an API roundtrip', async () => {
    roughOverride = () => 10
    await expect(
      countReadTokensForRead('content', 'ts', 100, false, false),
    ).resolves.toBe(10)
    expect(apiCalls).toEqual([])
  })

  test('zero estimate returns undefined', async () => {
    roughOverride = () => 0
    await expect(
      countReadTokensForRead('', 'ts', 100, false, false),
    ).resolves.toBeUndefined()
  })

  test('non-whole read over the length ratio pre-throws with the rough count', async () => {
    roughOverride = () => 5000
    const content = 'x'.repeat(128 * 100 + 1) // > cap*128
    const promise = countReadTokensForRead(content, 'ts', 100, false, false)
    await expect(promise).rejects.toBeInstanceOf(
      MaxFileReadTokenExceededError,
    )
    await promise.catch((err: MaxFileReadTokenExceededError) => {
      expect(err.tokenCount).toBe(5000)
      expect(err.maxTokens).toBe(100)
    })
    expect(apiCalls).toEqual([])
  })

  test('whole-file read skips the length pre-throw and uses the API count', async () => {
    roughOverride = () => 5000
    apiOverride = async () => 50
    const content = 'x'.repeat(128 * 100 + 1)
    await expect(
      countReadTokensForRead(content, 'ts', 100, true, false),
    ).resolves.toBe(50)
    expect(apiCalls.length).toBe(1)
  })

  test('API count over the cap throws', async () => {
    roughOverride = () => 50
    apiOverride = async () => 200
    const promise = countReadTokensForRead('x'.repeat(400), 'ts', 100, true, false)
    await expect(promise).rejects.toBeInstanceOf(
      MaxFileReadTokenExceededError,
    )
    await promise.catch((err: MaxFileReadTokenExceededError) => {
      expect(err.tokenCount).toBe(200)
      expect(err.maxTokens).toBe(100)
    })
  })

  test('API null falls back to the estimate', async () => {
    roughOverride = () => 50
    apiOverride = async () => null
    await expect(
      countReadTokensForRead('x'.repeat(400), 'ts', 100, true, false),
    ).resolves.toBe(50)
  })

  test('raised floor: max(rough, ceil(bytes/2))', async () => {
    roughOverride = () => 100
    const content = 'x'.repeat(1000) // byteLength 1000 → ceil(1000/2) = 500
    await expect(
      countReadTokensForRead(content, 'ts', 10000, true, true),
    ).resolves.toBe(500)
    await expect(
      countReadTokensForRead(content, 'ts', 10000, true, false),
    ).resolves.toBe(100)
    expect(apiCalls).toEqual([])
  })

  test('maxTokens defaults to the standard reading limits', async () => {
    roughOverride = () => 10
    await expect(
      countReadTokensForRead('content', 'ts', undefined, false, false),
    ).resolves.toBe(10)
  })
})

// ── dOr catch branch: token-cap partial view ──

describe('buildTokenCapPartialView (official dOr catch @219156400)', () => {
  const baseOpts = {
    filePath: '/f/big.txt',
    baseMaxTokens: 100,
    errorMaxTokens: 100,
    raisedMaxTokens: undefined,
    room: { roomTokens: undefined, raised: undefined },
    optedIn: false,
  }

  test('line-mode pagination math and notice', () => {
    // Hn = 39999/10000 ≈ 3.9999; Eo = floor(1000*100/10000*0.85) = 8;
    // shown = 8*39+7 = 319 chars → ao ≈ 79.75 ≤ 100 → keep.
    const view = buildTokenCapPartialView({
      ...baseOpts,
      content: FIXTURE_CONTENT,
      tokenCount: 10000,
      totalLines: 1000,
    })
    expect(view.charMode).toBe(false)
    expect(view.shownLines).toBe(8)
    expect(view.content).toBe(
      Array.from({ length: 8 }, () => LINE).join('\n'),
    )
    expect(view.notice).toBe(
      `${PARTIAL_VIEW_PREFIX}/f/big.txt: showing lines 1-8 of 1000 total (10000 tokens, cap 100). Call Read with offset=9 limit=8 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]`,
    )
  })

  test('raised cap label replaces the base cap', () => {
    const view = buildTokenCapPartialView({
      ...baseOpts,
      raisedMaxTokens: 500,
      errorMaxTokens: 600,
      content: FIXTURE_CONTENT,
      tokenCount: 10000,
      totalLines: 1000,
    })
    expect(view.notice).toContain(
      'allow_large had room for 600 tokens this turn',
    )
    expect(view.notice).not.toContain('cap 100')
  })

  test('opted-in suffix is appended inside the notice', () => {
    const view = buildTokenCapPartialView({
      ...baseOpts,
      room: { roomTokens: 10, raised: undefined },
      optedIn: true,
      content: FIXTURE_CONTENT,
      tokenCount: 10000,
      totalLines: 1000,
    })
    expect(view.notice).toContain(
      'Even with allow_large, this is more than fits in the context you have left this turn',
    )
  })

  test('single huge line → char-mode excerpt', () => {
    const content = 'x'.repeat(50000)
    // Hn = 5; line loop pinned at Eo=1 → ao = 10000 > 100 → char mode;
    // fo = floor(100*5*0.85) = 425 → ao = 85 ≤ 100.
    const view = buildTokenCapPartialView({
      ...baseOpts,
      content,
      tokenCount: 10000,
      totalLines: 1,
    })
    expect(view.charMode).toBe(true)
    expect(view.content.length).toBe(425)
    expect(view.shownLines).toBe(1)
    expect(view.notice).toContain(
      'showing the first 425 of 50000 characters (10000 tokens, cap 100)',
    )
    expect(view.notice).toContain(
      'this file has very long lines and cannot be paginated by line',
    )
  })

  test('char-mode cut ending on a high surrogate strips it', () => {
    const content =
      'x'.repeat(424) + '\uD83D' + '\uDE00' + 'x'.repeat(50000 - 426)
    const view = buildTokenCapPartialView({
      ...baseOpts,
      content,
      tokenCount: 10000,
      totalLines: 1,
    })
    expect(view.charMode).toBe(true)
    expect(view.content.length).toBe(424)
    expect(view.notice).toContain('showing the first 424 of 50000 characters')
  })

  test('uneven lines exhaust the line-shrink loop and fall to char mode', () => {
    // line0 = 10000 chars, 999 empty lines → Hn = 10999/10000 = 1.0999;
    // Eo starts 8 but every prefix ≈ 10000 chars → ao ≈ 9098 > 100 down to
    // Eo=1 → char mode: fo = floor(100*1.0999*0.85) = 93 → ao ≈ 84.6 ≤ 100.
    const content = ['x'.repeat(10000), ...Array(999).fill('')].join('\n')
    const view = buildTokenCapPartialView({
      ...baseOpts,
      content,
      tokenCount: 10000,
      totalLines: 1000,
    })
    expect(view.charMode).toBe(true)
    expect(view.content.length).toBe(93)
    expect(view.shownLines).toBe(1)
    expect(view.notice).toContain(
      'showing the first 93 of 10999 characters (10000 tokens, cap 100)',
    )
  })

  test('countNewlines', () => {
    expect(countNewlines('a\nb\nc')).toBe(2)
    expect(countNewlines('abc')).toBe(0)
    expect(countNewlines('')).toBe(0)
  })
})

// ── Error-class suffix args (official r0e/LVe/$de 3rd ctor param) ──

describe('read-error classes accept an allow_large suffix', () => {
  test('FileTooLargeError appends the suffix', () => {
    const err = new FileTooLargeError(2048, 1024, ' SUFFIX.')
    expect(err.message.endsWith(' SUFFIX.')).toBe(true)
    expect(err.message).toContain('File content (2KB)')
    expect(err.sizeInBytes).toBe(2048)
    expect(err.maxSizeBytes).toBe(1024)
  })

  test('SelectedRangeTooLargeError appends the suffix', () => {
    const err = new SelectedRangeTooLargeError(4096, 2048, ' SUFFIX.')
    expect(err.message.endsWith(' SUFFIX.')).toBe(true)
    expect(err.selectedBytes).toBe(4096)
    expect(err.maxSelectedBytes).toBe(2048)
  })

  test('MaxFileReadTokenExceededError appends the suffix', () => {
    const err = new MaxFileReadTokenExceededError(500, 100, ' SUFFIX.')
    expect(err.message.endsWith(' SUFFIX.')).toBe(true)
    expect(err.message).toContain('exceeds maximum allowed tokens (100)')
    expect(err.tokenCount).toBe(500)
    expect(err.maxTokens).toBe(100)
  })

  test('suffix defaults to empty — legacy messages unchanged', () => {
    const err = new FileTooLargeError(2048, 1024)
    expect(err.message.endsWith('instead of reading the whole file.')).toBe(
      true,
    )
  })
})

// ── Schema surface ──

describe('Read tool schema: allow_large (official $w(M().optional()) @219133376)', () => {
  test('accepts boolean and "true"/"false" strings via semanticBoolean', () => {
    const parse = (v: unknown) =>
      FileReadTool.inputSchema.safeParse({ file_path: '/x', allow_large: v })
    expect(parse(true)).toMatchObject({
      success: true,
      data: { allow_large: true },
    })
    expect(parse('true')).toMatchObject({
      success: true,
      data: { allow_large: true },
    })
    expect(parse('false')).toMatchObject({
      success: true,
      data: { allow_large: false },
    })
    const omitted = FileReadTool.inputSchema.safeParse({ file_path: '/x' })
    expect(omitted.success).toBe(true)
    expect(parse('yes').success).toBe(false)
  })

  test('field order: allow_large comes after pages', () => {
    expect(Object.keys(FileReadTool.inputSchema.shape)).toEqual([
      'file_path',
      'offset',
      'limit',
      'pages',
      'allow_large',
    ])
  })

  test('describe text is byte-exact', () => {
    const field = FileReadTool.inputSchema.shape.allow_large as unknown as {
      description?: string
    }
    expect(field.description).toBe(
      'Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context. Only use this when you genuinely need all of it or the user asked for the whole file; otherwise read it in parts with offset and limit, or search it.',
    )
  })
})

// ── Integration through FileReadTool.call ──

describe('FileReadTool.call allow_large integration (official nOr/dOr)', () => {
  test('scenario A: unopted full read over the cap paginates to a partial view', async () => {
    roughOverride = content => Math.floor(content.length / 4)
    apiOverride = async () => 10000
    const context = makeContext({
      fileReadingLimits: { maxTokens: 100, maxSizeBytes: 1_000_000 },
    })

    const result = await callRead(bigFile, {}, context)
    expect(result.data.type).toBe('text')
    if (result.data.type !== 'text') throw new Error('unreachable')

    const expectedPage = Array.from({ length: 8 }, () => LINE).join('\n')
    expect(result.data.file.content).toBe(expectedPage)
    expect(result.data.file.numLines).toBe(8)
    expect(result.data.file.startLine).toBe(1)
    expect(result.data.file.totalLines).toBe(1000)
    expect(result.data.file.truncatedByTokenCap).toBe(true)

    // readFileState stores the RAW truncated content (official be.set) — no
    // notice prepend — with limit = shown lines and isPartialView.
    const state = context.readFileState.get(bigFile) as {
      content: string
      offset: number
      limit: number | undefined
      isPartialView?: boolean
    }
    expect(state.content).toBe(expectedPage)
    expect(state.content).not.toContain('<system-reminder>')
    expect(state.offset).toBe(1)
    expect(state.limit).toBe(8)
    expect(state.isPartialView).toBe(true)

    // The notice reaches the model through the mapper prepend channel.
    const mapped = FileReadTool.mapToolResultToToolResultBlockParam(
      result.data,
      'tu_scenario_a',
    ) as { content: string }
    expect(mapped.content.startsWith('<system-reminder>')).toBe(true)
    expect(mapped.content).toContain(
      `${PARTIAL_VIEW_PREFIX}${bigFile}: showing lines 1-8 of 1000 total (10000 tokens, cap 100)`,
    )
    expect(mapped.content).toContain(
      'Call Read with offset=9 limit=8 for the next page',
    )
    // Unopted read with no room → no allow_large suffix in the notice.
    expect(mapped.content).not.toContain('allow_large')

    // Telemetry: paged read metrics; NO allow_large event.
    const [sessionEvent] = sessionReadEvents()
    expect(sessionEvent?.metadata).toEqual(
      expect.objectContaining({
        totalLines: 1000,
        readLines: 8,
        readBytes: Buffer.byteLength(expectedPage, 'utf8'),
        truncatedByTokenCap: true,
        offset: 1,
      }),
    )
    expect(sessionEvent?.metadata).not.toHaveProperty('allow_large')
    expect(allowLargeEvents()).toEqual([])
  })

  test('scenario B: allow_large with room lifts the caps, claims tokens, logs fit', async () => {
    roughOverride = content => Math.floor(content.length / 4)
    apiOverride = async () => {
      throw new Error('count API must not be called when the estimate fits')
    }
    const claimCalls: number[] = []
    const room = makeRoom(1_000_000, 0, 0, claimCalls)
    const context = makeContext({
      fileReadingLimits: { maxTokens: 100, maxSizeBytes: 20_000 },
      contextRoom: () => room,
    })

    const result = await callRead(bigFile, { allow_large: true }, context)
    expect(result.data.type).toBe('text')
    if (result.data.type !== 'text') throw new Error('unreachable')

    // roomTokens = floor(1e6*0.7) = 700000 > 100 → raised
    // {maxTokens: 700000, maxSizeBytes: max(20000, 700000*3*3)} — the
    // 39999-byte file passes the raised byte cap and the whole content lands.
    expect(result.data.file.content).toBe(FIXTURE_CONTENT)
    expect(result.data.file.numLines).toBe(1000)
    expect(result.data.file.truncatedByTokenCap).toBeUndefined()

    const state = context.readFileState.get(bigFile) as {
      limit: number | undefined
      isPartialView?: boolean
    }
    expect(state.limit).toBeUndefined()
    expect(state.isPartialView).toBeUndefined()

    // Tokens claimed against the turn room (khn raised-floor estimate of the
    // line-numbered content — assert consistency, not the exact format).
    expect(claimCalls.length).toBe(1)
    expect(claimCalls[0]).toBeGreaterThan(0)

    const [fitEvent] = allowLargeEvents()
    expect(fitEvent?.metadata).toEqual(
      expect.objectContaining({
        outcome: 'fit',
        lifted: true,
        roomTokens: 700000,
        totalBytes: 39999,
        totalLines: 1000,
        readLines: 1000,
        tokens: claimCalls[0],
        ext: 'txt',
      }),
    )
    const [sessionEvent] = sessionReadEvents()
    expect(sessionEvent?.metadata).toEqual(
      expect.objectContaining({ allow_large: true, readLines: 1000 }),
    )
    expect(sessionEvent?.metadata).not.toHaveProperty('truncatedByTokenCap')
  })

  test('scenario C: allow_large without room → unavailable suffix + telemetry', async () => {
    const context = makeContext({
      fileReadingLimits: { maxTokens: 100, maxSizeBytes: 1000 },
    })

    let caught: unknown
    try {
      await callRead(bigFile, { allow_large: true }, context)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FileTooLargeError)
    const err = caught as FileTooLargeError
    expect(err.sizeInBytes).toBe(39999)
    expect(err.maxSizeBytes).toBe(1000)
    expect(err.message.endsWith(ALLOW_LARGE_UNAVAILABLE_MESSAGE)).toBe(true)

    const [event] = allowLargeEvents()
    expect(event?.metadata).toEqual({
      outcome: 'unavailable',
      lifted: false,
      totalBytes: 39999,
      ext: 'txt',
    })
  })

  test('scenario D: unopted oversize error advertises allow_large when room exists', async () => {
    const claimCalls: number[] = []
    const room = makeRoom(1_000_000, 0, 0, claimCalls)
    const context = makeContext({
      fileReadingLimits: { maxTokens: 100, maxSizeBytes: 1000 },
      contextRoom: () => room,
    })

    let caught: unknown
    try {
      await callRead(bigFile, {}, context)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FileTooLargeError)
    // No allow_large in the input → optedIn false, room raised and the file
    // fits the raised caps → Aws discovery suffix, NO telemetry event.
    expect(
      (caught as FileTooLargeError).message.endsWith(ALLOW_LARGE_FITS_MESSAGE),
    ).toBe(true)
    expect(allowLargeEvents()).toEqual([])
  })
})
