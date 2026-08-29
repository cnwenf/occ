# OCC-109 版本差距台账(官方 2.1.251 落地轮:5 项安全修复 + Bash 算术赋值权限修复)

日期:2026-08-30(自动化轮次,Asia/Shanghai)。上一轮:OCC-108(追齐 2.1.248,发布 2.1.315,base `d513ad9`)。

## 1. 版本状态(三方核实)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.251**(2026-08-28T15:34Z);无更新版本(2.1.252+ 不存在) |
| GitHub `anthropics/claude-code` releases | v2.1.251 存在,release notes 完整(本轮开工时 73 条,较 OCC-108 轮内所见 ~35 条又有增补) |
| 官方二进制取证源 | 2.1.251 linux-x64 官方 npm 包(`anthropic-ai-claude-code-linux-x64-2.1.251.tgz`):ELF md5 `8787d0bd7aa3e423f6cc83ebc20c08b2`,214,326,616 bytes,版本标记 `2.1.251` ×2048、`2.1.252` ×0;`strings -n 6` dump 497,854 行 |
| OCC 基线 | 追齐至官方 **2.1.248**(OCC-108;release 2.1.315;base `d513ad9`) |

本轮 gap = **2.1.251**(OCC-108 §5 全量分诊结转;安全项最高优先)。重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐任务(occ 项目 in_progress 仅本 issue)。

## 2. 逐版本结论

- **2.1.249** — 从未发布(维持 OCC-108 判定)。
- **2.1.250** — no-op(维持 OCC-108 判定:仅 "Bug fixes and reliability improvements")。
- **2.1.251** — 本轮落地 **6 项安全修复**(§3:Gap-109a…f);`PreModelSwitch`/`PostModelSwitch` hook 新事件族 + §5 其余项 staged/不落地(§4、§5)。

## 3. 本轮落地项(均对官方 2.1.251 ELF 取证)

### Gap-109a — 文件工具 symlink TOCTOU(changelog #6)

- **官方机制**:权限检查时把目标路径的 symlink 解析结果 stash 进 per-toolUseId 会话态(二进制 `Uzt` 模块,read/write 两泳道,带 LRU 驱逐与驱逐拒绝文案);工具 `call()` 时重新解析并与检查时批准的集合做子集比对(二进制 `LC` 门 `s()`),任何新解析不在批准集合内即抛 `c7`/SymlinkReadRefusedError,拒绝文案逐字节匹配。
- **OCC 落地点**:新增 `src/utils/permissions/symlinkResolutionStash.ts`(`stashCheckTimeResolutions` / `takeApprovedPathsForRead` / `assertSymlinkResolutionsUnchangedForWrite` / `SymlinkReadRefusedError` / 带驱逐的 `SymlinkResolutionStash`);FileReadTool(read 泳道)、FileWriteTool / FileEditTool / NotebookEditTool(write 泳道)在 `checkPermissions`(stash)与 `call`(门)两点接线;`src/utils/permissions/permissions.ts` 与 `src/services/tools/toolHooks.ts` 把 `toolUseId` 穿入权限检查上下文。
- **测试**:`src/utils/permissions/__tests__/symlinkResolutionStash251.test.ts`(23 例)。

### Gap-109b — Grep/Glob symlink 搜索路径 TOCTOU(changelog #10)

