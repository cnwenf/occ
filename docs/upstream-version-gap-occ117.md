# OCC-117 — 版本追齐 2.1.261 → 2.1.263（gap 调研 + 定性）

- **日期**：2026-09-07（autopilot 触发）
- **官方最新版**：`2.1.263`（npm `@anthropic-ai/claude-code` latest/next，2026-09-06T02:07:58Z 发布；本轮复核时再次核验 dist-tags）
- **`2.1.262` 未发布**：npm versions 列表无此版本（2.1.261 直接跳到 2.1.263），官方 CHANGELOG 无 2.1.262 段落 —— 按 skill 规则跳过未发布版本。
- **OCC 对齐点（本轮开始时）**：`2.1.261`（OCC release 2.1.323，main HEAD `532f515`）
- **官方 2.1.263 CHANGELOG**：仅一条 —— *"Bug fixes and reliability improvements"*。
- **取证材料**：`/tmp/occ117-diff/`（官方 2.1.261 / 2.1.263 linux-x64 tgz 各自解包 `v261/package/claude`、`v263/package/claude`；`strings -n 8 | sort -u` 全量 dump `s261.txt`（274224 行）/ `s263.txt`（274236 行）；`comm` 双向 diff `added.txt`（9951 行）/ `removed.txt`（9939 行））。所有定性均按 `aligning-with-official-binary` 纪律以 `grep -aboF` + `dd` 逐字节核验，未采信任何复述（含 Leader 预取证），未发明任何值。
- **二进制 sha256**（非 byte-identical，需内容级 triage）：
  - 2.1.261：`4ae40dd1784e85753e742e09f267d29ecbb82890361ad3817d27560866d364a6`
  - 2.1.263：`26d020351e8112f4006790f3cfce43b4c9df0c1bb1d0e542364d64151b81d5ba`
- **本轮结论**：**纯 no-op 轮，无可移植实体改动，OCC 零代码变更**。2.1.263 的全部实质改动 = 2 处 Anthropic 后端 gate 专属实验（§1、§2）+ 1 处 first-party beta 错误恢复路径（§3）+ ~9.9k 行 minify churn（§4 全量扫描零用户可见面）。按 issue 描述转入严格自验收（§5）。docs-only，按 OCC-88 先例不发版（§6）。

---

## §1 后端专属不移植 — `CLAUDE_CODE_POLISHED_DEWDROP` / `tengu_polished_dewdrop`（thinking prefix mismatch 实验）

**263 新增 env 全量核查**：`CLAUDE_CODE_[A-Z0-9_]+` 提取 comm diff，261→263 新增仅 `CLAUDE_CODE_POLISHED_DEWDROP` 一个（`...DEWDROPG` 为正则贪吃相邻 minified 导出字符的伪影，byte 上下文证实同一变量）；`ANTHROPIC_[A-Z0-9_]+` 面零增删；removed 为空。261 二进制中 `grep -aboF 'CLAUDE_CODE_POLISHED_DEWDROP'` 零命中，263 三处命中（offsets 96041992 / 177269309 / 186086439）。

**逐字节取证（263 @186086439 代码区）**：

```js
var Pis="tengu_polished_dewdrop";
function Mar(e){switch(e){case"drop":return"drop_block";case"block":return"error";default:return}}
function Oar(){ {if(!ju())return;               // ← 硬门控
  let e=a.CLAUDE_CODE_POLISHED_DEWDROP;
  if(e!==void 0)return Mar(e);
  return Mar(I(Pis,""))} return }               // env 优先，其次后端 gate 值
```

