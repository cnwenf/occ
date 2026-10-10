# Upstream Version Gap — OCC-153 (2026-10-10 round)

轮次定位：官方 `latest` 已晋升 **2.1.295**（2026-10-08T18:22Z 发布，**143 条 changelog —— 史上单版最大之一**，上一轮 occ150 已对 293/294 收口），`next` = **2.1.296**（2026-10-09T16:58Z 发布，**无 changelog 段**）。OCC main（HEAD `45d8388`，package version `2.1.377`，README badge "Now tracking Claude Code 2.1.294"）→ **本轮 gap = 2.1.295 全量移植 + 2.1.296 next-only 建档**。调研由 Leader 按 `upstream-tracking` / `aligning-with-official-binary` skill 纪律完成：所有二进制侧断言给出可复现取证数字；未逐站点取证的一律标 needs per-site forensics，**Never invent**。

## §0 版本事实（three-way verified：npm dist-tags × 发布时间 × ELF 取证）

npm dist-tags（2026-10-09T17:0xZ 核查）：`latest=2.1.295`，`next=2.1.296`，`stable=2.1.286`。
发布时间（`npm view time`）：2.1.294 = 2026-10-08T03:42Z（上轮已移植）；2.1.295 = 2026-10-08T18:22Z；2.1.296 = 2026-10-09T16:58Z。

| version | ELF bytes | md5 | 自身版本标记数（raw bytes / strings 行） | 备注 |
|---|---|---|---|---|
| 2.1.294 | 252,755,128 | `66d0b5080c038991d342e1e0594d21c7` | 2564 / 150 | **md5 与 occ150 ledger §0 一致 —— 证据链不断** |
| 2.1.295 | 256,113,848 | `4f067be625a3fc99f1c76a563d14cfdb` | 2629 / 149 | 较 294 **+3,358,720 B —— 实打实逻辑增量**（对比 293↔294 同尺寸重打包） |
| 2.1.296 | 257,068,216 | `3c8749470f70a26efadf982b587e1548` | 2644 / 153 | next-only，无 changelog，本轮只建档 |

`strings -n 8 | sort -u` 全量集合差分：
- **294→295：added 20,182 / removed 17,060**（unique 行；s294=315,636，s295=318,758）—— 非对称，真实变化叠加重打包噪声。
- **295→296：added 17,942 / removed 16,806**（s296=319,894）—— 非对称、量级大；无 changelog 对照无法安全分诊 → **顺延下轮**（惯例：next-only 不移植；occ150 轮对 294 的处理同款）。

官方 CHANGELOG 快照：8,707 行（raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md）；`## 2.1.295` 段 = 第 3–148 行 = **143 条**；`## 2.1.296` 段不存在。

OCC 侧现状：`@cnwenf/occ` npm latest = **2.1.367**（E404 事故，OCC-151 blocked，等 owner 轮换 NPM_TOKEN）；GitHub tags=176 / releases=175，唯一缺口 = `v2.1.377`（npm 补发载体，OCC-151 解锁 re-run 后由 publish.yml 幂等补 Release 条目）。

## §1 本轮优先级队列（port round queue）

**P0 安全批（4 条）**：#031 conceal/色彩残留隐藏文本链接地址、#050 raw terminal hyperlink 字节 → 可点击隐藏地址链接（OCC-109 `ad()` 转义族直接相关）、#073 server-managed settings 缓存篡改 → 个人 plugin 被计为 org-managed（提权面）、#076 tabs/bidi 控制字符行尾丢失/覆写邻行（Trojan-source 渲染面）。

**P1 正确性/安全加固批（25 条）**：#001 hooks `onFailure:"block"`、#014 `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`、#016 `[1m]` beta 被拒自动重发、#017 `-p` 多轮丢前轮输出、#018 MCP 远程重连退避≤30s、#019 MCP 错误回复含网络错误名误断连、#022 Bash `command_description` 别名、#026 AUTO_BACKGROUND 与排队 edit/shell 竞态、#035 linked-worktree subagent 误用父会话 git 上下文、#037 `--tools`/`--restricted` 漏延迟注册 built-in + deprecated 名越集、#044 bash for-loop glob 权限精度、#056 万行响应冻结且 ctrl+c 失灵、#061 `cat` 无输出仍标记已读（**直接修正 293 轮 bashReadCommands.ts 移植**）、#067 嵌套引用冻结+GB 级内存、#070 async SessionStart 未变 context 每次 resume 重注入、#071 `CLAUDE_ENV_FILE` 变量 /resume//branch 后不达 Bash、#072 skill `allowed-tools`/`effort` 在流结束前完成时被丢弃 → `-p` 拒绝 skill Bash、#078 async hook 多行 JSON 输出被忽略、#088 Edit 内容变了但 mtime 未前进 → 误判已读（stale-read 防护）、#090 scheduled task rewind/resume 丢失/复活、#091 语法高亮冻结（超长行/空行连/未闭合 heredoc）、#095 /rewind 后 prompt 丢失 + turn 复活、#108 Grep 接受 `-l`/`-c`/`-r`、#112 tool-search MCP 描述 cap 2048→16384、#124 ws MCP >16MiB 直接断连（DoS；OCC `maxPayload` 0 命中 → 疑似真缺口）。

**P2（44 条）/ P3（26 条）**：见 §3 表；本轮按性价比取舍，未消化的记 STAGED 结转下轮。
**N/A（44 条）**：Gateway/VSCode/Slack/Cloud/Runner/Chrome/CodeReview-action 七族 + MODS-runtime 专有条目 + #092 seed-admin（OCC 0 命中，occ150 §7.3 已证 NO-OP）。

## §2 新增 env/token 取证（294→295，token 集合差分，已排除 minify 邻接噪声）

真实新增 token（9 组）+ v295 ELF 首见字节偏移（python `mmap.find`，可复现；dd 取证用）：

