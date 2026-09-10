# OCC-82 版本差距台账（官方 2.1.266 → 2.1.267）

日期：2026-09-11（Asia/Shanghai）。上一轮：OCC 已追齐官方 **2.1.266**（OCC release `2.1.327`）。本轮 gap = **2.1.267 settings 侧 effort cap**，OCC release **2.1.329**（注：实现期间并行的 OCC-121 轮次以 `2.1.328` 发布了 2.1.267 可移植子集并把本项 staged，故本轮落地版本号顺延为 2.1.329）。

取证源：官方 2.1.267 linux-x64 npm 包 ELF strings dump（`/tmp/cc267/s267.txt`，对照 `s266.txt` / `added.txt`）。二进制内嵌版本信息（verbatim）：

```
VERSION:"2.1.267", BUILD_TIME:"2026-09-09T17:26:03Z", GIT_SHA:"a9e1808c8204fef901336d54bac7d4ab442955cb"
```

对齐基线 spec：issue OCC-82 内 Gap 调研评论（thread `9635bc05`，含全部 verbatim 窗口与 `@偏移`）。所有落地字符串/常量均自 s267.txt 逐字节核验，未发明任何文案。

## 1. 本轮 delta 概述

2.1.266 已有完整 effort cap 机制（clamp、capLevels 过滤、启动警告、picker 截断），但 cap **只来自组织注册表**（bootstrap API 下发 `model_access[].max_effort_level`）。2.1.267 新增 **settings 侧 cap**：

- schema 键：顶层 `maxEffortLevel` + `modelSettings.<model>.maxEffortLevel`（枚举含 `"max"`＝豁免；`effortLevel` 枚举不含 max，不变）；
- 解析器 `N(e)`（跨 settings 文件取最低；单文件内 per-model 命中替换顶层）；
- 合并解析器 `Stt(e) = min(settings cap, org cap)`；
- 全部用户可见文案从 "exceeds your organization's limit" 改写为 "exceeds the cap … set by your settings or organization"。

其余 267 changelog 条目多为 VSCode/web/Claude Tag/gateway/移动端等 OCC 无对应 surface 项（spec 已逐条给 verbatim 证据），本轮无其他落地项。

## 2. 落地内容（符号对照 + 文件）

### 2.1 符号映射（官方 → OCC）

| 官方 267 | OCC | 位置 |
|---|---|---|
| `Mu` = `["low","medium","high","xhigh","max"]` | `EFFORT_LEVELS` | `src/utils/effort.ts` |
| `E(e)` = `Mu.indexOf(e)` | `effortLevelIndex` | `src/utils/effort/cap.ts` |
| `N(e)` settings cap 解析器 | `getSettingsEffortCap` | `cap.ts` |
| `Stt(e)` = min(settings, org) | `getEffectiveEffortCap`（OCC 无 org 注册表 → ≡ N，`"max"`→null） | `cap.ts` |
| `Uhe` | `isEffortLevelAllowed` | `cap.ts` |
| `S9` | `getAllowedEffortLevels` | `cap.ts` |
| `lF` | `clampEffortToCap` | `cap.ts` |
| `K` | `modelSupportsEffortLevel` | `cap.ts` |
| `vur` | `hasEffortLevelsAboveCap` | `cap.ts` |
| `Eur` 启动/内联警告 | `getEffortCapWarning` | `cap.ts` |
| `Zf(…,{key:"model-effort-cap"})` | `emitStartupEffortCapWarning` | `cap.ts` + `src/main.tsx` 挂接 |
| `zS`（ultracode 可用，缩减） | `isUltracodeAvailableForModel` | `cap.ts` |
| `kE` 有效档位管线（267 三处变更） | `resolveAppliedEffort` | `src/utils/effort.ts` |
| `P` cap-clamp→能力降级 | `clampEffortValue` | `cap.ts` |
| `dF` 数字档位→'high' 归一 | `resolveAppliedEffort` 内联 | `effort.ts` |
| `DP` env override | `getEffortEnvOverride` | `effort.ts` |
| `Bhe` 规范名 | `getCanonicalName` | `src/utils/model/model.ts` |
| `JCs` 请求 effort 参数 | `configureEffortParams`（本轮导出） | `src/services/api/claude.ts` |
| `oRt` settings 热同步 clamp | `applySettingsChange` effort 同步 | `src/utils/settings/applySettingsChange.ts` |
| `txr` argumentHint builder | `buildEffortArgumentHint` | `cap.ts` + `src/commands/effort/index.ts` getter |
| `U` 设档 clamp 分支 | `setEffortValue` clamp-first | `src/commands/effort/effort.tsx` |
| `Jdt` 动态帮助 | effort help 分支（`help|-h|--help`） | `effort.tsx` |
| `dt(t)`/`Sr(t)`/`wr` picker | ladder 截断/显示 clamp/持久 clamp/cap 注释 | `src/components/ModelPicker.tsx` |

