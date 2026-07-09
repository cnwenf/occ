# MCP (Model Context Protocol)

OCC connects to external tools via [Model Context Protocol](https://modelcontextprotocol.io/) servers. MCP servers expose tools, resources, and prompts that OCC can call. You can also run OCC itself as an MCP server.

## Configuration

MCP servers are configured in JSON, loaded from several scopes (merge order, low→high: plugin < user < project < local):

| Scope | Location | Notes |
|---|---|---|
| Project | `.mcp.json` in cwd (traversed up to root) | Requires trust approval unless `enableAllProjectMcpServers` |
| User | `~/.claude.json` `mcpServers` key | Personal servers |
| Local | `~/.claude/projects/<sanitized-cwd>/...` | Project-local |
| Enterprise | `<managed-path>/managed-mcp.json` | Exclusive control when present |
| claude.ai | cloud connectors (OAuth) | Lowest precedence |
| Plugin | plugin `mcp/` dir | Namespaced `plugin:<name>:<server>` |

### Server config formats

**stdio** (spawns a subprocess):

```json
{
  "mcpServers": {
    "my-database": {
      "command": "npx",
      "args": ["@my-org/db-mcp-server"],
      "env": { "DB_URL": "postgres://..." },
      "alwaysLoad": true
    }
  }
}
```

**http** (StreamableHTTP):

```json
{
  "sentry": {
    "type": "http",
    "url": "https://mcp.sentry.dev/mcp",
    "headers": { "Authorization": "Bearer $TOKEN" }
  }
}
```

**sse**:

```json
{
  "slack": { "type": "sse", "url": "https://mcp.slack.com/sse" }
}
```

**ws** (WebSocket), **sse-ide**/**ws-ide** (IDE), and **sdk** (SDK-managed) transports are also supported.

OAuth config (optional): `{ "oauth": { "clientId", "callbackPort", "authServerMetadataUrl" } }`.

### `.mcp.json` example

```json
{
  "mcpServers": {
    "my-database": {
      "command": "npx",
      "args": ["@my-org/db-mcp-server"],
      "env": { "DB_URL": "postgres://..." }
    },
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp"
    }
  }
}
```

## CLI: `occ mcp`

```bash
occ mcp add <name> <commandOrUrl> [args...]   # add a server
occ mcp add-json <name> <json> [-s scope]     # add from a JSON string
occ mcp list                                  # list configured servers
occ mcp get <name>                            # show a server's details
occ mcp remove <name> [-s scope]              # remove a server
occ mcp add-from-claude-desktop [-s scope]    # import from Claude Desktop (Mac/WSL)
occ mcp reset-project-choices                 # reset .mcp.json approvals
occ mcp serve                                 # start OCC as an MCP server
```

`occ mcp add` options: `-s/--scope` (local|user|project, default local), `-t/--transport` (stdio|sse|http), `-e/--env` (KEY=VALUE), `-H/--header` (Header:Value), `--client-id`, `--client-secret`, `--callback-port`. Use `--` to separate subprocess flags.

## REPL: `/mcp`

```
> /mcp                        # open the MCP settings panel
> /mcp reconnect <server>     # reconnect a server
> /mcp enable [server|all]    # enable a server (or all)
> /mcp disable [server|all]   # disable a server
```

## CLI flags

```bash
occ --mcp-config servers.json          # load servers from a file or JSON string
occ --mcp-config a.json b.json         # space-separated, multiple files
occ --strict-mcp-config                # ignore all other MCP configurations
```

`--mcp-config` servers pass through policy filtering (name/command/URL allow+deny).

## Connection states

An MCP server connection is one of: `connected`, `failed`, `needs-auth`, `pending`, `needs-approval` (project `.mcp.json` awaiting trust), `disabled`. Project servers require trust approval unless `enableAllProjectMcpServers` is set or they're listed in `enabledMcpjsonServers`.

## MCP tools

Tools exposed by MCP servers are named `mcp__<server>__<tool>`. They behave like built-in tools — they go through the same permission system. The base `MCPTool` template (`src/tools/MCPTool/`) is cloned per server tool.

Resource tools:

| Tool | Description |
|---|---|
| `ListMcpResourcesTool` | List resources from configured MCP servers |
| `ReadMcpResourceTool` | Read a specific resource (`server`, `uri`) |
| `ReadMcpResourceDirTool` | List children of a directory resource |

When a server needs auth, an `mcp__<server>__authenticate` pseudo-tool appears to start the OAuth flow.

## Roots

OCC declares the `roots` capability (with `listChanged`) to connected MCP servers. The `roots/list` response includes the session's original working directory plus any additional working directories added via `/add-dir` or permission grants — each as a `file://` URI. When the set of roots changes (e.g. a new directory is added with `/add-dir`), OCC sends a `notifications/roots/list_changed` so servers can re-fetch `roots/list`.

## MCP_SKILLS

The `MCP_SKILLS` feature flag (live in OCC) fetches skill modules from MCP servers that declare the `io.modelcontextprotocol/skills` extension. This is non-blocking when no MCP server is connected. See [Skills](./skills.md).

## Policy & security

Settings keys for MCP policy:

| Key | Purpose |
|---|---|
| `enableAllProjectMcpServers` | Auto-approve all `.mcp.json` servers |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | Per-server enable/disable |
| `allowedMcpServers` | Allowlist of `{serverName}` / `{serverCommand}` / `{serverUrl}` |
| `deniedMcpServers` | Denylist (takes precedence over allowlist) |
| `allowManagedMcpServersOnly` | Only managed servers (policy only) |
| `allowAllClaudeAiMcps` | Load claude.ai connectors alongside managed config |

`isMcpServerAllowedByPolicy` checks deny→allow (name, then command for stdio, then URL pattern for remote). SDK-type servers are exempt from policy gating.

## Running OCC as an MCP server

```bash
occ mcp serve
```

This starts an MCP `Server` (name `claude/tengu`) over `StdioServerTransport`. It exposes OCC's built-in tools via `ListToolsRequest` (converting Zod schemas to JSON schema) and handles `CallToolRequest` with permission gating. Currently `/review` is exposed as an MCP command.

## Related

- [Tools](./tools.md) — built-in tools and MCP tool naming
- [Settings](./settings.md) — MCP policy keys
- [Skills](./skills.md) — `MCP_SKILLS` flag
