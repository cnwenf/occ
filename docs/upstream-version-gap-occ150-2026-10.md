# Upstream Version Gap — OCC-150 (2026-10-09 round)

Round-start research ledger for the daily catch-up issue **OCC-150**（`daa2f20a-9ede-49ec-a9a0-f175300e49d1`，autopilot 触发 2026-10-09 01:00 Asia/Shanghai）。
调研执行：OCC Leader（本轮 gap 调研 + 取证摘录；移植轮由 OCC 程序员按 §5 顺序执行）。
方法：npm dist-tags/发布时间核对 → 下载三个版本的 `@anthropic-ai/claude-code-linux-x64` ELF → md5/尺寸/版本标记数 → `strings -a` 全量抽取 + 排序去重 + `comm` 集合差分 → 官方 CHANGELOG 逐条 triage（对照 OCC 源码面 grep 实证）→ 关键站点逐字提取。纪律遵循 `aligning-with-official-binary` / `upstream-tracking` skills：**Never invent** —— 本文所有二进制侧断言都给出可复现的取证数字，未取证的一律标 "needs per-site forensics"。

## §0 版本事实（three-way verified）

官方 npm dist-tags（2026-10-09 查询）：

| tag | version | 发布时间 (UTC) | changelog 条数 |
|---|---|---|---|
| `latest` | **2.1.293** | 2026-10-07T17:18:04Z | 56 |
| `next` | **2.1.294** | 2026-10-08T03:42:57Z | 2 |
| `stable` | 2.1.285 | （未变） | — |

OCC 现状：main @ `5a3299f`，package `2.1.374` ≙ 官方 **2.1.292**（CHANGELOG.md 第 9 行 "Now tracking Claude Code `2.1.292`"）。**Gap = 2.1.293 (latest) + 2.1.294 (next)，共 58 条 changelog 条目**，另有 OCC-149 §8/§10 结转的 STAGED 项（§4）。

ELF 取证（linux-x64 平台包，`npm pack @anthropic-ai/claude-code-linux-x64@<ver>`；注意 `@anthropic-ai/claude-code@<ver>` 的 tarball 只含 wrapper/install.cjs，无二进制）：

| version | ELF bytes | md5 | 自身版本标记数 | 备注 |
|---|---|---|---|---|
| 2.1.292 | 251,456,696 | `266ee31079044fc85c06d80feef37ccb` | 2408 | OCC 当前追齐目标 |
| 2.1.293 | 252,755,128 | `33a00cad155f5ef8e70b65d01adf4b7d` | 2423 | 唯一串差 vs 292：+29,272 / −27,121（实质版本） |
| 2.1.294 | 252,755,128 | `66d0b5080c038991d342e1e0594d21c7` | 2423 | 与 293 **同尺寸**；cmp -l 差异字节偏移 140,703,392（重打包+小逻辑改动） |

293↔294 字符串集合差分：**8495 added / 8495 removed，完全对称** → 绝大部分是重新压缩/混淆噪声。定点复核（`grep -ac` 全串计数）：

- `"Allowing runs the command as written"`：s293 = 2，s294 = 2（相同）
- `"plainly-spelled"`：s293 = 5，s294 = 5（相同）
- `Cannot destructure property 'additionalContext' from null or undefined value`：s293 = 1，s294 = 1（相同；早期 comm 抽样窗口的"仅 293 存在"是打包边界噪声，已推翻）
- 同法复核 `chainReleaseCount` / `linkError` / `loadedModules` / `deleteDataDir` / `pollEvent` / `preTokens` / `rateLimitType` 的 destructure 常量：全部 1 vs 1

**结论：2.1.294 在字符串层无任何可隔离的真实 delta**。其两条 changelog（hook 判定修复，§3）是纯逻辑改动，移植前必须做专项逐站点反编译取证，不能靠字符串 diff 定位。

293 侧新信号（`grep -ac claude-haiku-5-5`）：s292 = **0**，s293 = **9** → Haiku 5.5 是 2.1.293 的头号可移植新功能（§2 已逐字提取）。`context-1m-2025-08-07` 在 292/293 均存在（复用，非新增）；mythos 系列在三版本均 12 hits（非 293 新增）。

