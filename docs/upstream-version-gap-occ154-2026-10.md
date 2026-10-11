# Upstream Version Gap — OCC-154 (2026-10-11 round)

轮次定位：官方 `latest` = `next` = **2.1.296**（2026-10-09T16:58Z 发布；OCC-153 轮时为 next-only 无 changelog 只建档，**现已晋升 latest 且官方 CHANGELOG 已落地 `## 2.1.296` 段 = 79 条**）。OCC main（HEAD `6ff64c8`，package version `2.1.378`，README badge "Now tracking Claude Code 2.1.295"）→ **本轮 gap = 2.1.296 全量移植 + OCC-153 STAGED 结转收口（含 §9.2 salvage 分支采纳裁决）**。调研由 Leader 按 `upstream-tracking` / `aligning-with-official-binary` skill 纪律完成；本轮为**调研级**（changelog + OCC 侧 grep 实证 + 复用 occ153 已录 ELF 基线），逐站点 ELF 取证归移植轮（§5.1 纪律），未取证站点一律标 CAND/CAND-v，**Never invent**。

## §0 版本事实（npm × 官方 CHANGELOG × 已录 ELF 基线）

npm dist-tags（2026-10-11 核查）：`latest=2.1.296`，`next=2.1.296`（latest/next 同点 → 无 next-only 顺延项），`stable=2.1.287`（286→287 移动，stable 族不在追齐口径）。

官方 CHANGELOG 快照（2026-10-11，raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md，8,789 行）：顶部段 `## 2.1.296` = **79 条**；无 `## 2.1.297` 段。

2.1.296 ELF 基线（**occ153 §0/§4 已录，可复现基准，本轮不重复下载**）：linux-x64 ELF md5 `3c8749470f70a26efadf982b587e1548`，257,068,216 B，自身版本标记 2644 raw / 153 strings 行；vs 2.1.295 strings 差分 **added 17,942 / removed 16,806**（s296=319,894）。移植轮按 occ153 §6.1 重新 `npm pack @anthropic-ai/claude-code-linux-x64@2.1.296` 并核对 md5 后方可取证。

OCC 侧现状：GitHub tags=releases **177=177 零缺口**（occ153 §10.2）；Releases Latest = `v2.1.378`（已按 §10.1 Option A 重指到已验收树 `f7ca298`）。npm `@cnwenf/occ` latest 仍 **2.1.367**（**OCC-151 blocked**，等 owner 轮换 NPM_TOKEN；债务不在本轮重复立项）。远端分支 = `main` + 载体分支 `agent/occ/f29b7705-1791569680`（§9.2 有意保留，本轮采纳载体）。

## §1 本轮范围（三块）

1. **2.1.296 全量 79 条**：triage 见 §3。P0×2 + P1×13 + P2×22 + P3×13 + N/A×29。
2. **OCC-153 §9.2 裁决兑现（salvage 采纳）**：分支 `agent/occ/f29b7705-1791569680`@`1d4bbd2` 含 295-STAGED-P1×8 的完整移植（#017 printTextResults、#035 context.ts worktree、#037半 launchToolList、#044 bash ast for-loop glob、#056 markdownWindowed、#067 markdownBlockquote、#072 StreamingToolExecutor applied-layers、#091 hljsGrammarPatches/hljsLimit；**编号为 295 changelog 序号**，v295 ELF md5 `4f067be625a3fc99f1c76a563d14cfdb` 取证在案）→ 本轮 cherry-pick/参照移植，把 occ153 §8.2 从 10 收敛到 2（#090/#095 rewind 子系统合并取证后定夺）。**采纳警示（§9.2 原文）**：#056/#067/#091 与 main 已审 P0 render 簇（stripRawHyperlinks/conceal、normalize-text tab 展开）有交互，对位调和而非盲目覆盖；附带摘取 `test/commands/clear/clear-cost-reset.test.ts` 的 `mock.module` live-binding 毒化修复。
3. **occ153 §8.3 STAGED P2/P3×49 + §5 结转债务**：按性价比取舍；未消化项在本账本追加新 § 记 STAGED，**no-silent-drop**。occ153 §4 侦察线索（`CLAUDE_CODE_SLEEP_COMPACT` 等 295 无 changelog token 是否在 296 有对应条目）由移植轮 ELF token 差分覆盖（本轮 OCC 侧 grep：SLEEP_COMPACT=0 命中，维持）。

## §2 OCC 侧 grep 实证（main @`6ff64c8`，本轮 Leader recon，命令可复现：`grep -rl <tok> src/ packages/`）

**0 命中（真缺口候选，PORT）**：`allow_large`（#006）、`BASH_ARGV0`（#031，另需 bash 权限赋值路径取证）、`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`（#003）、`CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`（#004）、`CLAUDE_CODE_SLEEP_COMPACT`（侦察项）。

