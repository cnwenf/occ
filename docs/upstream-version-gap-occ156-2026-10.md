# upstream-version-gap-occ156-2026-10 — OCC-156 严格自验收账本

> 轮次：2026-10-13 严格自验收（官方 2.1.296 = latest/next，OCC v2.1.380 已对齐 @ tag `ab5155a`）。
> 纪律：Never invent — 一切结论附行为/二进制证据；无证据 = CAND；被证伪 = FALSIFIED 留档。
> 对照物：官方 2.1.296 npm 二进制（Bun ELF，strings 55MB/319,894 行）vs OCC main HEAD `3b9ec3adf` 重建 dist（30.09MB）。
> 工作分支：`agent/occ156-selfaccept`。本账本随做随 commit（Leader 指令，防服务器中断零产出）。

---

## §0 版本事实

| 项 | 值 | 来源 |
|---|---|---|
| 官方 latest/next | 2.1.296（无更新版本） | npm registry 查询（本轮 run 1 核实） |
| OCC 已对齐 tag | v2.1.380 @ `ab5155a` | git tag |
| main HEAD | `3b9ec3adf`（= 工作分支基点） | git |
| `ab5155a..3b9ec3adf` | 4 commits，实质 test-only（见 §1） | git diff |

## §1 Task-1 复核：ab5155a..3b9ec3adf 是否 test-only

`git diff ab5155a..origin/main --name-only | rg '^src/'` 命中 **2 个文件**：

- `src/tools/FileEditTool/__tests__/nonUtf8Refusal296.test.ts`
- `src/utils/secretRedaction/__tests__/twoPhaseAssign296.test.ts`

**裁决：实质 test-only，不触发"src/ 改动即停"条款。** 证据：

1. 两文件均位于 `__tests__/` 目录，diff 共 84 insertions / 0 deletions，全部为新增 `test()` 用例；
2. 来自 commit `d3eafae test(2.1.296): close OCC-114 acceptance coverage gaps`（type=test）；
3. 区间其余 8 个文件 = 1 docs 账本 + 7 test 文件，无任何生产代码变更。

## §2 VERIFIED PARITY（行为级 A/B，字节一致）

对照方式：tmux REPL（`new-session -d -x 200 -y 50`）+ `-p --output-format stream-json --verbose`，双侧同场景同输入。产物在 `/tmp/ab/`（本轮 run 本地，关键数据已摘录于此）。

| # | 面 | 证据 | 结论 |
|---|---|---|---|
| P1 | Read `allow_large` 尺寸拒绝 | 双侧 refusal 文案 **334 chars 字节一致**（256KB cap 提示） | PARITY |
| P2 | Read `allow_large` token 拒绝 | 双侧 **378 chars 字节一致**，含相同 **36009**-token 计数（25000 cap） | PARITY |
| P3 | Read `allow_large:true` 放行 | 大文件（1,119,999B/20000 行）双侧放行，paged content **59892 bytes == True** 一致 | PARITY |
| P4 | Read token-cap 分页重写 | footer 分页提示一致（src `allowLarge.ts:311` paged-rewrite message） | PARITY |
| P5 | Read `tengu_file_read_allow_large` 遥测事件名 | `allowLarge.ts:185` = 官方 strings 同名 | PARITY |
| P6 | Read offset 行号语义 | 见 §4 F1（FALSIFIED 后按同参数复验：line numbers mirror offset，双侧一致） | PARITY |
| P7 | `autoCompactWindow` 警告 | 官方 debug log 与 OCC **逐字节一致**：`[WARN] ...invalid autoCompactWindow...`（agent frontmatter `autoCompactWindow: 50`）；`[DEBUG] ...invalid maxTurns...`（`maxTurns: -3`） | PARITY |
| P8 | `autoCompactWindow` 常量 | OCC `AUTO_COMPACT_WINDOW_MIN=100_000 / MAX=1_000_000`（`autoCompactWindow.ts:47-48`）；官方二进制行为确认（debug log 边界值） | PARITY |
| P9 | `/agents` wizard-removed 文案 | tmux A/B 双侧 **字节一致** | PARITY |
| P10 | agent frontmatter 警告 render 点 | `loadAgentsDir.ts:1020,1038` + `loadPluginAgents.ts:191,207` 与官方逐字一致 | PARITY |
| P11 | `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` | 官方描述符 `,Ci=H.int({min:32000`（本轮从 296 module 段提取）= OCC `OVERLOADED_RETRY_MAX_DELAY_MIN_MS=32000`（`withRetry.ts`）；max 64000 由 UT 钉死；digits-only regex `/^[+-]?\d+$/` | PARITY（静态+UT） |
| P12 | `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` | 官方 `,ni=H.int({min:500` = OCC `OVERLOADED_RETRY_BASE_DELAY_MIN_MS=500`（`withRetry.ts:1464`） | PARITY（静态） |
| P13 | `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` | 静态+UT（workflowSubagentModel296.test）通过；行为面本轮未复跑 | PARITY（静态+UT） |
| P14 | 296 UT battery | **31 文件 / 495 pass / 0 fail**（allowLarge296、agentAutoCompactWindow296、agentFrontmatterWarnings296、workflowSubagentModel296、overloadedRetryMaxDelay296、twoPhaseAssign296、nonUtf8Refusal296×3、dangerousRm296、gitBashPaths296、workflowDepth296、workflowScriptCrlf296、otelGitCommitId296、marketplaceConstructorName296、hintTagSanitize296、mcpDescriptionCap296、osc52VteGuard296 等） | PASS |

