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

---

## 7. P1 执行结果（程序员，2026-09-27）

基线 main `c732ab0`；工作分支 `agent/occ/31d2f391`。所有 PORT 均对官方
v2.1.283 ELF（md5 `b5afa8208e39db13e13e89449b1825f2`）做 byte-level 取证
（strings/dd，二进制全程未执行），实现由本人逐条复核（行为验证，不以
source-grep 为完成门槛）。

| 项 | changelog 条目 | 结果 | 验证 |
|----|---------------|------|------|
| P1-1 | 2.1.283 第 75 条（claude-ai 保留名回退） | **LANDED** | 部分回退按官方 v283 字节还原；回归 pin 绿 |
| P1-6b | 第 68 条（Skill deny 扩展） | **LANDED** | `Skill(anthropic-skills:*)` Desktop-plugin 投递 + alias/display-name 匹配，deny 语义测试绿 |
| P1-2 | 第 2/3 条（availableModelsMatch/deniedModels） | **LANDED** | 8 处 byte-offset 抽查属实；99 pass/0 fail/234 expects 本人复跑；45/0 回归 pin。偏差记录：该项 subagent 违反"每 run 一条评论"自行发过一条进度评论（`a294bff4`），无法撤回，以本轮总结评论为准 |
| P1-3 | 第 1 条（x-claude-code-prompt-id） | **LANDED** | 43/0/76 expects 本人复跑；`getAttributionHeader` cc_prompt_id 头对（UUID 正则 + firstParty + isFirstPartyAnthropicBaseUrl 门控，位于 workload 头对之后，对齐官方 r0r @199419765）；claude.ts/gatewayHints.ts/client.ts 全 threading 点位逐一核读 |
| P1-4 | 第 5/56 条（/doctor prompt-audit） | **STAGE** | 理由见下 |
| P1-5 | 第 4 条（OTEL tool.output） | **LANDED** | 17 pass/31 expects；`OTEL_LOG_TOOL_CONTENT` 基座上的增量 |
| P1-6a | 第 40 条（managed sandbox 部分无效 fail-closed） | **LANDED** | policySandbox283 14/14（71 expects）；settings 全套 253/0（753 expects，22 文件）；runtime trace 逐字节核对消息文本（含 W 序 skeleton 消息） |
| N36 | 第 67 条（--system-prompt 双形式） | **LANDED** | systemPromptMerge.ts（or @212162145 / C$n @203745647 / qvr @203745738）+ 10 单测 + 4 wire e2e（mock SSE，需 dist 构建） |
| N69 | 第 34 条（keybindings 指南 3s/cmd 文案） | **LANDED** | src/skills/bundled/keybindings.ts meta/cmd 行 + 3s chord 文案，源码级 smoke 绿 |

> 注：表中"第 N 条"= 官方 CHANGELOG 2.1.283 小节内 bullet 序号（1 起）。

**P1-4 STAGE 理由（4 条，按 §5.6 记录）：**
1. 官方实现是 `/doctor` 对 bundled `claude-api` skill 的薄委托，审计正文来自
   zst 压缩的 `shared/prompt-audit.md`；
2. OCC 的 bundled skill `.md` 文件是 OCC-44 起的有意 1-byte stub（该 STAGE
   注记对 credentials/prompt-audit 类正文持续成立），无正文可委托；
3. OCC 的 `/doctor` 是 local-jsx UI，与官方委托结构不同构，硬移植=发明；
4. 282→283 的增量（stale path/command 前置、contradicting instruction
   files、保留已文档化 thinking 关键词，第 56 条）扩展的是本就已 STAGE
   的表面——增量随主体一起解锁，不单独立项。

**P1-6a 实现要点**（byte-exact，名称映射已写入 policyLocks.ts 头注）：
`Lt`=isRecursiveEmptyPlainObject @196663983、`Sn`=isRebuiltBlock @196668238
（sandbox 仅排除 credentials）、`Ni`=null-removal @196668878（+removal:!0）、
`ta`=isDisableRemovalValue @196669384、`Ho`=applyLeafCoercion @196669558
（boolean 字符串强转 + disable-false 读作 key removal；wslInherits 的第 3 份
内联拷贝按官方原样保持内联）、`fg`=wrapLeafField @196670068（第 5 参
neverSubstitute，`h=c?void 0:g`，"not treated as X" ignore 变体）、
`jo`=rebuildBlockSchema @196671300（skeleton 排除合并、shape-aware 空检
`Object.hasOwn(n.shape,F)`、adopt 增 `||Lt(W)`）、`eg`=BLOCK_GRANTS
@196666922（sandbox.network/filesystem 行 +withholdOnEntryDrop:!0）、
os tail @196694745 专用 sandbox 接线（skeletonExclude=["sandbox.enabled"]、
neverSubstitute=["sandbox.failIfUnavailable"]）+ tail applicable 过滤
`&&!Lt(_[M])` @196695417。两条 2-record tail 语义（leaf/skeleton 替换记录 +
tail onlySubstitutes 记录）经 runtime trace 确认，与 282 remoteTools:"garbage"
pin 同构；policyStrictParse282 两条 282 pin 按 283 语义翻转并注明。
**STAGED**：官方 `te` credentials 覆盖（@196692500，awsPairs/sigv4/
allowPlaintextInject fail-closed 骨架）——OCC sandbox.credentials 仅
`{enabled}`，覆盖面不同构，OCC-97 的 credentials STAGE 注记继续成立。

## 8. 94 条逐行台账（§5.6 诚实分诊，全部 94 条无静默跳过）

行号 = 官方 CHANGELOG 2.1.283 小节 bullet 序号（1 起；临时文件
`cl283-triage.md` 的行号 = bullet 序号 + 2，该文件已按纪律删除，本台账
自带条目摘要，可独立核对）。

**判定计数：✅ LANDED 9 · 🔜 PORT-NEXT 38 · ⚪ NO-OP 13 · ⏸ STAGE 34
（合计 94；第 48 条 /mcp 列表为 PORT-NEXT+STAGE 混合，计入 PORT-NEXT）。**

