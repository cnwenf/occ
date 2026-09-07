# OCC-118 — 官方 2.1.263 未动 → 严格自验收轮（REPL 实战 + A/B 对照，发现并修复 4 个交互不一致 gap，发版 2.1.324）

- 日期：2026-09-08
- 官方最新版本：`2.1.263`（npm dist-tags + GitHub releases 双重复核，与 OCC-117 轮相同，未前进 → 按 issue 规则转入**严格自验收轮**：像人类用户一样用 OCC REPL 干真实任务，优先验收近期新增功能，其次核心主干；最高标准 = 与官方 `uvx claude-code`（2.1.263 linux-x64 官方二进制）交互一致；**任何不一致记录为 gap 并按流程推进修复**）。
- 本轮性质：**有代码变更** → 走完整发版流程（v2.1.324）。
- A/B 环境：官方 2.1.263 linux-x64 ELF（`anthropic-ai-claude-code-linux-x64-2.1.263.tgz` 解包）vs OCC `dist/cli.js`（bun 运行，30,377,484 B）；tmux 200x50 detached，独立 HOME（`home-off` / `home-occ`），qwen3 代理（`ANTHROPIC_BASE_URL`=dashscope，`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY` 均在环境中）。全部屏幕证据存于 `occ118-ab/captures/`（off-* = 官方，occ-* = OCC）。

---

## §1 自验收发现并修复的 4 个 gap（全部达到与官方逐屏一致）

官方 2.1.263 二进制字节取证（`En` 确认框组件）：

```text
Trust:   e(En,{hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:"Yes, I trust this folder",cancelLabel:…"No, exit"})
Bypass:  e(En,{hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:"Yes, I accept",cancelLabel:"No, exit"})
ApiKey:  e(En,{hideIndexes:!0,focus:"cancel",…onConfirm:()=>"yes",onCancel:()=>"no"})
```

### Gap-118a — TrustDialog 未 cancel-first（安全正向修复）

- 现象：OCC 旧顺序 `[Yes, I trust this folder, No, exit]`，光标默认落在**接受信任**上——裸 Enter 即授予整个工作区读/写/执行信任。官方 2.1.263 是 `cancelFirst:!0, focus:"cancel"`：`No, exit` 为第一项且是默认焦点（安全默认）。
- 修复：`src/components/TrustDialog/TrustDialog.tsx` t20 选项数组反转为 `[No, exit / exit, Yes, I trust this folder / enable_all]`（值语义不变），并加 `hideIndexes={true}`（官方 `hideIndexes:!0`，无 "1./2." 数字槽）。
- 活体 A/B：官方与 OCC 均渲染 `❯ No, exit`（无序号）→ Down → `❯ Yes, I trust this folder` → Enter 接受并持久化 `hasTrustDialogAccepted: true`（逐项目）。captures: `off/occ-onb-s3*`。

### Gap-118b — BypassPermissionsModeDialog 缺 hideIndexes

- 现象：选项顺序已是 cancel-first（`No, exit` / `Yes, I accept`），但渲染带序号槽，官方 `hideIndexes:!0` 不带。
- 修复：`src/components/BypassPermissionsModeDialog.tsx` `<Select … hideIndexes={true}>`。
- 活体 A/B：`--dangerously-skip-permissions` 下两侧均为 `❯ No, exit` 无序号；裸 Enter 拒绝退出（exit 1，不落盘）；Down+Enter 接受 → `skipDangerousModePermissionPrompt: true` 持久化，二次启动直进 bypass REPL。captures: `off/occ-onb-s4*`、trust-gate 测试 4/5。

### Gap-118c — ApproveApiKey 默认焦点带 ✔ 选中勾

- 现象：OCC 用 `defaultValue="no"` → `No (recommended)` 行渲染出 ✔ 已选中勾。官方 `En` 只有 `focus:"cancel"`——光标停留但**无勾**。
- 修复：`src/components/ApproveApiKey.tsx` 改为 `defaultFocusValue="no"`（只移光标不置选中值）+ `hideIndexes={true}`。
- 活体 A/B：两侧一致渲染 `Yes / ❯ No (recommended)`、`Enter to confirm · Esc to cancel`，无勾无序号。拒绝路径行为一致：写入 `customApiKeyResponses.rejected`，同 HOME 二次启动不再弹。captures: `off/occ-onb-s2*`、本轮 probe（S1 屏）。

### Gap-118d — ThemePicker "New custom theme…" 入口未按官方 gating

