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
| `ab5155a..3b9ec3adf` | 5 commits（4 test + 1 docs occ154 账本收尾），实质 test-only（见 §1） | git rev-list / git log |

## §1 Task-1 复核：ab5155a..3b9ec3adf 是否 test-only

> 计数口径（验收 F2 修正）：区间 `git rev-list --count` = **5 commits**：`d076169` docs(occ154 §12 账本收尾) + `d3eafae`/`80d12d7`/`1d3966b`/`3b9ec3a` 4 个 test。此前交接文字误写 "4 commits"（漏计 docs 收尾 commit），test-only 裁决本身不受影响。

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

- **补充证据（shift+tab 全模式循环 A/B，2026-10-13）**：循环序一致（auto→manual→accept edits→plan→auto），四个模式指示串**逐字节一致**（`⏵⏵ auto mode on (shift+tab to cycle)` / `⏸ manual mode on` / `⏵⏵ accept edits on (shift+tab to cycle)` / `⏸ plan mode on (shift+tab to cycle)`）。差异仅在：官方 footer 在**每个模式态**都追加 `· ← for agents` 后缀（manual 态为 `⏸ manual mode on · ? for shortcuts · ← for agents`，agent hint 与 shortcuts hint **并存追加**，非替换）；OCC 所有模式态均无该后缀。→ occ156-01 精确化：缺的是 footer 组合里的 agent-status hint 槽位（b9e 组件整体），port 时为在现有 hint 后追加的独立槽，不动 mode/shortcuts hint 本体。
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
- **Leader 裁决（2026-10-13，裁决评论 `b16f18f6`）：STAGED-BY-LEADER** —— 本轮**不**无条件切 auto，OCC 默认维持 manual。理由：① 官方 stable 通道仍停 2.1.287，2.1.296 仅在 latest/next；以未晋升 stable 的版本为基准切换默认安全 posture 属冒进；② `7b17869` 已复现官方**同意路径**（nudge 对话框 + 公告面，官方 gate aMr/dialog qhe/resolver Ckt+Tkt 字节核验在案），官方迁移策略核心（用户显式同意 opt-in）已覆盖，OCC 用户不会被静默切模式。**复议触发条件 = 官方 stable ≥ 2.1.296**（届时连同 `tengu_migrate_reset_auto_opt_in_for_default_offer` 迁移 + `skipAutoPermissionPrompts` 逃生门 + `o2r()==="enabled"` 门控链一起字节取证再裁决）。

### GAP occ156-04（P3，cosmetic）WelcomeV2 splash 分隔符字符漂移（`.` → `…`）

- **现象（tmux 实测 + 字节级）**：onboarding splash art 分隔符，官方 = ASCII `0x2e`（`.......█ █   █ █........`），OCC = U+2026 `e2 80 a6`（`…………………█ █   █ █………`）。顶部横线官方 58 × `.`，OCC 60 × `…`。
- **官方二进制字面量存档**（WelcomeV2 对应模块）：

```js
children:[".......", e(n,{color:"clawd_body",children:"█ █   █ █"}),
          "..........................░..........▒...."]
```

- **OCC 现状**：`src/components/LogoV2/WelcomeV2.tsx` 全组件硬编码 `…` 序列（lines 32/101/117/192/243/300/307/352/411/418 等）。
- **裁决**：STAGED（P3 cosmetic）。修复 = 字面量替换（`.`×7 / `.`×26+░+`.`×10+▒+`.`×4 等，逐段对照官方），需重排 WELCOME_V2_WIDTH 对齐；建议与 occ156-05 合一个 cosmetic-parity 小切片。

### GAP occ156-05（P3，cosmetic）ThemePicker 选项编号 + ✔ 位置漂移

- **现象（tmux 实测）**：onboarding 主题选择器，官方渲染无编号、✔ 前置（`❯ ✔ Dark mode`）；OCC 渲染带编号、✔ 后置（`❯ 2. Dark mode ✔`）。同屏对照，trust dialog（2 项）双侧均无编号一致。
- **机制**：OCC `Select` 组件已有 `hideIndexes` prop（`select.tsx:452` 条件渲染 `${i}.`），OCC `ThemePicker.tsx` 未传；官方二进制 `hideIndexes` 53 hits（组件面存在），官方主题选择器行为证明其隐藏编号（✔ 位置差异疑似 ThemePicker label 装饰自渲染，待修时对照）。
- **裁决**：STAGED（P3 cosmetic）。修复 = ThemePicker 传 `hideIndexes` + ✔ 位置对照官方，加 snapshot 测试；建议与 occ156-04 同切片。