- `ju()` 定义（263 @178283619）：`function ju(){return Le()==="firstParty"&&po()}`，其中 `po()` = `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` 覆盖 || `ANTHROPIC_BASE_URL` 未设置 || 其 host ∈ `["api.anthropic.com"]`。即**整条路径仅在 Anthropic 官方后端（first-party + api.anthropic.com）激活**。
- 消费点：返回值挂 `thinkingPrefixMismatchBehavior`（263 新遥测字段），进 `tengu_api_query` 事件（@183902542 `Pxn({...,thinkingPrefixMismatchBehavior:D,...})` → `i("tengu_api_query",{...,thinkingPrefixMismatchBehavior:He(D),...})`）。行为语义 = thinking 前缀不匹配时 `drop`→丢弃该 block（`drop_block`）/ `block`→报错（`error`），配合既有 prefix-lock stripping 机制（`prefix-lock rejection` 文案 261/263 均 3 处，非本轮新增）。
- `ju()` 引用面 261→263 从 7 处涨到 26 处（unique-strings 计数复核一致）：官方在把更多实验路径收拢到 first-party 门控后 —— 均为同性质后端专属化，无用户可见面。

**定性：后端专属不移植。** gate `tengu_polished_dewdrop` 由 Anthropic GrowthBook 后端下发，且 `ju()` 硬门控 first-party + api.anthropic.com；OCC（任意 base URL / 非 first-party）下 `Oar()` 恒返回 `undefined`，行为与 261 完全一致。移植 = 引入死代码 + 伪 env 面，违反 skill「feature-gated 后端依赖不移植」规则。

## §2 分级保留（后端 gate 驱动，OCC 无基座）— effort medium nudge 泛化

**261 形态**（@91578368 字符串区 + 代码区）：硬编码对话框文案 "Switch your default effort to medium?" / "Yes, use medium effort by default" / "No, keep high"，单一 gate `tengu_radiant_island`，单一全局状态 `hasSeenEffortMediumNudge`。

**263 形态**（逐字节核验）：

- 文案模板化（@91579080）："Switch your default effort to **{to}**?" / "Yes, use **{to}** effort by default" / "No, keep **{from}**"；渲染器 `vse()` 做 `{model}`/`{from}`/`{to}` 三占位符替换，`copy.title/body/confirmLabel/cancelLabel` 可被后端 gate config 整体覆盖。
- 新警告文案（@91749371）：`{from} effort uses more tokens per task than {to}.` + `{from} effort is ~Nx the estimated cost of {to} (the default).`（倍率来自模型配置 `effort_cost_index`，格式化器 `Oot()`：`<0.1 → ~0.0Xx`，否则 `~N.Nx`）。
- gate-config zod schema（@200847400）：`body`(≤W7 行)/`confirmLabel`/`cancelLabel`/`cancelFirst`/`fromEffort`(string|string[])/`toEffort`/`showWarning`/`warningText`，控制字符与单行 refine；解析失败或部分字段非法 → 遥测 `("effort_medium_nudge","served_copy_invalid")` 并降级（剔除非法字段重 parse；`toEffort ≥ 所有 fromEffort` 不成立则整体作废 `Aet()`）。
- per-model flag 表：`var v2={"claude-opus-5":{flag:"tengu_radiant_island",from:["high"]},"claude-fable-5-1":{flag:"tengu_steady_plum",from:["high","xhigh","max"]}},Det="claude-opus-5"`（@200848357）。`tengu_steady_plum` 为 263 新 gate（261 零命中），`tengu_radiant_island` 两版均存在。
- per-model 已读状态：`hasSeenEffortMediumNudgeByModel`（263 新增，261 零命中）+ 旧键 `hasSeenEffortMediumNudge` 向后兼容（`C3t()`：opus-5 需新旧两键均真才算已看过；`Let()` 写入时双键同步）。
- 触发条件链（`Net()`/`$be()`）：onboarding 完成 && 模型在 v2 表 && 未看过 && 当前 effort ∈ from 表 && **后端下发了合法 gate config**（`I(flag,{})` → `_3t()` 返回 undefined 即整个 nudge 不出现）&& 非 bridge/reattach/ultracode 等排除态；cohort 分 `default` / `user_pin`（用户 settings 显式钉住该 effort）。
- 对话框组件 `HFe`（@201580434）：`cancelFirst` 控制选项顺序（screen reader 恒 cancel-first），遥测 `tengu_effort_medium_nudge_shown{cohort,option_order,nudge_model,from_level,to_level,warning_shown}`。

**settings 面核查**：zod-optional-settings-key 全量提取 comm diff，261→263 唯一新增 `showWarning` —— 属 nudge gate-config schema（后端下发 JSON），**非 settings.json 用户键**；`.describe(` 出现次数 2037 = 2037，describe 文案提取 comm diff 为空。用户可配置面零变化。

