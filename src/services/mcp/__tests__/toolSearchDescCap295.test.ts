import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Tool, Tools } from '../../../Tool.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { clearToolSchemaCache } from '../../../utils/toolSchemaCache.js'
import {
  fetchToolsForClient,
  getMaxMcpDescriptionLength,
  truncateMcpDescription,
} from '../client.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../types.js'

/**
 * Official Claude Code v2.1.295 item #112 — "MCP tool descriptions loaded
 * through tool search are now truncated at 16,384 characters instead of 2,048."
 *
 * Byte-verified against the v295 linux-x64 ELF:
 *
 * - @213397142 `_Rn=2048,Qts=16384` — s295-only (s294 has neither token).
 * - @~217055278 `mx(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??
 *   (e?Qts:_Rn)}` — s294's `UF(){return ...??X5o}` had NO branch; the
 *   `loadedThroughToolSearch` parameter is the 295 delta. The env override
 *   wins for BOTH load paths (single `??` in front of the branch).
 * - @243847045 truncator gained a cap parameter: `Jt(e,r,n,s=mx())`.
 * - @243900141 MCP tool factory computes two eager variants
 *   `_e=Jt(Re,`Tool "${q.name}" description`,e)` and `ce=Jt(Re,...,e,mx(!0))`,
 *   and `async prompt({loadedThroughToolSearch:Ee}){return Ee?ce:_e}`
 *   (dup factory @244085866). Call site @217614375 sets the flag only for
 *   tool-search-discovered tools; schema-cache bit @215678602 adds `"LT:"`
 *   when `loadedThroughToolSearch===!0&&isMcp===!0`.
 *
 * CC 2.1.296 #061 SUPERSESSION: the default (sent-up-front) cap is now 4,096
 * (was 2,048); the tool-search cap stays 16,384. v296 ELF @214045823:
 * `sxn=4096,sns=16384` (v295 @213397126: `_Rn=2048,Qts=16384`); getter
 * @217807549 `Ax(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??
 * (e?sns:sxn)}` — same shape as the 295 `mx`. 2.1.296 changelog line 61:
 * "Changed the default limit on MCP tool descriptions sent up front and on
 * MCP server instructions from 2,048 to 4,096 characters."
 *
 * Scope note: this suite pins BOTH the cap layer (the mx/Jt equivalents in
 * client.ts) AND the production serializer wiring. As of the #112 catch-up the
 * MCP factory computes the 4096 and 16384 variants, `Tool.prompt`'s options
 * type declares `loadedThroughToolSearch`, and `toolToAPISchema` (utils/api.ts)
 * plumbs the flag into `tool.prompt()` — derived from `deferLoading && isMcp`
 * (the official call-site condition `bn&&ur(Kn)&&Nn(Kn,Cr)`, since claude.ts
 * marks a tool defer_loading only when tool search discovered it) and gating the
 * schema-cache key with an `"LT:"` bit so the two caps never share an entry. The
 * "reaches the API serializer" suite below drives that full production path:
 * real factory (fetchToolsForClient) → real serializer (toolToAPISchema).
 */

const ENV_KEY = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const DEFAULT_LIMIT = 4096
const TOOL_SEARCH_LIMIT = 16384
/** Official suffix: U+2026 HORIZONTAL ELLIPSIS, one space, `[truncated]`. */
const SUFFIX = '… [truncated]'

let savedEnvValue: string | undefined

beforeEach(() => {
  savedEnvValue = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnvValue
  }
})

describe('2.1.295 #112 — getMaxMcpDescriptionLength (binary mx @~217055278)', () => {
  test('general path stays 4096, tool-search path is 16384 (env unset)', () => {
    // Arrange / Act / Assert — `mx(e=!1){return ...??(e?Qts:_Rn)}`
    expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
    expect(getMaxMcpDescriptionLength(false)).toBe(DEFAULT_LIMIT)
    expect(getMaxMcpDescriptionLength(true)).toBe(TOOL_SEARCH_LIMIT)
  })

  test('env override wins for BOTH load paths (single ?? in front of the branch)', () => {
    // Arrange
    process.env[ENV_KEY] = '512'

    // Act / Assert
    expect(getMaxMcpDescriptionLength()).toBe(512)
    expect(getMaxMcpDescriptionLength(true)).toBe(512)
  })

  test('invalid env values fall back per-path (digitsOnly, min 1 — 280 contract intact)', () => {
    // Arrange / Act / Assert
    for (const invalid of ['abc', '0', '-5', '1e6', '64_000', '', '1.5']) {
      process.env[ENV_KEY] = invalid
      expect(getMaxMcpDescriptionLength()).toBe(DEFAULT_LIMIT)
      expect(getMaxMcpDescriptionLength(true)).toBe(TOOL_SEARCH_LIMIT)
    }
  })
})

