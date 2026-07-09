# MCP Integration

OCC connects to Model Context Protocol (MCP) servers, exposing their tools,
resources, and prompts to the agent. MCP servers can be stdio processes, HTTP
endpoints, SSE streams, WebSockets, or in-process linked transports. This
document covers the client, config scoping, the MCPTool wrapper, and OCC's own
MCP-server mode.

## The MCP client — `src/services/mcp/client.ts`

**`connectToServer(name, serverRef, serverStats?)`** is the memoized connection
factory (lodash `memoize` via `getServerCacheKey`). It builds the right
transport per `serverRef.type`, creates an `@modelcontextprotocol/sdk` `Client`
with capabilities `{roots:{listChanged:true}, elicitation:{}}`, races
`client.connect(transport)` against a `getConnectionTimeoutMs()` timeout
(default 30000ms, env `MCP_TIMEOUT`). Returns a discriminated
`MCPServerConnection`: `'connected' | 'needs-auth' | 'needs-approval' |
'failed'`.

The client declares `roots.listChanged: true` and registers a
`ListRootsRequestSchema` handler returning `getMcpRoots()`, so `/add-dir` (and
other roots changes) push a `notifications/roots/list_changed` to connected
servers (2.1.203). A server `ref` that supplies a `url` without a `type` is
rejected up front with a clear "url requires a type" error rather than
misrouting to the stdio transport.

### Transports supported

| `serverRef.type` | Transport |
|---|---|
| `'sse'` | `SSEClientTransport` with `ClaudeAuthProvider`, fetch timeout/Step-Up wrappers |
| `'sse-ide'` | `SSEClientTransport` (IDE, no auth) |
| `'http'` | `StreamableHTTPClientTransport` with auth provider, session-ingress bearer |
| `'ws'` / `'ws-ide'` | custom `WebSocketTransport` (`src/utils/mcpWebSocketTransport.ts`), protocol `['mcp']` |
| `'claudeai-proxy'` | `StreamableHTTPClientTransport` to the claude.ai MCP proxy URL |
| `'stdio'` (or no type) | `StdioClientTransport` spawning `command` with env including `CLAUDE_PROJECT_DIR`, `CLAUDECODE=1` |
| in-process | `createLinkedTransportPair` from `InProcessTransport.ts` (Chrome MCP, Computer Use MCP) |

### Tool/resource/commands fetching

`fetchToolsForClient`, `fetchResourcesForClient`, `fetchCommandsForClient` —
`memoizeWithLRU` (size 20) wrappers calling `tools/list`, `resources/list`,
`prompts/list` with pagination (`nextCursor`) and retry
(`requestToolsListWithRetry`, 3 attempts).

Other exports: `ensureConnectedClient` (re-resolves stale clients),
`reconnectMcpServerImpl`, `clearServerCache`, `areMcpConfigsEqual`,
`resolveMcpMaxResultSizeChars` (ceiling `MCP_MAX_RESULT_SIZE_CHARS_CEILING =
500_000`), `getMcpServerConnectionBatchSize` (default 3).

## MCPTool — `src/tools/MCPTool/MCPTool.ts`

A stub `Tool` built with `buildTool`: `name: 'mcp'`, `inputSchema =
z.object({}).passthrough()`, `isMcp: true`. All fields (`name`, `description`,
`prompt`, `call`, `userFacingName`) are **overridden in client.ts** per-server
when `fetchToolsForClient` maps each MCP tool to the `Tool` shape:

- spread `...MCPTool`, then override.
- `name` via `buildMcpToolName` → `mcp__<server>__<tool>`.
- `mcpInfo: { serverName, toolName }`.
- `call` → `callMCPToolWithUrlElicitationRetry`.
- `inputJSONSchema` (raw JSON Schema, not Zod).
- annotation-derived flags: `isReadOnly` from `readOnlyHint`,
  `isDestructive` from `destructiveHint`.
- `_meta`-driven `maxResultSizeChars` / `searchHint` / `alwaysLoad`.

## Config scoping — `src/services/mcp/config.ts`