### 8.1 ✅ LANDED（本轮已落地，详见 §7）

| # | 条目摘要 | 承载项 |
|---|---------|--------|
| 1 | x-claude-code-prompt-id gateway hint 头 | P1-3 |
| 2 | managed availableModelsMatch 模型治理 | P1-2 |
| 3 | managed deniedModels | P1-2 |
| 4 | OTEL tool.output 内容导出 | P1-5 |
| 34 | keybindings 指南 3s/cmd 文案 | N69 |
| 40 | managed sandbox 部分无效 fail-closed | P1-6a |
| 67 | --system-prompt/-append 双形式合并 | N36 |
| 68 | Skill(anthropic-skills:*) deny 扩展 | P1-6b |
| 75 | claude-ai 保留名回退 | P1-1 |

### 8.2 ⚪ NO-OP（13 条，逐条理由）

| # | 条目摘要 | 理由 |
|---|---------|------|
| 6 | fullscreen 截断消息 click-to-expand | OCC 无 click-to-expand 表面（`clickToExpand` grep 0）；特性整体缺席，无 bug 可修；若未来引入该特性须按官方 v283 形态整体落地 |
| 22 | `plugin details` MCP 计数为 0 | OCC plugin CLI（main.tsx ~4656-4770）无 `details` 子命令；官方修复在其 handler 内部。若未来为 parity 增加 `details`，须从第一天就统计 `plugin.json` 声明的 mcpServers |
| 24 | `plugin uninstall` 大小写碰撞误删 | 结构性免疫（binary-proven）：官方 bug 需要大小写不敏感回退 `U=cC(Object.keys(T),C)??C`（v282 @210948800+，v283 @212674800 修复为 `Zp` 碰撞集检查）；OCC 卸载路径全部精确匹配（pluginOperations.ts:194-198/452-457、installedPluginsManager.ts:924），三文件零 `toLowerCase`，bug 类不可能发生 |
| 38 | worktree checkout GIT_CONFIG_COUNT CA 校验失败 | OCC 全仓 `GIT_CONFIG_COUNT` 0 命中——OCC 不以 env 对形式向 git 注入 CA 证书，官方 bug 的触发路径（CA env 对在 worktree checkout 时丢失）在 OCC 不存在 |
| 39 | sandboxed git 让 credential helper 存 sandbox proxy 登录 | OCC sandbox 路径无 credential-helper 注入（sandbox/BashTool 零 credential 接线；全仓唯一 credential-helper 使用在 marketplaceManager git 操作，属 #049 官方忠实行为），"failed to store" 打印路径不存在 |
| 41 | auto-memory 笔记在 git 子目录启动时被误拦为 sensitive 写 | OCC 的 sensitive-写守卫直接以 auto-mem 路径为准放行：filesystem.ts:2517/2661 `isAutoMemPath(normalizedPath)` → `behavior:'allow'`（"auto memory files are allowed for writing"），不依赖 cwd 与 git root 的相对关系，官方的子目录解析 bug 在 OCC 无对应触发点 |
| 43 | /remote-control QR 提示窄终端断词 | 与第 42 条（Remote Control 付费计划门控，STAGE）同属 /remote-control 菜单表面；文案换行修饰随第 42 条一并处理，不单独立项（superseded） |
| 58 | artifact DB 有序查询整页提示 | OCC 无 artifact database 读表面（artifact watch/DB grep 0），无可修对象 |
| 60 | 首请求延迟：复用 preconnected 连接 | OCC 已有且设计即复用：`apiPreconnect.ts` 头注明 "Bun's fetch shares a keep-alive connection pool globally, so the real API request reuses the warmed connection"，init.ts:153-159 在证书/代理配置落定后触发——官方本条改进 OCC 结构性已具备 |
| 61 | 启动：`-p` 不载交互 UI + classifier/Artifact 懒加载 | OCC print 路径在 main.tsx:4284 `isPrintMode` 早分支，不挂载 REPL/Ink（4560 注释同旨）；auto-mode classifier 在 feature-flag 门后按需；Artifact tool 表面缺席（0 命中）。三个子项在 OCC 均已是目标形态 |
| 62 | claude.ai 账户 Artifact 特性未知时启动等 1.5s | OCC 无 artifact-feature 探测等待（grep 0），无可修对象 |
| 71 | `plugin eval` 要求 git ≥ 2.31 | OCC 无 `plugin eval` 命令（表面已裁剪）；官方修复属实（v283-only "eval: git version probe timed out" 等 3 串 @102186080+，v282 零命中），OCC 无可修对象 |
| 72 | artifact watch 3.5h 无活动自动解除 | 同第 58 条：OCC 无 artifact watch 表面，无可修对象 |

### 8.3 ⏸ STAGE（34 条，逐条理由）

