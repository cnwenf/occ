/**
 * CC 2.1.274 — `mcp__<server>__complete_authentication` auth-stub tool
 * (official binary `v(e,r)`, live-binary verified @211336157 region). This
 * tool was MISSING entirely from OCC before this round (only the
 * `authenticate` stub shipped) — the remote-session paste path had no
 * model-callable completion tool. Description and every error/success
 * message are byte-ported from the official templates; forensics and the
 * strings-extraction newline caveat are in docs/upstream-version-gap-occ128.md.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only the registry readers, restore after.
const actualAuth = await import('../../../services/mcp/auth.js')

let mockedSubmitter: ((url: string) => boolean) | undefined
let mockedActiveFlow: Promise<void> | undefined

mock.module('../../../services/mcp/auth.js', () => ({
  ...actualAuth,
  getOAuthCallbackSubmitter: () => mockedSubmitter,
  getActiveOAuthPromise: () => mockedActiveFlow,
}))

const { createMcpCompleteAuthTool, buildMcpCompleteAuthToolDescription } =
  await import('../McpCompleteAuthTool.js')
const { AuthenticationCancelledError } = actualAuth

import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'

const httpConfig = {
  type: 'http',
  url: 'https://srv.test/mcp',
  scope: 'user',
} as ScopedMcpServerConfig

/** Tool.call context is unused by this tool — cast a stub. */
const stubContext = {} as never

function makeTool(serverName = 'srv') {
  return createMcpCompleteAuthTool(serverName, httpConfig, () => undefined)
}

afterAll(() => {
  mock.module('../../../services/mcp/auth.js', () => ({ ...actualAuth }))
})

describe('2.1.274 complete_authentication: identity', () => {
  test('tool name / userFacingName / render / size cap match official', () => {
    const tool = makeTool('github')
    expect(tool.name).toBe('mcp__github__complete_authentication')
    expect(tool.userFacingName?.()).toBe('github - complete authentication (MCP)')
    expect(tool.renderToolUseMessage?.()).toBe(
      'Complete authentication for github MCP server',
    )
    expect(tool.maxResultSizeChars).toBe(10_000)
    expect(tool.isMcp).toBe(true)
  })

  test('description is byte-identical to the official v(e,r) template', async () => {
    expect(buildMcpCompleteAuthToolDescription('github')).toBe(
      'Complete an in-progress OAuth flow for the "github" MCP server by submitting the callback URL. Call `mcp__github__authenticate` first to start the flow and get the authorization URL. ' +
        'After the user authorizes in their browser, the browser is redirected to a `http://localhost:<port>/callback?code=...&state=...` URL — ' +
        'on remote sessions that page fails to load, but the URL in the address bar is still valid. Pass that full URL here as `callback_url`.',
    )
    expect(await makeTool('github').description()).toBe(
      buildMcpCompleteAuthToolDescription('github'),
    )
  })

  test('input schema carries the official callback_url describe() text', () => {
    const schema = makeTool().inputSchema as unknown as {
      shape: Record<string, { description?: string }>
    }
    expect(schema.shape.callback_url.description).toBe(
      'The full callback URL from the browser address bar after authorizing, e.g. http://localhost:<port>/callback?code=...&state=...',
    )
  })
})

describe('2.1.274 complete_authentication: call() gating', () => {
  test('no flow in progress → official error pointing at the authenticate tool', async () => {
    mockedSubmitter = undefined
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=b' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      'No OAuth flow is in progress for srv. Call `mcp__srv__authenticate` first, then retry with the callback URL.',
    )
  })

  test('URL without code/error → invalid-callback-URL error, submitter untouched', async () => {
    let submitted = 0
    mockedSubmitter = () => {
      submitted += 1
      return true
    }
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?foo=bar' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      "Invalid callback URL: missing authorization code. Ask the user to paste the full redirect URL from their browser's address bar, including the `?code=...&state=...` query string.",
    )
    expect(submitted).toBe(0)
  })

  test('submitter returns false (wrong state) → flow-still-waiting error', async () => {
    mockedSubmitter = () => false
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=WRONG' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      'That callback URL belongs to a different sign-in attempt for srv (its state does not match the flow in progress), or carries no authorization code. The current flow is still waiting: ask the user for the URL from the page this sign-in opened, then retry.',
    )
  })

  test('submitter true + no active promise (CLI/headless-initiated flow) → distinct error, never success (review P2-1)', async () => {
    // Pre-fix, `getActiveOAuthPromise` returned undefined here and the tool
    // awaited it — `await undefined` resolved instantly and reported
    // "Authentication complete" while the real exchange (owned by the CLI /
    // headless surface that started the flow) was still in flight.
    mockedSubmitter = () => true
    mockedActiveFlow = undefined
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=S' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      "The callback URL was accepted by the in-progress OAuth flow for srv, but that flow was started outside this session's tool path (e.g. `occ mcp login` or a headless control channel), so its token exchange cannot be tracked here. The surface that started the flow will report completion — do not retry this tool.",
    )
  })

  test('submitter true + flow resolves → official success message', async () => {
    mockedSubmitter = () => true
    mockedActiveFlow = Promise.resolve()
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=S' },
      stubContext,
    )
    expect(data.status).toBe('success')
    expect(data.message).toBe(
      "Authentication complete for srv. The server's tools should now be available.",
    )
  })

  test('flow rejects with AuthenticationCancelledError → cancelled message', async () => {
    mockedSubmitter = () => true
    mockedActiveFlow = Promise.reject(new AuthenticationCancelledError())
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=S' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      'The OAuth flow for srv was cancelled (a newer attempt may have superseded it). Call `mcp__srv__authenticate` again to restart.',
    )
  })

  test('flow rejects with secret-bearing error → redacted + sanitized detail', async () => {
    mockedSubmitter = () => true
    mockedActiveFlow = Promise.reject(
      new Error('token exchange failed with Bearer sksecret12345678 inline'),
    )
    const { data } = await makeTool().call(
      { callback_url: 'http://localhost:1/cb?code=a&state=S' },
      stubContext,
    )
    expect(data.status).toBe('error')
    expect(data.message).toContain('Authentication failed for srv:')
    expect(data.message).not.toContain('sksecret12345678')
    expect(data.message).toContain('Bearer [redacted]')
  })

  test('mapper returns data.message as tool_result content', () => {
    const tool = makeTool()
    const block = tool.mapToolResultToToolResultBlockParam(
      { status: 'success', message: 'M' },
      'tu-1',
    )
    expect(block).toEqual({
      tool_use_id: 'tu-1',
      type: 'tool_result',
      content: 'M',
    })
  })
})
