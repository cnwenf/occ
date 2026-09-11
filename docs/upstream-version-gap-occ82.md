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
| 10 | `CLAUDE_CODE_EXTRA_BODY` 注入 effort | **官方唯一不 clamp 入口**：`configureEffortParams` = 官方 `JCs` delete-first 两门——`if(!Nh(d)){delete n.effort;return}`（不支持 effort 的模型：注入的 effort 被**删除**，请求干净发出）+ `if("effort"in n)return`（支持的模型：注入值原样保留、不 clamp）。review P2-1 修复：此前 OCC 合并为单门 `||`，漏掉 delete 分支 | ✅（review P2-1 修复后逐字对齐） |

### 2.6 文案（全部 byte-verified）

- `U` clamp：`Effort '${t}' exceeds the cap for ${s} set by your settings or organization; set to '${e}' instead (this session only): ${description}`（持久分支为 `(saved as your default for new sessions)`）；
- `Eur` 启动：`Effort '${e}' exceeds the cap for ${n} set by your settings or organization; using '${r}'.`；
- `wr` picker：`Higher effort levels are capped by your settings or organization.`；
- `sYt`：`Fable 5, Opus 4.7+, Sonnet 5`（xhigh 描述后缀）；
- argumentHint/usage/invalid-argument/help 均按 `S9`+`zS` 动态拼接。

## 3. 测试

- **单元**：`src/utils/__tests__/effortCap267.test.ts` — 63 tests（describe A schema / B 解析器 N(e) / C helpers / kE / D·E `/effort` / F oRt / G picker cycle / H 启动警告；review 修复新增 4：P2-1 delete-first 门 ×2 + P3/oRt 前置门 ×2），全绿；TDD（先 RED 后实现）。（round-2 起 **72**，见 §8.5。）
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
6. **数字档位 `dF` 归一路径**：官方 2.1.267 `JCs` **没有** ant 数字分支（`r`/extraBodyParams 参数不使用，`effort_override` 在 ELF dump 0 命中）——OCC 的 legacy `USER_TYPE=ant` → `anthropic_internal.effort_override` 分支已在 review P2-1 修复中**移除**。数字 effort 由 `kE`（resolveAppliedEffort）内的 `dF` 归一为 `'high'`；该分支在测试环境**可达**（`CLAUDE_CODE_EFFORT_LEVEL=50` → parseEffortValue 返回数字 50，review P2-2 已补真实行为断言，此前"测试环境不可达"的注释为假）。
7. **picker ultracode chip**（官方 `dt(t)` 在 `zS(t)` 时追加）+ Gap-97f ultracode appState 管路：OCC picker 无 ultracode 会话态，`/effort ultracode`（K3）已有；chip 待 ultracode 状态入 picker 后补。
8. **Remote Control `apply_flag_settings` effort 通道**：OCC 无 RC bridge；`oRt` 语义已在 `applySettingsChange`（IDE/managed 热更新路径）落地。review P3 修复后含官方前置门 `if(!Nh(e)||DP()!==void 0)return`——模型不支持 effort 或 `CLAUDE_CODE_EFFORT_LEVEL` 存在时**不写** effortValue；官方的 pinning/org-default 物化分支（`uF`/`uxe`→`LP`）在 OCC 为 N/A（无 launch-pin 子系统 §5.4、无 org 注册表 §5.1）。

## 6. 发布

- 版本号：`package.json` 2.1.328 → **2.1.329**；CHANGELOG 新条目；合入 main（PR #349，merge `db2ab1a`）；tag `v2.1.329` 由发版流程（验收通过后）执行——**打在 review 修复后的 commit 上，不是 `db2ab1a`**。

## 7. Code-review 修复记录（2026-09-11，验收员三镜审查 564dcb3c → 程序员修复）

审查基线：`git diff 663f635..db2ab1a`（PR #349）；官方 2.1.267 ELF dump `/tmp/cc267/s267.txt` 逐字节复验。无 P1；2 项 P2 + 4 项 P3 处置如下（TDD：4 个新 RED 用例先行，实现后全绿）：

