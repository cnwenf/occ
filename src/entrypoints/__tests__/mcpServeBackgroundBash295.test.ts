import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.295 — `claude mcp serve` background Bash results + description.
 *
 * Official 2.1.295 forensics (linux-x64 binary strings, /tmp/cc295/s295.txt;
 * every quoted snippet verified absent from s294.txt = new in 2.1.295):
 *
 *   // serve factory startup (`y` = http; stdio `mcp serve` takes the else):
 *   Y.disableBackgroundAgentLaunch(),Y.disableRemoteAgentIsolation(),
 *   Y.disableBackgroundDeadline(),y?xIr(Sw()):Y.disableBackgroundCompletionNotice()
 *
 *   // the gate + the serve-mode sentence:
 *   function Ole(){return!Sw().backgroundCompletionNoticeDisabled}
 *   var sYt="Nothing notifies you when the command finishes: read the output
 *     file that the result names to check on it. The file gets no line when
 *     the command ends, so if you need to know that it has, end the command
 *     with an `echo` of your own."
 *
 *   // raw (stdio) serve tool-result serialization — NO mapper call; the
 *   // interactive mapToolResultToToolResultBlockParam texts never reach
 *   // raw-serve clients. `ku` ≡ getTaskOutputPath, `_` ≡ jsonStringify:
 *   let o=j.data,b=typeof o==="object"&&o!==null&&"backgroundTaskId"in o
 *     &&typeof o.backgroundTaskId==="string"
 *     ?{...o,backgroundOutputPath:ku(o.backgroundTaskId)}:o;
 *   A={content:[{type:"text",text:_(b)}]}
 *
 *   // serve Bash background note (fxt()): "Only use this if you don't need
 *   // the result immediately. ${sYt} You do not need to use '&' ..." — no
 *   // notification promise, no backgroundTimeoutUsageNote() suffix; the
 *   // Ole()-gated sleep bullets (Monitor + both notification promises) are
 *   // dropped from the served description.
 *
 * These tests drive the REAL serve path end-to-end (real MCP SDK Server +
 * real Client over an InMemoryTransport linked pair — only the stdio
 * transport class is swapped), plus pure-helper unit tests for the two
 * exported transforms in ../mcp.ts.
 */

// ---------------------------------------------------------------------------
// Module mocks (installed before ../mcp.js is imported).
// ---------------------------------------------------------------------------

// The serve entrypoint hardcodes StdioServerTransport; swap it for one end of
// an in-memory linked pair so a real MCP Client can talk to the server.
let activeServerTransport: InMemoryTransport | undefined
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {
    constructor() {
      // Returning an object from a constructor overrides `new` — the Server
      // receives the linked in-memory transport instance directly.
      // biome-ignore lint/correctness/noConstructorReturn: deliberate `new`-override to inject the in-memory transport into the entrypoint's hardcoded StdioServerTransport construction.
      return activeServerTransport as unknown as MockStdioServerTransport
    }
  },
}))

// MACRO is a build-time macro (bun build) with a dev polyfill in cli.tsx;
// tests that drive an entrypoint directly need the same polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '2.1.295-test',
    BINARY_NAME: 'occ',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '@cnwenf/occ',
    VERSION_CHANGELOG: '',
  }
}

const { startMCPServer, serializeServeToolResultData, toServeModeBashDescription } =
  await import('../mcp.js')
const { getTaskOutputPath } = await import('../../utils/task/diskOutput.js')
const { backgroundTimeoutUsageNote } = await import(
  '../../tasks/LocalShellTask/backgroundDeadline.js'
)
const { getIsInteractive, setIsInteractive } = await import(
  '../../bootstrap/state.js'
)

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Official `sYt` — verbatim serve-mode background-completion sentence. */
const SYT =
  'Nothing notifies you when the command finishes: read the output file that the result names to check on it. The file gets no line when the command ends, so if you need to know that it has, end the command with an `echo` of your own.'

/**
 * The interactive Bash background usage note, verbatim from
 * BashTool/prompt.ts getBackgroundUsageNote() (deadline suffix omitted —
 * empty in an interactive/attended session).
 */
const INTERACTIVE_NOTE =
  "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter."

/** The three Ole()-gated sleep bullets dropped from the served description. */
const MONITOR_BULLET =
  'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.'
const LONG_RUNNING_BULLET =
  'If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.'
const DO_NOT_POLL_BULLET =
  'If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.'
/** Kept: OCC's serve validateInput still blocks long leading sleeps. */
const SLEEP_BLOCKED_BULLET =
  '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.'

let tempRoot: string
let configDir: string
let savedConfigDirEnv: string | undefined
let savedNodeEnv: string | undefined

async function startServe(cwd: string): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  activeServerTransport = serverTransport
  const serveReady = startMCPServer(cwd, false, false)
  const client = new Client({ name: 'occ-mcp-serve-295-test', version: '1.0.0' })
  await serveReady
  await client.connect(clientTransport)
  return client
}

