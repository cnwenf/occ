# OCC-103 — 2026-08-24 版本追齐 2.1.240 → 2.1.241(官方 "Bug fixes and reliability improvements";二进制取证确认零新增可移植面 + 严格自验收)

## 1. 版本状态(三方核实,2026-08-24)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = 2.1.241,next = 2.1.241(stable = 2.1.231),published 2026-08-22T23:58Z |
| GitHub releases | v2.1.241(Latest,2026-08-23T00:52Z),body 仅 "Bug fixes and reliability improvements" |
| OCC(追齐前) | 2.1.309,行为面对齐官方 2.1.240 → 本轮 gap = **1 个版本(2.1.241)** |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64`,`npm pack` 原样解包):

| 文件 | 字节数 | md5 |
|------|--------|-----|
| 2.1.240 `claude` ELF | 342,636,848 | `8494744db1e5ff50dd54d5ce53c8746e`(与 OCC-102 取证一致) |
| 2.1.241 `claude` ELF | 342,636,848(**与 2.1.240 逐字节等长**) | `8326230ad538d59d4828ebf44e3932ea` |

strings 转储(`strings -n 8`):strings240.txt / strings241.txt,各 521,621 行(**行数完全相同**)。

版本标记计数:

| 标记 | 2.1.240 ELF | 2.1.241 ELF |
|------|-------------|-------------|
| `2.1.240` | 125 | 0 |
| `2.1.241` | 0 | 125 |
| `2.1.242+` | 0 | 0 |

`2.2.0/2.2.2/2.2.5/2.2.6` 命中为两版共有的第三方库版本串(如 PowerShell `Az.Accounts -MinimumVersion 2.2.0`),非 claude-code 版本标记。

重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐 issue。

## 2. 结论:2.1.241 零新增可移植面

### 2.1 全量 strings 级比对

`diff strings240.txt strings241.txt` = 5,114 个 hunk、每侧 7,426 行差异。逐类归因后**全部为 minifier 标识符重命名噪声**(每次重新编译混淆名变化,如 `Cannot call a class constructor A3u/AEa without`、`zfS`→`WfS`):

- 人类可读短语(≥4 词)指纹比对(剥离标识符后按前 80 字符指纹去重):**真新增 = 0,真删除 = 0**。即 2.1.241 没有任何新的错误消息、帮助文本、设置 `.describe()`、提示文案。
- 环境变量面:对两版二进制做 `CLAUDE_CODE_*` / `ANTHROPIC_*` 全量扫描,初看的 ~40 个"新增/删除"候选经精确出现次数核验全部为字符串表尾部粘连噪声(如 `CLAUDE_CODE_DISABLE_CRON` 两版各 6 次、`CLAUDE_CODE_RETRY_WATCHDOG` 各 4 次、`ANTHROPIC_CONFIG_DIR` 各 8 次……逐一相等)。
- 斜杠命令注册表(`type:"(local-jsx|local|prompt)",name:"..."` 全集):**两版完全一致**。
- 工具名、hook 事件名、模型注册面:`name:"Bash"` ×2、`"PreToolUse"` ×39、`"PostToolUse"` ×45、`"Stop"` ×55、`"SessionStart"` ×27、`"DirectoryAdded"` ×6、`claude-opus-5` ×80、`claude-opus-4-8` ×99、`claude-sonnet-4-5` ×80 —— 两版逐项相等。

### 2.2 2.1.239 可移植簇复核(计数与 2.1.239/2.1.240 完全一致)

`killRange` ×6、`getReadlineWordBoundaries` ×4、`backwardKillWord` ×5、`placeholderEndingAt` ×4、`placeholderStartingAt` ×5、`placeholderContaining` ×4、`snapOutOfPlaceholder` ×6、`deleteWordBefore`/`deleteWORDBefore`/`deleteWordAfter`/`deleteToLineStart`/`deleteToLineEnd` 各 ×5 —— 240↔241 无任何变化。

### 2.3 唯一原始 delta 的归因(字符串表打包噪声,非功能差异)

strings 表中 240 有独立条目 `;|&$()`<>["`、241 对应条目为 `;|&$()`<>`(差 `["` 两字符)。深查:

- 两版**源码文本**中该字面量均只出现一次,且都是 10 字符版 `";|&$()`<>"`(`CLAUDE_CODE_PROCESS_WRAPPER` argv 解析器的元字符常量;240 `zfS` / 241 `WfS`)。12 字符版在两版源码中均不存在(0 次)。
- 解析器函数本体逐段比对(240 `GfS` / 241 `qfS`):JSON 数组分支、双引号状态机、`unquoted shell metacharacter` / `unterminated double quote` / 空元素错误消息 —— **除混淆名外逐字节一致**;错误消息所列元字符集 `; | & $ ( ) ` < >` 也与 10 字符常量一致。
- 相关计数:`CLAUDE_CODE_PROCESS_WRAPPER` 两版各 17 次、`unquoted shell metacharacter` 各 1 次、`unterminated double quote` 各 2 次。
- 240 表中多个相邻条目(`getState` 等)也带同样的 `["` 尾部粘连 —— 字符串表打包产物,非源码面。

## 3. 已对齐、本轮无动作

OCC-102 §3/§4.2 所列全部预存分歧(Ctrl+A/E logical-line、Ctrl+K 归属、左箭头手势簇、home/end/page/return ctrl 守卫、CSI-u Ctrl+Enter、super+arrow、vim 词吸附、kill ring 结构)在 241 二进制中逐字节未变,维持原状;§4.3 的官方修复候选(2.1.241 未涉及)继续留待专项。

## 4. Staged 项

无新增。2.1.241 release notes 仅 "Bug fixes and reliability improvements",changelog 无任何条目可 triage;二进制取证(§2)确认无隐藏新面 —— 与 2.1.240 在 OCC-102 的结论同型。

## 5. 自验收(版本追齐后的自验收,2026-08-24)

本轮无 gap 可补,按 issue 要求执行严格自验收(像人类用户一样使用 OCC,并与官方 2.1.241 二进制对照):

- `bun install --frozen-lockfile` + `bun run build`:绿,`dist/cli.js` 28.92 MB。
- `bun test src`:**2174 pass / 8 fail / 5039 expect()** —— 8 个失败与 OCC-102 基线完全一致(2.1.202/2.1.216 telemetry ×2 + 2.1.218 agentHookTrust,历轮 A/B stash 核过的预存项),无回归。
- e2e:`occ-versioning` + `commands-alignment` **6 pass / 0 fail**;`version-2.1.239-keybinding-flavor`(tmux 真实键序列,2.1.239 簇)**4 pass / 0 fail**。
- 与官方 2.1.241 对照:`--version` 正常(`OCC 2.1.309` vs `2.1.241 (Claude Code)`);`mcp --help` / `mcp login --help` / `mcp logout --help` 逐项 diff —— 仅差产品名(`occ` vs `claude`)与已记录的 Gap-5 顶级帮助换行延迟项,无新分歧。
- 真机 REPL(tmux):`--dangerously-skip-permissions` 启动、欢迎面/状态栏正常 → 真实对话回合(`say exactly: REPL-OK` → 模型回复 `REPL-OK`)→ `/status` 面板(版本/会话/鉴权/基址)→ `/exit` 正常退出。
- `-p` 管道:`echo "say PONG" | occ -p` → `PONG`(workspace 代理模型 `glm-5.2` 触发 OCC-95 移植的 `[claude-code:unrecognized_model]` 诊断,行为符合官方设计)。

自验收未发现任何与官方不一致的新 gap。

## 6. 发布

版本指针推进到 2.1.241,发布 **2.1.310**:docs-only + 版本号变更,无 `src/` 行为改动;安全审查 = 本 diff 无代码路径变化(无后门面)。
