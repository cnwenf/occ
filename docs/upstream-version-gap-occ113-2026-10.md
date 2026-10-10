# Upstream Version Gap Ledger — OCC-113 追齐轮 2.1.295 → 2.1.296（2026-10-11）

> 本账本记录 OCC（open claude code）对齐官方 claude-code **2.1.296** 的 gap 调研、逐条 triage、
> 二进制取证索引与移植执行计划。格式沿用 `upstream-version-gap-occ153-2026-10.md`。
> 纪律：**只取证不执行**（官方 ELF 只做 strings/mmap 字节取证，绝不运行）；**Never invent**
> （无二进制/ changelog 证据不移植）；大文件禁止整读（grep -aboF / dd / mmap 窗口）。

## §0 版本事实（three-way verified）

| 事实 | 值 | 验证方式 |
|---|---|---|
| 官方 latest | **2.1.296** | npm dist-tags + CHANGELOG.md `## 2.1.296`（/tmp/cc296/cc-changelog.md，8789 行） |
| 官方 stable 通道 | 2.1.287 | npm dist-tag stable（本轮不追） |
| OCC 追齐目标 | 2.1.286 基座 → **2.1.296 honest-partial** | 本账本 §3 逐条 triage |
| OCC 版本 | 2.1.378 → **2.1.379**（本轮 bump） | package.json |
| main HEAD（开工） | `6ff64c8` | git log |
| 2.1.295 ELF | 256,113,848 B，md5 `4f067be625a3fc99f1c76a563d14cfdb` | npm pack @anthropic-ai/claude-code-linux-x64@2.1.295；与 occ153 §0 一致 |
| 2.1.296 ELF | 257,068,216 B，md5 `3c8749470f70a26efadf982b587e1548` | npm pack …@2.1.296；与 occ153 §0 next-only 建档一致 |
| strings 统计 | s295 318,758 行 / s296 319,894 行；added 17,942 / removed 16,806 | `strings -n 8 \| sort -u` + comm（/tmp/cc296/diff/） |
| 2.1.296 changelog | **79 条** | /tmp/cc296/cl-296.txt（## 2.1.296 段完整落盘） |
| 二进制内版本号 | `// Version: 2.1.296` @207598042 | mmap 直读 |

## §1 本轮优先级队列（port round queue）

- **P0 安全簇（6）**：#016 secret-redaction 296 两阶段扫描器、#031 BASH_ARGV0 特殊变量守卫、
  #032 非 UTF-8 Edit/NotebookEdit 拒绝、#015 hook 输出 hint-tag 整行消毒（lL）、
  #027 marketplace `constructor` 类名字拒绝、#028 plugin secret `constructor`/`prototype` 保存丢失。
- **P1 参数/正确性（8）**：#004 OVERLOADED_RETRY_MAX_DELAY_MS、#003 WORKFLOW_SUBAGENT_MODEL、
  #061 MCP 描述 cap 2048→4096、#059 Sonnet 5.5 cache-read $0.10、#043 Workflow CRLF 接纳、
  #044 OTel git_commit_id `-q`/`-C`、#002 autoCompactWindow 子代理 frontmatter、
  #036 PowerShell CLAUDE_ENV_FILE 纯赋值解析。
- **P2 UX/杂项（2）**：#017 VTE 终端 52;c 抑制、#055 --debug 未识别 frontmatter 字段提示。
- **STAGED（20）**：#006 allow_large（P1，证据已全量落盘）等，见 §3。
- **N-A（43）**：gateway/cloud/Claude Tag/VSCode/Code Review 服务端/runners/mods($ API)/
  claude.ai sync/Windows 专属/GC 未实现面等，见 §3。

## §2 新增 env/token 取证（295→296，token 集合差分，已排除 minify 邻接噪声）

真正新增的 env 名（`grep -oE "CLAUDE_CODE_[A-Z0-9_]{3,}" | sort -u | comm -13` 后人工复核）：

