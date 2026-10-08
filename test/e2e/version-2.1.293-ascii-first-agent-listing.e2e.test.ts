import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOcc } from './helpers'

/**
 * CC 2.1.293 changelog entry #46 — agent lists + MCP servers announced to the
 * model sort non-ASCII names AFTER ASCII ones (docs/gap-research-293/triage-293.md
 * §46). Official comparator `ZCe` @204175795, byte-read from the official
 * 2.1.293 linux-x64 ELF (never executed):
 *
 *   var f=/^[\x00-\x7f]*$/;
 *   function ZCe(t,n){let e=f.test(t);if(e!==f.test(n))return e?-1:1;
 *     if(e)return t.localeCompare(n);if(t===n)return 0;return t<n?-1:1}
 *
 * Official switched 6 call sites; OCC's counterparts are
 * `compareAgentsByName` (agentDisplay), `getActiveAgentsFromList`
 * (loadAgentsDir — official `Array.from(z.values()).sort((V,Y)=>ZCe(...))`
 * @214472660), `mcp_instructions_delta` (@214429076) and `agent_listing_delta`
 * (@216012902). Unit coverage: src/utils/__tests__/asciiFirstSort293.test.ts.
 *
 * Wire-level e2e (same mock-endpoint pattern as
 * version-2.1.283-system-prompt-merge.e2e.test.ts): a real `occ -p` run against
 * a local mock Anthropic endpoint, asserting the ordering the MODEL actually
 * receives in the Agent tool description ("Available agent types …", built from
 * `getActiveAgentsFromList`). Pre-#46 the same fixture produced
 * `alpha, Ünicorn, zeta, 日本語-agent` (localeCompare interleaves Ü before z);
 * the official ordering is `alpha, zeta, Ünicorn, 日本語-agent`.
 */

const REQUEST_MODEL = 'claude-sonnet-5'

/** Fixture agent names — ASCII (locale-ordered) first, then non-ASCII (code-unit). */
const FIXTURE_AGENT_NAMES = ['alpha', 'zeta', 'Ünicorn', '日本語-agent']

const SSE_BODY = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_ascii46',
      type: 'message',
      role: 'assistant',
      model: 'claude-ascii46-mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n')

interface MockEndpoint {
  port: number
  bodies: () => string[]
  close: () => Promise<void>
}

function startMockEndpoint(): Promise<MockEndpoint> {
  const received: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      received.push(body)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.end(SSE_BODY)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        bodies: () => [...received],
        close: () =>
          new Promise<void>(res => {
            server.close(() => res())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function freshHome(root: string, projectDir: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-09-11T00:00:00.000Z',
      migrationVersion: 11,
      userID: 'occ-ascii46-0000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.293',
      lastReleaseNotesSeen: '2.1.293',
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true }),
  )
  return home
}

/**
 * Project agents whose FILENAME order (alpha, ja, unicorn, zeta) differs from
 * both the pre-#46 locale order and the official ASCII-first order, so a
 * no-op sort cannot pass by accident.
 */
function writeFixtureAgents(projectDir: string): void {
  const agentsDir = join(projectDir, '.claude', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const files: Array<[string, string]> = [
    ['alpha', 'alpha.md'],
    ['zeta', 'zeta.md'],
    ['Ünicorn', 'unicorn.md'],
    ['日本語-agent', 'ja-agent.md'],
  ]
  for (const [name, file] of files) {
    writeFileSync(
      join(agentsDir, file),
      `---\nname: ${name}\ndescription: ${name} agent for the CC 2.1.293 #46 ASCII-first ordering e2e\ntools: Read\n---\n\nYou are the ${name} test agent.\n`,
    )
  }
}

function baseEnv(
  endpoint: MockEndpoint,
  home: string,
  projectDir: string,
): Record<string, string> {
  return {
    HOME: home,
    OCC_CWD: projectDir,
    ANTHROPIC_API_KEY: 'occ-ascii46-key',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`,
    ANTHROPIC_MODEL: REQUEST_MODEL,
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_UNATTENDED_RETRY: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/** Description of the Agent tool from the first captured /v1/messages body. */
function capturedAgentToolDescription(
  endpoint: MockEndpoint,
): string | undefined {
  for (const raw of endpoint.bodies()) {
    try {
      const parsed = JSON.parse(raw)
      const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
      const agentTool = tools.find(
        (t: { name?: string }) => t?.name === 'Agent',
      )
      if (typeof agentTool?.description === 'string') {
        return agentTool.description
      }
    } catch {
      // Not a JSON body (e.g. a health probe) — keep scanning.
    }
  }
  return undefined
}

/** Agent names of the "Project agents" group, in rendered order. */
function projectAgentLines(stdout: string): string[] {
  const lines = stdout.split('\n')
  const start = lines.indexOf('Project agents:')
  if (start === -1) return []
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    // The handler terminates every source group with a blank line.
    if (line.trim() === '') break
    const name = line.match(/^\s{2}(\S.*?)\s·/)?.[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

describe('CC 2.1.293 #46 — ASCII-first ordering of agent names announced to the model', () => {
  test('wire: the Agent tool description lists non-ASCII agents after ASCII ones', async () => {
    const endpoint = await startMockEndpoint()
    const root = mkdtempSync(join(tmpdir(), 'occ-ascii46-'))
    const projectDir = join(root, 'proj')
    mkdirSync(projectDir, { recursive: true })
    try {
      const home = freshHome(root, projectDir)
      writeFixtureAgents(projectDir)

      const result = await runOcc(
        ['-p', 'Say OK'],
        baseEnv(endpoint, home, projectDir),
      )
      expect(result.code).toBe(0)

      const description = capturedAgentToolDescription(endpoint)
      expect(typeof description).toBe('string')
      expect(description).toContain(
        'Available agent types and the tools they have access to:',
      )

      const positions = FIXTURE_AGENT_NAMES.map(name => [
        name,
        (description as string).indexOf(`\n- ${name}:`),
      ])
      // Every fixture agent reached the wire…
      for (const [name, position] of positions) {
        expect(position, `${name} missing from the Agent tool description`).toBeGreaterThan(-1)
      }
      // …in ASCII-first order (locale inside ASCII, code-unit after).
      expect(
        [...positions].sort((a, b) => a[1] - b[1]).map(([name]) => name),
      ).toEqual(FIXTURE_AGENT_NAMES)
    } finally {
      await endpoint.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  test('cli: `agents --definitions` renders the project group ASCII-first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'occ-ascii46-cli-'))
    const projectDir = join(root, 'proj')
    mkdirSync(projectDir, { recursive: true })
    try {
      const home = freshHome(root, projectDir)
      writeFixtureAgents(projectDir)

      const result = await runOcc(
        ['agents', '--definitions'],
        {
          HOME: home,
          OCC_CWD: projectDir,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      )
      expect(result.code).toBe(0)
      expect(projectAgentLines(result.stdout)).toEqual(FIXTURE_AGENT_NAMES)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
