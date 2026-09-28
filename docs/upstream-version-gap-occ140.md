# Upstream Version Gap — OCC-140（2.1.283 严格自验收轮 + v2.1.358 结转清偿）

- **日期**: 2026-09-29
- **官方最新（Leader 开工核查）**: `2.1.283`；OCC 追齐基线 `2.1.283`，**gap = 0** → 本轮为严格自验收轮
- **轮中上游动态**: 官方 `2.1.284` 于 **2026-09-28T17:11:59Z** 发布（npm `latest`/`next` 均已翻到 2.1.284）→ 本轮按 OCC-37 先例做 **changelog 级 triage**（§7），移植整体推迟到下一轮（本轮范围已由 Leader 明确圈定为 283 自验收 + 结转清偿；284 是含默认 Sonnet 换版的大版本，需要独立的 binary-diff 轮）
- **OCC 侧**: 已发布 `v2.1.358`（npm `@cnwenf/occ`）；main HEAD `023ccc1`；本轮产出合入 main 后等待验收 → 再切 `v2.1.359`
- **A/B 对照物**: 官方 npm 包 `@anthropic-ai/claude-code@2.1.283` 自带的 **原生 ELF**（`official-cc/node_modules/@anthropic-ai/claude-code/bin/claude.exe`，直接执行打印 `2.1.283 (Claude Code)`；注意 `node .bin/claude` 会报 ERR_UNKNOWN_FILE_EXTENSION——283 的 npm 包 launcher 已是原生二进制而非 JS cli）vs OCC `dist/cli.js`（v2.1.358，clean 源码构建，29.52 MB）

---

## §1 结转清偿（occ99 §6 的 3 项，全部完成）

| 项 | 交付 | 状态 |
|---|---|---|
| **P2** nudge 状态机 wire 回归测试 | 新文件 `test/e2e/version-2.1.283-nudge-statemachine-wiring.e2e.test.ts`（4 探针，全部对 built dist + 顺序 mock SSE 端点走真实 wire）：probe-a next_turn 复位（4 响应：thinking-only → Bash tool_use → thinking-only → 文本答案；断言 4 个 body + bodies[1]/bodies[3] 末尾 nudge 块）、probe-b `stop_sequence` 臂可达、probe-c terminal-MCP 守卫（`CLAUDE_CODE_TERMINAL_MCP_TOOLS=Bash` 环境覆写 → 恰好 2 body、无 nudge 文本）、probe-d StructuredOutput 守卫（`--json-schema` + StructuredOutput tool_use → 恰好 2 body） | ✅ 全绿，且 5 组变异全部按预期被杀/惰性（§2） |
| **P3** registry 补 4 个未断言 id | `src/utils/__tests__/maxTokensRegistry283.test.ts` 新增：`claude-fable-5`（mythos-5 的真实 canonical 落点）、`claude-opus-4-5`（v2.1.358 验收证明的静默回归通道 → mutation kill-switch）、`claude-sonnet-4-5`、`claude-sonnet-4-0` → **官方 20 id 注册表全部有断言**；`src/utils/context.ts` mythos-5 分支注释改为诚实描述（canonical 名不可达该分支，值由 fable-5 分支供给） | ✅ 17 tests 全绿 |
| **P3** nudge e2e 断言精确化 | `test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts` 的 `toContain` 子串断言 → `content.at(-1)` **全等断言**（nudge 是最后一个 user message 的最后一个 content block：text + ephemeral cache_control；不整体冻结 content 数组是因为其中还有动态 system-reminder 块） | ✅ |

## §2 变异验证矩阵（P2 探针的 kill-switch 实证，全部对 built dist 执行）

