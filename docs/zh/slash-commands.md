# 斜杠命令

在 REPL 输入框中输入 `/` 触发斜杠命令。OCC 实现了数十个命令，覆盖模型切换、配置、权限、会话管理、后台任务等。

> 命令注册表在 `src/commands.ts` 的 `COMMANDS()` 数组。`INTERNAL_ONLY_COMMANDS`（ant 专用）在 OCC 中不注册。

## 命令类型

| 类型 | 说明 |
|------|------|
| `local` | 本地执行，不涉及模型 |
| `local-jsx` | 本地执行并渲染 Ink 组件 |
| `prompt` | 展开为 prompt 注入对话（类似技能，`source: 'builtin'`） |

## 模型与配置

| 命令 | 别名 | 说明 |
|------|------|------|
| `/model` | — | 切换 AI 模型（sonnet/opus 等，显示当前模型） |
| `/effort` | — | 设置 effort 级别（`low`/`medium`/`high`/`max`/`ultracode`/`auto`） |
| `/config` | `/settings` | 打开配置面板；`-p` 模式可设 `key=value` |
| `/theme` | — | 切换主题 |
| `/status` | — | 显示版本、模型、账户、API 连接、工具状态 |
| `/usage` | `/cost`、`/stats` | 显示会话成本、plan 用量、活动统计 |
| `/login` | — | 登录 Anthropic 账户（仅非第三方 provider 时注册） |
| `/logout` | — | 登出（仅非第三方 provider 时注册） |
| `/upgrade` | — | 升级到 Max 获取更高限额（仅 claude.ai 订阅者） |

## 权限与安全

| 命令 | 别名 | 说明 |
|------|------|------|
| `/permissions` | `/allowed-tools` | 管理 allow/deny 工具权限规则 |
| `/hooks` | — | 查看工具事件的 hook 配置 |
| `/keybindings` | — | 打开/创建键位配置文件（`~/.claude/keybindings.json`） |
| `/less-permission-prompts` | — | 扫描历史，生成 allow 规则减少权限提示 |

## 上下文与记忆

| 命令 | 别名 | 说明 |
|------|------|------|
| `/init` | — | 生成 CLAUDE.md 草稿（分析项目）。NEW_INIT 变体还生成 skills/hooks |
| `/memory` | — | 在编辑器中打开记忆文件 |
| `/pause-memory` | — | 暂停/恢复 CLAUDE.md 与记忆文件加载（toggle） |
| `/context` | — | 可视化当前上下文用量（彩色网格）；`-p` 模式显示文本 |
| `/add-dir` | — | 添加工作目录（`<path>`） |
| `/compact` | — | 压缩上下文（摘要对话释放空间） |
| `/clear` | `/reset`、`/new` | 开新会话清空上下文（旧会话保留可 `/resume`） |

## 会话管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/resume` | `/continue` | 恢复历史会话（`[id 或搜索词]`） |
| `/branch` | — | 在当前点创建会话分支（`[name]`）。`/fork` 未启用时 `fork` 是其别名 |
| `/rewind` | `/checkpoint`、`/undo` | 恢复代码和/或对话到先前检查点（可从 `/clear` 前恢复） |
| `/export` | — | 导出当前对话到文件或剪贴板（`[filename]`） |
| `/fork` | — | 派生继承完整对话的后台代理。默认禁用（需 `CLAUDE_CODE_FORK_SUBAGENT=1`） |

## 规划与审查

| 命令 | 别名 | 说明 |
|------|------|------|
| `/plan` | — | 启用 plan 模式或查看当前会话计划（`[open|<描述>]`） |
| `/review` | — | 审查 GitHub PR（工作 diff 用 `/code-review`）。prompt 型内置 |
| `/code-review` | — | 多代理代码审查，可选 effort 级别（`low`/`medium`/`high`/`xhigh`/`max`，默认 `high`）。目标可为 PR 号、分支名或省略（审查当前工作 diff）。`--fix` 应用已验证的发现；`--comment` 作为 PR 内联评论发布。示例：`/code-review high 1234` 审查 PR #1234；`/code-review max --fix 1234` 审查并修复 |
| `/security-review` | — | 安全审查当前分支的待提交变更。已"迁移到插件" `security-review@claude-code-marketplace` |
| `/doctor` | — | 诊断并校验安装与设置 |

## 后台任务与守护进程

