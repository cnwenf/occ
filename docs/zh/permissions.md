# 权限与安全

OCC 的权限系统控制工具能执行什么操作。它在你和文件系统 / shell / 网络之间设了一道审批闸门，防止意外的破坏性操作。

## 权限模式

OCC 支持六种权限模式（定义在 `src/types/permissions.ts`，`PERMISSION_MODES`）：

| 模式 | 说明 |
|------|------|
| `default` | 标准模式。未在 allow 列表中的敏感操作都会提示确认。`manual` 是它的别名。 |
| `acceptEdits` | 自动接受文件编辑（Edit/Write），但 bash 等仍需确认。适合信任代码修改、但仍把控命令执行的场景。 |
| `plan` | plan 模式。只读规划，不执行任何写操作或副作用。提交计划经你批准后才执行。 |
| `auto` | 自动模式。由 AI 分类器（`TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER`）判断每个操作是否安全，安全的自动放行，危险的提示。OCC 中已启用。 |
| `bypassPermissions` | 跳过所有权限检查。**仅推荐无互联网沙箱使用**。 |
| `dontAsk` | 不提示，直接拒绝未授权操作（fail-closed）。 |

### 切换模式

```bash
# 命令行指定
occ --permission-mode acceptEdits
occ --permission-mode plan
occ --dangerously-skip-permissions   # = bypassPermissions

# REPL 内按 Shift+Tab 在 default/acceptEdits/plan 间循环切换

# /permissions 命令查看与修改
> /permissions
```

`auto` 模式需要 opt-in（`--enable-auto-mode` 隐藏选项，或在 settings 中配置 `autoMode`）。`bypassPermissions` 首次使用时会显示确认对话框，可用 `skipDangerousModePermissionPrompt: true` 记住选择。

## 权限规则

在 `settings.json` 的 `permissions` 对象中配置规则：

```jsonc
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Read",
      "Edit",
      "Bash(git:*)",
      "Bash(npm install:*)",
      "Bash(bun test:*)"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(git push --force:*)"
    ],
    "ask": [
      "Bash(npm publish:*)",
      "Bash(git push:*)"
    ],
    "additionalDirectories": [
      "/shared/libs"
    ]
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `defaultMode` | 默认权限模式 |
| `allow` | 自动放行的操作（不提示） |
| `deny` | 直接拒绝的操作 |
| `ask` | 总是提示确认的操作（即便在 acceptEdits 下） |
| `additionalDirectories` | 额外纳入权限范围的目录（默认只有启动目录） |
| `disableBypassPermissionsMode` | 设为 `"disable"` 禁用 bypass 模式 |
| `disableAutoMode` | 设为 `"disable"` 禁用 auto 模式 |

### 规则格式

规则字符串格式为 `ToolName` 或 `ToolName(args)`：

- `"Read"` —— 匹配所有 Read 调用。
- `"Bash(git:*)"` —— 匹配所有 `git` 子命令。
- `"Bash(npm install:*)"` —— 匹配 `npm install ...`。
- `"Edit"` —— 匹配所有文件编辑。

规则按 `deny` > `ask` > `allow` 优先级匹配：先看 deny，再看 ask，最后 allow，未匹配的走 `defaultMode`。

## 受保护路径

某些路径因为修改后会执行代码或改变工具行为，被列为"受保护路径"：

- `.claude/` —— 配置与 hooks，修改可改变工具行为。
- `.git/` —— git 配置/hooks 可执行任意代码。
- `.vscode/` —— 编辑器配置。
- shell 配置（`.bashrc`、`.zshrc` 等）—— 修改可在下次 shell 启动时执行任意代码。

对受保护路径的写操作默认会提示。用 `--dangerously-skip-protected-paths` 跳过这些提示（谨慎使用）。

## auto 模式与分类器

OCC 的 `auto` 模式由 AI 分类器驱动，两个相关 feature flag 都已启用：

- `TRANSCRIPT_CLASSIFIER` —— 对话级分类，决定是否进入 auto 语义。
- `BASH_CLASSIFIER` —— 对每条 bash 命令分类（safe / soft_deny / hard_deny）。

`autoMode` 配置（settings.json）：

```jsonc
{
  "autoMode": {
    "allow": ["Bash(ls:*)", "Bash(cat:*)"],
    "soft_deny": ["Bash(curl:*)"],
    "hard_deny": ["Bash(rm -rf /*:*)"],
    "environment": "development",
    "classifyAllShell": true
  }
}
```

- `allow` —— 分类器判定后自动放行的。
- `soft_deny` —— 软拒绝（可被用户覆盖）。
- `hard_deny` —— 硬拒绝（不可覆盖）。
- `classifyAllShell` —— 是否对所有 shell 命令分类。

用 `occ auto-mode` 子命令检查分类器配置：

```bash
occ auto-mode defaults   # 默认配置
occ auto-mode config     # 当前配置
occ auto-mode critique --model opus   # 评估分类器
```

## 破坏性命令阻止

OCC 多层防护破坏性操作：

1. **规则匹配** —— `deny` 列表直接拦截（如 `Bash(rm -rf:*)`）。
2. **BASH_CLASSIFIER** —— auto 模式下对每条命令分类，危险的硬拒绝。
3. **受保护路径** —— 写 `.git/` 等需要额外确认。
4. **路径校验** —— 工具操作路径必须在权限范围内（启动目录 + `additionalDirectories`）。
5. **沙箱** —— 可配置 sandbox 限制工具的文件/网络访问（见 settings 的 `sandbox` 键）。

## 工具级控制

除了权限规则，还可用 CLI 参数限制工具集：

```bash
# 只允许某些工具
occ --allowed-tools "Bash(git:*) Read Edit"

# 禁止某些工具
occ --disallowed-tools "Bash(rm:*)"

# 指定可用工具集合
occ --tools "Bash,Read,Edit"          # 只用这三个
occ --tools "default"                  # 用全部
occ --tools ""                         # 禁用全部
```

## 减少权限提示

频繁的权限提示影响效率。可用 `/less-permission-prompts` 命令扫描历史对话，找出常用的只读操作并生成 allow 规则写入 `.claude/settings.json`：

```bash
> /less-permission-prompts
```

## 沙箱

settings.json 的 `sandbox` 键配置沙箱（由 `@anthropic-ai/sandbox-runtime` 支持），限制工具的文件系统与网络访问范围。适合在不可信代码上运行时加固。

## 与 Claude Code 的差异

OCC 权限系统与 Claude Code 对齐。差异：

- OCC 的 `auto` 模式分类器是本地运行的（`TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER` 在 feature 白名单中已启用），不依赖远程 Statsig 下发配置。
- OCC 不上报任何权限决策到远程服务（Analytics/Sentry 为空实现）。
- `bypassPermissions` 行为一致，OCC 同样强调仅限无互联网沙箱使用。

## 下一步

- [配置](./settings.md) —— `permissions` 与 `autoMode` 配置项。
- [Hooks](./hooks.md) —— 用 PreToolUse hook 实现自定义权限逻辑。
- [故障排查](./troubleshooting.md) —— 权限提示频繁的解决方法。