| # | 条目摘要 | 理由 |
|---|---------|------|
| 5+56 | /doctor prompt-audit（新命令 + 283 报告增强） | P1-4，4 条理由见 §7 |
| 7 | stream-json init `plugin_errors` 增 `path` | systemInit.ts 只有 `plugins[]`，`plugin_errors` 字段整体缺席（grep 0）——官方 schema @197928420 含 path.optional()+describe；须随 stream-json init parity 整体落地（含 path），非独立 bugfix |
| 8 | gateway `load_test_mode` 块 | Claude apps gateway 为 Anthropic 服务端配置表面，OCC 无 gateway 服务端（`load_test_mode` grep 0） |
| 9 | gateway `mantle` upstream | 同上（gateway 服务端表面缺席）；OCC 客户端侧 mantle provider 已存在（providers.ts，2.1.94 A15），本条客户端无可动 |
| 15 | /usage 周 Fable 限额（遥测关时） | OCC /usage 无服务端周限额 schema（weeklyLimit grep 0）；限额数据来自 Anthropic 账户服务，无法从 ELF 推断 OCC 侧数据源——不发明 |
| 29 | screen-reader 权限对话框引号内容朗读 | OCC 有 screen-reader 模式（25 文件），但本条为辅助技术运行时行为（引号文本被读作对话框自身文本），本环境无 AT 运行时可验证；需真人/AT 环境逐站点核对后再移植 |
| 33 | cloud session 首词迟滞 | Anthropic cloud-session 流式基础设施，OCC 无 cloud session 传输层 |
| 37 | type-ahead/连击键对 stale state 处理 | 输入管线时序修复，需交互负载复现 + 官方逐站点反编译定位（typeahead grep 0，OCC 无对应机制命名）；盲改风险大于收益 |
| 42 | Remote Control 付费计划 + DISABLE_TELEMETRY/DO_NOT_TRACK 可用性 | 计划门控数据在服务端；OCC remoteControlServer 表面与官方 Remote Control 不同构，需专项取证后再对齐（第 43 条文案随本条） |
| 48-icon | /mcp 列表组织封锁工具警告图标 | 子项 STAGE：OCC 零 per-tool org policy 数据（`org_max_permission`/`permission_policy` grep 0 文件）；列表翻页/滚轮/鼠标部分见 PORT-NEXT |
| 59 | 首回复延迟：pattern-compile 前移 | 性能重排修复，需先定位官方 pattern-compile 步骤归属（正则预编译点位）再评估 OCC 对应热点；不猜测点位 |
| 64 | /ultrareview 启动对话框"上传未提交更改"文案 | 该文案描述官方本地分支审查上传未提交更改到云的行为；OCC /ultrareview 为本地执行、无此上传路径——照抄文案会失实（aligning-with-official-binary：不发明不存在的行为描述）；若未来引入上传路径则同步 |
| 70 | /workflows 运行列表尺寸对齐 | OCC workflow UI 为自建（WORKFLOW_SCRIPTS 存活但列表布局自定），半高内联 + 标题保持需 UI 反编译对照，随 UI 批次专项处理 |
| 73+74 | self-hosted runner git lifecycle / GIT_SSL_CAINFO | OCC 无 self-hosted runner 产品表面（`configure-git` grep 0）；runner 侧 git 行为无落点 |
| 76-82 | [VSCode] 7 条 | VSCode 扩展为独立客户端仓库表面，本仓（CLI）无对应代码；CLI ELF 中无可移植的客户端修复 |
| 83-85 | [Cloud sessions] 3 条 | Anthropic cloud-session 服务端行为（私仓只读挂载、重启后重复步骤、routine 默认错峰），OCC 无该表面 |
| 86-92 | [Claude Tag] 7 条 | Slack 集成产品（频道搜索管理设置、Back to Slack、attach rule、GitHub App 仓库搜索、重复回复、routine 频道 ID、Channel only 会话终止）均为服务端行为，OCC 无 Claude Tag 表面 |
| 93+94 | [Code Review] 2 条 | GitHub App "@claude review" 服务端重试/计费行为，OCC 无该表面 |

### 8.4 🔜 PORT-NEXT（38 条：本轮完成分诊+取证锚点，落地排入后续轮次）

F/G 簇 16 条已完成三重验证（changelog 原文 + OCC 表面 grep + v283/v282
二进制 byte-offset 差分），锚点如下；其余 22 条为表面核实后的结构性排队。

**F 簇（plugin CLI）：**

| # | 条目摘要 | 锚点/移植形态 |
|---|---------|--------------|
| 20 | validate 接受不可安装名 | v283 @231738823-231739300：`xRe(p.name)` 不可安装名 → `code:'error'` path:"name"（v282 仅 warning）；OCC validatePlugin.ts:171 复用 findReservedNameMatch + 字符集规则改 error |
| 21 | validate 放行越界 outputStyles/themes/monitors/lspServers | v283 @231723400-231724600 全新声明式 spec 表（`recordPathProperty`/`bareStringIndexed` v282 0 命中）；OCC 以 spec 表替换逐 kind 手写 path 检查（覆盖 OCC 已有 kind；themes/monitors 待 schema 引入） |
| 23 | marketplace remove 不列被卸载插件 | v283 @231809643-231810000 handler 输出行（"Also uninstalled…"等 3 新串）；OCC `removedPluginIds` 已在 removeAllPluginsForMarketplace 返回——纯管道工程，**最便宜的先手项** |
| 25 | 无版本插件按源最新 commit 恢复 | v283 @206783700-206786700：recordedGitCommitSha 复现安装版本时 pin sha fetch + 2 条回退警告；OCC pluginLoader.ts ~2390-2470 同 bug |
| 26 | home/config 目录迁移后 cache-miss | v283 新函数 `B6` @203630329（路径 marker 段回扫重定基）+ 两装载点 wrapper @206587523/@206534219；OCC pluginLoader.ts ~2203 同 bug |
| 27+28+57 | installed_plugins.json 三修复（无效 id 记录/重写丢记录/整体不可读恢复） | 单工作流 bundle：per-record 解析容错 @206583341、id 错误文案 @206587900、不可读记录只读策略 @206590016、无效 id 搁置+dated sidecar @206590443/@206596947、loader 穿线 @206771700（`installedListHeldNote` 11-vs-0） |
| 30 | /context 不计 MCP server instructions | v283 @204772591："MCP server instructions" 行插在 "MCP tools" 与 deferred 行之间、计入 reduce 总和；OCC analyzeContext.ts:1010-1055 加行（注入机制已存在：client.ts:261-385） |
| 32 | mcp add/add-json/remove 写失败仍报成功 | v283 @203712200-203713300：写后读回验证 + 两错误构造器（"protected by a sandbox" 等 6 新串）；OCC cli/handlers/mcp.tsx:336-365 + utils/config.ts:884-952 同 bug |

**G 簇（MCP）：**

