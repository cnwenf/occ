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
| 002 | P1-PORT | subagent frontmatter + `--agents` 定义支持 `autoCompactWindow`（会话级基建已在，frontmatter 侧 0 命中）（已移植，§7.4；**已对齐（OCC-113 轨，b1eb311）→ R2 裁定 SWITCH 回 occ154 实现**：官方 spawn-site @223555765 ceiling/fork/传播语义 main 缺失，§9.1，reconcile 823d16a） |
| 003 | P2-PORT | `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`：workflow agent 统一模型（workflow 引擎 LIVE，token 0 命中）（已移植：QTe getter + YU inWorkflowRun 臂 + Bt 链 + 双臂 kt 抑制 + obr 令牌，§7.10；**已对齐（OCC-113 轨，f3ed083）→ R2 裁定 SWITCH 回 occ154 实现**：main ALS 版 4/4 行为探针失败（inherit 哨兵/FORCE 策略守卫缺失），§9.2，reconcile cbe52a8）|
| 004 | P2-PORT | `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`：529 退避上限（`withRetry.ts` 族，token 0 命中）（已移植：cap 覆盖 + too-long 阈值加宽 + w1 单点双 env 门控，§7.9；**已对齐（OCC-113 轨，f3ed083）→ R2 裁定 SWITCH 回 occ154 实现**：官方 H.int 描述子 @207579354 存在（ELF mmap 复核），main 无界解析器收 31999/64001，§9.3，reconcile ebb59da）|
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
| 016 | P1-PORT | **安全**：shared transcripts/debug logs 秘密 redaction 漏掉 key-no-value 后随值（含 shell 串内 JSON）（106 文件 redact 面；已整模块移植 v296，§7.7；**已对齐（OCC-113 轨，c1634c5）→ R2 裁定 KEEP MAIN**：213 例差分语料的 24 例提交探针对 main 两阶段 assignScanner 引擎全过（126/0），语料以 occ154- 前缀吸收，§9.4，reconcile 8011946） |
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
| 031 | **P0-PORT** | **安全（权限绕过）**：Bash 权限检查对"赋值 `BASH_ARGV0` 再使用"的命令自动放行 → 现应询问（OCC bash 权限链 = OCC-44/46 敏感链，AST+legacy 双路径都要核；已移植；**已对齐（OCC-113 轨，c1634c5）→ R2 裁定 KEEP MAIN**：occ154 rebound 语料 12/12 对 main 守卫全过，以 occ154- 前缀吸收，§9.5，reconcile 8011946） |
| 032 | **P0-PORT** | **数据完整性**：Edit/NotebookEdit 对非有效 UTF-8 文件（Windows-1252/Shift-JIS/GBK）替换所有非 ASCII 字符 → 现应拒绝编辑（FileEditTool UTF-8 校验 0 命中；与 occ153-F4 CRLF-cache 修复同文件族；已移植 §7 切片；**已对齐（OCC-113 轨，c1634c5）→ R2 裁定 SWITCH 回 occ154 实现**：官方 aen 拒绝 errorCode=15（@10206075/@47166593），main 用 14 与官方文档校验族码位冲突；官方消费面为 nwe lossyDecode @10207433，main 无 fileRead lossyDecode 面，§9.6，reconcile ab6027b/b3097cf） |
| 033 | P2-CAND | `←` 后立刻发送的 prompt 在 bg service 慢时被跑两次（一次前台不可见）（autoBackground 面；与 occ153-F3 kill-race 修复同族） |
| 034 | P2-CAND | SessionStart hooks 仍在跑时发送的 prompt 随 `←` 移 bg 而消失 → 仍不发送但 `↑` 可取回 |
| 035 | P2-CAND-v | headless 会话中迟加载 plugin 的 SessionStart hook 输出在 `/clear` 后到达新对话 |
| 036 | P2-CAND-v | PowerShell 命令看不到 hooks 写入 `CLAUDE_ENV_FILE` 的变量（纯赋值时）（295#071 Bash 侧已落，PowerShell 面需核） |
| 037 | N/A-CLOUD | cloud sessions 被称 non-interactive 并建议 `/mcp` |
| 038 | P3-CAND-v | `/code-review` 在 cloud/SDK/IDE 以 raw JSON array 结束 → 编号列表（cloud/IDE 分发面 N/A 成分；OCC 自有 /code-review 面需核） |
| 039 | P2-CAND-v | auto mode 偶发拒绝更新自己的 artifact（误判 sharing 变化）（auto mode LIVE + Artifact 11 文件） |
| 040 | N/A-TRIMMED | claude.ai 同步 skills 多会话共享 config 目录时永不完成安装、每次重下（claude.ai-sync 子系统 OCC 不存在，§8 结构性证据） |
| 041 | N/A-TRIMMED | claude.ai 同步 plugin 因其 marketplace 依赖也是同步来源而被禁用（同 #040，§8） |
| 042 | P2-CAND | macOS 启动挂起：Linux 机器拷来的 plugin 路径指向 /home 下（启动挂起修复，跨平台价值） |
| 043 | P2-PORT | Workflow tool 拒绝 CRLF 行尾脚本文件（Windows checkout 场景；workflow LIVE）（**已对齐（OCC-113 轨，f3ed083）→ R2 裁定 KEEP MAIN**：main parse-site 归一化（scriptLoader I3n）覆盖全部执行消费面（含 inline）= 官方 intake-site 位置的超集；occ154 失败探针断言的是位置而非契约；main workflowScriptCrlf296 已在契约级钉住（5 测试），§9.7） |
| 044 | P3-CAND-v | OTEL `tool_result` 事件在 `git commit -q` / `git -C <dir> commit` 后缺 `git_commit_id`（1 文件面） |
| 045 | N/A-TRIMMED | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` 丢弃文本含 U+2028/U+2029 的消息（transcript-local-GC 子系统 OCC 未移植，token 仅存在于 scrubber 名单，§8） |
| 046 | P2-CAND | `claude purge` 对含 U+2028/U+2029 的 prompt 留在 history 文件（与 #045 同字符族，purge 6 文件面） |
| 047 | P3-CAND-v | Windows：PowerShell >1KB 命令恒询问 → allow 规则/只读检测适用到 32KB |
| 048 | P2-CAND-v | Windows：stdio MCP server 关机被强杀 → 先关 stdin，300ms 后仍活才杀进程树（graceful-shutdown 逻辑跨平台通用，Windows tag 需核 OCC 对应面） |
| 049 | P3-CAND-v | Windows：无 GitHub SSH key 机器上 `plugin install` GitHub `owner/repo` 源失败 → HTTPS 重试 |
| 050 | P1-PORT | **安全（Windows）**：bypass permissions 模式下 Git Bash `rm -rf /c/Users/<name>` 不询问（已移植 v296 zwr/qpt 翻译层 + dangerousRemoval circuitBreaker bypass 免疫，§7.8） |
| 051 | P3-CAND-v | fullscreen 模式鼠标指针下链接加下划线 |
| 052 | P2-CAND | ctrl+o transcript toggle 在代码重对话中卡顿 → 缓存语法高亮块（与 salvage #091-295 hljsGrammarPatches/hljsLimit 交互，合并处理） |
| 053 | N/A-GATEWAY | Desktop Code tab gateway 会话不能启动的原因回显 |
| 054 | N/A-CLOUD | cloud session 被拒错误说明 org policy 加载失败原因 |
| 055 | P2-CAND | `--debug` 输出点名 custom agent 文件未识别 frontmatter 字段 + typo 提示（295 B1 schema/校验族延伸） |
| 056 | P3-CAND-v | auto mode 检查无可用答案时 tool call 显示 dim "Not run" 行而非红色错误 |
| 057 | P3-CAND | `--debug` hooks 日志：command hooks 完成时记录 command/plugin/outcome/duration（慢 hook 可定位） |
| 058 | N/A-TRIMMED | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`：重写大 transcript 文件仅当能省 ≥10%（与 #045 同族，GC 子系统不存在，§8） |
| 059 | P1-PORT | Sonnet 5.5 cache read 定价 $0.20→**$0.10**/MTok（`/cost`、status line、`--max-budget-usd`、SDK cost 同源；`modelCost.ts:337` 直接站点；已移植；**已对齐（OCC-113 轨，f3ed083）→ R2 裁定 KEEP MAIN**：occ154 modelCost 语料 8/8 全过（双轨收敛同一价目表），以 occ154- 前缀吸收，§9.8，reconcile 8011946） |
| 060 | P3-CAND-v | bundled dataviz skill 更新：light 第七序列浅紫、dark 主文本柔化、y 轴紧凑标签 1K（OCC dataviz 3 文件面需核是否实体/stub） |
| 061 | P1-PORT | MCP tool 前置描述默认 cap + server instructions cap **2048→4096**（`client.ts:293` 直接站点；与 295#112 已落 tool-search 16384 的层级关系需 ELF 取证；已移植；**已对齐（OCC-113 轨，f3ed083）→ R2 裁定 KEEP MAIN**：main 81/81（同文件同 cap，双轨收敛），§9.9） |
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

**统计**：P0=2（#031/#032），P1=13（#002/#006/#007/#008/#009/#014/#016/#019/#023/#030/#050/#059/#061），P2=22，P3=13，N/A=29（GATEWAY 4 / SLACK 7 / CLOUD 6 / VSCODE 5 / MODS 3 / RUNNER 2 / CODE-REVIEW 2）—— 2+13+22+13+29 = 79 ✓ 无静默丢弃。**§8 终裁后复核**：P0 2 done；P1 13 = 7 PORT done + 6 VERIFIED N/A（§7.2/§7.3）；P2 22 = 3 done（#003/#004/#043）+ 1 N/A-TRIMMED（#045）+ 18 STAGED；P3 13 = 3 N/A-TRIMMED（#040/#041/#058）+ 10 STAGED；原 N/A 29 —— 2+13+22+13+29 = 79 ✓，STAGED 合计 28，no-silent-drop。

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
- **hook 簇 #007/#008/#019**（4ecde7e）：VERIFIED N/A 裁定文档（§7.2）。
- **会话/恢复簇 #009/#014/#030**（8606441）：VERIFIED N/A 裁定文档（§7.3）。
- **#002**（afdb70d）：子代理 autoCompactWindow ceiling 全链（§7.4）。
- **#006 Slice A**（a4ece59）：per-turn contextRoom 基建（§7.5）。
- **#006 Slice B**（6751150）：Read `allow_large` 全量移植（§7.5）。
- **#023 + #043**（5d6e847）：Workflow pretty-print blowup gate（Hps 估计器 + z=8 门）+ CRLF 脚本归一（§7.6）。
- **#016**（ac012d5）：secretRedaction 模块 v296 整模块逐字移植（§7.7）。

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

### §7.5 #006 Read `allow_large`（超限文本读取按当轮剩余上下文放行 + token-cap 分页重写）：**PORT DONE（Slice A a4ece59 + Slice B 6751150，51+35 新测试，A/B 零回归）**

