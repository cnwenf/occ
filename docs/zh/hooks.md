# Hooks

Hooks 让你在工具调用与会话的生命周期中插入自定义逻辑 —— 自动格式化、运行 lint、阻止危险操作、注入上下文等。Hooks 在 `settings.json` 中配置，由 OCC 的 hook 运行时执行。

> 注意：`src/hooks/` 是 React hooks 目录，**不是** agent hook 系统。agent hook 系统在 `src/utils/hooks.ts`、`src/schemas/hooks.ts`、`src/types/hooks.ts`。

## Hook 事件

OCC 支持丰富的 hook 事件（`HOOK_EVENTS`，`src/entrypoints/sdk/coreTypes.ts`）：

| 事件 | 触发时机 |
|------|----------|
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后 |
| `PostToolUseFailure` | 工具执行失败后 |
| `PostToolBatch` | 工具批量调用后 |
| `UserPromptSubmit` | 用户提交 prompt 时 |
| `UserPromptExpansion` | prompt 展开时 |
| `SessionStart` | 会话启动 |
| `SessionEnd` / `PostSession` | 会话结束 |
| `Stop` / `StopFailure` | 会话停止 |
| `SubagentStart` / `SubagentStop` | 子代理启动/停止 |
| `PreCompact` / `PostCompact` | 压缩前/后 |
| `PermissionRequest` / `PermissionDenied` | 权限请求/拒绝 |
| `Setup` | 初始化（`--init`/`--maintenance`） |
| `TeammateIdle` | teammate 空闲 |
| `TaskCreated` / `TaskCompleted` | 任务创建/完成 |
| `Elicitation` / `ElicitationResult` | 引导交互 |
| `ConfigChange` | 配置变更 |
| `WorktreeCreate` / `WorktreeRemove` | worktree 创建/移除 |
| `InstructionsLoaded` | 指令加载（User/Project/Local/Managed） |
| `CwdChanged` / `FileChanged` | 工作目录/文件变更 |
| `MessageDisplay` | 消息显示 |
| `Notification` | 通知 |

`SessionStart` 与 `Setup` 始终发射；其余受 `includeHookEvents` SDK 选项或 `CLAUDE_CODE_REMOTE` 模式控制（`setAllHookEventsEnabled`）。

## Hook 命令类型

Hook 支持五种命令类型（`HookCommandSchema` 判别联合，`src/schemas/hooks.ts`）：

| type | 关键字段 | 执行函数 |
|------|----------|----------|
| `command` | `command`、`if`、`shell`、`timeout`、`statusMessage`、`once`、`async`、`asyncRewake`、`args`、`continueOnBlock` | `execCommandHook` |
| `prompt` | `prompt`（用 `$ARGUMENTS`）、`if`、`timeout`、`model`、`statusMessage`、`once`、`continueOnBlock` | `execPromptHook` |
| `http` | `url`、`if`、`timeout`、`headers`、`allowedEnvVars`、`statusMessage`、`once` | `execHttpHook` |
| `agent` | `prompt`、`if`、`timeout`、`model`、`statusMessage`、`once` | `execAgentHook` |
| `mcp_tool` | `server`、`tool`、`input`、`if`、`timeout`、`statusMessage`、`once` | `execMcpToolHook` |

`shell` 接受 `'bash'`（用 `$SHELL`）或 `'powershell'`（用 pwsh）。`headers` 值可插值环境变量（`$VAR`/`${VAR}`），但仅限 `allowedEnvVars` 列出的。

## 配置格式

在 `settings.json` 的 `hooks` 键下，按事件名分组。顶层键 = 事件名，值是 `HookMatcher` 数组：

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write \"$tool_input.file_path\"",
            "timeout": 30,
            "statusMessage": "格式化中..."
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "验证测试是否通过。 $ARGUMENTS",
            "model": "claude-sonnet-4-6"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "echo done" }
        ]
      }
    ]
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `matcher` | 字符串，匹配工具名（如 `"Write"`、`"Bash"`）。省略则匹配所有触发 |
| `hooks[].type` | 命令类型：`command`/`prompt`/`http`/`agent`/`mcp_tool` |
| `hooks[].if` | 可选，用**权限规则语法**过滤（如 `"Bash(git *)"`、`"Read(*.ts)"`），在派生前按 `tool_name`+`tool_input` 求值 |
| `hooks[].timeout` | 超时 |
| `hooks[].statusMessage` | 显示的状态消息 |
| `hooks[].once` | 仅运行一次 |

