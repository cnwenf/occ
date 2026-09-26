# OCC-138 — 2.1.282 → 2.1.283 对齐轮 gap 调研与实施记录

> 程序员实施文档（issue OCC-138，2026-09-27）。Leader kickoff 调研见
> `docs/upstream-version-gap-occ98-2026-09.md`（版本事实、strings 差分、簇初判）；
> 本文档为逐条裁决 + 落地记录，按簇增量更新。
> 方法学：`upstream-tracking` + `aligning-with-official-binary`；官方二进制全程
> **只做 strings/byte 取证，不执行**（occ136 §11.5 纪律）。

## 1. 版本事实（沿用 Leader occ98 §1，本轮已复核）

| 项 | 值 |
|----|----|
| 对齐目标 | 官方 Claude Code **2.1.283**（npm latest 2026-09-25，GitHub Release v2.1.283） |
| 基线 | OCC main `c732ab0`（tracking 2.1.282，release 2.1.354） |
| v2.1.283 linux-x64 ELF | 241,556,664 B，md5 `b5afa8208e39db13e13e89449b1825f2`，tarball sha256 `db404a91...`（与官方 SHASUMS256.txt 一致 ✓） |
| v2.1.282 linux-x64 ELF | 238,767,288 B，md5 `54435b7ed06ae1ef9417edda38256c15`（与 OCC-97 轮记录一致 ✓） |
| strings 差分 | 283 新增 18,616 行 / 移除 15,789 行（只作线索，落地点位逐字节核实） |
| changelog | `## 2.1.283` 共 **94 条 bullet** |

取证工作目录：runtime workdir `scratch-occ138/`（v282/v283 解包 + strings +
diff），**用完即删**（收尾时 `rm -rf`）。

## 2. 94 条 changelog 逐条裁决

裁决口径：**PORT**（本轮落地）/ **PARTIAL**（部分落地，余项记录去向）/
**NO-OP**（OCC 无该表面或行为已一致，逐条给理由）/ **STAGE**（有表面但需
专项取证或属功能决策，诚实推迟并记录）。带 ★ 的为 P1/P2 优先项。

### A. claude-ai revert + Skill deny 语义（P1b — ✅ 已落地 `bba07e7`）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| A1★ | Reverted the 2.1.282 reservation of the `claude-ai` name | **PORT（revert）** | 官方 zAe @197323150 = `["anthropic-skills"]` 单元素；`startsWith("claude-ai:")` 0 代码命中（唯一 `claude-ai:` 串为内嵌 changelog 文本）。OCC-97 Cluster D 的双元素数组回退为单元素；fallback reason `_Mt` @201087507 单名化（"the names reserved ..." 复数措辞保留，无 " or " join）。§4 详录。 |
| A2★ | Changed `Skill(anthropic-skills:<name>)` deny rules to also block that skill when Claude Desktop delivers it as a plugin, and `Skill(skill:<name>)` denies to match the skill's alias and display name | **PORT** | 283 重写 ue deny matcher + 新 packaging 机制（vdt/z$/d/JVn/dOo/uOo/le/w6/Be/fMe）全量落地；`De` desktop-holder 豁免、`he` renamed-variant（Es/ez mangled-name 规则面）**STAGE**（fail-closed 方向，见 §4.3）。§4 详录。 |

### B. managed 模型治理（P3）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| B1★ | `availableModelsMatch` managed setting（"exact"） | **PORT 计划（P3）** | 282:0 → 283:9 处；settings 信任链表面，与 OCC-97 Cluster B 同族。 |
| B2★ | `deniedModels` managed setting | **PORT 计划（P3）** | 282:0 → 283:23 处。 |

