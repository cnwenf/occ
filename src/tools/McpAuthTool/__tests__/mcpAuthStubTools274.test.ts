/**
 * CC 2.1.274 — auth-stub factory `Qx(e,r)` + `D.call()` gating chain
 * (live-binary verified; forensics in docs/upstream-version-gap-occ128.md).
 *
 * Locks in:
 *  - factory returns BOTH stub tools in interactive sessions and NONE in
 *    non-interactive (`-p`) sessions — pre-274 OCC shipped only the
 *    authenticate stub, unconditionally;
 *  - the official gating order: managed-policy → disabled → project-approval
 *    → claudeai-proxy → unsupported-transport → anthropic-hosted blocklist;
 *  - the byte-exact auth_url message incl. the callback-paste guidance
 *    (local + remote variants) pointing at `complete_authentication`;
 *  - silent-completion and start-failure messages;
 *  - setActiveOAuthPromise registration so the sibling complete tool can
 *    await the flow.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// OCC-97: Bun's mock.module leaks across files in the same worker — spread
// the real modules, override only what each test needs, restore in afterAll.
const actualState = await import('../../../bootstrap/state.js')
const actualAuth = await import('../../../services/mcp/auth.js')
const actualClient = await import('../../../services/mcp/client.js')
const actualConfig = await import('../../../services/mcp/config.js')
const actualUtils = await import('../../../services/mcp/utils.js')

const flags = {
  nonInteractive: false,
  disabled: false,
  allowedByPolicy: true,
  projectStatus: 'approved' as 'approved' | 'rejected' | 'pending',
}

const oauth = {
  calls: 0,
  impl: undefined as
    | ((
        name: string,
        config: unknown,
        onUrl: (url: string) => void,
        signal: unknown,
        opts: unknown,
      ) => Promise<void>)
    | undefined,
  activeFlowRegistrations: [] as Array<{ name: string; promise: Promise<unknown> }>,
}

const reconnect = {
  clearCacheCalls: 0,
  reconnectCalls: 0,
}

mock.module('../../../bootstrap/state.js', () => ({
  ...actualState,
  getIsNonInteractiveSession: () => flags.nonInteractive,
}))
mock.module('../../../services/mcp/auth.js', () => ({
  ...actualAuth,
  performMCPOAuthFlow: (
    name: string,
    config: unknown,
    onUrl: (url: string) => void,
    signal: unknown,
    opts: unknown,
  ) => {
    oauth.calls += 1
    if (!oauth.impl) {
      throw new Error('test: performMCPOAuthFlow called without impl')
    }
    return oauth.impl(name, config, onUrl, signal, opts)
  },
  setActiveOAuthPromise: (name: string, promise: Promise<unknown>) => {
    oauth.activeFlowRegistrations.push({ name, promise })
  },
}))
mock.module('../../../services/mcp/client.js', () => ({
  ...actualClient,
  clearMcpAuthCache: () => {
    reconnect.clearCacheCalls += 1
  },
  reconnectMcpServerImpl: async () => {
    reconnect.reconnectCalls += 1
    return { client: { name: 'srv' }, tools: [], commands: [] }
  },
}))
mock.module('../../../services/mcp/config.js', () => ({
  ...actualConfig,
  isMcpServerDisabled: () => flags.disabled,
  isMcpServerAllowedByPolicy: () => flags.allowedByPolicy,
}))
mock.module('../../../services/mcp/utils.js', () => ({
  ...actualUtils,
  getProjectMcpServerStatus: () => flags.projectStatus,
}))

const { createMcpAuthStubTools, createMcpAuthTool } = await import(
  '../McpAuthTool.js'
)

import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'

const httpConfig = {
  type: 'http',
  url: 'https://srv.test/mcp',
  scope: 'user',
} as ScopedMcpServerConfig

const AUTH_URL =
  'https://idp.example/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fcallback'

function makeContext() {
  const applied: unknown[] = []
  const context = {
    setAppState: (
      updater: (prev: {
        mcp: {
          clients: unknown[]
          tools: { name?: string }[]
          commands: { name?: string }[]
          resources: Record<string, unknown>
        }
      }) => unknown,
    ) => {
      applied.push(
        updater({
          mcp: {
            clients: [],
            tools: [{ name: 'mcp__srv__authenticate' }],
            commands: [],
            resources: {},
          },
        }),
      )
    },
  }
  return { context: context as never, applied }
}

/** OAuth flow that surfaces an auth URL and then stays pending. */
function pendingFlowWithUrl(): Promise<void> {
  return new Promise<void>(() => {
    // intentionally never settles — models the user not finishing the flow
  })
}