| # | 条目摘要 | 锚点/移植形态 |
|---|---------|--------------|
| 11 | 后台化后 MCP 进度通知被丢弃 | v283 `mcpCallProgress` 4-vs-0；auto-background 点位 @~235308781：全局 progress-sink map（abort signal 为键）+ 1000ms 节流 statusMessage；OCC autoBackground.ts/McpBackgroundTask.ts 现丢弃（grep 0） |
| 12 | 会话结束时启动中的 stdio server 残留 | v283 @229241500-229242400：spawn 前 shutting-down 守卫（"Claude Code is shutting down…" 2-vs-0）+ exit hook 未建连即杀进程树（SIGINT 100/SIGTERM 400/SIGKILL 100，与 OCC 既有 disconnect 梯一致）；复用 processTreeKill.ts |
| 13 | stateless 远端瞬时 404 致服务器整会话不可用 | v283 @229386809 单条件：http transport 且无 sessionId 的 404 不再判 session-expiry；OCC client.ts:207-225 + ~3905-3935 同 bug |
| 14 | 无有效 URL 的 server sign-in 报 opaque SDK 错 | v283 @229199182：auth-start URL 守卫，/mcp 不再对此类 server 提供 Authenticate；OCC MCPRemoteServerMenu.tsx ~505-545 |
| 48 | /mcp 列表翻页/滚轮/鼠标 | MCPToolListView.tsx + CustomSelect 批次（警告图标子项 STAGE，见 §8.3） |
| 49 | MCP 工具图片落盘 | v283 Tr @229370112 + q9 @203281261；OCC client.ts ~3127-3147（image）/ ~3160-3190（resource-blob）复用 mcpOutputStorage.ts:148/188 |

**其余排队项（表面已核实存在，待专项反编译）：**

| # | 条目摘要 | 排队理由/形态 |
|---|---------|--------------|
| 10 | SDK 会话丢失 deferred tool call / result.usage | src/entrypoints/sdk 表面存活；三个子缺陷需逐站点反编译（turn 早结束、worker 重启后 held prompt、非流式回退 usage） |
| 16 | /model 接受带日期/-v1:0 后缀 id 的 `[1m]` | 模型治理批（与 17/18/19 同轮）：id 后缀解析规则需 byte 提取 |
| 17 | /model picker Haiku 版本/价格硬编码（ANTHROPIC_DEFAULT_HAIKU_MODEL pin 时） | 同批：picker 行数据源改为解析 pin 的模型 |
| 18 | model fallback 期间启动的 dynamic workflows 全跑 fallback 模型 | 同批：workflow agent 模型重试语义 |
| 19 | DISABLE_PROMPT_CACHING_HAIKU 对主模型 Haiku 无效 | 同批：cache 门控读取点位 |
| 31 | Warp 终端 markdown 链接渲染为纯文本 | OCC 有 Warp 检测引用（4 文件）；终端特定渲染修复需取证 |
| 35 | keybindings.json 误拼 modifier 静默接受 | keybindings 表面本轮存活（N69 已落地）；debug log 警告 + 建议修复文案需 byte 提取；与 36 同批 |
| 36 | footer "Enter to view" 在 footer:openSelected 重绑后不更新 | 同批：footer hint 与实际绑定联动 |
| 44+45+46 | vim 三修复（`.` 丢 Shift+Enter/重音字母/3J 光标；万字符 recall 光标越界 + `V p` 落点；`J` join 间距 + 3J 末行光标） | OCC 有真 vim 引擎（src/vim/），修复适用于 OCC 表面；按 OCC-44 §3d 纪律需逐站点反编译 + OCC-vim 行为验证后移植，不盲改 |
| 47 | Windows PowerShell `cmd /c rd` 等删驱动器根/家目录 | OCC 有 PowerShellTool（gitSafety/readOnlyValidation）；移植 Remove-Item 拒删等级的 guard |
| 50 | /tasks 列表状态图标/翻页/滚轮/点击 | UI 列表批次（与 51/52 同轮） |
| 51 | /help /hooks /copy 等 11 个 picker 翻页/鼠标 | 同批 |
| 52 | 搜索框旁列表 pointer 变暗（/skills /artifacts） | 同批（OCC /skills 存活；/artifacts 缺席则仅 /skills 侧） |
| 53 | compaction spinner 计时/token 计数替代百分比 | UI 批次：spinner 数据源改造 |
| 54 | MCP OAuth 登录后浏览器页（居中/暗色/新图） | OCC OAuth 简化版有回调页；HTML 资产需 byte 提取 |
| 55 | Skill 回复：所属 plugin 加载失败时说"加载失败"而非"未安装" | 随 F 簇 plugin bundle：OCC Skill tool + plugin 加载失败路径均存活；官方回复文案需 byte 提取 |
| 63 | 三方 provider/遥测关时会话默认 auto mode 启动 | OCC auto-mode 存活；defaultMode 决策链改动需取证（permissions.defaultMode 覆盖语义保持） |
| 65 | /model picker Opus 行/默认模型名去 "(1M context)" | OCC picker 自 OCC-36 1b 起有 "(1M context)" 行——本条为真实文案变更，窗口不变 |
| 66 | prompt suggestions 连续 20 次未用后降频 | --prompt-suggestions 表面存活；计数/降频逻辑需 byte 提取 |
| 69 | /rewind /diff 列表并入 select:* 动作（messageSelector:*/diff:* 重绑仍有效） | keybindings 动作映射批次（与 35/36 同轮） |

**跨项注记**：F8/F9/F10（27+28+57）为单 bundle；G1/G2/G3（11/12/13）同触
`src/services/mcp/client.ts`，落地时串行或协调；模型治理批（16-19）与
keybindings 批（35/36/69）各自成轮内并行簇。

## 9. 测试 / 构建 / 发布日志（本轮）

### 9.1 测试

- **权威门禁（逐文件进程隔离）**：`CI=true bash scripts/ci-test.sh` →
  **6832 pass / 0 fail / 115 skip，665 文件，exit 0**。本轮全部 11 个新
  283 测试文件单独确认绿：promptIdHeader283 43、reservedNamespacePermissions283 16、
  availableModelsMatch283 25、deniedModels283 28、modelGovernance283 32、
  managedOnlyKeys283 14、policySandbox283 14、reservedNamespaces283 46、
  toolOutputContent283 17、systemPromptMerge283 10、
  version-2.1.283-system-prompt-merge.e2e 4。
