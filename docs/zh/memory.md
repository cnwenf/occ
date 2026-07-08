# 记忆

OCC 通过两层机制记住你的项目与偏好：**CLAUDE.md 项目文件**（你手写、版本化）和**自动记忆**（OCC 自主写入、跨会话持久）。

## CLAUDE.md

CLAUDE.md 是项目级的指令文件，告诉 OCC 这个项目的约定、命令、架构、注意事项。OCC 在每次对话启动时自动发现并加载它作为系统上下文的一部分。

### 发现层级

OCC 的 CLAUDE.md 发现逻辑在 `src/utils/claudemd.ts`，按层级加载：

1. **项目根** —— `./CLAUDE.md`（当前工作目录）。
2. **父目录链** —— 向上遍历父目录的 `CLAUDE.md`，直到根。
3. **用户全局** —— `~/.claude/CLAUDE.md`，对所有项目生效。
4. **子目录** —— 工具访问到的子目录中的 `CLAUDE.md`（按需加载）。

多个 CLAUDE.md 会合并进上下文。项目级覆盖用户全局的冲突部分。

### 写什么

CLAUDE.md 应写 OCC 需要知道但无法从代码推断的信息：

```markdown
# CLAUDE.md

## 项目概述
这是一个基于 Bun 的 CLI 工具，用于 X。

## 命令
- `bun run dev` —— 开发模式
- `bun test` —— 测试
- `bun run build` —— 构建

## 约定
- 用 Biome lint，不要跑 tsc
- 函数 <50 行，文件 <800 行
- 不要修复全部 tsc 错误

## 架构
- 入口: src/entrypoints/cli.tsx
- 主循环: src/query.ts
```

### 用 /init 生成

```bash
# REPL 内
> /init
```

`/init` 命令会分析项目并生成初始 CLAUDE.md 草稿。

### --bare 模式

`--bare` 模式跳过 CLAUDE.md 自动发现。如需在 bare 模式提供项目上下文，用 `--add-dir` 指定包含 CLAUDE.md 的目录。

## 自动记忆

OCC 会在对话中自主记忆重要事实（如你的偏好、项目状态、踩过的坑），写入磁盘，跨会话持久。

### 存储位置

记忆文件按项目隔离，存储在：

```
~/.claude/projects/<项目路径编码>/memory/MEMORY.md
```

项目路径会把 `/` 等分隔符编码为 `-`。例如 `/root/code/occ` 编码为 `-root-code-occ`，对应：

```
~/.claude/projects/-root-code-occ/memory/MEMORY.md
```

`MEMORY.md` 是索引式记忆 —— 每条记忆是一个标题 + 指向更详细记忆文件的链接。详细记忆文件存放在同目录下。

### 记忆内容示例

```markdown
# Memory

- [OCC 版本追赶](occ-version-catchup.md) — baseline、workflow、模型配置、e2e 注意点
- [UI 视觉验证教训](ui-visual-verification-lesson.md) — UI 功能需要 tmux 交互冒烟
```

每条指向一个独立的 `.md` 文件，其中是结构化的详细笔记。

### 何时记忆

OCC 在以下情况会主动记忆：

- 你明确要求记住某事（"记住：不要跑 tsc"）。
- 对话中出现长期有用的项目事实或教训。
- 完成复杂任务后的总结性洞察。

记忆是**追加式**的 —— OCC 不会覆盖已有记忆，而是新增或更新条目。

## /pause-memory

```bash
# REPL 内
> /pause-memory
```

`/pause-memory` 暂停自动记忆写入。适合：

- 处理敏感信息不希望持久化时。
- 临时调试不希望污染记忆时。

再次执行恢复记忆。

## 记忆与压缩的关系

- **记忆**（memory）—— 跨会话持久，写在磁盘文件里。
- **压缩**（compaction，`/compact`）—— 单次会话内上下文过长时的摘要，不跨会话。

两者独立。压缩减少当前 token 用量；记忆积累跨会话知识。

## 自定义记忆目录

记忆目录由 `src/memdir/` 模块管理，路径基于项目工作目录自动派生。一般无需手动修改。如需查看当前项目的记忆：

```bash
ls ~/.claude/projects/<编码后的项目路径>/memory/
```

## 与 Claude Code 的差异

OCC 的记忆机制与 Claude Code 对齐。差异：

- OCC 的自动记忆不会上报到任何服务（Analytics/Sentry 为空实现），完全本地。
- `--bare` 模式严格跳过自动记忆（Claude Code 同样如此）。

## 下一步

- [配置](./settings.md) —— 在 settings.json 中控制记忆相关开关。
- [斜杠命令](./slash-commands.md) —— `/init`、`/pause-memory`、`/memory`。
- [Hooks](./hooks.md) —— 用 Stop hook 在会话结束时触发自定义记忆逻辑。
