# OCC-104 — 2026-08-25 版本追齐自验收(官方 latest 仍为 2.1.241,无版本 gap;自验收发现并修复 1 处预存 help 文案对齐缺口)

## 1. 版本状态(三方核实,2026-08-25)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = 2.1.241,next = 2.1.241(stable = 2.1.231),published 2026-08-22T23:58Z |
| GitHub releases | v2.1.241(Latest,published 2026-08-23T00:52Z),body 仅 "Bug fixes and reliability improvements" |
| npm time 序列 | 2.1.240(08-22)→ 2.1.241(08-22)之后**无任何新版本**;2.1.241 即当前官方最新 |
| OCC(追齐状态) | 已在 OCC-103 追齐 2.1.241(发布 2.1.310),行为面对齐 → **本轮版本 gap = 0** |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64@2.1.241`,`npm pack` 原样解包):

| 项 | 值 |
|----|----|
| `claude` ELF 字节数 | 342,636,848(与 OCC-103 记录一致) |
| `claude` ELF md5 | `8326230ad538d59d4828ebf44e3932ea`(**与 OCC-103 取证完全相同**,即同一二进制) |
| 版本标记 | `2.1.241` 字符串存在;`2.1.242` / `2.1.243` = **0** 次(无更新版本面) |

重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐 issue(`multica issue search 追齐` 仅命中本 issue;`--status in_progress` 项目内仅本 issue;前一轮 OCC-103 状态为 done)。

## 2. 结论:无版本 gap,本轮为版本追齐后的自验收

官方最新仍为 2.1.241,OCC-103 已追齐并做了零新增面的二进制取证。按 issue「版本追齐后的自验收」要求,本轮执行严格自验收(像人类用户一样使用 OCC,并与官方 2.1.241 二进制逐项对照),重点是 **OCC REPL 与官方 `claude-code` 交互的一致性**。

## 3. 自验收过程与结果

### 3.1 构建与单测(基线对照,无回归)

- `bun install --frozen-lockfile` + `bun run build`:绿,`dist/cli.js` 28.92 MB,`MACRO.VERSION=2.1.310`、`MACRO.BINARY_NAME=occ`。
- `bun test src`:**2174 pass / 8 fail / 5039 expect()** —— 与 OCC-102/103 基线完全一致;8 个失败为历轮 A/B 核过的预存项(2.1.202 telemetry ×2、2.1.216 interactive-permission telemetry ×1、2.1.218 agentHookTrust ×5),无回归。

### 3.2 对齐类 e2e(全绿)

- `occ-versioning` + `commands-alignment` + `version-2.1.238-keybinding-flavor` + `version-2.1.239-keybinding-flavor`:**12 pass / 0 fail / 33 expect()**。
- `commands-behavior` + `mcp-connection-nonblocking` + `resume-interrupted-turn-221`:**17 pass / 1 fail**;唯一失败为 `/feedback`(见 §5,模型依赖、预存、与本轮改动无关)。

### 3.3 `-p` 管道 + 真机 REPL(tmux,像人类用户使用)

- `-p` 管道:`echo "say exactly: PONG" | occ -p` → `PONG`,exit 0(workspace 代理模型 `glm-5.2` 触发 OCC-95 移植的 `[claude-code:unrecognized_model]` 诊断,行为符合官方设计,与 OCC-103 一致)。
- 真机 REPL(tmux,`--dangerously-skip-permissions`):
  - 启动:欢迎面 `OCC v2.1.310` + "Welcome back!" + Recent activity + **What's new feed**(正确拉到 OCC-103 的 CHANGELOG 段落,release-notes 管线工作)+ 状态行 `glm-5.2 with xhigh effort`。
  - 真实对话回合:`say exactly: REPL-OK` → 模型回复 `● REPL-OK`,turn 正常收尾。
  - `Shift+Tab` 权限模式切换:底部状态从 `⏵⏵ bypass permissions on` → `⏸ manual on`(2.1.239 keybinding 簇行为正常)。
  - `/status` 面板:Status/Config/Usage 三 tab,Version 2.1.310、Session ID、cwd、Auth token、base URL、Model glm-5.2、MCP servers 3 connected、Setting sources 均正常渲染;`/exit` 干净退出。

### 3.4 help 面与官方 2.1.241 二进制逐项对照(本轮重点)

对全部 `mcp` 子命令的 leaf `--help` 与官方二进制逐一 `diff`(仅归一化产品名 `claude`→`occ`、`(Claude Code)`→`(OCC)`):

| 命令 | 结果 |
|------|------|
| `mcp login --help` / `mcp logout --help` | 一致 |
| `mcp add` / `add-json` / `add-from-claude-desktop` / `remove` / `reset-project-choices` / `serve` `--help` | 一致 |
| `mcp get --help` / `mcp list --help` | **发现缺口 → 已修复**(见 §4) |
| `mcp --help`(多子命令 Commands 列表)/ 顶级 `--help` | 仅 Gap-5 换行布局差异(CLAUDE.md 已记录的 by-design 延期项)+ 产品名,**无新分歧** |

## 4. 本轮发现并修复的 gap(预存,非 2.1.241 新增)

**Gap-104a:`mcp get` / `mcp list` 的 `--help` 描述缺少 "unless disabled for this project."**

- 官方 2.1.241 二进制中两条描述均为:`...approved servers are health-checked unless disabled for this project.`(`strings` 提取确认,该从句在 ELF 中出现)。
- OCC 修复前(`src/main.tsx`):描述在 `...health-checked.` 处截断,缺尾从句。
- 归因:OCC-103 已取证 2.1.241 零新增人类可读短语,故该从句必早于 2.1.241 存在 —— 属**历轮对齐遗漏的预存缺口**,非本轮新版本引入;CLAUDE.md 与 gap 文档均未将其记录为 by-design 分歧。
- 修复:在 `src/main.tsx` 的 `mcp.command('list')` / `mcp.command('get <name>')` 两处 `.description()` 末尾补上 ` unless disabled for this project.`。
- 验证:重新构建后 `mcp get --help` / `mcp list --help` 与官方 2.1.241 **逐字节一致**(仅产品名归一化);对齐类 e2e 复跑 12 pass / 0 fail,`bun test src` 复跑 2174/8 与基线一致,无回归。无测试断言旧文案(`grep` 确认),纯文案对齐无行为面副作用。

## 5. 已知预存项(与本轮改动无关,不在本轮处理)

- `/feedback` e2e(commands-behavior)为 **OCC 自定义的 AI 驱动命令**,成功提示文案由模型自由生成(本轮实际产出 "Issue filed successfully." / "**Issue URL:**",而测试断言的是 "Issue created:"),且依赖真实 `gh issue create`、60s 超时,天然 flaky;两轮分别表现为超时(-1)与文案不匹配。与本轮 mcp 文案改动无任何关联。自验收期间该测试误建的真实 issue #299 已用 `gh issue close` 清理。
- 8 个单测失败、顶级/多子命令 help 的 Gap-5 换行布局:均为历轮已记录、已归因的预存项,维持原状。

## 6. 发布

本轮唯一行为改动为 Gap-104a 的 help 文案对齐(真实改动,非 no-op),按发版流程发布 **2.1.311**:CHANGELOG + `package.json` 版本号 → 合入 main → 打 tag `v2.1.311` 触发 publish.yml(build → npm publish → GitHub Release)。安全审查 = 本 diff 仅两处 `.description()` 字符串,无代码路径/逻辑变化,无后门面。