**面已存在（CAND/CAND-v 站点线索）**：
- `autoCompactWindow`：8 文件（`src/utils/autoCompactWindow.ts` 会话级 + `main.tsx` CLI 入口）；**AgentTool/schema 0 命中** → #002 = 既有基建向 subagent frontmatter 的扩展，真缺口在 frontmatter 侧。
- `DEFAULT_MAX_MCP_DESCRIPTION_LENGTH = 2048`（`src/services/mcp/client.ts:293`；tool-search 16384 已随 295#112 落地）→ **#061 直接 PORT 站点**（前置默认 cap 2048→4096 + server instructions 同 cap；注意与已落地 16384 tool-search 路径的层级关系需官方 ELF 取证）。
- `src/utils/modelCost.ts:337`：Sonnet 5.5 = `tier_2_10`，注释明记 cache_read **$0.20**（2.1.284 binary-verified）→ **#059 直接 PORT 站点**（cache read $0.20→$0.10；`/cost`、status line、`--max-budget-usd`、SDK cost 同源）。
- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`：4 文件（`cli/print.ts`、`utils/conversationRecovery.ts`）→ #030 CAND（MCP tool result 结束 turn 后的 finished-turn 重跑守卫）。
- `updatedMCPToolOutput`：5 文件 → #008 CAND（managed PostToolUse 应用路径）。`UserPromptSubmit`：21 文件 → #019 CAND。`disabledMcpServers`（`services/mcp/config.ts:1954+`）→ #009 CAND。`purge`：6 文件 → #046 CAND。`git_commit_id`：1 文件 → #044 CAND-v。`dataviz`：3 文件 → #060 CAND-v（OCC skill .md 历史上有 stub 面，需核 dataviz 是否实体）。`teleport`：69 文件 → #012 CAND。`redact`：106 文件 → #016 CAND（key-no-value 后随值漏redaction 具体站点需取证）。`52;c`：1 文件 → #017 CAND（OSC 52 copy 面存在）。`optionKeySafety`：3 文件（295#062 已落）→ #027/#028 CAND（同 prototype-key 族，marketplace 名与 plugin secret 面）。
- `src/tools/FileEditTool.ts`：**UTF-8 有效性校验 0 命中** → #032 疑似真缺口（非 UTF-8 文件 Edit/NotebookEdit 应拒绝而非替换非 ASCII 字符；数据损坏面）。
- `src/tools/WorkflowTool/WorkflowTool.ts:565`：`JSON.stringify(result, null, 2)` **无深度守卫** → #023 疑似真缺口（深嵌套截断 + 巨型 task output 文件，DoS 面；workflow 引擎为 LIVE flag）。
- `src/tools/BashTool/destructiveCommandWarning.ts:1661`：已有 Git Bash drive-root（反斜杠裸目标）检测 → #050 CAND-v（`/c/Users/<name>` home 面在 bypass 模式下是否询问，需核）。

**取证教训沿用（occ153 §9.3）**：grep 0 命中 ≠ 无受攻击面；N/A 判定不得只凭 grep 0 命中，接线型修复要核基建。

## §3 2.1.296 changelog 逐条 triage（79 条）

处置代号同 occ153 §3：P0/P1/P2/P3 = 本轮优先级；PORT = OCC 面已证 0 命中/直接站点的真缺口；CAND = 候选（面已证存在）；CAND-v = 需先核验 OCC 对应面；N/A-x = 族级无面。**每条落地前仍需官方 ELF 逐站点取证（§5.1），本表是队列不是结论。**

| # | 处置 | 摘要 |
|---|---|---|
| 001 | N/A-GATEWAY | Claude apps gateway `managed.policies[]` 新增 `code` key（Desktop Code tab） |
| 002 | P1-CAND | subagent frontmatter + `--agents` 定义支持 `autoCompactWindow`（会话级基建已在，frontmatter 侧 0 命中） |
| 003 | P2-PORT | `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`：workflow agent 统一模型（workflow 引擎 LIVE，token 0 命中） |
| 004 | P2-PORT | `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`：529 退避上限（`withRetry.ts` 族，token 0 命中） |
| 005 | P3-CAND-v | `/plugin` 提示 hooks 因同名 plugin 被略过（plugin hooks 薄层面需核） |
| 006 | P1-PORT | Read tool `allow_large` 选项：超常规大小限制一次读全文件（模型可见 schema 面，0 命中） |
| 007 | P1-CAND-v | managed-settings `PreToolUse` hooks `"continue": false` 拒绝后未结束 turn + managed `prompt` hooks 阻断同款（managed settings 面需核；hook 阻断语义正确性） |
| 008 | P1-CAND | managed PostToolUse hooks 部分会话未应用 `updatedMCPToolOutput`（5 文件面） |
| 009 | P1-CAND | headless 会话在 cd/reload plugins 后启动了该文件夹已关闭的 `.mcp.json`/plugin MCP server（`disabledMcpServers` 面） |
| 010 | N/A-GATEWAY | gateway `allowedProviders` 含 `"gateway"` 锁死笔记本 |
| 011 | N/A-GATEWAY | `forceLoginMethod:"gateway"` 无 URL 时 saved sign-in 被忽略（295 回归） |
| 012 | P2-CAND | `--teleport` 在 session history 读不到时打开空对话（69 文件面） |
| 013 | P2-CAND-v | Haiku 5.5 等 adaptive-thinking-only 模型 token 计数（gateway 失败部分 N/A；budget-thinking 误计部分核 OCC 计数面） |
| 014 | P1-CAND | resumed subagent 被告知"用户拒绝了被会话关闭打断的 tool call"（`resumeAgent.ts` 面） |
| 015 | P2-CAND-v | hook 输出含类似 plugin hint tag 文本时被改写 |
| 016 | P1-CAND | **安全**：shared transcripts/debug logs 秘密 redaction 漏掉 key-no-value 后随值（含 shell 串内 JSON）（106 文件 redact 面，站点需取证） |
| 017 | P2-CAND | 老 VTE 终端（MATE 等）copy 后残留 `52;c;…` 转义串（OSC 52 面 1 文件） |
| 018 | P3-CAND-v | `/diff` 面板/对话框打开期间 toasts/通知不可见挂起 |
| 019 | P1-CAND | **安全相邻**：`UserPromptSubmit` hook（及 mod `prompt.submit`）期间 Esc/interrupt → headless 会话被结束、已输入 prompt 被清、或**未经检查的 prompt 被放行**（mod 半 N/A；hook 半 21 文件面） |
| 020 | P2-CAND-v | headless 启动后加载的 plugin 的 SessionStart hooks 因同名（或变体拼写）plugin 已跑而被跳过 |
| 021 | N/A-RUNNER | `claude self-hosted-runner` 注册被拒错误信息 |
| 022 | N/A-RUNNER | runner `--capacity`>1 同仓会话 git fetch/pull/push 失败 |
| 023 | P1-PORT | workflow 脚本结果/agent options 嵌套 >~20,000 层静默截断 + 深嵌套结果写出巨型 task output 文件（`WorkflowTool.ts:565` 无守卫；DoS 面） |
| 024 | N/A-MODS | plugin `$` 方法在主会话 cwd 运行、忽略 calling hook 的 turn |
| 025 | N/A-MODS | mod reload/remove 后仍在跑的 hook `$.agent.register` 成功（应拒绝） |
| 026 | N/A-MODS | `$.http.fetch` HEAD 请求 Content-Length>4MiB 被拒 |
| 027 | P2-CAND | marketplace 名为 `constructor` 时 `marketplace add/update`、`plugin install` 内部错误 → `add` 明确拒绝（optionKeySafety 同族） |
| 028 | P2-CAND | plugin secret 名 `constructor`/`prototype` 被下次保存删除（295#062 同族） |
| 029 | N/A-CLOUD | cloud sessions auto mode 对 Chrome actions 的检查跳过 |
| 030 | P1-CAND | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 重启后把 MCP tool result 已结束的 finished turn 重跑（4 文件面；OCC-44 已落 falsy-honor，此为语义补丁） |
| 031 | **P0-CAND** | **安全（权限绕过）**：Bash 权限检查对"赋值 `BASH_ARGV0` 再使用"的命令自动放行 → 现应询问（OCC bash 权限链 = OCC-44/46 敏感链，AST+legacy 双路径都要核；token 0 命中） |
| 032 | **P0-PORT** | **数据完整性**：Edit/NotebookEdit 对非有效 UTF-8 文件（Windows-1252/Shift-JIS/GBK）替换所有非 ASCII 字符 → 现应拒绝编辑（FileEditTool UTF-8 校验 0 命中；与 occ153-F4 CRLF-cache 修复同文件族，注意对位） |
| 033 | P2-CAND | `←` 后立刻发送的 prompt 在 bg service 慢时被跑两次（一次前台不可见）（autoBackground 面；与 occ153-F3 kill-race 修复同族） |
| 034 | P2-CAND | SessionStart hooks 仍在跑时发送的 prompt 随 `←` 移 bg 而消失 → 仍不发送但 `↑` 可取回 |
| 035 | P2-CAND-v | headless 会话中迟加载 plugin 的 SessionStart hook 输出在 `/clear` 后到达新对话 |
| 036 | P2-CAND-v | PowerShell 命令看不到 hooks 写入 `CLAUDE_ENV_FILE` 的变量（纯赋值时）（295#071 Bash 侧已落，PowerShell 面需核） |
| 037 | N/A-CLOUD | cloud sessions 被称 non-interactive 并建议 `/mcp` |
| 038 | P3-CAND-v | `/code-review` 在 cloud/SDK/IDE 以 raw JSON array 结束 → 编号列表（cloud/IDE 分发面 N/A 成分；OCC 自有 /code-review 面需核） |
| 039 | P2-CAND-v | auto mode 偶发拒绝更新自己的 artifact（误判 sharing 变化）（auto mode LIVE + Artifact 11 文件） |
| 040 | P3-CAND-v | claude.ai 同步 skills 多会话共享 config 目录时永不完成安装、每次重下（claude.ai-sync 面，occ153#094 同族） |
| 041 | P3-CAND-v | claude.ai 同步 plugin 因其 marketplace 依赖也是同步来源而被禁用 |
| 042 | P2-CAND | macOS 启动挂起：Linux 机器拷来的 plugin 路径指向 /home 下（启动挂起修复，跨平台价值） |
| 043 | P2-CAND | Workflow tool 拒绝 CRLF 行尾脚本文件（Windows checkout 场景；workflow LIVE） |
| 044 | P3-CAND-v | OTEL `tool_result` 事件在 `git commit -q` / `git -C <dir> commit` 后缺 `git_commit_id`（1 文件面） |
| 045 | P2-CAND-v | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` 丢弃文本含 U+2028/U+2029 的消息（GC 面宽度需核：仅 1 test 文件命中 token） |
| 046 | P2-CAND | `claude purge` 对含 U+2028/U+2029 的 prompt 留在 history 文件（与 #045 同字符族，purge 6 文件面） |
| 047 | P3-CAND-v | Windows：PowerShell >1KB 命令恒询问 → allow 规则/只读检测适用到 32KB |
| 048 | P2-CAND-v | Windows：stdio MCP server 关机被强杀 → 先关 stdin，300ms 后仍活才杀进程树（graceful-shutdown 逻辑跨平台通用，Windows tag 需核 OCC 对应面） |
| 049 | P3-CAND-v | Windows：无 GitHub SSH key 机器上 `plugin install` GitHub `owner/repo` 源失败 → HTTPS 重试 |
| 050 | P1-CAND-v | **安全（Windows）**：bypass permissions 模式下 Git Bash `rm -rf /c/Users/<name>` 不询问（`destructiveCommandWarning.ts` 已有 drive-root 检测，home-dir 面需核；bash 权限敏感链） |
| 051 | P3-CAND-v | fullscreen 模式鼠标指针下链接加下划线 |
| 052 | P2-CAND | ctrl+o transcript toggle 在代码重对话中卡顿 → 缓存语法高亮块（与 salvage #091-295 hljsGrammarPatches/hljsLimit 交互，合并处理） |
| 053 | N/A-GATEWAY | Desktop Code tab gateway 会话不能启动的原因回显 |
| 054 | N/A-CLOUD | cloud session 被拒错误说明 org policy 加载失败原因 |
| 055 | P2-CAND | `--debug` 输出点名 custom agent 文件未识别 frontmatter 字段 + typo 提示（295 B1 schema/校验族延伸） |
| 056 | P3-CAND-v | auto mode 检查无可用答案时 tool call 显示 dim "Not run" 行而非红色错误 |
| 057 | P3-CAND | `--debug` hooks 日志：command hooks 完成时记录 command/plugin/outcome/duration（慢 hook 可定位） |
| 058 | P3-CAND-v | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`：重写大 transcript 文件仅当能省 ≥10%（与 #045 同族） |
| 059 | P1-PORT | Sonnet 5.5 cache read 定价 $0.20→**$0.10**/MTok（`/cost`、status line、`--max-budget-usd`、SDK cost 同源；`modelCost.ts:337` 直接站点，用户可见成本数字） |
| 060 | P3-CAND-v | bundled dataviz skill 更新：light 第七序列浅紫、dark 主文本柔化、y 轴紧凑标签 1K（OCC dataviz 3 文件面需核是否实体/stub） |
| 061 | P1-PORT | MCP tool 前置描述默认 cap + server instructions cap **2048→4096**（`client.ts:293` 直接站点；与 295#112 已落 tool-search 16384 的层级关系需 ELF 取证） |
| 062 | P2-CAND | `←` 行为变更：移 bg 时已启动的 turn 或 `!` 命令被**停止**而非看不见地跑完（autoBackground 族行为变更；与 #033/#034 同轮处理） |
| 063 | N/A-VSCODE | `claudeCode.spinnerVerbs` 设置缺失/畸形值破坏 chat panel |
| 064 | N/A-VSCODE | Claude in Chrome 每会话询问 browser actions |
| 065 | N/A-VSCODE | Windows 全路径 chat 链接打不开文件 |
| 066 | N/A-VSCODE | reduced motion 下 working indicator 仍动画 |
| 067 | N/A-VSCODE | prompt cache clock 面板迟追赶后误读 warm |
| 068 | N/A-CLOUD | self-hosted Activity tab 状态筛选 |
| 069 | N/A-CLOUD | cloud session 队列位置各自独立显示 |
| 070 | N/A-CLOUD | 回复中发送的消息不再跳到回复上方 |
| 071 | N/A-SLACK | Claude Tag：thread 仅最新回复带 footer |
| 072 | N/A-SLACK | Claude Tag：含括号 URL 链接断裂 |
| 073 | N/A-SLACK | Claude Tag：六位 PR 号误画色块 |
| 074 | N/A-SLACK | Claude Tag：Memory tab 工作区/频道 memory 文件 CRUD |
| 075 | N/A-SLACK | Claude Tag：plugin 确认卡显示 ID 而非名称 |
| 076 | N/A-SLACK | Claude Tag：移除频道设置不含的 plugin 卡片 |
| 077 | N/A-SLACK | Claude Tag：runner 迁移中丢回复 |
| 078 | N/A-CODE-REVIEW | PR 上 Code Review check 停在 in progress |
| 079 | N/A-CODE-REVIEW | Code Review admin 设置保存失败原因说明 |

**统计**：P0=2（#031/#032），P1=13（#002/#006/#007/#008/#009/#014/#016/#019/#023/#030/#050/#059/#061），P2=22，P3=13，N/A=29（GATEWAY 4 / SLACK 7 / CLOUD 6 / VSCODE 5 / MODS 3 / RUNNER 2 / CODE-REVIEW 2）—— 2+13+22+13+29 = 79 ✓ 无静默丢弃。

## §4 STAGED 结转入口（occ153 账本为准，不在此重复罗列）

- **occ153 §8.2 STAGED P1×10** → 本轮经 §1.2 salvage 采纳收敛到 2（#090-295/#095-295 rewind 子系统，需 v295+v296 ELF 重取后合并取证）。
- **occ153 §8.3 STAGED P2×31 + P3×19** → 本轮按性价比取舍；其中与 296 新条目同族的可并案（如 #002-295 OSC 7501 与 296 无对应、hljs 族 #091-295 与 #052-296）。
- **occ153 §5 结转债务**：#018-295 WebFetch 100k reader+offset（取证 70%）、#148-295 `!` 原始控制字符拒绝、OCC-109 STAGED、OCC-111 验收 7 findings（验收员复核）、npm E404（OCC-151，外部阻塞）。

## §5 移植轮执行顺序（给 OCC 程序员）

1. **ELF 重取**（occ153 §6.1 纪律）：`npm pack @anthropic-ai/claude-code-linux-x64@2.1.296`，核对 md5 `3c8749470f70a26efadf982b587e1548`；如需 295 对照一并重取（md5 `4f067be625a3fc99f1c76a563d14cfdb`）。工具：`strings -n 8 | sort -u` + `comm`；字节站点 python `mmap.find`（grep -boF 对 256MB 无换行 blob 静默失败）→ `dd bs=1 skip=OFFSET count=N`。二进制不留 /tmp，run 结束销毁。
2. **salvage 采纳先行**（§1.2）：8 项已取证移植 + clear-cost-reset mock.module 修复；对位调和 main render 簇交互；全量测试绿后合入工作分支。**注意**：salvage 基于 295 ELF 取证，落地前用 296 ELF 抽查站点未被 296 再次改动（若 296 又改了同站点，以 296 为准重新取证）。
3. **P0 批（2 条）**：#031 BASH_ARGV0（AST+legacy 双路径，OCC-44/46 敏感链，live-path 补偿守卫先例参照）、#032 Edit/NotebookEdit 非 UTF-8 拒绝（与 occ153-F4 CRLF 修复对位）。安全审核员重点面。
4. **P1 批（13 条）按簇**：直接站点簇（#059 定价、#061 cap）→ hook/managed 簇（#007/#008/#019）→ 会话/恢复簇（#009/#014/#030）→ frontmatter/tool 面（#002/#006）→ workflow DoS（#023）→ redaction（#016）→ Windows bash 权限（#050，面核后定 PORT/N-A）。
5. **P2/P3 按取证成本取舍**；未消化项在本账本追加新 § 记 STAGED，不许静默丢弃。
6. **测试纪律**：每项 TDD + binary 证据注释；全量 git-stash A/B 零回归；build + headless `-p` + tmux REPL live smoke（真实模型 round-trip）。
7. **抗中断纪律（本轮新增，occ153 §9.0 教训 + 本 issue 首次程序员 run 被 server cancel 教训）**：小切片推进，**每切片落地即 commit 到工作分支并 push**，保证任何时点被 cancel 成果可 salvage；不要攒大包。
8. **发布**：合 main → version bump（2.1.379 起，若被并行轮抢占则顺延）→ CHANGELOG + README badge（Now tracking 2.1.296）→ **tag 门禁 = 验收员在 issue 上对当前 main HEAD 树给出 PASS（occ153 §10.3 纪律，抢跑即事故）** → tag 后 publish.yml npm 步**预期 RED**（OCC-151，非回归）→ Release 步因 `if: success()` 不跑 → 手动 `gh release create <tag> --generate-notes`（幂等）→ parity 核验 tags=releases → 回帖（/releases 总条目数 + Release 链接）。
9. **交接链**：程序员完成 → 评论 @OCC 安全审核员（重点 #031/#032 P0 + #016 redaction + #019 unchecked-prompt + #023 DoS）→ @OCC 验收员（对齐抽验 + 像人类用户一样 REPL/uvx 一致性 + 分支清理核验；salvage 载体分支采纳合入后可删）→ 验收 PASS 通知程序员发版 → Leader 汇总 + lark 汇报 + issue done。

## §6 调研工件与复现

- 官方 changelog 快照：本轮 workdir `cc-CHANGELOG-snapshot.md`（8,789 行，源 URL 见 §0）；run 结束销毁，复现直接 curl 同源。
- OCC 侧 grep：main @`6ff64c8`，命令与命中数全部记录在 §2，可逐条复现。
- 本调研未下载/执行任何官方二进制；ELF 数字均引自 occ153 §0/§4 已录基线（其原始取证 run 记录在案）。

## §7 移植轮实施日志（程序员，feature/occ154-296，滚动更新）

### §7.1 已落地切片（每切片 commit+push，抗中断）

- **salvage 采纳（§5.2）**：8× 295-STAGED-P1 全部落地（c4ec98d #017-295、609a19c #035-295、f745b4f #037-295、1bef78b #044-295、0e0fe2e #056/#067-295、753099f #091-295、3a2212a #072-295、01db9a2 mock 清理）。
- **P0 #031**（8e1fa81）：BASH_ARGV0 AST+legacy 双路径 + live-path 补偿守卫。
- **P0 #032**（a217491）：Edit/Write/NotebookEdit 非 UTF-8 拒绝（isLossyUtf8Decode/lossyDecode 管线，官方 aen/UTs 文案，errorCode 15）。
- **#059**（8e38726）：Sonnet 5.5 cache read $0.20→$0.10（tier_2_10_cache_read_0_10 @207704167 + remap @207711856）。
- **#061**（bf37986）：MCP 描述默认 cap 2048→4096（v296 @214045823 `sxn=4096,sns=16384`；getter `Ax` @217807549；tool-search 16384 不变；env override 两路径均优先）。39/39 目标测试 + mcp 目录全量 414/0。

### §7.2 hook/managed 簇裁定（#007/#008/#019）：**VERIFIED N/A（OCC 无生产者面），无代码改动**

ELF 逐站点取证结论（v295 md5 4f067be6…/v296 md5 3c874947…，python mmap.find，全部字节可复核）：

1. **v296 hook 区域唯一 delta = 新 "hook did not run" 子系统**：全部 updatedMCPToolOutput 消费站点（redaction builder、qV/YY 经典链、managed runner p9n/o7n、PostToolUse 生成器、输出解析器）与全部 12 个 managedHooksOnly 站点 v295→v296 **逐字节相同**（仅压缩名变化）。
2. 新子系统三个生产者，OCC 均无对应面：
   - `SOe(e,n,r)` @216154360 = `pluginHookRunner.refusal(pluginId,…)` —— OCC plugins 已裁（grep `pluginHookRunner|\.refusal` 0 命中）。
   - `notTested` ← `QTt` 异常 @214073652：**仅 cloud session 抛出**（`Ce()` 门内 "This hook's matcher cannot be tested in a cloud session"）—— OCC 无 cloud session；v295 `notTested`:0 → v296:6，收集函数 v295 `dan` @217842203 无 QTt catch，v296 `Fdn` @218604265 新增 `ke` 包装 + `_e` map + `Fe` 重排（仅 `_e.size>0` 时生效）。
   - `jY()` kill switch @216153456 读远程 gate `HXn`（payload 源）—— OCC 无远程 gate 基建（GrowthBook 空实现）。
   - `bOe` 结果构造器 @216154448 仅被上述两分支消费；v296 全二进制 `suppressOriginalPrompt` 代码站点 33→34，唯一新增即 bOe 自身，无新消费者。
3. **OCC 已承载可观测契约**（更早轮次已落）：2.1.288 #57 fail-closed 守卫（匹配错误传播，guarded 事件 fail-closed，hooks.ts:2985 区）、`buildScriptGuardDidNotRunResult`（官方 N5e/C0e，script 型休眠）、`onFailureBlock.ts`（官方 K_t/V_t，含 `suppressOriginalPrompt` + PermissionRequest deny）、`processUserInput.ts:196` blockingError→`shouldQuery:false`（未检查 prompt 不放行）。
4. **#019 mod `prompt.submit` 半区**：OCC 无 mods 面（grep 0 命中）→ N/A（与 §3 MODS 3 项同类）。
5. projectRoot "no longer a working copy" 分支 v295 已存在（非 v296 delta）；OCC 侧属 OCC-46 worktree-pin STAGED 结转，维持 staged。

**裁定：#007/#008/#019 三项在 OCC live surface 上无字节可移植内容，判定 VERIFIED N/A；语义等价保障已由 288#57/onFailureBlock 既有移植承载。非静默丢弃，证据如上。**

### §7.3 会话/恢复簇裁定（#009/#014/#030）：**VERIFIED N/A（三项均为 remote-transport 面或 OCC 已承载等价语义），无代码改动**

ELF 逐站点取证（v295/v296，python mmap.find + 区域 sig 归一化 realdiff，偏移量全部可复核）：

**#030（resume 打断轮重跑）— N/A，remote-transport 专属机械**
1. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 区域 v296 全部 delta 被 `n.isRemoteTransport()` 门控（OCC grep `isRemoteTransport|parkedPermission|resumeStalePromptCancel` = 0 文件）。
2. 本地恢复面（conversationRecovery 区，v295@231307502 ↔ v296@232059784）**逐字节相同（仅压缩名变化）**。
3. v296 新增全部为远端件：inherited-ask 领养机制（`inheritedAnswerOff` killswitch `tengu_ccr_inherited_approval_killswitch`、`offerInheritedAnswer` 0→3、深比较输入守卫 + `MI=180000` 新鲜度、`servedCallsNeverSent`（`gXo({forwarding,…})` 构造、遥测 `never_sent`）、`interruptedTurn` 描述符（仅作 `_w`/resumeStalePromptCancel 遥测消费）、`send_now==="stopped"` 队列冲洗。
4. OCC 本地 `detectTurnInterruption`（conversationRecovery.ts:418）结构性免疫：重跑需尾随未决 tool_use；已完成轮（工具结果在场）→ `{kind:'none'}`，不会重跑。

**#014（resumed subagent 被告知"用户拒绝"）— N/A，修复作用域 = `mcp__remote-devices__`，OCC 无该面且已承载等价语义**
1. v296 真实 delta 定位（deserializeMessages v295 `MNt`@~216137474 ↔ v296 `C$t`@~216886971，stamped-token 锚定 realdiff）：新函数 `zFt(e,n,r,s)`@216859784 区 —— 把持久化的 `interruptedByShutdown===true` 用户行（`uSe`@207899579：type user + 该 flag + 含 tool_result）当其全部 tool_result 属于未决 `qFt` 组时，剥掉 flag、内容改写为 `V`、置 `toolDenialKind:"interrupted"`，id 并入 `answeredToolUseIds`；调用点 `dt=Je?zFt(Ve,V,nt,[w,...S??[]]):Ve`，门 `Je=G&&!zre()`（G=RESUME_INTERRUPTED_TURN env；`zre()`@211049111=`CLAUDE_CODE_REMOTE_TOOLS_FORWARD===!0`）。
2. `qFt` 作用域：assistant 行全部 tool_use 名以 `$mo=Bo(da)` 前缀开头；`Bo(e)=\`mcp__${In(e)}__\``@208712902、`da="remote-devices"`@209540839 → 修复只作用于 **remote-devices MCP 调用**（远端 handoff 机械；`handedOff===!0` 行跳过）。后三个 `GFt` 站点（223984756/233621075/238471357）为跨 chunk 同名冲突（`assembleToolPool`），与本修复无关。
3. 内容常量 v295 已有（仅换名）：`Iu/Hu`="[Request interrupted by user for tool use]"、`oN/bP`="[Tool call interrupted: the session ended before this call's result was recorded…]"、`sN/gN`="[Tool call result not in this copy…]"；`V=!G?Hu:y?gN:bP` 选择逻辑两版相同。token 计数：`toolDenialKind:"interrupted"` 3→4（唯一新站点 @216860140 即 zFt 内）、`interruptedByShutdown` 28→29（新站点 @216860080 同区）。
4. OCC 侧三重免疫：(a) 无 `interruptedByShutdown` **写入者**（仅 messages.ts:3300/3337 读侧 scan-continue，2.1.285 #54 移植）→ `uSe` 输入集恒空；(b) 无 remote-devices server（grep 0）→ `qFt/GFt` 作用域恒空；(c) OCC `ensureToolResultPairing` 对尾随未决 tool_use 已填 `SESSION_ENDED_MESSAGE`（messages.ts:253，字节等同官方 `oN/bP`；resumePlaceholderFamily281 测试承载）—— 即官方修复后的行为，不存在"用户拒绝"误标路径。