| 项 | 处置 | 落点 |
|---|---|---|
| **P2-1** `JCs` 合并守卫漏 `delete n.effort` | **已修**：按官方拆为 delete-first 两门 `if(!modelSupportsEffort(model)){delete outputConfig.effort;return}` + `if('effort' in outputConfig)return`；**并移除** legacy `USER_TYPE=ant` → `anthropic_internal.effort_override` 数字分支（官方 2.1.267 `JCs` 无数字分支、`r` 参数不使用、`effort_override` dump 0 命中——比 review 处方更进一步的全量对齐，`extraBodyParams` 形参保留以对齐官方 5 参签名）；同步修正 claude.ts 注释、本台账 §2.5 item 10 / §5 item 6、CHANGELOG 措辞。新增 2 个单元测试（不支持模型删除注入 effort；数字 effortValue 对 ant 也不再写 extraBody） | `src/services/api/claude.ts` |
| **P2-2** `dF` 数字分支"不可到达"注释为假 | **已修**：删除假注释，补真实行为断言——`CLAUDE_CODE_EFFORT_LEVEL=50`（parseEffortValue → 数字 50）+ cap=high → `resolveAppliedEffort` 返回 `'high'`；cap=low → dF 先归一再 clamp 返回 `'low'`；保留 `clampEffortToCap(30)===30` 直通断言 | `src/utils/__tests__/effortCap267.test.ts` |
| **P3-a** wire e2e 在 CI 永不执行 | **已修**：②③④⑦ 的 `describe.skipIf(!!process.env.CI)` 去掉（仅依赖本地 mock 端点 + fake key + 临时 HOME + 已构建 dist，无 tmux），成为常驻回归门；① tmux REPL 块保持 CI skip | `test/e2e/version-2.1.329-effort-cap.e2e.test.ts` |
| **P3-b** `oRt` 移植缺官方前置门 | **已修**（选择"按官方补门"而非仅记账）：`if(!Nh(e)||DP()!==void 0)return` → 模型不支持 effort 或 env override 存在时不写 effortValue；pinning/org-default 物化分支（`uF`/`uxe`→`LP`）保持 N/A（§5 items 4/5/8）。新增 2 个单元测试 | `src/utils/settings/applySettingsChange.ts` |
| **P3-c** 启动警告 model 取非交互 Fable-5 consent 回退**之前** | **已修**：`emitStartupEffortCapWarning` 改用 consent 回退后的 `parseUserSpecifiedModel(effectiveMainLoopModel ?? getDefaultMainLoopModel())`（交互路径行为不变） | `src/main.tsx` |
| **P3-d** ModelPicker `onSelect` 传未 clamp effort | **已修**：按官方 `ns(Ki)` 的 `Js = xi&&Nn!==void 0&&Nn!=="ultracode" ? lF(Nn,xi) : Nn`——onSelect 与 `tengu_model_command_menu_effort` 事件均改用按所选模型 clamp 后的值（OCC picker 无 ultracode 档位，该三元臂 N/A，见 §5 item 7）；/model 确认文案自此与实际生效值一致 | `src/components/ModelPicker.tsx` |
| **P3-e** SEC-1 `maxEffortLevel` `.catch(undefined)` fail-open | **不改**：官方同款行为（review 亦标注仅信息提示） | — |

## 8. Round-2 修复记录（2026-09-11，验收员复审 held 3 候选 → 程序员修复 `64d7ce1`，PR #351 → merge `96bd36e`）

复审背景：round-1（§7）收口后验收员仍持有 3 个候选——**runtime-3**（显示面未走 cap-clamp）、**test-f3**（ModelPicker capped-note/persist-clamp 缺正式测试）、**test-f4**（启动警告 bg-session gate 缺测试）。fix commit `64d7ce1`（4 files，+362/−17），全部 3 候选关闭。

### 8.1 runtime-3：显示面统一走 cap-clamp（本轮唯一运行时代码修复）

