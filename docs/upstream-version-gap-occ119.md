# OCC-119 — 官方 2.1.263 连续第三轮未动 → 严格自验收轮（修复 onboarding 安全说明陈旧文案 Gap-119a，发版 2.1.325）

- 日期：2026-09-09
- 官方最新版本：`2.1.263`（npm dist-tags 复核，与 OCC-117 / OCC-118 轮相同，连续第三轮未前进 → 按 issue 规则继续**严格自验收轮**：像人类用户一样用 OCC REPL 干真实任务，最高标准 = 与官方 2.1.263 linux-x64 官方二进制交互一致；任何不一致记录为 gap 并按流程推进）。
- 官方 `next`：`2.1.265`（预发布通道，本轮**不对齐**，仅做预 triage 供下轮台账，见 §4）。
- 本轮性质：**有代码变更**（Gap-119a 修复）→ 走完整发版流程（v2.1.325）。
- A/B 环境：官方 2.1.263 linux-x64 ELF（tgz 解包）vs OCC `dist/cli.js`（修复后重建，28.97 MB，`OCC 2.1.324`）；tmux 200x50 detached，独立 HOME（`home-off` / `home-occ` / `home-occ2`），共享 `proj/`，qwen3 代理（dashscope）。屏幕证据存于本轮工作目录 `occ119-ab/captures/`（off-* = 官方，occ-* = OCC）。

---

## §1 Gap-119a — onboarding 安全说明文案陈旧（已修复，逐字节一致）

官方 2.1.263 二进制字节取证（security step 完整 JSX，ELF strings + 上下文还原）：

```text
e(t,{bold:!0,children:"Security notes:"}),
e(o,{flexDirection:"column",width:70,children:r(W,{children:[
  r(W.Item,{children:[
    e(t,{children:"Claude can make mistakes."}),
    r(t,{dimColor:!0,wrap:"wrap",children:[
      "You're responsible for Claude's actions and should always",
      e(WS,{}),
      "review them, especially when running code.",
      e(WS,{})]})]}),
  r(W.Item,{children:[
    e(t,{children:"Due to prompt injection risks, only use it with code you trust"}),
    e(Wf,{url:"https://code.claude.com/docs/en/security"})]})]})}),
```

其中 `Wf`（LearnMore）渲染单行 dimColor `Learn more: <Link>`。

- **现象**：OCC 携带的是 pre-2.1.263 陈旧文案——条目 1 无句号（`Claude can make mistakes`）且第二句为 `You should always review Claude's responses, especially when…running code.`；条目 2 为 `For more details see:` + 换行 + Link 的旧版式。官方 2.1.263 已改为责任声明句式（`You're responsible for Claude's actions and should always review them…`）+ 单行 `Learn more:` 版式。
- **修复**：`src/components/Onboarding.tsx` securityStep 两条 OrderedList.Item 按上述取证逐字节替换（官方 JSX 结构与 OCC 现状同构，仅文案节点差异；`wrap="wrap"` / dimColor / Newline 位置均照抄二进制证据）。
- **回归测试（TDD）**：新增 `test/e2e/version-2.1.263-security-notes-parity.e2e.test.ts`（3 测试：官方文案钉死 ×2 + 陈旧文案禁回退 ×1；docstring 内嵌完整官方 JSX 取证）。RED（3 fail）→ 修复 → GREEN（与 dialog-parity 文件合计 6 pass / 18 expect）。lint clean；`dist/cli.js` 重建。
- **活体验证**：全新 HOME（`home-occ2`）首启走 onboarding，安全说明屏与官方同屏 diff → **逐字节一致**（captures: `off-s2` vs `occ-s2-fixed`，diff 结论 SECURITY-NOTES-IDENTICAL）。

## §2 Gap-119b — 启动欢迎框/更新通知子系统已被官方 2.1.263 重做（STAGED，附字节证据）

自验收中最大的一处渲染分歧：官方 2.1.263 二次启动为 **condensed banner**（无欢迎框），OCC 渲染完整欢迎框（Tips for getting started / Recent activity 等）。取证结论：