- **共享进程全量 `bun test`（非门禁，仅记录）**：6761 pass / 187 fail / 12
  skip（6960 tests）。187 失败全部属已归档的 `mock.module()` 跨文件泄漏类
  （OCC-129；ci-test.sh 头部注释即为此设立）——同一批文件在隔离门禁下全绿，
  泄漏证据：downloadStream.test.ts 期望 /Checksum mismatch/ 实得 401（前序
  文件状态泄漏），隔离后通过。
- **P1 分项自验计数（本人复跑，非子代理汇报）**：P1-2 availableModelsMatch +
  deniedModels 99 pass / 0 fail / 234 expects；P1-3 prompt-id 43/0/76；
  P1-5 OTEL tool.output 17 pass / 31 expects；P1-6a policySandbox283 14/14 +
  settings 套件 253/0。

### 9.1 追记（合并树重跑，§10 承诺项）

- **合并提交 `039a0af`（本轮 `26e7999` × origin/main `180db95`）之后的权威
  门禁重跑**：`CI=true bash scripts/ci-test.sh` → **6857 pass / 0 fail /
  115 skip，666 文件，exit 0**（较合并前 6832/665 的增量 = OCC-138 带入的
  misspelledModifier283 等测试文件 + 本轮被其取代的 282 命名恢复测试）。
- **构建重跑**：`bun run build` → `dist/cli.js` **30,947,156 bytes**，注入
  MACRO.VERSION=2.1.354。
- **合并后 live 冒烟（隔离 `CLAUDE_CONFIG_DIR`，重建 dist）**：
  `echo "reply with exactly: PONG-MERGED" | bun dist/cli.js -p` → **EXIT=0，
  stdout `PONG-MERGED`**；stderr 仅预期的 `[claude-code:unrecognized_model]`
  诊断行（qwen3.8-max，2.1.233 对齐行为）。
- **仲裁测试合并后单跑复核**：policySandbox283 14/14、managedOnlyKeys283
  14/14、policyStrictParse282 41/41、reservedNamespaces282 0 fail、
  reservedNamespacePermissions282 0 fail、promptIdHeader283 0 fail。

### 9.1 追记（二）（C1 合并树重跑，§10.1 承诺项）

- **合并提交 `859c8dd`（`d80491b` × origin/main `1f31a46`，OCC-138 C1
  prompt-id 集群，决议见 §10.1）之后的权威门禁重跑**：
  `CI=true bash scripts/ci-test.sh` → **6867 pass / 0 fail / 115 skip，
  667 文件，exit 0**（较上次 6857/666 的增量 = C1 带入的
  promptIdHeader283 客户端发射套件 10 项）。
- **构建重跑**：`bun run build` → `dist/cli.js` **30,947,156 bytes**，
  MACRO.VERSION=2.1.354。
- **C1 合并后 live 冒烟（隔离 `CLAUDE_CONFIG_DIR`，重建 dist）**：
  `echo "reply with exactly: PONG-C1" | bun dist/cli.js -p` → **EXIT=0，
  stdout 以 `PONG-C1` 开头**（live 往返成功；stdout 尾部附带网关模型
  qwen3.8-max 自行幻觉的一句元文本，属模型侧输出内容而非 OCC 缺陷——
  冒烟契约为 exit 0 + 真实往返，均满足）。
- **prompt-id 集群仲裁**：promptIdResolver283（我方 508 行套件）43 pass /
  0 fail / 76 expects；promptIdHeader283（C1 218 行套件，跑在我方
  `applyClientGatewayHintHeaders` 路径上）10 pass / 0 fail / 33 expects；
  gatewayHints273 59 pass / 0 fail / 126 expects（再导出无回归）。

### 9.1 追记（三）（C2 合并树重跑，§10.2 承诺项）

- **合并提交 `eada11a`（`62bee66` × origin/main `fc9dbb6`，OCC-138 C2
  OTEL tool.output 集群，决议见 §10.2）之后的权威门禁重跑**：
  `CI=true bash scripts/ci-test.sh` → **6870 pass / 0 fail / 115 skip，
  668 文件，exit 0**（较上次 6867/667 的增量 = C2 带入的
  mcpToolOutputOtel283 套件 17 项，减去我方 toolOutputContent283 修剪掉
  的 14 项重复 pin）。
- **构建重跑**：`bun run build` → `dist/cli.js` **30,946,875 bytes**，
  MACRO.VERSION=2.1.354。
- **C2 合并后 live 冒烟（隔离 `CLAUDE_CONFIG_DIR`，重建 dist）**：
  `echo "reply with exactly: PONG-C2" | bun dist/cli.js -p` → **EXIT=0，
  stdout 恰为 `PONG-C2`**。
- **C2 集群仲裁**：toolOutputContent283（修剪后）3 pass + mcpToolOutputOtel283
  17 pass，合计 20/20，0 fail / 40 expects。

### 9.1 追记（四）（验收修复树重跑，§11 承诺项）

- **§11 验收修复（9 findings）之后的权威门禁全量重跑**：
  `CI=true bash scripts/ci-test.sh` → **6875 pass / 0 fail / 115 skip，
  668 文件，exit 0**（较上次 6870 的增量 = 本轮新增 5 项：
  modelGovernance283 缓存 3 项 + toolOutputContent283 精确边界 2 项）。
- **构建**：`bun run build` → `dist/cli.js` **30,947,219 bytes**，
  MACRO.VERSION=**2.1.355**（随 release commit `cca3cbf` 的版本 bump）。
- **修复树 live 冒烟（隔离 `CLAUDE_CONFIG_DIR`）**：
  `echo "Output only this word and nothing else: PONGFIX" | bun dist/cli.js -p`
  → **EXIT=0，stdout 恰为 `PONGFIX`**。
