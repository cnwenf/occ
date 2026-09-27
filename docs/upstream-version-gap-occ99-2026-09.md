# OCC-99 严格自验收轮 — 官方 Claude Code 2.1.283 gap 调研与修复记录（2026-09）

> **轮次性质**：本轮开始时 OCC（v2.1.356 @ a96f75b）与官方追踪版本 **2.1.283** 之间版本 gap 为**零**，
> 因此本轮为**严格自验收**（strict self-acceptance）：像人类用户一样在真实任务上运行 OCC REPL
> （`repl-tmux-e2e-testing` skill），并对官方 2.1.283 npm 包做 A/B 取证，重新审计已落地的
> 2.1.283 轮特性 + 核心主干。
>
> 轮中 origin/main 前进到 **v2.1.357**（OCC-139 轮 `--effort` parity + `--bare` help），本分支已
> rebase（无冲突），本轮发布版本 = **2.1.358**。
>
> 官方取证二进制：`@anthropic-ai/claude-code@2.1.283` linux-x64 ELF（`claude.exe`，
> md5 `b5afa8208e39db13e13e89449b1825f2`）。仅用于字节级取证（grep -aboF / dd 提取）与
> A/B 对照运行（kickoff 明确许可官方 npm 包 A/B；仓库外来路不明的文件一律不执行）。

---

## 1. 已落地 2.1.283 轮特性复验（全部 PASS）

| 特性 | 验证方式 | 结果 |
|---|---|---|
| Managed model governance startup gate | e2e（mock endpoint）+ 官方 ELF A/B 字节对照 | PASS，门控文案逐字节一致 |
| `claude-ai` reserved-namespace revert | 65 个 revert 单测 | PASS |
| `x-claude-code-prompt-id` 请求头 | wire-level mock 捕获，对照官方 | PASS |
| OTEL `tool.output` span events | 单测 + 事件结构对照 | PASS |
| `--system-prompt` / `--append-system-prompt` 双形态合并 | e2e，合并结果与官方字节一致 | PASS |
| Keybinding 拼错修饰键校验 | 单测（validator 行为对照官方） | PASS |
| Async startup gate | 单测 + e2e | PASS |
| 2.1.283 轮合计回归 | 220 单测 + 6 e2e 全绿 | PASS |

核心主干（REPL 启动、print 模式、模型注册、query loop、stream parser）经 REPL tmux 真实任务
+ 官方 A/B 复验，未发现回归。

## 2. 本轮新发现并已修复的 gap（3 项）

### FIX-99a — 模型 max-tokens 注册表缺 opus-5-5 / mythos-5 系

- **现象（A/B 实测 + ELF 取证）**：官方 2.1.283 模型注册表（ELF @197060200 字节提取）中
  `claude-opus-5-5` 为 **default=128000 / upper=128000**（全表唯一 default==upper 的模型，
  即官方默认模型），`claude-mythos-5` / `claude-mythos-5-1` 为 64000/128000。
  OCC `getModelMaxOutputTokens` 没有这两个分支 → 官方默认模型在 OCC 落入通用 opus-5
  分支拿到 64000 上限（wire 层 `max_tokens` 直接减半）。
- **修复**：`src/utils/context.ts` 在通用 opus-5 分支前插入 `opus-5-5`（128000/128000）与
  `mythos-5`（64000/128000）分支，附 ELF 取证偏移注释。
- **测试**：`src/utils/__tests__/maxTokensRegistry283.test.ts` — **14/14 pass**，含全注册表
  parity（逐模型对照字节提取表）、`claude-opus-5-5[1m]` ANSI 变体、wire 路径
  `getMaxOutputTokensForModel`→128000、env override。

### FIX-99b — thinking-only 回合静默完成（官方 2.1.183 起修复，OCC 缺失）

- **现象（A/B 实测）**：模型返回只含 thinking 块、以 `end_turn`/`stop_sequence` 结束、
  无可见文本时，官方注入一次性 meta nudge（官方常量 `I$t`，ELF @197449268 字节提取，
  文本 `[Your previous response had no visible output. Please continue and produce a user-visible response.]`），
  丢弃 thinking-only assistant 消息后重查；OCC 直接静默 `completed`——用户看到空回合。
- **修复**（忠实移植，ELF @211166255-211166700 逐条件对照）：
  - 新建 `src/query/thinkingOnlyNudge.ts`：`THINKING_ONLY_NUDGE_TEXT`（字节精确）、
    `isTextlessQuerySource`（官方 `nVe`/`MFn` @204278422：prompt_suggestion/away_summary/
    agent_summary/narration 四源豁免）、`isTerminalMcpToolTurn`（官方 `r$e`/`Ggo`
    @206152475：CLAUDE_CODE_TERMINAL_MCP_TOOLS 环境解析 + 回走成功 tool_result + isMeta 跳过）、
    `isStructuredOutputTurn`（官方 `ie` @211160472：回走 StructuredOutput tool_use）、
    `hasVisibleText`（trim 非空 text 块）。
  - `src/query.ts` 接线：State 增 `thinkingOnlyNudged` guard；nudge 块位于 terminal 分支内
    max-output-token recovery 之后、isApiErrorMessage 检查之前（与官方位置一致）；
    一次性 guard 仅 next_turn 重置（官方 `Kr` 语义）；六个 transition（collapse_drain_retry /
    reactive_compact_retry / max_output_tokens_escalate / max_output_tokens_recovery /
    stop_hook_blocking / token_budget_continuation）carry-over；transition reason
    `thinking_only_retry`；日志 `query_thinking_only_response: nudged/nudge_exhausted`。