## §1 本轮优先级队列（port round queue）

**P0 — 安全相邻（先做）**
1. OCC-149 §7 STAGED 的四条 **2.1.292 安全修复**（当时未落地，结转）：
   - UNC 路径绕过 PreToolUse hook 审批 + auto-mode（OCC 现状：`src/tools/FileReadTool/FileReadTool.ts:599-603` 已有 pre-I/O `isUncPath` 检查，但 **hook/permission 审批路径没有**同等防护 —— 优先补齐）
   - sandboxed 命令可读 `/ultrareview` 在 `~/.claude/seed-admin` 的暂存副本
   - managed sandbox read-deny 路径中途出现/被重指向
   - 篡改磁盘上的 server-managed settings 缓存可顶掉 policy plugin
2. **2.1.294 两条 hook 判定修复**（§3）：instruction 式 `prompt`/`agent` hooks "allowing what they should block"；Stop/SubagentStop instruction hooks 判定过松。OCC 面：`src/utils/hooks/execPromptHook.ts`（244 行）、`execAgentHook.ts`（339 行）。需专项反编译取证。

**P1 — 旗舰功能**
3. **Haiku 5.5**（2.1.293）：§2 有完整逐字提取，照 OCC-36/37（Opus 5 launch）的模型上新 playbook 移植。

**P2 — 可移植候选批量**（§2.1.293 triage 表中标 candidate 的条目，按簇执行）：teleport/← 簇、paste 簇、vim 簇、keybindings 校验、MCP HTTP 泄漏、subagentStatusLine agentType、非 ASCII 排序、purge 对齐核验、daemon 签退、CLAUDE.md 单文件 Bash 读取、/tui --chrome、/model effort 环绕等。

**P3 — STAGED 结转**：#018 WebFetch offset（occ149 §8，取证 70%，helper 清单在案）；#148 skills `!` 原始控制字符拒绝；OCC-109 STAGED 清单。

## §2 Haiku 5.5 — 2.1.293 ELF 逐字提取（可直接进移植）

Registry 条目（verbatim，从 s293 提取）：

```js
{id:"claude-haiku-5-5",family:"haiku",display_name:"Haiku 5.5",knowledge_cutoff:"June 2026",
 provider_ids:{first_party:"claude-haiku-5-5",bedrock:"us.anthropic.claude-haiku-5-5",
   vertex:"claude-haiku-5-5",foundry:"claude-haiku-5-5",anthropic_aws:"claude-haiku-5-5",
   anthropic_google_cloud:"claude-haiku-5-5",mantle:"anthropic.claude-haiku-5-5"},
 vertex_region_env_var:"VERTEX_REGION_CLAUDE_HAIKU_5_5",fallback_3p:"claude-haiku-4-5",
 context:{window:1e6,native_1m:!0,supports_1m_beta:!0},
 max_output_tokens:{default:128000,upper:128000},pricing:"haiku_55",
 capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking","mid_conv_tool_change",
   "context_management","rejects_disabled_thinking","per_turn_effort","lean_prompt",
   "org_locked_thinking","haiku_5_5_early_stopping_guidance"],
 default_effort:"medium",advisor_rank:4}
```

Pricing 档 `haiku_55`（verbatim；与 changelog "$0.10/$0.50 per Mtok（>100K prompt 为 $0.50/$2.50）"一致）：

```js
haiku_55:{input:0.1,output:0.5,cache_write_5m:0.125,cache_write_1h:0.2,cache_read:0.01,
 web_search:0.01,long_prompt:{above_prompt_tokens:1e5,input:0.5,output:2.5,
 cache_write_5m:0.625,cache_write_1h:1,cache_read:0.05}}
```

Haiku 默认切换（verbatim）：

```js
haiku:{default:"claude-haiku-5-5",
 per_provider:{bedrock:"claude-haiku-4-5",vertex:"claude-haiku-4-5",
  foundry:"claude-haiku-4-5",mantle:"claude-haiku-4-5" /* ... */}}
```

即：first-party 默认切到 5-5，第三方 provider（bedrock/vertex/foundry/mantle）留在 4-5（`fallback_3p:"claude-haiku-4-5"` 同源语义）。