### 2.2 schema（`src/utils/settings/types.ts`）

`maxEffortLevel`（顶层）与 `modelSettings.<model>.maxEffortLevel` 两键，`.optional().catch(undefined)`（非法值静默丢弃），**`.describe()` 原文照抄官方**（顶层 describe 含 "Enforced client-side: an effort supplied through CLAUDE_CODE_EXTRA_BODY is not clamped."）。`modelSettings` 外层 preprocess 保留原型键防污染守卫（`Object.hasOwn(Object.prototype, key)` 命中即安全化）；per-model 条目 passthrough。

### 2.3 解析器语义（`getSettingsEffortCap`，逐字对齐 `N(e)` @20350600）

1. 性能短路：仅当**任一**启用来源的 modelSettings 出现 `maxEffortLevel` 时才对模型名做 `Bhe` 规范化匹配；
2. 单文件内：per-model 命中替换顶层（`perFile ??= settings.maxEffortLevel`）；同文件多键规范化撞同一模型取最低；
3. 跨文件：取最低（`effortLevelIndex` 比较）；
4. `"max"` 不产生 cap（含 per-model `"max"` 覆盖本文件顶层 cap 的豁免情形）；
5. 无 cap 返回 `null`。

来源序：`getEnabledSettingSources()`（OCC 与官方 `Wo()` 一致：flagSettings/policySettings 永远参与）。官方 `N(e)` 额外前置 `Tc()`（MDM 多 tier policy）——OCC 无 MDM 多 tier 注册表，policySettings 即其对应物（缩减，见 §5）。

### 2.4 kE 三处 267 变更（`resolveAppliedEffort`）

- 新增 `turnEffort` 语义位（OCC 调用点对齐）；
- `l = N(e) !== null` 时：env-unset 也**物化显式默认档位**（不再放行到服务端默认）、数字档位经 `dF` 转字符串——cap 下 API 必发显式 clamped effort；
- env=null（`auto`/`unset`）分支直接压过 turnEffort/session。
- 统一 `P()`：先 `lF` cap clamp，再模型能力降级（max→high、xhigh→high）。

### 2.5 Enforcement 点全表

| # | 入口 | 落点 | 状态 |
|---|---|---|---|
| 1 | `/effort <level>` | `setEffortValue` clamp-first + `U` 文案；**被 clamp 的选择不持久化**（session-only） | ✅ |
| 2 | `/effort` argumentHint / usage / help | `txr`/`S9`/`Jdt` cap 过滤（`[low|medium|high|auto]`） | ✅ |
| 3 | ModelPicker | ladder `Sr(Stt)` 截断、显示 clamp、focus 默认 clamp、持久化前 `lF` clamp、`wr` cap 注释行 | ✅ |
| 4 | API 请求 effort 参数 | `claude.ts:1735` `resolveAppliedEffort`（kE→P） | ✅ |
| 5 | `CLAUDE_CODE_EFFORT_LEVEL` env | kE 优先级链内 clamp（含 `auto`/数字值） | ✅ |
| 6 | `--effort` CLI | 汇入同一 kE 管线 | ✅ |
| 7 | agent frontmatter effort | `runAgent.ts` → kE | ✅ |
| 8 | settings 热更新（managed/IDE） | `applySettingsChange`（oRt）clamp 后入 AppState | ✅ |
| 9 | 启动期警告 | `Eur` → `emitStartupEffortCapWarning`（main.tsx，advisor 块前，官方同位） | ✅ |
| 10 | `CLAUDE_CODE_EXTRA_BODY` 注入 effort | **官方唯一不 clamp 入口**：`configureEffortParams` 早退 `if (!modelSupportsEffort(model) || 'effort' in outputConfig) return` | ✅（对齐官方豁免） |

