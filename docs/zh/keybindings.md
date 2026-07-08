# 快捷键

OCC 的交互式 REPL 支持丰富的键盘快捷键与 vim 模式。键位定义在 `src/keybindings/`，vim 逻辑在 `src/vim/`。

## 重要说明：自定义限制

> 自定义键位通过 `~/.claude/keybindings.json` 配置，但**自定义功能受 `tengu_keybinding_customization_release` GrowthBook flag 限制**（`isKeybindingCustomizationEnabled()`，`src/keybindings/loadUserBindings.ts`）。外部用户始终只用默认键位，文件监听器对外部用户是 no-op。OCC 中 GrowthBook 为空实现，因此自定义键位**不可用** —— 你获得的是下述默认绑定。`/keybindings` 命令仍可打开配置文件，但修改不生效。

## 默认快捷键

### Global（全局，处处生效）

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+C` | 中断 / 退出（不可重绑） |
| `Ctrl+D` | 退出（不可重绑） |
| `Ctrl+T` | 切换 todo 列表 |
| `Ctrl+O` | 切换 transcript 视图 |
| `Ctrl+Shift+B` | 切换 brief |
| `Ctrl+Shift+O` | 切换 teammate 预览 |
| `Ctrl+R` | 历史搜索 |

> `Ctrl+C`、`Ctrl+D`、`Ctrl+M`（等同 Enter）为 **NON_REBINDABLE**（硬编码，重绑会报错）。`Ctrl+Z`（SIGTSTP）、`Ctrl+\`（SIGQUIT）被终端/OS 拦截。macOS 下 `Cmd+C/V/X/Q/W/Tab/Space` 被系统保留。

### Chat（输入框聚焦时）

| 快捷键 | 作用 |
|--------|------|
| `Enter` | 提交输入 |
| `Ctrl+J` | 换行（多行输入） |
| `Ctrl+L` | 清空输入框 |
| `Ctrl+K` / `Cmd+K` | 清屏 |
| `Escape` | 取消（中断生成 / 关闭面板） |
| `Shift+Tab` | 循环切换权限模式（default → acceptEdits → plan）；Windows 无 VT 模式时为 `Meta+M` |
| `Meta+P` | 模型选择器 |
| `Meta+O` | fast mode 切换 |
| `Meta+T` | 切换 extended thinking |
| `↑` / `↓` | 上一条 / 下一条历史 |
| `Ctrl+_` / `Ctrl+Shift+-` | 撤销 |
| `Ctrl+X Ctrl+E` / `Ctrl+G` | 外部编辑器 |
| `Ctrl+S` | stash |
| `Ctrl+V` | 粘贴图片（Windows 为 `Alt+V`） |
| `Ctrl+X Ctrl+K` | 终止所有代理 |

> `Meta` 在 macOS 为 `Cmd`，在 Linux/Windows 为 `Alt`。`Meta+T` 是 thinking 切换（不是 `Alt+T`）。

### Autocomplete（自动补全）

| 快捷键 | 作用 |
|--------|------|
| `Tab` | 接受补全 |
| `Escape` | 关闭补全 |
| `↑` / `↓` | 上一个 / 下一个候选 |

### Confirmation（权限确认对话框）

| 快捷键 | 作用 |
|--------|------|
| `Y` / `N` | 是 / 否 |
| `Enter` | 确认（是） |
| `Escape` | 取消（否） |
| `Shift+Tab` | 循环权限模式 |
| `Ctrl+E` | 切换说明展开 |
| `Ctrl+D` | 切换 debug 视图 |

### Scroll（滚动）

| 快捷键 | 作用 |
|--------|------|
| `PageUp` / `PageDown` | 翻页 |
| `Ctrl+↑` / `Ctrl+↓` | 行滚动 |
| `Ctrl+U` / `Ctrl+D` | 半页滚动 |
| `Ctrl+B` / `Ctrl+F` | 全页滚动 |
| `Ctrl+Home` / `Ctrl+End` | 顶部 / 底部 |
| `Ctrl+Shift+C` / `Cmd+C` | 复制选区 |

### HistorySearch（历史搜索，`Ctrl+R` 进入）

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+R` | 下一个匹配 |
| `Escape` / `Tab` | 接受 |
| `Ctrl+C` | 取消 |
| `Enter` | 执行 |

### Task

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+B` | 移到后台 |

### Transcript

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+E` | 切换显示全部 |
| `Ctrl+C` / `Escape` / `Q` | 退出 |