Fast-mode gate（verbatim 片段）：`n.includes("haiku")&&n!=="claude-haiku-5-5"` → `!1`，即 haiku-5-5 可进 fast mode，老 haiku 不可。

OCC 现状：全仓 `claude-haiku-5-5` 0 处。移植触点：`src/utils/model/configs.ts`（haiku 默认 `claude-haiku-4-5-20251001` 于 firstParty 分支 line 52 附近；`claude-3-5-haiku-20241022` line 42）、model registry/descriptors、MODEL_COSTS、ModelPicker、capability 允许表、`claude-api` skill 文档、help 文案。1M context beta header `context-1m-2025-08-07` 已存在于 OCC 与官方两版（复用）。

## §3 2.1.293 changelog 逐条 triage（56 条）+ 2.1.294（2 条）

判定标签：**PORT** = 本轮移植；**CAND** = 候选（changelog + OCC 面实证都在，按簇移植）；**VERIFY** = 疑似已对齐/无需动作，移植轮核验；**N/A** = OCC 无该子系统；**WIN** = Windows-only。

### 2.1.294（2 条，全部 P0 CAND）

| # | 条目 | 判定 | 依据 |
|---|---|---|---|
| 1 | instruction 式 `prompt`/`agent` hooks 允许了本该 block 的内容 | **CAND (P0)** | OCC 有 execPromptHook/execAgentHook；§0 证明字符串层不可隔离 → 需专项反编译 |
| 2 | Stop/SubagentStop 上 instruction 式 `prompt` hooks 判定改进，减少提前停止 | **CAND (P0)** | 同上 |

### 2.1.293（56 条）