describe('2.1.295 #112 — truncateMcpDescription cap parameter (binary Jt @243847045)', () => {
  test('default cap still truncates a 5000-char description at 4096 + suffix', () => {
    // Arrange
    const text = 'x'.repeat(5000)

    // Act
    const result = truncateMcpDescription(text, 'Tool "t" description')

    // Assert
    expect(result).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
  })

  test('explicit 16384 cap passes a 5000-char description through untouched', () => {
    // Arrange
    const text = 'x'.repeat(5000)

    // Act — the factory's tool-search variant: Jt(Re,label,e,mx(!0))
    const result = truncateMcpDescription(
      text,
      'Tool "t" description',
      undefined,
      getMaxMcpDescriptionLength(true),
    )

    // Assert
    expect(result).toBe(text)
  })

  test('explicit 16384 cap truncates a 20000-char description at 16384 + suffix', () => {
    // Arrange
    const text = 'y'.repeat(20000)

    // Act
    const result = truncateMcpDescription(
      text,
      'Tool "t" description',
      undefined,
      getMaxMcpDescriptionLength(true),
    )

    // Assert
    expect(result).toBe('y'.repeat(TOOL_SEARCH_LIMIT) + SUFFIX)
  })

  test('explicit cap parameter is honored verbatim (arbitrary small cap)', () => {
    // Arrange / Act
    const result = truncateMcpDescription(
      'abcdefghijkl',
      'Tool "t" description',
      undefined,
      4,
    )

    // Assert
    expect(result).toBe('abcd' + SUFFIX)
  })
})

/**
 * CC 2.1.295 #112 — production reachability. The cap layer above is only half
 * the feature: the 16384 variant must actually reach the API serializer for a
 * tool-search-discovered MCP tool. These tests drive the real production path —
 * fetchToolsForClient (the factory that builds MCP Tool objects) →
 * toolToAPISchema (the serializer that renders the description sent to the API)
 * — and assert the cap on the rendered schema's description.
 */