**官方取证（v296 ELF，md5 3c8749470f70a26efadf982b587e1548，python mmap.find + dd，全部字节核实、偏移可复核）**：
- 常量 @209662501：`rt="Read"`、`hue="allow_large"`；系数 @219148327：`sOr=0.7`（room 份额）、`iOr=2`（raised 模式 bytes-per-token 下限除数）、`aOr=3`（raised 字节 cap 乘数）；`Ugo=25000`/`jgo=128` @210495482。
- 三条消息 @210495482-210496323：`Aws`（可放行提示）/`Bgo`（放行也装不下）/`Cws`（无 room 环境）—— 全部逐字节复刻。
- schema 字段 @219133376：`[hue]:$w(M().optional()).describe("Set to true to read a text file, …")`，位于 `pages` 之后；`$w` ≡ OCC `semanticBoolean`（optional 在内层）。
- 入口 `nOr` @219145200：`Fe=()=>lOr(y,S,{maxSizeBytes:Re,maxTokens:Pe})`（懒闭包，每次现算）、`He=h?Fe():void 0`（opt-in 快照一次）；`Ft` 对象 @219147380 把 `room:Fe,allowLarge:He` 带进主路径 + ENOENT alt 路径两个 Shn 调用点。
- room 计算 `lOr` @219148327：usage（O5≡normalizeUsage → VRt≡sumInputTokens + output）与 held() 取大 + claimed() → `H=max(0,floor((threshold-w)*0.7))`；`H<=base.maxTokens` 不 raise；否则 `raised={maxTokens:H,maxSizeBytes:max(base,H*bytesPerToken*3)}`（Xd≡bytesPerTokenForModel）。
- 遥测 `Chn` @219148814：`tengu_file_read_allow_large` {outcome,lifted,…roomTokens 条件展开,…extra,…ext 条件展开}；outcome 经 `d`=fromEnum=**恒等**（chunk-wkmq9ht0.js @207051783 核实）→ 原始串 "unavailable"/"too_large"/"fit"/"paged"。
- 消息选择器 `Ave` @219148986、错误变换器 `_hn` @219149198（r0e 需 `maxSizeBytes===readMaxSizeBytes` 匹配才变换；opted-in 才发遥测）、token 计数 `khn` @219149776（raised 模式估计值取 `max(rough, ceil(bytes/2))` 下限；≤cap/4 早退不打 API；非整读且 `length>cap*128` 先抛）、错误类第三 ctor 参 suffix（r0e/LVe/$de @214287400 区）。
- 文本路径 `dOr` @219156400-219161350 全量：raised caps 传入 readFileInRange（无 limit → maxBytes=raised；有 limit → `maxSelectedBytes=max(G*128, raised?.maxSizeBytes??0)`）+ `.catch(_hn)`；`an=(offset??1)<=1&&limit===void 0&&pages===void 0` 整读判定；raised 时对**加行号后的内容**计数（Q5e≡addLineNumbers，startLine=max(1,offset)）；计数成功后对**新鲜 room**（`V().raised?.maxTokens??G`）复查再 `claim(Sn)`；catch 分支 $de+整读 → PARTIAL view（`Eo=max(1,min(lines,floor(lines*G/tokenCount*0.85)))` + ≤6 轮 ×0.7 收缩；char 模式 `fo=max(1,floor(G*Hn*0.85))` + 代理对切割保护；`Cn` 通知两变体逐字节）；readFileState 存**裸内容**（v296 起不再前缀通知）且 paged 时 `limit=qt`；data.file `startLine:paged?max(1,offset):offset`；`tengu_session_file_read` paged 时 `readBytes=byteLength(Vt)`；尾部 `if(Y)Chn(Y,fit/paged,…)`。

**OCC 移植**：
- **Slice A（a4ece59）**：`src/utils/contextRoom.ts`（新，createContextRoom ≡ 官方 ra @224116753 + IHe/Oms/syr/CAs）、tokenEstimation.ts（bytesPerTokenForModel ≡ kh/rF legacy 集 + OCC canonical 别名）、tokens.ts（UsageShape/isZeroTokenUsage 导出）、messages.ts（CUTOFF_RESUME_* 导出）、Tool.ts（`contextRoom?: () => ContextRoom | undefined`）、query.ts（per-turn 接线 @224224750）。35 新测试。
- **Slice B（6751150，5 文件）**：
  1. `src/tools/FileReadTool/allowLarge.ts`（新）— 官方系数/消息/类型 + `computeAllowLargeRoom`（lOr）+ `selectAllowLargeMessage`（Ave）+ `logAllowLargeEvent`（Chn）+ `buildTokenCapPartialView`（dOr catch 分支，含 capLabel `allow_large had room for N tokens this turn`/`cap G` 二态与 countNewlines）。
  2. `src/tools/FileReadTool/FileReadTool.ts` — schema `allow_large`（semanticBoolean + 官方 describe 逐字节）；`MaxFileReadTokenExceededError` 第三 ctor 参 suffix；新导出 `transformReadError`（_hn）+ `countReadTokensForRead`（khn）；call() 入口 room 闭包 + opt-in 快照贯穿两个 callInner 站点；callInner 尾部两参 `room/allowLarge`；文本路径整体重写为官方 dOr（旧 2.1.145 世代 `buildPartialViewIfNeeded` 删除）；outputSchema text 增 `truncatedByTokenCap?`。
  3. `src/utils/readFileInRange.ts` — FileTooLargeError/SelectedRangeTooLargeError 增官方第三 ctor 参 suffix（r0e/LVe）。
  4. `src/utils/tokens.ts` — 导出 normalizeUsage/sumInputTokens/NormalizedUsage（O5/VRt）。
  5. `src/tools/FileReadTool/__tests__/allowLarge296.test.ts`（新）— 51 测试：常量/三消息逐字节、Ave 7 例矩阵、lOr room 数学（IEEE 精确：`floor(1350*0.7)=944`、`floor(700*0.7)=489` —— 与官方同一浮点运算）、_hn 6 例（含遥测元数据精确断言与不匹配恒等）、khn 8 例、dOr catch 7 例（行模式 8 行/319 字符 + 通知全文、raised capLabel、char 模式、代理对、不均行回退）、错误类 suffix 4 例、schema 3 例（键序 file_path/offset/limit/pages/allow_large）、集成 4 场景（未 opt-in 分页、allow_large fit+claim+双事件、unavailable、未 opt-in 发现提示无遥测）。

**文档化分歧（全部有官方字节依据，非猜测）**：`lOr` 的 `remoteCall`/`inputFromAnotherMachine` 早退守卫 OCC 无对应面省略；`d`=fromEnum=恒等（遥测 outcome 原始串）；PARTIAL 通知官方走独立 `read_truncation_notice` attachment，OCC 保留既有 prepend 通道（partialViewNotices WeakMap → mapper，`<system-reminder>` 包装）；`countTokensWithAPI` 官方带 credentials 参、OCC 只收内容；`addLineNumbers` 无 tabAwareSeparator 参；`tengu_session_file_read` 官方无 `is_session_memory`/`truncatedByTokenCap` 键，OCC 保留；官方 `nestedMemoryAttachmentTriggers` 为数组（includes/push），OCC 为 Set（add）语义等价；`bytesPerTokenForModel` 官方返回 `{bytesPerToken}` 对象、OCC 返回数值。**范围外（STAGED，不静默丢弃）**：官方 dOr 的 `Qwt` task-file 装饰、`artifactRead`/`afterResultCommitted`/`pendingHandoverReads` 钩子 —— OCC 无 task-registry/artifact 面，无字节可移植对象。

**验证**：新增 51/51 绿；FileReadTool 目录 109/0；兄弟簇（FileEdit/FileWrite/NotebookEdit/tools/__tests__ + readFileInRangeStream276/attachmentsStash291/symlinkStash251）192/0（clean 臂 141/0，差值恰为 51 新测试）；contextRoom296 35/0、tokensWalkback288 7/0；**git-stash A/B 双臂**：tools 臂 dirty/clean fail 集均空；utils 臂 4887 pass/16 fail 两臂逐名相同（全部既有/环境性）→ **零回归**；biome clean（5 触达文件）；`bun run build` 绿（dist/cli.js 30.06 MB）。

**裁定：#006 PORT DONE。P1 余量：#023（WorkflowTool DoS）→ #016（redaction）→ #050（Windows bash）。**

### §7.6 #023 Workflow 深嵌套结果（截断半 + 巨型输出半）与附带 #043（CRLF 脚本）：**巨型输出半 PORT DONE + 截断半 N/A-by-architecture + #043 PORT DONE（A/B 零回归）**

**官方取证（v296 ELF，md5 3c8749470f70a26efadf982b587e1548；全部 python3 mmap.find 字节定位，未执行官方二进制）**：changelog 第 23 条 = "Fixed workflow scripts silently truncating results, agent options and other values nested deeper than about 20,000 levels, and deeply nested results writing huge task output files"。修复分两半：

1. **截断半**：v295 的递归 VM 边界 walker（`ewr` sandbox sanitize、`O$n` host primitivizeDeep —— ~20k 层栈溢出，逐槽 catch `if(isCap(e))throw e; out[i]=undefined` 把 RangeError 静默洗成 undefined）被 v296 换成共享**迭代**生成器 `ws({arrayLengthCap,isListSeenFirst})`：深度上限 `m7t=1e5`（`capErr('nesting deeper than 100000 levels is not supported across the VM boundary')`）、数组上限 `fR=4096`（常量 @207368237）、`lost(e)`/`isStackEnd(e)` 把 `Maximum call stack size exceeded.` 洗成 `capErr('the stack ran out while copying a value across the VM boundary')`、显式帧栈 `for(;;)`、`__proto__` 跳过、`_defineProperty` 写入；消费者 `jSr`（sandbox {sanitize,snapshot,getProp}）、`ks`（host primitivizeDeep，runInThisContext filename:"primitivizeDeep"）、`USr`（host snapshot）、`Fx`（host checkedLength）。
2. **巨型输出半**：新增 `Hps` pretty 尺寸估计器 + 门。v295 `Hjr` 无条件 `_(…,null,2)`；v296 `ajr` @225609040：`c=_(d);Alo(i.outputFile,Hps(c,2,c.length*z)?_(d,null,2):c).catch(...)`，块常量 `var D=500,z=8` @225605959（`D` 此路径未消费）。`Hps(e,i,n)` + 私有串跳过器 `R(e,i)` 逐字 @215076527（chunk-bcy16nn4.js 导出 `{w_e,mDn,Hps,Dps,wst,Lps}`；`Dps=64`、`wst`/`Lps` 均未被 workflow 区域消费 → 不移植）。估计器对小对象**精确**（手算 `{"a":1}` → 12 = 真实 pretty 长度）。Bun 实证：20k 层嵌套 compact 120,002 字符 vs indent-2 **800,180,002 字符（800MB）**；100k 层 JSON.stringify 双模式 RangeError —— 与 changelog "~20,000 levels" 两半均吻合。
3. **官方 journal key 计算 295→296 未变**（仅名字漂移）：`Br="v2"`；`Hr(e)` = 7 字段白名单 + 递归归一化 `p` + `_(p(r))`；`No(e,r,s)` = `"v2:"+sha256(s\x00e\x00Hr(r))`（v295 @227951265，v296 @228287611）。官方安全串化 `_`（chunk-bd805sh6/sz42tpc6）为**纯字节码不可逐字恢复**——由调用点证据推得契约（可返回 undefined：`bgn` 的 `t===void 0` 检查；透传 JSON.stringify 参数：`_(d,null,2)`），**不复制**（Never invent）。