| # | 条目（摘） | 判定 | 依据/触点 |
|---|---|---|---|
| 1 | Haiku 5.5 发布并成为默认 Haiku | **PORT (P1)** | §2 逐字数据已备 |
| 2 | subagentStatusLine payload 增加 `agentType` | **CAND** | `subagentStatusLine` 12 hits 在 292/293 均有；`agentType` 计数 182→186（+4，与 payload 新增一致）；OCC `StatusLine.tsx:39` 已有 `agentType = getMainThreadAgentType()` 但无 subagentStatusLine 面 → 需先确认 OCC 是否已有该 payload，再取证 diff |
| 3 | `isDeferred` for `$.tool.register` mods | N/A | OCC 无 mods/plugin `$.tool.register` 引擎（occ149 §7 先例） |
| 4 | Compaction 把最近完成的 action 当未完成重复 | CAND | OCC compact 服务面存在；需取证 |
| 5 | MCP HTTP 连接内存泄漏修复 | CAND | `src/services/mcp/client.ts` StreamableHTTP 面存在 |
| 6 | ← 转后台时排队消息丢失 | CAND | teleport 簇（#26/#27 同簇）；`src/utils/teleport.tsx`（1255 行） |
| 7 | /model effort 列表 ←/→ 环绕 | CAND | ModelPicker.tsx 有 effort 机制，未见 wrap 代码 → 需逐站点取证 |
| 8 | /tui --chrome 断连修复 | CAND | OCC 有 `src/commands/tui/tui.ts`（镜像官方 /tui）→ 需确认 chrome 断连路径 |
| 9 | SendMessage 已移除仍向 session 通报 | N/A(dormant) | OCC KAIROS 门控默认关（OCC-24） |
| 10 | subagent/--agent 被告知 builtin tools 完全禁用 | CAND | AgentTool/runAgent 面存在 |
| 11 | claude.ai 同步的 skill 描述 | N/A | 无 claude.ai skill 同步 |
| 12 | daemon logs/stop/kill/rm；daemon status/stop/uninstall 登出修复 | CAND(核验) | OCC daemon 在 `feature("DAEMON")` 门控（cli.tsx:216）；`daemon.ts` 内未见这些子命令字面量 → 先盘点 OCC daemon 子命令集再定 |
| 13 | 文件读失败后 footer agent 计数 | CAND | PromptInputFooter 面存在 |
| 14 | 自定义 agent "worker" 显示为 "Agent" | CAND | 小 UI fix |
| 15 | Artifact transcript 行 "(unprintable path)" | N/A(核验) | OCC 仅 ReviewArtifactTool，无 Artifact 云发布 |
| 16 | /ultrareview 上传在 Linux 拒绝（嵌套 checkout；sandbox 中 settings 解析失败） | CAND | OCC 有 `cli/handlers/ultrareview.ts` + `commands/review/ultrareviewCommand.tsx` + `services/api/ultrareviewQuota.ts` |
| 17 | /ultrareview split-index 建议的 git 命令 | CAND | 同上 |
| 18 | RC/cloud 长会话流式 | N/A | 无 cloud sessions；OCC RemoteControl 是 daemon 绑定，不同物 |
| 19 | RC 凭证恢复后重传起始历史 | N/A | 同上 |
| 20 | PushNotification "Remote Control inactive"（claude remote-control 期间） | CAND(核验) | OCC cli.tsx:170 有 `remote-control` 参数分支 → 核验 PushNotificationTool 门控是否同病 |
| 21 | mod-hook worker 重启跳过 `classic.*` | N/A | 无 mods |
| 22 | `claude plugin test` `$.session.append`/mock.session | N/A | 无 plugin test 命令 |
| 23 | `claude plugin eval` Docker Desktop 链接拒绝 | N/A | 同上 |
| 24 | Claude apps gateway desktop policy | N/A | — |
| 25 | `claude agents` bypassPermissions consent（settings.local.json/--settings） | CAND(核验) | 需先盘点 OCC agents 命令面 |
| 26 | ← 时未发送文本/挂起问题 → 10 秒转后台 | CAND | `teleport.tsx` line ~1244 恰有 `timeout:10000` → 强候选，取证对齐 |
| 27 | ← 之后 permission prompt Esc/No 不停止 turn | CAND | teleport 簇 |
| 28 | agents 视图文件夹读失败留下 placeholder 行 | CAND | daemon agents 视图 |
| 29 | path-scoped rules；单文件 `cat`/`head`/`tail`/`sed -n`/`grep` Bash 读取不加载嵌套 CLAUDE.md | **CAND(P2 靠前)** | 安全相邻（规则作用域）；OCC 有 instruction-file 加载链 → 需取证官方判定点 |
| 30 | 粘贴首尾重复词被当作已键入发送 | CAND | paste 簇；293 新增串中含 paste-dedup 代码段（pastedContents 相关）→ 官方新实现已在 ELF 中，可提取 |
| 31 | 粘贴时 skill 名重音符号融合 | CAND | paste 簇；OCC `components/PromptInput/inputPaste.ts` |
| 32 | /feedback Ctrl+O/Ctrl+Z 后恢复 | CAND(核验) | OCC Feedback 面存在；确认终端语境是否受影响 |
| 33 | `claude purge` 无法删时静默停止 → 删其余、列出、exit 1 | VERIFY | OCC `cli/handlers/projectPurge.ts:183` 已有 `process.exit(1)` → 核验"继续删其余+列出不可删"行为是否一致 |
| 34 | keybindings：单个 `" "` 不再报错；`"ctrl+ k"` 给 warning | CAND | OCC `src/keybindings/validate.ts` ~176-255 有 space-vs-plus 逻辑 → diff 行为对齐 |
| 35 | vim `>>`/`<<` 在纯空白行 | CAND | OCC `src/vim/` 完整引擎（types.ts indent `dir:'>'|'<'`） |
| 36 | vim `V`-`d` 光标位置 + `.` 重复整行 | CAND | 同上 |
| 37 | Windows statusline/hook/shell PID 竞争 | WIN | OCC Linux/macOS-first |
| 38 | Revert 2.1.281 auto-mode denial 文案 | VERIFY(no-op 倾向) | OCC 无该文案（"covers the outcome" 0 hits）→ 大概率未移植过，核验后记 no-op |
| 39 | Revert 2.1.290 cloud-session sleep 修复 | N/A | 无 cloud sessions |
| 40 | Team/Enterprise 启动：更早取 policy + 3 秒 stall 重试 | CAND | OCC 有 managed/policy settings 面（managedEnvConstants 等）→ 需取证 |
| 41 | Claude in Chrome 更少因 tab 报慢而拒绝 | N/A | 无 Chrome 扩展集成 |
| 42 | cloud sessions 中 Chrome 消息改进 | N/A | — |
| 43 | Bash 编辑 diff 备注措辞（"changed while the command ran"） | CAND(核验) | OCC 未见该备注文本 → 若整个 feature 未移植则归入其母特性，不单独做 |
| 44 | artifact 固定到 >2 周前精确版本 | N/A | artifact 云 |
| 45 | skill 同步 40 分钟 | N/A | — |
| 46 | agent 列表 + MCP server 公告：非 ASCII 排在 ASCII 后 | CAND | 确定性小改，易对齐 |
| 47 | OTel at_mention 上限 100+100 | CAND(structural) | OCC analytics 是 stub → 只做结构对齐 |
| 48 | self-hosted runner 轮询 4-6s 抖动 | N/A | 无 self-hosted runner |
| 49-55 | [Claude Tag] ×7 | N/A | occ149 先例：Claude Tag 全线 N/A |
| 56 | [Code Review] add-repo 对话框 | N/A | 无 Code Review 云面 |