- **spm wire e2e（#7/#9 修复后）**：4 pass / 0 fail / 12 expects（8.7s），
  跑后 `/tmp/occ-sp283-*` 残留 = 0（mkdtemp 泄漏已闭）。
- **mutation 复核（#8）**：`<=`→`<` 变异在新增精确边界 pin 下被捕获，
  恢复后绿（修复前该变异不红）。

### 9.2 构建

- `bun run build` → `dist/cli.js` **30,942,878 bytes**；构建后 0 个 src 文件
  比 dist 新（新鲜度确认）；注入 MACRO.VERSION=2.1.354。

### 9.3 真实 e2e（live API，非 mock）

- **`-p` 冒烟（隔离 `CLAUDE_CONFIG_DIR=/tmp/occ-smoke-cfg`）**：
  `echo "say PONG" | bun dist/cli.js -p` → **EXIT=0，stdout 含 PONG**
  （ANTHROPIC_MODEL=qwen3.8-max）；显式 `ANTHROPIC_MODEL=glm-5.2` 复跑 →
  **EXIT=0，stdout 含 PONG**。stderr 均打出
  `[claude-code:unrecognized_model] {"model":...,"query_source":"sdk"}`
  ——2.1.233 对齐的诊断行在 print 模式走 stderr，行为正确。
- **首轮冒烟 EXIT=124（90s 超时）定性：环境性，非本轮回归**。A/B 证据链：
  ① 隔离配置目录下同一 dist 两个模型均秒级 PONG + exit 0；② 挂死仅发生在
  加载完整宿主配置时——`~/.claude/settings.json` env 块
  `ANTHROPIC_MODEL=glm-5.2`（settings env 经 `applyConfigEnvironmentVariables`
  Object.assign 覆盖进程 env，官方语义）+ `~/.claude.json`（970KB）注册
  `xapi`/`WebSearch` 两个 MCP server，启动期连接即挂起；③ curl 直连代理
  glm-5.2 与 qwen3.8-max 均 HTTP 200（0.9s/1.6s），排除上游死链；④ 同一
  dist 全量隔离 CI（含 e2e）0 失败。结论：挂起来自宿主运行环境的 MCP 启动
  连接 + settings env 覆盖，与本轮代码变更无关（观察记录：宿主 MCP server
  在 OCC 启动期的连接挂起值得后续单独立项排查，非本轮范围）。
- **REPL tmux 交互冒烟（隔离配置目录）**：启动 → 主题选择（Enter）→ API key
  确认（选 Yes）→ 安全提示（Enter）→ 信任目录（选 Yes）→ 主界面就绪；
  发送 `reply with exactly: PONG-REPL` → **模型真实回复 `● PONG-REPL`**
  （live 往返）；`/status` → **Version: 2.1.354**、cwd 正确、
  Model: deepseek-v4-flash-0731（网关模型发现结果，显示项，非本轮触点）；
  `/exit` 退出 + kill-session，无残留进程（pgrep 确认）。

### 9.4 发布

- 按链条纪律：合入 main 后交 @安全审核员 后门审查 → @验收员 真人 REPL 验收
  + 分支清理；**验收通过前不发版**（不打 tag、不 bump 版本）。本轮版本号
  维持 2.1.354，发布（CHANGELOG + bump + tag → publish.yml → npm + GitHub
  Release → parity check）由验收后的下一环执行。

## 10. 与 OCC-138 并行轮的合并决议（本轮收尾时发生）

本轮分支基于 `9e0c050`；推送前 `origin/main` 已被并行的 OCC-138 轮推进
（`1c32d65` P1a sandbox 机制、`bba07e7` P1b claude-ai 回退+deny matcher、
`9bb67b2` G2 keybindings 误拼 modifier 校验、两份 gap 文档），与本轮三个
集群重叠。合并决议（以我方 byte-pin 测试为仲裁，全部对官方 v283 ELF
md5 b5afa8208e39db13e13e89449b1825f2 重新取证核实）：

| 集群 | 决议 | 依据 |
|---|---|---|
| 保留名空间（我 P1-1/P1-6b ↔ 其 P1b） | **取 OCC-138 版**（reservedNames.ts / SkillTool.ts / 其 282 名测试文件；弃我方 283 重命名版） | 其移植为超集（含 kOe/nse/v$o 加载过滤、BGo names_refused、_e held-back 遥测）；其两套测试 0 fail；我方消费文件（loadSkillsDir/mcpSkills/client.ts）所需符号在其导出表中逐一核对存在 |
| sandbox 策略机制（我 P1-6a ↔ 其 P1a） | **取 OCC-138 版 + 3 处 byte-verified 补丁** | 我方 policySandbox283 14 项 pin 跑出 2 项真实缺口：① BLOCK_GRANTS sandbox 两行缺 `withholdOnEntryDrop:!0`（官方 eg @196666922 dd 复读确认，其表保留的是 282 mn 时代的死行形态）；② os 尾 transform 缺 `!Lt(_[M])` 递归空值过滤（官方 @196695417 `w=Object.keys(_).filter((M)=>!lt.some((V)=>V===M)&&!Lt(_[M]))` dd 复读确认）。补入后 policySandbox283 14/14、其 policyStrictParse282 41/41 双绿 |
| 模型治理 schema 布线（我 P1-2，其未做） | **重放到其文件结构**：deniedModels `Ko` wrapper（@196677430 strings 复读确认全文）+ availableModelsMatch `Qe` 表项 `restrictive:"exact"`（官方表序 feedbackDrafts→availableModelsMatch→askUserQuestionTimeout strings 复读确认；其 P1a 注释曾把它当 OCC-schema-absent 略过，实际 types.ts:1211 存在该键） | 补入后 managedOnlyKeys283 14/14 |
| keybindings（我 N69 ↔ 其 G2） | 指南文案两侧代码相同（meta/cmd 行 + 3s 文案），**注释取 OCC-138 版**；其 validate.ts 误拼 modifier 校验 + misspelledModifier283（210 行）无冲突并入——**§8 中 bullet 35 由 STAGE 转 LANDED（经 OCC-138）** | 冲突仅注释；其测试 0 fail |
| mcp/client.ts | 双侧改动正交（我 P1-3 prompt-id 线程化 ↔ 其 P1b reserved prompt 过滤），单处注释冲突取其版（更详） | promptIdHeader283 43 项 0 fail |