- **官方机制(二进制 `S2t` 门)**:检查时消费 read 泳道 stash(`Nve`)→ 解析子集门(`d()`)→ ripgrep 仅能按 PATH 名解析时拒绝 cwd 之外搜索(`v`/`R()`,deny 规则无法锚定)→ `open(O_RDONLY|O_NONBLOCK)` errno 分支(`aY`;ENOENT/ENOTDIR → 空结果 `GPn`/`Qat` null 分支;EACCES/EPERM/ELOOP → 拒绝)→ `stat` → 目录 `X_OK` 可遍历性(`lY`)→ spawn 前 `recheckBeforeSpawn()` + `H2t` deny 模式快照复比;入口 `fu()` NUL 字节守卫;5 条拒绝文案逐字节匹配。
- **OCC 落地点**:新增 `src/utils/permissions/searchTargetGate.ts`(`prepareVerifiedSearchTarget` / `computeReadDenyPatternSnapshot` / `assertDenyPatternsUnchanged` / `RipgrepNullByteError`);GrepTool(`getPath`、`checkPermissions` stash、`call` 门 + `emptyGrepResult` 三模式空形状 + spawn 前复比);GlobTool(`getPath` 采用二进制 `NI.getPath` 语义——绝对模式经 `extractGlobBaseDirectory` 提取的基目录优先于 `path` 参数、`checkPermissions` stash、`call` 门 + 空结果)。
- **测试**:`src/utils/permissions/__tests__/searchTargetGate251.test.ts`(28 pass / 1 skip;skip 为 root 环境下 `X_OK` 项)。`grepTool210.test.ts` 两个 tmpdir fixture 测试按守卫语义迁入 cwd 之下(守卫允许区)。
- **注**:`bun test` 环境 `ripgrepCommand()` 回退为裸名 `rg`,PATH-名守卫在测试中实际生效;打包产物 `Bun.embeddedFiles.length > 0` → ripgrep 内嵌/绝对路径,守卫休眠——与官方一致(官方 ripgrep 恒为内嵌绝对路径,该守卫是防 PATH 劫持场景的纵深防御)。
- **staged(见 §4b)**:二进制的 fd-pinning 泳道与逐结果判定。

### Gap-109c — Workflow 工具 scriptPath 门(changelog #9)

- **官方机制**:Workflow 工具的 `scriptPath` 须落在“可读集”内(代理本就能 Read 的路径),且经 TOCTOU 硬化读取(二进制 `dtn`/`Wo`/`Ast`)在 `checkPermissions`、`validateInput`、`call` 三时点各读一次;错误文案引用 scriptPath,字节匹配(`It`/`dtn`/`Ast`)。
- **OCC 落地点**:`src/tools/WorkflowTool/scriptLoader.ts`(`checkScriptPathReadable` / `loadScriptGated` / `scriptPathNotReadableMessage` / `WORKFLOW_SCRIPT_MAX_BYTES`)、`WorkflowTool.ts` / `WorkflowPermissionRequest.tsx` / `primitives.ts` 接线。
- **测试**:`src/tools/WorkflowTool/__tests__/scriptPathGate251.test.ts`。

### Gap-109d — project settings env 黑名单 + beta tracing/OTLP 支配(changelog #8)

- **官方机制(二进制 `P7n` managed-env 类)**:project 作用域设置不得设置黑名单 env 键(详细 beta tracing、原始 API body 日志等敏感键);OTEL exporter 族的 managed/host 声明(`enforceManagedOtelFamilyDominance`)支配低信任 `process.env` 值,含 `BETA_TRACING_ENDPOINT` 旁路。
- **OCC 落地点**:`src/utils/managedEnv.ts`(`PROJECT_SCOPE_BLOCKED_ENV_KEYS` + `enforceManagedOtelFamilyDominance`);`src/utils/telemetry/instrumentation.ts` 相应调整,删除已被支配逻辑取代的 `managedOtelEndpoint.ts` 及其测试。
- **测试**:`src/utils/__tests__/projectScopeEnvBlocklist251.test.ts`。

### Gap-109e — plugin 路径穿越(changelog #7)

- **官方机制(二进制 `Ibe`)**:所有相对组件路径规范化后做包含检查,拒绝解析到 plugin 根之外的任何路径。
- **OCC 落地点**:`src/utils/plugins/pluginLoader.ts` `resolveContainedPluginPath`,接入 `validatePluginPaths`(agents/skills/output-styles)、六处命令路径位点(manifest + marketplace,数组与 source 形态)与 manifest hooks 位点;`PluginErrors.tsx` / `types/plugin.ts` 相应面。
- **测试**:`src/utils/plugins/__tests__/pluginPathTraversal251.test.ts`(经导出的 `createPluginFromPath` 行为性演练真实攻击形态 `./../x.md`——manifest schema 要求 `./` 前缀,穿越必经此形)。