| 变异 | 位置 | 结果 |
|---|---|---|
| M1 删 `\|\| lastStopReason === 'stop_sequence'` | `src/query.ts:1465` | **probe-b 杀死**（收到 `"\n"` 静默完成——正是 2.1.183 修复前的 bug 形态） |
| M2 删 `!isTerminalMcpToolTurn(...)` | `src/query.ts:1469` | **probe-c 杀死**（期望 2 body，实际 3） |
| M3 删 `!isStructuredOutputTurn(...)` | `src/query.ts:1471` | **probe-d 杀死**（期望 2 body，实际 3） |
| M4 `thinkingOnlyNudged: false,` → 裸进位 `thinkingOnlyNudged,` | `src/query.ts:2044` | **probe-a 杀死**（期望含答案 marker，收到 `"\n"`） |
| M4b 字面删除整行 `thinkingOnlyNudged: false,` | `src/query.ts:2044` | **惰性（probe-a 仍过，12 expect）**——见 §3 |

每次变异后 `git checkout src/query.ts` 还原并重新 `bun run build`；最终 clean 状态 3 个触及文件 **23 pass / 0 fail / 59 expect()**（11.62s）。

## §3 变异语义（探针注释所引用的规范性说明）

**字面删除 @2044 是惰性变异**：`next_turn` 转移构造的是**全新 State 字面量**（`src/query.ts:2032-2046`），删掉 `thinkingOnlyNudged: false,` 后该字段为 `undefined`，而守卫唯一的读取点是 `if (!thinkingOnlyNudged)`（@1473）——`!undefined ≡ !false`，行为不变。因此**忠实的、可检测的"删复位"变异是进位形态**：把该行改成裸 `thinkingOnlyNudged,`（从上一状态展开进位），模拟"忘了复位"的真实回归；probe-a 被构造为杀死该形态（M4 已实证）。任何未来重构若把 next_turn 从 fresh-literal 改为 spread 进位，probe-a 立即变成对真实复位语义的守卫。

官方对照：`Kr` 复位集 @ELF 211098289（`{...Me,...Kr,turnCount}`），nudge 置位 `thinkingOnlyNudged:!0` @211166255-211166700 区段（2.1.183 changelog "Fixed turns silently completing with no visible output"）。

## §4 严格自验收 A/B（vs 官方 2.1.283 原生二进制）

方法（repl-tmux-e2e-testing skill + occ139 方法论）：wire 侧用顺序 mock SSE 端点捕获 `POST /v1/messages` 全量 body；每 run 全新隔离 HOME（预置 onboarding/trust）+ 最小化 env（`ANTHROPIC_BASE_URL` 指向 mock、关 autoupdater/nonessential/retry、`IS_SANDBOX=1`）；REPL 侧 tmux 200×50 + 真实 dashscope 代理（qwen3.8-max）。scratch 工件保留于未跟踪目录 `scratch-ab/`（`nudge-ab.ts`/`nudge-ab-report.txt`、`nudge-dump.ts`/`bodies/`、`maxtokens-ab.ts`/`maxtokens-ab-report.txt`、`captures/`×21、`taskA/`×78、`ab140-report.md`）。

### §4a thinking-only nudge wire A/B（S1–S4）——状态机语义全平价

| 场景 | 指标 | OCC | 官方 2.1.283 | 判定 |
|---|---|---|---|---|
| S1 end_turn nudge + 恢复 | 调用数 / exit / 答案 / thinking 丢弃 | 2 / 0 / 有 / 是 | 2 / 0 / 有 / 是 | **MATCH** |
| S2 one-shot 守卫（连续 thinking-only） | 恰好 2 body、不无限循环、exit 0 | ✓ | ✓ | **MATCH** |
| S3 stop_sequence 臂 | 2 body / 答案恢复 | ✓ | ✓ | **MATCH** |
| S4 tool 循环 → next_turn 复位（nudge 两次） | 4 body / 两次 nudge / tool_result 在第 4 请求 | ✓ | ✓ | **MATCH** |

nudge 文本字节一致：`[Your previous response had no visible output. Please continue and produce a user-visible response.]`；两侧都是最后一个 user message 的最后一个 text block。

### §4b 新发现 **Gap-140b**（staged，非行为级）：官方请求装配 / 缓存拓扑差异