- **官方取证**（真实 2.1.267 二进制，tmux + mock SSE 实测；settings cap=`high`@claude-sonnet-5，启动 `--effort xhigh`）：logo 后缀 `Sonnet 5 with high effort`、状态 chip `● high · /effort`、`/effort` picker 停在 high——**所有显示面渲染 kE-clamp 后的值**。ELF 侧：`kE` 解析器出口统一过 `P(e,n)`，`P` 第一步即 `lF`（cap-only clamp），随后才是能力降级（max→high、xhigh→high）；banner 后缀渲染器 `wtt` 读取的是 kE-clamped 值。
- **OCC 缺口**：`resolveConfiguredEffort` 返回原始配置档位（Gap-97c capability-verbatim 语义），显示面（chip / banner / `/effort` 当前档位）随之显示未 clamp 的 `xhigh`，而 wire 侧（`resolveAppliedEffort`）已经 clamp——显示与请求不一致。
- **修复**：`src/utils/effort.ts` `resolveConfiguredEffort` 出口追加 `return clampEffortToCap(resolved, model)`（= 官方 `P` 的第一步 `lF`，cap-only）。**Gap-97c 保留**：能力降级仍不作用于显示路径，只有 settings cap 会 clamp 显示（describe I 含 2 条 capability-verbatim 对照测试钉死）。传递性修复 `getDisplayedEffortLevel`（chip + `/effort` 数据源，CC-1088）、`getEffortSuffix`（Logo/Spinner banner，官方 `wtt` 对应物）、`CLAUDE_CODE_EFFORT_LEVEL` env 显示路径。
- **独立 clamp 点**：`src/commands/effort/effort.tsx` `showCurrentEffort` 不经过上述出口，mutation M3b 暴露后单独修复——clamp 后输出 `Current effort level: ${clamped} (${description})`。

### 8.2 test-f3：ModelPicker `focusedCapped` + persist-clamp 覆盖（行为 round-1 已落地，本轮补正式证据）

picker 行为本体 round-1 已在 `src/components/ModelPicker.tsx` 落地（本轮零 diff）：`focusedCapped = hasEffortLevelsAboveCap(focusedModelForCap)`（官方 `vur` 按聚焦模型求值）、`wr` cap 注释行渲染、持久化前 `clampEffortToCap`（官方 `lF`，`updateSettingsForSource` 之前）、onSelect/事件传 clamp 后值（官方 `ns(Ki)` `Js`，即 §7 P3-d）。本轮补 **e2e ⑥**（tmux 真实 REPL，流程移植自验收员已验证探针）：`/model` → Up×4 到 Default(Sonnet 5) 行 → Right 切 xhigh（sonnet-5 支持 xhigh 且未被 cap）→ Down 到 capped `claude-opus-4-7` 行 → 注释行 `Higher effort levels are capped by your settings or organization.` 渲染 → Enter → settings.json `effortLevel:'high'`（陈旧 xhigh 被 persist-clamp）+ `/model` 确认文案 `with high effort`（非 xhigh）。

### 8.3 test-f4：启动警告 bg-session gate 覆盖（行为 round-1 已落地，本轮补正式证据）

官方 `Zf`：非 json 且非 bg（`CLAUDE_CODE_SESSION_KIND !== 'bg'`）→ 黄色 `console.warn`；json/stream-json/bg → `logForDebugging('[effort] ${Ve}')`。OCC `emitStartupEffortCapWarning`（`cap.ts`，round-1 落地，§5 item 3 缩减口径）同款；本轮补 **describe H +3**：bg → 无 console.warn + `[effort]` debug 行**内容**断言；json → 抑制 warn 保留 debug；interactive → warn 且无 debug 行。debug.js mock 遵守 §4 活体-mock 纪律（安装前捕获真实实现，`mockActive` 旗标委托，afterAll 复位）。

### 8.4 符号对照（round-2 增量）

| 官方 267 | OCC | 位置 | 状态 |
|---|---|---|---|
| `P(e,n)` 第一步 `lF`（显示面经 kE 出口统一 clamp） | `resolveConfiguredEffort` 出口 `clampEffortToCap` | `src/utils/effort.ts` | ✅ 本轮修复 |
| `wtt` kE-clamped banner 后缀 | `getEffortSuffix`（经 `resolveConfiguredEffort` 传递修复） | `effort.ts` | ✅ 传递修复 |
| `/effort` 无参当前档位显示 | `showCurrentEffort` clamp | `src/commands/effort/effort.tsx` | ✅ 本轮修复（M3b） |
| `vur`（按聚焦模型） | `focusedCapped` | `src/components/ModelPicker.tsx` | round-1 落地，本轮 e2e ⑥ 覆盖 |
| picker 持久化前 `lF` | `clampEffortToCap`（`updateSettingsForSource` 前） | `ModelPicker.tsx` | round-1 落地，本轮 e2e ⑥ 覆盖 |
| `Zf` 的 `CLAUDE_CODE_SESSION_KIND=bg` 门 + `[effort]` debug 行 | `emitStartupEffortCapWarning` | `src/utils/effort/cap.ts` | round-1 落地，本轮 describe H 覆盖 |

