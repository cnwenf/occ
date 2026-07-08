# CLI 参考

OCC 命令名为 `occ`（从源码运行时为 `bun run dev`）。它基于 Commander.js，默认启动交互式 REPL，用 `-p`/`--print` 进入非交互管道模式。

```
occ [prompt] [options]
```

`[prompt]` 是可选的位置参数 —— 你的提示词。不提供且未进入管道模式时，启动交互式 REPL。

## 全局选项

### 帮助与调试

| 选项 | 说明 |
|------|------|
| `-h, --help` | 显示帮助 |
| `-d, --debug [filter]` | 启用 debug 模式，可选分类过滤（如 `"api,hooks"` 或 `"!1p,!file"`） |
| `--debug-to-stderr` | 启用 debug 模式（输出到 stderr） |
| `--debug-file <path>` | 将 debug 日志写入指定文件（隐式启用 debug） |
| `--verbose` | 覆盖配置中的 verbose 设置 |

### 输入输出

| 选项 | 说明 |
|------|------|
| `-p, --print` | 打印响应并退出（管道模式）。注意：`-p` 模式跳过工作区信任对话框，仅在信任目录中使用 |
| `--bare` | 最小模式：跳过 hooks、LSP、plugin 同步、归因、自动记忆、后台预取、keychain 读取、CLAUDE.md 自动发现。设置 `CLAUDE_CODE_SIMPLE=1` |
| `--safe-mode` | 安全模式：禁用所有插件、内置技能、hooks。用于排查 |
| `--output-format <format>` | 输出格式（仅 `--print`）：`text`（默认）、`json`、`stream-json` |
| `--input-format <format>` | 输入格式（仅 `--print`）：`text`（默认）、`stream-json` |
| `--json-schema <schema>` | 结构化输出的 JSON Schema（如 `{"type":"object","properties":{"name":{"type":"string"}}}`） |
| `--include-hook-events` | 在输出流中包含所有 hook 生命周期事件（仅 `--output-format=stream-json`） |
| `--include-partial-messages` | 包含到达的部分消息块（仅 `--print` + `--output-format=stream-json`） |
| `--replay-user-messages` | 回显 stdin 的用户消息到 stdout（仅 stream-json 双向模式） |

### 模型与思考

| 选项 | 说明 |
|------|------|
| `--model <model>` | 本次会话的模型。可用别名（`sonnet`、`opus`）或全名（`claude-sonnet-4-6`） |
| `--effort <level>` | effort 级别：`low`、`medium`、`high`、`max` |
| `--agent <agent>` | 本次会话使用的 agent，覆盖 `agent` 设置 |
| `--betas <betas...>` | API 请求中包含的 beta 头（仅 API key 用户） |
| `--fallback-model <model>` | 默认模型过载时自动回退到指定模型（仅 `--print`） |
| `--thinking <mode>` | 思考模式：`enabled`（等价 adaptive）、`adaptive`、`disabled` |
| `--max-thinking-tokens <tokens>` | [已弃用，改用 `--thinking`] 最大思考 token 数（仅 `--print`） |
| `--max-turns <turns>` | 非交互模式最大 agentic turn 数，达到后提前退出（仅 `--print`） |
| `--max-budget-usd <amount>` | API 调用最大美元预算（仅 `--print`） |

### 权限

| 选项 | 说明 |
|------|------|
| `--dangerously-skip-permissions` | 跳过所有权限检查。仅推荐无互联网的沙箱使用 |
| `--allow-dangerously-skip-permissions` | 允许跳过权限检查作为选项（不默认启用） |
| `--dangerously-skip-protected-paths` | 跳过对受保护路径（`.claude/`、`.git/`、`.vscode/`、shell 配置）的权限提示 |
| `--permission-mode <mode>` | 权限模式，可选值见 [权限](./permissions.md) |
| `--allowedTools, --allowed-tools <tools...>` | 允许的工具列表（逗号或空格分隔，如 `"Bash(git:*) Edit"`） |
| `--disallowedTools, --disallowed-tools <tools...>` | 拒绝的工具列表 |
| `--tools <tools...>` | 指定可用工具集合。`""` 禁用全部，`"default"` 用全部，或指定工具名 |
| `--permission-prompt-tool <tool>` | 用于权限提示的 MCP 工具（仅 `--print`） |

### 会话

