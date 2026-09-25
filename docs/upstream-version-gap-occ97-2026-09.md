# Upstream Version Gap — OCC-97 round (occ97-2026-09)

Round: **2.1.281 → 2.1.282 alignment** (2026-09-26, Leader gap 调研). Ledger: this file.
Prior-round ledger: `docs/upstream-version-gap-occ136.md`（§9 对 2.1.282 已完成
triage-only 预审，本轮按晋升纪律转 PORT）。

> 命名说明：`upstream-version-gap-occ97.md` 已被 2026-08-18 的自验收轮占用，
> 本文件为 OCC-97（2026-09-26 autopilot 轮）的 gap 调研记录，不覆盖旧档。

## §1 版本事实（三方核实，2026-09-26）

| 事实 | 值 | 核验方式 |
|------|-----|---------|
| OCC 当前版本 | `2.1.353`（main HEAD `72609bc`，tracking 上游 `2.1.281` 可移植子集） | `package.json` + git log |
| npm dist-tags | `stable`=2.1.274, **`latest`=2.1.282**, `next`=2.1.282 | `npm view @anthropic-ai/claude-code dist-tags` |
| 2.1.282 发布时间 | npm 2026-09-24T15:56Z；GitHub Release v2.1.282 2026-09-24T18:38Z（标记 Latest） | `npm view ... time` + `gh release view` |
| 官方 CHANGELOG `## 2.1.282` | **已发布，86 条 bullet**（occ136 轮时尚未发布，事实变化） | raw CHANGELOG.md，顶部版本即 2.1.282，无 283+ |
| v2.1.282 linux-x64 二进制 | md5 `54435b7ed06ae1ef9417edda38256c15`，238,767,288 B（与 occ136 §1 记录一致 ✓） | 本轮 fresh `npm pack` + extract |

## §2 晋升判定

occ135 纪律：**绝不从 `next`-only 版本 port**；occ136 §10 列明的晋升条件
"当 npm `latest` 移到 2.1.282 时" —— **现已满足**（latest=2.1.282 且官方
CHANGELOG 已发布 `## 2.1.282` 段，86 条）。

**结论：本轮对齐目标 = 2.1.282，occ136 §9 的全部 STAGE 材料按晋升纪律转
PORT 候选**（逐条仍需 byte-level 复核，STAGE→PORT 不豁免取证）。

## §3 本轮范围（继承 occ136 §9/§10，按优先级）

1. **P1 安全簇（settings-trust）**：mid-pattern `:*` Bash 规则修复 + startup
   warning（与已落地的 P2 NUL-byte guard 同一代码邻域）；managed settings
   部分无效值不再整块丢弃（`permissions`/`autoMode`/`worktree`/`attribution`）；
   boolean lock 键误拼值仍生效并报键名；project/local settings 忽略
   OpenTelemetry 导出开启变量；`sandbox.excludedCommands` 在 managed
   `allowUnsandboxedCommands:false` / `allowManagedDomainsOnly:true` 下忽略
   project/local 条目；skill/command/plugin manifest 在
   `allowManagedPermissionRulesOnly` 下不得经 `allowed-tools` 自我预批；
   `anthropic-skills`/`claude-ai` 命名空间抢注硬化；CLAUDE.md/rules 经 repo
   symlink 触达 macOS `/Network`、`/.vol` 内核路径的读取修复（281 `/.vol`
   STAGE 项的伴生项，一并复核）。
2. **会话/传输可靠性 ★子集**（occ136 §8.3 + §9）：web-search 解密失败 400
   循环、resumed-session 变形重发、immediate slash command 丢 thinking、
   `redacted_thinking` invalid-data drop+retry-once、compaction 拒答→fallback
   model、safety model switch 后 effort-vs-thinking 失败轮、login-refresh
   "another process" 分钟级失败、org-policy fetch 重试、大会话 resume 提速。
3. **UI/UX 批次**：`maxProseWidth`、telemetry-vars startup notice +
   `/status`/`doctor` 条目、bracketed-paste 重置后逐行提交、CJK/emoji diff
   残列、vim 批量轮（§8.7 + §9 vim 三条合并做）等。
4. **NO-OP 组**（occ136 §9 已判，勿重复取证）：Fable credits、[VSCode]、
   [Cloud sessions]、[Claude Tag]、gateway readiness、Bedrock/Mantle
   request-ID、auto-mode server classifier、`claude-api` skill 文案等。
5. 12 个 genuine-new 2.1.282 env 标记（occ136 §9 表）逐个复核处置。