### C. gateway / 遥测（P3）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| C1★ | `x-claude-code-prompt-id` gateway hint header | **PORT 计划（P3）** | OCC 已有 `GATEWAY_HINT_HEADERS` 基座（2.1.273 轮），增量 port；282:0 → 283:2 处。 |
| C2★ | OTEL `tool.output` 加入 MCP tool / WebFetch / WebSearch 输出 | **PORT 计划（P3）** | OCC 已有 `OTEL_LOG_TOOL_CONTENT` 6 处命中，增量 port。 |
| C3 | `load_test_mode` gateway 配置块 | **STAGE** | Claude apps gateway **服务端**表面，OCC 无 gateway 服务端（沿 Leader D 簇初判；load_test_mode 282 已有 10 处命中为客户端侧探测串，归属服务端功能）。 |
| C4 | `mantle` upstream provider（Bedrock Mantle endpoint） | **STAGE** | 同上，gateway 服务端 provider 表。 |

### D. /doctor prompt-audit（P3 候选，规模待估）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| D1 | `/doctor prompt-audit`（`/checkup prompt-audit`） | **STAGE（本轮）** | 全新命令表面（282:7 → 283:13 处）；审计 CLAUDE.md/skills/agents/commands 的旧模型 prompting 模式。OCC src 0 命中，需专项取证 + 审计规则集全量恢复，规模超出本轮 P1/P2 预算；下轮优先候选。 |
| D2 | prompt-audit 配置侧增强（stale paths/commands/冲突 instruction files 领头） | **STAGE** | 依附 D1。 |

### E. plugin CLI 修复簇（P3/P4 逐条分诊）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| E1 | `plugin validate` 不可安装名 / marketplace.json 校验 | **PARTIAL→STAGE** | OCC plugin validate 表面存在但为裁剪版；需逐 site 取证，本轮预算外。 |
| E2 | `plugin validate` outputStyles/themes/monitors/lspServers 越界路径 | **STAGE** | 同 E1；OCC 无 lspServers/monitors 声明面。 |
| E3 | `plugin details` MCP 计数 0 修复 | **STAGE** | OCC plugin details 表面待核。 |
| E4 | `marketplace remove` 列出被卸载插件 | **STAGE** | UX 文案 + 行为，需取证。 |
| E5 | `plugin uninstall` 大小写碰撞误删 | **STAGE（安全相关，下轮优先）** | id 大小写归一化碰撞；OCC plugin id 处理需核对。 |
| E6 | 无 version 插件按源最新 commit 恢复 | **STAGE** | cache 恢复语义。 |
| E7 | home/config 目录迁移后 cache-miss | **STAGE** | 路径锚定逻辑。 |
| E8/E9 | `installed_plugins.json` 三修复（invalid id 加载 / 重写丢记录 / 不可读恢复备份） | **STAGE** | OCC installed_plugins 表面存在；恢复语义需逐 site 取证。 |
| E10 | Skill tool 对加载失败插件的回复措辞 | **STAGE（P4 候选）** | 小文案 + 判定逻辑。 |
| E11 | `plugin eval` 要求 git ≥ 2.31 | **STAGE** | OCC 无 plugin eval 表面（待核）。 |

### F. MCP 修复簇（P3）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| F1 | 后台长任务的 progress 通知不再丢弃 | **PORT 计划（P3）** | OCC MCP client 有后台任务表面。 |
| F2 | 会话结束时 stdio server 残留 | **PORT 计划（P3）** | OCC stdio 生命周期。 |
| F3 | stateless remote server 短暂 404 后整会话不可用 | **PORT 计划（P3）** | OCC HTTP transport 错误恢复。 |
| F4 | sign-in 无有效 URL 的 opaque error；/mcp 不再提供 Authenticate | **STAGE** | OCC MCP OAuth 为简化版（CLAUDE.md 记录），表面不同。 |
| F5 | `mcp add/add-json/remove` 配置写失败仍报 success | **PORT 计划（P3）** | 安全相关（静默失败）；OCC mcp CLI 表面存在。 |
| F6 | MCP tool 返回图片同时落盘 | **STAGE（P4 候选）** | 新行为面，需取证图片落盘路径约定。 |
| F7 | `/mcp` 工具列表 UI（翻页/鼠标/组织 blocked 图标） | **STAGE（P4）** | UI 批次。 |
| F8 | MCP sign-in 后的浏览器页（居中/暗色/新美术） | **NO-OP** | 官方托管的静态页面资产，不在 CLI 二进制行为面内。 |