**#009（headless 启动被关掉的 .mcp.json/plugin server）— N/A（logic-only 上游修复不可低成本定位；OCC 触发条件不存在）**
1. 全部相关 token 计数 v295→v296 相同：`disabledMcpServers` 6/6（站点区域逐一 realdiff：仅压缩名/chunk-import 变化）、`disabledMcpjsonServers` 32/32、`enabledMcpjsonServers` 27/27、`enableAllProjectMcpServers` 20/20、`strict-mcp-config` 24/24、`add_directory` 14/14、`reconnectMcp` 29/29、`refreshMcp` 27/27、`reloadPlugins` 10/10；无新增字符串字面量（added296/removed296 扫描：mcp 相关命中均为改名噪声对）。mcpconfig 窗口唯一实变 = `OHe→sDe`（`reopen_refetch`/`before_handler` 分类，属 #030 remote-tools 族，非本项）。模块布局在两版间大幅移位，索引配对区域 diff 不可靠 → 定位成本超收益，停止 ELF 挖掘（判断依据记录在案，非静默丢弃）。
2. OCC 侧行为审计（触发条件不存在 + 每次刷新即场咨询）：
   - headless 无 `add_directory`（grep 0 文件）→ "改目录后" 触发路径不存在；`setCwd` 仅 setup.ts 启动期（MCP 启动前）。
   - `reload_plugins` 控制请求（print.ts:3237）→ `applyPluginMcpDiff()`（print.ts:1963）**每次现调 `getAllMcpConfigs()` 新鲜解析**，不缓存启动期列表。
   - 采集点即场过滤（config.ts getClaudeCodeMcpConfigs）：项目 `.mcp.json` 仅 `getProjectMcpServerStatus(name)==='approved'` 进入（:1213，内部咨询 `disabledMcpjsonServers`，utils.ts:371）；手动 server 全量 `!isMcpServerDisabled(name)` + policy（:1235）；plugin server 拆分 disabled/policy-blocked（:1249）；连接点复查（client.ts:3122/3165）。
   - 结论：官方 bug 条件（reload/cd 后用陈旧列表启动被关 server）在 OCC 的双咨询 + 无 cd 面下不可复现。

