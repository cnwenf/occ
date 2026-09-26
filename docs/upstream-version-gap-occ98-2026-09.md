# OCC-98 — 2026-09-27 轮 gap 调研：官方 Claude Code 2.1.282 → 2.1.283

> Leader kickoff 调研文档（本轮 issue：OCC-98，autopilot 触发 2026-09-27 01:00 Asia/Shanghai）。
> 逐项 byte-level 取证与实现由程序员在本轮推进中补充（沿用 `upstream-tracking` +
> `aligning-with-official-binary` skill 方法学）。

## 1. 版本事实（三方核实，2026-09-27）

| 来源 | 结果 |
|------|------|
| OCC 当前 | `2.1.354`，main HEAD `c732ab0`，tracking 上游 **2.1.282**（OCC-97 轮已对齐，见 `docs/upstream-version-gap-occ97-2026-09.md`） |
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = **2.1.283**（published 2026-09-25T18:46:11Z）；`stable` = 2.1.274；`next` = 2.1.283 |
| GitHub Release（anthropics/claude-code） | `v2.1.283` published 2026-09-25T21:50:12Z，非 draft / 非 prerelease，为最新 release |
| 官方 CHANGELOG | `## 2.1.283` 段已发布，共 **94 条 bullet**（2.1.282 为 86 条） |
| v2.1.283 linux-x64 二进制 | tarball sha256 `db404a91bec8baffb53463166fdc8bf579208a527d60afc2d984d7507dc0c2f9`（与官方 SHASUMS256.txt 一致 ✓）；ELF 241,556,664 B，md5 `b5afa8208e39db13e13e89449b1825f2`；`2.1.283` 版本标记 2280 处；**无 2.1.284+ 标记** |
| v2.1.282 linux-x64 二进制（基线） | ELF 238,767,288 B，md5 `54435b7ed06ae1ef9417edda38256c15` —— 与 OCC-97 轮记录逐字节一致 ✓ |

**晋升判定**：npm `latest` 已移到 2.1.283（2026-09-25），GitHub Release 同步发布。
按 occ135 纪律（绝不从 `next`-only 版本 port）与 occ136 §10 晋升条件——**条件已满足，
本轮为实质追齐轮，对齐目标 = 2.1.283**。

## 2. ELF strings 差分（v2.1.282 ↔ v2.1.283，linux-x64）

方法：`strings -n 8 | LC_ALL=C sort -u`，双向 `comm`。

- 282 唯一串：298,222 行；283 唯一串：301,049 行
- 283 新增：**18,616 行**；283 移除：**15,789 行**

注意（沿用既有方法学）：minified JS 边界漂移会产生大量假阳性，差分结果只作
线索，不作为证据；每个落地点位需对官方 ELF 做逐字节提取核实后才实现。
官方二进制全程只做 strings/byte 取证，**不得执行**。

## 3. 本轮最高优先项（P1，已 byte-level 预核实）

### 3.1 ⚠️ 官方 revert：`claude-ai` 保留命名空间撤销（直接影响 OCC-97 Cluster D）

changelog 原文：*"Reverted the 2.1.282 reservation of the `claude-ai` name:
skills, commands, workflows and MCP servers' skills and prompts so named load
again, and `Skill(claude-ai:*)` rules are ordinary prefix rules."*

字节证据（本轮已核实）：

| 锚点 | v2.1.282 ELF | v2.1.283 ELF |
|------|-------------|-------------|
| `["anthropic-skills","claude-ai"]`（ITe RESERVED_NAMESPACES 双元素数组） | 1 处 | **0 处** |
| `["anthropic-skills"]`（单元素数组） | 0 处 | **1 处** |
| `startsWith("claude-ai:")` | 2 处 | **0 处** |
| `tengu_plaid_harbor` gate | 2 处 | 2 处（保留） |