### GAP occ156-06（P2，功能面）/command palette 命令集漂移

**枚举方法**：tmux 双侧 palette 全量滚动采集（48×Down + 严格行正则），疑点用 C-u 清空 + filter probe 复核（palette 可见性 ≠ 命令存在性）；OCC src/commands registry 交叉核对。官方 palette 可见 61 条；OCC 枚举 51 + probe 补认 /theme /usage /tasks /tui /skill-doctor /terminal-setup /feedback(bug)。

**a) OCC 真缺失（filter probe 无匹配 + src registry 无目录）×6**：
| 命令 | 官方描述（tmux 采集） | 官方二进制佐证 |
|---|---|---|
| `/subtask` | — | s296 5 hits |
| `/radio` | Listen to Claude FM lo-fi radio | `dTo={type:"local",name:"radio",...}` 存档 |
| `/import` | — | palette 枚举 |
| `/list-agents` | — | s296 4 hits |
| `/auto-mode-setup` | Teach auto mode about your environment, plus optional rule tweaks | palette 枚举（与 occ156-03 同族） |
| `/design-login` | Authorize design-system access for /design-sync with your claude.ai account | s296 28 hits（claude.ai 绑定，OCC gateway 场景适配性存疑） |

**b) `/advisor` 可见性门控漂移**：同一 gateway 环境，官方 palette 显示 `/advisor`（`isEnabled:()=>bE(), isHidden:!bE()`，bE() 本环境=true），OCC 隐藏（`advisor.ts:122 isEnabled:()=>canUserConfigureAdvisor()` = `isAdvisorEnabled() && getAdvisorConfig().canUserConfigure`，本环境=false）。OCC 命令本体存在（`src/commands/advisor.ts`，OCC-37 已 port）。官方 `bE()` 未完整 RE → 机制 CAND、行为 CONFIRMED。
- **裁决**：STAGED。b) 需先 RE 官方 bE() 再改门控；a) 中 auto-mode-setup 并入 occ156-03 切片，design-login 需 Leader 定 claude.ai 面取舍，radio/stickers 为官方 fun-surface（低成本可补），subtask/import/list-agents 需独立 RE。

**c) `/fork` 语义漂移**：官方 /branch（"Create a branch of the current conversation at this point"）与 /fork（"Copy this conversation into a new background session and keep working here"）**分立**；OCC 只有 `/branch (fork)` 别名合一。官方 /fork = 后台会话复制语义，OCC 缺该独立命令。STAGED（后台会话家族，关联 occ154 #033/#034/#062 autoBackground 大包）。

**d) OCC-specific 命令（非 gap，留档）**：`/daemon`、`/pause-memory`、`/scroll-speed`、`/setup-bedrock`、`/setup-vertex`（官方同环境 probe 无匹配；OCC 扩展面/历史遗留，是否收敛由 Leader 定）。

### GAP occ156-07（P3，文案面）palette 描述文本漂移 ×11

同命令同环境采集（join 比对），官方 2.1.296 文案 vs OCC 现文案：

| 命令 | 官方 | OCC |
|---|---|---|
| /config | Open settings | Open config panel |
| /diff | Toggle the diff panel showing uncommitted changes | View uncommitted changes and per-turn diffs |
| /exit | Exit the CLI | Exit the REPL |
| /fast | Toggle fast mode (Opus) | Toggle fast mode (Opus 4.8 only) |
| /keybindings | Open your keyboard shortcuts file | Open or create your keybindings configuration file |
| /login | Switch Anthropic accounts | Sign in with your Anthropic account |
| /memory | Edit CLAUDE.md files and memory settings | Open a memory file in your editor |
| /permissions | Manage allow and deny tool permission rules | Manage allow & deny tool permission rules |
| /sandbox | ◯ sandbox disabled (⏎ to configure) | ⚠ sandbox disabled (⏎ to configure)（图标漂移） |
| /doctor | Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data | Diagnose and verify your Claude Code installation and settings |
| /skill-doctor | **Show which loaded skills are unused and costing context** | **Diagnose skill issues (missing frontmatter, invalid fields, broken paths)**（语义级漂移：官方=上下文成本分析，OCC=skill 诊断） |

