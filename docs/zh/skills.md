# 技能

技能（Skills）是可复用的指令包，让 OCC 在特定任务上表现得更专业。每个技能是一个目录，包含带 frontmatter 的 `SKILL.md`。技能可由用户通过 `/skill-name` 调用，也可由模型自动发现并使用。

## 技能是什么

技能 = 一个目录 + `SKILL.md`（YAML frontmatter + Markdown 指令）。当技能被触发时，其 Markdown 内容作为 prompt 注入对话，指导 Claude 如何完成该任务。技能可以包含 `!` shell 语法（内联执行命令）、引用技能目录下的辅助文件。

## 技能位置

技能按来源加载（`src/skills/loadSkillsDir.ts` 的 `getSkillsPath`）：

| 来源 | 路径 | 说明 |
|------|------|------|
| user | `~/.claude/skills/` | 全局，所有项目 |
| project | `.claude/skills/` | 项目级，随仓库提交 |
| managed | `<managedPath>/.claude/skills/` | 企业策略 |
| plugin | 随插件分发（`plugin:<name>`） | 插件命名空间 |
| bundled | 编译进 CLI（`src/skills/bundled/`） | 内置技能 |
| mcp | MCP 服务器暴露（需 `MCP_SKILLS`） | 动态 |

> 注意：OCC 只支持**目录格式**（`<name>/SKILL.md`）。`skills/` 下单独的 `.md` 文件不会被加载。

## 内置技能

OCC 自带这些 bundled 技能（`src/skills/bundled/`）：

- `claude-api` —— Claude API / Anthropic SDK 参考
- `verify` —— 行为驱动的端到端验证
- `update-config` —— 通过 settings.json 配置 harness
- `keybindings` —— 自定义键盘快捷键
- `loop` —— 定时循环运行任务
- `run`、`init`、`review`、`security-review` 等命令型技能

用户/项目技能可**遮蔽**（shadow）同名 bundled 技能（`dropShadowedBundledSkills`）。

## SKILL.md frontmatter

```markdown
---
name: my-deploy
description: 部署到生产环境的步骤
when_to_use: 当用户要求部署时
allowed-tools:
  - Bash(npm:*)
  - Read
disallowed-tools:
  - Bash(rm:*)
argument-hint: "[env]"
model: sonnet
effort: high
context: fork
default-enabled: true
user-invocable: true
---

# 部署技能

执行以下步骤：
1. `!npm run build`
2. `!npm run deploy $ARGUMENTS`
...
```

### frontmatter 字段

| 字段 | 说明 |
|------|------|
| `name` | 技能名（用于 `/name` 与模型调用） |
| `description` | 一句话描述 |
| `display-name` / `displayName` | 显示名（kebab-case 自动转 camelCase） |
| `when_to_use` | 何时使用此技能（供模型判断） |
| `allowed-tools` | 此技能允许的工具列表 |
| `disallowed-tools` | 此技能禁止的工具列表 |
| `argument-hint` | 参数提示 |
| `arguments` | 参数定义 |
| `model` | 使用的模型（`inherit` = 不覆盖） |
| `effort` | effort 级别 |
| `context` | `fork` 表示在隔离子代理中运行 |
| `agent` | 指定 agent |
| `shell` | shell 配置 |
| `default-enabled` | `false` 则完全不加载此技能 |
| `user-invocable` | 用户是否可调用（默认 true） |
| `disable-model-invocation` | 禁止模型自动调用 |
| `fallback` | 回退技能 |
| `metadata` | 元数据 |
| `version` | 版本 |
| `paths` | glob 模式，条件触发（同 CLAUDE.md rules） |
| `hooks` | 技能级 hooks（`HooksSchema` 校验） |

## 创建自定义技能

1. 创建目录：

```bash
mkdir -p ~/.claude/skills/my-skill
# 或项目级
mkdir -p .claude/skills/my-skill
```

2. 写 `SKILL.md`：

```markdown
---
name: my-skill
description: 做某件事的标准流程
when_to_use: 当需要做某件事时
allowed-tools:
  - Bash
  - Read
argument-hint: "[target]"
---

# 流程

1. 读取 $ARGUMENTS 指向的文件
2. 运行 `!make test`
3. 报告结果
```

3. 让 OCC 重新加载：

```bash
> /reload-skills
```

`/reload-skills` 会拾取会话中途新增/修改的技能，无需重启。

## 调用技能

```bash
# 用户调用
> /my-skill some-argument

# 在管道模式
occ -p "/my-skill target-file"
```

技能 prompt 中的 `$ARGUMENTS` 会被替换为传入参数，`${CLAUDE_SKILL_DIR}` 替换为技能目录绝对路径，`${CLAUDE_SESSION_ID}`、`${CLAUDE_EFFORT}` 也可用。

## 模型自动发现技能

两个 feature flag（OCC 均已启用）让模型能自动发现并使用技能：

- `EXPERIMENTAL_SKILL_SEARCH` —— turn-zero 技能预取（`src/query.ts`），DiscoverSkills 在 SkillTool 中可用，`/skills` 清缓存 hook，技能搜索 prompt 段落。OCC 用**本地**搜索（`src/skills/searchSkills.ts`，按 name/description/whenToUse 加权评分），而非远程 OAuth 端点。
- `MCP_SKILLS` —— 从 MCP 服务器获取技能模块（见 [MCP](./mcp.md)）。

### DiscoverSkills 工具

工具名 `SearchSkills`（`src/tools/DiscoverSkillsTool/`），输入 `{keywords[]}`（1–8 个关键词，每个 1–64 字符）。返回按相关性排序的技能列表，供模型判断是否调用。

### SkillTool

工具名 `Skill`（`src/tools/SkillTool/`），输入 `{skill, args?}`。校验技能存在且为 prompt 型。**内联**执行（展开 prompt 到消息，应用 allowedTools/model/effort contextModifier）或 **fork** 执行（`context: 'fork'` 时在隔离子代理中运行）。

## /skills 命令

```bash
> /skills          # 列出可用技能
> /reload-skills   # 重新加载（拾取磁盘变更）
> /skill-doctor    # 诊断技能加载问题
```

## 技能级控制

| 设置键 | 作用 |
|--------|------|
| `disableBundledSkills` | 禁用所有内置技能/workflow |
| `disableSkillShellExecution` | 禁用技能/命令中的 `!` shell 执行 |
| `skillOverrides` | 按技能名控制（`on`/`name-only`/`user-invocable-only`/`off`） |

## 子代理技能隔离

当技能在 fork 子代理中运行时，`sessionSkillAllowlist`（`src/skills/sessionSkillAllowlist.ts`）可限制该子代理能调用哪些技能（errorCode 8 表示越权）。

## 与 Claude Code 的差异

- OCC 的技能搜索是**本地**的（文件系统索引 + 内存缓存），不调用远程 claude.ai OAuth 端点。
- `MCP_SKILLS` 中 `src/skills/mcpSkills.ts` 目前是 stub（`fetchMcpSkillsForClient` 返回 `[]`），注册器已就绪但具体获取逻辑待完善。
- 技能不上报到远程服务。

## 下一步

- [斜杠命令](./slash-commands.md) —— `/skills`、`/reload-skills`、`/skill-doctor`。
- [子代理](./sub-agents.md) —— `context: fork` 的隔离执行。
- [MCP](./mcp.md) —— `MCP_SKILLS` 技能模块。