OCC 现状：`src/utils/skills/reservedNames.ts` 的 `RESERVED_NAMESPACES =
['anthropic-skills', 'claude-ai']`（OCC-97 Cluster D 刚落）。**本轮需按官方
283 字节做部分 revert**：`claude-ai` 退出保留命名空间（skills/commands/
workflows/MCP skills+prompts 恢复可加载，`Skill(claude-ai:*)` 规则回到普通
前缀规则语义），`anthropic-skills` 保留及 plaid-harbor gate 不动。相关测试
（`reservedNamespaces282.test.ts`、`reservedNamespacePermissions282.test.ts`）
与 Cluster D 各接线点需同步修订；`pge`（claude-ai:↔anthropic-skills: 别名
互转）在 283 的去留需 byte 取证后定。

### 3.2 新增 managed 模型治理设置（283 新表面，OCC 0 命中）

- `availableModelsMatch`（`"exact"` 时 `availableModels` 条目只放行点名的模型
  版本，新模型发布保持 blocked 直到列入）——282:0 处 → 283:**9 处**
- `deniedModels`（即使 `availableModels` 允许也可阻断特定模型）——282:0 处 →
  283:**23 处**

与 OCC-97 Cluster B（policy-source strict parse）同族，属 settings 信任链表面。

### 3.3 gateway hint header 扩展（OCC 已有基座）