| token | 证据 | 处置 |
|---|---|---|
| `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` | 配置导出 `LU=H.str()` @207576589；3P-probe env 列表 @208765415；managed env 列表 @208771578 | PORT（#003） |
| `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` | retry 流程 `or=Vo?a.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS:void 0` + `tengu_api_retry_after_too_long` @218332623（ev-retry296.txt） | PORT（#004） |

非 env 的新 token：`allow_large`（Read 工具入参，@209662501/@219139959/@219145401，STAGED）、
`tier_2_10_cache_read_0_10`（定价层，@207704167）、`autoCompactWindow`（agent frontmatter 新面）。
其余 added.txt 差量绝大多数为 minify 邻接噪声（单字符重命名漂移），不采信。

## §3 2.1.296 changelog 逐条 triage（79 条）

> 编号按 cl-296.txt 行序。判定：**PORT**（本轮移植）/ **STAGED**（证据不足或工程量大，结转）/
> **N-A**（OCC 无此面/后端专属/平台专属）。证据偏移均指 `/tmp/cc296/diff/vver/package/claude`
> （295 对照指 vprev）。落盘证据文件见 §7。

| # | 条目（摘要） | 判定 | 理由 / 证据 |
|---|---|---|---|
| 001 | gateway managed.policies[] 加 `code` key | N-A | Claude Desktop gateway 面，OCC 无 |
| 002 | autoCompactWindow 进 subagent frontmatter / --agents | **PORT→已对齐(b1eb311)** | schema @208188475（ev-agentfw296.txt）：`E().int().min(b0).max(TN)` + describe "only lowers the window…No effect on the main session agent"；字段白名单 `Wf` @210942084 含 autoCompactWindow。OCC bounds 已有 AUTO_COMPACT_WINDOW_MIN/MAX=100k/1M（src/utils/autoCompactWindow.ts:47） |
| 003 | `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` | **PORT→已对齐(f3ed083)** | §2；OCC 已有 SUBAGENT_MODEL 消费点（AgentTool.tsx、WorkflowTool/primitives.ts、modelLadder.ts） |
| 004 | `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` | **PORT→已对齐(f3ed083)** | ev-retry296.txt：`MF(on+G,fo,or,r.random,…BASE_DELAY…)`，超限走 `tengu_api_retry_after_too_long` + 抛错。OCC src/services/api/withRetry.ts 已有 BASE_DELAY（292）与 WATCHDOG（295） |
| 005 | /plugin 提示 hooks 因同名被略过 | STAGED-P3 | plugin UI 提示面，官方站点未取证 |
| 006 | Read `allow_large` | STAGED-P1 | 证据已全量取齐（room 函数 lOr @219148250、0.7/×3 系数、prompts Ugo=25000/Aws/Bgo/Cws/jgo=128、telemetry `tengu_file_read_allow_large`、5 个调用站点）但涉及 Read 限额管线全链改造，本轮预算不足；证据在案下轮优先 |
| 007 | managed PreToolUse `"continue":false` deny 不终轮 | STAGED-P2 | hook 引擎 deny 语义，官方 diff 站点未定位 |
| 008 | managed PostToolUse `updatedMCPToolOutput` 偶不生效 | STAGED-P2 | OCC 有 updatedMCPToolOutput 面（toolHooks.ts/toolExecution.ts），managed 分支差异未取证 |
| 009 | headless 下被关掉的 .mcp.json/plugin MCP server 复活 | STAGED-P2 | cwd 变更/reload 后 disabled 集合丢失，站点未取证 |
| 010 | allowedProviders "gateway" 锁死笔记本 | N-A | gateway 认证面 |
| 011 | forceLoginMethod=gateway 无 URL 时忽略已存登录（295 回归） | N-A | gateway 认证面 |
| 012 | --teleport 历史读不出时开空会话 | STAGED-P3 | OCC teleport 为自有 RemoteAgentTask 构造，官方 history-read 站点未取证 |
| 013 | Haiku 5.5 等 adaptive-thinking-only 模型 token 计数 | STAGED-P2 | 官方 model 目录 capabilities 已取证（ev-pricing296.txt：haiku-5-5 带 adaptive_thinking/rejects_disabled_thinking），但计数修复站点（gateway 失败/budget-thinking 误计）未定位；OCC model 面差异需专项比对 |
| 014 | resumed subagent 误报 user rejected | STAGED-P2 | resume 中断路径，站点未取证 |
| 015 | hook 输出含 hint-tag 样文本被篡改 | **PORT→已对齐(c1634c5)** | 295 `REe`（m-flag regex 替换+折行）→ 296 `lL`（**整行**匹配才剥离：`Ctr(e){if(e.length>1024||!e.includes("<claude-code-hint"))return!1;return k1n.test(e)}`，`lL` 按行 filter）@215807103（ev-hints296.txt）；hook 输出调用点 `stdout:lL(Ar.stdout),stderr:lL(Ar.stderr),output:lL(Ar.output)` @218578100、ranElsewhere @218569346。OCC src/utils/claudeCodeHints.ts 仍是 295-era 且 hooks 路径完全无消毒 |
| 016 | secret redaction 漏"key 无值"后的值（含 shell 串内 JSON） | **PORT→已对齐(c1634c5)** | 296 新两阶段扫描器：`Ye={plain:{assign:/qe\|et/gi,nextKey:RegExp(ts,"iy"),…,skipsStrays:!1},escaped:{assign:/qe\|et\|gn/gi,nextKey:RegExp(ns,"iy"),…,skipsStrays:!0}}`，`fn=/\\["'/` 触发 escaped 阶段；`on()` 带 sticky nextKey 前瞻、512 gap cap、引号跨值 `^(["'])[^]*\1$`、range merge `bn`；新 builder `ns`（escaped-quote key `\\\\+"${Z}\\\\+"`）；规则表 64 条（ev-rules296.txt 全量落盘，含 `sensitive-assign-escaped` redactOnly）。OCC src/utils/secretRedaction/ 停在 2.1.286（46 规则、无 escaped 阶段、无 nextKey 前瞻） |
| 017 | 老 VTE 终端复制后屏上残留 `52;c;…` | **PORT→已对齐(b1eb311)** | 296 setClipboard 加 VTE 门：`d = mux===null && native && (linux\|\|wsl) && R7r() && (flavor==="vte-based"\|\|"gnome-terminal") && TERM.startsWith("xterm") && !XTERM_VERSION && !ALACRITTY_WINDOW_ID && !ALACRITTY_LOG && !KITTY_WINDOW_ID && !WEZTERM_PANE` → emit "none(vte)" 返回 ""（@214869805，batch5 log）；295 无此门。OCC src/ink/terminal.ts 已有 VTE_VERSION 探测，src/ink/termio/osc.ts:156 有 52;c 路径 |
| 018 | /diff 面板开着时 toast 积压 | STAGED-P3 | UI 调度面，站点未取证 |
| 019 | UserPromptSubmit hook 期间 Esc/中断致 headless 终会话等 | STAGED-P2 | 中断语义深水区 |
| 020 | 后加载 plugin 的 SessionStart 因同名（或变体拼写）已跑而被跳过 | STAGED-P2 | plugin hook 去重键面，站点未取证 |
| 021 | self-hosted-runner 注册被拒时误导性报错 | N-A | runner 服务面 OCC 无 |
| 022 | runner --capacity>1 同仓 git fetch/pull/push 失败 | N-A | 同上 |
| 023 | workflow 脚本 >20000 层嵌套静默截断 + 巨型 task 输出 | STAGED-P2 | SDK conformance 层 marker 逻辑 295/296 相同（`replaced N subtree(s) nested deeper than ${pe} levels with a marker` @237666456 / 295 @235236458），真正修复点在 workflow 结果序列化侧，未定位；OCC WorkflowTool 为自有实现 |
| 024 | plugin `$` 方法跑在主会话 cwd / 忽略调用 hook 的 turn | N-A | mods `$` API 面 OCC 无 |
| 025 | mod reload 后 `$.agent.register` 仍成功 | N-A | 同上 |
| 026 | `$.http.fetch` HEAD + Content-Length>4MiB 误拒 | N-A | 同上 |
| 027 | marketplace 名如 `constructor` 致 add/update/install 内部错误；add 明确拒绝 | **PORT→已对齐(c1634c5)** | 296 拒绝链：`L7e(e){if(!D7e(e))throw new gbn(e)}`，`gbn`=UnrecordablePluginIdError("plugin id cannot be a key of the install records") @219454191（ev-market296b.txt）；add 侧 `e7e` 保留名拒绝 @219389759（ev-market296.txt）。**晋升 occ153 §8.3 #025（marketplace 名装不了→拒绝）**。OCC 已有 optionKeySafety.ts（#062 同族） |
| 028 | plugin secret 名 `constructor`/`prototype` 被下次保存删除 | **PORT→已对齐(验证)** | 295 `li(S,(b,P)=>h.has(P))` → 296 `Av(S,(b,P)=>!h.has(P))`（own-keys 安全过滤）@213495184 vs 295 @212857467（ev-secrets296.txt）。**实现核查：OCC mcpbHandler.ts/pluginOptionsStorage.ts 已是 296-shape（own-keys 过滤），无需改动；以 pluginSecretsProtoKeys296.test.ts（6 用例）钉死行为** |
| 029 | cloud session flags 未载时跳过 Chrome auto-mode 检查 | N-A | cloud 面 |
| 030 | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 在 MCP tool result 结尾的轮次重启后重跑已完成轮 | STAGED-P2 | OCC 有面（conversationRecovery.ts/print.ts），官方修复站点未取证，不猜 |
| 031 | Bash 权限自动放行 `BASH_ARGV0` 赋值后用它的命令 → 改为询问 | **PORT→已对齐(c1634c5)** | 特殊变量集 `KLn` @212066150（含 BASH_ARGV0/PIPESTATUS/BASH_REMATCH/PS1-4 等）+ 解析器 `Z(e,t,r){if(KLn.has(s))return r&&le.has(s)&&s!=="BASHPID"?_:b(e)}`；for-loop 守卫 @212027456：`n==="BASH_ARGV0"||…→{kind:"too-complex",reason:"${n} as loop variable bypasses assignment validation",nodeType:"for_statement"}`（ev-bashargv0.txt / ev-bashargv0-loop.txt）。OCC src/utils/bash/ast.ts 有 BASHPID/too-complex 同构面、0 处 BASH_ARGV0 |
| 032 | Edit/NotebookEdit 把非 UTF-8 文件（Windows-1252/Shift-JIS/GBK）整文件替换为 U+FFFD → 拒绝 | **PORT→已对齐(c1634c5)** | 两条 verbatim 消息 @208137035（ev-utf8.txt）：`aen`="File is not valid UTF-8. … Nothing was written. Make the change with a shell command that reads and writes the file in its own encoding, or ask the user whether to convert the file to UTF-8 first."；`UTs`="The file on disk is not valid UTF-8, and the new content holds U+FFFD, … Nothing was written. …"；挂 FileStateError 家族（`class C8 extends Error{this.name="FileStateError"}`）。OCC 三个编辑工具 0 处 UTF-8 校验 |
| 033 | `←` 后立刻发 prompt 被前后台各跑一次 | N-A | background service `←` 面 OCC 无 |
| 034 | SessionStart 期间发的 prompt 在 `←` 后丢失 | N-A | 同上 |
| 035 | 迟加载 plugin 的 SessionStart 输出穿过 /clear 进新会话（headless） | STAGED-P3 | 与 #020 同族，站点未取证 |
| 036 | PowerShell 看不到 hooks 写入 CLAUDE_ENV_FILE 的变量（文件仅纯赋值时） | **PORT→已对齐(b1eb311)** | 296 新增 `A_t`：逐行匹配 `K8n=/^(?:\s*(?:#.*)?\|(?:export +\|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]\|'[^'\0]*'\|"(?:[^"\\$`\0]\|\\[^\0])*")*))$/`，任一行不匹配→"Session environment is not all plain assignments" 返回空 Map；`V8n` 去引号。295 无 A_t（"is not all plain assignments" 0 命中）。OCC sessionEnvironment.ts 只有 bash 侧脚本拼接 |
| 037 | cloud 会话被称 non-interactive 并误导 /mcp | N-A | cloud 面 |
| 038 | /code-review 在 cloud/SDK/IDE 输出裸 JSON 数组 | STAGED-P3 | OCC ReportFindings 渲染面差异未取证 |
| 039 | auto mode 误判自己 artifact 共享变化 | N-A | auto-mode cloud/Chrome 面 |
| 040 | claude.ai 同步的 skills 装不完、每次重下 | N-A | claude.ai 后端同步面 |
| 041 | claude.ai 同步的 plugin 因依赖同源被禁用 | N-A | 同上 |
| 042 | macOS 启动挂起（Linux 拷来的 plugin 路径指向 /home） | STAGED-P3 | macOS 平台路径探测，OCC 未复现面 |
| 043 | Workflow 拒绝 CRLF 脚本文件（Windows checkout） | **PORT→已对齐(f3ed083)** | 296 workflow 脚本清洗 `I3n(e)=Lpe(gf(e).replace(/\r\n/g,"\n").split("\n").map(Rn).join("\n"),R3n)` @223844141（ev-wfcrlf296.txt；常量组 Le=10,vn=30,R3n=10240,In=200,ze=32768,qt=512,Dn=64）。OCC WorkflowTool 0 处 \r 处理 |
| 044 | OTel tool_result 丢 git_commit_id（`git commit -q` / `git -C <dir> commit`） | **PORT→已对齐(f3ed083)** | 门函数 `R7t(e,n)=xd()&&(Bash\|\|PowerShell)&&typeof n.command==="string"&&Oss(n.command)` @217866714（ev-otel296.txt），前置态 `Ur=await ZTo(cwd)`，事后 `Mss(stdout,cwd,Ur)` @217897356 产出 commitId/branch。OCC toolExecution.ts:1411-1424 parseGitCommitId 同构面；Oss 的命令形状匹配含 -q/-C 形态（changelog 直接证据） |
| 045 | TRANSCRIPT_LOCAL_GC 丢含 U+2028/U+2029 的消息 | N-A | OCC src 无 TRANSCRIPT_LOCAL_GC 实现（仅测试文件名引用），特性缺位则 bug 不存在；GC 特性本体在 occ153 STAGED 池 |
| 046 | purge 后 history 残留含 U+2028/U+2029 的 prompt | N-A | OCC projectPurge 整目录/整文件删除，不做逐行改写，无此 bug 面 |
| 047 | Windows PowerShell >1KB 命令总是询问 → allow 规则/read-only 检测放宽到 32KB | N-A(核) | Windows 专属修复（官方 `sIr=32000` @219100783）；OCC powershellPermissions.ts 无 1KB 询问上限同构面（MAX_COMMAND_LENGTH 为输出截断语义），实现时复核一次，若有低 cap 一并对齐 |
| 048 | Windows stdio MCP 关机强杀 → 先关 stdin 等 300ms | N-A | Windows 进程树专属 |
| 049 | Windows plugin install 无 SSH key 时 GitHub 源失败 → HTTPS 重试 | N-A | Windows 专属（clone 回退链） |
| 050 | Windows Git Bash `rm -rf /c/Users/<name>` bypass 模式不询问 | N-A | Windows 路径形态专属 |
| 051 | fullscreen 鼠标悬停链接加下划线 | STAGED-P3 | Ink 渲染面，站点未取证 |
| 052 | ctrl+o 代码块高亮缓存提速 | STAGED-P2 | 性能改造面，OCC transcript toggle 结构不同，需专项 |
| 053 | Desktop Code tab gateway 失败原因回显 | N-A | Desktop/gateway 面 |
| 054 | cloud 会话被拒错误信息改进 | N-A | cloud 面 |
| 055 | --debug 报出 agent 文件未识别 frontmatter 字段（含 typo 提示） | **PORT→已对齐(b1eb311)** | 官方字段白名单 `Wf`=["name","description","prompt","tools","disallowedTools","model","effort","permissionMode","mcpServers","hooks","maxTurns","autoCompactWindow","skills","initialPrompt","memory","background","omitClaudeMd","isolation"] @210942084（batch3 log）；OCC loadAgentsDir.ts zod schema 同构面 |
| 056 | auto mode 检查无答案时显示 dim "Not run" 行 | N-A | auto-mode UI 面 |
| 057 | --debug hook 日志（命令/plugin/结果/时长） | STAGED-P3 | OCC hooks.ts 已有 durationMs/hook_duration_ms 部分面，官方格式串未取证 |
| 058 | TRANSCRIPT_LOCAL_GC 释放 <10% 不重写 | N-A | 同 #045，GC 特性未实现 |
| 059 | Sonnet 5.5 cache read 定价 $0.20→$0.10 | **PORT→已对齐(f3ed083)** | 新定价层 `tier_2_10_cache_read_0_10:{input:2,output:10,cache_write_5m:2.5,cache_write_1h:4,cache_read:0.1,web_search:0.01}` @207704167；sonnet-5-5 `pricing:"tier_2_10_cache_read_0_10"` @207711865（ev-pricing296.txt）。OCC model.ts 已有 `tier_4_20_cache_read_0_20` 同构命名 |
| 060 | 内置 dataviz skill 配色/轴标签更新 | N-A | OCC bundled skills 无 dataviz |
| 061 | MCP 工具描述/服务器 instructions 默认 cap 2048→4096 | **PORT→已对齐(f3ed083)** | `Ax(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??(e?sns:sxn)}` @217807522（env 覆盖保留，默认改 4096；changelog 明文 2,048→4,096）。OCC client.ts:293 `DEFAULT_MAX_MCP_DESCRIPTION_LENGTH=2048`；注意 occ153 #112 的 tool-search 16384 口径不变 |
| 062 | `←` 语义变更：后台化时未完成的轮/`!` 命令被停止 | N-A | background service 面 OCC 无 |
| 063-067 | VSCode 扩展 5 条（spinnerVerbs/Chrome 询问/Windows 链接/reduced motion/cache clock） | N-A | VSCode 扩展面 OCC 无 |
| 068-070 | Cloud sessions 3 条（状态过滤/队列位次/消息排序） | N-A | cloud 服务端面 |
| 071-077 | Claude Tag（Slack）7 条 | N-A | Slack 集成面 OCC 无 |
| 078-079 | Code Review 服务 2 条（PR check 卡 in-progress/admin 设置报错） | N-A | Code Review 服务端面 |

