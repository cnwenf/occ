# OCC 概览

## OCC 是什么

**Open C Code（OCC）** 是一个开源的编码智能体。它的能力与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 对齐（当前跟踪 `2.1.200`），但全部源码开放、无混淆、可逐行审计，构建产物可由源码复现。

如果你担心闭源 CLI 可能植入后门、担心代码与凭据被上传到不可审计的服务，OCC 就是为你准备的：API 凭据只发往你自己配置的端点，无遥测黑盒、无隐藏上报。

## 定位

| 维度 | 说明 |
|------|------|
| 开源可审计 | 全部源码开放，无混淆，可逐行审查 |
| 安全透明 | 无遥测黑盒、无隐藏上报；行为由你监督 |
| 能力对齐 | REPL、工具系统、权限模型、MCP、子代理、斜杠命令 —— 与 Claude Code 一致 |
| 数据自主 | API Key / Bedrock / Vertex / Azure 凭据留在本机，请求只发往你指定的端点 |

## 与 Claude Code 的对比

OCC 在功能层面与 Claude Code `2.1.200` 对齐，但有以下重要差异：

### 相同点

- **交互式 REPL**：基于 Ink 的终端渲染，完整交互界面、流式输出、工具调用循环。
- **工具系统**：Bash、FileRead、FileEdit、FileWrite、Grep、Glob、Agent、WebFetch、WebSearch、TaskCreate/Update/List 等。
- **权限模型**：plan / acceptEdits / default / bypassPermissions 模式，规则匹配。
- **MCP**：通过 Model Context Protocol 接入外部工具（`--mcp-config`、`.mcp.json`）。
- **子代理**：Agent 工具支持 fork / async / background / remote 隔离模式。
- **斜杠命令**：数十个已实现，如 `/model`、`/mcp`、`/config`、`/goal`、`/workflows`、`/skills`。
- **CLAUDE.md 与记忆**：项目层级发现、自动记忆。
- **Hooks**：PreToolUse / PostToolUse / Stop，通过 `settings.json` 配置。

### 关键差异

| 方面 | Claude Code | OCC |
|------|-------------|-----|
| 源码 | 闭源、混淆 | 全开放、无混淆、MIT 许可 |
| 运行时 | Node.js | Bun（>= 1.3.11） |
| 遥测/分析 | Statsig、GrowthBook、Sentry | 全部空实现，不上报 |
| 内部服务 | KAIROS、PROACTIVE、COORDINATOR_MODE 等 | feature flag 全部关闭 |
| Computer Use | `@ant/*` 完整 | stub 包 |
| 原生模块 | `*-napi`（audio/image/url 等） | stub（仅 `color-diff-napi` 完整） |
| Plugins/Marketplace | 完整 | 移除 |
| MCP OAuth | 完整 | 简化 |
| Magic Docs / Voice / LSP server | 完整 | 移除 |
| 类型检查 | tsc 严格 | 约 1300 个非阻塞 tsc 错误，门槛是 Biome lint |

### OCC 已启用的 feature flag

OCC 的 `feature()` 函数（`src/utils/featureFlags.ts`）对以下 flag 返回 `true`，其余返回 `false`：

- `WORKFLOW_SCRIPTS` —— vm 沙箱多代理 workflow 脚本引擎（Workflow 工具 + `/workflows` 命令）
- `MONITOR_TOOL` —— Monitor 工具（自包含、无阻塞 init）
- `TRANSCRIPT_CLASSIFIER` —— 对话分类器
- `BASH_CLASSIFIER` —— Bash 命令分类（破坏性命令检测）
- `EXPERIMENTAL_SKILL_SEARCH` —— turn-zero 技能预取与搜索
- `MCP_SKILLS` —— 从 MCP 服务器获取技能模块

这意味着：workflow 引擎、Monitor 工具、技能搜索、Bash 分类器在 OCC 中是**实时可用**的。其余内部功能（COORDINATOR_MODE、KAIROS、PROACTIVE、UDS_INBOX 等）全部关闭。

## 架构总览

```
src/entrypoints/cli.tsx   # 真正入口（运行时 polyfill、宏注入）
src/main.tsx              # Commander CLI 定义
src/query.ts              # 主 API 查询循环
src/QueryEngine.ts        # 会话编排器（状态、压缩、归因）
src/screens/REPL.tsx      # 交互式 REPL 屏幕（React/Ink）
src/services/api/         # API 客户端（Anthropic / Bedrock / Vertex / Azure）
src/tools/<Name>/         # 每个工具一个目录
src/commands/             # 斜杠命令
src/ink/                  # 自定义 Ink 框架
src/skills/               # 技能系统
src/hooks/                # Hooks 系统
src/daemon/               # 守护进程（后台代理、workflow 异步、远程控制）
packages/                 # workspace stub（@ant/*、*-napi）
```

### 启动流程

1. **`src/entrypoints/cli.tsx`** —— 真正入口。注入运行时 polyfill：
   - `feature()` —— 对白名单 flag 返回 `true`，其余 `false`。
   - `globalThis.MACRO` —— 模拟构建时宏注入（VERSION、BUILD_TIME 等）。
   - `BUILD_TARGET`、`BUILD_ENV`、`INTERFACE_TYPE` 全局变量。
2. **`src/main.tsx`** —— Commander.js CLI 定义。解析参数、初始化服务（认证、分析、策略），然后启动 REPL 或管道模式。
3. **`src/entrypoints/init.ts`** —— 一次性初始化（遥测、配置、信任对话框）。

### 核心循环

- **`src/query.ts`** —— 主 API 查询函数。发送消息给 Claude API，处理流式响应、工具调用，管理对话 turn 循环。
- **`src/QueryEngine.ts`** —— 更高层编排器。管理对话状态、压缩、文件历史快照、归因、turn 级簿记。
- **`src/screens/REPL.tsx`** —— 交互式 REPL 屏幕（React/Ink 组件）。处理用户输入、消息显示、工具权限提示、快捷键。

## 当前状态与限制

- 跟踪 Claude Code **`2.1.200`**。
- 约 1300 个非阻塞 `tsc` 类型错误（大量松散的 `unknown`/`never`/`{}` 类型），**不影响 Bun 运行时执行**。`tsconfig.json` 设为 `strict: false` + `skipLibCheck: true`，tsc 不在 CI 中。门槛是 Biome lint。
- 已发布到 npm：[`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ)。
- 所有内部 feature flag（除白名单外）已关闭，相关功能为死代码。

## 适用场景

- 想要 Claude Code 的能力，但需要源码可审计。
- 在受管环境/沙箱中运行，需要确认没有隐藏外发行为。
- 想自托管、自定义 provider 路由、自定义 hooks 与技能。
- 想学习 Claude Code 内部实现的开源参考。

## 下一步

- [安装](./installation.md) —— 安装 OCC。
- [快速开始](./quickstart.md) —— 首次使用。
- [CLI 参考](./cli-reference.md) —— 所有命令行参数。