| token | offset | 关联 |
|---|---|---|
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` | @99966792 | #014（P1） |
| `CLAUDE_CODE_SLEEP_COMPACT` | @95416468 | 无 changelog —— 隐藏特性，侦察 |
| `CLAUDE_CODE_SUBAGENT_CONFIG_WARNING` | @93815440 | 无 changelog —— 疑与 #113 相关，侦察 |
| `CLAUDE_CODE_WEBSEARCH_CITATIONS` | @95578280 | 无 changelog —— 侦察 |
| `CLAUDE_SESSION_SURFACE` | @104922062 | 无 changelog —— 侦察 |
| `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` | @94550008 | 无 changelog —— 疑与 #037/#073 相关，侦察 |
| `CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST` | @95417452 | 无 changelog —— host 面，侦察 |
| `CLAUDE_CODE_DISABLE_BG_STABLE_PATH` / `CLAUDE_PTY_HOST_NO_STABLE_PATH` | @93309560 / @93301896 | 无 changelog —— pty/bg stable path，疑与 #097 相关 |
| `CLAUDE_RUNNER_FETCH_SERVER_PROGRESS_CAP_MS` | @97829376 | #130（runner 专用，N/A） |

字符串计数佐证：`command_description` **0→3 命中**（#022 新别名，@99517632）；`7501` 3→7（#002 OSC 7501）；`onFailure` 48→55 行（#001）；`context-1m` 3→5（#016）；`upstream_ttfb_ms` 3→7（#006 gateway）。消失 token：`CLAUDE_CODE_ARTIFACT_FIVE_CLASS_ASKS`、`CLAUDE_CODE_INTRO_FRAME`（artifact 族面复核参考）。

**OCC 侧 grep 实证（main @45d8388）**：`onFailure`=0、`7501`=0、`command_description`=0、`maxPayload`=0、`seed-admin`=0 → #001/#002/#022/#124 为真缺口、#092 N/A 确认。已有面：`RETRY_WATCHDOG`（withRetry.ts）、`context-1m`（bootstrap/state.ts 等）、`CLAUDE_ENV_FILE`（sessionEnvironment.ts/hooks.ts）、`allowed-tools`（SkillTool）、`DEFAULT_MAX_MCP_DESCRIPTION_LENGTH = 2048`（services/mcp/client.ts:292 → #112 改的是 tool-search 路径 cap）、plugin hooks（utils/plugins/loadPluginHooks.ts，仅薄层）。

**产品面宽度普查**（grep -rlE 文件数）：worktree 121、mcpServe 62、WebSocket 55、rewind 45、remoteControl 44、advisor 40、Fable 36、toolSearch 31、cron/ScheduledTask 24、ultrareview 24、tui 18、Artifact 11、vim 11、/copy 10、autoBackground 9、PushNotification 2、loopWakeup 2。**结论：OCC 产品面很宽 —— 只有七大分发面族（Gateway 服务端/VSCode 扩展/Slack/Cloud web/Runner/Chrome 扩展/CodeReview action）与 mods-runtime 专有机制可整族 N/A，其余一律逐项 verify，不许整族拍 N/A。**

## §3 2.1.295 changelog 逐条 triage（143 条）

处置代号：P0/P1/P2/P3 = 本轮优先级；PORT = OCC 面已证 0 命中的真缺口可直接排移植；CAND = 候选（面已证存在）；CAND-v = 需先核验 OCC 对应面；N/A-x = 族级无面。

| # | 处置 | 摘要 |
|---|---|---|
| 001 | P1-PORT | hooks `onFailure:"block"`：起不来/超时/异常码 → block 而非放行（OCC 0 命中） |
| 002 | P2-PORT | OSC 7501 Program Status Protocol（working/waiting/done 终端状态；OCC 0 命中） |
| 003 | P3-CAND | /copy picker 引文去 `>` 标记 |
| 004 | P2-CAND | plugin install/enable/disable/marketplace add：settings 文件不加载时告警 |
| 005 | P2-CAND | `claude -p` 末轮后仍挂着时 stderr 说明在等什么 |
| 006 | N/A-GATEWAY | `timeouts.upstream_ttfb_ms` gateway 云上游 |
| 007 | P3-CAND | "Backgrounding cancelled" 提示 |
| 008 | N/A-GATEWAY | upstream `models` 列表 + `*` 通配 |
| 009 | N/A-GATEWAY | `forceLoginMethod:"gateway"` + `forceLoginGatewayUrl` |
| 010 | P3-CAND | plugin validate README 缺 install-line 建议（不改 exit code） |
| 011 | N/A-GATEWAY | `upstream_request_id` 审计事件 |
| 012 | N/A-MODS | `$.ui.notify` |
| 013 | N/A-MODS | mod Button children |
| 014 | P1-PORT | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` 限制无人值守重试等待（token @99966792） |
| 015 | N/A-GATEWAY | 成功推理响应 `request-id` 头 |
| 016 | P1-CAND | `[1m]` 模型 beta 被 gateway/Bedrock/Vertex/Foundry 拒 → 去 beta 重发 |
| 017 | P1-CAND | `-p` 文本输出：bg 工作开启新轮时不再丢前轮响应 |
| 018 | P1-CAND | 远程 MCP headless/SDK：>15s 故障后不再永久断连；紧循环重连退避≤30s |
| 019 | P1-CAND | MCP 错误回复恰含网络错误名 → 不再误断连 |
| 020 | P2-CAND | MCP 分页 cursor 重复 → 同页最多问 20 次 |
| 021 | P2-CAND-v | MCP 返回 CSS/JS/XML 不再存成 .bin（Read 拒读）；font/icon 独立扩展名 |
| 022 | P1-PORT | Bash 模型传 `command_description` 不再失败（0→3 命中 @99517632） |
| 023 | N/A-CHROME | `host:80` deny 规则适用 plain http |
| 024 | P3-CAND-v | /plugin Errors tab Enter 删 marketplace 先询问 |
| 025 | P2-CAND | marketplace add：名字装不了任何 plugin → 拒绝而非报成功 |
| 026 | P1-CAND | `CLAUDE_AUTO_BACKGROUND_TASKS`：edit/shell 在排队时不把 subagent 送 bg（会提前起跑） |
| 027 | P2-CAND-v | PushNotification 在 remote-control 会话误报 "not sent" |
| 028 | P2-CAND-v | remote 会话 >256 文件 vouch 拒绝 |
| 029 | P2-CAND-v | login refresh 后 managed settings 启动加载偶发失败 |
| 030 | P2-CAND | /tui 无法重启时不再无提示/raw error 退出 |
| 031 | **P0-CAND** | 回复残留色彩/conceal 样式隐藏文本链接地址（含表格/问题预览换行处） |
| 032 | P2-CAND-v | gateway 会话 Fable `availableModels` → /model picker 内置行优先于 modelPicker 行 |
| 033 | N/A-GATEWAY | admin spend view 陈旧 groups/cap |
| 034 | N/A-GATEWAY | `DISABLE_NONESSENTIAL_TRAFFIC` vs gateway spend limit 显示 |
| 035 | P1-CAND | linked-worktree subagent 不再显示父会话 git branch/status/commits |
| 036 | P2-CAND | 打字取消 backgrounding → 前台继续干活（不再停在当前 tool 末尾） |
| 037 | P1-CAND | `--tools`/`--restricted` 对 launch 后注册的 built-in 生效 + deprecated 名不达集外 tool |
| 038 | P2-CAND | 等 MCP resource list 时 interrupt 不再拖到超时才结束 turn |
| 039 | P2-CAND-v | hook 深嵌套 tool input 静默截断 → guard 可能放行未见内容 |
| 040 | P2-CAND-v | Esc 停不掉被 ← 移到 bg 的自定步 /loop；取消 pending wakeup 给提示 |
| 041 | P2-CAND | bg 会话 commands/hooks 继承 `FORCE_COLOR=3` → 输出混入色码 |
| 042 | P3-CAND-v | `claude agents` 退出时不再拉起新 bg service |
| 043 | P3-CAND | 自定义 agent 名 `worker` 不再显示成 "Agent" |
| 044 | P1-CAND | bash for-loop over glob patterns 权限检查精度 |
| 045 | P2-CAND-v | Workflow subagent 的 forked skill 结果误投主对话 |
| 046 | P2-CAND-v | in-process teammate 首次 SendMessage 失败（tool search 未加载） |
| 047 | P3-CAND | resume 提示不再归因 `TaskStop`（不可能是该因） |
| 048 | P3-CAND-v | 从 tasks panel/客户端停长 MCP 调用时要告知 Claude |
| 049 | P2-CAND-v | bg 会话进程 down 时到点的 /loop wakeup 不再无声丢失 |
| 050 | **P0-CAND** | raw terminal hyperlink 字节被画成可点击+隐藏地址链接（OCC-109 `ad()` 转义族直接相关） |
| 051 | P2-CAND | marketplace 大 git submodule 仓库 add/refresh 失败 → 只 fetch 含 plugin 的 submodule |
| 052 | P3-CAND | /advisor 对不可用已存模型不再打勾，开在 "No advisor" |
| 053 | P3-CAND | bg MCP tool 通知不再显示缩短 task id |
| 054 | P2-CAND | vim `~` 越过 EOL（后续 `x` 空转）+ `3~` 冲进下一行 |
| 055 | P2-CAND | macOS 重音文本（NFD）粘贴到 prompt 中部光标多偏一格 |
| 056 | P1-CAND | 万行级响应终端冻结且 ctrl+c 失灵 |
| 057 | P2-CAND-v | mod reload 期间调用绕过另一 mod 带 `.catch` 的 guard hook（worker 重启窗口） |
| 058 | P2-CAND-v | hooks 模块嵌套数千层 → 加载/校验裸 stack-overflow |
| 059 | P3-CAND-v | `claude plugin test` 放行会删 tool call/result/thinking 块的 `session.append` hook |
| 060 | P2-CAND-v | kill+二次 resume 后不再提示可用 SendMessage 恢复 bg subagent |
| 061 | P1-CAND | `cat` 等无输出仍标记文件已读（**直接修正 293 轮 bashReadCommands.ts 移植**） |
| 062 | P2-CAND-v | plugin option 名 `constructor`/`prototype` 恒读默认值且编辑不重载 |
| 063 | N/A-MODS | hot-reload 读取窗口期 save 丢失 |
| 064 | N/A-MODS | hot-reload 询问每轮重复 |
| 065 | P2-CAND-v | /model /fast /output-style 保存设置未询问 plugin `config.set` hook |
| 066 | P3-CAND | piped 输出 bold 紧跟 dim 画得微弱 |
| 067 | P1-CAND | 引用逐层嵌套回复 → 冻结数秒 + GB 级内存 |
| 068 | N/A-MODS | hot-reload 毫秒级 save 丢失 |
| 069 | P2-CAND | `claude mcp serve` bg Bash 结果不报输出文件名 + 描述承诺不来通知 |
| 070 | P1-CAND | async SessionStart hook 未变 context 每次 resume 重复注入 |
| 071 | P1-CAND | SessionStart 写入 `CLAUDE_ENV_FILE` 的变量在 in-app /resume//branch 后不达 Bash |
| 072 | P1-CAND | Skill tool 在响应流结束前完成 → `allowed-tools`/`effort` 被丢 → `-p` 拒绝 skill 的 Bash |
| 073 | **P0-CAND-v** | server-managed settings 缓存被篡改 → 个人 plugin 计为 org-managed（提权面；需核 OCC managed-settings/plugin provenance） |
| 074 | P2-CAND | Claude 3 Opus/3.x Sonnet 会话不再被提供 tool search（模型会拒） |
| 075 | P3-CAND-v | `-p`/SDK 会话不再把生成类型文件写进 `--plugin-dir` |
| 076 | **P0-CAND** | tabs/bidi 控制字符文本行尾丢失或覆写邻行（Trojan-source 渲染面） |
| 077 | P3-CAND | /model Max effort 误报 "已存为默认"（Max 仅当前会话） |
| 078 | P1-CAND | async hook JSON 输出跨多行打印时被忽略（OCC hooks.ts:6529 单 `JSON.parse(trimmed)` 站点需核） |
| 079 | P2-CAND | Read 空 `pages` 参数按省略处理而非拒绝（**直接修正 292/294 轮 strict pages parser 移植**） |
| 080 | N/A-VSCODE | Windows drive-letter 大小写 project-scope plugins（#74612） |
| 081 | P3-CAND | Windows 盘符大小写 → plugin install/uninstall 记录丢失/重复 |
| 082 | P2-CAND-v | `←` 后立刻 `↑`/`Esc` 收回 queued message 丢失 |
| 083 | N/A-MODS | SDK host 提前关 enable 问题 → 整会话 hot-reload 关闭 |
| 084 | N/A-MODS | `prompt.submit` 改写/丢弃后仍按原文存 history/queued 记录 |
| 085 | P2-CAND | 非交互会话：请求未用到的 MCP server 不再提示需认证 |
| 086 | N/A-GATEWAY | `claude_code.auth` OTEL gateway sign-in |
| 087 | P2-CAND-v | 巨型 interface plugin 在 worker stall 时把别的 plugin 卸载 |
| 088 | P1-CAND | Edit：内容变了但 mtime 未前进 → 仍当已读（stale-read 防护） |
| 089 | P2-CAND | CRLF 短命令输出被画成单行 |
| 090 | P1-CAND | scheduled task：停掉的任务 rewind+resume 复活；Esc/rewind+compaction 后 resume 丢失 |
| 091 | P1-CAND | 语法高亮冻结数秒~数分钟：超长行/长空行连/未闭合 string/heredoc |
| 092 | N/A | `~/.claude/seed-admin` 临时文件保留清理（OCC 0 命中；occ150 §7.3 已证 NO-OP） |
| 093 | P2-CAND-v | Desktop/SDK：`disableAutoMode` 移除后拒绝切回 auto mode 直至重启 |
| 094 | P2-CAND-v | claude.ai-synced plugin hooks 长会话 "Plugin directory does not exist" |
| 095 | P1-CAND | /rewind 后发送的 prompt 丢失 + 被移除 turn 复活（bg 移动/kill 后 resume） |
| 096 | N/A-CLOUD | mod `session.receive` hook 权限询问挂起 cloud 会话 |
| 097 | P3-CAND-v | macOS 更新后 bg 会话重启跑出 stable app wrapper（疑关联 `CLAUDE_PTY_HOST_NO_STABLE_PATH` 新 token） |
| 098 | P2-CAND-v | headless/SDK 迟到 sign-in/reconnect 把 `setMcpServers()` 服务集重列成自己的 |
| 099 | P2-CAND-v | /config auto-update channel 保存前未询问 plugin `config.set` hook |
| 100 | P2-CAND-v | macOS 会话启动 file count 触及其他 app 数据 → 隐私弹窗（home 及以上目录启动时） |
| 101 | N/A-GATEWAY | Bedrock CountTokens API |
| 102 | N/A-GATEWAY | PostgreSQL read-only 30s 告警 |
| 103 | P3-CAND-v | RC/claude.ai/desktop 等待状态：MCP tool 用 server+可读名而非 `mcp__server__tool` |
| 104 | N/A-GATEWAY | gateway 后台请求用 Haiku 4.5 |
| 105 | N/A-GATEWAY | Bedrock 非 US 区 models 处理 |
| 106 | P3-CAND | headless `rate_limit_event` 说明是否开了 extra usage |
| 107 | P3-CAND-v | `plugin-authoring` 内置 skill 改进（无终端会话不给终端命令） |
| 108 | P1-CAND | Grep 带 `-l`/`-c`/`-r` flag 的搜索直接跑而非失败 |
| 109 | P3-CAND | plugin validate：hooks 顶层 `var` 重绑报错带行号+原因+修法 |
| 110 | P3-CAND | Workflow `scriptPath` 拒绝文案 → 指路 inline `script` |
| 111 | P3-CAND-v | 大文件上传失败无因 → Claude 报告失败而非缩文件 |
| 112 | P1-CAND | tool-search 加载的 MCP tool 描述 cap 2048→**16384**（OCC client.ts:292 = 2048；核官方是否只改 tool-search 路径） |
| 113 | P2-CAND | subagent `skills` 字段预载 ≤32 个、各一次 |
| 114 | P3-CAND-v | attached bg 会话 idle Ctrl+C 不动 pending /loop wakeup（双击 detach、loop 续跑） |
| 115 | P3-CAND-v | `claude agents` 与 bg service 同停：会话约 1 分钟内停 + 提示 |
| 116 | P2-CAND-v | claude.ai connectors 默认协商 MCP `2026-07-28` + `MCP_PROTOCOL_NEGOTIATION=legacy`（两版字符串同计数 6/6 —— 疑文档迟录，需 per-site） |
| 117 | P3-CAND-v | Artifact 无背景页白底（疑 cloud viewer 侧） |
| 118 | N/A-MODS | mod 跑后拒绝 tool call 的措辞 |
| 119 | P2-CAND | tab stops 从文本起点计（indent 2 → 首 stop 8 列） |
| 120 | P2-CAND-v | Artifact tool telemetry-off 权限提示统一为五问 |
| 121 | P3-CAND-v | telemetry-off 安装：scheduled/Run-now 发布私有 artifact 免询问 |
| 122 | N/A-MODS | org mods toast 优先 |
| 123 | N/A-GATEWAY | `desktop` policy key 启动告警 |
| 124 | P1-CAND | ws MCP >16MiB 消息不解析直接断连（OCC `maxPayload` 0 命中 → 疑似真缺口，DoS 面） |
| 125 | N/A-VSCODE | 文件行点击打开 |
| 126 | N/A-VSCODE | fork/rewind "Message not found in session" |
| 127 | N/A-VSCODE | 快捷键误切 permission mode |
| 128 | N/A-VSCODE | 双视图焦点跳动错投输入 |
| 129 | N/A-RUNNER | 停传 `CCR_AUTO_MODE_*` 三 env |
| 130 | N/A-RUNNER | git fetch progress cap（`CLAUDE_RUNNER_FETCH_SERVER_PROGRESS_CAP_MS`） |
| 131 | N/A-CLOUD | unarchive 后首条消息无回复 |
| 132 | N/A-CLOUD | 旧 routines 不递 saved prompt |
| 133 | N/A-CLOUD | 断线追赶一次性渲染 |
| 134 | N/A-CLOUD | setup script 输入框 UI |
| 135 | N/A-SLACK | settings 确认卡 30 分钟 |
| 136 | N/A-SLACK | Enterprise Grid 共享频道通知限频 |
| 137 | N/A-SLACK | fork 线程卡 raw Slack codes |
| 138 | N/A-SLACK | Working status 空转 |
| 139 | N/A-SLACK | busy channel 他 bot @Claude 无应答 |
| 140 | N/A-SLACK | channel manager 添加确认 |
| 141 | N/A-CODE-REVIEW | re-review open findings 计数 |
| 142 | N/A-CODE-REVIEW | 大 CLAUDE.md 被 PR 编辑时规则跳过 |
| 143 | P2-CAND-v | `xhigh`/`max` effort 下 web search + agent hook 评估显著变慢 |