| 选项 | 说明 |
|------|------|
| `-c, --continue` | 继续当前目录最近的对话 |
| `-r, --resume [value]` | 按 session ID 恢复对话，或带可选搜索词打开交互选择器 |
| `--fork-session` | 恢复时创建新 session ID 而非复用原 ID（与 `--resume`/`--continue` 同用） |
| `--from-pr [value]` | 恢复与某 PR 关联的会话（PR 号/URL），或打开选择器 |
| `--no-session-persistence` | 禁用会话持久化（不保存到磁盘，不可恢复，仅 `--print`） |
| `--resume-session-at <message id>` | 恢复时只到指定 assistant 消息（与 `--resume` 在 print 模式同用） |
| `--rewind-files <user-message-id>` | 将文件恢复到指定 user message 时的状态并退出（需 `--resume`） |
| `--session-id <uuid>` | 使用指定 session ID（必须为合法 UUID） |
| `-n, --name <name>` | 设置会话显示名（显示在 `/resume` 和终端标题） |
| `--prefill <text>` | 预填提示输入但不提交 |

### 上下文与配置

| 选项 | 说明 |
|------|------|
| `--settings <file-or-json>` | 加载额外设置的 JSON 文件路径或 JSON 字符串 |
| `--add-dir <directories...>` | 额外允许工具访问的目录 |
| `--system-prompt <prompt>` | 本次会话使用的 system prompt |
| `--system-prompt-file <file>` | 从文件读取 system prompt |
| `--append-system-prompt <prompt>` | 追加到默认 system prompt |
| `--append-system-prompt-file <file>` | 从文件读取并追加到默认 system prompt |
| `--mcp-config <configs...>` | 从 JSON 文件或字符串加载 MCP 服务器（空格分隔） |
| `--strict-mcp-config` | 只用 `--mcp-config` 的 MCP 服务器，忽略其他 MCP 配置 |
| `--agents <json>` | 定义自定义 agent 的 JSON 对象（如 `'{"reviewer": {"description": "...", "prompt": "..."}}'`） |
| `--agent <agent>` | 覆盖 `agent` 设置 |
| `--setting-sources <sources>` | 加载的设置来源（逗号分隔：`user,project,local`） |
| `--plugin-dir <path>` | 仅本次会话从目录加载插件（可重复：`--plugin-dir A --plugin-dir B`） |
| `--disable-slash-commands` | 禁用所有技能（斜杠命令） |
| `--ide` | 启动时若恰好有一个有效 IDE 则自动连接 |
| `--file <specs...>` | 启动时下载的文件资源，格式 `file_id:relative_path` |
| `-w, --worktree [name]` | 为本次会话创建新的 git worktree（可选指定名称） |
| `--tmux` | 为 worktree 创建 tmux 会话（需 `--worktree`）。`--tmux=classic` 用传统 tmux |

### worktree 与 teammate（隐藏）

`--worktree` 配合以下隐藏选项用于多代理 worktree 隔离场景：

| 选项 | 说明 |
|------|------|
| `--agent-id <id>` | 代理 ID |
| `--agent-name <name>` | 代理显示名 |
| `--team-name <name>` | 团队名 |
| `--agent-color <color>` | 代理颜色 |
| `--teammate-mode <mode>` | teammate 模式：`auto`/`tmux`/`in-process` |
| `--agent-type <type>` | 代理类型 |
| `--parent-session-id <id>` | 父会话 ID |
| `--parent-agent-id <id>` | 父代理 ID |
| `--plan-mode-required` | 强制 plan 模式 |

详见 [子代理](./sub-agents.md)。

### Chrome 集成

| 选项 | 说明 |
|------|------|
| `--chrome` | 启用 Claude in Chrome 集成 |
| `--no-chrome` | 禁用 Claude in Chrome 集成 |

### 初始化与维护（隐藏）

这些选项在 `--help` 中隐藏，主要用于 hook/SDK 流程：

| 选项 | 说明 |
|------|------|
| `--init` | 运行 Setup hooks（init 触发器），然后继续 |
| `--init-only` | 运行 Setup 与 SessionStart:startup hooks，然后退出 |
| `--maintenance` | 运行 Setup hooks（maintenance 触发器），然后继续 |
| `--enable-auth-status` | 在 SDK 模式启用认证状态消息 |

## 子命令

OCC 注册了若干子命令。常见子命令也可作为斜杠命令在 REPL 内使用。

### `occ mcp`

MCP 服务器管理。子命令包括 `occ mcp add`（添加服务器）、`occ mcp serve`（将 OCC 作为 MCP 服务器运行，暴露 `/review` 等为工具）。详见 [MCP](./mcp.md)。