### 2.6 文案（全部 byte-verified）

- `U` clamp：`Effort '${t}' exceeds the cap for ${s} set by your settings or organization; set to '${e}' instead (this session only): ${description}`（持久分支为 `(saved as your default for new sessions)`）；
- `Eur` 启动：`Effort '${e}' exceeds the cap for ${n} set by your settings or organization; using '${r}'.`；
- `wr` picker：`Higher effort levels are capped by your settings or organization.`；
- `sYt`：`Fable 5, Opus 4.7+, Sonnet 5`（xhigh 描述后缀）；
- argumentHint/usage/invalid-argument/help 均按 `S9`+`zS` 动态拼接。

## 3. 测试

- **单元**：`src/utils/__tests__/effortCap267.test.ts` — 59 tests（describe A schema / B 解析器 N(e) / C helpers / kE / D·E `/effort` / F oRt / G picker cycle / H 启动警告），全绿；TDD（先 RED 后实现）。
- **回归**：`effortGap97.test.ts` invalid-argument 断言改为模型无关（267 起列表 cap/model 感知）；xhigh/ai-agent 套件 32/32 绿。
- **真实 e2e**：`test/e2e/version-2.1.329-effort-cap.e2e.test.ts` —
  - ②③④⑦ wire 级：本地 mock Anthropic 端点捕获请求体，断言 `output_config.effort`（② Bedrock 拼写键 `us.anthropic.claude-opus-4-7-v1:0` 规范化命中；③ per-model `"max"` 豁免 + 去豁免后回落；④ user high + project medium → medium；⑦ EXTRA_BODY 注入 xhigh 不被 clamp + 对照组 `--effort xhigh` 被 clamp 为 high）；
  - ① REPL：tmux 起真实 REPL（settings `maxEffortLevel:"high"`），断言 `/effort ` argumentHint 只剩 `[low|medium|high|auto]`（hint 仅在命令后恰有一个尾随空格时渲染——OCC typeahead 与官方同规则）、选 xhigh 出逐字节 clamp 文案 `(this session only)`、settings.json **无写入**。
- **冒烟**：`occ -p`（真实 API）+ tmux REPL 手工验证。

### spec ⑩ 必测点对照

| 点 | 覆盖 |
|---|---|
| ① argumentHint 截断 + clamp 文案 + 不落盘 | unit（describe D）+ **REPL e2e** |
| ② dated/[1m]/Bedrock/Vertex 拼写规范化 | unit（B，四种拼写）+ **wire e2e**（Bedrock 键） |
| ③ per-model `"max"` 豁免 | unit（B）+ **wire e2e** |
| ④ 双文件取最低 | unit（B）+ **wire e2e** |
| ⑤ org cap 与 settings cap 取低 | **N/A** — OCC 无 org 注册表（`Stt ≡ N`，见 §5.1） |
| ⑥ env=xhigh + cap=high：启动警告 + 请求 effort=high | unit（kE env clamp + describe H 启动警告）+ wire 级 clamp 同 ⑦ 对照组 |
| ⑦ EXTRA_BODY 注入不被 clamp | unit（E）+ **wire e2e** |
| ⑧ thinking-disabled clamp + 遥测 | 既有 266 语义（`Nh` 门在 OCC 调用点），事件名不变，未回归 |
| ⑨ settings 热更新解除 launch pin | **N/A** — OCC 无 launch-pin 子系统（§5.4） |
| ⑩ `/effort auto` 删键而非写 null | unit（describe D：写 `{effortLevel: undefined}`） |

遥测/事件名保持不变：`tengu_effort_command`、`tengu_model_command_menu_effort`、`tengu_effort_clamped_thinking_disabled`、`effort_level` 字段。

## 4. 全量套件基线