**统计**：P0=4，P1=25，P2=44，P3=26，N/A=44（GATEWAY 13 / MODS 9 / SLACK 6 / VSCODE 5 / CLOUD 5 / RUNNER 2 / CODEREVIEW 2 / CHROME 1 / seed-admin 1）——合计 143 ✓。

## §4 2.1.296（next-only）建档

发布 2026-10-09T16:58Z，无 changelog 段；ELF md5 `3c8749470f70a26efadf982b587e1548`，257,068,216 B；vs 295 strings 差分 added 17,942 / removed 16,806（非对称，含真实变化）。**处置：顺延下轮**（changelog 落地或晋升 latest 后再逐站点取证）。侦察线索留给下轮：新 token 差分、`CLAUDE_CODE_SLEEP_COMPACT` 等 §2 无 changelog token 是否在 296 有对应条目。

## §5 结转债务（本轮账本内跟踪）

1. **occ150 §4/§8.4 STAGED**：#018 WebFetch 100k reader+offset（取证 70%，helper 集清单在 occ149 §8）、#148 skills/custom-commands `!` 原始控制字符拒绝、OCC-109 STAGED 清单、occ150 P2 簇（teleport/←、paste、vim、keybindings、MCP HTTP 泄漏等 —— 与本轮 §3 P2 部分重叠，合并处理）。
2. **OCC-111 验收 APPROVED_WITH_RISK 的 7 项 findings**（见 OCC-111 验收评论）—— 若前两轮未消化，本轮验收员复核。
3. **npm E404（OCC-151 blocked）**：`NPM_TOKEN` 90 天过期（2026-07-05+90d≈10-03），等 owner 人类轮换。**对本轮的影响：发版时 publish.yml 会在 npm publish 步红 —— 预期内、非本轮回归**；GitHub Release 步骤因 `if: success()` 不会跑 → **tag 后需手动 `gh release create <tag> --generate-notes`（幂等）**。`v2.1.377` 载体 tag 保持无 Release 现状（OCC-151 解锁 re-run 后由 workflow 幂等补齐），当前 tags=176/releases=175 唯一缺口即此，验收口径按此调整。
4. **`agent/occ/01bb1c9b` 分支**保留至 npm 补发完成后由程序员处置（occ150 验收意见）。