```bash
occ mcp add <name> <commandOrUrl> [args...]   # 添加 MCP 服务器（-s/--scope, -t/--transport stdio|sse|http）
occ mcp add-json <name> <json>                # 从 JSON 添加
occ mcp add-from-claude-desktop               # 从 Claude Desktop 导入
occ mcp remove <name>                         # 移除
occ mcp list                                  # 列出
occ mcp get <name>                            # 查看详情
occ mcp serve                                 # OCC 作为 MCP 服务器
```

### `occ daemon`

后台代理守护进程管理（详见 [守护进程](./daemon.md)）：

```bash
occ daemon start         # 启动（默认）
occ daemon stop          # 停止（--any/-a 停所有）
occ daemon restart
occ daemon status
occ daemon logs
occ daemon install       # 安装为系统服务
occ daemon uninstall
occ daemon remote-control
occ daemon scheduled add <task-id> --schedule <cron> --prompt <text>  # 定时任务
occ daemon scheduled list
```

### `occ auth`

认证管理：

```bash
occ auth login [--email|--sso|--console|--claudeai]
occ auth status [--json|--text]
occ auth logout
```

### 其他子命令

| 子命令 | 说明 |
|--------|------|
| `occ agents` | 后台会话仪表盘（`--json`、`--definitions`） |
| `occ project purge [path]` | 清理项目状态（`--dry-run`、`--all`、`-i`） |
| `occ doctor` | 诊断检查（等价 REPL 内 `/doctor`） |
| `occ update` / `occ upgrade` | 检查并安装更新 |
| `occ install [target]` | 安装原生构建（`--force`） |
| `occ plugin` | 插件管理（OCC 中为最小实现：`list`/`validate`/`marketplace`/`install`/`uninstall`） |
| `occ server` | 启动会话服务器（`--port`、`--host`、`--auth-token`、`--unix`、`--workspace`） |
| `occ ssh <host> [dir]` | SSH 到远程主机运行（`--permission-mode`、`--local`） |
| `occ stop <id>` / `occ attach <id>` / `occ logs <id>` | 后台会话管理 |
| `occ completion <shell>` | 生成 shell 补全（bash/zsh/fish，`--output`） |
| `occ remote-control` / `occ rc` | 远程控制连接（见 [远程控制](./remote-control.md)） |
| `occ auto-mode` | auto mode 分类器配置（`defaults`/`config`/`critique`） |
| `occ setup-token` | 设置长期 auth token |

## 深度链接与远程

| 形式 | 说明 |
|------|------|
| `cc://...` / `cc+unix://...` URL | 在 argv 中检测到时重写为主命令，提供完整 TUI；headless 模式重写为内部 `open` 子命令 |
| `occ ssh <host> [dir]` | SSH 到远程主机运行（从 argv 剥离后交主命令处理） |
| `--teleport` | teleport 选项（内部） |
| `--remote` / `--remote-control` | 远程 SDK / 远程控制选项，见 [远程控制](./remote-control.md) |

## 管道模式示例

```bash
# 简单管道
echo "explain this function" | occ -p

# 带结构化输出
occ -p --output-format json "list files in src/"

# 流式 JSON
occ -p --output-format stream-json "refactor this" | jq .

# 限制 turn 数与预算
occ -p --max-turns 5 --max-budget-usd 1.0 "fix the failing test"

# 指定模型与 effort
occ -p --model sonnet --effort high "review this PR"
```

## 退出码

- `0` —— 正常完成。
- 非零 —— 出错（如 API 错误、权限拒绝、预算/turn 超限）。

管道模式中，`--max-turns` 提前退出与 `--max-budget-usd` 超限会以非零码退出。

## 环境变量

主要的运行时环境变量（详见 [配置](./settings.md)）：

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic 直连 API Key |
| `CLAUDE_CODE_USE_BEDROCK` | 设为 `1` 启用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 设为 `1` 启用 Google Vertex |
| `CLAUDE_CODE_USE_FOUNDRY` | 设为 `1` 启用 Azure Foundry |
| `AWS_REGION` / `AWS_*` | AWS 凭据链 |
| `CLOUD_ML_REGION` / `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex 配置 |
| `CLAUDE_CODE_SIMPLE` | `--bare` 模式设置，简化启动 |
| `MAX_THINKING_TOKENS` | 限制思考 token 预算 |
| `FEATURE_ALLOWLIST` | （仅源码）`src/utils/featureFlags.ts` 中的白名单 |

## 下一步

- [斜杠命令](./slash-commands.md) —— REPL 内的 `/` 命令。
- [工具](./tools.md) —— 所有工具。
- [配置](./settings.md) —— settings.json 详解。
