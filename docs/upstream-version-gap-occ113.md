# OCC-113 — 版本追齐 2.1.252 → 2.1.258（gap 调研 + 对齐）

- **轮次日期**: 2026-09-03
- **OCC 起点**: 2.1.319（= 官方 2.1.252，`021df1f chore(release): 2.1.319`）
- **官方最新版本**: 2.1.258（2.1.253–2.1.256 从未发布；gap = 2.1.257 的 104 条 + 2.1.258 的 2 条，共 106 条，见 `cc-diff-113/entries-113.txt`）
- **方法**: 官方 2.1.258 linux-x64 ELF 二进制取证（`grep -aboF` 定位 + `dd` 提取）对照 OCC 源码；凡移植的值均可在 `cc-diff-113/v2.1.258/claude.strings` 中按偏移复核

## §1 已落地 — Gap-113a：Fable 5.1 模型注册（entry 003 + 092）

官方 2.1.257 发布 Claude Fable 5.1（`claude-fable-5-1`），成为默认 Fable 模型；1M 上下文；$10/$50 per Mtok、$0.25/Mtok 缓存读。

| 文件 | 变更 |
|---|---|
| `src/utils/model/configs.ts` | `CLAUDE_FABLE_5_1_CONFIG`（firstParty/vertex/foundry/gateway/anthropic_aws = `claude-fable-5-1`，bedrock = `us.anthropic.claude-fable-5-1`，mantle = `anthropic.claude-fable-5-1`）+ `fable51` 注册进 `ALL_MODEL_CONFIGS` |
| `src/utils/model/model.ts` | `getDefaultFableModel()`（env override → gateway 保持 fable5，否则 fable51 — entry 092：gateway 未配置 5.1 前继续解析 Fable 5）；`firstPartyNameToCanonical` 增加 mythos-5-1/fable-5-1 分支（**特定分支必须先于宽分支**：`claude-fable-5-1` 含子串 `claude-fable-5`）；`getPublicModelDisplayName` → `Fable 5.1`；`getMarketingNameForModel` fable-5-1 分支（二进制无 Fable 1M 营销名 — 已字节核验） |
| `src/constants/fableIdentity.ts` | 新文件：Fable 身份常量 |
| `src/constants/prompts.ts` | `CLAUDE_LATEST_MODEL_IDS.fable = 'claude-fable-5-1'`；知识截止分支：fable-5-1 → June 2026、fable-5 → January 2026、opus-5 → May 2026（特定先于宽） |
| `src/utils/model/modelOptions.ts` | `/model` 选择器 Fable 5.1 行（官方 `WZe`/`pxe` 文案逐字节移植；`zZe` " · Requires usage credits" 后缀**分级保留**见 §7） |
| `src/utils/modelCost.ts` | 新档位 `COST_TIER_10_50_CACHE_READ_0_25`（10 / 50 / 写 12.5 / 1h 写 20 / 读 0.25 / web 0.01 — 偏移 12961200 字节核验）；`MODEL_COSTS['claude-fable-5-1']` 用新档、`'claude-fable-5'` 用 `COST_TIER_10_50` |
| `src/utils/envUtils.ts` | Vertex 区域表扩至官方 17 项（含 `VERTEX_REGION_CLAUDE_FABLE_5_1`/`FABLE_5`）；有序 `startsWith` 匹配，5-1 先于 5 |
| `src/utils/betas.ts` | `modelSupportsContextManagement` 覆盖 `claude-fable-5` 家族 |
| `src/services/api/errors.ts` + `src/utils/model/validateModel.ts` | 3P fallback 建议文案增加 fable 分支（两处同文） |
| `src/utils/commitAttribution.ts` | `sanitizeModelName` 增加 fable-5-1/fable-5/mythos-5-1/mythos-5 分支 |
| `src/schemas/hooks.ts` | schema 示例模型 id → `claude-sonnet-5` |
| `src/utils/model/modelStrings.ts` | 无需改动：`MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS)` 自动派生 `fable51` |