## §4 验收与发布口径（不变）

- 真实 e2e（含 REPL tmux 实操）+ 与官方 v2.1.282 二进制 A/B 对照；
  全量 CI `bash test/e2e/ci-test.sh` 绿。
- 代码合入 main；清理 GitHub 残留分支（当前 `git ls-remote --heads` 仅 main ✓）。
- /releases 与 /tags 一致性保持（当前 153 = 153，缺口清零 ✓）；发版走 issue
  正文固化的 publish.yml 流程。

## §5 P1 settings-trust 安全簇 — 本轮落地结果（全部 byte-level 复核 v2.1.282 ELF）

五个簇全部 PORT 完成，官方字符串经 `grep -aboF` + `dd` 逐条对照
`/tmp/occ97b/package/claude`（md5 `54435b7ed06ae1ef9417edda38256c15` ✓）：

| 簇 | 官方机制 | OCC 落点 | 状态 |
|----|---------|---------|------|
| A. mid-pattern `:*` Bash 规则 | 282 validator 顺序：empty-prefix invalid → allow-only wildcard-before-subcommand → mixes 分支（`Nge`/`eVn`/`wo`）→ mid-pattern valid+warning；281 的 `'The :* pattern must be at the end'` 拒绝在 282 中已移除（0×）；startup warning loop 含 identifier-colon skip 启发式 | `permissionValidation.ts` / `permissionRuleParser.ts` / `permissionSetup.ts`；warning 行 `Permission ${behavior} rule (${sourceLabel}): ${warning}`，sourceLabel 渲染相对 settings 路径（官方无 "project settings" 字样） | ✅ LANDED + `midPatternStarRules282.test.ts` / `startupRuleWarnings282.test.ts` |
| B. policy-source strict parse | 官方 `Wge`/`Ko`/`pd`：never whole-reject；误拼 lock 值→restrictive 替换（fail-closed）；string-boolean coercion（`nx`）；statusOnly vs startup；partial-block salvage（`Ki`/`tg` 4 策略/`zo` grant-withholding/`zi` skeleton）；null=删键（`Oi`）；restrictive 表 `Xe` 数据驱动 | `policyStrictSchema.ts` + `policyLocks.ts`（26 个 OCC 已有键入表；7 个 OCC schema 缺失的 lock 键跳过——机制数据驱动，键补入即自动生效） | ✅ LANDED + `policyStrictParse282.test.ts`；已知 fail-open/静默路径见下方 §5.1 披露（验收 RT③，钉桩测试已补，勿改行为） |
| C. telemetry env + sandbox.excludedCommands | 48-name blocklist（`Gcn`：35 OTLP + 2 Prometheus + enable/exporter + 2 beta + 5 OTEL_LOG_*）；`Vcn` off-only 例外（`ko` falsy 或 exporter="none" 且 project 层无 shadow）；excludedCommands gate `vO`（managed allowManagedDomainsOnly=true ∥ (policy??flag).allowUnsandboxedCommands=false，GrowthBook stubbed false）；read-time filter + 一次性 warning + write redirect（`OIt`） | `managedEnv.ts`（PROJECT_SCOPED_SOURCES 过滤）+ `sandbox-adapter.ts` + `shouldUseSandbox.ts` + `sandboxTypes.ts` schema describe（官方 `Md` 双句 byte-exact）；`/sandbox exclude` caller 改用 outcome-aware 消息（refused → error；added → 实际写入 source 的相对路径） | ✅ LANDED + `projectScopeEnvBlocklist251.test.ts`（扩展）+ `excludedCommandsScoping282.test.ts` |
| D. frontmatter grants + reserved namespaces | `zw()`=allowManagedPermissionRulesOnly；trusted set `FU` {plugin,policySettings,built-in,builtin,bundled}；`ZMe` apply-time gate + once-per-session warn + `tengu_frontmatter_grant_withheld`；reserved ['anthropic-skills','claude-ai']（case-insensitive，gate `tengu_plaid_harbor` default true）：squatter→forced ask + suppressAlwaysAllowRule，loader drop+warn，MCP prompts/skills gated（tools 不动） | `frontmatterGrants.ts` + `reservedNames.ts`；wiring：`SkillTool` / `loadSkillsDir` / `mcpSkills` / `loadPluginCommands` / `forkedAgent` | ✅ LANDED + `frontmatterGrants282.test.ts` / `reservedNamespacePermissions282.test.ts` |