全量 body 对照（`scratch-ab/bodies/{occ,official}-{0,1}.json`）显示官方 2.1.283 print 模式的请求装配与 OCC 有四点结构差异（**与 nudge 无关，首个请求即存在**）：

1. **尾部 `role:"system"` message**：官方把动态段（`# Environment`、可用 agent types、Session-specific guidance 等）作为 messages 数组**末尾追加的一条 `role:"system"` 消息**发送（单 text block，带 `cache_control:ephemeral`）。OCC 无此消息——动态内容以 system-reminder text blocks 内联在**首个 user message**里（skills 列表、currentDate），另有第 4 个 top-level system block（Session-specific guidance）。
2. **cache 断点拓扑**：官方 = `system[1]`（SDK agent prompt）+ `system[2]`（主 prompt）各带 `ephemeral`（无 scope）+ 尾部 system message block[0]；OCC = 仅 `system[2]` 带 `ephemeral` 且含 `scope:'global'` + **最后一个 user message 的最后一个 block** 带 `ephemeral`。
3. **nudge block 的 cache_control**：官方 nudge block 是**裸 text**（无 cache_control）；OCC 的 nudge block 带 `ephemeral`——这是 (2) 中"OCC 在最后 user block 打断点"策略的自然结果，不是 nudge 站点自身的实现差异。
4. **健康探测路径**：官方 `HEAD /api/hello`，OCC `HEAD /`。
5. （附带）首条 user message 的 system-reminder 内容差：官方是 git attribution（Co-Authored-By）reminder，OCC 是 skills+currentDate reminder——属于同一"动态段放置"架构差异族。

**行为影响判定**：对 nudge 状态机语义为零（§4a 四场景全平价）；差异只在 prompt-cache 拓扑与 wire 形态。移植 = 请求装配层的深度重构（REPL/print 双路径、缓存效率、`--exclude-dynamic-system-prompt-sections` 语义交互都要联动），按 aligning-with-official-binary 纪律**不做推测性移植**——staged，留待专门轮次做逐站点 ELF 反编译取证。此前各轮 ledger 均未记录过该差异（grep 全 docs 无命中），为本轮 A/B 首次实测发现。

### §4c max-tokens 注册表 wire A/B —— 20/20 平价

对官方注册表全部 20 个 id，两侧各以 `--model <id> -p hi` 打同一 mock，比对首个请求 body 的 `model` + `max_tokens`（`scratch-ab/maxtokens-ab-report.txt`）：

| id | 注册表 default | OCC wire | 官方 wire | 判定 |
|---|---|---|---|---|
| claude-opus-5-5 | 128000 | 128000 | 128000 | MATCH |
| claude-opus-5 | 64000 | 64000 | 64000 | MATCH |
| claude-mythos-5 / -5-1 | 64000 | 64000 | 64000 | MATCH ×2 |
| claude-fable-5 / -5-1 | 64000 | 64000 | 64000 | MATCH ×2 |
| claude-sonnet-5 | 64000 | 64000 | 64000 | MATCH |
| claude-sonnet-4-6 | 32000 | 32000 | 32000 | MATCH |
| claude-opus-4-6 / -4-7 / -4-8 | 64000 | 64000 | 64000 | MATCH ×3 |
| claude-opus-4-5 | 32000 | 32000 | 32000 | MATCH |
| claude-sonnet-4-5 | 32000 | 32000 | 32000 | MATCH |
| claude-sonnet-4-0 | 32000 | 32000 | 32000 | MATCH |
| claude-haiku-4-5 | 32000 | 32000 | 32000 | MATCH |
| claude-3-7-sonnet | 32000 | 32000 | 32000 | MATCH |
| claude-opus-4-0 / -4-1 | 32000 | **claude-opus-5-5/128000** | **claude-opus-5-5/128000** | MATCH（见下注） |
| claude-3-5-sonnet | 8192 | 8192 | 8192 | MATCH |
| claude-3-5-haiku | 8192 | 8192 | 8192 | MATCH |

