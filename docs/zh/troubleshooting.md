# 故障排查

本章涵盖 OCC 常见问题与排查方法。

## /doctor 诊断

OCC 内置诊断命令，检查环境、配置、API 连接等：

```bash
# REPL 内
> /doctor

# 命令行直接运行
occ doctor
```

`/doctor` 会检查并报告各项健康指标。诊断界面定义在 `src/screens/Doctor.tsx`。

如果启动失败或行为异常，先跑 `/doctor`。

## 常见问题

### Bun 版本过旧

**症状**：启动时报各种莫名错误。

**原因**：OCC 需要 Bun >= 1.3.11。旧版 Bun 产生误报错误。

**解决**：

```bash
bun upgrade
bun --version   # 验证 >= 1.3.11
```

### API 凭据未配置或无效

**症状**：启动后无法获得响应，或报认证错误。

**排查**：

```bash
# Anthropic 直连
echo $ANTHROPIC_API_KEY   # 应为 sk-ant-...

# 管道模式冒烟测试
echo "say hello" | occ -p
```

如果用 Bedrock/Vertex/Foundry，确认对应的环境变量已设置（见 [安装](./installation.md)）。也可用 `/setup-bedrock`、`/setup-vertex` 交互式配置。

### 退出码与管道模式提前退出

**症状**：管道模式中以非零码退出。

**原因**：

- `--max-turns` 达到上限 —— 对话被提前截断。
- `--max-budget-usd` 超限 —— 预算用尽。
- API 错误或权限拒绝。

**解决**：调大限制，或检查权限设置。

### tsc 类型错误（非问题）

**症状**：IDE 中显示大量红色波浪线 / `tsc` 报约 1300 个错误。

**说明**：这是**预期现象**，不影响运行时。OCC 代码库有约 1300 个非阻塞 `tsc` 类型错误（多为 `unknown`/`never`/`{}` 类型）。`tsconfig.json` 设为 `strict: false` + `skipLibCheck: true`，`tsc` 不在 CI 中。质量门槛是 Biome lint。

**解决**：不要试图修复全部 tsc 错误。用 `bun run lint`（Biome）作为质量检查。

### Biome lint 报错

**症状**：提交时 pre-commit hook（`.githooks/`）报 lint 错误。

**解决**：

```bash
bun run lint:fix    # 自动修复
```

如果错误来自既有噪声，可用 `git commit --no-verify` 绕过（不推荐用于新代码）。

### feature flag 关闭的功能不可用

**症状**：某些工具/命令（如 Sleep、Cron、RemoteTrigger 等）不工作。

**说明**：OCC 中所有 `feature()` 调用对白名单外的 flag 返回 `false`，相关代码为死代码。已启用的 flag：`WORKFLOW_SCRIPTS`、`MONITOR_TOOL`、`TRANSCRIPT_CLASSIFIER`、`BASH_CLASSIFIER`、`EXPERIMENTAL_SKILL_SEARCH`、`MCP_SKILLS`（见 `src/utils/featureFlags.ts`）。

**解决**：这些功能在 OCC 中不可用，是设计上的裁剪。如需启用某个子系统，可修改 `FEATURE_ALLOWLIST`，但注意某些子系统（KAIROS、UDS_INBOX）启用后会阻塞查询路径。

### 权限提示频繁

**症状**：每次工具调用都弹权限提示。

**解决**：

- 用 `/permissions` 添加允许规则（如 `Bash(git:*)`）。
- 用 `Shift+Tab` 切到 `acceptEdits` 模式（自动接受文件编辑）。
- 用 `/less-permission-prompts` 扫描历史并生成允许列表。
- 沙箱环境可用 `--dangerously-skip-permissions`（仅无互联网沙箱）。

详见 [权限](./permissions.md)。

### Bash "argument list too long"（E2BIG）——多 worktree 仓库

**症状**：Bash 命令失败，报 `E2BIG: argument list too long`。

**原因**：Bash 沙箱对*每个*已注册 git worktree 的内部文件（`config.worktree`、`config.worktree.lock`、`commondir`）禁止写入。该拒绝列表随 worktree 数量无限增长，最终使沙箱命令行超过 OS `ARG_MAX` 限制。

