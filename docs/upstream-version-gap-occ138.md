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
| B1★ | `availableModelsMatch` managed setting（"exact"） | **STAGE（见 §6.3）** | 282:0 → 283:9 处；settings 信任链表面，与 OCC-97 Cluster B 同族。 |
| B2★ | `deniedModels` managed setting | **STAGE（见 §6.3）** | 282:0 → 283:23 处。 |

### C. gateway / 遥测（P3）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| C1★ | `x-claude-code-prompt-id` gateway hint header | **✅ 已落地（`1f31a46`，见 §6.1）** | OCC 已有 `GATEWAY_HINT_HEADERS` 基座（2.1.273 轮），增量 port；282:0 → 283:2 处。 |
| C2★ | OTEL `tool.output` 加入 MCP tool / WebFetch / WebSearch 输出 | **✅ 已落地（见 §6.2）** | OCC 已有 `OTEL_LOG_TOOL_CONTENT` 6 处命中，增量 port。 |
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
| F1 | 后台长任务的 progress 通知不再丢弃 | **STAGE（见 §6.3）** | OCC MCP client 有后台任务表面。 |
| F2 | 会话结束时 stdio server 残留 | **STAGE（见 §6.3）** | OCC stdio 生命周期。 |
| F3 | stateless remote server 短暂 404 后整会话不可用 | **STAGE（见 §6.3）** | OCC HTTP transport 错误恢复。 |
| F4 | sign-in 无有效 URL 的 opaque error；/mcp 不再提供 Authenticate | **STAGE** | OCC MCP OAuth 为简化版（CLAUDE.md 记录），表面不同。 |
| F5 | `mcp add/add-json/remove` 配置写失败仍报 success | **STAGE（安全相关，下轮优先，见 §6.3）** | 安全相关（静默失败）；OCC mcp CLI 表面存在。 |
| F6 | MCP tool 返回图片同时落盘 | **STAGE（P4 候选）** | 新行为面，需取证图片落盘路径约定。 |
| F7 | `/mcp` 工具列表 UI（翻页/鼠标/组织 blocked 图标） | **STAGE（P4）** | UI 批次。 |
| F8 | MCP sign-in 后的浏览器页（居中/暗色/新美术） | **NO-OP** | 官方托管的静态页面资产，不在 CLI 二进制行为面内。 |

### G. 安全 / 权限杂项（P2 — 本轮次优先）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| G1★ | Windows PowerShell `cmd /c rd/rmdir/del/erase` 删除驱动器根/家目录拦截 | **NO-OP（见 §5.1）** | 官方 283 实为 smart-quote 归一化 + PowerShell credential-theft 检测子系统（`tengu_curious_lake`），非 OCC 表面；OCC PowerShell 工具 AST 路径对驱动器根删除 fail-closed。 |
| G2★ | `keybindings.json` 误拼 modifier（如 `ctl+k`）debug-log 警告 + 建议 | **✅ PORT（`9bb67b2`，见 §5.2）** | 官方 `Me(e,r)` 校验器 + Damerau-Levenshtein 建议 + 指南文案全量落地，15 项测试。 |
| G3★ | auto-memory 子目录 sensitive-file 误拦（git repo 子目录启动时） | **NO-OP（见 §5.3）** | 官方双 resolver 不一致 bug 在 OCC 单 resolver `getAutoMemPath()` 结构上不可复现。 |
| G4★ | screen-reader 模式权限对话框把引号内命令/路径读成对话框自身文本 | **STAGE（取证穷尽，见 §5.4）** | 官方修复机制在 283 二进制行级差分中不可定位（全部 SR/对话框候选逐一排除）；OCC SR 为 flat-render 忠实 port，盲改即发明 → 按 Never-invent 纪律 STAGE。 |
| G5★ | sandboxed git 让 credential helper 存 sandbox proxy 登录 → "failed to store" | **NO-OP（见 §5.5）** | 官方 GCP `credential.<proxy>.helper=` 覆盖链在 OCC sandbox git 结构上不存在（5 条免疫证据）。 |
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
| I4 | keybindings 指南 1s→3s、`cmd`≠`meta` 别名文案 | **✅ 随 G2 落地（`9bb67b2`）** |
| I5 | footer hints `footer:openSelected` 重绑后仍说 "Enter to view" | **STAGE（P4）** |
| I6 | type-ahead / 键重复 / ssh-tmux 突发键 stale state | **STAGE** | OCC 输入栈不同（自研 Ink fork），需专项。 |
| I7 | `/remote-control` QR 窄终端断词 | **NO-OP** | OCC Remote Control 表面不同（daemon supervisor）。 |
| I8 | `/mcp`、`/tasks`、各 picker 列表翻页/鼠标/指针 dim | **STAGE（P4 批次）** |
| I9 | compaction spinner 计时起点 + summary token 流式计数替代百分比条 | **STAGE（P4）** |
| I10 | `/ultrareview` 上传未提交更改文案 | **NO-OP** | OCC 无 /ultrareview 表面。 |
| I11 | `/model` picker Opus 行去 "(1M context)" 文案 | **STAGE（P4 候选）** | OCC-36 轮落的 picker 行文案需对照 283。 |
| I12 | prompt suggestions 连续 20 次未用后降频 | **STAGE（P4）** |
| I13 | `/rewind` `/diff` 列表改用 `select:*` 键位动作 | **STAGE（P4）** — 取证：官方 283 unknown-action 校验从 `!A(h)` 变为 `!M(h)&&!q(h)`（动作名同时查主表 + 别名表），动作白名单 `YEe` 163→157 项；OCC `validateBlock` 缺该 unknown-action 检查（**既有缺口，非本轮回归**），随 P4 批次一并落。 |
| I14 | `/workflows` 运行列表尺寸（半终端 + 标题保留） | **STAGE（P4）** |