- 现象：OCC 在**所有** ThemePicker 出现点（onboarding、Settings→Config→Theme、/theme）都渲染 "New custom theme…" 入口。官方 2.1.263 的入口以 `onCustomTheme` handler 存在为门——只有 `/theme` 传入；onboarding 与设置面板只显示 7 个预设。
- 修复：`src/components/ThemePicker.tsx` 新增 `allowCustomThemeCreation` prop（默认 false，门控 `NEW_CUSTOM_THEME_LABEL` 入口）；`src/commands/theme/theme.tsx` 的 /theme 面板传 `allowCustomThemeCreation={true}`。
- 活体 A/B：onboarding 主题页两侧均 7 预设无创建入口（captures: `off/occ-onb-s0/s1*`）；`/theme` 内 OCC 保留创建入口（与官方一致）。

### 回归测试

- 新增 `test/e2e/version-2.1.263-onboarding-dialog-parity.e2e.test.ts`（3 测试，源码级钉死：Trust cancel-first 顺序 + hideIndexes；Bypass hideIndexes + 顺序；ApiKey hideIndexes + `defaultFocusValue="no"` 且**不得**回退 `defaultValue=`）。3 pass / 9 expect。
- `test/e2e/version-2.1.149-ui.e2e.test.ts` 增补 theme gating 断言。

---

## §2 自验收中的行为发现 — 启动对话框次序（实证）

**trust → ApproveApiKey（当且仅当环境含 `ANTHROPIC_API_KEY`）→ bypass（当且仅当 `--dangerously-skip-permissions`）→ REPL**。

- API-key 拒绝持久化到 `~/.claude.json` `customApiKeyResponses.rejected` → 同 HOME 再启动跳过。
- trust 接受持久化为逐项目 `hasTrustDialogAccepted: true`。
- 官方与 OCC 次序一致（两侧 onb-s0..s5 逐屏对照）。
- tmux 环境注意：`tmux new-session` 继承 server 环境，`env VAR=…` 不加 `-i` 不清除 ambient 变量 → 本机 `ANTHROPIC_API_KEY` 常驻时该对话框不可避免，测试必须在流程内消化它（§3）。

---

## §3 trust-gate 全量门 +1 fail 取证与修复（测试侧，非回归）

本轮全量 `scripts/ci-test.sh`：**3527 pass / 16 fail / 12 skip，425 文件（10 failed files）**；OCC-117 基线：**3524 / 15 / 12，424 文件**。fail +1 全部来自 `trust-gate.e2e.test.ts`（基线 4 fail → 本轮全量时 5 fail）。三层取证：

1. **+1 的直接原因**：旧断言编码的是修复前的选项顺序（trust-first）。Gap-118a 落地后原 5 个测试按旧交互全部失败（全量跑时点），其中基线本就 pass 的第 3 个测试也转为 fail → 15→16。属"断言过时"瞬态，非行为回归。
2. **基线 4 fail 的环境根因（本轮确证）**：ambient `ANTHROPIC_API_KEY` → trust 接受后弹出 ApproveApiKey 对话框，挡住 ready 等待。基线里第 3 个测试 pass 是因为 Down→No-exit→exit 路径根本走不到 API-key 对话框。
3. **修复（test-only）**：
   - 新增 `dismissApiKeyDialogIfPresent()` helper（等 "use this api key" ≤4s，出现则 300ms 后裸 Enter 拒绝——默认焦点即 No，拒绝持久化后二次启动不再弹；干净环境为 no-op）。
   - ready 标记从过时的 `"for shortcuts"` 改为实测渲染的 `"shift+tab"`（OCC 手动模式页脚 `⏸ manual mode on (shift+tab to cycle)`；官方同屏渲染 `· ? for shortcuts · ← for agents` —— 属 §4 页脚构成差异，与 trust-gate 无关）。probe 实证：非 bypass 流程 trust→api-key 拒绝后 REPL 就绪屏不含 "for shortcuts"。
   - 结果：**5 pass / 0 fail / 24 expect（19.09s）**。dist 无需重建（`dist/cli.js` mtime 晚于全部 src 修改，且本修复纯测试侧）。

**修复后全量等价重算**：3527+5 = **3532 pass / 11 fail / 12 skip**（trust-gate 隔离重跑为证据；变更 test-only、可证隔离）。剩余 11 fail = 基线环境依赖集（OCC-117 §5.3 的 15）减去 trust-gate ×4：goal-gate ×2、plan-approval ×2、commands-behavior `/feedback` ×1、feedback-ai ×1、goal-panel ×1、repl-interactive auto-mode ×1、resume-command-name ×1、screen-reader ×1、workflow-save-dialog ×1。**优于基线**。

---

## §4 观察到的其余不一致 — 记录、本轮不移植（附理由）