// `unknown` parameter (not `{ content: unknown }`): the MCP SDK's callTool
// return type carries an index signature that is not assignable to a narrower
// structural parameter under this repo's loose tsconfig.
function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content
  return content?.[0]?.text ?? ''
}

async function getBashToolDescription(client: Client): Promise<string> {
  const { tools } = await client.listTools()
  const bashTool = tools.find(t => t.name === 'Bash')
  expect(bashTool).toBeDefined()
  return bashTool?.description ?? ''
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'occ-mcp-serve-295-'))
  configDir = join(tempRoot, 'config')
  await mkdir(join(configDir, 'agents'), { recursive: true })

  savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
  savedNodeEnv = process.env.NODE_ENV
  // Fresh temp config home so the serve path never reads real-machine state.
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.NODE_ENV = 'test'
})

afterAll(async () => {
  if (savedConfigDirEnv === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv
  }
  if (savedNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = savedNodeEnv
  }
  mock.restore()
  await rm(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Unit: serializeServeToolResultData (official raw-serve serialization)
// ---------------------------------------------------------------------------

describe('serializeServeToolResultData — official 2.1.295 raw-serve result serialization', () => {
  test('enriches background task data with backgroundOutputPath = getTaskOutputPath(backgroundTaskId)', () => {
    // Arrange — the official BashTool background result data shape.
    const data = {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: 'bg-task-295',
    }
    const snapshot = { ...data }

    // Act
    const parsed = JSON.parse(serializeServeToolResultData(data)) as Record<
      string,
      unknown
    >

    // Assert — official `{...o, backgroundOutputPath: ku(o.backgroundTaskId)}`.
    expect(parsed).toEqual({
      ...snapshot,
      backgroundOutputPath: getTaskOutputPath('bg-task-295'),
    })
    // Immutable: the input object is never mutated.
    expect(data).toEqual(snapshot)
  })

  test('serializes non-background result data plain, without backgroundOutputPath', () => {
    // Arrange — a foreground Bash result shape (no backgroundTaskId).
    const data = { stdout: 'hello\n', stderr: '', code: 0, interrupted: false }

    // Act
    const serialized = serializeServeToolResultData(data)

    // Assert
    expect(JSON.parse(serialized)).toEqual(data)
    expect(serialized).not.toContain('backgroundOutputPath')
  })

  test('does not enrich when backgroundTaskId is not a string', () => {
    // Arrange — official predicate requires `typeof o.backgroundTaskId==="string"`.
    const data = { backgroundTaskId: 42, stdout: '' }

    // Act
    const serialized = serializeServeToolResultData(data)

    // Assert
    expect(serialized).not.toContain('backgroundOutputPath')
    expect(JSON.parse(serialized)).toEqual(data)
  })

  test('passes null, primitives and arrays through jsonStringify safely', () => {
    // Arrange / Act / Assert — the official guard (`typeof o==="object"&&o!==null`)
    // means none of these take the enrichment branch.
    expect(serializeServeToolResultData(null)).toBe('null')
    expect(serializeServeToolResultData(7)).toBe('7')
    expect(serializeServeToolResultData('str')).toBe('"str"')
    expect(JSON.parse(serializeServeToolResultData([1, 2]))).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// Unit: toServeModeBashDescription (official Ole()-gated serve description)
// ---------------------------------------------------------------------------

describe('toServeModeBashDescription — official 2.1.295 serve description gating', () => {
  test('replaces the interactive notification promise with the official sYt sentence', () => {
    // Act
    const out = toServeModeBashDescription(INTERACTIVE_NOTE)

    // Assert — official serve fxt(): "Only use this if you don't need the
    // result immediately. ${sYt} You do not need to use '&' ...".
    expect(out).toContain(SYT)
    expect(out).toContain(
      "Only use this if you don't need the result immediately.",
    )
    expect(out).not.toContain(
      'are OK being notified when the command completes later',
    )
    expect(out).not.toContain("you'll be notified when it finishes")
    expect(
      out.startsWith(
        'You can use the `run_in_background` parameter to run the command in the background.',
      ),
    ).toBe(true)
    expect(
      out.endsWith(
        "You do not need to use '&' at the end of the command when using this parameter.",
      ),
    ).toBe(true)
  })

  test('drops the three notification-promise sleep bullets and keeps the rest', () => {
    // Arrange — prependBullets rendering: nested sub-items get a `  - ` prefix.
    const description = [
      ' - Avoid unnecessary `sleep` commands:',
      `  - Do not sleep between commands that can run immediately — just run them.`,
      `  - ${MONITOR_BULLET}`,
      `  - ${LONG_RUNNING_BULLET}`,
      '  - Do not retry failing commands in a sleep loop — diagnose the root cause.',
      `  - ${DO_NOT_POLL_BULLET}`,
      `  - ${SLEEP_BLOCKED_BULLET}`,
    ].join('\n')

    // Act
    const out = toServeModeBashDescription(description)

    // Assert — the Ole()-gated bullets are gone ...
    expect(out).not.toContain('Use the Monitor tool to stream events')
    expect(out).not.toContain('you would like to be notified when it finishes')
    expect(out).not.toContain('do not poll')
    // ... the kept bullets survive (OCC serve still blocks long leading sleeps).
    expect(out).toContain(
      'Do not sleep between commands that can run immediately',
    )
    expect(out).toContain('Do not retry failing commands in a sleep loop')
    expect(out).toContain(SLEEP_BLOCKED_BULLET)
    expect(out.split('\n')).toHaveLength(4)
  })

  test('strips the background-deadline usage suffix when the deadline is enabled (official serve fxt() has none)', () => {
    // Arrange — force the unattended session so backgroundTimeoutUsageNote()
    // returns the real deadline sentence (official serve runs with
    // disableBackgroundDeadline(); its note never appears in serve).
    const savedInteractive = getIsInteractive()
    setIsInteractive(false)
    try {
      const note = backgroundTimeoutUsageNote()
      expect(note).not.toBe('')

      // Act
      const out = toServeModeBashDescription(INTERACTIVE_NOTE + note)

      // Assert
      expect(out).not.toContain('the timeout is instead how long')
      expect(out).toContain(SYT)
    } finally {
      setIsInteractive(savedInteractive)
    }
  })

  test('leaves unrelated text unchanged and is idempotent', () => {
    // Arrange
    const unrelated =
      'Some other tool description\n - with a bullet mentioning run_in_background in passing.'

    // Act
    const once = toServeModeBashDescription(INTERACTIVE_NOTE)
    const twice = toServeModeBashDescription(once)

    // Assert
    expect(toServeModeBashDescription(unrelated)).toBe(unrelated)
    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// E2E: the real `mcp serve` ListTools / CallTool path
// ---------------------------------------------------------------------------

describe('mcp serve e2e — 2.1.295 background Bash surface', () => {
  test('served Bash description carries the official sYt note and no notification promises', async () => {
    // Arrange
    const cwd = await mkdtemp(join(tempRoot, 'cwd-desc-'))
    const client = await startServe(cwd)
    try {
      // Act
      const description = await getBashToolDescription(client)

      // Assert — official serve gating applied to the interactive prompt.
      expect(description).toContain(SYT)
      expect(description).not.toContain(
        'are OK being notified when the command completes later',
      )
      expect(description).not.toContain("you'll be notified when it finishes")
      expect(description).not.toContain('Use the Monitor tool to stream events')
      expect(description).not.toContain(
        'you would like to be notified when it finishes',
      )
      expect(description).not.toContain('do not poll')
      // Kept — OCC's serve validateInput still blocks long leading sleeps
      // (the official's Ole() gate there lives in BashTool — staged).
      expect(description).toContain(SLEEP_BLOCKED_BULLET)
      // The deadline suffix never reaches the served description.
      expect(description).not.toContain('the timeout is instead how long')
    } finally {
      await client.close()
    }
  })

  test('foreground Bash result serializes plain, without backgroundOutputPath', async () => {
    // Arrange
    const cwd = await mkdtemp(join(tempRoot, 'cwd-fg-'))
    const client = await startServe(cwd)
    try {
      // Act
      const result = await client.callTool({
        name: 'Bash',
        arguments: { command: 'echo occ-serve-295-fg' },
      })

      // Assert
      expect(result.isError).toBeFalsy()
      const text = firstText(result)
      expect(text).toContain('occ-serve-295-fg')
      const parsed = JSON.parse(text) as Record<string, unknown>
      expect(parsed.backgroundOutputPath).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  test('background Bash result includes backgroundTaskId and the enriched backgroundOutputPath', async () => {
    // Arrange
    const cwd = await mkdtemp(join(tempRoot, 'cwd-bg-'))
    const client = await startServe(cwd)
    try {
      // Act
      const result = await client.callTool({
        name: 'Bash',
        arguments: {
          command: 'echo occ-serve-295-bg',
          run_in_background: true,
        },
      })

      // Assert — official raw-serve enrichment over the BashTool final data
      // shape (Out: stdout/stderr/interrupted/backgroundTaskId/…).
      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(firstText(result)) as Record<string, unknown>
      expect(typeof parsed.backgroundTaskId).toBe('string')
      expect(parsed.backgroundOutputPath).toBe(
        getTaskOutputPath(parsed.backgroundTaskId as string),
      )
      expect(parsed.stdout).toBe('')
      expect(parsed.interrupted).toBe(false)
    } finally {
      await client.close()
    }
  })
})