### J. vim 批次（P3 候选）

| # | 条目 | 裁决 | 说明 |
|---|------|------|------|
| J1 | vim `.` 丢 Shift+Enter 换行 / 重音字母内光标 / `3J`、Visual `J` 后重复旧更改 | **STAGE（见 §6.3）** | OCC 有完整 vim 表面（`src/vim/`），occ44 起 vim 修复按 per-site 取证纪律推进；本轮预算内能证则 port，否则诚实 STAGE。 |
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
| K9 | `--system-prompt`/`--append-system-prompt` 文本与 `-file` 双形式并用 | **STAGE（见 §6.3）** | OCC CLI 表面存在；小改动。 |
| K10 | artifact DB 有序查询满页提示 | **NO-OP** | OCC 无 artifact DB 表面。 |
| K11 | artifact watch 3.5h 自动解除 | **NO-OP** | 同上。 |
| K12 | Remote Control 在 telemetry off 时付费计划不可用 | **NO-OP** | OCC Remote Control 表面不同。 |
| K13 | `plugin_errors` 加 `path` 字段（`--plugin-dir` 加载失败条目） | **STAGE（见 §6.3）** | OCC stream-json init 事件已有 plugin_errors 基座（待核字段）。 |

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
| ✅ PORT 已落地 | A1、A2、G6（P1a+P1b）、G2（P2）、C1、C2（P3） |
| PORT 计划（P2） | G1–G5（裁决完成：1 PORT + 3 NO-OP + 1 STAGE，见 §5） |
| STAGE（原 P3 计划，预算耗尽诚实转 STAGE，逐项理由见 §6.3） | B1、B2、F1、F2、F3、F5、K9、K13、J1–J3 |
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

## 5. P2 — 安全簇（G1–G5 裁决完成：1 PORT + 3 NO-OP + 1 STAGE）

### 5.1 G1 — PowerShell 驱动器根删除拦截 → **NO-OP**

官方 283 二进制取证（strings-only，未执行）：

- changelog 所述拦截实为官方 283 新增的 **PowerShell credential-theft /
  危险命令检测子系统**（遥测名 `tengu_curious_lake`）：+9KB 增长区
  282:135398 ↔ 283:136389（`knownSwitches`/`knownValueParams` 表、引号配对器
  `Ye(e,n)`、tokenizer `Dt(e)`、验证器 `Cs(e)`/`Ls(e)`）。
- **smart-quote 归一化器 `Ae`**（283:138511）：`[‘-‛]`→`'`、
  `[“-„]`→`"`、`[–-―]`→`-`，再经 `B(e)` NFKC +
  dotless-ı/ſ 折叠——防全角/弯引号绕过检测。
