# OCC-105 — 2026-08-26 版本追齐(官方 2.1.242/2.1.243/2.1.245;落地 Sonnet 5 $2/$10 定价 + Default 行动态后缀、完整 prompt-cache TTL 子系统;发布 2.1.312)

## 1. 版本状态(三方核实)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = **2.1.245**(2026-08-25T04:45Z),stable = 2.1.231;next = 2.1.246(2026-08-25T19:17Z,仅 next 通道,无 changelog 条目、无 GitHub Release → 按"跳过未正式发布版本"规则归**下一轮**) |
| GitHub releases | **v2.1.245 = Latest**(2026-08-25T05:13Z);无 v2.1.242/v2.1.244/v2.1.246 |
| changelog | 2.1.242 / 2.1.244 **无条目**;2.1.243 为大版本(~60 条);2.1.245 仅 1 条 |
| OCC(追齐状态) | OCC-103/104 已追齐 2.1.241(发布 2.1.310/2.1.311)→ **本轮为 gap 对齐轮:241 → 242 → 243 → 245** |

二进制取证(官方平台包 `@anthropic-ai/claude-code-linux-x64`,`npm pack` 原样解包,`strings -n 8` dump):

| 版本 | ELF md5 | 备注 |
|------|---------|------|
| 2.1.241 | `8326230ad538d59d4828ebf44e3932ea` | 与 OCC-103/104 取证相同(基线) |
| 2.1.242 | `30fd9bd387f693be7da7c59b9800149e` | 无 changelog;体积 +35 MB |
| 2.1.243 | `fd2f13ae50f4464dfa569d7b85a839e5` | 大版本 |
| 2.1.245 | `9e348ce403e3040023e70bce9fb74765` | glibc 修复版 |

重复任务护栏:开工前已核实 workspace 内无其他 running/queued 的版本追齐 issue;本 issue 即当前运行中的追齐任务。

## 2. 逐版本结论

### 2.1.242(无 changelog)
字符串面 +35 MB,抽样核实主体为 **Bun build 布局变化产生的重排/重定位噪声**(大量"新"字符串为同一标识符在新布局下的不同上下文),命名面(新 env / settings key / 命令 / hook)逐一对照后**无独立于 2.1.243 的可移植新面** → 不单独落地,并入 243 处理。

### 2.1.243(大版本,~60 条)
全量逐条分诊(见 §4/§5)。本轮落地 2 个高价值、可字节验证的可移植子系统:

- **Gap-105a:Sonnet 5 定价转正 + `/model` Default 行动态后缀**(changelog:"Updated the /model picker … to show Sonnet 5's $2/$10 per Mtok pricing as its standard list price")
- **Gap-105b:prompt-cache TTL 子系统**(changelog:"Added promptCacheTtl and subagentPromptCacheTtl settings …"),含 1h cache_control 随附的 `extended-cache-ttl-2025-04-11` beta 头

### 2.1.245(仅 1 条)
"Fixed a crash on startup on Linux distributions that ship glibc 2.44"。官方修复面向其原生 ELF 发行物;OCC 以 Bun 运行 `dist/cli.js`(非该原生打包路径),**无对应代码面 → N/A,不落地**。

## 3. 本轮落地项(均逐字节对照官方 2.1.245 / 2.1.241 ELF 取证)

### Gap-105a — Sonnet 5 tier_2_10 定价 + Default 行动态后缀

- `src/utils/modelCost.ts`:新增 `COST_TIER_2_10`(input $2 / output $10 / cache write 5m $2.50 / 1h $4 / read $0.20 / web search $0.01,取自官方 `pricing_tiers` 表);`MODEL_COSTS[claude-sonnet-5]` 指向该档;sonnet-4-x 仍为 `COST_TIER_3_15`($3/$15)。
- `src/utils/model/modelOptions.ts`:PAYG Default 行由硬编码 `$3/$15` 改为官方 `se()` 语义——后缀 = 解析后默认模型自身目录价(仅 "tier" attribution),env 覆盖时显示 ` · Set by ANTHROPIC_DEFAULT_MODEL`(替代定价);定价显示仅 firstParty(官方 `XOn` 门)。
- **本轮新取证(2.1.245)**:env attribution 的 env 源**只有** `ANTHROPIC_DEFAULT_MODEL` —— `Lx()` 经 `vy()` 读取启动时闩存的 `initialEnvDefaultModel`,其初始化站点为 `ui(_.ANTHROPIC_DEFAULT_MODEL ?? null)`(字节 274954609 import 组 → `GS()` = `n().modelSelection.initialEnvDefaultModel()`,字节 303993884/304019001)。即 `ANTHROPIC_DEFAULT_SONNET_MODEL` 等分层变量**不**触发 env attribution。微分歧备注:官方为启动闩存、OCC 为实时读 `process.env`,仅当 env 在会话中途变化时行为不同,不影响任何正常用法。
- 归属链中 org / enforced / entitlement 三支依赖 managed-settings 子系统(OCC-46 staged),OCC 本轮只实现 env-vs-tier 分支。
- 配套:三个 Sonnet 5 picker 行改用 `COST_TIER_2_10`。

