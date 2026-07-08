# 快速开始

本章带你完成 OCC 的首次使用：启动 REPL、执行第一个任务、使用管道模式、以及基本操作。

## 前置条件

确保已完成 [安装](./installation.md) 并配置了 API 凭据：

```bash
# 验证安装
occ --version

# 验证凭据（管道模式冒烟测试）
echo "say hello" | occ -p
```

如果 `occ -p` 能返回响应，说明环境就绪。

## 启动交互式 REPL

```bash
# 在你的项目目录中启动
cd my-project
occ
```

首次在某个目录启动时，OCC 会显示工作区信任对话框（trust dialog），确认你信任该目录后才会运行。管道模式（`-p`）会跳过此对话框，所以仅在信任目录中使用 `-p`。

启动后你会看到交互式 REPL 界面（基于 Ink 的终端渲染），底部是输入框。

### 第一次对话

直接输入自然语言提示并回车：

```
> 帮我看看这个项目的结构
```

OCC 会调用工具（如 Bash、Glob、Read）探索项目，然后给出回答。工具调用会在界面上显示，部分工具调用会请求权限确认（详见 [权限](./permissions.md)）。

## 基本操作

### 输入与提交

- 输入文本后按 `Enter` 提交。
- 多行输入：按 `Shift+Enter` 或 `\` 换行（见 [快捷键](./keybindings.md)）。
- 粘贴大段文本直接粘贴即可。

### 斜杠命令

在输入框中输入 `/` 会弹出命令列表。常用命令：

| 命令 | 作用 |
|------|------|
| `/help` | 查看帮助 |
| `/model` | 切换模型（sonnet / opus 等） |
| `/effort` | 切换 effort 级别（low/medium/high/max） |
| `/config` | 打开配置界面 |
| `/permissions` | 查看与修改权限规则 |
| `/clear` | 清空当前对话 |
| `/compact` | 手动压缩上下文 |
| `/resume` | 恢复历史会话 |
| `/doctor` | 运行诊断 |
| `/mcp` | 管理 MCP 服务器 |
| `/skills` | 管理技能 |
| `/goal` | 设定目标驱动 workflow |
| `/workflows` | 查看 workflow |
| `/exit` | 退出 |

完整列表见 [斜杠命令](./slash-commands.md)。

### 文件引用

在提示中用 `@` 引用文件路径，OCC 会读取并纳入上下文：

```
> 看看 @src/main.tsx 的入口逻辑
```

### 权限提示

当 OCC 要执行可能敏感的操作（如运行 bash 命令、写入文件）时，会弹出权限提示。你可以选择：

- 允许一次
- 允许本次会话
- 拒绝

按 `Shift+Tab` 可在权限模式间切换（default → acceptEdits → plan），详见 [权限](./permissions.md)。

## 管道模式（非交互）

管道模式适合脚本化、CI/CD、单次查询：

```bash
# 基本管道
occ -p "explain package.json"

# 从 stdin
cat src/main.tsx | occ -p "summarize this file"

# 链式处理
occ -p "list all TODO comments" | grep TODO

# JSON 输出（便于程序解析）
occ -p --output-format json "what's the entrypoint?" | jq '.result'

# 流式 JSON
occ -p --output-format stream-json "refactor X" > events.jsonl
```

### 限制 turn 与预算

CI 中常需限制行为：

```bash
occ -p --max-turns 10 --max-budget-usd 2.0 "fix the failing tests"
```

达到限制会提前退出（非零退出码）。

### 指定模型与工具

```bash
# 用 opus 做高难度任务
occ -p --model opus --effort max "design a new API"

# 只允许 Bash 和 Read
occ -p --allowed-tools "Bash Read" "show me git log"

# 禁止某些工具
occ -p --disallowed-tools "Bash(rm:*)" "clean up temp files"
```

## 继续与恢复会话

```bash
# 继续当前目录最近的对话
occ --continue
# 或
occ -c

# 按 session ID 恢复
occ --resume <session-id>

# 打开交互式会话选择器
occ --resume

# 恢复时创建新 session（不污染原会话）
occ --resume <session-id> --fork-session
```

REPL 内用 `/resume` 同样可打开选择器。

## 添加额外目录

默认 OCC 只能访问启动目录。要让工具访问其他目录：

```bash
occ --add-dir /path/to/other/dir --add-dir /another/dir
```

REPL 内用 `/add-dir` 命令。

## 下一步

- [工具](./tools.md) —— 了解 OCC 可用的所有工具。
- [斜杠命令](./slash-commands.md) —— REPL 内命令全表。
- [权限](./permissions.md) —— 权限模式与安全。
- [记忆](./memory.md) —— 用 CLAUDE.md 定制 OCC 的项目认知。