## §6 移植轮执行顺序（给 OCC 程序员）

1. **重新下载** 294/295（如需 next 对照再下 296）ELF —— 勿复用他人工作目录二进制；核对 §0 md5；只跑授权 A/B，不执行官方二进制。取证工具：`strings -n 8 | sort -u` + `comm`；字节站点 python `mmap.find`（grep -boF 对 256MB 无换行 blob 会静默失败，本轮已踩坑）→ `dd bs=1 skip=OFFSET count=N`。
2. **P0 安全批 4 条**（#031/#050/#076 渲染安全簇可并案取证 —— 同属输出净化/转义面；#073 先核 OCC managed-settings/plugin provenance 面再定 PORT/NO-OP）。
3. **P1 25 条按簇**：hook 簇（#001/#078/#070/#071/#072）→ MCP 簇（#018/#019/#112/#124）→ 冻结/DoS 簇（#056/#067/#091）→ 权限/stale-read 簇（#037/#044/#088/#061）→ headless/model（#017/#016/#022/#014）→ 会话状态簇（#026/#035/#090/#095/#108）。
4. P2/P3 视取证成本取舍；未消化项在本账本追加新 § 记 STAGED，不许静默丢弃。
5. 每项配测试 + 全量 git-stash A/B 零回归 + Docker e2e A/B + live smoke（headless `-p` + tmux REPL 真实模型 round-trip）。
6. **发布**：合 main → version bump（2.1.378 起，若被并行轮抢占则顺延）→ CHANGELOG + README badge（Now tracking 2.1.295）→ tag `v2.1.378` → publish.yml npm 步**预期红**（OCC-151，不算回归）→ 手动 `gh release create v2.1.378 --generate-notes`（幂等）→ 核验 /releases ≡ /tags（残留缺口应仍只有 v2.1.377）→ 回帖汇报（含 /releases 总条目数 + Release 链接，按发版流程第 5 条）。
7. **交接链**：程序员完成 → 评论 @OCC 安全审核员（后门检查，重点 P0 渲染安全簇 + #073 提权面）→ @OCC 验收员（对齐/合并/分支清理 + 像人类用户一样真实使用 REPL/uvx 一致性；通过后通知程序员发版收口）→ Leader 汇总 + lark 汇报 + issue 置 done。

