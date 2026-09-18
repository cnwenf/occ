# OCC-129 — 版本追齐轮：2.1.274 → 2.1.276（2026-09-19）

本轮把 OCC 的上游追踪指针从 Claude Code `2.1.274` 推进到官方 npm `latest`
`2.1.276`。官方版本三角（npm dist-tags）：stable=2.1.267、**latest=2.1.276**、
next=2.1.277。缺口 = 2.1.275（96 条 changelog）+ 2.1.276（1 条，advisor 代理
400 修复）。

取证材料：`npm pack @anthropic-ai/claude-code-linux-x64@{2.1.274,2.1.275,2.1.276}`
三个官方 ELF（md5 分别为 `7137e84f2a7189e6190cf5af3de1dcc4` /
`418eaebf72634e854a5b26f667e14272` / `702857fc5a4a946799d0ae66c531da51`；
275/276 大小同为 232,059,192B）。方法：模块切分
（`\n// Version: 2.1.NNN\n` 头，1872 个模块）+ canon 归一
（chunk 名 / 版本号 / SHA / **ISO BUILD_TIME**）+ 结构化哈希 LCS 对齐 +
同长模块字符位 diff。加入 BUILD_TIME 归一后，275→276 真正变化的模块从 87 个
收敛到 36 个，其中 34 个为纯标识符重编号（同长、全部 diff 区域都是 identifier
token），#1871 为 ELF 尾部二进制噪声，**唯一的语义变化在模块 #489**。

## 2.1.276（1 条）：advisor 代理 400 修复 —— 已完整字节取证并对齐

官方 changelog：

> Fixed every request failing with `400 … Input tag 'advisor_20260301'` when
> `ANTHROPIC_BASE_URL` points at a proxy or gateway (2.1.275 regression)

### 修复点（逐字节验证，v275 vs v276 模块 #489 = advisor 状态/解析模块）

模块 #489 特征：`var h={announcement:void 0,advisorModel:void 0,advisorDeferred:!1,advisorActive:!1}`，
入口 `sEr(e,n,{querySource,resumeActive,configuredRuntimeModel,runtimeOptionsModel,carrier,toolChangesRide})`。
**该模块是 2.1.275 新引入的**（v274 二进制中 `advisorDeferred`/`advisorActive`
均为 0 次命中）——回归正是随它进来的。

v275（回归态）advisor 模型解析函数：

```js
function O(e,n){if(!Bb()||!lL(e))return;let t=yB(),l=[...t.filter((r)=>!w(r)),...t.filter((r)=>w(r))];for(let r of l){let u=p(r,e,n);if(u!==void 0&&l0r(e,u))return u}return}
```

v276（修复态，重命名为 N，并新增 `import{Ia}`）：

```js
function N(e,n){if(!Ia()||!Bb()||!lL(e))return;let t=yB(),l=[...t.filter((r)=>!w(r)),...t.filter((r)=>w(r))];for(let r of l){let u=p(r,e,n);if(u!==void 0&&l0r(e,u))return u}return}
```

其中（v276 逐字节提取）：

```js
function Ia(){return He()==="firstParty"&&es()}
function es(){if(a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return Rw()}
function Rw(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return Iv(e)}
function Iv(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
```

### 回归机理

- `He()` 的 "gateway" 判定基于凭据槽（gatewayAuth/gatewayServerProcess/
  gatewayRequiredByHostPolicy），**与 ANTHROPIC_BASE_URL 无关** —— 代理用户
  的 provider 仍是 `"firstParty"`。
- advisor 启用链（275/276 完全一致，逐字节核对过 `yct/Bb/Ky/da/p9/TM/qM`、
  push 点 `if(ss)vd.push({type:"advisor_20260301",name:YR,model:ss,...})`、
  beta 头 `Ewn=Ee("advisor_tool","advisor-tool-2026-03-01")` 及其 gate、错误
  谓词 `TPe/vtt`、重试 `zHe`、kill-switch `Yqt/Vqt`）中**没有任何 base-url
  检查**；2.1.274 的解析器 `Wde`（gate=`TA()`）同样没有。