**OCC 映射裁定**：OCC 无 `vmHardening.ts`、WorkflowEngine.ts **无边界拷贝 walker**（node:vm 共享堆、按引用传递）→ v295 截断 bug **结构性不存在**；OCC 的递归路径（journal.ts `stable()`、`JSON.stringify(entry)`）**响亮失败**（RangeError 直接传播），且官方对应物（`Hr` 归一化）同样递归、295→296 未变 → 平价。OCC 唯一 pretty-print 站点 = `WorkflowTool.ts` mapToolResultToToolResultBlockParam（旧 `JSON.stringify(result,null,2)`）；OCC 无 workflow outputFile writer。→ **截断半 N/A-by-architecture；巨型输出半 PORT**。

**落地（1 commit，4 文件 +395/-5）**：
1. `src/tools/WorkflowTool/prettyFits.ts`（新）— `Hps`/`R` 逐字改名移植（`prettyPrintFits`/`skipJsonString`，循环结构、charCodeAt 比较、`--r`/`++r` 前缀序全保留）+ `PRETTY_BLOWUP_MULTIPLIER=8`（官方 z）+ `PRETTY_INDENT=2` + `stringifyResultGated`（ajr 门形状）。
2. `src/tools/WorkflowTool/WorkflowTool.ts` — mapper 非字符串 result 改走 `stringifyResultGated(result)`（官方 ajr 门：compact 一次，估计 pretty 超 8× compact 则不展开）。
3. `src/tools/WorkflowTool/scriptLoader.ts` — **#043（changelog 第 43 条，账本 row 85 P2-CAND 一并关闭）**：官方 `jce` @212275184（`e.replaceAll("\r\n","\n")`，v296 新增，v295 Efs 无）落在**两个文件读取站点**（loadScriptGated buffer 解码、loadScript readFileSync）；`loadScriptFromSource`（inline script）不动 —— 官方对 inline 参数同样不归一。
4. `src/tools/WorkflowTool/__tests__/workflowDepth296.test.ts`（新）— 13 测试：估计器精确性（手算 `{"a":1}`→12、空容器跳过、串内 `[,:{}]`/转义引号跳过、20k 深早退 false、浅载荷 true）、常量（z=8/indent=2）、mapper 门（浅→pretty、字符串透传、20k 深→compact 且文本 <4× compact、undefined result 保持旧 "undefined" 文本）、CRLF（loadScriptGated/loadScript 归一 + LF 文件不变）。

**文档化微分歧（有官方字节依据）**：官方 `ajr` 对 `c`（stringify 结果）无 undefined 守卫（undefined 会崩在 `c.length`），但官方载荷 `d` 恒为对象字面量不会 undefined；OCC 的 mapper 载荷是裸 `result`（可能 undefined/function/symbol），`stringifyResultGated` 在 `JSON.stringify(value)===undefined` 时返回 `"undefined"` 字符串 = 保持 OCC 既有模板字面量输出，既不崩溃也不发明官方没有的行为。**范围外（STAGED，不静默丢弃）**：`ws()` 迭代 walker 全家（jSr/ks/USr/Fx/capErr/m7t/fR）—— OCC 无 VM 边界拷贝面，无字节可移植对象；`_` 安全串化 —— 纯字节码不可恢复；`Dps/wst/Lps/w_e/mDn` —— 未被 workflow 区域消费；100k+ 层 RangeError 传播行为与官方残留边界一致（官方在 RangeError 深度同样经 `_.catch`/崩溃路径），不另加守卫。

**验证**：新增 13/13 绿；WorkflowTool 目录 63/0（6 文件）；**git-stash A/B 双臂**（WorkflowTool/BashTool/FileReadTool/FileEditTool/AgentTool/utils/effort/query/screens 分块）：dirty/clean fail 集均空 → **零回归**；biome clean（4 触达文件）；`bun run build` 绿（dist/cli.js 30.06 MB）。

**裁定：#023 巨型输出半 PORT DONE、截断半 N/A-by-architecture；#043 PORT DONE。P1 余量：#016（redaction）→ #050（Windows bash）。**

### §7.7 #016 secretRedaction 模块（changelog 第 16 条）：**PORT DONE（v286→v296 整模块逐字移植，24 新测试 + 213 例差分语料 ground truth，A/B 零回归）**

**官方取证（v296 ELF，md5 3c8749470f70a26efadf982b587e1548；python3 mmap.find 字节定位 + dd 提取，未执行官方二进制；提取出的官方 JS 文本在 bun 下运行属允许面）**：changelog 第 16 条 = "Fixed secret redaction in shared transcripts and debug logs missing some values that follow a key with no value, including in JSON written inside a shell string"。redaction 模块 @207282419（64KB dump `r16-mod-full296.js`），区域划分（模块内偏移）：invisibleChars+未移植 sanitize 簇 reg1 s[375:4591]；scanner s[4591:13293]；rules s[13293:21754]；pem s[21754:22687]（尾 94B 为 rt/Je/sn）；engine s[22687:29664]；Xe/Hs/Bs @38108-38610。v296 修复坐落在 v295 代际的**规则元数据层**上：每规则 `redactOnly/prefilter/run/displayRun` + `Xe` 测试器 + `QRr` 追踪切片缓存（Ye/as/us + ds/fs=512）；entry-16 两半 = ① key-no-value 后随值 → engine `zCo` 回退链（`ps(s)` → `_9(s)` → `redactOnlyRules` → `ps(n)`），② shell 串内转义 JSON → rules 新规则 `sensitive-assign-escaped`（redactOnly+prefilter:fn）+ `ls/on` 的 plain/escaped 双通道 assign 扫描。

**Ground truth 差分语料（机器生成，`scratch/corpus-results.json`）**：官方模块文本重组为可加载 `bundle296.ts`（bun 下 export p2n/ps/_9/WCo/f2n/QRr/CPe/b9/zCo/Aon 全通），29 输入 × 7 API + 8 定向 = **213 例对比：186 SAME / 27 DIFF，27 例全部为 v296 多redact**（shell-escaped JSON、key-no-value zCo 链、传播面），与 entry-16 家族一一对应；由 DIFF 行机器生成 RED 测试 `secretRedaction296.test.ts`（24 测试 = 15 entry-16 行为 + 9 回归护栏；v286 代码上 RED 确认 15 fail / 9 pass）。注：语料 harness 对返回值统一 JSON.stringify 存档，`redactJsonValue` 对象入参用例的断言以 `JSON.stringify(actual)` 对 GT 串比较（官方 b9 与 v286 M4 对对象入参**同样**返回 null-prototype 对象克隆，行为无分歧）。

**整模块移植裁定（v286→v296，保持 OCC 文件拆分 + index.ts barrel 公共 API 不变；消费者仅 3 文件且全部 barrel-only：Feedback.tsx / FeedbackSurvey/submitTranscriptShare.ts / commands/feedback/index.ts → 内部标识符翻面安全）**：

1. **rules.ts 重写**（s[13293:21754] 逐字，64 规则）：v296 名 st/qe/et/te/fn/gn/ns/ts/pn/Qr/hn + 新规则；**外科剔除**（零消费者取证，M6r/m4o 先例）：`BCo=new RegExp(le)`（0 refs）、`oMs`（0 refs，正则感知 top-level comma walker 定位）、`,rs=64`（PEM 行预算，OCC 留在 pem.ts 的 Ln）；`Bs` 缩写映射从 @38108 迁回 rules（v286 ir 对位）。import 别名回 v296 名（TPe/k8e/gBe ← invisibleChars 三名）。
2. **urlScanner.ts 重写**（s[4591:13293] 逐字）：v296 全新 span 扫描器（qt 家族游标走查 + je），替换 v286 userinfo-only dt；**排除** nU/APe/Dse/Gt/IDt/zt/rMs（逐个验证仅被官方未移植相邻代码消费，保留定义零引用）；自包含（零外部引用验证）。export { qt, je }。
3. **engine.ts 重写**（rt/Je/sn + s[22687:29664] + Xe/Hs 逐字，官方模块内顺序）：**排除** `var oo/ao`（官方自身死代码，0 refs——且为 engine 唯一 `ot` 消费者，故不 import ot）、`tT="[redacted URL]"`@29664（属未移植 an..ke 簇）；import 五模块全部别名回 v296 名（textSlicing Su→Ca/re→ne、trackedDoc ot→Wt/at→Kt/ie→Ee/Te→Ve、urlScanner、rules 12 名、pem Dn→ss/H6r→jCo/Et→mn）。
4. **jsonlRedact.ts 最小编辑**：主体与 v296 **逐字节等价已证**（64 hunk 全为压缩器局部单字符改名，长度 1789=1789）→ 仅改 import 行 `import { ps as Rs, zCo as D6r, Aon as OGt }`。
5. **pem.ts / trackedDoc.ts / textSlicing.ts / invisibleChars.ts 不变**：identity 证明（pem 唯一 hunk = rs↔Ln 放置；trackedDoc 加 d→f 局部改名后全等；invisibleChars TPe/Mt 字节相等、k8e/eMs/gBe 结构相同）。
6. **index.ts** 重映射 v296 名（公共名 redactSecrets/scanSecrets/... 13 个全部不变）。

**验证**：`secretRedaction296.test.ts` RED(15F/9P)→**GREEN 24/24**；`secretRedaction286.test.ts` 24/24（53 expect，零断言改动）；**scoped chunked git-stash A/B**（src/utils+components+commands 427 文件 9 批，消费者面全覆盖）：双臂各 5393 pass / 12 fail（既有基线，hooks-rewake/large-memory/invisible-strip 遥测三簇，与 redaction 无关），fail 集逐行相同 → **零回归**；biome clean（engine 补 noEmptyCharacterClassInRegex+noCommaOperator ignore-all，与 v286 同款）；`bun run build` 绿（dist/cli.js 30.07 MB）；`bun dist/cli.js --version` → OCC 2.1.378。

**范围外（STAGED，不静默丢弃）**：reg1 内未移植 sanitize 簇（Ut/ze/yr/br/Er/Sr/LO/xr/kr/be/wr + ypt 簇）—— v286 起即未移植（OCC 无消费面），v296 逐字节延续；an..ke URL 簇 + transcript classifier（engine 与 Xe/Hs 之间）—— 相邻模块消费，OCC 无对应面；`redactUrl.ts` 独立文件不在 v296 delta 内，未触。