**定性：分级保留（后端 gate 驱动，不移植）。** 整个 nudge（含 261 的硬编码版）依赖 Anthropic GrowthBook 下发 gate config 才会出现；OCC 从未实现 nudge 基座（`src/` 中 `hasSeenEffortMediumNudge`/`radiant_island` 零命中，历轮台账一致定性后端专属），263 的泛化只是把「后端下发什么文案就显示什么」参数化，OCC 侧无任何可观测行为差。若未来官方将 nudge 转为无 gate 的常开行为，再按届时的二进制形态移植。

## §3 天然 no-op（first-party beta 专属恢复路径）— `tengu_thinking_binding_rejected_retry`

**Leader 预取证未列、本轮全量 gate diff 新发现**：`tengu_[a-z0-9_]+` 提取 comm diff，261→263 新增 gate 共 3 个 = `tengu_polished_dewdrop`（§1）、`tengu_steady_plum`（§2）、`tengu_thinking_binding_rejected_retry`（本节）；removed 为空。

**逐字节取证（263 @186131785 代码区）**：新 handler `XZ` —— 当服务端拒绝 `thinking-binding-controls-2026-08-01` beta（`Got(et)` 匹配拒绝错误）且该 beta header 确已发出（`Sh.includes(e1.header)`）时：置 `Wa=!1`、清 `block_binding` 值、从 header 列表剔除 `e1`，warn 日志 *"[thinking] server rejected the thinking-binding-controls beta; dropping the header and the block_binding value for this conversation and retrying."*，遥测 `tengu_thinking_binding_rejected_retry{model}`，返回重试标记 `"retry:thinking-binding-controls"`。

**家族定位**：这是既有「beta 被拒 → 丢弃 → 重试」错误恢复家族的第三个兄弟 —— `tengu_thinking_display_rejected_retry`（thinking.display updates）、`tengu_thinking_token_count_rejected_retry`、`tengu_effort_unsupported_retry` 三者在 261 已存在（字符串计数两版均 2，非本轮新增）；`thinking-binding-controls` beta 本体（header 定义 @178678661、内置 Bedrock/Vertex 支持矩阵文档 @215221188）261 也已存在（计数 3），263 只是补上了它的拒绝恢复分支（计数 3→6）。

**OCC 侧核查**：`src/` 全量 grep `thinking-binding-controls`/`block_binding`/`thinking-display-updates`/`thinking-token-count`/`retry:thinking`/`effort-unsupported` **全部零命中** —— 整个 beta 家族（含 261 已有的三个兄弟）OCC 均未实装，历轮定性一致：这些实验 beta header 仅在 `qh()`（`ws()`= firstParty/foundry/特定 proxy && 未禁用 experimental betas && 非 hipaa）下随请求发出，Anthropic 后端专属。OCC 不发这些 header → 服务端不可能拒绝它们 → 恢复路径不可达。

**定性：天然 no-op / 后端专属不移植。** 无可移植面（守卫逻辑的前提条件在 OCC 中恒假）。

## §4 全量 diff 扫描 — 其余 ~9.9k 行增删均为 minify churn，零用户可见面

对 `added.txt`(9951) / `removed.txt`(9939) 的系统性扫描（全部为 261/263 双侧对照）：