### Gap-109f — Bash 整数属性变量算术赋值自动批准绕过(changelog #39)

- **官方机制(二进制集合 `or`/`Va`/`Wn`/`Vo` + 判定 `Jo`/`Jn`/`Vwe`)**:对整数属性 shell 变量(`OPTIND`、`RANDOM` 等)的赋值,shell 会对 RHS 做算术求值——`X='a[$(id)]'` 会执行下标里的命令替换,构成权限绕过。官方对裸赋值做执行影响(`Jn`)+ 整数属性算术求值(`Jo`)双判定;env 前缀形态做 `Jo`;for 循环变量做 `Jn` + 三变量集;`unset` 经 `Vwe` 门(针对 shell 变量的提示)且限 `-f`/`-v`。
- **OCC 落地点**:`src/utils/bash/ast.ts`(OCC-46 的 `walkTestExpr` 链之外的赋值/循环/unset 位点)。
- **测试**:`src/tools/BashTool/__tests__/integerAttrArithEval251.test.ts`。

## 4. 2.1.251 全量分诊(73 条逐条;OCC-108 §5/§6 已分诊项交叉引用)

### 4a. 本轮落地(6 项,见 §3)

| # | changelog 条目 | Gap |
|---|----------------|-----|
| 6 | 文件工具 symlink TOCTOU(权限检查后工作目录内 symlink 被换) | Gap-109a |
| 10 | Grep/Glob 对经 symlink 搜索路径到达的文件不应用 `Read(...)` deny 规则 | Gap-109b |
| 9 | Workflow 工具权限检查前读取(并在错误中引用)`scriptPath` | Gap-109c |
| 8 | project settings 可启用详细 beta tracing / 原始 API body 日志;低 scope 端点绕过 OTLP collector | Gap-109d |
| 7 | marketplace 条目声明的 plugin 命令可指向 plugin 目录之外(路径穿越) | Gap-109e |
| 39 | Bash 权限检查对整数 shell 变量赋算术表达式(`OPTIND=1/0`、`RANDOM=2+2`)自动批准 | Gap-109f |

### 4b. 有 OCC 对应面 → staged(需专项取证,留后续轮次)