注：`claude-opus-4-0/4-1` 两个 **deprecated id 在两侧都被客户端 remap 成 `claude-opus-5-5`/128000** 后才上 wire（注册表 default 32000 不到达请求）——弃用迁移层优先于注册表，且 **OCC 与官方行为逐字节一致**，非差异。

### §4d `--effort` 解析器族 CLI A/B —— 13/13 字节一致

Gap-139a 移植稳固。dead endpoint + 每 run 全新 HOME，`cmp` 级比对 stdout/stderr/exit：`BoGuS`/空串 → 警告文本逐字节一致（分隔符 **U+2014 em dash**、raw 大小写保留、`Valid values: low, medium, high, xhigh, max.`）；`med`/`ultracode`/`HIGH`/`  MAX  ` 等 9 个合法/别名/关键字值静默通过；env `CLAUDE_CODE_EFFORT_LEVEL=med|BoGuS`（无 flag）两侧同样静默。原始流保留在 `scratch-ab/taskA/`。

### §4e REPL tmux A/B（live dashscope 代理，200×50）——主干平价

| 步骤 | 结果 |
|---|---|
| boot | 两侧正常起 REPL；官方多一条首启 "fullscreen renderer" opt-in 对话框（§5 Gap-140e）+ auto-mode 公告；OCC 为 boxed splash + Opus-1M promo（品牌 chrome，预期差异） |
| shift+tab 模式环 ×3 | **环序/文案 MATCH**（同一 mode ring；起点差异见 Gap-140c） |
| chat round-trip | **MATCH**：`Reply with exactly one word: PONG140` → 两侧 JSONL transcript 中 assistant text 均恰为 `PONG140`（官方 `✻ Cooked for 7s · done 2:57 AM` vs OCC `✻ Crunched for 40s`——spinner 动词/时间后缀为 cosmetic） |
| /status | KNOWN（occ139 §3 items 1-2：5 tabs vs 3、rows/layout）+ 新增小项见 Gap-140e |
| /help | **新差异**，见 Gap-140d |
| 未知命令 | 文本 MATCH；suggestion 行 KNOWN（occ139 §2）；bullet 字形 `●`(U+25CF) vs `❯`(U+276F) 记入 Gap-140e |
| quit | 两侧干净退出 |

## §5 本轮新发现的 REPL 侧差异（全部 staged 至下一轮，不在本轮移植）

- **Gap-140c（P1 候选）boot 默认权限模式**：官方（fresh HOME，预置 `migrationVersion:11`）启动时迁移到 **14** 并以 **auto mode** 起（附首启公告）；OCC `CURRENT_MIGRATION_VERSION = 11`（`src/main.tsx:341`）缺官方 12→14 迁移，以 **manual** 起。occ139 §2 曾记录两侧都 boot auto——差异面自上一轮以来暴露（官方 283 把 auto 设为默认权限模式）。与已知 pre-existing failure `repl-interactive auto-mode opt-in`（occ139 §3）同族。移植需要：官方 12–14 迁移的逐项 ELF 取证 + auto-mode 默认翻转的 opt-in 语义联动，行为面大，单独成项。
- **Gap-140d（P2）/help 右列**：官方显示 `/keybindings to customize`；OCC 该行被 statsig gate `tengu_keybinding_customization_release`（默认 false，`src/keybindings/loadUserBindings.ts:41-46`）挡掉——OCC 的 statsig 是 stub，缓存值永远 false。occ139 曾记录 /help 字节一致，说明官方该 gate 的落地默认值已翻 true。修复候选：从 283 ELF 取证官方 gate 默认值后翻转 OCC fallback。另 OCC 多 `alt + o to toggle fast mode` 行（fast-mode 在 OCC 是实功能，合理）与 HelpV2 的 `/feedback` 尾行（行数阈值触发）。
- **Gap-140e（P3 集合）**：官方首启 fullscreen-renderer opt-in 对话框（OCC 无该渲染器，属功能面差异）；session 以首条 prompt 自动命名（OCC 停留 `/rename to add a name`）；/status `Session kind`/`Peer address` 行 + dismiss 文案（`Settings dialog dismissed` vs `Status dialog dismissed`）；未知命令 bullet 字形 `●` vs `❯`；官方 fresh `$HOME` 下仍经 passwd-home fallback 加载 `/root/.claude/AGENTS.md` 并打 `● agents-md:` 提示行（OCC 静默）；chat 时间戳 `· done <time>` 后缀。
- **boot chrome**（OCC boxed splash + promo 行 vs 官方紧凑 logo header）：品牌性预期差异，记录不修。