- **裁决**：STAGED（一个 metadata 小切片可清 9 条纯文案；/skill-doctor 为语义漂移需单独立项对照官方行为）。注意 /login、/sandbox 描述可能状态相关，修复切片时先复核状态同构。

### GAP occ156-08（P2/P3，/status 面）tab 集 + 字段 + 诊断段漂移

同环境 tmux A/B（同一 /tmp/ab/repl + 共享 CLAUDE_CONFIG_DIR）：

| 项 | 官方 2.1.296 | OCC 2.1.380 |
|---|---|---|
| tab 集 | `Settings  Status  Config  Usage  Stats`（5） | `Status  Config  Usage`（3，缺 Settings/Stats） |
| Session kind | `interactive` | 缺 |
| Peer address | `uds:/tmp/.../cc-socks/*.sock` | 缺（官方 peer-socket 基建面，OCC N/A 候选） |
| Setting sources | `User settings` | ✅ 一致 |
| Managed settings (remote) | `not fetched — not available with a custom ANTHROPIC_BASE_URL` | 缺 |
| Organization policy | `not fetched with a custom ANTHROPIC_BASE_URL` | 缺 |
| Auto mode server | `Disabled` | ✅ 一致 |
| System diagnostics 段 | 5 条 native-install 体检警告（PATH/npm 残留/broken binary） | 缺（官方 native installer 基建绑定，OCC 无 native 安装面 → 部分 N/A 候选） |

- **裁决**：STAGED。Settings/Stats tab + Session kind + Managed/Org policy 两行为真 surface（gateway 环境文案官方已给全）；Peer address / System diagnostics 与官方专有基建耦合，port 前需 Leader 定 N/A 边界。

### GAP occ156-09（P2，/context 面）built-in skills 集 + 布局漂移

同环境 tmux A/B：grid 可视化、六类目（System prompt/System tools/Skills/Messages/Free space/Autocompact buffer）结构一致，计数差在系统提示品牌差范围内（1.4k/1.3k、17.6k/17.4k）。真漂移：

1. **Built-in skills 集**：官方 13 个（dataviz ~480、claude-api ~360、update-config ~240、code-review ~210、run ~120、loop ~120、plugin-authoring ~90、workflow-authoring ~80、keybindings-help ~80、fewer-permission-prompts ~60、simplify ~60、security-review ~30、init ~20）；OCC 仅 5 个（update-config 228、code-review 150、keybindings-help 82、simplify 62、verify 22）。**缺 9**：dataviz（= occ154 STAGED #060 已知）、claude-api、run、loop、plugin-authoring、workflow-authoring、fewer-permission-prompts、security-review、init（后四者 OCC 以 slash command 形态存在，skill 形态缺）；**OCC 独有**：verify（官方 296 无此 built-in skill）。
2. **token 计数格式**：官方 `~480 tokens`（约数取整）vs OCC `228 tokens`（精确值）。
3. **`Auto-compact window: 200k tokens` 行**：官方有，OCC 缺（autoCompactWindow 面已 port，此为展示缺口）。
4. **头部布局**：官方 model 行 + 独立计数行（`21k/200k tokens (11%)` 第二行右侧）；OCC 合并单行（`qwen3.8-max · 19.1k/200k tokens (10%)`）。

- **裁决**：STAGED。built-in skills 补齐是大切片（9 个 skill 本体 + loader）；`~` 格式 / Auto-compact window 行 / 头部布局为小切片 cosmetic 三件套，可与 occ156-04/05 合并推进。

### GAP occ156-10（P2，stream-json 契约面）thinking_tokens 事件 + init/result 字段集漂移

`-p --output-format stream-json --verbose` 同 prompt 双侧 A/B（`Use the Read tool to read /tmp/ab/small.txt then reply with only its last line.`）：