- **测试**：
  - 单测 `src/query/__tests__/thinkingOnlyNudge.test.ts` — **17 pass / 23 expect**。
  - wire e2e `test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts` — **2 pass / 9 expect**：
    print 模式 mock endpoint，断言恰好 2 次 /v1/messages、重试请求末尾为字节精确 nudge 文本、
    thinking-only 回合被丢弃（重试体不含 thinking marker）、原 prompt 保留、
    二次 thinking-only 不触发第三次请求（one-shot guard）。
  - **REPL tmux 真实验证**：mock SSE 服务器（haiku 侧调用与主模型分流），OCC REPL 内 3 次调用
    （haiku 侧、主 thinking-only、nudge 重试 hasNudge:true / hasThinkingMarker:false），
    屏幕渲染出恢复后的答案 `OCC99_NUDGE_RECOVERY_ANSWER`。
  - **官方二进制 A/B**：官方 print 模式同场景 2 次调用，语义完全一致，nudge 文本字节相同，
    thinking 同样被丢弃。唯一差异：官方重试请求 messages 角色序列为 `user,system`
    （mid-conversation system 消息架构），OCC 为合并后的 `user`（isMeta user message）——
    属已知 STAGED 架构 gap（§4），非本 fix 引入。

### FIX-99c — 未知模型误报：默认模型自身触发 unrecognized_model

- **现象（A/B 实测）**：官方 2.1.283 `oA` 目录注册了 `claude-opus-5-5`（ELF 43 处字符串命中，
  官方默认模型）与 `claude-fable-5-1`（24 处命中；`claude-mythos-5-1` canonicalize 到它）。
  OCC 的 `KNOWN_CANONICAL_MODELS` 缺这两项 → OCC 对**自己的默认模型**发
  `[claude-code:unrecognized_model]` stderr 警告 + `tengu_api_unrecognized_model` 遥测，
  官方对同模型静默。
- **修复**：`src/utils/model/unrecognizedModelSignal.ts` 目录集合加入 `claude-opus-5-5`、
  `claude-fable-5-1`（附取证注释）。
- **测试**：`unrecognizedModelSignal233.test.ts` 增补 4 个新模型形态
  （opus-5-5 / opus-5-5[1m] / fable-5-1 / mythos-5-1）— **11/11 pass**；`my-custom-model`
  仍正确触发警告（无误放行）。

## 3. 本轮验证证据汇总

- 新增测试：14（registry）+ 17（nudge 单测）+ 2（nudge wire e2e）= **33 新 pass**；
  连同既有 2.1.283 集群共 **39 pass / 0 fail / 73 expect**。
- 2.1.283 轮既有特性复验：220 单测 + 65 revert 单测 + 6 e2e 全绿。
- REPL tmux：nudge 真实场景 + 常规 REPL 任务；`repl-interactive` 套件 2/1
  （auto-mode opt-in dialog 用例失败为 **pre-existing**，git-stash A/B 证实 pristine main
  同样失败，与 OCC-44 ledger 记录一致，非本轮引入）。
- 全量套件：69 个失败在 pristine main 上**完全同集合复现**（stash A/B，diff 仅计时数字），
  各失败套件单独运行全 pass → 属并行全量运行的既有污染 flake，本轮改动零回归。
- 官方 A/B：governance gate 门控字节一致；system-prompt 合并字节一致；prompt-id 头一致；
  nudge 语义一致（角色序列差异见 FIX-99b）。

## 4. STAGED（取证不完整 / 架构级，本轮不移植，逐项理由）

| 项 | 理由 |
|---|---|
| Malformed tool_use retry（官方 `x$t` 路径） | 官方代码 @211164800 区域已提取（stop_reason==="tool_use" && 无 tool_use 块 → tombstone + `x$t` meta + `malformedToolUseRetried` guard + `tengu_malformed_tool_use_response` 遥测），但 `Bs`（text_has_leaked_invoke 判定体）与各 transition guards 展开未提取——按 "Never invent" 纪律不猜写 |
| Truncated-response recovery（`H$t`/`M$t`，`zn`=3，`An` 追踪） | 恢复文案与计数常量已取证，`An`（上一回合截断标记）赋值点未提取 |
| Mid-conversation system 消息架构 | 官方在重试请求中使用 role=system 消息；OCC 消息管线无该形态（isMeta user 合并）。架构级改造，nudge A/B 已证实行为等价 |
| resumeIncompleteThinking | 需专用逐点反编译 |
| thinking display:"omitted"（`PHo`） | UI 层行为，需逐点取证 |
| 4 个 anthropic-beta flags 差异 | 需逐 flag 服务端行为验证 |
| print 模式 interactive-tool 过滤（P3） | 既有 documented divergence（CLAUDE.md OCC-24） |
| Glob/Grep tool_use emission build-form fallback | 低优先级 |
| KAIROS 官方默认开 / OCC 关 | featureFlags 安全纪律（KAIROS 挂起风险，见 featureFlags.ts 头注） |
| browser tools OCC 常开 | OCC 特有 WebBrowser（documented divergence） |
| HEAD /api/hello probe、first-turn reminder delta、官方 onboarding tips | 低影响，逐项需独立取证 |

## 5. 发布

- 版本：**2.1.358**（rebase 到 origin/main v2.1.357 之上）
- 提交：`fac0bba` fix（三修复 + 测试）→ 本文档 + `chore(release): 2.1.358`
- 发布链路：merge main → tag `v2.1.358` → CI（publish.yml）npm publish + GitHub Release
  （/releases ≡ /tags 校验）