| 条目 | 去向 | 备注 |
|------|------|------|
| Gap-109b 余留:二进制 `S2t` 的 **fd-pinning 泳道**(批准路径 `open(O_RDONLY)` 后持 fd 跨 spawn,经 `readlink(/proc/self/fd/N)` 取规范解析,`spawnCwd=/proc/self/fd/N` + `relativeOutput` target="." 与 `XYn`/`KPn` 输出路径重映射)、**逐结果 deny 判定**(`judgeEveryResult`/`l_t`)、**安全泳道早退**(`jn`/`Os`/`yr`)、Windows 分支 | 专项轮 | OCC 已落地检查时门 + spawn 前复比(同一拒绝面);fd-pinning 泳道是更深的官方实现,依赖 `/proc/self/fd` 语义与输出重映射链,需专项取证后整体移植 |
| Gap-109a 余留:官方 `Uzt`/`LC` 除解析子集比对外疑似还有更深的比对泳道 | 专项取证 | OCC 已落地检查时 stash + 调用时子集比对(同一拒绝面与文案);若后续取证确认官方有 fd 级钉住,再对齐 |
| `PreModelSwitch`/`PostModelSwitch` hook 事件 + `SessionStart` resume 陈旧度/重缓存成本 | 专项轮 | 新 hook 事件族:模型切换路径触发点 + 事件 schema + SessionStart resume payload 扩展,跨切面大,按 `--restricted` 先例专项落地 |
| `/cost` 每会话 prompt-cache 行 + status line `prompt_cache` 对象 | 专项取证 | OCC-108 §5 结转 |
| `/usage` Spend limit 条 + `rate_limits.spend_limit` | 部分适用 | OCC-108 §5 结转(gateway 面) |
| `claude --help` 增 `attach/logs/stop/respawn/rm`;`--resume` 点名 `attach <id>` | 帮助文本取证 | OCC-108 §5 结转;OCC 自研 daemon 子命令面 |
| 仅 thinking 回合后卡 "text content blocks must be non-empty" | 请求/消息面 | OCC-108 §5 结转 |
| Opus 5 effort xhigh/max + thinking 关 → 改发 `high` | effort 面 | OCC-108 §5 结转 |
| `--input-format stream-json` 无 message id 注入 tool call 并入首条 | `-p`/SDK 输入面 | OCC-108 §5 结转 |
| `/cd` 挪到同 ID 既有 transcript 静默覆盖 | 会话持久化面 | OCC-108 §5 结转 |
| 后台会话及子代理无法编辑自己 `git worktree add` 的 worktree | worktree/后台面 | OCC-108 §5 结转 |
| 后台会话启动恰逢 marketplace 刷新 → 无 plugin skills | plugin 加载竞态 | OCC-108 §5 结转 |
| SDK MCP 握手确认丢失 → 无限挂起(官方 70s 超时) | MCP 面 | OCC-108 §5 结转 |
| `additionalDirectories` null 字节 → 启动崩溃 / `/add-dir` 损坏 | 输入校验,安全相邻 | OCC-108 §5 结转 |
| 首启新装默认 default 而非 auto mode | auto-mode 面 | OCC-108 §5 结转 |
| 多并行子代理 TUI 卡顿(进度 tick 替换不堆叠) | 渲染面 | OCC-108 §5 结转 |
| managed-settings `disableAutoMode` 中到达不迁回 | auto-mode 面(依赖 managed-settings 面) | OCC-108 §5 结转 |
| "切 Opus 1M" 提示在已是 1M 时出现 | `/model` 面 | OCC-108 §5 结转 |
| tmux-over-SSH 后台会话选中复制走 OSC 52 回退 | 终端面 | OCC-108 §5 结转 |
| `claude mcp add --header` / `add-json` 帮助文本写错 transport | 帮助文本,小 | OCC-108 §5 结转 |
| GNU screen / screen 型 tmux 斜体渲染成高亮块 | 渲染面 | OCC-108 §5 结转 |
| MCP server 菜单复制快捷键提示 | UI 小修 | OCC-108 §5 结转 |
| `Cwt` noteHookFailure pill(2.1.248 结转) | UI pill 专项 | OCC-108 §6 结转 |
| `--restricted` / `CLAUDE_CODE_RESTRICTED=1`(2.1.248 结转) | 专项轮 | OCC-108 §6 结转(大跨切面新安全模式) |
| 子代理首调模型 404 → 会话 fallback 模型链 + 错误细节(2.1.247 结转) | AgentTool LIVE 面 | OCC-107 §7 结转最高优先 |
| hook/后台 MB 级错误输出会话级限额核对(2.1.247 结转) | `outputLimits.ts` 面 | OCC-107 §7 结转最高优先 |
| **`CLAUDE_CODE_SUBAGENT_MODEL` 改为默认而非覆盖**(agent 定义 `model:` 与逐次指定优先) | `src/utils/model/agent.ts:43` 现为覆盖语义,官方改为默认层 | 新条目(本轮未落地,下轮候选首位) |
| **模型非常识 Claude 时默认提交尾注改 `Co-Authored-By: Claude Code`** | `src/utils/attribution.ts` 面 | 新条目,需取证尾注判定链 |
| **`/effort` 按模型保存默认级别** | effort 面 | 新条目 |
| **重试时丢弃畸形 tool call 坏输出(含 Bedrock/Vertex/Foundry)** | query 重试运行路径 | 新条目 |
| **MCP server 名在错误/菜单/命令结果中的消毒** | MCP 面 | 新条目 |
| **footer PR badge 改直调 GitHub API(`gh auth token`/`GH_TOKEN`)** | OCC-98 glab badge 面 | 新条目 |
| **plugin/LSP 安装建议与 auto-mode 默认提议等待输入发送/清空** | 建议/提议 UI 面 | 新条目 |
| **沙箱内 Bash 命令输出文件的创建/回读方式(沙箱命令不能重定向/替换)** | 沙箱面(OCC 经 `sandbox-runtime`) | 新条目,安全相邻 |
| **`ANTHROPIC_CUSTOM_HEADERS` 自 managed/project settings 设敏感头需批准** | `src/services/api/client.ts` 读此头;批准子系统面 | 新条目,安全相邻 |
| **项目级 `.claude/settings.json` `env` 不再设 `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_TMPDIR`/`TMPDIR`/`TMP`/`TEMP`** | settings env 面 | 新条目,安全相邻 |
| auto-mode 默认提议不在无人值守会话出现 | auto-mode 面 | 新条目 |
| CPU 占用优化(削减冗余 UI 重渲染) | 渲染性能,无可取证外表面 | 新条目 |
| 二进制减重 ~5MB + 移除 6 种语言语法高亮 | 构建/打包,不适用 | 新条目 |