1. **手动模式页脚构成**：官方 `⏸ manual mode on · ? for shortcuts · ← for agents`；OCC `⏸ manual mode on (shift+tab to cycle)`（`off/occ-t3-stab2.txt` 同屏对照；右侧 `Ctrl+Y to paste deleted text` 两侧一致）。二进制侧页脚由段过滤器 + `.join(" · ")` + 条件段（`<ycn?IXt:"? for shortcuts"`、`← for agents` 门控）拼装，状态机需逐点反编译才可信；按 `aligning-with-official-binary` 纪律（模糊即 STOP、绝不发明）不在本轮猜测移植。两串在双方二进制中都存在（官方 8 处 / OCC 2 处 "for shortcuts"），是**组装条件**差异而非缺字符串。
2. **effort 指示器位置**：官方 `● high · /effort` 挂在输入框上方分隔行右端；OCC 同串但分隔行布局略异（t3 captures）。纯外观，同上理由缓移。

以上两条与既有 CLAUDE.md 记录的设计性分歧（`--help` 顶层换行、`-p` 工具集、`--safe-mode` 范围等）一并留档，不构成用户可用性问题。

---

## §5 REPL 实战 A/B 结果（T1–T5 + onboarding + 截断路径）

| 项 | 内容 | 结果 |
|---|---|---|
| onb-s0..s5 | 首启 onboarding 全程逐屏（主题页→安全说明→trust→api-key→bypass→REPL） | 修复后**逐屏一致**（修复前 s1/s2/s3/s4 各有 §1 所述差异） |
| T1 | 输入框 Ctrl+W 词删除（`hello world`，两次 cw；OCC-116 Gap-116a keybindingFlavor 废弃后的 Bash 词单元行为） | 一致（`off/occ-t1-after-cw1/cw2`） |
| T2 | 连字符词组删除（`one-three four`，词单元边界） | 一致（`off/occ-t2-mf-md`） |
| T3 | Shift+Tab 模式循环 ×6（stab1..6，bypass↔manual 全环） | 模式序列一致；页脚文案差异见 §4（`off/occ-t3-stab1..6`） |
| T4 | `/status` 面板 | 结构一致（版本/模型/项目行；OCC 头 `OCC v2.1.323 · Open C Code` 为既有品牌化差异） |
| T5 | 主干真实任务：`/status` 关闭 + `Run this exact bash command…: echo occ118-trunk-ok`（模型往返 + Bash 工具执行） | 两侧均完成任务往返（`off/occ-t5-trunk`） |
| trunc | bashOutputMaxChars 实战 A/B（`-p` stream-json，13.6KB 超限输出） | **一致**：两侧同渲染 `<persisted-output>` + `Output too large (13.6KB). Full output saved to: …`，正文同截于 `527` 行 + `...` 尾；tool_result 长度 off=2383B vs occ=2379B（4B 差 = 持久化文件路径长度，非内容差异）。OCC-116 Gap-116b 落地质量复核通过 |

## §6 全量门对照汇总

| 轮次 | pass | fail | skip | 文件 |
|---|---|---|---|---|
| OCC-117 基线 | 3524 | 15 | 12 | 424 |
| OCC-118 全量（修复断言前时点） | 3527 | 16 | 12 | 425 |
| OCC-118 修复后等价重算 | **3532** | **11** | 12 | 425 |

+1 fail 定性：过时断言 × 新（官方一致）交互的瞬态 + 环境 `ANTHROPIC_API_KEY` 根因确证，见 §3；已修复并 5/5 绿。新增 1 文件 = 新 parity 套件。

## §7 发版定性

有代码变更（4 个 gap 修复 + 测试）→ **发版 v2.1.324**（package.json 2.1.323 → 2.1.324；CHANGELOG `## 2.1.324 - 2026-09-08`；tag push → `.github/workflows/publish.yml` npm publish + `gh release create`）。

## §8 安全审查记录（全 diff）

本轮全部 src 变更 = 三个确认对话框的选项顺序/渲染 prop（`hideIndexes`、`defaultFocusValue`）+ ThemePicker 入口 gating prop + /theme 传参；其余为测试文件。无新依赖、无网络面、无输入处理/凭据路径变更、无 hardcoded secret。Gap-118a 为**安全正向**：裸 Enter 从"授予工作区信任"变为"退出"（与官方安全默认一致）；ApproveApiKey 默认焦点保持 `No (recommended)` 且拒绝落盘。结论：无后门、无泄密面。

## §9 资源清理

- `occ118-ab/` 内官方 tgz ×2 与解包 `package/`、`official263/` 二进制：删除（遵循 OCC-117 §8 "不在盘上留下载二进制"纪律）。
- A/B HOME（`home-occ`、`home-off`）、probe 临时目录（`/tmp/occ-trust-probe*`）：删除。
- tmux：全部测试/probe 会话 kill，tmux server 关闭。
- captures 与 ci-test 日志：证据留存于本轮工作目录（不入库）。