**裁定：#009/#014/#030 三项 VERIFIED N/A。会话/恢复簇关闭，P1 余量：#002/#006（frontmatter/tool 面）→ #023（WorkflowTool DoS）→ #016（redaction）→ #050（Windows bash）。**

### §7.4 #002 子代理 `autoCompactWindow`（frontmatter/`--agents` 可设 + ceiling 解析）：**PORT DONE（8 文件 + 21 测试，A/B 零回归）**

**官方取证（v296 ELF，全部字节核实，偏移可复核）**：
- 界值 @207848454：`b0=1e5, TN=1e6`（[100000, 1000000]）。
- agent-def schema describe @208188475："Token count at which this agent compacts its own conversation when it runs as a subagent. It only lowers the window the subagent would otherwise inherit. No effect on the main session agent."
- `--agents` zod @217449940：`autoCompactWindow:E().int().min(b0).max(TN).optional()`（位于 maxTurns 与 skills 之间）。
- frontmatter 解析器 `ihr` @211911797：正整数 + 闭区间界，否则 undefined。
- 常规 markdown 警告 @217695969：`` `Agent file ${e} has invalid autoCompactWindow '${ut}'. Must be an integer from ${b0} to ${TN}.` `` `{level:"warn"}`；plugin 警告 @217649573 同文（前缀 "Plugin agent file"）。
- ceiling 谓词 `nIt`：`typeof e==="object"&&"ceiling"in e`；包装器 `WJn` @223498818：ceiling undefined 时恒等返回 inherited，否则 `{ceiling:s,inner:n}`。
- 解析器 `iv` ceiling 分支：先解析 inner；`inner.source==="env"` 或 `inner.window<=ceiling` → inner；否则 `{window:Math.min(ctx,ceiling),configured:ceiling,source:"settings"}`（env 豁免）。
- spawn 接线 @223555765：`e.agentType===Q$&&Xa(e)?n.options.autoCompactWindow:WJn(n.options.autoCompactWindow,e.autoCompactWindow)`（`Q$="fork"` @211657790；`Xa=isBuiltInAgent`，经 chunk export alias 块 @243898894 `Xa as isBuiltInAgent` 消歧 —— WJn 存在跨 chunk 同名冲突[markdown-link extractor]，已排除）。
- inProcessRunner 阈值 @242303606：teammate 自身 `agentDefinition.autoCompactWindow` 重包 ceiling（该站点无 fork 检查）。