- 于是 275 起：代理 + 实验开启（growthbook `tengu_sage_compass2` 或服务端
  rollout）→ 解析出 advisor 模型 → tools 数组携带
  `{type:"advisor_20260301"}` → 代理/网关不认识该 tool 判别式 → 每个请求
  `400 … Input tag 'advisor_20260301'`。
- 276 修复 = 给解析器加 `Ia()` 前置 gate（firstParty **且** base-url 在
  allowlist 内）。beta 头 gate `if(yct()&&(Bb()||h.advisorModel!==void 0))we.push(Ewn)`
  刻意**不含** base-url 检查（275↔276 逐字节一致）。

### OCC 对齐（本轮落地，全部带 UT）

| # | 变更 | 官方依据 |
|---|------|----------|
| 1 | `src/utils/advisor.ts`：growthbook key `tengu_sage_compass` → **`tengu_sage_compass2`** | v274/v275/v276 三个二进制各含 `tengu_sage_compass2` 2 次、裸 `tengu_sage_compass` 0 次 —— OCC 的旧 key 从来不会命中服务端实验 |
| 2 | `src/utils/advisor.ts`：`isAdvisorEnabled()` 重构为官方 yct()&&Bb() 端态：严格 `firstParty`（foundry 也排除）、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 短路、新增 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` env override | v274 `TA()` / v276 `yct()+Bb()` 逐字节（见下） |
| 3 | `src/services/api/claude.ts`：advisor 模型解析块加 `isFirstPartyAnthropicBaseUrl()` gate（= 官方 `Ia()`；provider 由 isAdvisorEnabled 保证 firstParty） | v276 模块 #489 `if(!Ia()\|\|!Bb()\|\|!lL(e))return;` |
| 4 | `src/utils/model/providers.ts`：`isFirstPartyAnthropicBaseUrl()` 补 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` override 臂 | v274 `Xo()` / v276 `es()` 逐字节 |

官方 gate 链（v274 逐字节，276 端态等价）：

```js
function TA(){if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)return!1;if(He()!=="firstParty"||!sy())return!1;if(a.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)return!0;return I("tengu_sage_compass2",{}).enabled??!1}
function sy(){return ia()&&!EY()}
function ia(){let e=He();return e==="firstParty"||vM(e)||e==="foundry"}   // 与 He()==="firstParty" AND 后收敛为 firstParty
function EY(){return a.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS||eM()}
function eM(){return Yf("hipaa")}                                          // OCC 无 taint registry，by-design 省略（同 betas.ts 既有惯例）
```

修复前 OCC 的实际暴露面：`isAdvisorEnabled()` 走的是
`shouldIncludeFirstPartyOnlyBetas()`（firstParty||foundry，无 base-url 检查）
+ 过期 key —— 因为 key 过期，growthbook 永远返回 `{}`，advisor 从不启用，
OCC 意外免疫。**只修 key 不加 gate 会让 OCC 原样继承 275 回归**，故四处变更
必须同轮落地（本轮已同轮落地）。

by-design 保留分歧（代码注释已标注）：
- hipaa taint 臂、`Vqt` org-refused kill-switch：OCC 无对应基础设施。
- beta 头的 `||h.advisorModel!==void 0` sticky 臂：OCC 无 mid-session 实验
  翻转状态机，维持既有简化。
- `isFirstPartyAnthropicBaseUrl` 的 ant `api-staging.anthropic.com` 臂：OCC
  既有超集（官方在兄弟 allowlist 中也含 api-staging），保留。

### 新增测试

- `src/utils/__tests__/advisorGate276.test.ts`（9 tests）：key 命中
  `tengu_sage_compass2` 且不含裸 key；实验 enabled 生效；DISABLE env 压倒
  一切；ENABLE env 免 growthbook 短路；bedrock/vertex/foundry 排除；
  DISABLE_EXPERIMENTAL_BETAS 排除。
- `src/utils/__tests__/firstPartyBaseUrl276.test.ts`（8 tests）：unset→true、
  api.anthropic.com→true、代理→false、畸形 URL→false、ASSUME env 覆盖、
  ASSUME falsy 不覆盖、ant staging→true、非 ant staging→false。

### 顺带清理