1. **官方欢迎框字符串已全部消失**：`Tips for getting started`、`Recent activity`、`Welcome back`、`Run /init to create`、`Opus now defaults`、`CLAUDE_CODE_FORCE_FULL_LOGO` 在官方 2.1.263 与 2.1.265 两份 strings dump（`s263.txt` / `s265.txt`）中均 **0 命中**。
2. **官方重做了启动通知机制**：二进制中提取到 `computeUpdateSummary` / `startupUpdateSummary` / `pretendLastSeen` / `countedNoticeImpressions` / `"Updated to latest."` 一套新机器；condensed 门控为 `pGt=()=>!O6e||Fae(N6e)||yt()||i6()!==void 0`（对应 OCC `LogoV2` 的 `isCondensedMode = !hasReleaseNotes && !showOnboarding && !isEnvTruthy(CLAUDE_CODE_FORCE_FULL_LOGO)`——OCC 门控所依赖的 env 变量官方已不存在）。
3. **OCC 侧 `Opus1mMergeNotice`**（`↑ Opus now defaults to 1M context · 5x more room, same pricing`，MAX_SHOW_COUNT=6）：该字符串在官方两份二进制中均不存在——属 OCC 从更早版本携带的残留通知。
4. **该区域是 OCC 有意重设计过的品牌面**（OCC-45，commits `0c6b95c` / `553bf88`：doge logo、"Welcome to OCC"、ellipsis 布局）。

**判定**：把启动通知子系统对齐到官方 2.1.263 形态是一个跨组件的大移植（通知计数持久化、release-notes 门控、condensed 判定链全部重构），且与 OCC 既有品牌化设计正面冲突；按 `aligning-with-official-binary` 纪律（模糊/大范围即 STOP、绝不发明）**本轮不移植**，证据留档，待后续轮次专项决策（对齐 vs 维持品牌化分歧并文档化）。

## §3 Gap-119c — /status 面板构成 + theme 持久化位置分歧（STAGED，附证据）

T4 `/status` A/B（captures: `off-t4` / `occ-t4`）：

- **构成差异**：官方 5 个 tab，OCC 3 个；OCC 缺行：`Session kind`（OCC-44 已 staged，待 attacher-state 解析）、`Peer address`（uds:）、`Managed settings (remote)`、`Organization policy`、`System diagnostics` ⚠ 块；value 列对齐方式略异。头部品牌差异（`OCC v2.1.324 · Open C Code`）为既有设计性分歧。
- **根因发现——theme 持久化位置**：官方 2.1.263 把 theme 写入 `~/.claude/settings.json`（settings schema 含 `theme: …describe("Color theme for the UI")`）；OCC `ThemeProvider.defaultSaveTheme` → `saveGlobalConfig` 写入 `~/.claude.json` 的 `theme` 键。下游效应：官方 HOME 因存在 settings.json，`/status` 的 `Setting sources:` 行显示 `User settings`；OCC HOME 无 settings.json → 该行为空（`src/utils/status.tsx` 按现有 settings 来源拼装，行为本身正确）。
- **功能本身正常**：onboarding 主题选择持久化可用（`home-occ2` 实证 `dark-daltonized` 落盘并在二次启动生效）。
- **判定**：迁移持久化位置是 settings 面的横切变更（读写兼容、迁移旧值、`Setting sources` 联动），本轮 STOP 留档；`/status` 缺行各自需要对应子系统（uds peer、managed settings、org policy、diagnostics）先行，不做表面拼接。

## §4 官方 2.1.265（next 通道）预 triage — 供下轮台账，本轮不对齐

- `/design` 命令被移除 —— OCC 从未 ship `/design` → **no-op**。
- 新 env 变量：`CLAUDE_CODE_ARTIFACT_DB_STR_REPLACE`、`CLAUDE_CODE_ARTIFACT_FIVE_CLASS_ASKS`、`CLAUDE_CODE_DISABLE_AWAITING_USER_IDLE`、`CLAUDE_CODE_TETHER_LIVE`（tether 遥测相关字符串为新增面）。
- settings schema `.describe()` 计数 89 = 89（与 2.1.263 持平，schema 面稳定）；hook 名称集合与 2.1.263 相同。
- §2 的欢迎框字符串在 2.1.265 中同样 0 命中（重做为持续状态，非 263 单点）。

## §5 REPL 实战 A/B 结果（本轮自验收场景）