`isFableModel` 经子串 `'claude-fable-5'` 天然覆盖 5-1，无需改动。

### 自发现漂移修复（§1-d）

Vertex 区域表对照中发现 OCC 旧表与 2.1.257 官方表漂移（opus-4-8 的 env-var 名不一致等），本轮随 Gap-113a 一并拉齐为官方 17 项全表，并加测试锁定 `VERTEX_REGION_CLAUDE_4_8_OPUS`。

## §2 已落地 — Gap-113b：`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`（entry 006）

设置后所有 subagent 强制使用继承的会话模型，忽略 per-spawn 与 agent 定义里的 model 覆盖（官方 `Cbn`/`bpn` 移植）。

| 文件 | 变更 |
|---|---|
| `src/utils/managedEnvConstants.ts` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 加入 provider-managed env 集合（官方 `Tg` 集合，偏移 12579700） |
| `src/utils/model/agent.ts` | `getAgentModel`：FORCE truthy 时 tool-specified 与 agent-definition model 作废，回落父模型；`CLAUDE_CODE_SUBAGENT_MODEL` env 仍然最先（先于 FORCE 判定） |
| `src/tools/WorkflowTool/primitives.ts` | FORCE 时忽略 workflow agent 的 per-agent model opt，`logForDebugging` 文案逐字节移植：`Workflow agent model "..." ignored: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set`（偏移 7904700） |
| `src/tools/AgentTool/AgentTool.tsx` | `inputSchema` 在 FORCE 时 `.omit({ model: true })`（官方 `bpn`：`a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ? n.omit({model:!0}) : n`）；OCC 的 override 文案在字段 `.describe()` 里，omit 后一并消失 — 可观察面等价 |

`lazySchema` 永久记忆、且 `buildTool()` 在构造时即求值 `inputSchema()`（`src/Tool.ts`）→ FORCE 的 schema 测试用独立 `bun -e` 子进程探针验证两个分支（`test/utils/model/version-2.1.257-agenttool-force-schema.test.ts`），与测试运行器/文件顺序无关。

## §3 已落地 — Gap-113c：移除 Ctrl+E 权限解释器（entry 096）

changelog 措辞保守（"Removed the Ctrl+E command explanation"），但**二进制取证显示整个子系统被移除**：2.1.258 ELF 中 `tengu_permission_explainer*`、`confirm:toggleExplanation`、`permissionExplainerEnabled`、`Explanation unavailable`、`explainer_visible` 全部零命中。按完整移除移植：

| 文件 | 变更 |
|---|---|
| `src/components/permissions/PermissionExplanation.tsx` | **删除**（271 行） |
| `src/utils/permissions/permissionExplainer.ts` | **删除**（250 行） |
| `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx` | 移除 explainer state/渲染/footer `ctrl+e` 提示；描述行无条件渲染 |
| `src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx` | 同上 |
| `src/components/permissions/useShellPermissionFeedback.ts` | 移除 `explainerVisible` 参数与 `explainer_visible` 埋点字段（该字段两个官方二进制中都不存在，属 OCC 本地，随 state 一并移除） |
| `src/keybindings/defaultBindings.ts` | 移除 Confirmation 上下文的 `'ctrl+e': 'confirm:toggleExplanation'` |
| `src/keybindings/schema.ts` | 移除 `confirm:toggleExplanation` action |
| `src/utils/config.ts` | 移除 `permissionExplainerEnabled` 类型字段与持久化键 |
| `src/types/permissions.ts` | 移除 `RiskLevel` / `PermissionExplanation` 类型块 |
| `docs/en/permissions.md` | 移除 Ctrl+E 说明行 |

## §4 测试与验证

