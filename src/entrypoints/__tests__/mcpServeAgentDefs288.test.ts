import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'

/**
 * CC 2.1.288 changelog #62: "Fixed the Agent tool in `claude mcp serve`
 * always reporting no available agents and rejecting every subagent_type."
 *
 * Official v288 forensics (binary @240458756, verified via strings/dd):
 *   let N={activeAgents:[],allAgents:[]},
 *       L=_?Promise.resolve():pC(oe(),s).then((o)=>{
 *         N=Une(o,o.allAgents.filter((T)=>{if(zce(T))return!0;
 *           return Gye(T,"subagent","definition"),!1}))}).catch((o)=>{c(o)})
 *   - ListTools handler: `await L` then builds tools with
 *     `{agentDefinitions:N}`; the tool-builder passes `agents:N.activeAgents`
 *     into every `tool.prompt(...)`.
 *   - CallTool handler: `await L` then threads `agentDefinitions:N` into the
 *     tool-use context options.
 *   - `zce` = definition-usable (folder-trust) predicate — OCC mirror:
 *     `isAgentHooksOriginTrusted`; `Une(o,filtered)` = `{...o,
 *     allAgents:filtered, activeAgents:getActiveAgentsFromList(filtered)}`.
 *
 * v287 (@239047744) hardcoded `agents:[]` and
 * `agentDefinitions:{activeAgents:[],allAgents:[]}` — the exact pattern OCC's
 * src/entrypoints/mcp.ts replicated at :88 and :124 before this fix, which
 * made the Agent tool reject every subagent_type under `occ mcp serve`.
 *
 * These tests drive the REAL serve path end-to-end: real MCP SDK Server +
 * real Client over an InMemoryTransport linked pair (only the stdio transport
 * class is swapped), real agent-definition loader over temp config/project
 * dirs.
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

// Wrap the (memoized) definitions loader so one test can hold its resolution
// open and assert the official's `await L` ordering, while every other test
// delegates to the real loader. The spread keeps all other exports (used by
// AgentTool.tsx et al.) intact.
const actualLoaderModule = await import(
  '../../tools/AgentTool/loadAgentsDir.js'
)
const realGetAgentDefinitionsWithOverrides =
  actualLoaderModule.getAgentDefinitionsWithOverrides
let loaderImpl: (cwd: string) => Promise<AgentDefinitionsResult> =
  realGetAgentDefinitionsWithOverrides

mock.module('../../tools/AgentTool/loadAgentsDir.js', () => ({
  ...actualLoaderModule,
  getAgentDefinitionsWithOverrides: Object.assign(
    (cwd: string) => loaderImpl(cwd),
    { cache: realGetAgentDefinitionsWithOverrides.cache },
  ),
}))

// MACRO is a build-time macro (bun build) with a dev polyfill in cli.tsx;
// tests that drive an entrypoint directly need the same polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '2.1.288-test',
    BINARY_NAME: 'occ',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '@cnwenf/occ',
    VERSION_CHANGELOG: '',
  }
}

const { startMCPServer } = await import('../mcp.js')

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function agentMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nYou are the ${name} test agent.\n`
}

let tempRoot: string
let configDir: string
let savedConfigDirEnv: string | undefined
let savedNodeEnv: string | undefined

async function makeTempCwd(prefix: string): Promise<string> {
  return await mkdtemp(join(tempRoot, prefix))
}

async function startServe(cwd: string): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  activeServerTransport = serverTransport
  const serveReady = startMCPServer(cwd, false, false)
  const client = new Client({ name: 'occ-mcp-serve-288-test', version: '1.0.0' })
  await serveReady
  await client.connect(clientTransport)
  return client
}

function firstText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ''
}

async function getAgentToolDescription(client: Client): Promise<string> {
  const { tools } = await client.listTools()
  const agentTool = tools.find(t => t.name === 'Agent')
  expect(agentTool).toBeDefined()
  return agentTool?.description ?? ''
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'occ-mcp-serve-288-'))
  configDir = join(tempRoot, 'config')
  await mkdir(join(configDir, 'agents'), { recursive: true })
  // User-level agent (source: userSettings — always trusted per official zce).
  await writeFile(
    join(configDir, 'agents', 'user-agent-288.md'),
    agentMarkdown(
      'user-agent-288',
      'User-level test agent for the 2.1.288 serve fix',
    ),
  )

  savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
  savedNodeEnv = process.env.NODE_ENV
  // getClaudeConfigHomeDir memoizes keyed on CLAUDE_CONFIG_DIR, so a fresh
  // value yields a fresh (temp) config home with no real-machine agents.
  process.env.CLAUDE_CONFIG_DIR = configDir
  // NODE_ENV=test pins getGlobalConfig() to the fixed test constant (no
  // trusted projects) so the folder-trust filter is deterministic.
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

beforeEach(() => {
  loaderImpl = realGetAgentDefinitionsWithOverrides
  actualLoaderModule.clearAgentDefinitionsCache()
})

describe('2.1.288 #62 — mcp serve loads real agent definitions', () => {
  test('ListTools Agent description lists user + built-in agents instead of the v287 hardcoded empties', async () => {
    const cwd = await makeTempCwd('cwd-list-')
    const client = await startServe(cwd)
    try {
      const description = await getAgentToolDescription(client)
      // v287 bug: prompt() got agents:[] → no agent types listed at all.
      expect(description).toContain('user-agent-288')
      expect(description).toContain('general-purpose')
    } finally {
      await client.close()
    }
  })

  test('CallTool threads loaded definitions: unknown subagent_type error lists the real agents', async () => {
    const cwd = await makeTempCwd('cwd-call-')
    const client = await startServe(cwd)
    try {
      const result = await client.callTool({
        name: 'Agent',
        arguments: { prompt: 'noop', subagent_type: 'no-such-agent-288' },
      })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain("Agent type 'no-such-agent-288' not found")
      // v287 bug: "Available agents: " was always empty because
      // toolUseContext.options.agentDefinitions was hardcoded empty.
      expect(text).toContain('user-agent-288')
      expect(text).toContain('general-purpose')
    } finally {
      await client.close()
    }
  })

  test('handlers await the definitions load before building tools (official `await L` ordering)', async () => {
    const warmCwd = await makeTempCwd('cwd-warm-')
    const warmDefs =
      await realGetAgentDefinitionsWithOverrides(warmCwd)

    const cwd = await makeTempCwd('cwd-deferred-')
    let resolveLoad: ((defs: AgentDefinitionsResult) => void) | undefined
    loaderImpl = () =>
      new Promise<AgentDefinitionsResult>(resolve => {
        resolveLoad = resolve
      })

    const client = await startServe(cwd)
    try {
      const listPromise = client.listTools()
      // While the load is pending, ListTools must NOT resolve — the official
      // handler awaits L before building the tool list.
      const raced = await Promise.race([
        listPromise.then(() => 'resolved' as const),
        new Promise<'pending'>(resolve => {
          setTimeout(() => resolve('pending'), 75)
        }),
      ])
      expect(raced).toBe('pending')

      resolveLoad?.(warmDefs)
      const { tools } = await listPromise
      const agentTool = tools.find(t => t.name === 'Agent')
      expect(agentTool?.description).toContain('general-purpose')

      // CallTool awaits the same promise; after resolution the context
      // carries the loaded definitions.
      const callResult = await client.callTool({
        name: 'Agent',
        arguments: { prompt: 'noop', subagent_type: 'no-such-agent-288' },
      })
      expect(firstText(callResult)).toContain('general-purpose')
    } finally {
      await client.close()
    }
  })

  test('definitions from untrusted project folders are filtered (official zce predicate); trusted sources survive', async () => {
    const cwd = await makeTempCwd('cwd-trust-')
    await mkdir(join(cwd, '.claude', 'agents'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'agents', 'project-agent-288.md'),
      agentMarkdown(
        'project-agent-288',
        'Project agent from an untrusted folder',
      ),
    )

    const client = await startServe(cwd)
    try {
      const description = await getAgentToolDescription(client)
      // projectSettings source in a folder with no accepted trust dialog is
      // not servable (official: zce filter + Gye(T,"subagent","definition")).
      expect(description).not.toContain('project-agent-288')
      // userSettings + built-in sources are always trusted.
      expect(description).toContain('user-agent-288')
      expect(description).toContain('general-purpose')
    } finally {
      await client.close()
    }
  })

  test('loader failure degrades to empty definitions without breaking serve (official .catch)', async () => {
    const cwd = await makeTempCwd('cwd-fail-')
    loaderImpl = () => Promise.reject(new Error('loader exploded 288'))

    const client = await startServe(cwd)
    try {
      // ListTools still answers (Agent description just lists no custom
      // agents); the server is not wedged by the rejected load.
      const { tools } = await client.listTools()
      expect(tools.find(t => t.name === 'Agent')).toBeDefined()

      const result = await client.callTool({
        name: 'Agent',
        arguments: { prompt: 'noop', subagent_type: 'no-such-agent-288' },
      })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain(
        "Agent type 'no-such-agent-288' not found",
      )
    } finally {
      await client.close()
    }
  })
})