| 命令 | 别名 | 说明 |
|------|------|------|
| `/daemon` | — | 管理后台代理守护进程（`install|status|stop|logs|scheduled`） |
| `/stop` | — | 按 ID 或 pid 停止后台代理/会话（`[id|pid]`） |
| `/background` | — | 将当前任务移到后台 daemon worker |
| `/tasks` | `/bashes` | 列出并管理后台任务 |

详见 [守护进程](./daemon.md)。

## 工作流与代理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/workflows` | — | 浏览运行中和已完成的 workflow（需 `WORKFLOW_SCRIPTS`，已启用） |
| `/goal` | — | 设定目标，Claude 停止前检查是否达成（`[<条件> \| clear]`）。注册会话级 Stop hook |
| `/agents` | — | stub（2.1.198 向导已移除）。提示让 Claude 创建/管理子代理或编辑 `.claude/agents/` |

详见 [Workflow](./workflows.md) 与 [子代理](./sub-agents.md)。

## MCP 与技能

| 命令 | 别名 | 说明 |
|------|------|------|
| `/mcp` | — | 管理 MCP 服务器（`[enable|disable [server-name]]`） |
| `/skills` | — | 列出可用技能 |
| `/reload-skills` | — | 重新加载技能（拾取磁盘变更） |
| `/skill-doctor` | — | 诊断技能 SKILL.md 加载问题 |
| `/plugin` | `/plugins`、`/marketplace` | 管理插件（OCC 中为最小实现） |

## 其他

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help` | — | 显示帮助与可用命令 |
| `/exit` | `/quit` | 退出 REPL |
| `/update` | — | 更新 OCC 到最新版本 |
| `/feedback` | `/bug` | 提交反馈 —— 在 `cnwenf/occ` 开 GitHub issue（OCC 定制，用 `gh`） |
| `/dataviz` | — | 数据可视化技能（prompt 型，映射 `dataviz` 技能） |
| `/insights` | — | 生成 Claude Code 会话分析报告 |

## 禁用 / Stub 命令

以下命令在 OCC 中**未注册**或为 stub：

| 命令 | 原因 |
|------|------|
| `/agents` | stub（向导已移除） |
| `/share` | 空 stub，ant 专用 |
| `/teleport` | stub（`isEnabled: () => false`），ant 专用 |
| `/peers` | 自动生成 stub，需 `UDS_INBOX`（关闭） |
| `/remoteControlServer` | stub，需 `DAEMON && BRIDGE_MODE`（均关闭） |
| `/version` | ant 专用（`isEnabled: USER_TYPE === 'ant'`） |
| `/fork` | 默认禁用（需 `CLAUDE_CODE_FORK_SUBAGENT=1`） |
| `/remote-env` | 需 claude.ai 订阅 + 策略允许 |

ant 专用命令（`INTERNAL_ONLY_COMMANDS`，OCC 不注册）：`/commit`、`/commit-push-pr`、`/bughunter`、`/good-claude`、`/issue`、`/summary`、`/share`、`/teleport`、`/version`、`/onboarding`、`/env`、`/ctx_viz`、`/break-cache`、`/mock-limits`、`/reset-limits`、`/oauth-refresh`、`/debug-tool-call`、`/agents-platform`、`/ant-trace`、`/perf-issue`、`/init-verifiers`、`/bridge-kick`、`/backfill-sessions` 等。

## prompt 型命令与技能

`type: 'prompt'` 的命令展开为 prompt 注入对话，行为类似技能（`source: 'builtin'`）：

- `/init` —— 其流程会调用 `update-config` 技能生成 hooks。
- `/review`、`/security-review` —— 展开 code-review / security-review prompt。
- `/less-permission-prompts` —— 概念上映射 `fewer-permission-prompts` 技能。
- `/dataviz` —— 映射 `dataviz` 技能。
- `/skill-doctor` —— 诊断 SKILL.md。

`/security-review` 已"迁移到插件"（`security-review@claude-code-marketplace`）：ant 用户获安装指引，外部用户获本地回退 prompt。

## 管道模式中的命令

部分命令支持 `-p` 非交互变体（`supportsNonInteractive`）：`/pause-memory`、`/daemon`、`/stop`、`/compact`、`/update`、`/feedback`、`/config`（`configNonInteractive` 设 `key=value`）、`/usage`（`usageNonInteractive`）、`/context`。

## 下一步

- [工具](./tools.md) —— 模型可调用的工具。
- [配置](./settings.md) —— `/config` 管理的设置项。
- [快捷键](./keybindings.md) —— `/keybindings` 自定义键位。