### Gap-105b — prompt cache TTL 解析子系统(官方 uFr/HUr/AR/NMs)

- `src/services/api/claude.ts`:替换旧版单一 `should1hCacheTTL`,按官方层级完整移植(优先级从高到低):
  1. `FORCE_PROMPT_CACHING_5M` → `{ttl:"5m", reason:"force_5m_env"}`
  2. 每线程环境变量 `CLAUDE_CODE_PROMPT_CACHE_TTL`(主线程源)/ `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`(其余),`enum 5m|1h`,非法值静默回落(官方 `.catch(undefined)`)→ `{reason:"env"}`
  3. 每线程 settings `promptCacheTtl` / `subagentPromptCacheTtl` → `{reason:"setting"}`
  4. `ENABLE_PROMPT_CACHING_1H`(bedrock 另认 `ENABLE_PROMPT_CACHING_1H_BEDROCK`)→ `{ttl:"1h", reason:"enable_1h_env"}`
  5. 订阅者门:claude.ai 订阅且未超额 + query source 命中 allowlist → `{ttl:"1h", reason:"subscriber"}`;allowlist 来自 `tengu_prompt_cache_1h_config`,烘焙默认 `["repl_main_thread*","sdk","auto_mode","memdir_relevance"]`(官方 kzt),会话内闩存
  6. 兜底 `{ttl:"5m", reason:"default"}`
  主线程源匹配 = 官方 `NMs` 四模式(尾 `*` 为前缀匹配)。替换掉了旧实现的资格闩存与 `USER_TYPE==='ant'` 覆盖(245 已无)。
- `src/utils/settings/types.ts`:新增 `promptCacheTtl` / `subagentPromptCacheTtl`,`z.enum(['5m','1h']).optional().catch(undefined)`,`.describe()` 文案与二进制逐字节一致。
- `src/constants/betas.ts` + `src/utils/betas.ts` + 请求构建器:1h `cache_control` 随附 `extended-cache-ttl-2025-04-11`(官方单出现字符串 `G8`,推送点 `if(N==="1h"&&hh()&&!me.includes(G8))me.push(G8)`;门 `hh()`/241 `hB()` = provider ∈ firstParty|anthropicAws|anthropicGoogleCloud|foundry 且未禁用实验 betas;hipaa-taint 分支省略——OCC 无分类器 taint 注册表,永不触发)。
- 线形不变:仅 `"1h"` 进入 `cache_control`,5m 保持隐式。

### 测试(30 个新/重写单测,全绿)

- `src/services/api/__tests__/prompt-cache-ttl.test.ts`(21 个):2.1.108 回归 ×4、kzt/NMs 模式 ×2、每线程 env ×4、settings ×3、订阅者门 ×5(含超额实时读、allowlist 闩存)、线形 ×3。订阅态走**真实 auth 路径**(`CLAUDE_CODE_OAUTH_TOKEN` → scopes `['user:inference']` → 订阅者;`ANTHROPIC_API_KEY` → 非订阅者),无模块 mock。
- `src/utils/__tests__/modelCostSonnet5Tier105.test.ts`(9 个):tier 常量、MODEL_COSTS 映射、`$2/$10 per Mtok`、sonnet-4-6 保持 `$3/$15`、未知模型无定价、Default 行三态(定价 / env attribution / 未知 env 模型仍显示 attribution)。

## 4. 验证(全部实测)

- **构建**:`bun run build` 绿,`dist/cli.js` 28.92 MB(30,327,987 B),`MACRO.VERSION=2.1.311`,`BINARY_NAME=occ`。
- **全量 src 套件**:`bun test src` = **2201 pass / 8 fail / 5096 expect()**(2209 tests / 228 files)。8 个失败与基线完全一致(2.1.202 telemetry ×2、2.1.216 permission-telemetry ×1、2.1.218 agentHookTrust ×5,历轮 A/B 核过的环境依赖预存项),**无回归**。
- **对齐类 e2e**(跑构建产物 `dist/cli.js`):`occ-versioning` + `commands-alignment` + `version-2.1.219-*` 6 件 = **55 pass / 0 fail / 190 expect()**。
- **2.1.221/REPL e2e**:`version-2.1.221-autocompact` **9 pass / 0 fail**(批量跑时 3 个 live-API 用例被 bun 5s/用例上限误杀,单独以 `--timeout` 复跑全绿);`resume-interrupted-turn-221` 1 pass;`repl-interactive`(tmux 真机 REPL)3/4,唯一失败为 "Shift+Tab auto-mode opt-in dialog"——OCC-44 已 git-stash A/B 核过的**预存**失败,与本轮改动无关。
- **`-p` 管道 + 真机 REPL smoke**:`bun dist/cli.js --version` → `OCC 2.1.311`;`echo "say PONG" | bun dist/cli.js -p` → `PONG`,exit 0;tmux 启动 REPL → `/model` picker:
  - 宿主配置(`ANTHROPIC_DEFAULT_MODEL` 未设、自定义 base URL + 分层默认变量)→ Default 行 `Use the default model (currently glm-5.2)`,**无后缀** —— 与官方语义逐分支推演一致(无 env attribution;tier 定价查询命中未知模型 → 空)。
  - `ANTHROPIC_DEFAULT_MODEL=claude-opus-4-5` → `Use the default model (currently claude-opus-4-5) · Set by ANTHROPIC_DEFAULT_MODEL` —— 官方文案逐字节一致。
  - 定价态(` · $2/$10 per Mtok`)由 `getDefaultOptionForUser()` 单测覆盖(真实生产函数、firstParty PAYG、无 env 覆盖 → 默认落 `claude-sonnet-5` → tier_2_10)。

