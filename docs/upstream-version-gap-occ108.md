# OCC-108 版本差距台账(官方 2.1.248 / 2.1.250 / 2.1.251)

日期:2026-08-29(自动化轮次,Asia/Shanghai)。上一轮:OCC-107(追齐 2.1.247,发布 2.1.314,base `8b4f391`)。

## 1. 版本状态(三方核实)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.251**(2026-08-28T15:34Z 发布);2.1.250(2026-08-27T22:27Z)、2.1.248(2026-08-27T20:35Z);**2.1.249 从未发布** |
| GitHub `anthropics/claude-code` releases | v2.1.251 / v2.1.250 / v2.1.248 均存在,各有 release notes |
| 官方二进制取证源 | 2.1.248 linux-x64 官方 npm 包(`anthropic-ai-claude-code-linux-x64-2.1.248.tgz`,ELF + 53.5 MB strings dump)——本轮 Gap-108a/b/d 全部取证于此 |
| OCC 基线 | 追齐至官方 **2.1.247**(OCC-107;release 2.1.314;`dist/cli.js` 需重建) |

本轮 gap = **2.1.248**(changelog 49 条,OCC-107 §6 已逐条分类)+ **2.1.250**(no-op)+ **2.1.251**(见 §5 全量分诊)。

## 2. 逐版本结论

- **2.1.248** — 落地 3 项(Gap-108a / 108b / 108d,§3);stage 2 项(`--restricted` 新模式、`Cwt` noteHookFailure pill,§6);其余按 OCC-107 §6 分诊维持。
- **2.1.250** — no-op。release notes 仅 "Bug fixes and reliability improvements" 1 条;本轮上半场 248→250 二进制 strings diff 仅见 minify 改名,无新 env/settings/hook/命令面(与 OCC-107 对 2.1.220 的 no-op 判定同法)。
- **2.1.251** — 本轮开跑时(01:00)GitHub changelog 尚未落全,上半场按二进制 strings 扫描判为"仅内部 codename flag"。轮内 v2.1.251 完整 changelog 落地(~35 条,含 **5 条安全修复**)→ 本轮做 changelog 级全量分诊(§5),**全部留下一轮**,安全项列为下一轮最高优先(沿用 OCC-107 对周期内新发 2.1.248 的"轮内分诊、下轮落地"先例)。

## 3. 本轮落地项(均对官方 2.1.248 ELF 取证)

### Gap-108a hooks stdout 非法 JSON 报告(对应 2.1.248 changelog 条目:`{…}` 输出不再当纯文本)

官方行为:hook stdout 以 `{` 开头却不是合法 JSON(或不满足输出 schema)时,不再静默按纯文本处理,而是产生**带解析信息的 hook 错误**。

OCC 落地(`src/utils/hooks.ts`):
- `parseHookOutput` + `formatHookJsonValidationError` + `hookOutputSchemaHint`:zod 4.3.6 union schema 的校验错误归一为**单条顶层 `invalid_union`**,再由 `formatHookJsonValidationError` 展开成含具体分支失败原因的提示文本(与官方错误串化器逐字对齐)。
- 主 hook 生成器与聚合执行器两处消费点均按 `validationError && result.status !== 2` 门控(官方:退出码 2 路径自有语义,不被 JSON 校验错误覆盖)。
- `wrapHookErrorWithStderr`:错误消息携带 stderr 上下文。
- 同步删除旁路文件 `src/utils/hooks/hookExit2Block.ts`(及其测试),exit-2 阻断语义折叠回主生成器的官方结构(结构对齐官方,消除双实现漂移)。

### Gap-108b agent frontmatter `experimental.cacheTtl`(2.1.248 官方 `uBt`/`qTt`/`Tvt`)

官方行为:markdown agent frontmatter 可设 `experimental.cacheTtl`(`"5m"` / `"1h"`,键名大小写不敏感),在无更高优先级 TTL 来源时决定该 agent 请求的 prompt cache TTL;"1h" 在订阅超额期间被忽略;JSON 定义的 agent **不**获得此字段;官方 plugin builder 会设置它。