## §7 调研工件与复现方法

- 本 run 工作目录 `/tmp/cc-diff-295`：tgz×3（294/295/296）、`v29{4,5,6}/package/claude`、`s29{4,5,6}.txt`（strings 全量排序去重）、`added295.txt`/`removed295.txt`（comm 差分）、`envtok29{4,5}.txt`（token 集合）。**本 run 结束即销毁（skill 纪律：二进制不留 /tmp）** —— 移植轮必须自行重新下载，§0 md5/计数即校验基准。
- 官方 changelog 快照 `/tmp/cc-CHANGELOG.md`（8,707 行）同源销毁；来源 URL 见 §0。
- 复现命令：`npm pack @anthropic-ai/claude-code-linux-x64@<ver>`；`md5sum`；`strings -n 8 <elf> | sort -u`；`comm -13/-23`；token 差分 `grep -ohE '\bCLAUDE_[A-Z0-9_]{3,}\b' | sort -u` 后 comm。
## §8 STAGED（本轮结转）+ 落地清单

本轮取证预算集中于 P0 渲染安全四件套 + 15 条可 binary-verify 的 P1 站点（每站点官方 ELF 逐字节取证 + 测试落地）；深子系统 P1（10 条）与其余 P2/P3 未做逐站点取证，按 §6.4 no-silent-drop 纪律全部显式结转，下轮按 §6.1 重新下载 ELF 复核。Never-invent：无二进制证据的站点一律 STAGED，不猜测、不部分认账。

### §8.1 本轮已落地（39 条 = P0 4 + P1 15 + P2/P3 20；commits ce6184a+6270e7a+c47976c+d242c13，range 0004682..d242c13）