### G. 安全 / 权限杂项（P2 — 本轮次优先）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| G1★ | Windows PowerShell `cmd /c rd/rmdir/del/erase` 删除驱动器根/家目录拦截 | **PORT 计划（P2）** | OCC PowerShell 拦截面存在（Windows 条目按 OCC 表面裁决）；官方正则 `^(rd|rmdir|del|erase)(?=$|[.:\[/+[\]",;=])` 待 byte 核实。 |
| G2★ | `keybindings.json` 误拼 modifier（如 `ctl+k`）debug-log 警告 + 建议 | **PORT 计划（P2）** | OCC keybindings 表面存在。 |
| G3★ | auto-memory 子目录 sensitive-file 误拦（git repo 子目录启动时） | **PORT 计划（P2）** | OCC auto-memory 表面存在。 |
| G4★ | screen-reader 模式权限对话框把引号内命令/路径读成对话框自身文本 | **PORT 计划（P2）** | OCC 权限对话框 a11y 面待核。 |
| G5★ | sandboxed git 让 credential helper 存 sandbox proxy 登录 → "failed to store" | **PORT 计划（P2）** | OCC sandbox git 表面存在。 |
| G6 | managed `sandbox` 设置单嵌套值非法时整块被忽略 → fail-closed + 余下仍生效 | **✅ PORT（P1a `1c32d65`）** | 见 §3。 |

### H. model / usage（P3/P4）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| H1 | `/model` 带日期/`-v1:0` 后缀时 `[1m]` 接受不一致 | **STAGE（P4 候选）** | model-id 解析细节，需 per-site 取证。 |
| H2 | `/model` picker Haiku 版本/价格硬编码 vs `ANTHROPIC_DEFAULT_HAIKU_MODEL` | **STAGE（P4 候选）** | OCC picker 数据层。 |
| H3 | dynamic workflows 在 model fallback 期间全部跑 fallback model | **STAGE** | OCC dynamic workflow 表面存在但 fallback 语义需取证。 |
| H4 | `DISABLE_PROMPT_CACHING_HAIKU` 在 Haiku 为主模型时无效 | **STAGE（P3 候选）** | 小逻辑，待取证。 |
| H5 | weekly Fable limit 在 telemetry off 时不显示于 `/usage` | **STAGE（P4）** | OCC /usage 表面待核。 |

### I. UI/UX 批次（P4）

| # | 条目 | 裁决 |
|---|------|------|
| I1 | fullscreen 其他会话截断消息 click-to-expand | **STAGE（P4）** |
| I2 | `/context` MCP instructions 独立行并计入 total | **STAGE（P4 候选，行为+UI）** |
| I3 | Warp 终端 markdown 链接可点击 | **STAGE（P4）** |
| I4 | keybindings 指南 1s→3s、`cmd`≠`meta` 别名文案 | **STAGE（P4，小文案）** |
| I5 | footer hints `footer:openSelected` 重绑后仍说 "Enter to view" | **STAGE（P4）** |
| I6 | type-ahead / 键重复 / ssh-tmux 突发键 stale state | **STAGE** | OCC 输入栈不同（自研 Ink fork），需专项。 |
| I7 | `/remote-control` QR 窄终端断词 | **NO-OP** | OCC Remote Control 表面不同（daemon supervisor）。 |
| I8 | `/mcp`、`/tasks`、各 picker 列表翻页/鼠标/指针 dim | **STAGE（P4 批次）** |
| I9 | compaction spinner 计时起点 + summary token 流式计数替代百分比条 | **STAGE（P4）** |
| I10 | `/ultrareview` 上传未提交更改文案 | **NO-OP** | OCC 无 /ultrareview 表面。 |
| I11 | `/model` picker Opus 行去 "(1M context)" 文案 | **STAGE（P4 候选）** | OCC-36 轮落的 picker 行文案需对照 283。 |
| I12 | prompt suggestions 连续 20 次未用后降频 | **STAGE（P4）** |
| I13 | `/rewind` `/diff` 列表改用 `select:*` 键位动作 | **STAGE（P4）** |
| I14 | `/workflows` 运行列表尺寸（半终端 + 标题保留） | **STAGE（P4）** |

