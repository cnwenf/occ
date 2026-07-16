# Open C Code (OCC)

> 安全、开源的编码智能体 —— 能力完全对齐 Claude Code。

**[English](./README.md)** · 简体中文

---

## 这是什么

**Open C Code（OCC）** 是一个开源的编码智能体。能力与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 对齐（当前跟踪 `2.1.210`）。代码全开放、可审计、无暗门，数据由你掌控。

> 注意：追齐 Claude Code `2.1.211` 的工作进行中 — 见 `docs/upstream-version-gap.md`。

如果你担心闭源 CLI 可能植入后门、担心代码与凭据被上传到不可审计的服务，OCC 就是为你准备的：全部源码开放、无混淆，构建产物可由源码复现，API 凭据只发往你自己配置的端点。

## 定位

- 🔓 **开源可审计** —— 全部源码开放，无混淆，可逐行审查。
- 🛡️ **安全透明** —— 无遥测黑盒、无隐藏上报；行为由你监督。
- 🎯 **能力对齐** —— REPL、工具系统、权限模型、MCP、子代理、斜杠命令……与 Claude Code 一致。
- 🔧 **数据自主** —— API Key / Bedrock / Vertex / Azure 凭据留在本机，请求只发往你指定的端点。

## 现状

- 跟踪 Claude Code **`2.1.210`**。
- 代码库有约 1300 个不阻塞的 `tsc` 类型错误（大量松散的 `unknown`/`never`/`{}` 类型），**不影响 Bun 运行时执行**。门槛是 Biome lint，不是 `tsc`。
- 所有内部 feature flag（`feature(...)`）已被 polyfill 为 `false` —— 内部功能（COORDINATOR_MODE、KAIROS、PROACTIVE 等）全部关闭。
- 已发布到 npm：[`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ)。

## 安装

```bash
npm i -g @cnwenf/occ
occ
```

需要有效的 Anthropic API Key（或 Bedrock / Vertex / Azure Foundry 凭据）。

## 快速开始

```bash
# 交互式 REPL
occ

# 管道模式（-p）
echo "say hello" | occ -p
```

## 能力

### 核心系统
- **REPL** —— Ink 终端渲染，完整交互界面。
- **API 层** —— Anthropic Direct、AWS Bedrock、Google Vertex、Azure Foundry（API Key + OAuth / 凭据刷新）。
- **查询循环** —— 流式对话、工具调用循环、自动压缩、token 追踪（`query.ts`）。
- **会话引擎** —— 对话状态、归因、文件历史快照（`QueryEngine.ts`）。
- **上下文** —— git status、CLAUDE.md 层级、memory 文件。
- **权限系统** —— plan / auto / manual 模式，YOLO 分类器、路径校验、规则匹配。
- **Hook** —— pre/post tool use，通过 `settings.json` 配置。
- **会话恢复**（`/resume`）、**诊断**（`/doctor`）、**自动压缩**。

### 工具 —— 始终可用
Bash、FileRead、FileEdit、FileWrite、NotebookEdit、Agent（子代理派生：fork / async / background / remote）、WebFetch、WebSearch、AskUserQuestion、SendMessage、Skill、EnterPlanMode、ExitPlanMode、TodoWrite（v1）、Brief、TaskOutput、TaskStop、ListMcpResources、ReadMcpResource、SyntheticOutput。

### 工具 —— 条件启用
Glob、Grep（默认启用）；TaskCreate/Get/Update/List（Todo v2）、EnterWorktree/ExitWorktree、TeamCreate/Delete（agent swarms）、ToolSearch、PowerShell（Windows）、LSP（`ENABLE_LSP_TOOL`）。

### 关闭 / Stub
- Feature flag 关闭（所有 `feature()` 返回 false）：Sleep、Cron、RemoteTrigger、Monitor、WebBrowser、Workflow、PushNotification 等。
- ANT-only stub：Tungsten、REPL、SuggestBackgroundPR。
- 移除 / 简化：Computer Use（`@ant/*`）、多数 `*-napi` 包（audio/image/url/modifiers —— 仅 `color-diff-napi` 完整实现）、Analytics / GrowthBook / Sentry（空实现）、Magic Docs / Voice Mode / LSP server、Plugins / Marketplace、MCP OAuth（简化）。

### 斜杠命令
已实现数十个：`/add-dir`、`/agents`、`/branch`、`/clear`、`/compact`、`/config`、`/context`、`/cost`、`/doctor`、`/effort`、`/export`、`/fast`、`/goal`、`/help`、`/init`、`/login`、`/mcp`、`/memory`、`/model`、`/permissions`、`/resume`、`/review`、`/status`、`/todo` 等。

### MCP
通过 Model Context Protocol 接入外部工具（`--mcp-config`、`.mcp.json`）。OAuth 流程已简化。

## 从源码构建

需要 [Bun](https://bun.sh/) >= 1.3.11。

```bash
bun install
bun run dev          # 从源码运行；版本号显示 2.1.210 即正常
bun run build        # 产物：dist/cli.js（~26MB，5300+ 模块，单文件 bundle）
bun test             # 测试套件
bun run lint         # Biome lint（禁用格式化以避免大 diff）
```

更详细的架构、入口/启动、工具系统、UI 层、模块状态说明见 [CLAUDE.md](./CLAUDE.md)。

## 项目结构

```
src/entrypoints/cli.tsx   # 真正的入口（运行时 polyfill、宏）
src/main.tsx              # Commander CLI 定义
src/query.ts              # 主 API 查询循环
src/QueryEngine.ts        # 会话编排
src/screens/REPL.tsx      # 交互式 REPL 屏幕
src/services/api/         # API 客户端（Anthropic / Bedrock / Vertex / Azure）
src/tools/<Name>/         # 每个工具一个目录
src/ink/                  # 自研 Ink 框架
packages/                 # workspace stub（@ant/*、*-napi）
```

## 许可证

MIT 许可证 — 详见 [LICENSE](./LICENSE)。