| 检查面 | 方法 | 结果 |
|---|---|---|
| slash 命令 | `type:"(local-jsx\|local\|prompt)",name:"[a-z-]+"` 全量提取 sort+diff | **121 = 121，逐条一致，零增删** |
| 工具面 | `name:"[A-Z][A-Za-z]+"` 提取 diff；`isConcurrencySafe` 计数 | 零增删；91 = 91 |
| CLI flags | `--[a-z][a-z0-9-]{2,30}` 提取 comm -3 | **零增删** |
| settings schema | `.describe(` 出现次数；describe 文案提取 diff；zod-optional 键 diff | 2037 = 2037；文案零 diff；键唯一新增 `showWarning`（§2 gate-config，非用户设置） |
| env 面 | `CLAUDE_CODE_*` / `ANTHROPIC_*` comm -3 | 新增仅 §1 一项；ANTHROPIC_* 零增删；removed 零 |
| hooks 面 | 11 个事件名计数（PreToolUse 96、PostToolUse 78、UserPromptSubmit 45、StopFailure 14、SubagentStart 18、SubagentStop 29、PreCompact 26、SessionStart 63、SessionEnd 29、PermissionRequest 86、Notification 264） | **全部两版一致** |
| 错误恢复机制 | `Removed base64` 2=2、`media-strip` 5=5、`cache-diagnosis` 4=4、`prefix-lock rejection` 3=3 | 全部两版一致（非新增） |
| 用户可见语句 | added 中句子形态行（`^[A-Z][a-z]+ [a-z]+ [a-z].*[.?]$`）26 行逐条 distinctive-substring 双版计数比对 | **26/26 均为长模板串内变量重命名导致的整行 churn**（如 StopFailure 文档、Explore agent 描述、teleport 标题生成 prompt 等，双版计数全等）；`^(Error\|Warning\|Failed)` 开头新增 0 行 |
| gate 面 | `tengu_*` comm -3 | 新增 3 个（§1/§2/§3 各自定性）；removed 零 |

结论：**2.1.263 对 OCC 无任何可移植实体改动**（守卫逻辑/错误文案/行为修复均无）。changelog 唯一条目 "Bug fixes and reliability improvements" 的实际内容 = §1–§3 的后端实验/恢复路径 + minify churn。

## §5 严格自验收（no-op 轮，按 issue 描述转入）— 实际结果

### 5.1 2.1.261 轮（OCC-116）新落地功能优先验收

**keybindingFlavor 弃用（Ctrl+W / Alt+F / Alt+D 恒 readline 行为）** — tmux REPL A/B（OCC `dist/cli.js` vs 官方 2.1.263 原生二进制，同一驱动脚本、同一 seeded HOME、200x50 pane）：

| 检查项 | OCC | 官方 2.1.263 | 结论 |
|---|---|---|---|
| `hello world test` + Ctrl+W ×1 | 剩 `hello world ` | 剩 `hello world ` | 一致（whitespace-kill） |
| 再 Ctrl+W ×1 | 剩 `hello ` | 剩 `hello ` | 一致 |
| `one two-three four` 行首 M-f M-d | 剩 `one three four` 形态（`two-` 被 kill，标点分词） | 同 | 一致（readline 标点分词） |
| Shift+Tab 模式循环 footer | `⏵⏵ bypass permissions on (shift+tab to cycle)` → `⏵⏵ auto mode on` → `⏸ manual mode on` | 逐字符相同 | 一致 |
| `/status` 渲染 | OK（model/version/cwd 行齐） | OK | 一致 |
| 真实 bash 工具环任务（`echo occ117-trunk-ok`） | TRUNK TASK OK | OK | 一致 |
| e2e 回归 | `version-2.1.261-keybinding-flavor-deprecated` / `version-2.1.239-keybinding-flavor` / `repl-interactive`（除已知环境性 auto-mode 项）在全量门中全部通过 | — | 绿 |

**bashOutputMaxChars 截断语义** — seeded `{"bashOutputMaxChars": 4000}`，`-p --output-format=stream-json --verbose` 驱动真实 `seq 1 3000`（13.6KB 输出）bash 工具调用，双侧对照：

| 检查项 | OCC | 官方 2.1.263 | 结论 |
|---|---|---|---|
| tool_result 形态 | `<persisted-output>` wrapper + `Output too large (13.6KB). Full output saved to: …/tool-results/<id>.txt` + `Preview (first 2KB)` | 同构同文案 | 一致 |
| tool_result 长度 | 2228 chars | 2236 chars（差值恰为 session 路径长度差） | 一致 |
| 持久化全量文件 | 存在，13893 bytes，3000 行完整（`…2999\n3000\n`） | 存在，13893 bytes | 一致 |