### J. vim 批次（P3 候选）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| J1 | vim `.` 丢 Shift+Enter 换行 / 重音字母内光标 / `3J`、Visual `J` 后重复旧更改 | **STAGE→P3 视预算** | OCC 有完整 vim 表面（`src/vim/`），occ44 起 vim 修复按 per-site 取证纪律推进；本轮预算内能证则 port，否则诚实 STAGE。 |
| J2 | vim 光标越界（>10,000 字符 recall）/ `V`+`p` 落点 | 同上 | |
| J3 | vim `J` join 间距与 Vim 差异 | 同上 | |

### K. 会话 / 性能 / 启动（多为宿主耦合）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| K1 | SDK deferred tool call / worker 重启后 held approval / 非流式 fallback result.usage | **STAGE** | SDK 会话恢复语义，OCC SDK 入口面不同。 |
| K2 | cloud session 首词延迟 | **NO-OP** | 官方云会话服务侧。 |
| K3 | worktree checkout `GIT_CONFIG_COUNT` CA 证书 | **STAGE（P3 候选）** | OCC worktree 表面存在；git env 传递需取证。 |
| K4 | 首回复延迟（pattern-compile 前移） | **STAGE** | OCC 回复管线不同。 |
| K5 | preconnect 复用 | **STAGE** | OCC API 层连接管理不同。 |
| K6 | 启动懒加载（`-p` 不载交互 UI；auto-mode 分类器规则 + Artifact tool 首次用时加载） | **STAGE（P3 候选）** | OCC 启动路径需 profile 后定。 |
| K7 | claude.ai 账号 Artifact 特性未知时 prompt 不等 1.5s | **NO-OP** | 官方账号服务耦合。 |
| K8 | 三方 provider / telemetry off 时默认 auto mode 启动 | **STAGE** | 权限模式默认值变更，涉及 OCC auto-mode 面（classifier flags live），需专项验证不误开。 |
| K9 | `--system-prompt`/`--append-system-prompt` 文本与 `-file` 双形式并用 | **PORT 计划（P3 候选）** | OCC CLI 表面存在；小改动。 |
| K10 | artifact DB 有序查询满页提示 | **NO-OP** | OCC 无 artifact DB 表面。 |
| K11 | artifact watch 3.5h 自动解除 | **NO-OP** | 同上。 |
| K12 | Remote Control 在 telemetry off 时付费计划不可用 | **NO-OP** | OCC Remote Control 表面不同。 |
| K13 | `plugin_errors` 加 `path` 字段（`--plugin-dir` 加载失败条目） | **PORT 计划（P3 候选）** | OCC stream-json init 事件已有 plugin_errors 基座（待核字段）。 |

### L. 自托管 runner / VSCode / Cloud sessions / Claude Tag / Code Review

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| L1-L2 | Self-hosted runner lifecycle hooks git / `GIT_SSL_CAINFO` | **NO-OP** | OCC 无自托管 runner 表面。 |
| L3-L9 | [VSCode] ×7 | **NO-OP** | VSCode 扩展表面，OCC 无（沿历轮纪律：VSCode-only 条目 NO-OP）。 |
| L10-L12 | [Cloud sessions] ×3 | **NO-OP** | 官方云会话服务侧。 |
| L13-L19 | [Claude Tag] ×7 | **NO-OP** | Slack 集成服务侧，OCC 无表面。 |
| L20-L21 | [Code Review] ×2 | **NO-OP** | GitHub App 服务侧。 |

### 裁决汇总

| 裁决 | 数量（含计划） |
|------|------|
| ✅ PORT 已落地 | A1、A2、G6（P1a+P1b） |
| PORT 计划（P2） | G1–G5 |
| PORT 计划（P3，视预算，不足则转 STAGE 并记录） | B1、B2、C1、C2、F1、F2、F3、F5、K9、K13、J1–J3 |
| STAGE | D1、D2、C3、C4、E1–E11、F4、F6、F7、H1–H5、I1–I6、I8、I9、I11–I14、K1、K3、K4、K5、K6、K8 |
| NO-OP | F8、I7、I10、K2、K7、K10、K11、K12、L1–L21 |

