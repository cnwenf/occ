# MCP

OCC 通过 Model Context Protocol（MCP）接入外部工具与资源。OCC 既能作为 MCP **客户端**连接外部服务器，也能作为 MCP **服务器**把自身工具暴露给其他应用。

## 概念

MCP 是一个开放协议，让 LLM 应用与外部工具/数据源通信。在 OCC 中：

- **作为客户端**：连接 MCP 服务器（如数据库、API、文件系统工具），其工具会出现在 OCC 的工具列表中，模型可调用。
- **作为服务器**：把 OCC 的内置工具与命令暴露给其他 MCP 客户端（如编辑器、其他 agent）。

## 配置位置

MCP 服务器按"作用域"（scope）配置，定义在 `src/services/mcp/config.ts`、`types.ts`：

| 作用域 | 存储位置 | 说明 |
|--------|----------|------|
| `project` | 项目根及各父目录的 `.mcp.json`（`mcpServers` 键） | 随仓库提交，团队共享 |
| `user` | `~/.claude.json` 的 `mcpServers` 键 | 全局，所有项目 |
| `local` | 项目本地配置（`getCurrentProjectConfig().mcpServers`） | 不提交 |
| `enterprise` | managed 路径下的 `managed-mcp.json` | 企业策略，存在时**独占控制**，忽略其他作用域 |
| `claudeai` | 通过 OAuth 从 claude.ai 获取 | 云端连接器 |
| `plugin` | 插件命名空间 `plugin:<pluginName>:<serverName>` | 随插件分发 |

加载优先级：父目录 `.mcp.json` → 子目录（靠近 CWD 的覆盖远的）。

### .mcp.json 示例

```jsonc
// .mcp.json
{
  "mcpServers": {
    "my-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgres://..."
      }
    },
    "my-api": {
      "type": "http",
      "url": "https://my-mcp-server.example.com/mcp"
    }
  }
}
```

### 服务器类型

支持的服务器配置类型（`McpServerConfigSchema`）：

| 类型 | 说明 |
|------|------|
| `stdio` | 启动子进程，通过 stdin/stdout 通信（`command`/`args`/`env`） |
| `sse` | Server-Sent Events HTTP 传输 |
| `sse-ide` | IDE 集成的 SSE |
| `ws` / `ws-ide` | WebSocket 传输 |
| `http` | 流式 HTTP 传输 |
| `sdk` | 进程内 SDK 传输 |
| `claudeai-proxy` | claude.ai 云端代理 |

所有类型支持 `alwaysLoad`（跳过工具搜索延迟，立即加载）。

## 项目服务器信任

项目级 `.mcp.json` 服务器在启动前需要用户信任审批 —— 连接状态为 `needs-approval`，用 `/mcp` 批准后才启动。这是防止恶意仓库通过 `.mcp.json` 自动执行代码的安全机制。

用 `enableAllProjectMcpServers: true` 自动批准所有项目服务器（不推荐用于不可信仓库）。`enabledMcpjsonServers` / `disabledMcpjsonServers` 精确控制。

## /mcp 命令

REPL 内管理 MCP 服务器：

```bash
> /mcp                    # 打开管理界面
> /mcp enable <name>      # 启用某服务器
> /mcp disable <name>     # 禁用某服务器
```

## CLI 子命令

```bash
# 添加 stdio 服务器
occ mcp add <name> <commandOrUrl> [args...] \
  -s/--scope <local|user|project> \
  -t/--transport <stdio|sse|http> \
  -e/--env KEY=VALUE \
  --header "X-Custom: value"

# 从 JSON 添加
occ mcp add-json <name> '<json>' -s/--scope <scope>

# 从 Claude Desktop 导入
occ mcp add-from-claude-desktop -s/--scope <scope>

# 列出 / 查看 / 移除
occ mcp list
occ mcp get <name>
occ mcp remove <name> -s/--scope <scope>
```

## --mcp-config 参数

```bash
# 从文件或 JSON 字符串加载（空格分隔多个）
occ --mcp-config ./servers.json
occ --mcp-config '{"my-server":{"command":"node","args":["srv.js"]}}'

# 只用命令行指定的，忽略其他配置
occ --mcp-config ./servers.json --strict-mcp-config
```

## MCP 相关工具

OCC 向模型暴露这些 MCP 工具（`src/tools/`）：

| 工具 | 作用 |
|------|------|
| `MCPTool` | 调用已连接 MCP 服务器暴露的工具 |
| `ListMcpResourcesTool` | 列出 MCP 服务器暴露的资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源 |
| `ReadMcpResourceDirTool` | 读取 MCP 资源目录 |
| `McpAuthTool` | 处理 MCP OAuth 认证流程 |

## OCC 作为 MCP 服务器

`src/entrypoints/mcp.ts` 实现 `startMCPServer(cwd, debug, verbose)`：

- 服务器名 `claude/tengu`，版本取自 `MACRO.VERSION`。
- 用 `@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport`（仅 stdio 传输）。
- 处理 `ListToolsRequestSchema` 与 `CallToolRequestSchema`。
- 暴露**所有**内置工具（通过 `getTools` + `zodToJsonSchema` 转换 schema）。
- 唯一注入的命令是 `review`（`MCP_COMMANDS = [review]`），即 `/review` 作为 MCP 工具可用。
- 构建非交互 `ToolUseContext`（无共享 AppState，thinking 禁用）。

```bash
# 将 OCC 作为 MCP 服务器运行
occ mcp serve

# 带 debug
occ mcp serve -d
```

这让其他 MCP 客户端（编辑器、自动化脚本）能调用 OCC 的 Bash、Read、Edit 等工具与 `/review` 命令。

## MCP 技能

`MCP_SKILLS` feature flag（OCC 已启用）：从声明 `io.modelcontextprotocol/skills` 扩展的 MCP 服务器获取技能模块。通过 `src/services/mcp/client.ts` + `useManageMCPConnections.ts` 接线，仅在连接了 MCP 服务器时运行（无服务器时不阻塞）。详见 [技能](./skills.md)。

## 调试

```bash
# 启用 MCP debug（推荐）
occ --debug mcp

# 旧式（已弃用）
occ --mcp-debug
```

## 企业策略

| 设置键 | 作用 |
|--------|------|
| `allowedMcpServers` | 企业 MCP 允许列表（按名/命令/URL） |
| `deniedMcpServers` | 企业 MCP 拒绝列表 |
| `allowManagedMcpServersOnly` | 只允许 managed 设置中的 MCP 服务器 |
| `allowAllClaudeAiMcps` | 加载 claude.ai 云端 MCP 连接器 |

## 与 Claude Code 的差异

OCC 的 MCP 实现与 Claude Code 对齐。差异：

- **OAuth 简化**：MCP OAuth 流程已简化（部分云端连接器可能不可用）。
- **claude.ai 连接器**：`claudeai` 作用域依赖 OAuth，在 OCC 中可能受限。
- **遥测**：MCP 连接事件不上报到远程服务。

## 下一步

- [技能](./skills.md) —— MCP_SKILLS 与技能系统。
- [CLI 参考](./cli-reference.md) —— `occ mcp` 子命令。
- [配置](./settings.md) —— MCP 相关设置键。
