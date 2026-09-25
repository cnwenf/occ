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