**解决**：OCC 会给出可读的诊断信息说明原因。恢复方法：清理无用 worktree（`git worktree remove` / `git worktree prune`）后重启，或为本次会话放宽沙箱。

### 登录即将过期警告

当 OAuth 登录（refresh token）距过期不足 5 天时，OCC 显示持续页脚横幅："Your login expires in {n} days · run /login to renew"。距过期不足 1 天时，还会触发一条高优先级瞬时通知。运行 `/login` 重新认证，以免后台会话被中断。

### --bare 模式行为差异

**症状**：`--bare` 模式下 CLAUDE.md、自动记忆、hooks 等不生效。

**说明**：这是 `--bare` 的设计 —— 最小模式跳过 hooks、LSP、plugin 同步、归因、自动记忆、后台预取、keychain 读取、CLAUDE.md 自动发现。认证严格限制为 `ANTHROPIC_API_KEY` 或 `--settings` 指定的 `apiKeyHelper`（不读 OAuth/keychain）。设置 `CLAUDE_CODE_SIMPLE=1`。

**解决**：如需完整上下文，用 `--system-prompt[-file]`、`--append-system-prompt[-file]`、`--add-dir`、`--mcp-config`、`--settings`、`--agents`、`--plugin-dir` 显式提供。

### Ink / 终端渲染异常

**症状**：界面错位、刷新异常、颜色丢失。

**解决**：

- 使用支持 ANSI 的现代终端（iTerm2、Windows Terminal、Alacritty）。
- 确认终端宽度足够（太窄会影响 Ink 布局）。
- 用 `/theme` 调整主题，`/color` 调整颜色。
- 严重时尝试 `occ --bare` 排除插件/hook 干扰。

### MCP 服务器连接失败

**症状**：MCP 工具不可用或报连接错误。

**排查**：

```bash
# REPL 内
> /mcp          # 查看服务器状态

# 启用 MCP debug
occ --debug mcp
# 或旧式
occ --mcp-debug   # 已弃用，改用 --debug
```

**解决**：检查 `.mcp.json` 或 `~/.claude.json` 中的 `mcpServers` 配置。用 `--strict-mcp-config` 只用命令行指定的服务器。详见 [MCP](./mcp.md)。

### 工作区信任对话框

**症状**：每次在目录启动都要确认信任。

**说明**：OCC 在首次进入某目录时显示信任对话框，防止在不可信目录中自动运行。`-p` 模式跳过此对话框 —— 所以仅在信任目录中使用 `-p`。

### 会话无法恢复

**排查**：

```bash
occ --resume        # 打开选择器，看历史会话列表
```

如用 `--no-session-persistence`，会话不保存到磁盘，不可恢复。

## 调试模式

```bash
# 启用 debug，可选分类过滤
occ --debug "api,hooks"

# 写入文件
occ --debug-file /tmp/occ-debug.log

# 输出到 stderr
occ --debug-to-stderr
```

debug 过滤语法：

- `"api,hooks"` —— 只看 api 和 hooks。
- `"!1p,!file"` —— 排除 1p 和 file 类别。

## 安全模式排查

怀疑某个插件/hook 导致问题时：

```bash
occ --safe-mode   # 禁用所有插件、内置技能、hooks
```

如果 `--safe-mode` 下问题消失，说明是插件或 hook 导致。逐一禁用排查。

## 获取帮助

- REPL 内输入 `/help` 查看命令列表。
- 运行 `occ --help` 查看 CLI 选项。
- 运行 `occ doctor` 做全面诊断。
- 参考 [CLAUDE.md](../../CLAUDE.md) 了解架构与已知限制。

## 已知限制

- 约 1300 个非阻塞 tsc 类型错误（不影响运行时）。
- Computer Use（`@ant/*`）为 stub。
- 多数 `*-napi` 包为 stub（仅 `color-diff-napi` 完整）。
- Analytics / GrowthBook / Sentry 为空实现（不上报）。
- Magic Docs / Voice Mode / LSP server 已移除。
- Plugins / Marketplace 已移除。
- MCP OAuth 已简化。
- 内部 feature flag（COORDINATOR_MODE、KAIROS、PROACTIVE 等）已关闭。