- **`bun test src`（单元门禁，git stash A/B 核验）**：改动前基线 **31 fail**（既有失败：TaskOutput/OBt/Kut 2.1.261 spec、2.1.218 hooks、OTEL dominance、isPathTrusted 等，均与 effort 无关）；改动后 **2550 pass / 1 skip / 31 fail**，失败集与基线**逐条 diff 完全一致**——本轮零新增失败。
- **过程中发现并修复一个测试基建问题（Gap-97b 同类）**：bun 全量跑时所有测试文件共享单进程，`mock.module` 会**活体改写**已捕获的模块命名空间——`afterAll` 里 `() => actualModule` 的"恢复"实际重装 mock，导致本文件之后加载的 prompt-cache-ttl/outputLimits261/BashTool spec 等 16 个用例读到空 settings（`bun test src` 47 fail）。修复：mock 安装前**捕获真实函数引用**，所有 mock 闭包经 `mockActive` 旗标在文件结束后委托真实实现（组合跑 88/88、84/84 绿，全量回到基线 31）。
- **全仓 `bun test`（含 e2e，混版跑）**：3545 pass / 12 skip / 106 fail / 3 errors（3663 tests，432 files）。106 中 effort 相关仅 3 个，均为套件启动早于最后源码编辑的混版伪影（stale dist → REPL e2e ① 失败；cap.ts 尚无 emit 导出 → describe H 2 个失败）；重建 dist 后 e2e 文件单独重跑 **5/5 绿**、`effortCap267.test.ts` **59/59 绿**。其余 103 个与历届基线同类（tmux/live-gh/凭据/docker 环境依赖 e2e），与本轮改动无关。
- **真实冒烟**：`bun dist/cli.js --version` → `OCC 2.1.328`（合并后重验为 `OCC 2.1.329`）；`echo "say PONG" | bun dist/cli.js -p` → `PONG`（exit 0）；临时 HOME 种 `maxEffortLevel:"high"` + `-p --effort xhigh` → stderr 打出逐字节 Eur 警告 `Effort 'xhigh' exceeds the cap for … set by your settings or organization; using 'high'.`（⑥ headless 端到端）；tmux 手工 REPL：`/effort ` 提示只剩 `[low|medium|high|auto]`，选 xhigh 出 `(this session only)` clamp 文案且 settings.json 无写入。

## 5. Staged / 缩减项（含理由）

1. **`Stt` org 注册表侧**（`drt()`/`Be`/`qP` identity 匹配、firstParty/gateway 门）：OCC 无组织策略注册表，org 项恒为 null → `Stt ≡ N`。测试点 ⑤ 因此不可达。org 注册表落地时再补齐 min(settings, org) 合并。
2. **restrictive merge 表条目** `{path:["maxEffortLevel"],restrictive:Mu}`：OCC 无 managed/policy restrictive-merge 表子系统（`feedbackDrafts` 等同表条目亦不存在）；`N(e)` 跨文件取最低（policySettings/flagSettings 恒参与）已实现同等"越严越胜"语义，不另造表。
3. **`Zf` 的 stream-json `notification` 系统事件**（`cc({type:"system",subtype:"notification",…})`）：OCC 无该 subtype 发射器；json/stream-json/bg 模式降级为 debug 日志行（官方非 notification 分支同款），非 json 模式 console 黄字警告一致。
4. **launch pin**（`uF`/`Xk`/`Qie` unpin*LaunchEffort、`/effort` pin 拒绝文案）与 **per-model `te()` 持久化写**（`modelSettings.<model>.effortLevel` 写路径）：OCC 保持顶层 `effortLevel` 持久化（读侧 per-model effortLevel 266 已支持）。均为 266 前既有差异，非本轮回归；待后续轮统一对齐。
5. **org-default 提示文案**（`uxe`/`LP` 的 ", set by your organization" 后缀）：依赖 org 注册表，同 §5.1 N/A。
6. **ant 数字档位 `dF` 直通路径**：`anthropic_internal.effort_override` 仅 ant 内部；OCC 结构已对齐（kE 内数字→字符串归一），测试环境不可达，不做 e2e。
7. **picker ultracode chip**（官方 `dt(t)` 在 `zS(t)` 时追加）+ Gap-97f ultracode appState 管路：OCC picker 无 ultracode 会话态，`/effort ultracode`（K3）已有；chip 待 ultracode 状态入 picker 后补。
8. **Remote Control `apply_flag_settings` effort 通道**：OCC 无 RC bridge；`oRt` 语义已在 `applySettingsChange`（IDE/managed 热更新路径）落地。

## 6. 发布

- 版本号：`package.json` 2.1.328 → **2.1.329**；CHANGELOG 新条目；合入 main（PR）；tag `v2.1.329` 由发版流程（验收通过后）执行。