- **核心工具流 PARITY**：`tool_use Read {"file_path": "/tmp/ab/small.txt"}` 双侧同参；`tool_result` 内容**逐字节一致**（`1\talpha\n2\tbeta\n3\tgamma\n4\tdelta\n5\tepsilon\n6\t…`）；终文本 `epsilon` 一致；`result success is_error=False` 一致。
- **漂移 1 — `system:thinking_tokens` 事件**：官方全程持续发射（`{estimated_tokens, estimated_tokens_delta}`，本 run 数十条）；OCC **0 条**。SDK/编程消费者可见的契约面。
- **漂移 2 — `system:init` 字段集**：官方 23 字段，OCC 13。官方独有：`analytics_disabled, capabilities, fast_mode_disabled_reason, memory_paths, messaging_socket_path, per_turn_effort_active, product_feedback_disabled, terminal_slash_commands, view_mode`。
- **漂移 3 — `result` 字段集**：官方独有 11 字段：`api_error_status, fast_mode_disabled_reason, first_content_frame_ms, queued_turn_count, result_index, safety_stops, subagent_stats, terminal_reason, time_to_request_ms, ttft_ms, ttft_stream_ms`（OCC 已有 fast_mode_state/is_error/modelUsage/permission_denials/stop_reason）。
- **裁决**：STAGED，建议独立小切片（stream-json 契约定为 SDK 面，部分字段绑官方基建——messaging_socket_path/analytics_disabled 需 N/A 甄别；thinking_tokens 与 ttft/时延字段可低成本补）。与 occ154 STAGED #013（model/token）家族相邻，triage 时并看。

### GAP occ156-11（P3，resume picker 文案/热键漂移）

`--resume` picker tmux A/B（共享 CLAUDE_CONFIG_DIR，**双侧互读对方 session 文件成功** — 会话格式互操作 parity，正面结论）：搜索框 `⌕ Search…`、条目格式 `3 seconds ago · HEAD · 6.3KB` 一致。漂移：

| 项 | 官方 | OCC |
|---|---|---|
| 标题 | `  Resume session` | `Resume Session`（大小写/缩进） |
| 项目分组头 | `  repl`（folder 分组） | 缺 |
| Ctrl+B 提示 | `Ctrl+B to only show current branch` | `Ctrl+B to toggle branch` |
| 预览热键 | `Space to preview` | `Ctrl+V to preview`（**功能级差异**：预览触发键不同） |
| 尾缀 | — | 末尾多 ` ·` |

- **裁决**：STAGED（cosmetic+1 个热键行为差；小切片可清）。

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
| 核心主干: footer/agent-status | ✅ → GAP occ156-01（全模式循环补充证据） |
| 核心主干: session/resume | ✅ picker A/B → GAP occ156-11；会话文件跨侧互读 PARITY |
| 核心主干: 工具调用/权限 | ✅ 模式循环 4 态逐字节一致；`--permission-mode` 六选一致；默认模式差 → GAP occ156-03；工具流 stream A/B 见 §2 补充 |
| 核心主干: hooks 行为 | ✅ §6.1（4-run 矩阵） |
| 核心主干: MCP | ✅ `mcp list` 双侧一致（仅品牌名 claude/occ 差，属 N1 类）；深度 MCP 会话面属 occ154 #048 STAGED 家族 |
| 核心主干: /command palette | ✅ → GAP occ156-06 / occ156-07 |

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

## §7 STAGED verify-first triage（2026-10-13，本轮完成）

方法：verify-first 5 项逐个 src/test 取证；quick-win 族对照 296 UT battery（29 文件）+ prod grep 定消化状态；大成本族按 taskbook 结转 STAGED。**无静默丢弃：occ154 §8.2 28 项 + occ153 余 2 项全部列出处置。**

### 7.1 verify-first 5 项处置