## 5. 2.1.243 其余项分诊(本轮未落地,逐项理由)

**N/A(依赖 OCC 不存在/已裁剪的子系统,二进制/源码核实):**

| 项 | 理由 |
|----|------|
| 2.1.245 glibc 2.44 崩溃修复 | OCC 以 Bun 跑 `dist/cli.js`,非官方原生 ELF 发行路径,无对应代码面 |
| `/usage` Loops breakdown、`/loop` 空唤醒折叠 | OCC 无 loop engine(triage 时源码核实) |
| VSCode 三项 | OCC 无 VSCode 扩展 |
| Claude in Chrome 原生宿主、computer use macOS Finder | OCC 无该两个子系统 |
| Keyless Console sign-in(`/login`)、`/web-setup` GitHub 行 ×2、desktop app MCP "Invalid redirect URI" | 依赖 Anthropic Console/claude.ai web/桌面端后端 |
| `modelPricing` managed setting、`/status` Skipped sources 行、`/mcp`+`/plugins` managed 标记、companyAnnouncements | managed-settings 子系统(与 OCC-46 staged 同批)+ 组织后端合约价 |
| zstd 原生安装压缩、原生体积/内存优化 ×3 | 官方原生打包工程,非代码面 |
| 组织遥测归因改进 ×2 | OCC analytics 为 stub |
| 跨会话消息 socket 修复 ×2 | OCC 的 inbox 通道为休眠态(未启用),同 KAIROS 约束 |

**Staged(有 OCC 对应面,需专项逐点反编译/行为核对,留后续轮次):**

| 项 | 备注 |
|----|------|
| **hook `if` 条件 `$()`/反引号误触发修复** | 安全相关,建议**下一轮优先**(需对 OCC hook 匹配路径做逐点取证) |
| `modelPicker` setting(replaceBuiltInOptions/options) | 大特性:picker 行注入/替换,涉及 option 身份与排序全链路 |
| `/tasks`+agent 详情显示子代理 model/effort | 需在 AgentTool 运行时记账 |
| `-p`/SDK 远程 MCP 断线自动重连 | 传输层行为变更 |
| `/model` 忽略 Ultracode 选择修复 | 需 fast/ultracode 选择链路取证 |
| `/resume` 50 条上限 → 滚动加载 | picker 分页 |
| 无响应 ~3 分钟超时+重试+错误行 | 请求超时路径 |
| auto mode 启动缓存禁用 / 短暂过载误拒 ×2 | auto-mode 状态机 |
| 后台子代理最后一个后台 Bash 完成不唤醒 | 唤醒链路 |
| 云会话重启后 pending hook/通知被重发为 prompt | resume 路径 |
| `--agents` 非法 JSON 报错、`/status` 无效条目文件名、`/clear` 后 `/rename` 名残留、Ctrl+R 历史坏行、容器内文本重绘切边、spellcheck emoji | 各自独立小修复,逐点取证后批量 |
| Ctrl+[ vim modifyOtherKeys | OCC vim 为自研全量实现,需按 OCC-44 的 vim 专项流程 |
| HTTPS_PROXY/no_proxy 大小写、sandbox 网络违规细节丢失、sandboxed Bash prompt 不再列允许主机 | 网络/沙箱专项 |
| rate_limits 窗口重置后百分比滞留 | 限额子系统 |
| `--teleport` stash、`/login` SSH 改进、effort+thinking-off 报错文案、`/model`+`/fast`+`/effort` 3P 立即执行 | 小项,逐点取证 |
| plugin marketplace 依赖解析、`/reload-plugins` LSP 残留 | OCC 已裁剪 plugins 面 |
| claude-api skill 的 Sonnet 5 定价文案 | OCC 捆绑 skill 为有意 1 字节 stub(历轮既定) |
| TTL 子系统的两处外围站点:`fork` 进程缓存 cacheScope/cacheTtl 别针、`artifact_comment_reply` TTL 站点 | OCC 无对应 fork 别针机制/该 query source |
| workload identity federation CI token 共享 | GCP WIF auth 专项 |

## 6. 结论

OCC 追齐至官方 **2.1.245**(`latest`;`next` 通道的 2.1.246 无 changelog/无 Release,归下一轮)。本轮发布 **2.1.312**。下一轮优先项:2.1.246 分诊 + hook `if` 条件 `$()`/反引号误触发修复(安全)。