### 8.5 测试与 mutation 证据

- 单元 `effortCap267.test.ts` **63 → 72**（describe H +3 test-f4；describe I +6 runtime-3，含 2 条 Gap-97c capability-verbatim 对照）。
- e2e `version-2.1.329-effort-cap.e2e.test.ts` 新增 **⑤**（runtime-3 REPL smoke：启动 Eur 警告仍报原始越 cap 值，但 banner `with high effort` / chip `high · /effort` / `/effort` → `Current effort level: high` / wire `output_config.effort:'high'` 全部 clamp）与 **⑥**（test-f3 picker flow）。
- 3 步 mutation 协议（基线全绿 → 变异体在原套件存活 → 聚焦测试击杀）：**6/6 击杀**——M1 bg-gate 剥离（71/1）、M2 debug 内容剥离（70/2）、M3 显示 clamp 剥离（69/3）、M3b showCurrentEffort 剥离（71/1）、M4 picker persist-clamp 剥离（重建 dist，e2e ⑥ 失败 `high`≠`xhigh`）、M5 `focusedCapped=false`（重建 dist，e2e ⑥ 注释行缺失）。
- 回归：full `bun test src` 31 fail 与既有基线逐条一致（时间后缀归一后 diff 为空）；冒烟 `--version` → `OCC 2.1.329`、headless `-p` PONG、live Eur 警告逐字节。

## 9. Round-3 复审收口（2026-09-11，验收员在 `96bd36e` 复验功能全绿但 hold tag：文档滞后 + e2e harness 竞态）

验收员复验结论（`96bd36e`）：单元 72/72（154 expect）、wire e2e 7 pass（40 expect）、全量 src 2597 pass / 31 fail（A/B 与基线一致，零回归）、dist 28.99MB、`--version` → OCC 2.1.329、headless `-p` PONG、live Eur 警告逐字节、README Tracks badge 4 处 `2.1.267-partial` ✓。tag `v2.1.329` held，两项硬发现及处置：

1. **文档未随 round-2 更新**——本台账缺 round-2 记录（本 §8/§9 补上，含符号对照、取证、fix commit 引用）；CHANGELOG 2.1.329 条目「63 unit tests」与现状 72 不符（已改为 72 并注明 round-2 +9）。台账是后续轮次唯一依据，文档滞后即事故。
2. **e2e ⑤ harness 竞态**——`waitForWireBody` 盲取 `bodies[bodies.length-1]`；并发侧信道请求后到时，断言读到不含待断言字段的 body 误判失败（实测约 1/4 概率；tmux describe 为 CI-skip，CI 不可见）。测试脚手架竞态，非产品缺陷。**修复（按处方主句「选择包含待断言字段的最新 body」）**：helper 改为接受谓词 `matches(parsed)`，在**新增** body（下标 ≥ `count`）中自最新向旧扫描，返回第一条 JSON 可解析且满足谓词者；无命中继续轮询至超时，不再盲取最后一条。**实证收紧**：谓词为实际断言字段 `output_config.effort !== undefined`，而非仅 `output_config` 存在性——每条请求都携带 `output_config` 对象（`JCs` delete-first 门对不支持 effort 的模型只删 `effort` 键、保留 `output_config`，haiku 侧信道探测体因此也带空 `output_config`），首轮按存在性过滤的实现在验证中仍选中探测体复现同款失败（`output_config.effort` → `undefined`），故按处方主句收紧到断言字段本身。

分支清理（验收 ③）由验收员在最终修复 PR 合并后统一执行；tag `v2.1.329` 打在 round-3 最终修复 commit 上（验收员执行，随后观察 publish.yml 完成 npm + GitHub Release）。