describe('2.1.295 #112 — 16384 cap reaches the API serializer (production path)', () => {
  // > 4096 and < 16384: a length that cleanly distinguishes the two caps.
  const LONG_DESC = 5000
  const SUFFIX_LEN = SUFFIX.length

  function permContext() {
    return async () => ({
      mode: 'default' as const,
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    })
  }

  function mcpConnection(
    name: string,
    description: string,
  ): MCPServerConnection {
    const config = {
      type: 'stdio',
      command: 'srv',
      args: [],
      scope: 'user',
    } as ScopedMcpServerConfig
    return {
      type: 'connected',
      name,
      capabilities: { tools: {} },
      config,
      client: {
        request: async () => ({
          tools: [
            { name: 'toolA', description, inputSchema: { type: 'object' } },
          ],
        }),
      },
      cleanup: async () => {},
    } as unknown as MCPServerConnection
  }

  // Build a real MCP Tool through the production factory. fetchToolsForClient is
  // memoized by server name (LRU), so delete around the call for a fresh tool.
  async function buildMcpTool(serverName: string, description: string) {
    fetchToolsForClient.cache.delete(serverName)
    const tools = await fetchToolsForClient(mcpConnection(serverName, description))
    fetchToolsForClient.cache.delete(serverName)
    expect(tools).toHaveLength(1)
    return { tool: tools[0]!, tools }
  }

  function serialize(
    tool: Tool,
    tools: Tools,
    extra: { deferLoading?: boolean; loadedThroughToolSearch?: boolean } = {},
  ) {
    return toolToAPISchema(tool, {
      getToolPermissionContext: permContext(),
      tools,
      agents: [],
      ...extra,
    })
  }

  beforeEach(() => {
    clearToolSchemaCache()
  })

  test('MCP tool discovered via tool search is NOT truncated to 4096 (deferLoading production signal)', async () => {
    // Arrange — claude.ts marks a discovered deferred MCP tool defer_loading:true.
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-reach-defer', desc)

    // Act
    const schema = await serialize(tool, tools, { deferLoading: true })

    // Assert — all 5000 chars survive (≤ 16384 cap); no 4096 cut, no suffix.
    expect(schema.description).toBe(desc)
    expect((schema.description as string).length).toBe(LONG_DESC)
  })

  test('MCP tool discovered via tool search is NOT truncated to 4096 (explicit loadedThroughToolSearch)', async () => {
    // Arrange
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-reach-explicit', desc)

    // Act — the official flag passed directly by a call site.
    const schema = await serialize(tool, tools, { loadedThroughToolSearch: true })

    // Assert
    expect(schema.description).toBe(desc)
  })

  test('MCP tool NOT loaded through tool search stays truncated at 4096 + suffix', async () => {
    // Arrange — an always-loaded MCP tool (no defer_loading, not discovered).
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-reach-normal', desc)

    // Act
    const schema = await serialize(tool, tools)

    // Assert — default-cap behavior (4096 since 2.1.296 #061).
    expect(schema.description).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
    expect((schema.description as string).length).toBe(DEFAULT_LIMIT + SUFFIX_LEN)
  })

  test('explicit loadedThroughToolSearch:false keeps the 4096 truncation', async () => {
    // Arrange
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-reach-false', desc)

    // Act
    const schema = await serialize(tool, tools, { loadedThroughToolSearch: false })

    // Assert
    expect(schema.description).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
  })

  test('tool-search cap still truncates a >16384-char description at 16384 + suffix', async () => {
    // Arrange — proves the wider bound is exactly 16384, not unlimited.
    const desc = 'y'.repeat(TOOL_SEARCH_LIMIT + 4000)
    const { tool, tools } = await buildMcpTool('cap295-reach-over', desc)

    // Act
    const schema = await serialize(tool, tools, { deferLoading: true })

    // Assert
    expect(schema.description).toBe('y'.repeat(TOOL_SEARCH_LIMIT) + SUFFIX)
    expect((schema.description as string).length).toBe(
      TOOL_SEARCH_LIMIT + SUFFIX_LEN,
    )
  })

  test('cache key distinguishes forms: the 4096 entry is not reused for the tool-search variant', async () => {
    // Arrange — serialize the SAME tool normally first (caches the 4096 base),
    // then as tool-search-discovered WITHOUT clearing the cache in between.
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-cache-fwd', desc)

    // Act
    const normal = await serialize(tool, tools) // caches under `<name>:<schema>`
    const viaSearch = await serialize(tool, tools, { deferLoading: true }) // `LT:<name>:<schema>`

    // Assert — the second call did NOT return the stale 4096 base.
    expect(normal.description).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
    expect(viaSearch.description).toBe(desc)
  })

  test('cache key distinguishes forms: the 16384 entry is not reused for the normal variant (reverse order)', async () => {
    // Arrange — reverse of the above: tool-search first, then normal.
    const desc = 'x'.repeat(LONG_DESC)
    const { tool, tools } = await buildMcpTool('cap295-cache-rev', desc)

    // Act
    const viaSearch = await serialize(tool, tools, { deferLoading: true })
    const normal = await serialize(tool, tools)

    // Assert
    expect(viaSearch.description).toBe(desc)
    expect(normal.description).toBe('x'.repeat(DEFAULT_LIMIT) + SUFFIX)
  })

  test('non-MCP tool is unaffected by the tool-search flag (isMcp gate)', async () => {
    // Arrange — a plain (non-MCP) tool whose prompt returns a long description
    // verbatim; only MCP tools truncate, and only MCP tools get the LT key bit.
    const longPrompt = 'z'.repeat(LONG_DESC)
    const tool = {
      name: 'PlainTool',
      isMcp: false,
      inputJSONSchema: { type: 'object', properties: {} },
      async prompt() {
        return longPrompt
      },
    } as unknown as Tool
    const tools = [tool] as Tools

    // Act — deferLoading:true must NOT widen/alter a non-MCP tool's description.
    const normal = await serialize(tool, tools)
    const deferred = await serialize(tool, tools, { deferLoading: true })

    // Assert — identical and untruncated (no MCP cap applied to non-MCP tools).
    expect(normal.description).toBe(longPrompt)
    expect(deferred.description).toBe(longPrompt)
  })
})