validation.ts 自动合并产生的 `removal?: boolean` 重复字段已手工去重（保留
双侧注释中的 byte 事实）。合并后权威门禁重跑记录见 §9.1 追记。

## 10.1 第二次并行碰撞：OCC-138 C1（prompt-id 头）合并决议

§10 合并完成后、推送前再次 fetch，`origin/main` 又推进了 `1f31a46`
（OCC-138 C1：`x-claude-code-prompt-id` 网关头移植）——与本轮 P1-3 完全
重叠（同一官方特性，双方各自 byte-verified）。合并提交 `859c8dd`，决议：

| 触点 | 决议 | 依据 |
|---|---|---|
| claude.ts 两处客户端创建的 promptId 解析 | **取我方（P1-3）**：`resolveQueryPromptId(messages, agentContext)`（官方 `Wve/EIe/SZt` 逐查询消息扫描 + `parentPromptId` 回退全移植）；非流式回退走 `clientOptions.promptId` 线程化（官方 `e.promptId` @205291335 形态） | 其 C1 提交信息自证偏差："OCC messages don't carry promptId, so callers pass bootstrap getPromptId()… Documented deviation: no per-message scan"。我方 P1-3 已让消息携带 promptId（`Ae` 工厂 spread @207040852 移植 + query.ts/AgentTool/resumeAgent/WorkflowTool 线程化 + compaction 回填 + 归因头 `cc_prompt_id` @199419765），**消除了该偏差**——观测契约同名同校验同门控，解析路径更贴官方 |
| client.ts 头施加 | **取我方** `applyClientGatewayHintHeaders(defaultHeaders, source, promptId)`（2.1.273 内联块的重构提取，行为与其内联版逐语句等价：同 gate、同 `en` 校验、同 EV spread 语义 @202059092） | 其 C1 客户端级发射测试（10 项）在我方路径下 0 fail——行为等价的直接证据 |
| gatewayHints.ts 自动合并撞车（我方 import × 其内联定义 → `PROMPT_ID_HEADER` 重复声明） | **手工修复**：删除其内联 `PROMPT_ID_HEADER`/`PROMPT_ID_UUID_RE`/`validatePromptIdHeader`，改为从 ./promptId.ts **再导出**（`export { PROMPT_ID_HEADER }` + `export const validatePromptIdHeader = validatePromptId` 别名）——C1 已发布的导入面（从 gatewayHints 取这两个名字）原样保留，单一事实源在 promptId.ts | 两侧校验器同为官方 `en` @195845579 的 byte-verified 移植，正则/typeof 守卫逐字符一致 |
| 测试文件 add/add 同名冲突（promptIdHeader283.test.ts） | **两套都保留**：其 218 行版留在原名（测 gatewayHints/client 发射面）；我方 508 行 byte-pin 解析器套件更名 `promptIdResolver283.test.ts`（测 promptId.ts 全导出面） | 仲裁复跑：promptIdResolver283 43/0、promptIdHeader283 10/0、gatewayHints273 59/0（再导出无回归） |
| claude.ts `getPromptId` import | 移除（其 C1 布线专用，取我方布线后无引用） | biome pre-commit 通过 |

合并后权威门禁第二次重跑记录见 §9.1 追记（二）。

## 10.2 第三次并行碰撞：OCC-138 C2（OTEL tool.output）合并决议

§10.1 收尾后、推送前再次 fetch，`origin/main` 又推进了 `fc9dbb6`
（OCC-138 C2：MCP/WebFetch/WebSearch 的 OTEL `tool.output` 发射）——与本轮
P1-5 完全重叠（同一官方 283 块 @204862589，双方各自 byte-verified）。
合并提交 `eada11a`，决议：

| 触点 | 决议 | 依据 |
|---|---|---|
| toolExecution.ts 发射块（唯一冲突） | **取 OCC-138 版（C2）**：内联发射 + `mappedToolResultBlock` 提升到 `endToolSpan` 之前 + `endToolSpan(toolResultStr)` 尾随 | **C2 修正了本轮 P1-5 的一个真实 live-path 缺陷**：我方原布线把 `addToolResultOutputEvent` 放在 `endToolSpan` 之后，而 `endToolSpan` 会清空 ALS toolContext store（`toolContext.enterWith(undefined)`，合并树 sessionTracing.ts 实读确认），`addToolContentEvent` 读不到 store 即静默丢弃事件——我方 17 项单测直接测 helper（自带 span/store），照不出该排序缺陷（behavior-driven-done 教训又一例：单测绿 ≠ live 路径对）。官方 283 排序即"映射→发射→iPt"，C2 与之一致 |
| sessionTracing.ts 双侧 helper 并存（自动合并） | **保留 C2 的 `shouldRecordToolContentEvent`（rTr）+ `flattenToolOutputContent`（wbo）**；删除我方被取代的 `serializeToolResultContent`/`redactToolContentNotRecorded`/`TOOL_OUTPUT_CONTENT_WEB_TOOLS`/`shouldEmitToolOutputContent`/`addToolResultOutputEvent` 及随之无用的 WEB_*_TOOL_NAME import | 双方 wbo 移植逐分支比对行为一致（string 原样 / array→text+[type] 拼 \n / 其余→""）；KEe accountMemory 分支双方同为结构不可达（C2 记 NO-OP deviation，我方记 forward-compat），删我方版无观测损失 |
| 我方 `buildToolContentAttributes`（oTr 截断环） | **保留**——它已接线在 `addToolContentEvent` 内部（双侧共用的发射汇聚点），非死代码 | 其 C2 测试文件头注明确认截断属 pre-existing 面 |
| 测试 toolOutputContent283.test.ts（我 17 项 ↔ 其 mcpToolOutputOtel283 368 行） | **修剪我方文件至 3 项**（仅 oTr 截断 pin，文件头记录取代原委）；发射/wbo/rTr pin 由其 mcpToolOutputOtel283 承担 | 修剪后 toolOutputContent283 3/3 + mcpToolOutputOtel283 17/17，双绿（合计 20 pass / 0 fail / 40 expects） |