## §3 CONFIRMED GAPS

### GAP occ156-01（P2）footer agent-status 组件 `← for agents` 缺失

- **现象**：官方 REPL idle footer 渲染 `← for agents`；OCC footer 无此 hint（tmux A/B 截图差）。
- **OCC 现状**：`PromptInputFooterLeftSide.tsx`（572 行）有 `shouldRenderModeCycleHint` / `shouldRenderShortcutsHint` / `getSpinnerHintParts`，**无 `← for agents` render site**（仅 line 148 注释记录官方文案）。← 键绑定本身 LIVE（`FleetViewScreen.tsx:112,131` `leftArrowOpensAgents ?? true`）。
- **官方 296 反编译存档（turnkey port 素材）**：

```js
function q1t(Uo){return Uo.leftArrowLeadsTo}
var Rz = 2500  // transient 清除延时 ms
function b9e(){
  ...C=Wo(q1t), L=!h&&C===void 0, H=Emt(), ee=Re(L?H:null),
     he=ee?.needsInput, Se=ee?.succeeded, ...[Je,at]=y("none"), [_t,xt]=y(0)...
}
// 4 states:
//  1) L&&(he===0||he===void 0)&&_t>0 → [A1,' ']+{_t>99?"99+":_t}(success)+" done"
//  2) C!==void 0 → <mce {...C}/>           // leftArrowLeadsTo 自定义 marquee
//  3) !L||he===void 0||he===0 → [A1," for agents"]   // idle 默认
//  4) else → arrow+count，awaiting=warning / done=success
// transient: needsInput 变化→"awaiting"；succeeded 增加→"done" delta xo=Se-io；Rz=2500ms 后清除
```

- **裁决**：**STAGED（turnkey 存档）**，不在本轮中途做 UI 手术。理由：完整 4 态组件 + 2500ms transient + needsInput/succeeded 计数是独立 UI feature，与 occ154 STAGED ← 家族（#033/#034/#062 autoBackground/`←`，大成本）同根，宜整包推进；本轮性质为自验收，生产改动纪律为小切片。反编译已全文存档如上，后续 port 可直接取用（参照 #044 先例）。

### GAP occ156-02（P3）auto-mode classifier 计费公告缺失（gateway 分支）

- **证据**：官方 s296.txt 2 hits / OCC dist 0 / OCC src 0。官方反编译：

```js
var K9e="https://code.claude.com/docs/en/auto-mode-classifier-billing";
function mpn(e){ if(e.gatewayHost!==void 0) return {
  title:"We're changing auto mode to no longer charge for classifier requests in Claude Code.",
  paragraphs:[`However, this session isn't eligible because your requests go through ${e.gatewayHost}, which isn't compatible with this update.`,
  "Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.", `To fi...` ]}}
function jrr(){let e=yqt(); return e===void 0?{}:{gatewayHost:e}}   // 从 API base URL 提取 host
function Wrr(e){return {...e,...mpn(e),helpUrl:K9e}}
function ZJo(e){let{title:n,paragraphs:r}=mpn(e);return[n,...r].join(" ")}
function gpn(e){let n=W2n();if(n!==void 0)return n;if(!_Tn())return ...}  // 门控后进入 auto-mode 面
```