- 新增 40 个测试：`test/utils/model/version-2.1.257-gap113.test.ts`（38，行为 + 源码级断言）+ `test/utils/model/version-2.1.257-agenttool-force-schema.test.ts`（2，FORCE schema omit）
- 全量门（`scripts/ci-test.sh`，逐文件进程隔离）：**3447 pass / 15 fail / 12 skip**；基线 3407 / 15 / 12 — 增量恰为 +40，15 个失败全部是已知环境性 tmux/model e2e，与基线相同
- `bun run build` 绿：`dist/cli.js` 28.97 MB
- 冒烟绿：`occ --version` → `OCC 2.1.319`；`echo "say PONG" | occ -p` → `PONG`（`unrecognized_model` 日志行为环境网关模型 glm-5.2 的既有噪音）

## §5 OCC 天然 no-op（按设计不追）

| entries | 原因 |
|---|---|
| 097–106（全部 [VSCode]） | OCC 无 VSCode 扩展 |
| 019, 032, 035 | Remote Control — OCC 无此子系统 |
| 002, 095 | 远端/计划会话、Cowork/claude.ai 云会话 — OCC 无 |
| 021, 022, 067, 073(部分), 094 | Claude apps gateway / Console 登录专属 |
| 041 | PROATIVE flag 在 OCC 关闭 → 死路径 |
| 001 | 官方原生打包在 macOS 12 的启动回归；OCC 以 npm/bun 分发，不含受影响产物 |
| 074, 075 | 官方二进制内部渲染性能优化，无可移植面 |

## §6 分级保留 — 安全类（下一轮 P0/P1 候选）

这些修复命中的面在 OCC 是**活路径**，但各需逐点二进制取证，本轮不猜：

- **046** auto 模式下复合命令/子 shell 内的 `permissions.ask` 规则被跳过 — OCC auto mode（TRANSCRIPT_CLASSIFIER）是活的。**P0**
- **054** Bash `Read()`/`Edit()` deny 规则未覆盖 `< file` 重定向与 `tac`/`egrep` 类读取命令。**P0**
- **070** zsh 解析差异的 `[[ ]]` 条件自动放行 — OCC 已有 2.1.221/2.1.223 完整性链 + 活路径补偿守卫（OCC-44/46），需确认 2.1.257 是否有新增残留形态。**P0**
- **052** 非 JSONL 数据灌入 `-p --input-format stream-json` 导致无界内存增长。**P1**
- **051** `.mcp.json` 是 FIFO/设备文件符号链接时 `mcp add/remove` 挂死。**P1**
- **091** 项目 `.claude/settings.json` 的 `defaultMode: "bypassPermissions"` 应被忽略（与 `"auto"` 一致）。**P1**
- **005** auto 模式 Containment Escape 规则（云元数据凭据、出口规避、跨租户）。**P1**
- **082** MCP 连接/OAuth 日志凭据脱敏。**P2**
- **093** `--add-dir` 拒绝网络路径（主要 Windows/UNC 面）。**P2**
- **047** 插件组件符号链接逃逸 — OCC 已裁剪插件系统，需核对自己的 loader。**P2**

## §7 分级保留 — 其余（需逐点取证，不猜）