## §6 沿袭的已知差异（occ139 §3，本轮复核未变化）

/status 5 tabs vs 3 + rows/layout；tmux focus-events advisory bar（官方独有）；manual-mode footer 提示措辞；OCC 未知命令 suggestion 行；pre-existing failures（`bun test src` 73 例、`repl-interactive` auto-mode opt-in、`version-2.1.329-effort-cap` test-f3）。

## §7 轮中上游 `2.1.284`（2026-09-28 发布）changelog 级 triage —— 全部推迟至下一轮

- **P0 模型发布**：新增 `claude-sonnet-5-5` 并成为 Anthropic API 上的**默认 Sonnet**（1M context，$2/$10 per Mtok，cache read $0.20/Mtok）→ 下一轮镜像 Opus-5 发布移植系列（OCC-35→37）：283→284 ELF binary diff、注册表 `max_output_tokens` 条目提取、`getDefaultSonnetModel` 翻转、MODEL_COSTS 定价、1M-capability 集合、/model picker 行、highlight-newest。
- **P0 安全候选（下一轮最优先）**：① `ANTHROPIC_FOUNDRY_RESOURCE` 未经校验被插值进 Foundry endpoint host（官方已改为拒绝非纯资源名）——OCC 有 Azure/Foundry provider 面，需对照自检；② 符号链接进 `.claude/rules` 的外部规则绕过 external-imports 审批提示（`.claude` 目录整体符号链接同样绕过）；③ marketplace/claude.ai/npm 插件在 `allowManagedPermissionRulesOnly` 下用 `allowed-tools` 自我预授权——官方收紧到 Anthropic 官方来源/managed settings 背书的来源；④ Workflow tool sandbox 对 async script hooks 抛错的加固——**OCC 的 `WORKFLOW_SCRIPTS` flag 是 LIVE 的，直接相关**。
- **P1 健壮性**：损坏响应流不再吐 raw "JSON Parse error"/"undefined"而是重试/报 interrupted；thinking block 后紧跟 overloaded/server error 不再以 error 终结而是重试；compact 后仍 "Prompt is too long" 时二次 compact（少保留近期对话）；**Explore subagent 对未识别 model id 不再切 Opus 而是继承 session model**（代理后自定义模型场景——与 OCC 常用 dashscope 代理直接相关）；MCP resume 时等待 server 连接最多 10s；plan-usage endpoint 退避。
- **P1 vim（OCC 有真实 vim 面）**：`.` 对极速输入/无 bracketed-paste 粘贴的重复失效；`dd`/`yy` 后光标停在 image placeholder 开括号导致 `r`/`x` 破坏。
- 其余（gateway/Desktop/Remote Control/Windows/plugin UI/fullscreen 渲染器/usage-limit UI/Monitor 行渲染//loop 状态可见化//ultrareview worktree/启动内存优化等）下一轮对照 OCC 表面逐项 triage。

## §8 本轮测试与构建