- **性质**：Anthropic 一次性计费变更公告，仅 auto-mode 面 + gateway 用户可见（OCC 用户恒走 gateway → 官方侧恰是该公告的目标受众）。
- **裁决**：**STAGED（P3）**。理由：时效性公告（未来官方版本大概率移除）、依附 auto-mode classifier 计费基础设施（OCC 无 Anthropic 计费面）、纯展示无行为影响。证据已存档，如 Leader 要求严格逐字对齐可低成本补 render。

### GAP occ156-03（P1，生产行为）auto mode 默认权限模式 + 公告 + opt-in 迁移缺失

- **现象（tmux 实测，同一 fresh CLAUDE_CONFIG_DIR，官方先跑写完 onboarding 状态后 OCC 复用同一 config）**：
  - 官方主 REPL footer：`⏵⏵ auto mode on (shift+tab to cycle) · ← for agents`，并展示一次性公告块：`▎ Auto mode is now Claude Code's default permission mode. / ▎ Auto mode lets Claude handle permission prompts automatically. ... / ▎ https://code.claude.com/docs/en/permission-modes`
  - OCC footer：`⏸ manual mode on · ? for shortcuts`，无公告块。
  - config 证据：官方跑完后 `.claude.json` 含 `hasResetAutoModeOptInForDefaultOffer:true, hasSeenAutoDefaultNotice:true`；**OCC 读同一文件仍以 manual 启动** → 非状态问题，是逻辑缺失。
- **grep 证据**：官方 `Auto mode is now` 2 hits（`QMr="Auto mode is now Claude Code's default permission mode."` + `ZMr` 正文）；OCC src **0 hits**。
- **官方机制 RE 存档**：
  - surface id `fNt="auto-mode-default"`；`Jh(l)` 置 `hasSeenAutoDefaultNotice` + 遥测 `tengu_auto_default_notice_shown`；
  - 迁移 `Bt(e)`：`if(ce().hasResetAutoModeOptInForDefaultOffer)return!0; if(o2r()!=="enabled")return!0; ...skipAutoPermissionP...`（userSettings 逃生门）→ 重置 opt-in，遥测 `tengu_migrate_reset_auto_opt_in_for_default_offer` / `migration_reset_auto_mode_opt_in`；
  - 相关 config keys：`autoModeOptInDismissed`、`hasSeenAutoDefaultNudge`、`hasSeenAutoModeEntryWarning`；
  - OCC 现状：`auto` 模式本体存在（`--permission-mode` 六选一致、可 cycle），缺的是 **默认值切换 + 一次性公告 + opt-in 重置迁移 + 门控**（`o2r()==="enabled"` 可用性门、managed/safe-mode 排除等）。
- **裁决**：**上报 Leader 定夺**（taskbook 第 4 条"拿不准→问 Leader"）。理由：改变每个新会话的默认安全姿态（manual→auto 自动放行低风险工具调用），且官方门控链（o2r 可用性探测、skipAutoPermissionPrompts 逃生门、企业 managed 排除）需完整 RE 后再动，不宜自验收轮内当天手术。证据与 RE 存档已 turnkey，可开独立小切片 issue。

## §4 FALSIFIED / 非 gap 观察

- **F1 Read 0-based 行号（FALSIFIED）**：初见 OCC `0\tLINE-000000` vs 官方 `1\t...` 疑似 gap；但两侧调用参数不同（OCC 侧带了 `offset:0`）。强制同参数复验：官方对 `offset:0` **同样**输出 `0\talpha`。结论：行号镜像 offset 值（offset:0→0-based；默认 offset=1→1-based cat -n），**双侧一致，非 gap**。留档以示 Never-invent 纪律执行。
- **N1** OCC branded splash box：OCC 自有品牌面，已裁决 OCC-specific，非 gap。
- **N2** "Debug mode enabled" / "Logging to:" 换行拆分：终端渲染宽度差异，非语义差。
- **N3** "↑ Opus now defaults to 1M context" tip：模型路由环境相关（dashscope 代理下 model=glm-5.2），双侧触发条件不同源，非 port 缺失（OCC 有对应 tip 面，条件未满足）。
- **N4** 官方 tmux focus-events hint：tmux 环境探测文案，OCC 无对应探测面为已知环境差异。

## §5 STAGED 结转（不静默丢弃）