**裁定：#016 PORT DONE。P1 余量：#050（Windows bash，面核后定 PORT/N-A）。**

### §7.8 #050 Git-Bash 危险 rm 翻译 + bypass 免疫（changelog 第 50 条）：**PORT DONE（Option-B：zwr/qpt 逐字翻译层 + dangerousRemoval circuitBreaker 全链免疫，26 新测试，A/B 零回归）**

**官方取证（v296 ELF，md5 3c8749470f70a26efadf982b587e1548；python3 mmap.find 字节定位 + dd 提取，未执行官方二进制）**：changelog 第 50 条 = "Windows: Fixed `rm -rf /c/Users/<name>` in Git Bash not asking in bypass permissions mode."。修复块 @218709361（`scratch/050-fix-block296.txt` 逐字存档）：`zwr=/^[\\/](?:cygdrive[\\/])?([A-Za-z])(?=[\\/]|$)/i`（Git-Bash/Cygwin 盘符路径正则）+ `Xun(e,n)`（先查原形、再查翻译形的双通道谓词包装）+ `qwr(e)`（windows 门控翻译器：先 `qpt` UNC 规范化，命中则返回；否则 zwr 匹配 `/c/...`、`/cygdrive/c/...`、`\c\...` → `C:\...`，正斜杠全翻反斜杠，无兜底 slash-flip）+ `wwe(e)=Xun(e,yLe)`（危险删除路径判定的 windows-aware 组合）。`qpt` @207109251 = UNC 设备路径规范化器（`\\?\C:\x`、`\\localhost\C$\x` → `C:\x`）。

**范围裁定（Option-B，实测驱动）**：probe（`bashToolHasPermission` 真入口，NODE_ENV=test）证明——① 灾难形 `rm -rf /`、`rm -rf ~` 在 OCC 所有模式（含 bypass）已是硬 deny，天然免疫；② 关键路径 ask（`/usr`、盘符子目录）此前 decisionReason `{type:'other'}`，bypass 下被 `maybeSuppressForBypass`(G6) 压成 passthrough → 泛化自动放行——**与官方 circuitBreaker 语义的真实缺口**；③ Git-Bash 形（`/c/Users`）从不翻译。故 v296 parity = 翻译层 + bypass 免疫两半，缺一不可。

**移植落点**：
1. **新模块 `src/utils/permissions/gitBashPaths.ts`**（机器生成纪律：zwr 字面量与 qpt 函数体从 ELF 提取件 splice，未手敲正则文本；标识符按语义改名 translateGitBashPathToWindows / normalizeUncDevicePath / checkWithGitBashTranslation / isDangerousRemovalPathWindowsAware）。windows 门控走 OCC `getPlatform()`。
2. **官方调用点映射**：① 关键路径检查 → `BashTool/pathValidation.ts checkDangerousRemovalPaths` + `inlineShellRm.ts isDangerousLiteralTarget`（globBase/resolved 两处）换用 windows-aware 包装——**已接线**；② workspace-dir/ancestor 检查 → OCC 的 out-of-workspace ask——**N/A-safe 不移植**（default 模式已是 failsafe ask；官方 bypass 同样压制 out-of-workspace ask，语义无缺口）；③ rootish 变量值检查 → inlineShellRm 包装替换已覆盖。**PowerShellTool 三处调用点刻意不动**（官方修复仅 bash 分析器面）。
3. **decisionReason 翻面**：关键路径 ask 从 `{type:'other'}` 改为官方 `{type:'safetyCheck', classifierApprovable:false, circuitBreaker:'dangerousRemoval'}` 形状（复用 CC 2.1.288 #54 内联 shell 移植已建立的形状）——零新管线即获得：permissions.ts step 1g bypass 免疫、line-612 auto-mode 分类器免疫（headless shouldAvoidPermissionPrompts → deny，官方同向）、line-224 渲染不变（safetyCheck 与 other 同渲染 decisionReason.reason，提示文案无扰动）。
4. **`maybeSuppressForBypass` 窄豁免**：仅 `circuitBreaker==='dangerousRemoval'` 的 ask 不被 bypass 压制；G6 保护路径（.git/.claude/.vscode/shell configs）压制契约对无 breaker 的 safetyCheck ask 原样保留（测试钉住）。
5. **step 1g 双站点守卫**：`--dangerously-skip-protected-paths` 的自动放行不得吞掉 dangerousRemoval breaker（该 flag 名义与实义都是保护路径写；circuitBreaker 的文档不变量是"任何 rule/bypass/分类器不得覆盖"）。两站点均以 `&& circuitBreaker !== 'dangerousRemoval'` 收窄；窄性有正反双测试（flag ON：`rm -rf /usr` 仍 ask；`echo x > .git/config` 仍被跳过）。

**验证**：RED（3 pass/5 fail/module-not-found）→ GREEN：`gitBashPaths296.test.ts` 16/16（翻译/UNC/门控/双通道短路/wwe 组合，platform-mock 按 ripgrepUnreadableWindows292 惯例 afterAll 复原）+ `dangerousRm296.test.ts` 10/10（default/bypass × 灾难形 deny 回归钉 × windows-mock 翻译链 × linux 门控 × step-1g 功能钉[checkRuleBasedPermissions 可 hermetic 导入] + 源锚钉[hasPermissionsToUseToolInner 站点按 uncSafetyCheck292/hookJudgment294 惯例 readFileSync 断言]）。已知测试 bug 修正：ask message 内嵌的是原始 absolutePath（`/c/Users`）而非翻译形——翻译只发生在谓词内部（官方 Xun 形状），断言已对齐。三目录全量扫（BashTool+permissions+PowerShellTool，88 文件）：dirty 1487 pass / clean 1461 pass（差值 = 26 新测试），双臂 fail 集逐行相同（6 例 = bashReadCommands293.integration ×4 + shellWiring042 ×2，全量并发跑的既有 contention 抖动，两臂单独跑均 7/7 过）→ **零回归**。biome clean；`bun run build` 绿（dist/cli.js 30.07 MB）。commit a7bb105 已推送。

**裁定：#050 PORT DONE。P1 全部清零（#059/#061/#007/#008/#019/#009/#014/#030/#002/#006/#023/#043/#016/#050 + P0 #031/#032）。下一步：P2/P3 按成本收益 triage，未消化项 STAGED 记录不静默丢弃。**

### §7.9 #004 `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`（changelog 第 4 条）：**PORT DONE（f5e5e49，25 新测试，A/B 零回归）**

**官方取证（v296 ELF，md5 `3c8749470f70a26efadf982b587e1548`；python3 mmap.find 字节定位 + dd 提取，未执行官方二进制）**：changelog 第 4 条 = 新增 env `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`。v295→v296 非持久退避调用点被改写（v295 @217571323 → v296 @218332694，原文逐字存档 `scratch/004-v295.txt`/`004-v296.txt`）：v295 为 `ir=EF(en+G,Qo,void 0,r.random,m1(nn)?a.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS:void 0)` + `else if(ir>fcr)throw`；v296 先 `Vo=w1(an)` 单点判定，`or=Vo?a.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS:void 0`，`dr=MF(on+G,fo,or,r.random,Vo?…BASE…:void 0)`（`or` 进 MF 第 3 参 capMs，默认 32000），too-long 阈值从裸 `fcr` 加宽为 `Math.max(ehr,Math.ceil((or??0)*(1+Swo)))`。符号字节定位：`Swo=0.25` @209499871（`var de=500,Swo=0.25;function MF(e,r,n=32000,…)`，与 getRetryDelay 抖动比同源）、`ehr=60000` @218319887（常量块 `Hgr=1000,Ygr=1000,ehr=60000,thr=300000,L6e=21600000`）、`w1` @209501135（`status===529 || message 含 "type":"overloaded_error"` — 与 OCC `is529Error` 逐字节相同）、env 描述符 `Ci=H.int({min:32000,max:64000,digitsOnly:!0})` @207579344（紧邻 BASE 的 `ni=H.int({min:500,max:32000,digitsOnly:!0})`）、导出表 @207578248。MAX token 在 v295 ELF **0 命中**（v296 新增，坐实缺口）。

**移植落点（单文件 `src/services/api/withRetry.ts`）**：
1. `getOverloadedRetryMaxDelayMs()` — 镜像 292 代 BASE 解析器（digits-only 正则 + parseEnvInt + [32000,64000] 范围；越界/非法/未设 → undefined，MF 默认 cap 32000 生效）。
2. `getRetryAfterTooLongThresholdMs(override?)` — 官方加宽公式 `Math.max(60000, Math.ceil((override??0)*1.25))` 的纯函数化（导出可测；Swo=0.25 抖动余量，官方 rationale：抬 cap 后近 cap 的合法退避不得触发 too-long throw）。
3. 调用点：`is529Error(error)` 提升为局部 `isOverloadedError`（官方 w1 单点判定，BASE+MAX 两 env 共用同一门控），`overloadedMaxDelayMs` 作为 getRetryDelay 第 3 参（原先恒 `undefined`），too-long 比较改走新阈值函数。watchdog 分支（`QK()`≡watchdogRetryEnabled）与持久两路**不动**——官方 v296 也只改这一个 else 分支。

**验证**：RED（20 fail/5 pass，过臂为 v295 既有行为钉）→ GREEN 25/25（`overloadedRetryMaxDelay296.test.ts`：描述符单元 12 + 阈值公式单元 6（含 Math.ceil 打平/进位边界）+ cap 窗口单元 2 + 集成钉 5——529+MAX=64000 时 retry-after 70 改 sleep（v295 会 throw）、非 529 的 500 不受 env 影响（w1 门控钉）、阈值有限（90s 仍 throw）、MAX 未设时 v295 行为原样、无 header 指数退避收于 [64000,80000]；集成复用 retryWatchdogRetryAfter281 passthrough-mock harness）。withRetry 全消费面 18 文件：295 pass/0 fail。`src/services/api/__tests__/` 全目录 A/B（原子 stash）：dirty 503 pass/0 fail vs clean 478 pass/0 fail（差值恰 = 25 新测试）→ **零回归**。biome clean；`bun run build` 绿（dist/cli.js 30.07 MB）。commit f5e5e49 已推送。

**裁定：#004 PORT DONE。P2 余量：#003（`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`）；随后 §8 对剩余 CAND 行做 STAGED/N-A triage。**

### §7.10 #003 `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`（changelog 第 3 条）：**PORT DONE（5a77e23，25 新测试，A/B 零回归）**