**统计：PORT 17 / STAGED 19 / N-A 43。**

## §4 关键二进制证据索引（偏移 → 落盘文件）

| 主题 | 296 偏移 | 295 对照 | 落盘 |
|---|---|---|---|
| secret redaction 规则表(64)+两阶段扫描器+En 类 | 207293500–207316000 | 206645000–206662000 | ev-rules296.txt / ev-rules295.txt |
| 非 UTF-8 拒绝（aen/UTs verbatim） | 208137035 | — | ev-utf8.txt |
| BASH_ARGV0：KLn 集+解析器 | 212066150 | — | ev-bashargv0.txt |
| BASH_ARGV0：for-loop too-complex 守卫 | 212027456 | — | ev-bashargv0-loop.txt |
| hint 模块（lL/Ctr/k1n/Oct/v1n/8232-3 行界） | 215807103 | REe @217807940 | ev-hints296.txt |
| OVERLOADED_RETRY_MAX_DELAY 流程 | 218332623 | — | ev-retry296.txt |
| agent frontmatter autoCompactWindow schema | 208188475 | — | ev-agentfw296.txt |
| 定价层 + sonnet/haiku 5.5 目录条目 | 207703800–207712600 | — | ev-pricing296.txt |
| CLAUDE_ENV_FILE A_t 纯赋值解析器 | 216106800–216110200 | 0 命中（新增） | ev-envfile296.txt |
| marketplace add 拒绝链（e7e/L7e/gbn） | 219389759 / 219454191 | — | ev-market296.txt / ev-market296b.txt |
| pluginSecrets 保存过滤（Av vs li） | 213495184 | 212857467 | ev-secrets296.txt |
| OTel git commit 门（R7t/Mss/ZTo） | 217866714 / 217897356 | — | ev-otel296.txt |
| Workflow CRLF 清洗（I3n） | 223844141 | — | ev-wfcrlf296.txt |
| WORKFLOW_SUBAGENT_MODEL 导出 | 207576589 | — | ev-wfmodel296.txt |
| 52;c VTE 门（setClipboard 全函数） | 214869000–214870100 | 214209100–214210000 | forensics-batch5.log |
| allow_large（room/prompts/telemetry，STAGED 备用） | 209662501/219139959/219145401/219148250/210495481 | — | 本账本 §3 #006 + 前轮会话记录 |
| MCP cap env 解析（Ax） | 217807522 | — | forensics-batch7.log |