小结：1 PORT（Haiku 5.5）+ ~22 CAND（含 3 条 VERIFY 型核验）+ ~30 N/A / WIN / dormant。

## §4 STAGED 结转（来自 OCC-149 ledger）

- **#018 WebFetch 100k reader+offset**：取证 70%；未解析 helper 集 `INe/ZK/Xl/ne/zJn/pqt/xeo/m1e/cX/Ve`、summarizeRemainder prompt、call-site gating —— 清单在 occ149 §8，先补完取证再动码。
- **#148** skills/custom-commands `!` 原始控制字符拒绝。
- OCC-109 STAGED 清单。
- npm `E404` carry-over（occ149 §9.6 记录，release 时留意）。

## §5 移植轮执行顺序（给 OCC 程序员）

1. **重新下载**三版 ELF（勿复用他人工作目录的二进制），核对 §0 md5；只跑授权 A/B，不执行官方二进制之外的东西。
2. P0 安全批：UNC PreToolUse/auto-mode 绕过 → 2.1.294 hook 判定（专项逐站点反编译 `execPromptHook`/`execAgentHook` 对应官方站点）→ 其余三条 2.1.292 安全修复（先面核验再移植）。
3. P1：Haiku 5.5，用 §2 逐字数据；live 对照 `npx @anthropic-ai/claude-code@2.1.293` 行为核验（默认模型、pricing 显示、fast-mode gate、3P fallback）。
4. P2 按簇：teleport/← 簇（#6/#26/#27）→ paste 簇（#30/#31）→ vim 簇（#35/#36）→ keybindings（#34）→ MCP HTTP 泄漏（#5）→ 非 ASCII 排序（#46）→ purge/daemon/revert 核验（#33/#12/#38）→ CLAUDE.md 单文件 Bash（#29）→ 其余 CAND 视取证成本取舍。
5. P3：#018 → #148。
6. 每项配测试 + git-stash A/B 零回归 + Docker e2e A/B + live smoke（headless `-p` + tmux REPL），照历轮惯例；完成后走 release：tag `v2.1.375` → publish.yml（build → npm publish → gh release create，幂等，无 --target）→ 校验 /releases ≡ /tags → 回帖汇报。
7. 交接链：程序员完成 → @安全审查员（后门检查）→ @验收员（对齐/合并/分支清理核验 + 通知程序员发版）→ Leader 汇总 + lark 汇报 + issue 置 done。

## §6 调研工件

- 本轮 Leader 工作目录内：三版 tgz/ELF、`s29{2,3,4}.txt`（strings 全量）、`u29{2,3,4}.txt`（排序去重）、`added/removed29{3,4}.txt`（comm 差分）、官方 `CHANGELOG-official.md`（8561 行，raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md）。工作目录为运行时本地、随 run 销毁 —— 移植轮**必须自行重新下载**（skill 纪律），本文所有 md5/计数即为其校验基准。