- 删除 `src/services/api/src/` 死桩树（47 个 "Auto-generated type stub —
  replace with real implementation" 文件，`export type X = any`；全仓 grep
  零引用、tsconfig/biome/package.json 零提及）。这是历史上误提交的重复目录
  影子（真实现在 `src/utils/`、`src/services/`），属于 stub-伪装-完成 的
  典型陷阱，按 skill 纪律清除。

## 2.1.275（96 条）：逐条分诊

（triage 结果，见下表；VSCode 27 条、web 5 条、Claude Tag 9 条、Code
Review 2 条共 43 条为 OCC 不适用 —— OCC 是 terminal-only。）

余下 53 条 terminal 相关条目逐条分诊如下（verdict：ALIGNED / GAP-S/M/L =
移植候选（工作量）/ N-A-ABSENT = OCC 无该功能面 / N-A-BACKEND = 依赖 OCC
没有的 Anthropic 后端/宿主产品；"partial" = OCC 面存在但官方机制未能在
合理预算内字节定位）。取证方式：OCC 源码 file:line + v274/v275 官方 ELF
字节摘录（详见分诊记录）。

| # | 条目（摘要） | verdict | 依据/备注 |
|---|--------------|---------|-----------|
| 01 | gateway 登录显示账号并确认 | N-A-BACKEND | Claude apps gateway 产品面；OCC 无 gateway sign-in 确认流 |
| 02 | send-now 键（ctrl+enter / ctrl+x ctrl+s） | GAP (M) | OCC `defaultBindings.ts` 无 send-now 绑定；官方 v275 handler + `queued_send_now` 遥测 + 灰色渲染已字节验证 |
| 03 | `otelHeadersHelper` 失败启动警告 | GAP (S) | OCC 有 otelHeadersHelper 面，无失败启动警告 |
| 04 | claude.ai 账号 skills/plugins 同步 | N-A-BACKEND | `syncClaudeAiSkills`/account-sync 全仓 0 命中 |
| 05 | `/plugin install --marketplace` | GAP (S, partial) | marketplace 基建在（`marketplaceManager.ts`、`cli/handlers/plugins.ts`）；"先加 marketplace 再装"便捷流未验证 |
| 06 | memory 文件 age note 漂移 → prompt cache miss | GAP (M) | OCC FileReadTool 与 v274 模式完全一致（WeakMap 存裸 mtime，渲染时 `Date.now()` 重算）；官方 v275 改为读取时预计算 note 文本（`GAe.set(Nn,Fzt(ze))`）+ `readNotes` 持久化/复活 + 形状校验 |
| 07 | `--forward-subagent-text` 丢 `context: fork` skill 子代理消息 | GAP (M) | 面存在（SkillTool fork 路径 + AgentTool 转发 + forwardSubagentText 管道），多处缺口 |
| 08 | @-mention 文件建议被 MCP 资源淹没 | GAP (S) | `fileSuggestions.ts:741,748` 拿数组下标当 score；`unifiedSuggestions.ts:166-170` 升序合并 → 下标 1–14 沉底；官方修复 = rank 归一到 [0,1)；OCC 还缺官方 `mcp_resource +0.15` 罚分 |
| 09 | fullscreen 后台任务完成通知位置 | GAP (M) | fullscreen 家族（见 14/25/29）；面存在（vendored ink + resume picker） |
| 10 | marketplace update 拉取失败误删本地副本 | GAP (M, partial) | OCC 与官方同为 env-gated keep；repo-name 特定 bug 是否波及 OCC 未验证 |
| 11 | plugin/marketplace 消息与日志泄露 URL 中密码/token | GAP (M) | OCC 无任何 redaction 模块；`logPluginFetch('marketplace_pull', gitUrl, …)` 记原始 URL —— 泄露面实存 |
| 12 | 恢复的 cloud session 遗留未答问题 | N-A-BACKEND | hosted cloud session；OCC 仅有 UI 标签（pillLabel "cloud sessions"） |
| 13 | vim 模式 dot-repeat `!` / 快速 `i!` 后光标右移一格 | GAP (S) | OCC dot-repeat 路径匹配 v274 形态；v275 在 vim executor 减 1 补偿；fast-typed 路径需在 OCC 行为实测 |
| 14 | fullscreen 滚过大文件 diff 冻结/白屏 | GAP (M) | fullscreen 家族 |
| 15 | 偶发游离 `</ccmemory>` 闭合标签 | N-A-ABSENT | `cc-memory`/`ccmemory` 全仓 0 命中 —— 引用标签功能整体不存在 |
| 16 | plugin 消息对某些 git 地址显示错误 server | GAP (S, partial) | plugin git 地址显示面存在；官方机制未字节定位 |
| 17 | 网关改写 400 响应 → 每回合 `API Error: 400` | N-A-ABSENT | 官方修复对象是 message-threads/tether beta（`retry:tether-stateless` 无头重发）；OCC 无 Message Threads。**注**：OCC 也完全没有 sticky-beta 移除重试机制，任何 beta 被改写型网关拒绝都会同样终态 400 —— 更宽的 L 级移植候选 |
| 18 | Linux 沙箱 Bash 在 zsh 下失败命令报 exit 0 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 19 | Read 工具大文件内存压力下解码失败挂起 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 20-22 | 畸形 transcript 三连（task-reminder/@-file 附件、消息条目、内容块）导致 resume/picker/后台代理/转录视图失败 | GAP (M) | OCC 有基础 `isMalformedAttachment`（2.1.217/218 移植）+ 宽松行级 JSON 解析 + parentUuid 桥接；缺 v275 两项：(a) transcript 加载期消息/内容块形状清洗器，(b) task_reminder/todo_reminder/file/already_read_file 按类型附件校验 |
| 23 | Grep/Glob/@-file 超 20MB 输出上限挂起/OOM；系统 ripgrep 警告洪水后谎报 no matches | GAP (M) | `src/utils/ripgrep.ts:214-273` 嵌入 spawn 路径与 v274 完全一致（无 maxBuffer；close 0/1 静默成功，截断输出当正常结果）；v275 修复 = 带帽收集器 `eqe`（VJ=20000000，1MB 分段解码）+ 溢出即杀子进程 + 截断转 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` + 新 `Zjt` 错误类与用户可读消息 |
| 24 | `/rewind` 备份复制不全时恢复出零填充/截断文件 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 25 | fullscreen 快速输入 + slash 下拉崩溃 | GAP (M) | fullscreen 家族 |
| 26 | 后台 session worker 在资源耗尽机器上 stdin 命令崩溃重启 | GAP (S, partial) | 后台 session 基建存在（main.tsx、cli/handlers/agents.ts）；韧性路径未验证 |
| 27 | `~/.claude.json` 畸形 `mcpNeedsAuthNoticed` 启动崩溃 | GAP (S) | 面：`src/utils/mcpNeedsAuthNotice.ts` |
| 28 | `--resume`/`--continue` 丢弃早期 thinking（内置工具被服务端旗标关掉） | INCONCLUSIVE | 官方 v275 机制未能在预算内字节定位；OCC 面存在 |
| 29 | fullscreen resume picker 鼠标选中文本进不了剪贴板 | GAP (M) | fullscreen 家族；子项 (c) 已验证 ALIGNED，其余子项 GAP/INCONCLUSIVE |
| 30 | plugin reload 预览覆盖运行中 session 的 `--plugin-dir` 解压文件 | GAP (S, partial) | plugin-dir 面存在（`pluginOperations.ts`） |
| 31 | 自托管 runner `--drain-wait-sec` SIGTERM 排水丢终态 | N-A-ABSENT | self-hosted runner 功能不存在 |
| 32 | `SubagentStop` hook matcher 对空 agent type 误触发 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 33 | 沙箱 Bash 无法写名为 `hooks/`、`config/` 的项目目录 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 34 | Artifact 跨机 resume 后 "File not found" | N-A-ABSENT | OCC 无 ArtifactTool（ReviewArtifactTool 是另一个工具） |
| 35 | `/update-config` 写 `Write(path)` 规则（应为 `Edit(path)`） | GAP (S) | 官方修复已在 v275 二进制定位 |
| 36 | claude-api skill live-sources 表 4 个死链 | N-A-ABSENT | OCC 的 bundled claude-api skill `.md` 全为 1 字节占位 —— 死链在 OCC 中不存在；**注**：整个 skill 内容为空是更大的内容缺口（live-sources 内容在官方二进制内为 zstd 压缩嵌入，hash v274≠v275 证实有改动） |
| 37 | `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 上方文本全局缓存 | GAP (S) | 官方修复已在 v275 二进制定位 |
| 38 | `/desktop` 错误信息改进 | GAP (S) | desktop CLI 面存在；官方新文案已提取 |
| 39 | Artifact publish/read 结果说明改进 | N-A-ABSENT | 同 34 |
| 40 | Artifact publish 结果（tab icon、NUL 警告、重试） | N-A-ABSENT | 同 34 |
| 41 | 粘贴/附加图片保存到免权限提示位置 | GAP (S) | 官方 v275 新路径已定位 |
| 42 | Artifact 就地更新指导 | N-A-ABSENT | 同 34 |
| 43 | plan-usage 读取跨进程共享（1 分钟内） | GAP (M, tentative) | `claudeAiLimits.ts` 有读取面但无跨进程共享缓存；官方机制 INCONCLUSIVE |
| 44 | `ListPlugins` 工具描述改进 | N-A-ABSENT | ListPlugins 工具全仓 0 命中 |
| 45 | 终端慢/暂停时输出不再越落越远 | GAP (M) | 官方修复已在 v275 二进制定位 |
| 46 | synced account-skills 目录 Write/Edit 结果提示 | N-A-BACKEND | 依赖 04 的账号同步功能 |
| 47 | `/logout` 对支持吊销的 gateway 同步登出 | N-A-BACKEND | Claude apps gateway 产品面 |
| 48 | hosted session 容器重启后保留未答权限提示 | N-A-BACKEND | 同 12 |
| 49 | Artifact 首次发布改问一词 tab icon | N-A-ABSENT | 同 34 |
| 50 | Chrome auto 模式对 classifier 批准调用跳过 per-site 检查 | N-A-ABSENT (部分潜在 GAP) | OCC WebBrowserTool 为简化面，无扩展 per-site 管道；v275 browser_batch 多 host 拒绝检查部分为潜在 GAP（机制 INCONCLUSIVE） |
| 51 | npm 源插件改 `npm pack --ignore-scripts` + 完整性校验 | GAP (M) | 官方 v275 新增（字符串计数验证 `Wnr`: `Be("npm",["pack","--ignore-scripts",…])`）；OCC 跑裸 `npm install` —— 供应链暴露面 |
| 52 | 定时 routine 运行数据保存到可编辑 artifact 并重发布 | N-A-ABSENT | OCC 无 routines/artifacts |
| 53 | 移除一次性 routine 启动通知 | N-A-ABSENT | 同 52 |