- **occ154 §8.2 ×28 家族**全部结转 STAGED（autoBackground/`←` #033/#034/#062、plugin hook #005/#020/#035、prototype-key #027/#028、PowerShell #036/#047、U+2028/2029 #046、MCP graceful shutdown #048、teleport #012、model/token #013、OSC52/VTE #017、UI misc #018/#051/#052/#056、artifact #039、startup hang #042、/code-review #038、hook output #015、frontmatter debug #055、hook debug log #057、dataviz #060、plugin HTTPS retry #049、OTEL git_commit_id #044=RE 存档 turnkey）。
- **occ153 §8.2 余 2**：#090、#095 结转 STAGED。
- **本轮新增 STAGED**：occ156-01（footer agent-status，含完整反编译存档）、occ156-02（classifier 计费公告）。
- verify-first 名单（#013/#015/#018/#038/#060）与 quick-wins（#027/#028/#036/#046/#049/#044/#057）见 occ154 §8.3，本轮 triage 结果见 §7。

## §6 自验收 sweep 进度（随做随更）

| 面 | 状态 |
|---|---|
| occ154-ported: Read allow_large | ✅ §2 P1-P6 |
| occ154-ported: autoCompactWindow | ✅ §2 P7-P8 |
| occ154-ported: WORKFLOW_SUBAGENT_MODEL | ✅ §2 P13（静态+UT） |
| occ154-ported: OVERLOADED_RETRY_MAX_DELAY | ✅ §2 P11-P12 |
| occ154-ported: managed hooks cluster | ✅ §6.1（行为 A/B 4-run 矩阵全对齐） |
| 核心主干: footer/agent-status | ✅ → GAP occ156-01 |
| 核心主干: session/resume | ⏳ 待测 |
| 核心主干: 工具调用/权限 | ⏳ 待测 |
| 核心主干: hooks 行为 | ⏳ 待测 |
| 核心主干: MCP | ⏳ 待测 |
| 核心主干: /command palette | ⏳ 待测 |

### §6.1 ManagedHooks 面复核 — VERIFIED PARITY（行为 A/B）

grep 复核：`managedHooks: src=0 official=21; managed_hooks: src=0 official=6; ManagedHooks: src=12 official=30`。OCC 12 个 src 文件为真实生产面：`allowManagedHooksOnly` policy 强制（`hooksSettings.ts:107-109`、`execHttpHook.ts:46`、`hooksConfigSnapshot.ts:12-27`、`policyLocks.ts`、`HooksConfigMenu.tsx`、`REPL.tsx`、`sessionStart.ts`、`settings/types.ts`）+ 2 tests（managedOnlyKeys283、hooksFailClosed288）。occ154 §7.2 的 VERIFIED N/A 裁决针对特定 fix cluster（#007/#008/#019），非整面缺失。

**行为 A/B 定案（2026-10-13，4-run 矩阵）**：`/etc/claude-code/managed-settings.json` = `{"allowManagedHooksOnly":true,"hooks":{"UserPromptSubmit":[touch MANAGED_HOOK_MARKER]}}`，CLAUDE_CONFIG_DIR 用户 settings.json 带 `UserPromptSubmit → touch USER_HOOK_MARKER`，双侧 `-p "hi" --debug`：

| Run | 侧 | managed 门控 | USER_MARKER | MANAGED_MARKER |
|---|---|---|---|---|
| 1 | 官方 2.1.296 | ✅ | **no**（被抑制 ✓） | **YES**（managed hook 执行 ✓） |
| 2 | OCC 2.1.380 | ✅ | **no** ✓ | **YES** ✓ |
| 3 | 官方（control，无 managed settings） | — | **YES**（用户 hook 恢复 ✓） | — |
| 4 | OCC（control） | — | **YES** ✓ | — |

结论：`allowManagedHooksOnly` 门控语义（用户 hook 抑制 + managed settings-file hooks 仍执行 + 撤销后恢复）双侧行为一致。计数差 12 vs 30 源于官方模块拆分粒度（官方另有 plugin-hooks skip 文案、goal 门控、edit_hook refusal 等分支；OCC 对应面由 hooksFailClosed288/managedOnlyKeys283 UT 钉住）。测试后 `/etc/claude-code` 已清理。**PARITY VERIFIED。**

## §7 STAGED verify-first triage（待填）

## §8 修复/交付（待填）