**C 簇措辞更正（验收 RT④，2026-09-26）**：表中"一次性 warning"仅写
**debug 日志**，不是终端可见提示——官方与 OCC 同款。官方 ELF 复核（md5
`54435b7ed06ae1ef9417edda38256c15` ✓）：`IJ()` @199153334 以单参调用
`t(\`[sandbox] excludedCommands restricted…\`)`，而 `t` 即官方 debug wrapper
`function t(e,n={level:"debug"}){R().log(e,n)}` @194169886 → DebugLogger 类
`ft.log`，默认 level "debug"，落盘 `~/.claude/debug/<sessionId>.txt`
（`defaultLogPath()`=`join(configHomeDir,"debug",…)`），仅
`--debug-to-stderr`/`-d2e` 时改写 stderr——常规终端 UI 永远看不到该行。
OCC 落点 `sandbox-adapter.ts` 用 `logForDebugging`（默认 level 'debug'，
同一落盘路径）为 official-parity，非降级。

**D 簇措辞更正（验收 RT④，2026-09-26）**：表中"MCP prompts/skills gated"
需拆开诚实表述——**prompts 侧 gate 是活的**（`fetchCommandsForClient`，
官方 `rZe` port：reserved-namespace server 的每条 prompt 被 drop 并写
byte-exact per-prompt 消息到 MCP debug log）；**skills 侧 gate 目前是
vacuous**：OCC 的 `src/skills/mcpSkills.ts` 是 auto-generated stub，
`fetchMcpSkillsForClient` 对任何 server 都恒返回 `[]`（OCC 本就不加载
MCP skills），reserved-name 检查在 stub 内保留了边界行为（含
`reservedMcpServerSkillsMessage` debug 日志），待 stub 被真实实现替换时
自动生效，但当下无实际拦截面。Tools 侧不受影响（官方同款）。
| E. macOS kernel/automounter denylist + symlink gate | `nE` = UNC-minus-WSL，/net folded，automounter-map `H$`（/net 全平台、/home darwin、≤3 段、无 `..`），`\??\`、`S_` /.vol\|.file\|.nofollow\|.resolve regex、`mL` folded-network；symlink gate `ZO` 祖先不可验证时 fail-closed；4 个 claudemd surface SILENT wiring | `macosKernelPaths.ts`（nE parity）+ `shouldRefuseMemorySymlink`（ZO parity）+ `claudemd.ts` 四触点 | ✅ LANDED + `memorySymlinkRefusal282.test.ts`；Linux 上 plain out-of-repo symlink（如 /etc/passwd）不拒绝 = 官方 parity（denylist 是 macOS 内核路径专属） |

已知推断项（非 byte-exact，已在代码注释标注）：E 簇 `H$` darwin 分支由
linux stub 反推 + message@211555751；`rules_walk_failed` log level 'warn'。

### §5.1 B 簇 fail-open/静默路径披露（验收 RT③，2026-09-26）

验收复核（main `9b36b4d`）发现 B 簇 strict parse 存在三条**静默或 fail-open**
路径。三条均为官方 v2.1.282 二进制同款行为（official-parity），按验收结论
**只披露 + 钉桩，不改行为**（改了就偏离官方 = invented hardening）。钉桩测试
位于 `policyStrictParse282.test.ts` 的 `RT③ fail-open disclosure pinning`
describe 块（3 条），任何后续改动（我方或上游 re-port）都会先翻红这些测试：

| # | 路径 | 行为（实测钉桩） | 根因 | fail-open 后果 |
|---|------|----------------|------|---------------|
| RT③a | `maxEffortLevel` 误拼（如 `"bogus"`/`42`） | `data {}`，**零诊断记录**（连 "This field was ignored." 都没有） | `types.ts` 中该键自带内联 `.catch(undefined)`，在 policy schema 的 generic per-field catch（`policyStrictSchema.ts` step 1）之前就吞掉了 issue | effort cap 静默不生效，管理员无任何提示 |
| RT③b | 顶层 lock 键写 `null`（如 `{disableAgentView:null}`） | 键静默消失，**零记录** —— 与 block 路径 `null`（如 `permissions:null`，有 `Oi` "read as key removal" 记录）**不对称** | lock wrapper 为 `z.union([z.null().transform(()=>undefined), coerced])`，null 分支直接 transform 成 undefined，不经过 onIssue | 管理员以为写了 lock，实际该 source 未设此键且无提示 |
| RT③c | `disableAllHooks` 误拼（含字符串 `"true"`） | 落入 generic catch：一条 "Invalid input: expected boolean, received string. This field was ignored." warning，键被丢弃；**无** string-boolean coercion、**无** restrictive 替换 | `collectLockFields`（官方 `Ni` @194777350 port）显式跳过 `disableAllHooks`（官方同款跳过），故该键不进 lock wrapper | **hooks 保持启用（fail-open）**：管理员写 `"true"` 期望禁 hooks，实际 hooks 照跑；同误拼在任何其他 lock 键上都会 fail-closed 强转 |

`collectLockFields` 的 docstring（`policyLocks.ts`）已补 DISCLOSED
CONSEQUENCE 段落说明 RT③c 后果与"官方同款、不得静默修"的口径。

## §6 会话/传输可靠性 ★子集 — 逐条判定

| 项（occ136 §8.3/§9） | 判定 | 理由 |
|---------------------|------|------|
| web-search 解密失败 400 循环 | NO-OP | Anthropic 后端专属（encrypted web-search tool-result 解密）；OCC gateway 无此密文通道 |
| resumed-session 变形重发（signed reasoning re-sends） | NO-OP | 依赖官方 signing/redaction 后端字段 |
| `redacted_thinking` invalid-data drop+retry-once | NO-OP | OCC 不产出 redacted_thinking 块（后端字段） |
| immediate slash command 丢 thinking | NO-OP | thinking 块传输语义同上，OCC gateway 无 affected surface |
| compaction 拒答→fallback model | NO-OP（伴生 env 已记录） | fallback-model chain 由官方后端下发；282 `DISABLE_REFUSAL_RETRY` env 标记已在 §8 复核归档 |
| safety model switch 后 effort-vs-thinking 失败轮 | NO-OP | safety-switch 是官方账号侧机制 |
| login-refresh "another process" 分钟级失败 | NO-OP | OAuth login-refresh 后端流程；OCC 用 API key/gateway token |
| org-policy fetch 重试 | NO-OP | OCC 无 org-policy 远端拉取 |
| 大会话 resume 提速 | **STAGE** | 唯一 plausible 的 OCC surface（本地 transcript 反序列化路径）；需独立取证项目定位官方 282 的具体提速点（缓存/惰性解析），本轮预算已被 7 个大型 port 占用 |
| parked run before /clear（`PARKED_RUN_BEFORE_CLEAR`） | **STAGE** | 与 /clear REPL 交互耦合，需 tmux 级行为取证；env 标记已归档 §8 |

## §7 UI/UX 批次 — 落地结果

- **maxProseWidth**：✅ PORTED。schema `z.number().int().min(40).optional().catch(undefined)`
  + describe byte-exact（@194756308）；`capProseWidth` opt-in gate（官方 `Ei` wrapper
  语义）：prose/headings/lists/blockquotes 收窄，tables + fenced code 保持全宽；
  call sites `za`/`xs`/`Ge`/`nXn` 对照落点 `Markdown.tsx` /
  `AssistantTextMessage.tsx` / `AssistantThinkingMessage.tsx`。
  测试：`maxProseWidth282.test.ts`（9）+ `components/__tests__/maxProseWidth282.test.tsx`（7）。
- **telemetry-vars startup notice + /status + doctor**：✅ PORTED。官方 `etr()` 语义 =
  状态可派生（重读 settings，无 collector state）；notice id
  `project-telemetry-env`、warning/medium/15000ms；/status 与 doctor 在
  Invalid Settings 之后输出 bare warning 行（官方 `qqr` @217299046 顺序）；
  `VT()` skip = path.resolve 相等（非 realpath）。落点：`telemetryEnvStatus.ts`
  + `useProjectTelemetryEnvNotice.ts` + `REPL.tsx` + `status.tsx` + `Doctor.tsx`。
  测试：`telemetryEnvStatus282.test.ts`（18）。
- **vim 批量轮**：**STAGE**（沿 occ136 §8.7 先例）。~12 处 fix + 3 条新 bullet，
  每条都需 per-site 反编译定位（官方 vim 实现在 minified ELF 中无稳定锚点），
  不允许批量猜测移植；列为下一轮首要候选。
- **bracketed-paste 重置后逐行提交 / CJK-emoji diff 残列**：**STAGE** —
  终端渲染时序类问题，需独立 tmux 取证（OCC 的 Ink fork 渲染路径与官方不同构，
  直接照抄官方 fix 位置无意义，须先在 OCC surface 复现）。

## §8 12 个 genuine-new 2.1.282 env 标记 — 复核结果（全部 ✓ 282-only，binary count 与 occ136 §9 表一致）

| 标记 | 281/282 count | 处置 |
|------|--------------|------|
| `CLAUDE_CODE_WEB_SEARCH_FAST_ARG` | 0/4 ✓ | NO-OP — OCC 无 server-side web_search tool 参数通道 |
| `CLAUDE_TEST_NO_OPEN` | 0/2 ✓ | NO-OP — 官方内部测试开关 |
| `DISABLE_REFUSAL_RETRY` | 0/✓ | NO-OP — 配对 compaction-refusal fallback model chain（§6，后端侧）；OCC 的 refusal 路径无 retry-with-fallback-model 机制可关 |
| `PARKED_RUN_BEFORE_CLEAR` | 0/✓ | STAGE — 与 /clear REPL 交互（§6） |
| 其余 8 个（OTEL_LOG_* 5 个 + telemetry 相关） | 0/✓ | 已并入 C 簇 48-name blocklist 落地（§5），非独立 surface |

结论：12 标记无一需要独立于 §5 簇的新代码；2 个 STAGE 关联项已挂账 §6。

## §9 本轮测试与 CI 口径

- 单元测试：全部新增 282 套件 + 相邻套件绿（per-file 进程隔离，
  `scripts/ci-test.sh`；bun `mock.module` 为进程级永久 mutation，
  C 簇修复沿用 snapshot-before-mock 恢复模式）。
- tsc：repo 基线本脏（HEAD 716 errors，多为历史 `unknown`/`never`）；
  gate = 本轮 touched files 零新增错误 ✓（REPL.tsx:2142 为基线 2140 行
  同一 pre-existing 错误，行号因 +2 行 hook 插入而位移）。
- lint：`bun run lint` 退出码非零来自 pre-existing 基线（yoga-layout/
  bashSecurity/screen-reader-render/InvalidConfigDialog），CI 中 lint 为
  informational（continue-on-error）；本轮 touched files 无新增 lint 错误。
- e2e A/B triage（当前树 vs pristine HEAD worktree，同机同 env）：

| 文件 | 当前树 | HEAD 基线 | 判定 |
|------|--------|-----------|------|
| commands-behavior（/feedback live-model ×2） | 复跑 16/16 pass | 16/16 pass | 首跑失败 = live-model flake，非回归 |
| repl-interactive（Shift+Tab auto-mode dialog） | fail | fail（同样） | pre-existing（OCC-44 已记录 stash A/B 同败） |
| version-2.1.208-screen-reader | fail | fail（同断言） | pre-existing |
| version-2.1.210-plan-approval ×2 | fail（~145s timeout） | fail（同） | pre-existing（live-model plan 流程在 gateway 下超时） |
| version-2.1.329-effort-cap ⑥ | fail（收到 `["claude-opus-4-7","opus"]`） | fail（同断言） | pre-existing |

  **结论：本轮零回归**；5 个 pre-existing 失败与本轮改动无关（逐一
  worktree A/B 验证），且全部位于 `skipIf(!!process.env.CI)` 门内 —
  GitHub CI 口径（`CI=true bash scripts/ci-test.sh`）不含这些 tmux/live 用例。
- 全量 CI 门：`CI=true bash scripts/ci-test.sh`（与 GitHub Actions 完全同参）
  → **656 文件 OK / 0 FAIL，exit 0** ✓（dist 以本轮最终源码重建后运行）。
- REPL tmux 实操（隔离 HOME=/tmp，项目 seeded `.claude/settings.json`）：
  1. mid-pattern `:*` startup warning 实时渲染，官方原文 + 相对路径 source
     label `Permission allow rule (.claude/settings.json): Bash(npm run test:* --watch) has a :* that is not at the end…` ✓（A 簇）
  2. telemetry-env startup notice 底部渲染 `This project's settings set telemetry environment variables. Run /status to see which ones Claude Code ignored…` ✓（C 簇 + PORT-C）
  3. `/status` System Diagnostics 输出 byte-exact 警告行（点名 `OTEL_EXPORTER_OTLP_ENDPOINT`，含 off-only 例外说明全文）✓
  4. live-model round-trip：`reply with exactly: PONG-282` → `● PONG-282` ✓
- 与官方 v2.1.282 二进制 A/B 对照：本轮全部落地字符串在官方 ELF 与
  `dist/cli.js` 双侧 `grep -cF` 命中一致；281 拒绝串
  `The :* pattern must be at the end` 官方 282 = 0×、281 = 2×、OCC dist = 0×
  （移除对齐 ✓；官方 282 残余 2 处 `must be at the end` 为路由参数无关串）。
  官方二进制全程未执行（occ136 §11.5 纪律），用后 `rm -rf`。