合并后权威门禁第三次重跑记录见 §9.1 追记（三）。



## 11. 验收修复轮（NEEDS_CHANGES → 修复，2026-09-27）

验收员对 `9e0c050..6a14385` 的完整验收裁决为 **NEEDS_CHANGES**（1×P2 + 8×P3，无 P0/P1；E2E PASS、Security CLEARED_WITH_RISK、硬检查 #6 通过）。全部 9 项在本轮修复，逐项记录：

| # | 级别 | 修复内容 | 验证 |
|---|------|----------|------|
| 1 | **P2** | `docs/upstream-version-gap-occ138.md` 裁决汇总行（:169）+ §6.3 B1/B2 行（:458）/K9 行（:463）：STAGE 判定划线作废，追记"已被 OCC-98 P1-2（模型治理）/ N36（--system-prompt 双形式）落地并随 merge `6a14385` 发货"，交叉引用本文档 §8.1 与 model-governance-283 台账。两账本不再互证矛盾 | 人工核对两 ledger 一致 |
| 2 | P3 | `README.md` 三处 2.1.283 叙述（What-is :16 / Capability-parity :65 / Status footer :160）补列 OCC-98 落地项：managed 模型治理（deniedModels/availableModelsMatch:"exact"）、完整 prompt-id 逐消息解析器（Wve/EIe/SZt）、N36 双形式合并、N69 keybindings 指南；STAGE 引用改为双账本。badge（:8）仅版本串，硬检查 #6 已核对 == 2.1.283 不动 | grep 四处版本串不变 |
| 3 | P3 | `modelGovernanceMessages.ts` TH 拒绝消息**重新对官方 ELF 字节取证后修复**：重下 v2.1.283 linux-x64（ELF md5 `b5afa8208e39db13e13e89449b1825f2` 与既有取证基线逐字节一致），dd 提取 TH @198791411 原文——官方两分支**共享尾句** `, and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".`，switch 分支**无**多余 `}`（原 port 把 minified 嵌套模板的收尾 `` `} `` 误当字面文本）。已按官方重写 denied 分支 + 同步 modelGovernance283.test.ts 两处 byte-exact pin（注明重取证来源） | modelGovernance283 35/35；exact-allowlist/catch 分支消息经比对与官方一致未动 |
| 4 | P3 | `docs/upstream-version-gap-model-governance-283.md` §4：12-fail 记录标注为 **mid-round 快照**（OCC-138 P1a 在飞时的时点数据），注明 policySandbox283.test.ts 属合并 PR diff（+343 行）、发货树 14/14 exit 0，指向本文档 §9.1 权威重跑（6870/0/115） | 人工核对 |
| 5 | P3 | `modelGovernance.ts`：`parseDeniedModelEntries` 加会话级 memo（`parseDeniedModelEntriesCached`，**以 policySettings 原始数组 identity 为键**——settings 重载必然产生新引用→自动 miss→重解析，同数组同解析结果，不会陈旧；对齐官方 `TO` "(cached)" 注释语义），另导出 `resetDeniedEntriesMemoForTest`。热路径（isModelAllowed→ModelPicker 逐行渲染）不再 O(entries) 重解析 | 新增 3 项缓存测试（identity 复用 / 重载重解析 / 缓存前后 deny-oracle 一致），套内 beforeEach 重置 memo；35/35 + model 目录 239/239 |
| 6 | P3 | `query.ts` reactive-compact backfill 死分支：**选择"注释标注死因"方案**（验收员 runtime-dataflow 帖 d113 给出的两个方向之一；删除会丢官方 @211163030 结构对齐，启用 gate 无意义——stub 恒 false/null）。在 require 守卫（:19）与分支头（:1262）加 DORMANT 注释：REACTIVE_COMPACT ∉ FEATURE_ALLOWLIST → 恒 null，official-parity 结构保留（先例：OCC-44 Monitor `qZs`）；可达的 compacted-summary promptId 不变量由 :588 proactive backfill 保证（有覆盖） | tsc/lint 无新错；行为零变化（纯注释） |
| 7 | P3 | `version-2.1.283-system-prompt-merge.e2e.test.ts:141` 字面 NUL 字节 → `'\x00'` 转义（TS 求值同为 NUL 字符，join 分隔语义不变）；`file` 判回 "JavaScript source, UTF-8 text"，git 恢复文本 diff/可 patch | spm e2e 4/4 pass（8.7s，wire 断言不变） |
| 8 | P3 | `toolOutputContent283.test.ts` 补两个精确边界 pin：exact-61440 原样透传（无 `_truncated`/`_original_length`）+ exact-61441 → 输出 == `'x'.repeat(61440)+'\n\n[TRUNCATED - Content exceeds 60KB limit]'`（恰 61482，含 original_length=61441）。**mutation 复核**：`<=`→`<` 变异现被捕获（修复前不捕获），恢复后绿 | 5/5 pass；mutation CAUGHT→restored GREEN |
| 9 | P3 | 同文件 4 个 mkdtemp 根在 finally 中与 `endpoint.close()` 并列加 `rmSync(root,{recursive:true,force:true})`（兄弟文件 effort-cap 先例） | e2e 跑完 `/tmp/occ-sp283-*` 残留 = 0 |

取证材料（重下的 v283 tarball/ELF）用完即删，不留仓内。修复树验证：构建 `dist/cli.js` 30,947,219 B（MACRO.VERSION=2.1.355，随 `cca3cbf` release commit）；权威门禁全量重跑记录见 §9.1 追记（四）。