**官方取证（v296 ELF，md5 `3c8749470f70a26efadf982b587e1548`；python3 mmap.find 字节定位 + 窗口提取，未执行官方二进制；10 个窗口 + 调用点全文存档 `scratch/003-w-*.txt`/`003-callsite-full.txt`）**：changelog 第 3 条 = 新增 env `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`（workflow 内所有 subagent 统一模型）。官方完整面（全部逐字恢复）：
1. **getter 模块 `QTe`** @215582922（独立 chunk，原文即 raw JS）：`function QTe(){let e=a.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL;if(!e||e.toLowerCase()==="inherit")return;if(a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE&&XFe("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL")?.trim()!==e)return;return e}` — 未设/空/'inherit'（大小写不敏感）→ undefined；**FORCE 守卫**：`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 开启时，仅当策略 env 组合携带同一值（trim 后相等）才生效 — 自设 env 不穿透 FORCE。`XFe(e)=Iko(M(),e)` @209449416，`M()`=`ji().lastPolicyEnvComposition`（策略 env 组合读取器）。
2. **解析器 `YU` 集成**（≡OCC `getAgentModel`，@216345215 区域全文）：`Y=y?.inWorkflowRun?QTe():void 0; if([e,r]=Y!==void 0?[void 0,void 0]:rAt(e,r),…)` — Y 有值时 frontmatter(e) 与 tool(r) 模型**双双作废**；env 兜底 `let he=Y??jte()` — workflow env 优先于通用 `CLAUDE_CODE_SUBAGENT_MODEL`（`jte()`=通用 env 或 "inherit"）。遥测包装 `_Xo` 标注 precedence `"workflow_env"`。远端路径调用点 @228342056 坐实上下文形状 `YU(void 0,…,{inWorkflowRun:p!==void 0})`（该调用点属 cloud-session 面，OCC 已裁剪 → N/A）。
3. **workflow 运行器 `Bt`** @228307864：`function Bt(R){if(R)return R;let j=QTe();if(j!==void 0)return j;let G=jte();return G!=="inherit"?G:U.options.mainLoopModel}` — 显式 > workflow env > 通用 env(≠inherit) > 主循环模型。
4. **agent() 抑制** @228311306（v296 双臂；v295 仅 FORCE 单臂且措辞 "…FORCE is set" @227975827，v296 改 "…FORCE is on"）：`let kt=QTe()!==void 0?"CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL is set":a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE?"CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on":void 0; if(J?.model!==void 0&&kt!==void 0)t(\`Workflow agent model "${J.model}" ignored: ${kt}\`),J.model=void 0;`
5. **scrubber 管控集 `obr`** @211233225：v296 追加该令牌（v295 集尾 @210502979 止于 `CLAUDE_CODE_ENABLE_CFC`，字节对比坐实增量为单令牌）— 项目/本地设置不得再设 workflow subagent 模型。`pBr` 文档门 @240260359（workflow 撰写参考文档 gated `FORCE||QTe()!==void 0`）— OCC 的 workflow 参考文档为自有文本，无对应面 → N/A。令牌命中偏移：97085152/100417944（字符串表）、207576577（env 注册表）、208765415/208771578（env 名单）、211233225（obr）、215582922/215583044（QTe 模块）、228311306（kt）、242333887。

**移植落点（7 文件，5a77e23）**：
1. 新建 `src/utils/model/workflowSubagentModel.ts` — `getWorkflowSubagentModel()`（≡QTe，含 FORCE 守卫）+ `resolveWorkflowSubagentEffectiveModel(explicit,mainLoop)`（≡Bt 四级链）。**两处文档化适配**（非发明）：XFe/M() 策略组合 → `getSettingsForSource('policySettings')?.env`（OCC managedEnv 最后应用到 process.env 的同一源；raw-vs-composed 差异仅在 ${VAR} 展开值场景，trim 相等守卫判不匹配 → FORCE 下丢弃，fail-closed 与官方同向）；FORCE 判定用 `isEnvTruthy`（与 OCC Gap-113b 既有 FORCE 语义一致，官方为裸字符串 truthy）。
2. `src/utils/model/agent.ts` — `getAgentModel` 增第 5 参 `inWorkflowRun?: boolean`；Y 臂早退（Y 恒为具体模型 — QTe 已滤 'inherit'，官方 inherit→S() 臂不可达），置于既有 env-first 分支之前（≡`he=Y??jte()` 优先级）。
3. `src/tools/AgentTool/runAgent.ts` — 调用点穿 `querySource === 'workflow'`（primitives 既有字面量，≡官方 `{inWorkflowRun}` 上下文）。AgentTool.tsx:471（纯遥测）与 resumeAgent.ts:193（恢复面）非 workflow 路径，不传 → 行为不变。
4. `src/tools/WorkflowTool/primitives.ts` — 抑制块升级为官方双臂 `kt`（含 FORCE 措辞 "is set"→"is on" 对齐）；`agentModel` 改走 `resolveWorkflowSubagentEffectiveModel`（stagger key + started 遥测反映实际运行模型）。
5. `src/utils/managedEnv.ts` — `PROJECT_SCOPE_BLOCKED_ENV_KEYS` 追加令牌（≡obr 增量；`projectScopeEnvBlocklist251.test.ts` 计数钉 116→117）。

**验证**：RED（模块级 fail，25 测试未存在面）→ GREEN 25/25（`workflowSubagentModel296.test.ts`：QTe 单元 9（inherit 大小写、FORCE 守卫四态含 trim 相等）+ YU Y 臂集成 7（双模型作废、`Y??jte()` 优先级、'inherit' 过滤回落、非 workflow 惰性）+ Bt 链单元 6 + 布线钉 3（blocklist 成员 hermetic、runAgent/primitives 源锚钉）；策略 env 播种走 `setCachedSettingsForSource` 公有缓存 API，disableWebFetch285 惯例）。消费面 sweep：model+managedEnv 24 文件 491 pass/0 fail、WorkflowTool+AgentTool 22 文件 225 pass/0 fail。原子 A/B（stash push -u→双 sweep→pop 单命令）：dirty 716 vs clean 691（差值恰 = 25 新测试）→ **零回归**。biome clean（仅 primitives 2 处既有 phase() 签名 warning，与本切片无关）；`bun run build` 绿（dist/cli.js 30.07 MB）。commit 5a77e23 已推送。

**裁定：#003 PORT DONE（含 N/A 子面：cloud 远端调用点、pBr 文档门、_Xo 遥测标注 — OCC 无对应承载面）。P2-PORT 余量清零；下一步 §8 对剩余 CAND 行做 STAGED/N-A triage。**

## §8 P2/P3 余量终裁（STAGED / N-A，no-silent-drop）

方法：P0/P1 全部收口（§7.1–§7.10）后，对 §3 剩余 32 个 CAND/CAND-v 行做终裁。N/A 判定给结构性证据（occ153 §9.3 教训：不得只凭 grep 0 命中，接线型修复要核基建）；拿不准的一律 STAGED 结转下一轮并标注预期成本与 verify-first 事项。**合计：STAGED 28 + N/A-TRIMMED 4 = 32 ✓**。

### §8.1 N/A-TRIMMED ×4（子系统缺失，结构性证据）

- **#040/#041（claude.ai 同步 skills/plugin）**：`syncSkillsFromClaudeAi`/`claudeAiSkills`/`skillSyncEnabled` 全 src/ 0 命中，claude.ai 同步子系统在 OCC 不存在（早期 grep 对 `loadSkillsDir.ts`/`commands.ts` 的命中均为本地加载路径误报）。共享 config 目录重下与 marketplace 依赖禁用两个 bug 都寄生在同步子系统上 → N/A-TRIMMED。
- **#045/#058（`CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` 族）**：GC 实现（`transcriptGc`/`localGc`/`gcTranscript`/`rewriteTranscript`）全 src/ 0 命中；env 令牌仅出现在 `projectScopeDisableAttachments290.test.ts` 的 scrubber 名单断言里（令牌已在 `PROJECT_SCOPE_BLOCKED_ENV_KEYS`，子系统本体未移植）。U+2028/U+2029 丢弃与 ≥10% 重写阈值两个 bug 都寄生在 GC 重写上 → N/A-TRIMMED。若未来移植 GC 子系统，两行随之复活。

### §8.2 STAGED ×28（按族分组结转，含预期成本）

**autoBackground/`←` 族（#033/#034/#062，预期成本：大，三项合并取证）**：基建 LIVE（`src/services/mcp/autoBackground.ts` + `LocalAgentTask` + 295 族已有 `autoBackgroundHold295.test.ts` 补丁）。#062 是行为变更（移 bg 时已启动 turn / `!` 命令应被**停止**而非 invisibly 跑完）、#033 双跑竞态（bg service 慢时 prompt 跑两次）、#034 prompt 消失可 `↑` 取回——三项共用同一移 bg 路径，官方取证一次覆盖三行；竞态验证需注入 bg-service 延迟，测试成本高。

**plugin hook 同名/时序族（#005/#020/#035，预期成本：中）**：SessionStart/plugin hook 去重键归一化（同名或变体拼写 plugin 导致 hooks 被跳过）+ headless 迟加载时序（hook 输出在 `/clear` 后到达新对话）。`sessionStart.ts` LIVE；三行共享同一去重键取证。

**prototype-key 族（#027/#028，预期成本：小，quick-win 候选）**：295#062 已落 `optionKeySafety`（`pluginOptionsStorage.ts` + `pluginOptionsProtoKeys295.test.ts`），本族是同一模式向 marketplace 名 `constructor`（`marketplaceManager` add/update/install 路径）与 plugin secret 名 `constructor`/`prototype`（保存时被删）的延伸。同族测试模式已在库。

**PowerShell 族（#036/#047，预期成本：小-中）**：`PowerShellTool` LIVE（含 `gitSafety.ts`）。#036 = 295#071 Bash 侧 `CLAUDE_ENV_FILE` 的 PowerShell parity（纯赋值时变量不可见）；#047 = >1KB 命令恒询问 → allow 规则/只读检测适用到 32KB 阈值。需取证官方阈值常量与 env-file dot-source 逻辑。

**U+2028/U+2029 字符族（#046，预期成本：小）**：`purge` 子命令 LIVE（`main.tsx:4886` + `cli/handlers/projectPurge.ts`，288#77 已对齐）；官方 bug = purge 后含 U+2028/U+2029 的 prompt 留在 history 文件。需核 OCC history 文件行匹配是否同病（JS 把 U+2028/2029 当行终止符的经典坑）。

**MCP 优雅关停（#048，预期成本：中）**：stdio MCP server 关机先关 stdin、300ms 后仍活才杀进程树。`services/mcp/client.ts` LIVE；graceful-shutdown 逻辑跨平台通用（官方 tag 为 Windows，但语义全平台受益）。

**teleport（#012，预期成本：中）**：`--teleport` LIVE（`main.tsx` + `utils/teleport/api.js` `fetchSession`）。session history 读不到时应报错而非打开空对话。需取证官方错误分支文案。

**模型/token 计数（#013，预期成本：小，verify-first）**：gateway 失败半 N/A；adaptive-thinking budget 误计半——OCC `tokens*`/`claude.ts` 无 `haiku-4-5` 命中，先核 OCC 是否注册 Haiku 5.5/adaptive-thinking-only 模型，未注册则整行 N/A。

**OSC52/VTE（#017，预期成本：小-中）**：osc52 面 LIVE（`ScrollKeybindingHandler.tsx` `'osc52'` 分支 + `osc52ClipboardRead.ts`）。老 VTE（MATE）copy 后残留 `52;c;` 转义串——需取证官方 VTE 检测/终结序列差异。

**UI/UX 杂项（#018/#051/#052/#056）**：#018 `/diff` 面板期间 toasts 挂起（`toastQueue` 0 命中——先核 OCC toast 对应面再定 N/A，预期成本：小）；#051 fullscreen 鼠标悬停下划线（OCC mouse 面存在：`FullscreenLayout.tsx`/`VirtualMessageList.tsx`，P3 低优，预期成本：小）；#052 ctrl+o transcript 卡顿→缓存高亮块（`CtrlOToExpand.tsx`/`HighlightedCode.tsx` LIVE，**与本轮 salvage 已落 #091-295 hljsGrammarPatches/hljsLimit 有交互，须对位调和**，预期成本：中）；#056 auto-mode "Not run" dim 行（`autoModeDenials.ts` LIVE，预期成本：小）。

**auto mode artifact（#039，预期成本：中）**：偶发误判 sharing 变化拒绝更新自己的 artifact。需取证官方 sharing-change 判定链（Artifact 面 11 文件）。

**startup 挂起（#042，预期成本：中）**：Linux 拷来的 plugin 路径指向 `/home` 导致 macOS 启动挂起。`pluginLoader` LIVE；启动路径改动需谨慎（挂起类 bug 难复现，需构造跨平台路径桩）。

**/code-review 输出（#038，预期成本：小，verify-first）**：cloud/IDE 分发半 N/A；OCC `/code-review` 独立实现（`src/commands/review.ts`），先核是否同病 raw JSON array 结尾，是则改编号列表。

**hook 输出改写（#015，预期成本：小，verify-first）**：`pluginHint`/`hintTag` 0 命中——按 occ153 §9.3 教训不径判 N/A，先核 OCC hook 输出是否存在 hint-tag 类改写路径，无则 N/A。

**frontmatter debug（#055，预期成本：小-中）**：`--debug` 点名 custom agent 文件未识别 frontmatter 字段 + typo 提示（295 B1 schema 族延伸，`AgentTool.tsx` LIVE）。

**hook debug 日志（#057，预期成本：小）**：`--debug` 下 command hooks 完成时记录 command/plugin/outcome/duration。OCC hook debug 日志面 0 命中，属新增日志行（低风险提示面）。

**dataviz skill（#060，预期成本：小，verify-first）**：`src/commands/dataviz.ts` 仅 54 行薄壳，bundled skills 未见 dataviz .md——先核 skill 内容是否实体（stub 则整行 N/A；实体则对位 light 第七序列/dark 主文本/y 轴 1K 标签三处色板改动）。

**plugin install HTTPS 重试（#049，预期成本：小）**：`marketplaceManager` ssh 链 LIVE（BatchMode/StrictHostKeyChecking/GIT_NO_PROMPT）；无 SSH key 机器上 `owner/repo` 源失败 → HTTPS 重试。注意与 OCC-134 已接受的 credential-helper 残留风险模型对位（HTTPS 重试不扩大面）。

**OTEL `git_commit_id`（#044，预期成本：小——取证已存档，下轮可直接移植）**：**本轮已完成裁定与取证**。OCC OTEL 消费面 LIVE 但窄（`toolExecution.ts:1424` 单点写 `toolParameters.git_commit_id`）；官方 6+ 符号（`R7t`/`Oss`/`Mss`/`eAo`/`Ur`/`qT`/`xCr`/`Dls`）已定位，工件存档 `scratch/044-*`。改动面 = `git commit -q`（quiet 无输出 hash → 补 `rev-parse`）与 `git -C <dir> commit`（目录参数路径）两个提取分支。

### §8.3 结转纪律

以上 28 行 STAGED 随 occ155（2.1.297 轮）结转，入口以本 §8 为准（同 §4 对 occ153 的处理）：verify-first 行（#013/#015/#018/#038/#060）先花小成本定 N/A 与否；quick-win 族（#027/#028/#036/#046/#049/#044/#057）优先消化；大成本族（#033/#034/#062、#052）单独排期。**79 条全账：12 PORT done + 6 VERIFIED N/A（§7.2/§7.3）+ 29 原 N/A + 4 N/A-TRIMMED（§8.1）+ 28 STAGED（§8.2）= 79 ✓ 无静默丢弃。**

## §9 R2 重复项终裁（OCC-113 轨 vs occ154 轨，Leader 裁决执行记录）

背景：OCC-113 轨已把 2.1.296 的 9 个重复项独立实现并发布为 **v2.1.379**（origin/main@`66905e9`，c1634c5/f3ed083/b1eb311 三簇），与本轨 feature/occ154-296@`0c637e0` 平行撞车。Leader 裁决（issue 评论 `b7c2b415`）：DEFAULT KEEP MAIN，**裁定标准是证据不是偏好**——用 occ154 语料对 main 实现跑差分，任一失败即 SWITCH 回 occ154 实现（v296 逐字移植优先）。全部裁定在 reconcile 分支 `feature/occ154-reconcile`（base `66905e9`）落地，逐项证据如下。官方字节证据一律来自 `/tmp/cc-diff-296/s296.txt`（v296 linux-x64 ELF strings，mmap 定位，只读不执行）。

### §9.1 #002 子代理 autoCompactWindow — **SWITCH → occ154**（reconcile `823d16a`）

- 证据 1（语料）：occ154 canonical 语料 `autoCompactWindowSubagent296.test.ts`（21 测试）对 main 直接 import 失败——官方符号 `wrapAutoCompactWindowCeiling`/`computeSubagentAutoCompactWindow`/`AutoCompactWindowOverride` 在 main 不存在。
- 证据 2（ELF 结构）：官方 spawn 点 @223555765 `autoCompactWindow: e.agentType===Q$&&Xa(e) ? n.options.autoCompactWindow : WJn(n.options.autoCompactWindow, e.autoCompactWindow)`——**在 spawn 时**计算：内置 fork 不加 ceiling 直接继承，其余走 WJn @223498818 包裹（`{ceiling, inner}`，父窗口向下传播）。main 只在 compact-check 时对 agent 自身裸数字与 SESSION 窗口取 min——depth≥2 嵌套子代理（spawn-depth 默认 3，可达）时祖父窗口传播语义分叉。
- 落地：Tool.ts 字段 `autoCompactWindow?: AutoCompactWindowOverride` 替换 main `subagentAutoCompactWindow?: number`；runAgent/inProcessRunner/autoCompact/loadAgentsDir/query.ts 全部对位；main 的 `agentAutoCompactWindow296.test.ts` 保留（17/18 原样过，1 例改写为 ceiling-wrap 语义）+ main 独有 coreSchemas SDK 条目保留；树内 `subagentAutoCompactWindow` 死引用清零。AgentTool 192/0、compact 34/0、swarm+contextRoom 50/0、biome 12 clean。

### §9.2 #003 CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL — **SWITCH → occ154**（reconcile `cbe52a8`）

- 证据（行为探针，架构中立 4 例对 main getAgentModel）：**4/4 失败**——P1/P1b：`inherit`/`INHERIT` 被当字面模型名返回（main 无 'inherit' 哨兵过滤，官方 QTe @215582922 有）；P2：FORCE 场景自设 env 即被采信（官方要求 policySettings env 组合携带同值才认，main 无此守卫）；P3：`inherit` 阻断 general-env fallback（官方 Bt @228307864 链 `explicit > QTe > general≠'inherit' > mainLoop`）。探针证据留存后删除。
- 落地：`workflowSubagentModel.ts`（QTe 逐字移植 91 行）+ agent.ts `inWorkflowRun` 第 5 参早退臂替换 main ALS 块；main 的 env 注册面（managed-env + SAFE_ENV_VARS）以 2 测试吸收进 canonical 套件。suite 27+12、utils/model 437/0、WorkflowTool 66/0、AgentTool 171/0。

### §9.3 #004 CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS — **SWITCH → occ154**（reconcile `ebb59da`）

- 证据（前会话 ELF 取证 + 本轮复核）：官方 H.int 描述子 @207579354 存在（带界解析）；main 无界解析器收 31999/64001 等越界值，bounds 缺陷坐实。
- 落地：occ154 版 cap 覆盖 + too-long 阈值加宽 + w1 单点双 env 门控整体替换；25 测试语料全过。

### §9.4 #016 secretRedaction 两阶段扫描 — **KEEP MAIN**（吸收 `8011946`）

- 证据：occ154 213 例差分语料（对机器提取的官方模块离线跑分，27 例 delta 全部为"更严格 redaction"方向）中挑选的 **24 例提交探针**对 main 两阶段 assignScanner 引擎（`src/utils/secretRedaction/`，c1634c5）**全过 24/0**；region 套件 126/0。main 实现即官方 v296 逐字移植，双轨收敛。
- 吸收：`src/utils/__tests__/occ154-secretRedaction296.test.ts`（24 探针，occ154- 前缀，R3）。

### §9.5 #031 BASH_ARGV0 权限绕过守卫 — **KEEP MAIN**（吸收 `8011946`）

- 证据：occ154 rebound 语料 **12/12** 对 main `bashArgv0Guard`（c1634c5）全过——赋值-再使用形态在 AST+legacy 双路径均 fail-closed。
- 吸收：`src/tools/BashTool/__tests__/occ154-bashArgv0Rebound296.test.ts`（12 测试，走 `parseForSecurityFromAst`，与 main `bashArgv0Guard296` 无同名冲突，R3）。

### §9.6 #032 非 UTF-8 文件编辑拒绝 — **SWITCH → occ154**（reconcile `ab6027b`+`b3097cf`）

- 证据 1（码位）：官方 aen 拒绝在两处 validateInput 均为 **errorCode:15**（NotebookEdit @10206075 `if(_e)return{result:!1,message:aen,errorCode:15}`；FileEdit @47166593，位于 stale-read 块之后）；官方 errorCode **14** 属文档/批处理校验族（@5813305+ "`data` must be a JSON-serializable object"）——main 用 14 与官方码位族冲突。
- 证据 2（消费面）：官方消费的是文件读取元数据的 lossyDecode 旗（nwe @10207433 `if(Te.lossyDecode)return _e(aen)`；FileEdit call 侧 `new C8(aen)` FileStateError @48305633）——main 无 fileRead lossyDecode 面，走独立 utf8Safety 重读。双轨 aen/UTs 文案字节一致（文案不是分歧点）。
- 落地：fileRead.ts `isLossyUtf8Decode`（官方 IAo @208689628 逐字）+ readFileSyncWithMetadata 返回 lossyDecode（nwe 形状）+ fileStateGuard 双消息常量（@101773572/@101773960 字节一致）；FileEdit/FileWrite 整体取自 occ154；NotebookEdit 手工切除 main utf8Safety 块只留 lossyDecode 流（validateInput errorCode 15 在 JSON parse 之前）；删除 `utf8Safety.ts` 及其 2 测试（树内引用清零）。main 的 0xFF 用例以吸收测试并入 fileReadLossyDecode296（12+1）。Tools 85/0、permissions 417/0、biome 9 clean。

### §9.7 #043 Workflow CRLF 脚本 — **KEEP MAIN**

- 证据：main parse-site 归一化（scriptLoader I3n，f3ed083）覆盖**全部执行消费面**（含 inline 脚本）= 官方 intake-site 位置的超集；occ154 失败探针断言的是归一化发生**位置**而非行为契约，位置差不构成行为回归。main `workflowScriptCrlf296.test.ts` 已在契约级钉住（CRLF 可解析、无 \r 残留、混合行尾、孤立 \r 不归一化、磁盘 CRLF 文件加载，5 测试）。无吸收项。

### §9.8 #059 Sonnet 5.5 cache read 定价 — **KEEP MAIN**（吸收 `8011946`）

- 证据：occ154 modelCost 语料 **8/8** 对 main（f3ed083）全过——双轨收敛同一价目表（$0.10/MTok）。
- 吸收：`src/utils/__tests__/occ154-modelCostSonnet55CacheRead296.test.ts`（8 测试，R3）。

### §9.9 #061 MCP 描述 cap 2048→4096 — **KEEP MAIN**

- 证据：main 81/81（同文件 `client.ts` 同 cap 值，双轨收敛，f3ed083）。无增量语料。

**R2 小结：9 项全裁定——SWITCH ×4（#002/#003/#004/#032，官方字节/行为证据），KEEP MAIN ×5（#016/#031/#043/#059/#061，语料全过）。R3 同步满足：KEEP 项吸收语料一律 `occ154-` 前缀（`8011946`，44/0），SWITCH 项收回 canonical 文件名，23 文件同名冲突面清零。**

## §10 R6 流程护栏（撞车根因与串行化纪律）

**根因**：OCC-113 与 OCC-154 从同一 base `6ff64c8` **平行**追齐 2.1.296——两轨独立取证、独立移植、独立测试，产出 9 个重复实现 + 23 个同名测试文件冲突面，OCC-113 轨先行发布 v2.1.379 后本轨 29 commits 全部悬空，只能走本轮 reconcile（R1–R6）收口。两轨全程互不知情。

**护栏（此后每个版本追齐轮开工前必查，任一命中即串行化）**：

1. **查在飞对齐轨**：`git branch -r` 列出所有远端分支，凡 `feature/occ*`、`agent/occ/*` 分支名或最近 commit message 命中当前目标版本号（如 `2.1.296`）即视为在飞对齐轨。
2. **查在飞任务**：`multica agent tasks <agent-id> --output json` 核 running/queued 任务描述是否覆盖同一版本追齐；`multica issue children` 核同 project 下有无同版本 gap issue 未关闭。
3. **命中即串行**：同一官方版本只允许**一条**对齐轨在飞。后启动方要么等先启动方合入后做增量 gap（只补 diff），要么由 Leader 显式裁决分工面（按 changelog 条目区间切分，两轨条目集合不相交），禁止两轨各自全量移植。
4. **开工声明**：追齐轮开工 issue 评论必须写明目标版本号 + 已核查的在飞轨清单（"无在飞轨"也要显式写），供 Leader 与他轨程序员对表。
5. **账本单一权威**：同一版本号的 gap 账本只开一份 `docs/upstream-version-gap-occ<N>-*.md`；他轨接手时在原文档追加 §，不另开新档（本轮 occ113/occ154 双账本已在 §9 收敛为单一权威记录，occ113 文档头部加会师横幅互指）。

## §11 修复轮记录（程序员，feature/occ154-reconcile，`dd61baa`→`18bc174`，2026-10-11）

Leader 委派修复轮：验收员候选验证 12 项裁决（11 confirmed / 1 falsified）全部采纳，处理 confirmed 项。修复决策规则：优先官方 v296 ELF 语义（取证 `/tmp/cc-diff-296`，R5 批准有效）；不可行则回退 main 行为 + 账本 STAGED。全程未触碰 `feature/occ154-296` 与 main；小切片 commit+push。

### §11.1 commit 链（9 commits，均已 push）

| commit | 项 | 内容 |
|---|---|---|
| `4a4d871` | contract-001 | loadAgentsDir.ts 重复 AUTO_COMPACT_WINDOW 命名导入块去重（TS2300 ×4 归零） |
| `ef67c5e` | contract-002 | 官方 v296 `spawnedByWorkflowRunId` lineage 机制移植（Tool.ts 字段 + forkedAgent 继承 + runAgent 判别 @官方调用点 228342056 + primitives 传 runId）；嵌套 spawn 不再丢 `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` |
| `4dd8f4a` | df-02 + t-05 | query.ts:1104 `turnModel = nextFallbackModel`（镜像官方 `Yn(vt)` @53594595 原地刷新）+ queryFallbackRoom296.test.ts（299 行，真 query() 生成器驱动，兼作 t-05 接线钉） |
| `c9d2b11` | df-01 | **ELF 证伪 → 无生产代码变更**；allowLarge296.test.ts 追加 3 钉固定官方混合语义（详见 §11.2） |
| `adfc3ce` | t-02 | hljsLimit295.test.ts（12 tests）：Layer A before:highlight 边界常量/专属 cap/权重钉 |
| `c526dcb` | t-03 | hljsGrammarPatches295.test.ts（4 tests）：Layer B LANGUAGE_PATCHES 契约钉（真实 v11.11.1 上验证） |
| `bbf11a8` | t-04 | hljsBoundGuard295.test.ts（4 tests）：hljsBound 双守卫安装接线钉（M-A/M-B） |
| `307887d` | t-06 | markdownWindowedTable295.test.ts（2 tests/15 expects）：GIVEUP_WINDOW_LINES=16000 常量钉 + 1100 行表格 windowTable fixture |
| `18bc174` | t-01 ≡ e2e-01 | test/e2e/dist-hljs-injection.e2e.test.ts（335 行，两腿产物级回归；详见 §11.4） |

### §11.2 逐项处置（12 项裁决）

| finding | 验收员裁决 | 本轮处置 | mutation-verify |
|---|---|---|---|
| contract-001 | confirmed | **FIXED** `4a4d871`（卫生项） | n/a（tsc TS2300 ×4→0 即验证） |
| contract-002 | confirmed | **FIXED** `ef67c5e`（官方 lineage 语义） | 删 forkedAgent 继承→RED，恢复→GREEN；workflowSubagentModel296 29/0；scope：AgentTool+model 631/0、WorkflowTool 66/0 |
| df-01 | confirmed | **ELF-FALSIFIED → 无生产变更** + 3 钉 `c9d2b11`；证伪链见 §11.3；**请验收员复测时重裁** | 硬编码 bpt=3 于 allowLarge.ts:127 → 3 钉全 RED、既有 51 绿；contextRoom296 35 不受影响（89/89） |
| df-02 | confirmed | **FIXED** `4dd8f4a`（官方 `Yn(vt)` 语义：room getter `()=>Rt` @53561900 活刷新，room identity + claimed() 保持，不重跑 seeding） | 删 `turnModel = nextFallbackModel` → df-02 RED（167000≠767000）；删 `contextRoom: () => turnContextRoom` 接线 → df-02+t-05 双 RED；基线 86/86 两 mutation 下保持绿 |
| df-03 | **falsified（验收员）** | 无代码变更，证伪结论存档 §11.5 | n/a |
| t-01 ≡ e2e-01 | confirmed | **FIXED** `18bc174`（两腿产物级回归测试） | 双向 ×2 轮，见 §11.4 |
| t-02 | confirmed | hljsLimit295.test.ts `adfc3ce` | 3/3 配方 RED（limit 50000→100000 3 fail；markdown WEIGHT_RULES 删条目 1 fail；excess-limit off-by-one 2 fail），restore GREEN 12/12 |
| t-03 | confirmed | hljsGrammarPatches295.test.ts `c526dcb` | 删 markdown+python patch 条目 → 3 RED（fence/link/number）、rust 对照 GREEN；restore 4/4（与 t-02 合跑 16/16） |
| t-04 | confirmed | hljsBoundGuard295.test.ts `bbf11a8` | M-A（禁 limit-guard 安装）→ 2 RED；M-B（删 isBounded 早退）→ 1 RED；restore 后四 hljs 套件 29/29 |
| t-05 | confirmed | 并入 `4dd8f4a` driver test（contextRoom 逐轮接线钉） | 同 df-02 行第二 mutation：删接线 → t-05 RED（原 86/86 全绿盲区被咬住） |
| t-06 | confirmed | markdownWindowedTable295.test.ts `307887d` | M-C1 GIVEUP 16000→999 → 常量钉 RED（既有 13 绿）；M-C2 行循环 cap → rows 1000≠1100 RED；restore 15/0/57（两 windowed 套件） |

### §11.3 df-01 ELF 证伪存档（完整链）

验收员 finding：plan-mode 'haiku'→sonnet-4-5 升级场景，`raised.maxSizeBytes` 取静态 `options.mainLoopModel`（bpt 4 → 1402788）而非 contextRoom 活跃已升级模型（bpt 3 → oracle 1052091），声称两 cap 之间读文件 HEAD 放行 / oracle 拒绝。

**官方 v296 ELF 取证（/tmp/cc-diff-296，strings + mmap.find，未执行官方二进制）**：

1. 官方 `lOr` @1722587：`raised.maxSizeBytes` 的 bytesPerToken(bpt) 来自 facade `e.model()` —— 即**静态** `options.mainLoopModel`；threshold 来自 live contextRoom。**官方本身就是混合语义**（静态 bpt × 活 threshold），HEAD 与官方一致。
2. **LEGACY bytesPerToken 集合同时包含 `claude-haiku-4-5` 与 `claude-sonnet-4-5`（均 bpt 4）**：验收员设想的升级对（haiku→sonnet-4-5）两端 bpt 相同 → 静态与活跃取值结果一致 → **分歧前提不成立**。
3. oracle 1052091 = floor(167000×0.7)×9 = 116899×9，要求 sonnet-4-5 的 bpt=3；官方 bytesPerToken 对 sonnet-4-5 返回 4（116899×12 = 1402788，即验收员自己引用的"静态值"）。**oracle 计算有误**。

处置：无生产代码变更；allowLarge296.test.ts 3 钉固定官方混合语义（含升级场景 1402788 断言），mutation（硬编码 bpt=3）全 RED 证明钉咬合。**此证伪推翻验收员 confirmed 裁决，复测时请重裁。**

### §11.4 D 项（t-01≡e2e-01）产物级回归：设计取证与三个环境发现

**dist hljs 拓扑取证**（byte-offset 级）：dist/cli.js 内联两代 hljs —— cli-highlight 私有的 @10.7.3（块 ≈9.33M–11.77M，注入点 #1 @11765242）与根 @11.11.1（块 ≈12.12M–13.71M，注入点 #2 @13710716）。cli-highlight 经 `require_lib8`（= @10.7.3 lib/index.js，def @11754500）绑定 hljs → **dist 实际渲染实例是 @10，唯一约束就是 build 注入**（cliHighlight.ts 运行时安装只覆盖 @11；其锚定 require @10 在 bundle 内按设计失败）。

**灾难输入选型**（hljs@10.7.3 store 拷贝实测）：`handlebars` 语言（内嵌 xml subLanguage → 级联复现，且**不在** html/xml/xhtml 前置过滤集内）+ `<script>`×24 = 无界 >70s（×20 = 13.1s）；有界（双守卫）→ HighlightBoundError @16ms。排除的候选：markdown 未闭合 fence **线性**（40k 字符 28ms，无冻结）、js `'${`×5000 = 32ms、js 55k = 55ms、xml ×20 = 13.2s 但被前置过滤挡住（不可判别）。

**两腿**：
- Leg 1（ungated，CI-red 门）：dist 提取注入 marker —— `.installHighlightBounds(module` ×2、`.applyGrammarPatches(module` ×2（rename-tolerant：匹配 `module.`/`module2.` 两形，不匹配 cliHighlight.ts 的 2 处裸运行时调用）、`hljs.registerLanguage` ≥300（两代均内联）。ci.yml 先 build 后 test（:37 注释）→ 发布机注入静默失效必 CI 红。
- Leg 2（skipIf(CI)，tmux REPL + mock SSE 流式 ```handlebars fence）：**判别信号 = 事件循环响应性（keystroke canary），不是 pane 文本** —— 见发现 2/3。

**三个环境/设计发现**（后续任何产物级高亮测试必读）：
1. **FORCE_COLOR 必需**：沙箱父环境无 TERM → 产物整个 TUI 无色、fence 全 plain、高亮管线整体休眠（mutation 下 leg 2 假绿）。`FORCE_COLOR=1 TERM=xterm-256color` 后 mutation dist 上 js fence 可着色 → 管线经无界 @10 实跑。
2. **Suspense fallback 画面不可判别**：Markdown.tsx 在 `getCliHighlightPromise` 决议前先以 fallback（highlight=null）画出 plain fence 体 → mutation dist 的 pane 在 ~1s 就显示 `<script>`×24（冻结发生在其后的同步高亮重渲染）。健康 dist 的最终画面同样是 plain（有界抛错 → memo → 降级），**两侧 pane 文本相同**。
3. **pre-freeze echo race → 双 canary**：冻结开始前的 ~100ms 窗口内敲键仍会被 echo（实测出现过一次假绿）。设计：早 canary 发送但**不断言**，settle 5s（mutation 侧冻结确定在途且持续 >70s；健康侧轮次早已完成），晚 canary 必须 30s 内 echo。

**mutation 矩阵（双向，各 ×2 轮确定性复现）**：注入 filter 置 no-op（`/node_modules…/` → `/MUTATION_NOOP…/`）→ build 仍 exit 0 → leg 1 RED（marker 2→0）+ leg 2 RED（模式 A：冻结抢在 fallback flush 前 → fence 30s 不上屏；模式 B：fence 上屏但晚 canary 37s 不 echo）；restore → rebuild → 两腿 GREEN ×2（全程 7.6s）。既有 hljs 套件 36/36 绿。

### §11.5 df-03 证伪存档（验收员产出，按 Leader 指令仅账本记录）

`printTextResults.ts` 的 `autoModeUnavailableStopNotice` latch 在 OCC 全 src 树**无任何 setter** → 可达性为零；官方同状态同样输出空 stderr；base `print.ts:1064-1066` 已同款 stdout 处理。port 文档记明的 no-op 准确，本 diff 未引入/扩大失败。无代码变更。探针存档于验收员 runtime（`static-findings-dataflow:df-03.probe.test.ts`）。

### §11.6 终验 battery（HEAD `18bc174`，2026-10-11）

| 项 | 结果 |
|---|---|
| 修复轮 focused 12 套件（allowLarge296 / queryFallbackRoom296 / workflowSubagentModel296 / contextRoom296 / hljsLimit295 / hljsGrammarPatches295 / hljsBoundGuard295 / hljsBound289 / cliHighlight289 / markdownWindowed295 / markdownWindowedTable295 / markdownBlockquote295） | **179 pass / 0 fail / 693 expect()** |
| 受影响 scope（AgentTool+WorkflowTool+FileReadTool+utils/model+src/__tests__，59 文件） | head **855/2** vs base `dd61baa` worktree **848/2** —— 失败集合逐字相同（agentTelemetry ×2），delta +7 = 本轮新增测试 |
| 上述 2 fail 定性 | agentTelemetry.test.ts 头注**自带文档**的 shared-process analytics-sink 泄漏竞争（attachAnalyticsSink 幂等、泄漏 sink 优先）；CI 以 scripts/ci-test.sh 逐文件进程隔离运行 → 隔离下该文件 4/0 绿、WorkflowTool 全目录逐文件全绿。**非本轮回归** |
| build | 绿：dist/cli.js 30.09 MB，`OCC 2.1.379`（未 bump，gate 未开） |
| headless `-p`（真 key） | `echo "say PONG" \| dist/cli.js -p` → PONG，exit 0 |
| REPL 快烟（真 key，tmux） | boot ready @2s；live round-trip（真实 API）SMOKE-OK @4s |
| dist-hljs-injection e2e（健康 dist） | GREEN ×3 轮（含 mutation 验证前/后） |

### §11.7 gate 与移交

- **发布 gate 不变**：验收员复测 PASS 前不 bump（2.1.380）不 tag；复测对象 = `feature/occ154-reconcile` HEAD `21447d0`（复测后）。
- **移交时必须显式提请验收员重裁 df-01**（本轮 ELF 证伪推翻其 confirmed 裁决，证据链 §11.3）。
- `/tmp/cc-diff-296` 官方取证保留至合入 main。
- 修复轮范围外零改动：`feature/occ154-296`、main、生产代码除 contract-002/df-02/contract-001 三处（均官方语义）外未触碰。

### §11.8 验收员复测记录（验收员，HEAD `21447d0`，2026-10-12）

复测对象 = 修复轮 HEAD `21447d0`（比 §11.6 记录的 `18bc174` 多一个 docs-only commit，生产/测试代码零差异）。**复测结论：PASS，可进入发布链。**

**df-01 重裁（接受程序员的 ELF 证伪）**。逐字节复核官方 v296 ELF（/tmp/cc-diff-296 `s296.txt`）：
- 官方 `lOr` @1722587：`let{bytesPerToken:G}=Xd(e.model())` —— bpt 经 facade `e.model()` 取 **静态** `options.mainLoopModel`；contextRoom 仅供 `threshold`/`held()`/`claimed()`。官方即混合语义（静态 bpt × 活 threshold），HEAD 一致。
- `e.model()` = `qu(e)=p(e)??e.options.mainLoopModel`；`p(e)` 仅当存在 `kind:"model"` 权限层时覆盖。逐站点排查所有 `Tn=[...{kind:"model",mainLoopModel:...}]` 安装点（15+ 处），全部位于 runAgent/agent-spawn/skill/SDK 覆盖路径（含 `yn(C)` 子代理权限声明处理器），**主线程 plan 路径无任何 kind:model 层**（plan-upgrade 只写入 runtimeModel，引用官方 `rg`）。
- LEGACY bpt 集合（官方 `kh` 的 rF Set）同时含 `claude-haiku-4-5` 与 `claude-sonnet-4-5`（均 bpt 4）→ 升级对两端 bpt 相同，分歧前提不成立。
- 复测探针的升级目标实为 `claude-sonnet-5-5`（bpt 3，非 legacy）而非程序员 §11.3 所引 `claude-sonnet-4-5` —— 该表述有出入，但证伪的核心分支（#1：官方 bpt 静态取源）独立成立：即使升级目标是 bpt-3 模型，官方仍以静态 `options.mainLoopModel`（haiku-4-5，bpt 4）计算 → H·12 = 1402788 = HEAD。**原 oracle 1052091（取活模型 bpt 3）在官方源码语义下不成立**。df-01 维持 falsified。
- **mutation 执行确认**（`21447d0` worktree）：allowLarge296.test.ts HEAD 54/0 全绿（含 3 钉）；硬编码 `bytesPerToken=3` 于 allowLarge.ts:127 → **51/3 红**（3 钉全 RED：expect 1402788 got 1052091 / sonnet-4-5 1402788→1052091 / haiku must-not-be-1052091），既有 51 测试全绿 → 钉真实咬合。恢复后 54/0。

**复测 battery（HEAD `21447d0`，全部复跑）**：

| 项 | 结果 |
|---|---|
| 修复轮 focused 12 套件 | **179 pass / 0 fail / 693 expect()**（与 §11.6 逐字节一致） |
| 受影响 scope（59 文件） | **855/2**，失败集合逐字相同（agentTelemetry ×2 shared-process sink 泄漏竞争），隔离执行下该文件 4/0 绿 → **非本轮回归** |
| contract-002（ef67c5e） | diff 对齐官方 `n?.spawnedByWorkflowRunId??e.spawnedByWorkflowRunId`（forkedAgent）+ `dt!==void 0\|\|...\|\|n.spawnedByWorkflowRunId!==void 0`（runAgent inWorkflowRun 判别）；workflowSubagentModel296 + AgentTool + WorkflowTool **287/0**（26 文件） |
| df-02（4dd8f4a） | 真 `query()` 驱动 queryFallbackRoom296 **2/0** + contextRoom296 **35/0** + allowLarge296 **54/0**；mutation（删 `turnModel = nextFallbackModel`）→ df-02 RED（767000→167000 即原缺陷）恢复绿；t-05 同文件同过 |
| C 覆盖 ×5 | t-02 12/0、t-03 4/0、t-04 4/0、t-06 13/0、t-05（含于 4dd8f4a）2/0 |
| D e2e（18bc174） | build 后 dist-hljs-injection **2/0**（Leg1 marker 门 + Leg2 tmux REPL 真键 canary） |
| build | 绿：dist/cli.js 30.09 MB，`OCC 2.1.379`（未 bump，gate 未开） |
| headless `-p`（真 key） | `echo "say PONG"` → **PONG**，exit 0 |
| REPL 快烟（真 key，tmux） | boot ready @2s；live round-trip `● SMOKE-OK` @4s |
| README Tracks badge 四处 | badge(2.1.296 partial)/正文/表格/页脚 = **2.1.296 (partial)** 一致，与账本 §0/§8 对齐（硬检查 #6 通过，无需改 README） |

**验收结论：修复轮 12 项裁决全部处置到位 —— contract-001/002、df-02 genuine-FIXED，df-01/df-03 FALSIFIED（维持，df-01 经重裁确认），t-01..t-06 全部以真实测试钉合，D 项产物级 e2e 双向 mutation 验证。无真实缺陷残留。**

**发布 gate 解除**：可 bump 2.1.380 → tag → npm release（GitHub Workflow）→ 观察 CI。发布链继续执行。