`taskOutputMaxChars` 走同一 `clampOutputChars`/persisted-output 管线（`src/utils/shell/outputLimits.ts`，官方 `ree`/`OBt`/`Kut` 对齐已在 OCC-116 逐字节核验），本项以 bash 侧行为实证代表管线语义。

### 5.2 核心主干

- `occ -p` 非交互真实模型往返：`say PONG` → `PONG`，exit 0。
- REPL 像人类一样使用：boot→输入编辑→模式循环→slash→真实工具任务→`/exit` 全链路绿（5.1 表）。

### 5.3 全量门 `scripts/ci-test.sh`（逐文件 bun 进程隔离，424 文件）

**3524 pass / 15 fail / 12 skip。** 15 个失败 = 历轮台账（OCC-110…115）记录的**已知环境性 tmux/live-model e2e 基线**，文件集与失败数逐一吻合（trust-gate ×4、goal-gate ×2、plan-approval ×2、commands-behavior `/feedback` ×1、feedback-ai ×1、goal-panel ×1、repl-interactive auto-mode ×1（OCC-44 起记录的既有项）、resume-command-name ×1、screen-reader ×1、workflow-save-dialog ×1）。本轮零代码变更 → 不可能引入回归；失败签名（gh 凭据依赖、tmux 时序、live-model 依赖）与基线一致。安静机器串行复跑确认非并发扰动、签名相同。

### 5.4 与官方 2.1.263 交互一致性对照（--help 面）

- 官方有而 OCC 无的 flag：`--permission-prompt-tool`（OCC 已注册仅 hideHelp）、`--teleport`（已注册）、`--restricted`（occ107/108 分级保留）、`--cloud`/`--environment`（occ110/111 分级保留）、`--permission-prompts`（occ114 Gap-114a 分级保留 P0）、**`--system-prompt-snapshot`（本轮自验收新发现，见 5.5）**。
- 其余面（slash 121 条、工具名、hook 事件、settings schema、env）§4 已证两版零 diff，OCC 对齐面无新增偏差。

### 5.5 自验收新发现（记录，不在本轮移植）— `--system-prompt-snapshot`

官方 **2.1.261 即已存在**（非 263 新增；两版二进制 `--system-prompt-snapshot` 计数一致，故 §4 的 flag diff 为零）的 CLI flag，OCC 未实现，且**历轮台账均未记录过**。二进制内完整描述（263 @98958378）：*"Record the system prompt once per conversation and reuse it verbatim on every request and resume (recommended: on)… No effect where system-prompt recording is not yet enabled."* —— 描述自证：**依赖 rollout-gated 的 system-prompt recording 基座**，基座未启用时该 flag 无任何效果。OCC 无该基座 → 单独移植 flag = 伪面。**定性：分级保留（staged）**，待官方将 recording 基座转为常开后再按届时二进制形态评估；本轮为 docs-only no-op，不因此扩围。

### 5.6 自验收结论

2.1.263 轮无新增可验收面；2.1.261 轮落地功能与官方 2.1.263 行为逐项一致；全量门与基线一致。**未发现需要修复的新 gap**（5.5 为记录性发现，定性 staged）。结果同步于本 issue 收尾回报评论。

## §6 发版定性

本轮 **docs-only**（本台账 + 零代码变更），按 OCC-88 先例**不发版**：OCC release 保持 2.1.323，对齐点推进为「官方 2.1.263（no-op 定性）」。`CHANGELOG.md` 头部 "Last fully caught up through" 更新为 2.1.263。

## §7 安全审查记录（全 diff）

- 新增 env `CLAUDE_CODE_POLISHED_DEWDROP` 为 Anthropic first-party 实验开关，OCC 不引入，无攻击面变化。
- 无任何新增网络端点、凭据处理、文件访问路径（ANTHROPIC_* 面零变化；新增字符串中无 URL/端点形态项，句子级扫描 26/26 为既有模板 churn）。
- OCC 零代码变更 → 无新引入后门/指纹提取面；本轮无需安全审核员介入（无安全相关落地项）。

## §8 资源清理

`/tmp/occ117-diff/`（两份 ~215MB ELF + strings dump）在台账落盘、取证复核完毕后删除，遵守 skill「Never leave downloaded binaries in /tmp」纪律。