| item | prio | evidence |
|---|---|---|
| #031 conceal/色彩残留隐藏链接地址 | P0 | `utils/hyperlink.ts` `SHOWN_URL_NEUTRALIZER` + `concealLinkSanitize295.test.ts` |
| #050 raw hyperlink 字节→可点击隐藏地址 | P0 | `utils/stripRawHyperlinks.ts` + `stripRawHyperlinks295` / `rawHyperlinkSanitize295` 测试 |
| #073 managed 缓存篡改→个人 plugin 计 org | P0 | `plugins/managedPlugins.ts`（+`pluginIdentifier.ts`/`mcpbHandler.ts`）+ `managedPluginsVouching295.test.ts` |
| #076 tabs/bidi 行尾丢失/覆写邻行 | P0 | `ink/normalize-text.ts` tab 预展开 + `tabsBidiEol295.test.tsx`；bidi NO-OP-PINNED（既有 U+FFFD 替换已覆盖） |
| #001 hooks `onFailure:"block"` | P1 | `hooks/onFailureBlock.ts` + `schemas/hooks.ts` + `onFailureBlock.test.ts` |
| #014 `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` | P1 | `api/withRetry.ts` env 上限（token @99966792 对应）。**review 轮诚实注记（dataflow-002）**：预算账本 per-`withRetry()` 调用重置（`capacityWait={spentMs:0}`），非官方 per-model-call 共享累计——一回合 N 次连续可重试调用可各睡满 cap；非容量重试（watchdogRetryable=false / transient 5xx）不计入预算。per-model-call 移植因二进制取证被禁（"Never invent"）暂不做；当前语义 + env getter（含 malformed warn-once，dataflow-007）+ budget-exhaust telemetry + heartbeat 累计已由 `retryWatchdog295Review.test.ts` 22 用例钉住（mutation M1/M2 均红） |
| #016 `[1m]` beta 被拒→去 beta 重发 | P1 | `api/claude.ts` context-1m heal 分支；review 轮补 focused 覆盖 `context1mBetaHeal295Review.test.ts`（7 用例：真实 `queryModelWithStreaming` + fetch mock，断言恰好一次去 beta 重发、`tengu_beta_400_healed` 恰一次、spent/unproven 锁存、modelSupports1M/betasCarried1m/classifier 三门拒绝；mutation「heal 永不触发」即红） |
| #018 MCP 重连退避≤30s | P1 | `mcp/client.ts` + `reconnectBackoff295.test.ts` |
| #019 错误回复含网络错误名→误断连 | P1 | `mcp/listPagination.ts` isNetworkError + `listPagination295.test.ts` |
| #022 Bash `command_description` 别名 | P1 | `BashTool.tsx` + `commandDescriptionAlias295.test.ts` |
| #026 AUTO_BACKGROUND 排队竞态 | P1 | `exclusiveCallRegistry.ts` + `LocalAgentTask.tsx`/`StreamingToolExecutor.ts` + `autoBackgroundHold295`/`exclusiveCallRegistry295` 测试 |
| #061 `cat` 无输出仍标已读 | P1 | `bashReadCommands.ts` 重写 + 293 测试签名迁移（d242c13） |
| #070 SessionStart context 重复注入 | P1 | `hooks/sessionStartContextDedupe.ts` + 同名测试（REPL.tsx / conversationRecovery.ts 双接线） |
| #071 `CLAUDE_ENV_FILE` resume 后不达 Bash | P1 | `sessionEnvironment.ts` + `sessionEnvKeying295.test.ts` |
| #078 async hook 多行 JSON 被忽略 | P1 | `hooks/AsyncHookRegistry.ts`（+445 行）+ `asyncHookJson295.test.ts`（497 行） |
| #088 Edit mtime 未前进误判已读 | P1 | `FileEditTool.ts` stale-read guard + `fileStateGuard.ts`/`fileStateCache.ts`/`queryHelpers.ts` contentNotInModelContext |
| #108 Grep `-l`/`-c`/`-r` 直接跑 | P1 | `GrepTool.ts` + `grepFlags295.test.ts` |
| #112 tool-search 描述 cap 2048→16384 | P1 | `toolSearchDescCap295.test.ts` + client/toolSearch cap 站点。**review 轮补接线（P1 must-fix）**：原实现 16384 分支生产不可达（无调用点传 `loadedThroughToolSearch`）。现已按官方模式接线：`Tool.prompt` options 类型（Tool.ts）+ `toolToAPISchema`（utils/api.ts）以 `loadedThroughToolSearch ?? (deferLoading && isMcp)` 推导（≡ 官方调用点 `bn&&ur(Kn)&&Nn(Kn,Cr)`：claude.ts tool-search 发现的 deferred MCP 工具即以 `deferLoading:true` 序列化）+ 官方 `"LT:"` cache key 位（@215678602）区分 2048/16384 缓存；测试 15 用例走真实工厂+序列化器（mutation 删 16384 分支即红），非 tool-search 路径保持 2048 不变 |
| #124 ws MCP >16MiB 直接断连 | P1 | `mcpWebSocketTransport.ts` maxPayload + `mcpWebSocketTransportCap295.test.ts` |
| #003 /copy picker 引文去 `>` 标记 | P3 | `copy/copy.tsx` QUOTE_FILENAME + quoted-passage entry（官方 `ge="copy.md"` port） |
| #004 settings 文件不加载告警 | P2 | `plugins/settingsFileLoadWarning.ts` + 295 测试（pluginCliCommands/cli handlers 接线） |
| #020 分页 cursor 重复→同页最多 20 次 | P2 | `listPagination.ts` + `listPagination295.test.ts`；e2e 132-fetch-retry / 144-pagination 同步更新 |
| #021 MCP CSS/JS/XML 不再存 .bin | P2 | `mcpOutputStorage.ts` ext map + `mcpOutputStorageExtMap295.test.ts` |
| #024 /plugin Errors tab 删除先询问 | P3 | `PluginSettings.tsx` + `errorsTabRemovalConfirm295.test.tsx` |
| #025 marketplace 名装不了→拒绝 | P2 | `marketplaceManager.ts` refusal（官方 `mt` verbatim）+ `marketplaceNameRefusal295.test.ts` |
| #038 resource list interrupt 拖到超时 | P2 | `ListMcpResourcesTool.ts` abort + `listMcpResourcesAbort295.test.ts` |
| #048 停长 MCP 调用要告知 Claude | P3 | `tasks.ts`/`task/framework.ts` mcp_task 一等注册 + `buildMcpTaskStoppedNotification`（官方 `SQn`/`Di` binary-verified）+ `mcpTaskStop.test.ts`；BackgroundTasksDialog stop 快捷键 |
| #052 /advisor 不可用模型不打勾 | P3 | `utils/advisor.ts`/`commands/advisor.ts` + `advisorNoCheckmark295.test.ts` |
| #054 vim `~` 越 EOL / `3~` 冲行 | P2 | `vim/operators.ts` + `vimToggleCase295.test.ts` |
| #055 NFD 粘贴光标偏一格 | P2 | `utils/nfcInsert.ts` + `nfcInsert295.test.ts`（PromptInput insertText NFC-splice，官方 @236618722） |
| #062 plugin option `constructor`/`prototype` | P2 | `optionKeySafety.ts` + `pluginOptionsStorage.ts` + `pluginOptionsProtoKeys295.test.ts` |
| #066 piped bold 紧跟 dim 微弱 | P3 | `ink/Ansi.tsx` + `ansiBoldDim295.test.tsx` |
| #069 mcp serve bg Bash 输出文件名 | P2 | `entrypoints/mcp.ts`（+167）+ `mcpServeBackgroundBash295.test.ts` |
| #074 Claude 3 不再被提供 tool search | P2 | `utils/toolSearch.ts` deny 集（官方 `Da`/`Bst` verbatim，substring 语义） |
| #077 /model Max effort 误报已存默认 | P3 | `model/model.tsx` `toPersistableEffort` suffix（官方 @247150291 verbatim） |
| #079 Read 空 `pages` 按省略处理 | P2 | `FileReadTool.ts` preprocess（官方 `Yi` verbatim）+ FileWriteTool reseed 传播 |
| #093 disableAutoMode 移除后仍拒 auto | P2 | `permissions/permissionSetup.ts` fresh-eval gate + `autoModeReevaluate295.test.ts` |
| #110 scriptPath 拒绝文案指路 inline | P3 | `WorkflowTool/scriptLoader.ts` 第二行指引（@227949074 byte-verified）+ `scriptPathGate251.test.ts` 更新 |
| #119 tab stops 从文本起点计 | P2 | `normalize-text.ts`/`render-node-to-output.ts` + `tabStopsFromTextStart295.test.ts`（NO-OP pin） |

