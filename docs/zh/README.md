# Open C Code (OCC) 中文文档

> 安全、开源的编码智能体 —— 能力完全对齐 Claude Code `2.1.200`。

OCC（Open C Code）是 Claude Code 的开源重建实现。全部源码开放、无混淆、可审计，API 凭据只发往你配置的端点。本目录是 OCC 的完整中文参考文档。

## 文档导航

### 入门

| 文档 | 内容 |
|------|------|
| [OCC 概览](./overview.md) | OCC 是什么、定位、与 Claude Code 的对比、差异说明 |
| [安装](./installation.md) | npm 安装、从源码构建、环境要求、Bun 安装 |
| [快速开始](./quickstart.md) | 首次使用、交互式 REPL、管道模式、基本操作 |
| [CLI 参考](./cli-reference.md) | 所有命令行参数、子命令、退出码 |

### 核心功能

| 文档 | 内容 |
|------|------|
| [工具](./tools.md) | 所有工具：Bash、Read、Edit、Write、Grep、Glob、Agent、WebFetch、TaskCreate 等 |
| [斜杠命令](./slash-commands.md) | 所有斜杠命令：/model、/mcp、/config、/goal、/workflows、/skills 等 |
| [权限与安全](./permissions.md) | 权限模式、破坏性命令阻止、auto-mode、沙箱 |
| [记忆](./memory.md) | CLAUDE.md、自动记忆、/pause-memory |
| [配置](./settings.md) | settings.json、环境变量、多 Provider 配置 |
| [快捷键](./keybindings.md) | 所有快捷键、vim 模式、自定义键位 |

### 扩展

| 文档 | 内容 |
|------|------|
| [MCP](./mcp.md) | MCP 服务器配置、OCC 作为 MCP 服务器 |
| [技能](./skills.md) | 技能系统、frontmatter、/skills、自定义技能 |
| [Hooks](./hooks.md) | Hooks 系统、PreToolUse、PostToolUse、Stop |
| [子代理](./sub-agents.md) | Agent 工具、子代理、后台代理、worktree 隔离 |

### 高级

| 文档 | 内容 |
|------|------|
| [Workflow](./workflows.md) | Workflow 工具、/workflows、异步执行、vm 沙箱 |
| [守护进程](./daemon.md) | 守护进程、/daemon、/stop、/background、后台会话 |
| [FleetView](./fleetview.md) | 代理舰队、调度、团队协作 |
| [远程控制](./remote-control.md) | connectRemoteControl、/remote-control、Unix socket |
| [故障排查](./troubleshooting.md) | 常见问题、/doctor、已知限制 |

## 关键事实速查

- **npm 包名**：`@cnwenf/occ`，版本 `2.1.200`
- **运行时**：Bun（不是 Node.js），需要 Bun >= 1.3.11
- **对齐版本**：Claude Code `2.1.200`
- **构建产物**：`dist/cli.js`（约 27MB，单文件 bundle）
- **Provider**：Anthropic 直连、AWS Bedrock、Google Vertex、Azure Foundry、第三方 provider
- **feature() 白名单**（已启用）：`WORKFLOW_SCRIPTS`、`MONITOR_TOOL`、`TRANSCRIPT_CLASSIFIER`、`BASH_CLASSIFIER`、`EXPERIMENTAL_SKILL_SEARCH`、`MCP_SKILLS`
- **类型错误**：约 1300 个非阻塞 `tsc` 类型错误（不影响运行时），门槛是 Biome lint
- **许可证**：MIT

## 快速安装

```bash
npm i -g @cnwenf/occ
occ
```

需要有效的 Anthropic API Key（或 Bedrock / Vertex / Azure Foundry 凭据）。

## 相关资源

- [英文 README](../../README.md)
- [CLAUDE.md（项目架构指南）](../../CLAUDE.md)
- [npm 包页面](https://www.npmjs.com/package/@cnwenf/occ)
- [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code)