`x-claude-code-prompt-id`（LLM gateway 归组同一用户 prompt 的请求；
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` opt-in）——282:0 处 → 283:**2 处**。
OCC 已有 `GATEWAY_HINT_HEADERS` 4 处命中（2.1.273 轮落的基座），为增量 port。

### 3.4 `/doctor prompt-audit` 新命令

`prompt-audit` 282:7 处 → 283:**13 处**（`/doctor prompt-audit` /
`/checkup prompt-audit`：审计 CLAUDE.md、skills、agents、commands 中为旧模型
写的 prompting 模式；配置侧 stale paths / stale commands / 冲突 instruction
files 领头报告）。OCC src 当前 0 命中，为全新表面，工作量待程序员分诊。

### 3.5 OTEL tool.output 扩展

MCP tool / WebFetch / WebSearch 输出加入 `tool.output` span event
（`OTEL_LOG_TOOL_CONTENT=1` 时）。OCC 已有 `OTEL_LOG_TOOL_CONTENT` 6 处命中，
为增量 port。

### 3.6 与 OCC-97 已落项的复核项

- *"Fixed managed `sandbox` settings being ignored entirely when one nested
  value was invalid; the invalid value now fails closed and the rest of the
  block still applies"* —— 语义与 OCC-97 Cluster B partial-block salvage 高度
  相近，需逐字节复核 OCC 现行实现是否已 == 官方 283 行为（可能 NO-OP）。
- *"Changed `Skill(anthropic-skills:<name>)` deny rules to also block that
  skill when Claude Desktop delivers it as a plugin, and `Skill(skill:<name>)`
  denies to match the skill's alias and display name"* —— 与 Cluster D deny
  matcher 的 deviations（OCC 省略 alias 展开）相关，需重新取证。

## 4. 94 条 changelog 分诊初判（Leader 粗分，逐项裁决归程序员）

| 簇 | 条目（概述） | 初判 |
|----|-------------|------|
| A. claude-ai revert + Skill deny 语义 | §3.1、§3.6 两条 | **P1 PORT/REVERT** |
| B. managed 模型治理 | availableModelsMatch、deniedModels | **P1 PORT** |
| C. gateway/遥测 | x-claude-code-prompt-id、OTEL tool.output | P1-P2 PORT（有基座） |
| D. gateway 服务端 | load_test_mode、mantle Bedrock provider | 初判 STAGE（OCC 无 gateway 服务端表面；load_test_mode 282 已有 10 处命中，需确认归属） |
| E. /doctor prompt-audit | 新命令 + 配置审计增强 | P2 PORT（新表面，规模待估） |
| F. plugin CLI 修复簇 | validate（不可安装名/越界路径）、details MCP 计数、marketplace remove 列表、uninstall 大小写碰撞、无版本插件恢复、installed_plugins.json 三修复、cache-miss（home 迁移）、eval git≥2.31 | P2 逐条分诊（OCC plugin 表面存在） |
| G. MCP 修复簇 | 后台进度通知、stdio server 残留、stateless 404 恢复、sign-in opaque error、tool 图片落盘、/mcp 列表 UI | P2 逐条分诊 |
| H. 安全/权限杂项 | sandboxed git credential helper、Windows PowerShell 驱动器根删除 guard、screen-reader 权限对话框、keybindings 误拼 modifier 警告 | P2（Windows 条目视 OCC 表面定 STAGE） |
| I. model/usage | /model `[1m]` 后缀、Haiku picker 硬编码、DISABLE_PROMPT_CACHING_HAIKU、dynamic workflows fallback、/usage Fable 限额 | P2-P3 逐条分诊 |
| J. UI/UX 批次 | /tasks、/help 等 picker 列表翻页/鼠标、compaction spinner token 计数、fullscreen click-to-expand、/rewind /diff select:* 键位、/workflows 列表尺寸、footer hints、prompt suggestions 降频、/model picker "(1M context)" 文案、/ultrareview 文案、Warp 链接、/context MCP instructions 行、/remote-control QR 换行 | P3 批次分诊（多数小改） |
| K. vim 批次 | `.` 丢 Shift+Enter、光标越界、`J`  join 间距等 | 初判 STAGE（OCC vim 批此前一直 STAGE，除非本轮已有 vim 表面） |
| L. 会话/性能 | SDK deferred tool call、首回复延迟、preconnect 复用、startup 懒加载（-p 不载交互 UI）、auto-mode 默认（三方 provider/遥测 off）、type-ahead stale state、cloud session 流式 | 多为 backend/宿主耦合，逐条 NO-OP/STAGE/PORT 分诊 |
| M. 自托管 runner / VSCode / Remote Control | lifecycle hooks git、GIT_SSL_CAINFO、VSCode 权限模式指示器、Remote Control 可用性 | 初判 STAGE（OCC 无对应表面，需确认） |
| N. 其他 | worktree GIT_CONFIG_COUNT CA、auto-memory 子目录 sensitive-file 误拦、--system-prompt 双形式、keybindings 指南 3s 文案、artifact DB 分页读、artifact watch 3.5h、MCP sign-in 浏览器页 | 逐条分诊 |

## 5. 本轮范围与推进约定

1. **对齐目标 = 官方 2.1.283**；基线 = OCC main `c732ab0`（tracking 2.1.282，
   release 2.1.354）。
2. 方法学沿用：changelog 94 条为权威清单，逐条 triage（PORT / NO-OP /
   STAGE），每个 PORT 落地点位对官方 v2.1.283 linux-x64 ELF（md5
   `b5afa8208e39db13e13e89449b1825f2`）做 byte-level 提取核实后才实现；
   strings 差分只作线索。官方二进制不执行。
3. P1 顺序建议：A（revert，先做——上轮刚落，越晚越容易长依赖）→ B → C →
   H 安全杂项 → 其余按簇。
4. 测试要求：真实 e2e（含 REPL tmux 实操）+ 全量 CI（`CI=true bash
   scripts/ci-test.sh`）+ build；与官方二进制 string A/B 对照。
5. 链路：程序员对齐合入 main → @安全审核员（后门审查）→ @验收员（功能/设计
   对齐 + 分支清理 + 真人 REPL 体验）→ 验收通过通知程序员按 issue 正文发版
   流程发布（tag → publish.yml → npm + GitHub Release → releases/tags 一致
   核验 → 回报本 issue）→ @OCC Leader 收尾（翻 done + lark 汇报）。
6. 诚实分诊纪律：NO-OP/STAGE 必须逐条给理由并记录在本文档续篇，不允许
   静默跳过。

## 6. 取证材料留存（本轮 runtime workdir，用完即弃）

- `cc-official/claude`（v2.1.283 ELF，md5 `b5afa8208e39db13e13e89449b1825f2`）
- `cc-official-282/claude`（v2.1.282 ELF，md5 `54435b7ed06ae1ef9417edda38256c15`）
- `s282.txt` / `s283.txt`（strings -n 8 sort -u）、`diff_new.txt`（18,616 行）/
  `diff_removed.txt`（15,789 行）

程序员如需官方二进制，自行按 SHASUMS256.txt 校验后下载
（`gh release download v2.1.283 --repo anthropics/claude-code`），勿信任何
未校验副本。