### §8.2 STAGED P1（10 条）

- **#017** `-p` bg 开新轮丢前轮输出（§3）— print-mode turn-loop 需逐站点反编译；本轮 diff 无二进制证据，不猜。
- **#035** linked-worktree subagent 误用父会话 git 上下文 — worktree 子系统（121 文件面）需专项取证；本轮 diff 0 命中。
- **#037** `--tools`/`--restricted` 漏延迟注册 built-in + deprecated 名越集 — tool-registry gating 需专项反编译；本轮仅注释级旁证。
- **#044** bash for-loop over glob 权限精度 — bash AST 权限站点（OCC-44/46 敏感链）需逐站点取证；0 命中。
- **#056** 万行响应冻结 + ctrl+c 失灵 — 渲染循环/背压子系统需反编译；本轮 `10000` 命中仅 #018 RAPID_DROP 常量。
- **#067** 嵌套引用冻结 + GB 级内存 — quote 递归站点未取证；diff 0 命中。
- **#072** skill `allowed-tools`/`effort` 流结束前完成被丢 — SkillTool 流式完成竞态需专项取证；allowed-tools 0 命中。
- **#090** scheduled task rewind/resume 丢失/复活 — scheduled+rewind 双子系统（45 文件面）需逐站点取证；本轮仅 rewind NO-OP 注释。
- **#091** 语法高亮冻结（超长行/空行连/未闭合 heredoc）— highlighter 路径未取证；heredoc/highlight 0 命中。
- **#095** /rewind 后 prompt 丢失 + turn 复活 — 与 #090 同 rewind 子系统，下轮 ELF 重取后合并做。

### §8.3 STAGED P2/P3（49 条 = P2 31 + P3 19）

P2（31 条，reason 分组：F=需逐站点取证 / V=需面核验 / T=低价值 trim 候选）：

- **#002** OSC 7501 program status — F：面 0 命中真缺口，下轮取证后 port
- **#005** `-p` 末轮挂起 stderr 说明 — V：print 面存在，站点未取证
- **#027** PushNotification remote-control 误报 — V：PushNotification 面仅 2 文件
- **#028** remote >256 文件 vouch 拒绝 — V：remote-control 面需先核
- **#029** login refresh 后 managed settings 偶发不加载 — F：permissionSetup 本轮改动属 #093，#029 站点无证据
- **#030** /tui 无法重启静默退出 — V：tui 面 18 文件需核
- **#032** gateway Fable picker 行序 — V：gateway 侧行为，model.tsx 本轮 0 命中
- **#036** 打字取消 backgrounding 前台继续 — F：bg 子系统逐站点
- **#039** hook 深嵌套 input 静默截断 — F：hook guard 站点未取证
- **#040** Esc 停不掉 bg /loop + wakeup 提示 — F：loop/wakeup 面仅 2 文件需取证
- **#041** bg 会话 FORCE_COLOR=3 混色码 — V：bg 输出面需核
- **#045** Workflow forked skill 结果误投 — F：workflow 子系统逐站点
- **#046** teammate 首次 SendMessage 失败 — F：in-process teammate + tool-search 竞态
- **#049** bg down 时 /loop wakeup 无声丢失 — F：与 #040 同族合并取证
- **#051** marketplace 大 submodule 只 fetch plugin 子模块 — F：本轮 marketplaceManager 仅落 #025
- **#057** mod reload 绕过 guard hook — V：MODS 相邻面需核
- **#058** hooks 数千层嵌套 stack-overflow — F：hook loader 站点未取证
- **#060** kill+二次 resume 无恢复提示 — V：面需核
- **#065** /model 等保存未问 config.set hook — F：plugin hook 面逐站点
- **#082** `←` 后 `↑`/`Esc` 收回 queued message 丢失 — F：PromptInput 本轮改动仅 #055 NFC
- **#085** 非交互会话未用 MCP 仍提示认证 — F：client.ts auth 提示站点本轮 0 命中
- **#087** 巨型 plugin worker stall 卸载他 plugin — F：plugin worker 子系统
- **#089** CRLF 短命令输出画成单行 — V：本轮 diff CRLF 0 命中
- **#094** synced plugin "directory does not exist" — V：claude.ai-sync 面需核
- **#098** headless 迟到 sign-in 重列 setMcpServers — F：SDK 面逐站点
- **#099** /config channel 未问 config.set hook — F：与 #065 同族
- **#100** macOS file count 隐私弹窗 — V：平台特定面需核
- **#113** subagent skills ≤32 预载 — F：`CLAUDE_CODE_SUBAGENT_CONFIG_WARNING`（§2）同族侦察
- **#116** connectors MCP 协议协商 2026-07-28 — F：两版字符串同计数 6/6，§3 已标需 per-site
- **#120** Artifact 五问权限统一 — V：Artifact 面 11 文件需核
- **#143** xhigh/max effort 下 web search+hook 变慢 — F：性能面，无二进制站点证据

P3（19 条）：

- **#007** "Backgrounding cancelled" 提示 — V
- **#010** plugin validate README 建议 — T
- **#042** claude agents 退出不拉新 bg service — V
- **#043** agent 名 worker 显示成 "Agent" — V
- **#047** resume 提示误归因 TaskStop — V
- **#053** bg MCP 通知不再显示缩短 task id — F：本轮 McpBackgroundTask 仅 #048 stop-通知路径，完成通知 shortened→full 站点无证据，不部分认账
- **#059** plugin test 放行删块 session.append hook — V
- **#075** `-p`/SDK 写生成文件进 --plugin-dir — V
- **#081** Windows 盘符大小写 plugin 记录 — T：平台特定低价值
- **#097** macOS 更新后 bg 重启跑 stable wrapper — V：`CLAUDE_PTY_HOST_NO_STABLE_PATH`（§2）侦察同族
- **#103** RC 等待状态 MCP tool 可读名 — V
- **#106** headless rate_limit_event extra usage — V
- **#107** plugin-authoring skill 改进 — T：OCC skill .md 为 stub 面
- **#109** plugin validate var 重绑报错带行号 — T
- **#111** 大文件上传失败无因 — F：本轮 attachments.ts 改动属 #088 fileStateGuard 族，非 #111
- **#114** attached bg idle Ctrl+C 不动 wakeup — V
- **#115** claude agents 与 bg service 同停 — V
- **#117** Artifact 无背景页白底 — V：疑 cloud viewer 侧
- **#121** telemetry-off 私有 artifact 免询问 — V