## §5 occ153 §8 STAGED-60 复查（296 晋升判定）

- **#025（marketplace 名装不了→拒绝，P2/P3）→ 晋升**：296 #027 给出明确拒绝语义与错误类
  （UnrecordablePluginIdError），本轮随 #027 一并落地。
- **#044（bash for-loop over glob 权限精度，P1）→ 部分晋升**：296 #031 的 for-loop 守卫
  （`${n} as loop variable bypasses assignment validation`）落在同一 AST 权限站点，本轮实现
  BASH_ARGV0 特殊变量族守卫；glob 迭代的更广精度问题仍 STAGED。
- #017/#035/#037/#056/#067/#072/#090/#091/#095（P1 余下 8 条）：296 diff 无新证据，维持 STAGED。
- P2×31/P3×19：逐条对照 296 changelog，除 #025 外无命中，维持 STAGED（#014 RETRY_WATCHDOG、
  #062、#112 等已在 occ153 落地，不重复）。

## §6 移植轮执行顺序（本轮）

1. **安全簇**（并行 subagent，互不共享文件）：
   - A：#032 非 UTF-8 拒绝（FileEditTool/NotebookEditTool/FileWriteTool 共享校验 util）
   - B：#031 BASH_ARGV0（src/utils/bash/ast.ts）
   - C：#015 hint lL（src/utils/claudeCodeHints.ts + hooks 输出消毒点）
   - D：#016 redaction 296（src/utils/secretRedaction/*）
   - E：#027+#028 plugin 家族（marketplaceManager/pluginOperations/optionKeySafety）