- 触及文件：**23 pass / 0 fail / 59 expect()**（nudge wiring 4 探针 + nudge e2e 2 tests + registry 17 tests）。
- 全量 `bun test src`：**5737 pass / 73 fail / 1 skip**（5811 tests，474 files，157.95s）——失败数与 occ139 记录的已知 pre-existing 集合完全持平（73），失败族（2.1.202 telemetry、2.1.233 signalUnrecognizedModel、2.1.247 DiskTaskOutput、2.1.251 Gap-110d、2.1.274 OAuth 等）均与本轮触及文件无关，**本轮新增失败 = 0**。
- `bun run build`：clean 源码 → `dist/cli.js` 29.52 MB（MACRO.VERSION=2.1.358）。
- 真实 e2e：REPL tmux A/B round-trip 两侧绿（live 代理）；wire A/B S1–S4 + 20 id + 13 effort 全平价。
- 变异验证 5 组（§2），每次变异后还原 + 重建，最终工作树对 src 零残留改动。

## §9 发布与交接

- 本轮产出（4 个测试相关文件 + 本 ledger）合入 main；发布 `v2.1.359` 在验收通过后切（链：安全审查员 → 验收 → tag → publish.yml 自动 npm + GitHub Release → 核验 /releases ≡ /tags）。
- **方法论事故（已遏制，记录在案）**：REPL A/B 第一遍的 projectDir 误设在 multica workdir 内，OCC 模型自动发现 workspace CLAUDE.md 并在 auto mode 下真实执行了一次 `multica issue comment add`——issue 上落了一条游离 `PONG140` 评论，**已删除并复核不存在**；随后两侧均以隔离 projectDir（`/root/ab140-isolated/`）重跑，结果干净。教训固化：A/B 的 projectDir 绝不可落在 agent workdir/任何含 CLAUDE.md 的目录树内。
- scratch 工件（`scratch-ab/`、`official-cc/`）保持未跟踪、不入版本库；关键数据已全部誊录本 ledger。

## §10 合并调和（origin/main 轮中前移 `474a274`，OCC-100 并行清偿同批结转项）

本轮收口时发现 origin/main 已前移：`474a274`（"test: OCC-100 carry-over — nudge 4-probe wire e2e + max-tokens registry nails + byte-exact wire equality"，ledger `docs/upstream-version-gap-occ100-2026-09.md`）对 occ99 §6 的 **同一批 3 项结转** 做了并行清偿。merge base `023ccc1`，三个文件冲突，调和原则 = 不丢任何断言、不回退 main 已合入工作：

| 冲突文件 | 决议 | 理由 |
|---|---|---|
| `src/utils/__tests__/maxTokensRegistry283.test.ts` | **取 OCC-140 版** | 双方新增的是**同 4 个 id、同期望值**（fable-5 / opus-4-5 / sonnet-4-5 / sonnet-4-0）；OCC-140 版另含完整 20-id ground-truth 头表，为文档超集。零断言丢失。 |
| `src/utils/context.ts` | **取 OCC-140 版** | 双方 mythos-5 注释语义等价（canonical 名不可达该臂）；OCC-140 版额外说明"仅裸 `mythos-5` 串可触发（防御性 parity）"。纯注释，无行为差。 |
| `test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts` | **取 main（OCC-100）版** | OCC-100 版已含 §6.3 同款 toContain→全等修复（**涵盖并超出**本轮 +19 行改动），且在同一文件内追加了 probe-a~d 四探针 + negative control。取 theirs 即完整保留双方意图。 |

非冲突产出全部保留：本轮新文件 `version-2.1.283-nudge-statemachine-wiring.e2e.test.ts`（4 探针 + §2 五组变异矩阵实证 + §3 惰性语义）与 main 的 `docs/upstream-version-gap-occ100-2026-09.md` 并存。**已知冗余**：probe-a~d 现存在于两个 e2e 文件（OCC-100 内嵌版 + OCC-140 独立 wiring 版，各自独立变异验证过）——功能重复但断言侧重不同（wiring 版绑定 §2/§3 变异语义，内嵌版含 negative control），合并去重列为下一轮 P3 结转，本轮不动 main 已验收内容。合并后复测：registry 17 tests、nudge e2e 6 tests、wiring e2e 4 tests、occ-versioning+commands-alignment 6 tests 全绿。