| # | 项 | 取证 | 处置 |
|---|---|---|---|
| #013 | model/token | `claude-haiku-4-5` 已注册（`tokenEstimation.ts:270`、`model/configs.ts`）→ "未注册则 N/A" 出口不成立；`modelCostSonnet55CacheRead296.test` 已覆盖 cache-read 成本 | **部分消化，余 adaptive-thinking budget 半继续 STAGED** |
| #015 | hook 输出改写 | `claudeCodeHints.ts`：`extractClaudeCodeHints`（官方 Mct）+ `stripHintTagLines`（官方 lL sanitizer），`hintTagSanitize296.test` 201 行 | **DIGESTED（296 轮已 port，出 STAGED）** |
| #018 | /diff 期间 toasts 挂起 | OCC 无通用 toastQueue 基建（仅 `ScrollKeybindingHandler.tsx:387` selection-copy toast） | **STAGED（N/A-leaning，待通用 toast 面落地后复核）** |
| #038 | /code-review 输出尾格式 | `commands/review.ts` 57 行薄壳 + `review/` 目录存在；palette 描述与官方一致（本轮 join 无漂移）；raw-JSON-array 尾格式需 live run 验证 | **STAGED（verify-first 半完成，余行为验证）** |
| #060 | dataviz | 命令面已实体（`dataviz.ts` prompt 型 + `datavizSkillContent.test` 色板/四序列断言）；但官方以 **built-in skill** 形态入 /context 列表（~480 tokens），OCC skill 形态缺 | **STAGED（精化：并入 occ156-09 built-in skills 大包）** |

### 7.2 quick-win 族消化状态（对照 296 battery + prod grep）

| # | 族 | 证据 | 处置 |
|---|---|---|---|
| #044 | OTEL git_commit_id | `otelGitCommitId296.test` + prod `toolExecution.ts` | **DIGESTED** |
| #046 | U+2028/2029 | prod 命中 `commands.ts` / `subagentOutputSanitizer.ts` / `loadAgentsDir.ts` + `workflowScriptCrlf296.test` | **DIGESTED** |
| #027/#028 | prototype-key | `optionKeySafety.ts`（occ154 注：295#062 已落）+ `pluginSecretsProtoKeys296.test` + `marketplaceConstructorName296.test` | **DIGESTED** |
| #036/#047 | PowerShell/gitbash | `powershellSessionEnv296.test` + `gitBashPaths296.test` + `sessionEnvPlainAssignments296.test` | **DIGESTED** |
| #017 | OSC52/VTE | `osc52VteGuard296.test` | **DIGESTED** |
| #049 | plugin HTTPS retry | prod 未见对应 retry 逻辑（仅 migration 注释） | **STAGED** |
| #057 | hook debug log | `hookEvents.ts` 弱命中，未定案 | **STAGED** |

### 7.3 大成本/其余族结转（全部 STAGED，入口以本 §7.3 为准）

#033/#034/#062 autoBackground/`←` 家族（**关联本轮 occ156-01 footer agent-status + occ156-06c /fork，建议三包合并排期**）、#005/#020/#035 plugin hook、#048 MCP graceful shutdown、#012 teleport、#018/#051/#052/#056 UI 杂项、#039 artifact、#042 startup hang、#038 /code-review（余行为验证）、#055 frontmatter debug（`agentFrontmatterWarnings296.test` 相邻覆盖警告面，debug-log 面未定案）、#057、#049、#013 余半、#060（并入 occ156-09）。
**occ153 §8.2 余 2**：#090、#095 继续 STAGED（本轮无新证据）。

**本轮新增 STAGED**：occ156-01（footer agent-status，RE turnkey 存档）、occ156-02（classifier 计费公告）、occ156-04/05（splash 分隔符 + ThemePicker 编号）、occ156-06（palette 命令集）、occ156-07（描述文案 ×11）、occ156-08（/status 面）、occ156-09（/context built-in skills ×9 + 布局）、occ156-10（stream-json envelope）、occ156-11（resume picker）。
**升级通道**：occ156-03（auto mode 默认，P1）→ Leader 已裁决 **STAGED-BY-LEADER**（裁决评论 `b16f18f6`，详见 §3 occ156-03 裁决补记；复议触发条件 = 官方 stable ≥ 2.1.296）。

### 7.4 安全审核 LOW 项 verify-first 登记（Leader 裁决 `b16f18f6`，下轮处置）

`7b17869` 安全审核 PASS（`f243887c` + `10dd1435`，无 CRITICAL/HIGH），LOW×3 处置：