- credential 检测 `Ce(e)`（283:276385/277887-9）：匹配
  CredentialManager / SecretManagement / Get-StoredCredential /
  Get-CredManCredential / PasswordVault / runas，配合 `Un` 正则与
  deny-rule 合成器 `Pe(e,n)`。
- OCC 裁决依据：OCC 的 PowerShell 工具走 AST 权限路径，对 `rd/rmdir/del/erase`
  驱动器根/家目录删除本就 fail-closed（拒绝不可解析/不可证明安全的形态）；
  官方新增的检测子系统属其正则/启发式管线的补强 + 遥测，OCC 无对应
  启发式管线可被绕过，亦无 `tengu_curious_lake` 表面。无可 port 的行为差。

### 5.2 G2 — keybindings 误拼 modifier 警告 → **✅ PORT（`9bb67b2`）**

- 官方 283 校验器 `Me(e,r)`（替换 282 仅查空 key part 的 `Se(e)`），
  byte 级取证：fuzzy 匹配 `CJ(e,n,{maxEditDistance=1})` + Damerau-Levenshtein
  `_6` @ELF 196737282；去重 `D(n)=[...new Set(n)]` @196094383；modifier
  元数据 `ce`/`Ie` 数组（cmd 别名 command/super/win，meta 独立）。
- 消息语法逐字对齐：`"X" is not a modifier, so "Y" in <Ctx> applies to "Z"
  instead` + Did-you-mean（全部 token 可 fuzzy 匹配时）/ 通用
  `Use ctrl, alt, shift, meta, or cmd before "+"...` 回退。
- 指南（bundled keybindings skill）同步官方 283 delta：meta/cmd 别名拆分
  说明、chord 超时 1s→3s（二进制 `var at=3000` 佐证，282 指南文案本就是
  bug）、doctor 表新增 "X is not a modifier" 行（官方 `Ys` 表
  s283s:300025，282 无此行）。
- OCC 发明的 `Could not parse keystroke` 消息移除——官方 282/283 均无此串。
- 测试：`src/keybindings/__tests__/misspelledModifier283.test.ts` 15 项
  （typo/换位/别名/大小写/多 token/去重/chord 重解析/无效 context/回归面）。

### 5.3 G3 — auto-memory 子目录 sensitive-file 误拦 → **NO-OP**

- 官方 bug 根因：双 resolver（memory 路径解析与 sensitive-file 检查各自
  resolve）在 git repo 子目录启动时给出不一致路径 → 自家 memory 文件被
  sensitive-file 规则误拦。
- OCC 结构免疫：auto-memory 路径单点出自 `getAutoMemPath()`
  （`src/memdir/paths.ts`），检查与写入共用同一 resolved 路径，双 resolver
  分歧不可能出现。
- 顺带观察（不落地，记录给后续轮）：官方 283 将 write-allow 收窄为
  `g.endsWith(".md")`；OCC 的 carve-out 无此后缀限定。OCC 当前语义更宽但
  作用面仅自家 memory 目录，非安全问题；如后续对齐 sensitive-file 簇再议。

### 5.4 G4 — screen-reader 权限对话框引号文本 → **STAGE（取证穷尽）**

对 282/283 二进制做了完整的行级/骨架级差分排查，官方修复点**不可定位**，
排除清单（全部 byte 级核实）：

1. 权限对话框行内 `waitingFor` 传播 delta = **纯遥测重构**：app-state store
   `userPrompt.pending:boolean`(282, `TVt`/`XYr`) → `userPrompt.waitingFor:
   value|undefined`(283, `w3t`/`Nar`/`wto`/`vto` @136927)，消费链
   `Oye()`→`Jco`→`utn` 发 `tengu_cache_heartbeat_shadow`，门控
   `snt()`=`tengu_dapper_dawn`（GrowthBook 默认 OFF）；另一消费点
   `isHeldByDialog`（282:157052↔283:158325）语义等价。
2. markdown 渲染器 `dI`（`screenReader:c=!1` 参数，282:220360↔283:222464，
   8197B）：骨架 + 字符串序列 0 差异。
3. prose 组件（282:298212↔283:300462，2360B）：0 差异。
4. AskUserQuestion `isScreenReader` 线索（282:248225↔283:150817）：两侧各
   4 site，`$ze/RY`≡`nYe/BY` 纯改名，`!h.isScreenReader&&Vze(Pe)` 门与
   t6t deny-feedback 片段（434B）逐字节相同。