汇总（53 条）：**ALIGNED 0 · GAP-S 17 · GAP-M 14 · INCONCLUSIVE 1 ·
N-A 21**（N-A-ABSENT 13 + N-A-BACKEND 6 + 部分 N-A 2）。本轮不携带任何
2.1.275 GAP 移植 —— 276 的唯一语义修复（advisor gate）已完整落地，275 的
GAP 清单作为后续轮次的移植候选队列记录在案。安全相关的 GAP 优先项：
**#11（marketplace URL token 泄露日志）**、**#51（npm 插件无
--ignore-scripts/完整性校验）**、#20-22（畸形 transcript 健壮性）。

### 附：live GrowthBook 佐证（本轮实测）

对 `api.anthropic.com` 的真实 GrowthBook remote-eval 拉取（673 个 feature）
返回 `tengu_sage_compass2 = {"enabled": true}`、裸 `tengu_sage_compass = {}`
—— 服务端实验**当前是开着的**。这意味着：修复前的 OCC（裸 key）因 key
过期而意外免疫；只修 key 不加 base-url gate 的中间态会立刻继承 275 回归
（代理用户每请求 400）。本轮四处变更同轮落地后，行为 e2e（mock API 捕获
真实请求体）证实：代理 base-url 下 advisor schema **不出现**（C1），
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 时**出现**（C2）—— 与官方
`Ia()` 语义一致。

## 追踪指针更新

- `CHANGELOG.md`：Now tracking Claude Code `2.1.276`。
- `CLAUDE.md`：追踪指针同步。
- 版本：OCC 2.1.341 → **2.1.342**。