| 项 | 内容 | 状态 |
|---|---|---|
| LOW-1 | `main.tsx:2677` nudge accept persist 后重查闸无 try/catch（persist 失败异常路径） | **下轮 verify-first**（不阻塞 2.1.381 发版） |
| LOW-2 | 显式 CLI 模式（如 `--permission-mode`）下 nudge 抑制行为，需与官方 `aMr` 对照字节取证 | **下轮 verify-first**（官方 aMr 对显式 CLI 指定的行为核对） |
| LOW-3 | gate_off 时不应发 `tengu_auto_default_nudge_resolved` 遥测 | **已关闭**（`035311d` 修正 + merge-semantics 单测在案） |

## §8 修复/交付

**本轮程序员产出为零 src/ 生产代码改动（10 个 docs-only commit）；但交付 HEAD 范围含 1 个并行轮 src feat（`7b17869`，OCC-115），计数口径按验收 F2 修正如下。**

- **变更集（口径修正）**：交付范围 `3b9ec3a..3958dfb`（及后续修订）= **11+ commits：10 个 occ156 docs-only**（工作分支 `agent/occ156-selfaccept` 上 8 个增量 commit fast-forward 合入 + §8 补记 2 个）**+ 1 个生产 src feat `7b17869`**（OCC-115 并行轮，cnwenf 提交，auto-default nudge，988+44 行 src 变更——非本轮产出，但落在交付 HEAD 范围内）。此前交接文字 "10 个 docs-only commit" 口径不成立，予以更正。
- **`7b17869` 安全审核归属（验收 F2.2）**：该 src feat 变更权限模式面（auto-default nudge），截至本修订**无安全审核链记录**（occ115 账本无安全审核节、无对口 multica issue）。归属裁定：**不并入 occ156-03**（occ156-03 = "是否无条件默认 auto + 迁移" 的产品决策，归 Leader）；`7b17869` 的代码安全审核为独立前置项，**已在 OCC-156 线程补走 @OCC 安全审核员**。在安全审核证据（或 Leader 明确 Waive 记录）落帖之前，含该 commit 的 HEAD **不得进入发版决策**，后续轮次勿误判为已审。
- **CI**：main HEAD `3958dfb` run `38297606817` **success**（https://github.com/cnwenf/occ/actions/runs/38297606817）；本次口径修正 commit 的 run 结果在复审交接评论中给出。
- **分支清理（taskbook #4 + 验收 F1）**：① 远端残留分支 `agent/occ/2db3a4dc` 已不存在（此前已被删除）；② 本轮工作分支 `agent/occ156-selfaccept`（tip `e150dc2`，已确认为 main 祖先、内容全量合入）已 `git push origin --delete` 删除。远端现收敛为**仅 main**。
- **发布纪律**：未打任何 tag；`2.1.381` 严禁抢跑，待验收 PASS 后由发布流程决定。**终态（2026-10-13）**：安全审核 PASS（`10dd1435`）+ 验收复审 PASS（`c5ba76dd`）后，Leader 裁决批准发版 v2.1.381（`b16f18f6`）；release commit（CHANGELOG + version bump + 本账本 §3/§7.4/§8 补记，零 src/）基于 `035311d`。
- **升级项**：occ156-03（auto mode 默认 + 公告 + opt-in 迁移，P1）按 taskbook「拿不准→问 Leader」升级。**中途更新**：并行轮 OCC-115 已落 `7b17869`（auto-default nudge：`autoDefaultNudge.ts` + `AutoDefaultNudgeDialog.tsx` + main.tsx 启动块，accept→startup 切 auto；官方 gate aMr/dialog qhe/resolver Ckt+Tkt 字节核验），覆盖 occ156-03 的 nudge/公告面；**残余 delta**（是否无条件默认 auto + `tengu_migrate_reset_auto_opt_in_for_default_offer` 迁移 + `skipAutoPermissionPrompts` 逃生门）仍待 Leader 定夺。
- **交接（口径修正）**：本轮程序员产出为 docs-only，但交付 HEAD 含 `7b17869` src feat → 按 taskbook #6 完整路由应为 **先 @OCC 安全审核员（对 `7b17869`）再 @OCC 验收员复审**；首次交接按 "docs-only 直送验收" 路由属技术性越权（验收 F2 认定），已补正。