### 4c. 无 OCC 对应面(不落地)

| 条目 | 理由 |
|------|------|
| Remote Control 前台子代理工具调用实时流 | 无 Remote Control 子系统(OCC-108 §5 维持) |
| Claude Desktop `SendMessage` 中转回复 | 无 Desktop 中转面 |
| agent teams 队友最终答案经 idle 通知送达 | 无 agent-teams 通知族 |
| 后台子代理回复未具名兄弟/父代理(`from` 为 agent type) | SendMessage/KAIROS 休眠 |
| gateway 存档 Anthropic profile 误当活跃(`/status`/401 重试) | 无 Claude apps gateway 面 |
| cloud 会话模型变更误报 | 无云会话子系统 |
| Remote Control 组织策略禁用时改单条静默通知 | 无 RC 面 |
| `/mcp reconnect`(Remote Control)错误信息 | 无 RC 面(OCC-108 §5 维持) |
| self-hosted runner 卡死 Bash 进程 | 无 self-hosted runner 子系统 |
| `/usage-credits` $0 上限话术 | 无 `/usage-credits` 面 |
| `--worktree --tmux` gitlab MR 抓取 | 无此面 |
| Ctrl+G emacs `/dev/tty`(后台会话) | 后台会话面休眠 |
| `claude --bg --model fable` Max 计划 usage credits 询问 | BG/gateway 面休眠 |
| 后台会话丢 Vertex/Bedrock gateway env(`ANTHROPIC_*_BASE_URL` + `CLAUDE_CODE_SKIP_*_AUTH`) | BG + gateway 面无 |
| `/ultrareview` 云会话启动失败早停 | 无云会话 |
| cloud 会话创建遇 GitHub 瞬断改提示重试 | 无云会话 |
| 云会话网络代理断连工具结果点名主机/原因 | 无云会话 |
| `/schedule` MCP connector 说明 | 无 `/schedule`/cloud routine 面 |
| 自家子代理消息措辞(会话内 worker) | SendMessage/KAIROS 休眠 |
| 后台子代理/fork transcript 占位符 "Message @name…" | BG 面板休眠 |
| Bedrock `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 启动优化 | Bedrock+Desktop host 面 |
| managed settings 批准对话框只列变更项 | 无 managed-settings 批准子系统 |
| Claude in Chrome 权限检查收编 | 无 Chrome 扩展面 |
| 席位制 Enterprise 默认模型改 Opus 5 | 无席位制订阅面 |
| analytics 登录前不因 managed settings 关闭 | analytics 为 stub |
| server-managed settings 弱化沙箱需批准 | 无 server-managed-settings 面 |
| managed-settings 批准提示网关重签后复现 | 无 managed-settings 面 |
| 禁用 `/bug`/`/share` 误报 `/feedback` 禁用 | OCC 无 `/bug`/`/share` 命令 |
| `/radio` 可用性扩展 | OCC 无 `/radio` |
| [VSCode] 登录屏第三方供应商文档锚点 | 无 VSCode 扩展 |
| [VSCode] Remote Control 横幅改 footer pill | 无 VSCode 扩展 |

## 5. 验证

**定向套件**(本轮新增/改动的 7 个测试文件,`bun test` 逐文件直跑):`searchTargetGate251`、`symlinkResolutionStash251`、`scriptPathGate251`、`projectScopeEnvBlocklist251`、`pluginPathTraversal251`、`integerAttrArithEval251`、`grepTool210`(修改)合计 **123 pass / 1 skip / 0 fail,273 expect()**。`grepTool210` 单跑 11 pass / 0 fail(见下回归修复)。

**全量门 `scripts/ci-test.sh`**(411 文件,逐文件独立进程):改动树 **3344 pass / 13 fail / 12 skip**;基线(HEAD `d513ad9`,即上轮 2.1.315 合并点,406 文件)**3236 pass / 14 fail / 11 skip**。净增 +108 pass、−1 fail、+5 文件。13 个失败分布在 8 个文件:`feedback-ai`、`goal-gate`、`goal-panel`、`repl-interactive`、`resume-command-name`、`trust-gate`、`version-2.1.208-screen-reader`、`version-2.1.210-plan-approval` —— 与 OCC-108 §4a 已用干净树 A/B 核实的**既有环境性失败名单逐一对应**(基线的第 9 个 `commands-behavior` 本轮通过),全部为 tmux/真模型 e2e 族。

**原始 `bun test` A/B 复核**:`git worktree` 干净树与改动树各全量裸跑,失败集合取差:仅改动树有的 6 个(`autoMode207`×3、`sandboxRipgrepScope232`×3)在逐文件隔离下全部通过 → 共享进程 `mock.module()`/记忆化状态串扰导致的顺序性 flake(机制见 `scripts/ci-test.sh` 头注);仅基线有的 4 个为同类 tmux flake。**零真实回归**。

**回归与修复**:Gap-109b 的 PATH 名 ripgrep 守门(忠实于二进制 `S2t`/`V()`)在 `bun test` 环境下(`ripgrepCommand()` 回退为裸 PATH 名 `rg`)会拒绝 cwd 之外的搜索目标 —— `grepTool210` 的计数合计与非法正则两用例原用 `tmpdir()` fixture,触发忠实拒绝。修复:fixture 迁入 `getCwd()` 下(`makeFixtureDir` + `afterAll` 清理),断言原样保留。生产捆绑包中 `isInBundledMode()` 为真、rg 为内嵌绝对路径,守门休眠,与官方二进制一致(官方 rg 恒为绝对路径)。

**Lint**:biome 对本轮全部 28 个改动文件 → **0 error**(2 warning 为 WorkflowTool primitives 的 `void`→`undefined` 返回类型风格项,6 info;error 为门控线)。

**构建与行为冒烟**(behavior-driven-done 门):
- `bun run build` 绿:`dist/cli.js` 28.97 MB,MACRO.VERSION 注入。
- 无头真模型冒烟:`bun dist/cli.js -p` → 按指令回复,exit 0,无挂起。
- tmux REPL 冒烟:启动屏完整渲染(版本号/模型/项目行),真模型往返一轮按指令回复,token 计数正常。

**安全自查**:全 diff 与新文件扫描 —— 无硬编码密钥/令牌/私钥;新增行无 `eval`/`new Function`/`child_process`/`spawn`/`fetch`/网络原语/混淆(唯一 `fromCharCode` 为测试中的 NUL 字节常量);未引入任何新 URL;两个新模块(`symlinkResolutionStash`、`searchTargetGate`)均为纯拒绝型守门逻辑,无外部副作用面。

## 6. 结论

Gap-109a..f 六项全部落地:每一项均先对官方 2.1.251 linux-x64 ELF 取证(机制、消息串、顺序),再逐字节移植到 OCC,消息串与官方逐字一致,未发明任何官方不存在的兜底/上限/启发式;每项均有定向测试覆盖,全量门零回归。至此 OCC 追平官方 2.1.251 中**全部可取证、可移植的安全修复**。

§4b 保留的两项暂存残项(Gap-109b 的 fd-pinning/逐结果审判车道的完整移植、Gap-109a 可能的更深 `Uzt`/`LC` 车道)均因二进制取证边界模糊或需大规模专项反编译,按 `aligning-with-official-binary` 纪律 STOP 暂存,不在本轮猜测实现。

版本:发布 **2.1.316**(tag `v2.1.316`,CI `publish.yml` 自动构建发布)。