5. SR 机制标识符计数两侧相等：prevScreenReaderPark 15/15、
   computeScreenReaderPark 3/3、srPreParked 10/10、axScreenReader 4/4；
   prevScreenReaderLines 渲染行仅改名。两版均无 screenReaderText/srText/
   spokenText 类文本变换 helper（0 命中）。
6. `aria-hidden` +1 = 283:240115 SVG pixelgram 渲染器（web 资产，非终端）。
7. "User denied permission" 所在 4 行配对：282:{4206,4802,281303} ↔
   283:{1700,5384,283996} 逐对骨架 diff **全同**（6424/6426、24636/24636、
   22/22B）；query-engine 282:135763↔283:130256（55066→44412B，−10.6KB）
   = **chunk 重切**：permission_bash / permission_ask_user_question /
   permission_coordinator_check 模式、hookUpdatedInput 决策逻辑、sandbox
   问答文案全部移入 283:138510/136696 等新 chunk（`permission_bash` 两侧
   各 2 处命中，内容未删）。
8. `accessibility:`/`role:"` 字面量两侧均 0（压缩后属性名，无差分信号）。
9. 283 新增字符串全集（comm -13，18616 行）无 SR/引号/对话框相关新文案。

OCC 侧判断：OCC 的 SR 输出走 `src/ink/screen-reader-render.ts`（官方 2.1.206
`mPr`/`iHh` flat-render 的忠实 port），整屏扁平序列化——与官方 282 行为
同构，同样存在"引号内命令/路径混入对话框文本流"的现象；但官方 283 的修复
机制（推测为对话框内引号内容节点的 a11y label/role 标注）在二进制差分中
不可见，任何 port 都只能靠发明，违反 `aligning-with-official-binary`
Never-invent 纪律 → **STAGE**。复审触发器：官方后续版本出现可定位的
SR-label 机制，或 OCC SR 用户实际反馈该痛点。

### 5.5 G5 — sandboxed git credential helper → **NO-OP**

- 官方 283 修复链（byte 级）：`Jxn()` 生成
  `credential.http://localhost:${n}.helper` 空值覆盖项，经 `Pot()` 进入
  `extraGitConfig:F?Pot():[]`（282 对应 `Cnt()`）；GCP 导出白名单
  `DAn` 中 `OAn=/^credential\.[a-z]+:\/\/.+\.helper$/` 放宽放行——即官方
  sandbox 内 git 通过 GIT_CONFIG_PARAMETERS 注入空 credential helper，
  阻止 helper 把 sandbox proxy 的 localhost 凭据存进用户钥匙串。
- OCC 免疫证据（5 条，src 全量 grep）：
  1. `refusing to export a git config entry` / `GIT_CONFIG_PARAMETERS` /
     `proxyAuthMethod` / `SANDBOX_RUNTIME` 全部 0 命中——OCC 无 GCP 导出
     管线，官方 bug 的载体不存在。
  2. `bashProvider.ts` `buildExecCommand(command, {id, sandboxTmpDir,
     useSandbox})` 无 extraGitConfig 参数面。
  3. OCC sandbox 代理 env 不含 userinfo 凭据（无 `user:pass@` 形态）。
  4. 代理认证仅 host 侧 `proxyAuthHeader`（进不了沙箱内 git 配置）。
  5. bwrap `--unshare-net` + socat 转发结构下，沙箱内 git 不会经由可被
     credential helper 缓存的 localhost 代理端点认证。

### 5.6 其他 283 delta（记录）

- `tengu_pewter_lintel` GrowthBook flag 门控 CLAUDE_CODE_COMMIT_BETWEEN_KEYS
  默认值（283 新串）；flag 默认 OFF，OCC 无该 env 表面，NO-OP。

## 6. P3 / P4（视预算）

预算内落地 C1、C2 两项（§6.1、§6.2）；其余 P3 计划项全部诚实转 STAGE
（§6.3）；P4 UI/UX 批次维持 STAGE（§2 I 簇逐条裁决即记录）。

### 6.1 C1 — `x-claude-code-prompt-id` gateway hint header（✅ `1f31a46`）

官方 283 机制（byte 级取证，v2.1.283 linux-x64 ELF）：