## 3. P1a — managed sandbox 单字段非法 fail-closed（✅ `1c32d65`）

Changelog G6。官方 283 policy 机制 byte-level port（详见 commit message 与
`docs/upstream-version-gap-occ97-2026-09.md` 续录）：

- `policyLocks.ts` 282→283 符号对齐：`mn`→`Sn` isRebuiltBlock 不再排除
  sandbox；`tg`→`fg` wrapLeafField 增加 neverSubstitute + `Ho` pre-wrap +
  "ignored, not treated as X" record 变体；新增 `Ho` leafCoercionPreWrap /
  `ta` isFalsyBool / `Lt` isNestedEmptyObject；`Oi`→`Ni` nullRemovalIssue
  增加 removal:true；`Ki`→`jo` rebuildBlockSchema skeletonExclude-union。
- `policyStrictSchema.ts` / `validation.ts`：13 条 sandbox RESTRICTIVE_ENTRIES
  per-field fail-closed；非法嵌套值不再让整块 sandbox 设置失效。
- bespoke sandbox `jo` rebuild @196694745 对齐；RT③d 重钉（282 轮
  whole-block-discard pinning 测试按 283 语义重写，非删除）。
- `te` sandbox.credentials override **STAGE**（依赖链未恢复完整， omission
  方向 fail-closed）。

## 4. P1b — claude-ai 保留命名空间 revert + deny-matcher packaging 扩展（✅ `bba07e7`）

### 4.1 revert 取证（v2.1.283 ELF，byte 级）

| 锚点 | v282 | v283 | OCC 落地 |
|------|------|------|---------|
| `["anthropic-skills","claude-ai"]` | 1 处 | **0 处** | `RESERVED_NAMESPACES` 回退单元素 |
| `["anthropic-skills"]`（zAe @197323150） | 0 处 | **1 处** | ✓ 对齐 |
| `startsWith("claude-ai:")` | 2 处 | **0 处**（余串为内嵌 changelog 文本 @212287592） | claude-ai 名全面恢复普通语义 |
| fallback reason `_Mt` @201087507 | 双名 " or " join | 单名（复数 "the names reserved" 措辞保留） | ✓ 对齐 |
| `tengu_plaid_harbor` gate | 2 处 | 2 处（保留） | gate 不动 |

### 4.2 283 packaging 机制 port（A2）

官方符号 → OCC 导出：`vdt`→qualifyAnthropicSkillsName、`z$`→
unqualifyAnthropicSkillsName、`d`→selfQualifiedSkillName、`JVn`→
packagingAliasOf、`dOo`→pluginPackagingNames、`uOo`→syncedPackagingNames、
`le`→packagingNamesFor、`w6`→globPatternMatches（`^`+escaped-split-on-`*`
-joined-`.*`+`$`，/s）、`Be`→SKILL_LITERAL_RULE_RE（`/^\s*skill\s*:(.*)$/s`）、
`fMe`→renamedCandidate、重写 `ue`→skillDenyRuleMatches（普通名 `Le`：
invoked/registered/display/aliases/unqualifiedName(prompt-only) + packaging
名）、`ye`→matchSkillRuleForPermission（candidates [n, s?.name, fMe(s)?]）。

checkPermissions 顺序对 v283 @210644300 byte 重验（RT② 不变）：deny(ue) →
allow(ye, held-back 跟踪) → safe-props(`en(l)||Pge(n)`) → squatter
(`U=Bge()&&jB(a)&&!(l!==void 0&&Bee(l))`) 强制 ask（suppressAlwaysAllowRule）
→ 默认 ask（suggestions addRules [`a`, `${a}:*`] → localSettings）。