OCC 落地(6 文件):
- `src/tools/AgentTool/loadAgentsDir.ts`:`extractAgentCacheTtl()`(官方 `uBt` 逐字移植)+ `BaseAgentDefinition.cacheTtl` 字段 + markdown builder 条件展开。
- `src/utils/plugins/loadPluginAgents.ts`:plugin agent 同样解析(与官方 plugin builder 一致;不同于 `permissionMode`/`hooks`/`mcpServers` 的 plugin 禁用面——那些仍按 PR #22558 语义拒绝)。
- `src/services/api/claude.ts`:`resolvePromptCacheTtlOverride`(官方 248 `qTt`)在 settings 与 `ENABLE_PROMPT_CACHING_1H` 之间插入 `agent_frontmatter` 层,带 `!(ttl==='1h' && isUsingOverage)` 超额守卫;`resolvePromptCacheTtl`(官方 248 `Tvt`)重构为官方形状(先算 `isOverage = isSubscriber && !ignoreOverage && isUsingOverage`,override 在订阅门之前返回);`should1hCacheTTL`/`getCacheControl`/`Options`/`addCacheBreakpoints`/`buildSystemPromptBlocks` 全链路透传 `agentCacheTtlOverride`。
- `src/query.ts`(`QueryParams` 字段 + `deps.callModel` 透传)、`src/utils/forkedAgent.ts`(`CacheSafeParams` 携带——TTL 改变 cache_control 写入,fork 必须复用以共享 agent prompt cache)、`src/tools/AgentTool/runAgent.ts`(`agentDefinition.cacheTtl` 传入 query + onCacheSafeParams)。
- wire shape 不变:仅 `"1h"` 进 `cache_control`(`ttl==="1h" ? "1h" : undefined`),5m 保持隐式。
- 决策留痕:OCC 无 agent frontmatter zod schema,官方 `.describe()` 文本落为 `BaseAgentDefinition.cacheTtl` 的字段注释(不发明 schema);`parseAgentFromJson` 刻意不解析此字段(官方保真);`loadAgentsDir ↔ loadPluginAgents` 的运行时循环为安全形态(函数声明提升 + 惰性调用,与官方结构一致)。

### Gap-108d hook 指向缺失插件脚本的专用错误(官方 `i$t` 启发式)

官方行为:hook 命令指向**不存在的插件脚本路径**时,不再落入通用退出码错误,而是给出专用提示:``Run `/plugin` to reinstall '<pluginId>' or remove it from settings.``

OCC 落地(`src/utils/hooks.ts`):`looksLikeMissingHookScript` 启发式 + 主生成器在通用 exit-2 块**之前**的专用分支;与 Gap-108a 的异步公告判定(`isAsyncHookAnnouncement`)、多 JSON 文档判定(`isMultipleJsonDocuments`)共同构成官方输出解析序。

## 4. 验证(全部实测)

| 项 | 结果 |
|----|------|
| 新增单元测试 | `hookOutputParsing.test.ts` 42 pass + `agentCacheTtl108.test.ts` 8 pass + `prompt-cache-ttl.test.ts` 新增 describe 8 cases(该文件 29 pass) |
| 新增 e2e | `test/e2e/version-hooks-2.1.248.e2e.test.ts` 12 用例:4 个运行时 `bun -e` 探针、5 个源码 grep、离线 `-p` stream-json 阻断形状、CI 门控真模型 exit-1 非阻断、tmux REPL 阻断 |
| 全量门 `scripts/ci-test.sh`(406 文件逐文件独立进程) | **3236 pass / 14 fail / 11 skip**(OCC-107 基线 3172 pass / 14 fail / 404 文件;14 fail 全部属既有环境性失败,见 §4a) |
| 构建 | `bun run build` → `dist/cli.js`(版本号仍 2.1.314,发版时 bump) |
| lint | `bun run lint`(Biome,formatter 关闭)对本轮改动文件零告警 |
| 真模型 `-p` | `echo "say PONG" \| occ -p` → `PONG`,exit 0 |

### 4a. 全量门说明

沿用 OCC-107 §4a 纪律:本机全量跑包含 tmux/真模型 e2e,其中一撮属**既有环境性失败**(OCC-107 §4a 已用干净树 A/B 双向核实):`feedback-ai`、`goal-gate`、`goal-panel`、`repl-interactive`、`resume-command-name`、`trust-gate`、`version-2.1.208-screen-reader`、`version-2.1.210-plan-approval`、`workflow-permission-dialog-ctrl-g`。

本轮全量门(改动树):**3236 pass / 14 fail / 11 skip,406 文件**。14 个失败用例分布在 9 个文件:`commands-behavior`(1:`/feedback` 真建-真关 GitHub issue 用例,与 `feedback-ai` 同族,依赖 live gh + 真模型)、`feedback-ai`(1)、`goal-gate`(2)、`goal-panel`(1)、`repl-interactive`(1)、`resume-command-name`(1)、`trust-gate`(4)、`version-2.1.208-screen-reader`(1)、`version-2.1.210-plan-approval`(2)。上轮已知失败 `workflow-permission-dialog-ctrl-g` 本轮在改动树与干净树均通过。

**干净树 A/B 复核(本轮实测)**:`git stash -u` 暂存全部本轮改动 → 干净树 `bun run build` → 对上述 9 个文件逐一重跑 → `git stash pop` 还原。干净树结果:`commands-behavior` 15 pass/1 fail、`feedback-ai` 5 pass/1 fail、`goal-gate` 0 pass/2 fail、`goal-panel` 0 pass/1 fail、`repl-interactive` 2 pass/1 fail、`resume-command-name` 0 pass/1 fail、`trust-gate` 1 pass/4 fail、`version-2.1.208-screen-reader` 0 pass/1 fail、`version-2.1.210-plan-approval` 0 pass/2 fail —— **9 个文件、14 个失败用例与改动树完全一致**。结论:本轮改动未引入任何新回归,14 fail 全部为既有环境性失败。

## 5. 2.1.251 全量分诊(changelog 级;本轮不落地,留下一轮)

轮内官方发布(2026-08-28)。本轮上半场的二进制 strings 扫描仅见内部 codename flag(changelog 当时未落全);v2.1.251 完整 changelog 落地后按 changelog 级重新分诊如下。**下一轮 gap = 2.1.251**,落地前逐项做二进制取证(`aligning-with-official-binary`:不取证不移植)。

**安全/新模式(下一轮最高优先):**

| 项 | OCC 面对应 |
|----|------|
| 文件工具(Read/Write/Edit)权限检查**后**工作目录内 symlink 被换 → 可读写批准位置之外 | OCC 有完整文件工具面;TOCTOU 修复,需逐点取证 |
| Grep/Glob 对经 symlink 搜索路径到达的文件不应用 `Read(...)` deny 规则 | OCC 有完整面;同上 |
| Workflow 工具在权限检查前读取(且在错误中引用)`scriptPath` 之外的路径 | OCC 有 workflow 引擎(WORKFLOW_SCRIPTS 在 6 旗标白名单内,活路径) |
| project settings 可启用详细 beta tracing / 原始 API body 日志;低 scope beta tracing 端点绕过 managed/host 固定的 OTLP collector | OCC settings + 遥测面 |
| marketplace 条目声明的 plugin 命令可指向 plugin 目录之外(路径穿越,现在拒绝) | OCC plugin 加载面 |
| **`PreModelSwitch`/`PostModelSwitch` hook 事件**(阻断/确认/批注模型切换);`SessionStart` resume hook 收到会话陈旧度与预估重缓存开销 | 新 hook 事件面,需专项反编译 |

**有 OCC 对应面 → staged(需专项取证):**

| 项 | 备注 |
|----|------|
| `/cost` 每会话 prompt-cache 行(命中率/miss/重缓存 token/warm-cold)+ status line `prompt_cache` 对象 | OCC 有 `/cost` + status line 面 |
| `/usage` Spend limit 条 + `rate_limits.spend_limit`(Claude apps gateway) | gateway 面,部分适用 |
| `claude --help` 增加 `attach/logs/stop/respawn/rm`;`--resume` 对运行中后台会话点名 `claude attach <id>` | OCC 有自研 daemon 子命令面,核对帮助文本 |
| 仅 thinking 的回合后卡在 "text content blocks must be non-empty" | 请求/消息处理面 |
| Opus 5 effort xhigh/max + thinking 关闭 → 改发 `high` | OCC 有 effort 面 |
| `--input-format stream-json` 无 message id 的客户端注入 assistant tool call 被并入第一条、结果丢失 | `-p`/SDK 输入面 |
| `/cd` 把会话挪到同 ID 既有 transcript 时静默覆盖 | 会话持久化面 |
| 后台会话及其子代理无法编辑自己 `git worktree add` 出的 worktree 内文件 | OCC worktree/后台面 |
| 后台会话启动时恰逢另一进程刷新 marketplace → 无 plugin skills | plugin 加载竞态 |
| SDK MCP server 握手确认丢失 → 无限挂起(官方改 70s 超时、仅标该服务器失败) | OCC MCP 面 |
| `additionalDirectories` 含 null 字节 → 启动崩溃 / `/add-dir` 与后续 settings 更新损坏 | 输入校验面,安全相邻 |
| 首启新装账户默认进 default 而非 auto mode | auto-mode 面 |
| 多并行子代理 TUI 卡顿(每秒进度 tick 替换不堆叠) | 渲染面 |
| managed-settings `disableAutoMode` 会中到达不迁回 | auto-mode 面 |
| "切 Opus 1M" 提示在已是 1M 时出现 | `/model` 面 |
| tmux-over-SSH 后台会话选中文本复制走 OSC 52 回退 | 终端面 |
| `claude mcp add --header` / `add-json` 帮助文本写错 transport | 帮助文本,小 |
| GNU screen / screen 型 tmux 中斜体渲染成高亮块 | 渲染面 |
| MCP server 菜单复制快捷键提示 | UI 小修 |
| `/mcp reconnect`(Remote Control)错误信息 | 无 Remote Control 面 → 实际不落地 |

**无 OCC 对应面(不落地):** Remote Control 实时流/禁用提示;Claude Desktop `SendMessage` 中转;cloud 会话(模型变更误报、ultrareview 等待);self-hosted runner 卡死 Bash 进程;agent teams 通知族(3 条);gateway 存档 profile `/status` 误报;`/usage-credits` $0 上限话术;`--worktree --tmux` gitlab MR 抓取;Ctrl+G emacs `/dev/tty`(后台会话);`--resume` 后台会话命名(与上帮助条重叠部分)。

## 6. Staged(已取证记录,本轮不落地)

| 项 | 取证与理由 |
|----|------|
| **`--restricted` / `CLAUDE_CODE_RESTRICTED=1`**(2.1.248) | 本轮上半场已取证其接线与行为面:移除跑命令/代码的内置工具与 WebFetch(除非 `--tools` 点名)、文件工具围栏在工作目录内、拒绝 `bypassPermissions`、忽略 user/project/local settings。大跨切面新安全模式(工具过滤集 × 目录围栏 × 权限/信任体系互操作),逐点反编译工作量大,专项一轮落地更安全 |
| **`Cwt` noteHookFailure pill**(2.1.248) | hook 失败的 UI pill;需 `Cwt` 组件反编译 + OCC Ink 渲染面对接,留专项 |
| 结转 | OCC-107 §7 两项最高优先(子代理 404 fallback 链、MB 级错误输出会话级限额核对)+ OCC-107 §6 其余未落地项 + 本文 §5 全部 |

## 7. 结论

OCC 本轮落地官方 **2.1.248** 的 3 项可取证对齐项(Gap-108a/b/d),stage `--restricted` 与 `Cwt` pill(取证留痕);2.1.250 核实 no-op;2.1.251 完成 changelog 级全量分诊(§5,含 5 条安全修复 → 下一轮最高优先)。本轮发布 **2.1.315**。下一轮 gap = **2.1.251**(安全项优先)+ 本文 §6 结转清单。