**OCC 移植（9 改 1 新）**：
1. `src/utils/autoCompactWindow.ts` — `AutoCompactWindowCeiling` 类型 + `isAutoCompactWindowCeiling`（nIt）+ `wrapAutoCompactWindowCeiling`（WJn）+ `resolveAutoCompactWindow` 顶部 ceiling 分支（iv 顺序：branch 在 env 检查前，env 豁免经 `inner.source` 判定；嵌套 ceiling 更紧者胜）。
2. `src/utils/frontmatterParser.ts` — `parseAutoCompactWindowFromFrontmatter`（ihr：复用 parsePositiveIntFromFrontmatter + 闭区间界）。
3. `src/tools/AgentTool/loadAgentsDir.ts` — AgentJsonSchema 插入 `autoCompactWindow: z.number().int().min(...).max(...).optional()`（maxTurns/skills 之间）；BaseAgentDefinition 增 `autoCompactWindow?: number`（官方 describe 原文入注释）；markdown 解析 + 字节级同款警告；JSON 解析条件展开。
4. `src/utils/plugins/loadPluginAgents.ts` — 同款解析块 + "Plugin agent file" 警告（`{level:'warn'}`）。
5. `src/Tool.ts` — `options.autoCompactWindow?: AutoCompactWindowOverride`（官方按 query 逐层透传；OCC 以 session 单例回退，语义等价，注释已说明）。
6. `src/tools/AgentTool/forkSubagent.ts` — 官方内联 spawn 接线提取为可测纯函数 `computeSubagentAutoCompactWindow`（fork+isBuiltInAgent → inherited 原引用透传；否则 wrap ceiling）。
7. `src/tools/AgentTool/runAgent.ts` — agentOptions 接线：`computeSubagentAutoCompactWindow(agentDefinition, toolUseContext.options.autoCompactWindow ?? getSessionAutoCompactWindow())`。
8. `src/services/compact/autoCompact.ts` — `getEffectiveContextWindowSize`/`getAutoCompactThreshold`/`calculateTokenWarningState`/`shouldAutoCompact` 增 override 形参（默认 `getSessionAutoCompactWindow()`，主线程调用方零改动）；`autoCompactIfNeeded` 从 `toolUseContext.options.autoCompactWindow` 取 override 贯穿阈值/窗口/recompactionInfo。
9. `src/utils/swarm/inProcessRunner.ts` — teammate 阈值站点按官方 @242303606 重包 ceiling。
10. `src/tools/AgentTool/__tests__/autoCompactWindowSubagent296.test.ts`（新）— 21 测试全绿：ihr 边界/类型、WJn 恒等与形状、nIt、iv ceiling 分支（cap/passthrough/auto-cap/env 豁免/嵌套更紧胜）、markdown/JSON 两解析路径、fork 透传（同引用）与 wrap。

**验证**：新增 21/21 绿；邻接回归 AgentTool+autoCompactWindow 211、compact+swarm+plugins 627、frontmatter 61、tokens walkback 7 全过；biome clean；tsc 触达文件零新错；`bun run build` 绿（dist/cli.js 30.05 MB）。**git-stash A/B（src/utils 全 chunk）**：dirty 16 fail ↔ clean 16 fail，归一化后 fail 集逐名相同（DiskTaskOutput×5、InstructionsLoaded×2、getBedrockModelStrings×4[环境超时]、large-memory-files×4、stripInvisibleText×1 —— 全部既有/环境性）→ **零回归**。

**裁定：#002 PORT DONE。P1 余量：#006（Read allow_large）→ #023（WorkflowTool DoS）→ #016（redaction）→ #050（Windows bash）。**