2. **参数簇**：#004 withRetry、#061 MCP cap、#059 定价、#003+#043 WorkflowTool、
   #044 OTel matcher、#002+#055 agent frontmatter。
3. **UX 簇**：#017 VTE、#036 PS env-file。
4. 每簇 `bun test`（相关文件）+ commit + push；全量回归 A/B、build、headless smoke、tmux REPL；
   bump 2.1.379 + CHANGELOG + README badge；合入 main；交接 @OCC 安全审核员（diff 6ff64c8..merge）。

## §7 调研工件与复现方法

- 工件目录 `/tmp/cc296/`（**轮末按 skill 纪律清除**）：cc-changelog.md、cl-296.txt、
  diff/{vprev,vver}/package/claude、s295.txt/s296.txt/added.txt/removed.txt、
  forensics-batch3..9.log、ev-*.txt（§4 索引）。
- 复现：`npm pack @anthropic-ai/claude-code-linux-x64@{295,296}` → md5 对照 §0 →
  `strings -n 8 | sort -u` → comm 差分 → python mmap 窗口提取（禁止整读 256MB）。
- 取证纪律：官方 ELF 只读不执行；所有判定以 verbatim 字节为准；minify 单字符名跨 chunk 复用，
  必须带边界正则与区域限定复核。
