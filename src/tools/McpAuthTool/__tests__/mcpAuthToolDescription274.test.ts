/**
 * CC 2.1.274 S3a — MCP auth-stub tool description must never embed the raw
 * env-EXPANDED config URL (post-expansion secrets leak into model-visible
 * tool descriptions). Official 2.1.274 fix (binary `Qx`→`_R({detail:'origin'})`
 * →`D(e,r,n)` @211336157 region): location comes from getMcpErrorEndpoint
 * (authored-unexpanded origin), sanitized via nPr(…,256); the server name via
 * xr(). Byte-verified against the 2.1.274 linux-x64 ELF; forensics in
 * docs/upstream-version-gap-occ127.md Part II.
 *
 * Resolver/fixture pattern mirrors mcpSecretRedaction268.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'
import {
  clearAuthoredUnexpandedRegistry,
  type UnexpandedScopeResolver,
} from '../../../services/mcp/redaction.js'
import {
  buildMcpAuthToolDescription,
  createMcpAuthTool,
} from '../McpAuthTool.js'

// ---------------------------------------------------------------------------
// Fixtures (same shape as mcpSecretRedaction268.test.ts)
// ---------------------------------------------------------------------------

const httpExpanded = {
  type: 'http',
  url: 'https://real.host.test/mcp',
  headers: { Authorization: 'Bearer ghp_secretvalue123' },
  scope: 'user',
} as ScopedMcpServerConfig

const httpAuthored = {
  type: 'http',
  url: 'https://${API_HOST}/mcp',
  headers: { Authorization: 'Bearer ${API_TOKEN}' },
  scope: 'user',
} as ScopedMcpServerConfig

/** Resolver serving a single authored copy in `user` scope. */
const resolverWithAuthored: UnexpandedScopeResolver = scope =>
  scope === 'user' ? { github: httpAuthored } : undefined

const emptyResolver: UnexpandedScopeResolver = () => undefined

afterEach(() => {
  clearAuthoredUnexpandedRegistry()
})

describe('2.1.274 S3a: buildMcpAuthToolDescription', () => {
  test('authored env-ref host → shows the AUTHORED template, never the expanded host', () => {
    const description = buildMcpAuthToolDescription(
      'github',
      httpExpanded,
      resolverWithAuthored,
    )
    expect(description).toContain('(http at https://${API_HOST})')
    expect(description).not.toContain('real.host.test')
    expect(description).not.toContain('ghp_secretvalue123')
  })

  test('known scope without authored match → bare transport label, no URL at all', () => {
    const description = buildMcpAuthToolDescription(
      'github',
      httpExpanded,
      emptyResolver,
    )
    expect(description).toContain('(http) is installed')
    expect(description).not.toContain('real.host.test')
    expect(description).not.toContain('ghp_secretvalue123')
  })

  test('expanded userinfo secret is never displayed (origin-only fallback)', () => {
    // Unknown scope (outside ConfigScopeSchema) → getEndpointForDisplay falls
    // back to the EXPANDED config but returns origin only — userinfo (where
    // the secret lives) is dropped by URL parsing.
    const leaky = {
      type: 'http',
      url: 'https://user:sup3rsecret@real.host.test/mcp',
      scope: 'cli',
    } as unknown as ScopedMcpServerConfig
    const description = buildMcpAuthToolDescription(
      'leaky',
      leaky,
      emptyResolver,
    )
    expect(description).not.toContain('sup3rsecret')
    expect(description).toContain('(http at https://real.host.test)')
  })

  test('stdio config → transport-only location', () => {
    const stdio = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      scope: 'user',
    } as unknown as ScopedMcpServerConfig
    const description = buildMcpAuthToolDescription(
      'local',
      stdio,
      emptyResolver,
    )
    expect(description).toContain('(stdio) is installed')
  })

  test('server name is sanitized (xr): quotes neutralized, 64-char cap', () => {
    const description = buildMcpAuthToolDescription(
      'ev`il"name',
      httpExpanded,
      emptyResolver,
    )
    expect(description).toContain('The "ev il name" MCP server')

    const long = buildMcpAuthToolDescription(
      'n'.repeat(100),
      httpExpanded,
      emptyResolver,
    )
    expect(long).toContain(`The "${'n'.repeat(64)}…" MCP server`)
  })

  test('description body matches the official 2.1.274 template verbatim', () => {
    const description = buildMcpAuthToolDescription(
      'github',
      httpExpanded,
      emptyResolver,
    )
    expect(description).toBe(
      'The "github" MCP server (http) is installed but requires authentication. ' +
        "Call this tool to start the OAuth flow — you'll receive an authorization URL to share with the user. " +
        "Once the user completes authorization in their browser, the server's real tools will become available automatically.",
    )
  })
})

describe('2.1.274 S3a: createMcpAuthTool wiring', () => {
  test('tool description/prompt use the sanitized builder output', async () => {
    const tool = createMcpAuthTool('github', httpExpanded, resolverWithAuthored)
    const expected = buildMcpAuthToolDescription(
      'github',
      httpExpanded,
      resolverWithAuthored,
    )
    expect(await tool.description()).toBe(expected)
    expect(await tool.prompt()).toBe(expected)
    expect(tool.name).toBe('mcp__github__authenticate')
    expect(tool.mcpInfo).toEqual({
      serverName: 'github',
      toolName: 'authenticate',
    })
    expect(tool.isMcp).toBe(true)
  })

  test('tool description never contains the expanded URL or header secret', async () => {
    const tool = createMcpAuthTool('github', httpExpanded, emptyResolver)
    const description = await tool.description()
    expect(description).not.toContain('real.host.test')
    expect(description).not.toContain('ghp_secretvalue123')
  })
})