- 常量 `var bqn="x-claude-code-prompt-id"` @198746663，**283 新增**（282 ELF
  0 命中）；同时加入官方 protected-header 集合 `TC`（仅影响错误消息选型
  `Invalid ${header} header value`，OCC 无对应构造点，无需 port）。
- 客户端工厂 `EV` 的 header spread @202059092：
  `...W&&S!==void 0&&en(S)!==null&&{[bqn]:S}` —— gate（`qnn()`，即 OCC 已
  port 的 `isGatewayHintHeadersEnabled`）开启 AND promptId 已定义 AND 通过
  校验器 `en`，否则**静默丢弃**（不抛错、不发非法值）。
- 校验器 `en`（chunk-s1pmhfks @195845579）：
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`，
  非 string → null。
- 调用点：仅 query-engine 的 client 创建传 promptId —— 主 query
  （`query_client_creation_start` 后 @205359056）+ 两处 yOt 非流式 fallback
  （@205395827/@205399719）；`verifyApiKey` **不传**（282 行为保持）。

OCC 落地（3 文件 + 1 测试文件，10/10 pass）：

- `src/services/api/gatewayHints.ts`：`PROMPT_ID_HEADER` 常量 +
  `validatePromptIdHeader()`（官方 `en` 逐字节等价）。
- `src/services/api/client.ts`：`getAnthropicClient` 新增可选 `promptId`
  参数；gated header 块内按官方 spread 语义注入（校验失败静默丢弃）。
- `src/services/api/claude.ts`：主 query + `executeNonStreamingRequest` 两处
  client 创建传 `getPromptId() ?? undefined`；`verifyApiKey` 不传（官方
  parity）。
- `src/services/api/__tests__/promptIdHeader283.test.ts`：校验器全分支
  （大小写 UUID 通过、11 种非法串拒绝、含 CRLF 头注入、非 string 输入）+
  client 级 header 发射 5 例（gate on/off、非法值丢弃、undefined 缺席时
  2.1.273 hint headers 不受影响）。

**记录在案的偏差**：官方 promptId 从消息流解析（`Wve`/`EIe`/`SZt` 扫描最后
一条 user message 的 promptId，非主会话 fallback `agentContext.parentPromptId`）；
OCC 消息不携带 promptId，改为传 bootstrap `getPromptId()` —— 同一个 per-prompt
UUID（processTextPrompt/processSlashCommand 设置，OTel `prompt.id` 同源），
进程内 subagent 共享 STATE 故发送父会话当前 prompt id，语义等价于官方
parentPromptId fallback。降级方向安全：缺失只降低归因精度，**永不误归因**。

### 6.2 C2 — OTEL `tool.output` 扩展至 MCP / WebFetch / WebSearch（✅ 本 commit）

官方 283 delta（byte 级取证）：283 ELF `tool.output` 3 处 vs 282 的 2 处；
新增块位于 query-engine tool-dispatch @~204862679，处在 tool_result 映射
（`ls=...mapToolResultToToolResultBlockParam...`）之后、endToolSpan 对应物
（`iPt`）之前（283 同时把 `Hr`/`iPt` 重排到新块之后）：

```js
if((e.mcpInfo!==void 0||HQn.has(e.name))&&!oo.detached&&rTr(Wt)){
  let Sr=wbo(ls.content);
  oTr(Wt,"tool.output",{output:e.mcpInfo?.accountMemory===!0?KEe(Sr):Sr})}