| 项 | 内容 | 结果 |
|---|---|---|
| onb | 全新 HOME onboarding 全程逐屏（主题页→安全说明→trust→api-key→REPL） | 修复后安全说明屏**逐字节一致**（§1）；trust cancel-first/无序号、api-key `❯ No (recommended)` 无勾、主题页 7 预设 vs `/theme` 8 项（含 New custom theme…）——OCC-118 四修复**活体复验通过** |
| banner | 二次启动 banner | 官方 condensed vs OCC 完整欢迎框 → Gap-119b staged（§2） |
| T1 | 输入框 Ctrl+W 词删除（`hello world`，两次 cw） | **一致**：cw1 后两侧均 `❯ hello`（逐字节），cw2 后均空（`off/occ119-t1-cw1/cw2`） |
| T3 | Shift+Tab 模式循环 ×6 | **模式序列一致**：manual→accept edits→plan→auto→manual→accept edits→plan；Auto mode 说明横幅逐字节一致；页脚差异仅既有 §4(OCC-118) 文案构成（官方尾部 `· ← for agents` 等），不重开（`off/occ119-t3-stab1..6`） |
| T4 | `/status` 面板 | 结构差异 → Gap-119c staged（§3） |
| T5 | 主干真实任务：`Run this exact bash command and show me the output: echo occ119-trunk-ok` | **两侧均完成往返**：`● Bash(echo occ119-trunk-ok)` → `⎿ occ119-trunk-ok`。OCC 侧额外实证：代理模型产生幻觉 Write（CLAUDE.md 父目录爬升发现了 Multica workdir 的指令文件——发现行为正确），manual-mode 权限门正确拦截（"User rejected write"），拒绝后模型正常收尾（`off263/occ119-t5-trunk-*`） |
| obs | occ-s5 花屏 | 复现根因 = 旧帧未清屏即重启的一次性 stale-screen 伪影；clean 重启（occ-s6）渲染完美 → 非可复现 Ink bug，仅记录 |

**代理退化备注**：本轮 `-p` 往返实测出现前缀行 `[claude-code:unrecognized_model] {"model":"glm-5.2","query_source":"sdk"}` + ~9s 延迟（上轮为快速干净往返）——代理侧退化，两侧同等受影响，非 OCC 代码问题。

## §6 全量 ci-test 门对照基线

| 轮次 | pass | fail | skip | 文件 |
|---|---|---|---|---|
| OCC-118 修复后基线 | 3532 | 11 | 12 | 425 |
| OCC-119 全量（本轮实测） | 3531 | 12 | 12 | 425 |
| OCC-119 等价重算（含新 parity 文件 +3） | **3534** | **12** | 12 | 426 |

- 总用例数持平（3543）；唯一翻红 = `autocompact` e2e（基线 pass → 本轮 fail）。**根因取证**：隔离重跑 3 fail + 2 error 全部为 5s/10s 超时；`echo "say PONG" | ./dist/cli.js -p` 探针实证代理注入 `[claude-code:unrecognized_model]` 前缀 + ~8.9s 延迟 → **环境性**（代理退化），与本轮 copy-only 变更无关（同文件其余 8 测试在同一树状态下全量跑时通过；变更仅为 JSX 文案）。
- 12 fail = 已知 11 个环境依赖集（goal-gate ×2、plan-approval ×2、commands-behavior `/feedback`、feedback-ai、goal-panel、repl-interactive auto-mode、resume-command-name、screen-reader、workflow-save-dialog）+ autocompact ×1（代理环境）。
- 新文件快照语义：`ci-test.sh` 启动时 `mapfile` 快照文件列表，本轮中途新增的 parity 文件不计入实测 425，故等价重算 426。

## §7 发版定性

有代码变更（Gap-119a 修复 + parity 测试 + 本台账）→ **发版 v2.1.325**（package.json 2.1.324 → 2.1.325；CHANGELOG `## 2.1.325 - 2026-09-09`；tag push → `.github/workflows/publish.yml` npm publish + `gh release create`）。

## §8 安全审查记录（全 diff）

本轮全部 src 变更 = `Onboarding.tsx` 安全说明文案节点替换（纯 JSX 文本，无逻辑/props/状态变更）；其余为新增测试文件（source-level 断言）与文档。无新依赖、无网络面、无输入处理/凭据路径变更、无 hardcoded secret。文案内容本身为安全提示强化（责任声明 + prompt injection 警示 + 官方安全文档链接）。结论：**无后门、无泄密面，APPROVE**。

## §9 资源清理

- `occ119-ab/` 内官方 263/265 tgz ×2 与解包二进制目录（`off263/`、`off265/`）：删除（沿用 OCC-117 §8 "不在盘上留下载二进制"纪律）。
- A/B HOME（`home-off`、`home-occ`、`home-occ2`）：删除。
- tmux：全部会话 kill，tmux server 关闭。
- captures 与 ci-test 日志：证据留存于本轮工作目录（不入库）。