## 特殊前缀输入

在输入框行首输入：

| 前缀 | 作用 |
|------|------|
| `/` | 斜杠命令（弹出列表与自动补全） |
| `@` | 文件引用（读取文件纳入上下文，带路径补全） |
| `!` | bash 模式（直接执行 shell 命令；可用 `disableSkillShellExecution` 禁用） |
| `#` | 记忆模式（写入记忆） |

## vim 模式

OCC 内置 vim 编辑模式（`src/vim/`）。

### 启用

在全局配置中设 `editorMode: 'vim'`（默认 `'normal'`）。`EDITOR_MODES = ['normal', 'vim']`。

```bash
# 通过 /config 交互式设置
> /config

# 或 CLI 标志
occ --editor vim
```

> 没有 `/vim` 命令（已在 2.1.92 移除）。vim 状态显示在 `StatusLine` 中。

### 模式

| 模式 | 说明 |
|------|------|
| `INSERT` | 插入模式（初始状态，跟踪 `insertedText` 供 dot-repeat） |
| `NORMAL` | 命令模式（状态机） |
| `VISUAL` | 可视模式（`v` 进 char，`V` 进 line，带 `anchor`） |

### 状态机

`CommandState`：`idle`、`count`、`operator`、`operatorCount`、`operatorFind`、`operatorTextObj`、`find`、`g`、`operatorG`、`replace`、`indent`、`textObject`。

### 操作符与移动

| 类别 | 按键 |
|------|------|
| 操作符 | `d`=删除、`c`=改写、`y`=yank |
| 移动 | `h`/`l`/`j`/`k`、`w`/`b`/`e`/`W`/`B`/`E`、`0`/`^`/`$` |
| 查找 | `f`/`F`/`t`/`T` |
| 文本对象 | `i`(inner)/`a`(around) + `w`/`W`/`"`/`'`/`` ` ``/`(`/`)`/`b`/`[`/`]`/`{`/`}`/`B`/`<`/`>` |

持久状态：`lastChange`（dot-repeat `.`）、`lastFind`、`register` + `registerIsLinewise`。`MAX_VIM_COUNT = 10000`。

NORMAL 模式下方向键映射到 vim 移动（`←`→`h`、`→`→`l`、`↑`→`k`、`↓`→`j`）。

## 键位配置文件

`~/.claude/keybindings.json`（`getKeybindingsPath()`）：

```jsonc
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+k": "chat:clearScreen",
        "shift+tab": "chat:cycleMode",
        "ctrl+h": "command:help",
        "ctrl+g": null
      }
    }
  ]
}
```

- `context` —— 上下文枚举（`Global`/`Chat`/`Autocomplete`/`Confirmation`/`Transcript`/`HistorySearch`/`Task`/`Scroll` 等）。
- 值 —— 动作枚举，或 `command:<name>` 运行斜杠命令，或 `null` 解绑。
- 修饰键名：`ctrl`/`control`、`alt`/`opt`/`option`、`meta`/`cmd`/`command`、`shift`。组合用空格：`"ctrl+x ctrl+e"`。

> **注意**：如前述，外部 OCC 用户修改此文件不生效（GrowthBook flag 限制）。用户绑定在默认之后合并（`[...defaultBindings, ...userParsed]`），故用户绑定覆盖默认。

## 相关设置

| 设置键 | 作用 |
|--------|------|
| `leftArrowOpensAgents` | 左箭头打开 FleetView（默认 true） |
| `wheelScrollAccelerationEnabled` | 滚轮加速 |
| `autoScrollEnabled` | 新输出自动滚动（默认 true） |
| `prefersReducedMotion` | 减少动画（无障碍） |
| `defaultShell` | `!` 命令的默认 shell |
| `editorMode` | 编辑模式（`normal`/`vim`） |

## 滚动速度

```bash
> /scroll-speed
```

## 与 Claude Code 的差异

- **自定义键位受限**：Claude Code 的键位自定义同样受 GrowthBook flag 控制；OCC 中 GrowthBook 为空实现，flag 恒为 false，因此**外部用户无法自定义键位**，只能用默认绑定。
- 默认绑定与 Claude Code 一致。
- vim 模式实现一致。

## 下一步

- [斜杠命令](./slash-commands.md) —— `/keybindings`、`/scroll-speed`。
- [配置](./settings.md) —— `editorMode` 等设置项。
- [权限](./permissions.md) —— `Shift+Tab` 权限模式切换。