```

- `HQn=new Set([Mr,uv])` @204827266，`Mr="WebFetch"` @200200794、
  `uv="WebSearch"` @202646603（builtin Read/Edit/Write/Bash 集合 `UQn` 282
  已有，对应 OCC 既有 contentAttributes 块，不动）。
- 门 `rTr(n){return ND()&&Iut()&&!Rk()&&n.isRecording()}` @201186406。
- 展平器 `wbo` @201186465：string 原样；非数组 → `""`；块数组 → text 块取
  `String(e.text)`，其余 `[${type??"unknown"}]` 占位，`\n` join（join 分隔符
  od 逐字节核实为模板串内真实换行）。
- 发射器 `oTr` @201186638 = OCC 既有 `addToolContentEvent`（截断 +
  `${key}_truncated`/`${key}_original_length` 已对齐）。
- accountMemory 遮蔽 `KEe(n)` @201178413 = `` `<${n.length} chars; not recorded>` ``。

OCC 落地（2 文件 + 1 测试文件，17/17 pass）：

- `src/utils/telemetry/sessionTracing.ts`：新增 `shouldRecordToolContentEvent()`
  （官方 `rTr` 调用点门）+ `flattenToolOutputContent()`（官方 `wbo` 逐分支
  等价）。
- `src/services/tools/toolExecution.ts`：新增 `WEB_OUTPUT_TOOL_NAMES`
  （官方 `HQn`）；**顺序对齐**：把缓存映射块（`mappedToolResultBlock`/
  `mappedContent`/`toolResultSizeBytes`）上提到 `endToolSpan` 之前（官方 283
  顺序：映射 → 新 tool.output → `iPt`；`endToolSpan` 会清 ALS store，发射
  必须在前），随后插入官方新块（mcpInfo 或 WebFetch/WebSearch → 展平映射
  content → `addToolContentEvent('tool.output', {output})`）。
- `src/services/tools/__tests__/mcpToolOutputOtel283.test.ts`：wbo 全分支
  7 例、rTr 门 env 真值表 4 例、runToolUse 集成 6 例（MCP 工具发射 + 展平、
  发射先于 endToolSpan 的顺序钉死、WebFetch/WebSearch 无 mcpInfo 也发射、
  无 mcpInfo 的 builtin 不走 283 路径、gate off 零发射、string content 原样）。

**记录在案的 NO-OP 偏差**：① `!oo.detached` —— OCC 工具结果无 detached
变体（官方 detached 旁路在 OCC 结构上不存在），条件恒真故省略；② `KEe`
accountMemory 遮蔽 —— OCC `mcpInfo` 仅 `{serverName,toolName}`，无
accountMemory 标志（MCP account memory 特性未 port，src 0 命中），三元
分支永不触发故省略；③ `!Rk()` —— 官方 CCR/cloud-remote 会话模式闩，OCC
无 CCR 表面，恒真；④ `n.isRecording()` —— 折叠进 OCC 既有
addToolContentEvent 的 store/span 存在性检查（既有门形状，非本轮引入）。

### 6.3 原 P3 计划余项 → STAGE（预算耗尽，逐项理由）

| 项 | STAGE 理由 |
|----|-----------|
| B1/B2 `availableModelsMatch`/`deniedModels` | 283 全新 managed-settings 表面（9/23 处命中），需恢复完整 settings 信任链机制（schema + 模型选择器全部消费点 + managed-only 强制），逐项 per-site 取证规模超出本轮剩余预算。下轮优先（settings 治理族，与 OCC-97 Cluster B 同基座）。 |
| F1 MCP 后台任务 progress 通知 | 官方 MCP client 后台任务生命周期多 site 差分，需专项取证 notification 缓冲/转发机制。 |
| F2 stdio server 会话结束残留 | 进程生命周期/清理路径与 OCC daemon 模型交叉，盲改风险高，需专项取证。 |
| F3 stateless remote 404 恢复 | HTTP transport 错误分类/重试语义 per-site 取证未完成。 |
| F5 `mcp add/remove` 静默失败 | **安全相关（静默失败），下轮优先**；OCC mcp CLI 写路径需先核对是否同构再 port。 |
| K9 `--system-prompt` 双形式 | CLI arg-parse site 取证未完成（官方 `-file` 后缀解析细节）。 |
| K13 `plugin_errors.path` | OCC stream-json init `plugin_errors` 基座字段需先核对（283 新字段的加载失败条目来源）。 |
| J1–J3 vim 批次 | 按 occ44 起的 per-site 取证纪律：每个行为需二进制行级差分定位 + OCC `src/vim/` 行为验证（OCC vim 引擎为独立实现，官方修复点位不必然同构），合并规模超出剩余预算；维持合并取证计划。 |
| I13 `select:*` 键位动作 | 已随 §2 I13 取证记录 STAGE（P4）：官方 unknown-action 校验 `!A(h)`→`!M(h)&&!q(h)`、白名单 163→157；OCC `validateBlock` 缺 unknown-action 检查为**既有缺口非本轮回归**，随 P4 批次一并落。 |

P4 UI/UX 批次（I 簇 + F7 + H5 等）：全部维持 STAGE，§2 逐条裁决即记录。


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