beforeEach(() => {
  flags.nonInteractive = false
  flags.disabled = false
  flags.allowedByPolicy = true
  flags.projectStatus = 'approved'
  oauth.calls = 0
  oauth.impl = undefined
  oauth.activeFlowRegistrations = []
  reconnect.clearCacheCalls = 0
  reconnect.reconnectCalls = 0
  // Deterministic local session: no SSH/remote markers.
  for (const key of [
    'CLAUDE_CODE_REMOTE',
    'SSH_CONNECTION',
    'SSH_TTY',
    'SSH_CLIENT',
  ]) {
    delete process.env[key]
  }
})

afterAll(() => {
  mock.module('../../../bootstrap/state.js', () => ({ ...actualState }))
  mock.module('../../../services/mcp/auth.js', () => ({ ...actualAuth }))
  mock.module('../../../services/mcp/client.js', () => ({ ...actualClient }))
  mock.module('../../../services/mcp/config.js', () => ({ ...actualConfig }))
  mock.module('../../../services/mcp/utils.js', () => ({ ...actualUtils }))
})

describe('2.1.274 createMcpAuthStubTools factory (binary Qx)', () => {
  test('interactive session → both stub tools, authenticate first', () => {
    const tools = createMcpAuthStubTools('srv', httpConfig, () => undefined)
    expect(tools.map(t => t.name)).toEqual([
      'mcp__srv__authenticate',
      'mcp__srv__complete_authentication',
    ])
  })

  test('non-interactive session (-p) → no stub tools at all', () => {
    flags.nonInteractive = true
    expect(createMcpAuthStubTools('srv', httpConfig, () => undefined)).toEqual(
      [],
    )
  })
})

describe('2.1.274 D.call() gating order', () => {
  test('managed-policy block wins over disabled and project-approval', async () => {
    flags.allowedByPolicy = false
    flags.disabled = true
    flags.projectStatus = 'pending'
    const { context } = makeContext()
    const { data } = await createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      '"srv" is blocked by your organization\'s managed policy — it can\'t be authenticated or reconnected here. Only an organization admin can change this; do not retry or ask the user to enable it.',
    )
    expect(oauth.calls).toBe(0)
  })

  test('disabled beats project-approval', async () => {
    flags.disabled = true
    flags.projectStatus = 'pending'
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'srv',
      { ...httpConfig, scope: 'project' } as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      'MCP server srv is disabled. Ask the user to enable it in /mcp before authenticating.',
    )
    expect(oauth.calls).toBe(0)
  })

  test('unapproved project-scope server → project-approval message', async () => {
    flags.projectStatus = 'pending'
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'srv',
      { ...httpConfig, scope: 'project' } as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('error')
    expect(data.message).toBe(
      '"srv" is a project-scope MCP server (.mcp.json) that is not approved for this project — approve it via /mcp first, then authenticate or reconnect it. Ask the user to approve it; do not retry until they have.',
    )
    expect(oauth.calls).toBe(0)
  })

  test('claudeai-proxy → unsupported with /mcp pointer', async () => {
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'srv',
      { type: 'claudeai-proxy', scope: 'user' } as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('unsupported')
    expect(data.message).toBe(
      'This is a claude.ai MCP connector. Ask the user to run /mcp and select "srv" to authenticate.',
    )
    expect(oauth.calls).toBe(0)
  })

  test('stdio transport → unsupported-transport message', async () => {
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'srv',
      {
        type: 'stdio',
        command: 'x',
        scope: 'user',
      } as unknown as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('unsupported')
    expect(data.message).toBe(
      'Server "srv" uses stdio transport which does not support OAuth from this tool. Ask the user to run /mcp and authenticate manually.',
    )
    expect(oauth.calls).toBe(0)
  })

  test('anthropic-hosted blocklist URL → connector message with occ-remove hint', async () => {
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'srv',
      {
        type: 'http',
        url: 'https://gmail.mcp.claude.com/mcp',
        scope: 'user',
      } as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('unsupported')
    // The official wraps the message in `Xi(…,1024)` — the display sanitizer
    // unconditionally replaces `"` with a space (redact mode 'none' only
    // disables secret redaction), so the quoted name arrives unquoted.
    expect(data.message).toBe(
      "srv is Anthropic-hosted and doesn't support local OAuth. Connect it via Settings → Connectors on claude.ai (requires `claude login`), then it'll be available here automatically. Remove the stale entry with: `occ mcp remove srv`",
    )
    expect(oauth.calls).toBe(0)
  })

  test('anthropic-hosted URL with shell-unsafe server name → no remove hint', async () => {
    const { context } = makeContext()
    const { data } = await createMcpAuthTool(
      'bad name; rm',
      {
        type: 'http',
        url: 'https://GMAIL.mcp.claude.com./mcp',
        scope: 'user',
      } as ScopedMcpServerConfig,
      () => undefined,
    ).call({}, context)
    expect(data.status).toBe('unsupported')
    expect(data.message).not.toContain('mcp remove')
    expect(data.message).toContain("is Anthropic-hosted and doesn't support local OAuth")
    expect(oauth.calls).toBe(0)
  })
})