遥测修正：官方 283 `qe` @210630306 action map 为二元
（`renamed_allow_rule` 字符串 282:2 处 → 283:**0 处**，已移除）；OCC
`logHeldBackRuleTelemetry` 同步改为 nonholder→`nonholder_allow_rule`，
boundary/renamed→`prefix_at_namespace_boundary`。

### 4.3 STAGE / 偏差记录（均 fail-closed 方向）

| 项 | 理由 |
|----|------|
| `De` desktop-holder 豁免 gate | 依赖链未完整恢复（pP homoglyph skeleton、kJ、Jq、real Pd、L()/I）；省略 = 少豁免 = fail-closed over-block。 |
| `yu()` desktop gate | `E()&&!n().childSession` 在 OCC ≡ false（无 Claude Desktop 宿主）；官方 CLI 场景同为 false，语义一致。 |
| `he` renamed-variant deny lookup | call site 已解析（Aqt validateInput 的 Es/ez mangled-name 规则面）；OCC 无该规则面，port 无落点。 |
| `_H` 283 homoglyph skeleton | OCC 保留已文档化的 NFKC+lowercase 偏差（occ136 记录），283 skeleton 差异未证明影响判定集。 |
| 官方遥测 guard `_le(h,Qje)===null` | 282 同有（`bZ(k,ARe)`）——**先前已存在的文档化 gap**，非 283 回归；OCC 保留 mode-only guard（无 auto-mode rule-check 表面）。 |

### 4.4 D-cluster 测试重写（不删测，expected-red 诚实改写）

- `src/utils/skills/__tests__/reservedNamespaces282.test.ts`：51 pass / 215
  expect。单元素 pin、claude-ai revert pins（loader/MCP/rule/squatter 全面）、
  packaging 机制 12 个新导出全覆盖、renamed-telemetry 二元 map、MCP gate 翻转。
- `src/tools/SkillTool/__tests__/reservedNamespacePermissions282.test.ts`：
  14 pass / 43 expect。squatter 用例切 anthropic-skills；新增两条 revert pin
  （`Skill(claude-ai:*)` → allow + decisionReason rule；无规则 → 默认 ask 带
  suggestions 不 suppress）；RT② 注释更新到 v283 符号。
- 相邻回归：mcp invalidNameReason 16 pass、dynamicMcpConfig 14 pass、
  loadedSkillsDedup 7 pass、skillBackground 11 pass。
- 非测试源无 claude-ai 保留残留（`commands.ts`/`types/command.ts` 的
  `availability: 'claude-ai'` 为账号可见性特性，无关，不动）。

## 5. P2 — 安全簇（进行中）

（G1–G5 落地后逐条记录取证偏移量与测试。）

## 6. P3 / P4（视预算）

（B/C/F/K9/K13/J 簇落地或诚实 STAGE 后记录。）

## 7. 上轮 STAGE 复核（occ136 §6）

| 上轮 STAGE 项 | 本轮 283 复核 |
|--------------|--------------|
| S1 dangerous-rm dataflow classifier（tIe/Joe） | 283 无相关 delta，维持 STAGE。 |
| S2 auto-mode safety-dialog cap | 283 无相关 delta（OCC deny-without-dialog 姿态不变），维持 STAGE。 |
| S3 MCP Apps host | 283 无相关 delta，维持 STAGE。 |
| sandbox `excludedCommands` matcher 修复 | 283 G6 sandbox fail-closed 已落（P1a）；excludedCommands matcher 仍 STAGE。 |
| `--setting-sources` 转发 spawned sessions | 283 无 delta，维持 STAGE。 |
| vim 批次（282 轮） | 283 又有新 vim 修复（J1–J3），合并为 P3 候选一次取证。 |

## 8. 测试与收尾记录

（CI 全量 gate、REPL tmux e2e、README/polyfill 版本同步、scratch 清理后填写。）

## 9. 取证材料留存

`scratch-occ138/`（runtime workdir，用完即删）：v282/v283 解包（ELF 各一）、
s282/s283 strings、new/removed strings 差分、cc-CHANGELOG.md。官方二进制
按 SHASUMS256.txt 校验后下载，不执行。