**`getClaudeCodeMcpConfigs()`** loads configs in precedence order (low → high):
`plugin < user < project < local`. Applies `isMcpServerAllowedByPolicy`
filtering. Project servers pending approval return `needs-approval`; only
`approved` servers are included.

| Scope | Source |
|---|---|
| `project` | `.mcp.json` traversed from cwd up to root (closer-to-cwd wins) |
| `user` | `getGlobalConfig().mcpServers` |
| `local` | `getCurrentProjectConfig().mcpServers` |
| `enterprise` | `<managedPath>/managed-mcp.json` (exclusive if exists) |

`.mcp.json` is loaded from the current working directory; `writeMcpjsonFile`
does atomic temp-file + `rename`. Other exports: `addMcpConfig`,
`removeMcpConfig`, `setMcpServerEnabled`, `parseMcpConfig`,
`filterMcpServersByPolicy`, `getMcpServerSignature`.

## Connection management — `useManageMCPConnections.ts`

The React hook orchestrating connections: exponential backoff reconnection
(`MAX_RECONNECT_ATTEMPTS=5`, `INITIAL_BACKOFF_MS=1000`,
`MAX_BACKOFF_MS=30000`), handles `ToolListChangedNotificationSchema` /
`ResourceListChangedNotificationSchema` / `PromptListChangedNotificationSchema`,
channel permissions, elicitation handler registration. Exposed via
`MCPConnectionManager.tsx` (React context) → `useMcpReconnect()` /
`useMcpToggleEnabled()`.

## OCC as an MCP server — `src/entrypoints/mcp.ts`

`startMCPServer(cwd, debug, verbose)` creates a `Server` (name
`claude/tengu`) with `StdioServerTransport`. It:

- Handles `ListToolsRequestSchema` — exposes all `getTools()` (the builtin
  tool pool), converting `inputSchema`/`outputSchema` via `zodToJsonSchema`.
- Handles `CallToolRequestSchema` — looks up a tool by name, builds a
  non-interactive `ToolUseContext` (`setAppState: () => {}`, `getAppState:
  () => getDefaultAppState()`, `isNonInteractiveSession: true`,
  `thinkingConfig: {type:'disabled'}`, `mcpClients: []`), calls `tool.call`.
- Exposes `MCP_COMMANDS = [review]`.

## MCP skills

When `feature('MCP_SKILLS')` is on (live), OCC fetches skill modules exposed
by MCP servers that declare the `io.modelcontextprotocol/skills` extension.
Wired through `src/services/mcp/client.ts` + `useManageMCPConnections.ts`;
runs only when an MCP server is connected.

## `/mcp` command — `src/commands/mcp/`

Registers a `local-jsx` command `mcp` with `argumentHint: '[enable|disable
[server-name]]'`. Args:

- `no-redirect` / default → `<MCPSettings>`.
- `reconnect <name>` → `<MCPReconnect>`.
- `enable|disable [target]` → `<MCPToggle>` (uses `useMcpToggleEnabled()` +
  `useAppState(s=>s.mcp.clients)`).

## Key files

| File | Role |
|---|---|
| `src/services/mcp/client.ts` | `connectToServer`, `fetchToolsForClient`, transport selection |
| `src/services/mcp/config.ts` | `getClaudeCodeMcpConfigs`, scoping, `.mcp.json` |
| `src/services/mcp/types.ts` | `ScopedMcpServerConfig`, `MCPServerConnection`, `ConfigScope` |
| `src/services/mcp/MCPConnectionManager.tsx` | React context provider |
| `src/services/mcp/useManageMCPConnections.ts` | Connection orchestration hook |
| `src/services/mcp/auth.ts` | `ClaudeAuthProvider`, Step-Up detection |
| `src/services/mcp/InProcessTransport.ts` | `createLinkedTransportPair` |
| `src/tools/MCPTool/MCPTool.ts` | The stub Tool wrapped per-server |
| `src/entrypoints/mcp.ts` | OCC as an MCP server |
| `src/commands/mcp/` | `/mcp` command |
| `src/utils/mcp/` | `dateTimeParser`, `elicitationValidation` |