## Hook 输入与输出

### 输入

Hook 命令通过 stdin 接收 JSON（`HookInput` + 事件特定字段）：

- `PreToolUseHookInput` = `HookInput & { tool_name: string }`
- `PostToolUseHookInput` = `HookInput & { tool_name: string }`
- `UserPromptSubmitHookInput` = `HookInput & { prompt: string }`

### 输出

Hook 输出 JSON（`syncHookResponseSchema`，`src/types/hooks.ts`）：

- `continue`（bool，默认 true）—— 是否继续执行
- `suppressOutput`（bool）—— 抑制输出
- `decision`（`'approve'`/`'block'`）—— 批准/阻止
- `reason` —— 原因
- `systemMessage` —— 系统消息
- 异步形式：`{ async: true, asyncTimeout?: number }`

`hookSpecificOutput`（按事件判别）：

| 事件 | 特定输出 |
|------|----------|
| `PreToolUse` | `permissionDecision`（`allow`/`deny`/`ask`/`defer`）、`permissionDecisionReason`、`updatedInput`、`additionalContext` |
| `PostToolUse` | `additionalContext`、`updatedToolOutput`、`updatedMCPToolOutput` |
| `UserPromptSubmit`/`SessionStart`/`Setup`/`SubagentStart` | `additionalContext`（SessionStart 还有 `initialUserMessage`、`watchPaths`） |
| `Stop`/`SubagentStop` | `additionalContext`（非错误反馈，对话继续） |
| `PermissionRequest` | `decision` = `{behavior:'allow', updatedInput?, updatedPermissions?}` 或 `{behavior:'deny', message?, interrupt?}` |
| `PermissionDenied` | `retry`（bool） |
| `Elicitation`/`ElicitationResult` | `action`（`accept`/`decline`/`cancel`）、`content` |
| `CwdChanged`/`FileChanged` | `watchPaths` |
| `WorktreeCreate` | `worktreePath` |
| `MessageDisplay` | `displayContent`（仅显示替换） |

## PreToolUse：阻止与修改

PreToolUse 的 `permissionDecision` 控制工具执行：

- `allow` —— 允许继续。
- `deny` —— 阻止，`permissionDecisionReason` 作为原因反馈给 Claude。
- `ask` —— 仍提示用户确认。
- `defer` —— 延迟决策。

`updatedInput` 可修改工具输入。这让 PreToolUse 可作为自定义权限闸门与输入改写器。

## PostToolUse：自动格式化

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "biome lint --fix", "timeout": 30, "async": true }
        ]
      }
    ]
  }
}
```

## HTTP Hook 安全

HTTP hook 受 allowlist 约束：

| 设置键 | 作用 |
|--------|------|
| `allowedHttpHookUrls` | 允许的 HTTP hook URL 列表 |
| `allowedHookEnvVars` | HTTP hook 可携带的环境变量名（与每 hook 的 `allowedEnvVars` 取交集） |

## 相关设置

| 设置键 | 作用 |
|--------|------|
| `disableAllHooks` | 禁用所有 hooks 与 statusLine |
| `allowManagedHooksOnly` | 只运行 managed-settings 中的 hooks（企业策略） |
| `disableSkillShellExecution` | 禁用技能/命令中的 `!` shell 执行 |
| `defaultShell` | hook 命令的默认 shell（`bash`/`powershell`） |

## 禁用与排查

```bash
occ --safe-mode                          # 禁用所有插件、内置技能、hooks
occ --bare                               # 跳过 hooks
occ -p --output-format stream-json --include-hook-events  # 输出中包含 hook 事件
```

## /hooks 与 /hookify 命令

```bash
> /hooks          # 查看 hook 配置
> /hookify        # 从历史分析并生成 hook 配置（防止行为复发）
```

`/goal` 命令也用会话级 Stop hook 实现（`addSessionHook`）。

## 与 Claude Code 的差异

OCC 的 hook 系统与 Claude Code 对齐，配置格式与运行时一致。差异：

- OCC 不接入远程 managed settings 下发。
- HTTP hook 的 allowlist 行为一致。
- `--safe-mode` 与 `--bare` 行为一致。

## 下一步

- [配置](./settings.md) —— `hooks` 配置项位置。
- [权限](./permissions.md) —— PreToolUse 与权限规则的关系。
- [斜杠命令](./slash-commands.md) —— `/hooks`、`/hookify`。