- **004** `timeFormat`/`timeZone` 设置 — 新设置面，需取 schema + 渲染点
- **007, 085** `/effort` 的 `s`（本会话）与 `--effort` hold 语义变更
- **008** `/doctor` 陈旧 sandbox mask 文件警告
- **009** auto 模式首次越界读提示 + `permissions.blockReadsOutsideWorkingDirectories`
- **010, 088** gateway 模型发现的 `description` 与 ESSENTIAL_TRAFFIC 豁免
- **011** 启动后新建 `.claude/` 的设置热加载
- **012–018, 024, 025, 037, 039, 053, 061, 069, 089** 官方后台会话/daemon 子系统 bugfix — OCC 用自建 daemon supervisor（`occ daemon/agents/attach/logs/stop`），逐点对应关系待核
- **020** 双列自定义 Authorization header 覆盖凭据（Bedrock/Mantle/Vertex/WIF）
- **023** `/schedule` 无 role 提示词 — OCC 无 routines
- **026** OTEL 服务器托管设置热启动 — OCC 无 OTEL/托管设置面
- **027** teammate 权限请求双答（邮箱写锁）
- **028** 斜杠命令面板下的幽灵重复行
- **029, 076, 086** policyHelper 计时钳制/诊断/遮蔽语义 — OCC 策略面裁剪
- **030** 切换 subagent transcript 后 token 计数冻结
- **031** 尾点域名绕过 `deniedDomains`
- **033, 034** 受管 MCP 允许/拒绝列表的 reconnect/enable 与 OAuth 残留
- **036** `allowManagedPermissionRulesOnly` 下 deny 规则在设置重载后丢失
- **038** 全屏模式点不开 `!` shell 输出
- **040** `claude agents --json` raw-mode 残留
- **042** 中断流后 subagent 自动续跑
- **043** `/btw` 面板 `←` 返回
- **044** advisor 模型的后台请求缓存未命中（OCC advisor 面待核）
- **045** `-p` 结束后等待 Monitor — OCC MonitorTool 是活的，需核对退出路径
- **048** `/add-dir` 拒绝工作目录内目录的修复
- **049** 从 transcript 视图停止 subagent 后告知主代理
- **050** 粘贴 ANSI 彩色文本崩溃
- **055** 超过 5 MB 的 transcript resume 失败
- **056** worktree 会话对不碰 git 的复杂 Bash 误拒
- **057** rewind 到空会话后的缓存警告
- **058** 图片超限后长会话每轮缓存未命中
- **059** Edit 权限 diff 的 emoji 宽度
- **060** WebSocket MCP 错误日志 `[object ErrorEvent]`
- **062–065** 后台命令脱离/停止通知/monitor 残留/worktree `.git` 写权限
- **066** Bedrock/Mantle 长思考期静默断流（progress events）
- **068** 云会话代理失败后凭据恢复 — OCC 无云会话
- **071** 受管设置审批提示的遥测措辞
- **072** tmux/iTerm2 teammate 确认后残留
- **077** `/code-review --comment` GitLab `glab` 支持
- **078** 排队通知的延迟对齐
- **079** 异步 hook 完成通知合并一行
- **080** self-hosted-runner git push 协商 — OCC 无此子命令
- **081** SDK 宿主活性上报（keep-alive）
- **083** `/fork` 保留提示缓存
- **084** emoji 短码别名
- **087** `managedSourcesBehavior: "merge"` 的整体取值语义
- **090** `/btw` 历史浏览改键

### Fable 5.1 发布清单中的分级保留项（@[MODEL LAUNCH] 余点）

- `zZe` " · Requires usage credits" 选择器后缀 — 依赖 usage-credits 面（OCC 未启用），分级
- coordinator 模式的 FORCE 文案行 — `COORDINATOR_MODE` flag 关闭 → 死路径，留注释不移植
- structured-outputs 模型允许列表的 fable-5-1 项
- `claudeApiContent.ts` 的 `SKILL_MODEL_VARS` fable 更新
- `advisor.ts` 的 fable 允许列表
- `modelSupports1M` 的 fable 家族缺口（二进制未给出，待下轮取证）
- `sanitizeModelName` 尾部 opus-4/sonnet-4 正则分歧（与本轮无关的既有差异）
- `K9r` 选择器 custom-fable 行渲染

## §8 发版

- 版本：**2.1.320**（OCC 2.1.3xx ↔ 官方 2.1.2xx；2.1.319 ↔ 2.1.252，2.1.320 ↔ 追齐 2.1.258）
- CHANGELOG：`Caught up with upstream Claude Code through 2.1.258` + 三条用户可见变更
- 流程：commit → tag `v2.1.320` → push 触发 `.github/workflows/publish.yml`（build → npm publish → gh release）