describe('2.1.274 D.call() OAuth start', () => {
  test('auth_url result registers the flow and carries byte-exact local guidance', async () => {
    oauth.impl = (_name, _config, onUrl) => {
      onUrl(AUTH_URL)
      return pendingFlowWithUrl()
    }
    const { context } = makeContext()
    const { data } = await createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    expect(oauth.calls).toBe(1)
    expect(oauth.activeFlowRegistrations.length).toBe(1)
    expect(oauth.activeFlowRegistrations[0].name).toBe('srv')
    expect(data.status).toBe('auth_url')
    expect(data.authUrl).toBe(AUTH_URL)
    expect(data.message).toBe(
      `Ask the user to open this URL in their browser to authorize the srv MCP server:\n\n${AUTH_URL}\n\nOnce they complete the flow, the server's tools will become available automatically.` +
        '\n\nIf the browser shows a connection error on the redirect page, ask the user to paste the full URL from the address bar and call `mcp__srv__complete_authentication` with it.',
    )
  })

  test('remote session → remote guidance embeds the extracted redirect_uri', async () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    oauth.impl = (_name, _config, onUrl) => {
      onUrl(AUTH_URL)
      return pendingFlowWithUrl()
    }
    const { context } = makeContext()
    const { data } = await createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    expect(data.status).toBe('auth_url')
    expect(data.message).toBe(
      `Ask the user to open this URL in their browser to authorize the srv MCP server:\n\n${AUTH_URL}\n\nOnce they complete the flow, the server's tools will become available automatically.` +
        "\n\nThis session is remote, so after authorizing the browser will try to load `http://localhost:4321/callback?code=...` and show a connection error — that's expected. Ask the user to copy the full URL from the browser's address bar and paste it into chat, then call `mcp__srv__complete_authentication` with that URL as `callback_url`.",
    )
  })

  test('flow completes without a URL → silent-completion message', async () => {
    oauth.impl = () => Promise.resolve()
    const { context, applied } = makeContext()
    const { data } = await createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    expect(data.status).toBe('auth_url')
    expect(data.message).toBe(
      "Authentication completed silently for srv. The server's tools should now be available.",
    )
    // Background continuation: cache cleared, reconnect attempted, prefix swap
    // applied through setAppState (stub tool removed by prefix replacement).
    await new Promise(r => setTimeout(r, 10))
    expect(reconnect.clearCacheCalls).toBe(1)
    expect(reconnect.reconnectCalls).toBe(1)
    expect(applied.length).toBe(1)
    const next = applied[0] as {
      mcp: { tools: { name?: string }[] }
    }
    expect(next.mcp.tools).toEqual([])
  })

  test('background continuation rechecks disabled/policy after completion', async () => {
    let resolveFlow: (() => void) | undefined
    oauth.impl = () =>
      new Promise<void>(resolve => {
        resolveFlow = resolve
      })
    const { context } = makeContext()
    // Do NOT await yet — call() races the flow promise, which only settles
    // once we release it below.
    const callPromise = createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    // Policy flips to disabled while the token exchange is still running —
    // the official continuation logs and skips the reconnect.
    flags.disabled = true
    resolveFlow?.()
    await callPromise
    await new Promise(r => setTimeout(r, 10))
    expect(reconnect.clearCacheCalls).toBe(1)
    expect(reconnect.reconnectCalls).toBe(0)
  })

  test('flow rejects → start-failure message with redacted detail', async () => {
    oauth.impl = () =>
      Promise.reject(new Error('discovery failed at https://srv.test/mcp'))
    const { context } = makeContext()
    const { data } = await createMcpAuthTool('srv', httpConfig, () => undefined).call(
      {},
      context,
    )
    expect(data.status).toBe('error')
    expect(data.message).toContain('Failed to start OAuth flow for srv:')
    expect(data.message).toContain('Ask the user to run /mcp and authenticate manually.')
    // Background continuation swallows the same rejection (log-only) — no
    // unhandled rejection may surface; give the microtask queue a turn.
    await new Promise(r => setTimeout(r, 10))
    expect(reconnect.reconnectCalls).toBe(0)
  })
})