---

**本轮结账**：landed **39** = P0 4 + P1 15 + P2/P3 20；STAGED **60** = P1 10 + P2 31 + P3 19；N/A **44**（§3 族级）—— 39+60+44 = 143 ✓ 无静默丢弃。2.1.296 next-only 顺延不变（§4）。

## §9 Leader 收口裁决（2026-10-10，OCC-153）

### §9.0 并行运行对账（事实记录）

本轮出现两个独立程序员 run 平行执行同一 2.1.295 移植：
- **获救 run 链**（f7902863/f2414eaf 抢救 + 续作）已合入 main：`ce6184a`→`6270e7a`(P0 render)→`c47976c`→`d242c13`(#061)→`7f60e40`(§8 closeout)→`d474a2b`(**release 2.1.378**)→`9137d91`(merge)→`644764b`(README 2.1.295)→`3042443`+`69b1282`（验收 NEEDS_CHANGES 修复轮：P1×2 must-fix + 11 defects 含 SEC-1/2，+97 tests，9141 pass sharded，zero net-new fail，build+headless+REPL smoke green）。安全审核与验收修复 substance 均在该链内完成并有 commit 级证据。
- **第二 run**（评论 `cb2aba55`）独立完成同轮移植后按「顺延 if preempted」条款**未合并、未擅自 tag/release**，成果保全于分支 `agent/occ/f29b7705-1791569680`@`1d4bbd2`。**main 拥有 2.1.378 版本号与实现所有权**；第二 run 的 release commit 已从其分支头 drop。处置正确，予以记录。

### §9.1 裁决 (a)：v2.1.378 暂缓 tag —— 先补验收员独立终验

main 树上**尚无验收员作为独立 agent 的 PASS 判定**（本轮审核/验收修复由获救 run 内部完成；issue 链条要求「验收员像人类用户一样验证 → 全部合并 main → 分支清理 → 通知程序员发版」）。裁决：
1. 移交 **OCC 验收员** 对 main `69b1282`（2.1.378）做独立终验（人类用户视角真实使用 REPL/headless、对齐主张抽验、SEC-1/2 与 P1×2 must-fix 在树确认、分支清理核验）。安全审核 substance 已在案（SEC-1/2 已修+测试钉住），**不重复送审**。
2. 验收 PASS 后由验收员通知程序员发版：tag `v2.1.378` → publish.yml **npm 步预期 RED**（OCC-151，非回归）→ 手动 `gh release create v2.1.378 --generate-notes`（幂等）→ parity 核验：**残留缺口应仅剩 v2.1.377**（OCC-151 载体）。
3. NEEDS_CHANGES 则回程序员修复后重验。

### §9.2 裁决 (b)：salvage 分支 8 项 STAGED-P1 立项下轮采纳

`agent/occ/f29b7705-1791569680`@`1d4bbd2` 含 §8.2 STAGED P1×10 中 **8 项的完整移植**（专项二进制取证 + byte-offset 证据注释 + 测试，基于 v295 ELF md5 `4f067be625a3fc99f1c76a563d14cfdb`）：#017（printTextResults）、#035（context.ts worktree）、#037半（launchToolList）、#044（bash ast for-loop glob）、#056（markdownWindowed）、#067（markdownBlockquote）、#072（StreamingToolExecutor applied-layers）、#091（hljsGrammarPatches/hljsLimit）。裁决：
- **分支保留、不删除**（下轮采纳载体，待遇同 §5.4 的 npm 补发载体先例）；下轮（次日 autopilot）台账以本节为入口，cherry-pick/参照移植，把 §8.2 从 10 收敛到 2（#090/#095 双方独立取证后均维持 STAGED，与 main 一致）。
- **采纳警示**：#056/#067/#091 与 main 已审 P0 render 簇（stripRawHyperlinks/conceal、normalize-text tab 展开）有交互，需对位调和而非盲目覆盖。
- 附带摘取：`test/commands/clear/clear-cost-reset.test.ts` 的 `mock.module` live-binding 毒化修复（进程级污染放大器）。

### §9.3 裁决 (c)：#073 取证口径冲突补记

- 两份独立取证判 **NO-OP**（评论 `e04419b1`：OCC grep 0 命中 server-managed settings cache，结构性免疫；`cb2aba55` 同判）。
- main 已验收树为 **PORTED**（`src/plugins/managedPlugins.ts` + `pluginIdentifier.ts`/`mcpbHandler.ts` + `managedPluginsVouching295.test.ts`，经验收修复轮）。
- **裁决：以 main 已验收实现为准**（结构性 parity 的防御纵深，测试钉住）。取证教训入账：**grep 0 命中 ≠ 无受攻击面** —— vouch 基建（remoteVerified/vouchedTiers）OCC 早已存在，官方 295 的修复是把 plugin provenance 接线到该基建；单 token grep 会漏判"接线型"修复。下轮起 #073 复核以 main 实现为基线，N/A 判定不得只凭 grep 0 命中。

### §9.4 分支清理状态（裁决时点）

- `fix/occ153-review`：fully-merged，**Leader 已删**（`git branch -r --merged` 核验后 push --delete）。
- `agent/occ/f29b7705-1791569680`：**有意保留**（§9.2 采纳载体）。
- `agent/occ/f7902863-*` 等获救 run 分支：已被平台/前序 run 清理（fetch --prune 确认）。
- §5.4 所记 `agent/occ/01bb1c9b`：已不在远端（本节更正，该债务项关闭）。
- 当前远端 = `main` + 1 载体分支，满足验收"残留分支清理"口径（载体分支为记录在案的例外）。

### §9.5 发布状态快照（裁决时点，待验收 PASS 后更新）

远端 tags 止于 `v2.1.377`（tag-without-Release，OCC-151 载体）；GitHub Releases Latest = `v2.1.376`；`v2.1.378` 已 bump 在 main（`d474a2b`）**未 tag**。npm `@cnwenf/occ` latest 仍 2.1.367（OCC-151 blocked，等 owner 轮换 NPM_TOKEN）。
