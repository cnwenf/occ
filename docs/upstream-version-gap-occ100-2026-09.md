# OCC-100 严格自验收轮 — 官方 Claude Code 2.1.283 A/B 取证 + OCC-99 三项结转落地（2026-09）

> **轮次性质**：本轮开始时 OCC（v2.1.358 @ main `023ccc1`）与官方追踪版本 **2.1.283** 之间版本 gap 为**零**
> （kickoff 实查：npm `latest` = 2.1.283 / published 2026-09-25，`stable` = 2.1.274，OCC v2.1.358 三件齐落）。
> 按 issue 条款进入**严格自验收**：像人类用户一样用 OCC REPL 跑真实任务（`repl-tmux-e2e-testing` skill），
> 优先复验 2.1.283 轮已落地特性，并对官方 2.1.283 npm 包做 A/B 取证对照。
> 同时领取 OCC-99 验收结转的三项残留（本文件 §2，spec 见 `docs/upstream-version-gap-occ99-2026-09.md` §6）。
>
> 官方取证二进制：`@anthropic-ai/claude-code-linux-x64@2.1.283`（npm registry 原样 `npm pack` 解包），
> md5 `b5afa8208e39db13e13e89449b1825f2` — **与 OCC-99 轮取证基准逐字节同源**（该 md5 即
> `maxTokensRegistry283.test.ts` 头注引用的 ground truth）。仅用于取证对照与受控 A/B 运行，未执行任何来路不明文件。
>
> **轮中官方前进（记录，不在本轮追齐）**：npm `next` 于轮中出现 `2.1.284`，GitHub Release `v2.1.284`
> published `2026-09-28T18:02:03Z`，且轮中 npm `latest` 已提升为 **2.1.284**（`stable` 同步移至 2.1.277）。
> 2.1.284 为实质版本（**Claude Sonnet 5.5 发布**：`claude-sonnet-5-5` 成为 API 默认 Sonnet，1M context，
> $2/$10 每 Mtok；另有 auto-mode "Yes, but ask again next time"、`/mcp reconnect all`、effortSlider keybinding
> actions、gateway 启动警告、约 8 项流式/compact/SDK 修复等 ~17 条 changelog）。
> 按历轮"轮中前进归下一轮"规则（occ44/occ105 先例），**2.1.284 gap 调研 = OCC-101 轮的首要任务**；
> 已知的直接后续：max-tokens 注册表 / `modelSupports1M` / `MODEL_COSTS` / picker 等 Sonnet 5.5 launch 站点。
> 本轮 A/B 全部钉在 2.1.283（round-pinned）。

## 1. 版本事实核查（本轮实查，非转述）

| 项 | 结果 |
|----|------|
| 官方 npm dist-tags（轮初） | `latest` = **2.1.283**（2026-09-25），`stable` = 2.1.274，`next` = 2.1.284 |
| 官方 npm dist-tags（轮末复查） | `latest` = **2.1.284**（轮中提升），`stable` = 2.1.277，`next` = 2.1.284 |
| GitHub Release | `v2.1.283`（2026-09-25T21:50Z）；`v2.1.284`（2026-09-28T18:02Z，轮中落地） |
| OCC 版本 | package.json `2.1.358`，`bun dist/cli.js --version` → `OCC 2.1.358` |
| OCC main HEAD（轮初） | `023ccc1` docs: OCC-99 acceptance carry-over |
| 官方取证 ELF | `claude.exe` 108,529,866 B（tgz），md5 `b5afa8208e39db13e13e89449b1825f2`，`--version` → `2.1.283 (Claude Code)` |

## 2. OCC-99 三项结转 — 全部完成（本轮核心交付）

变更仅 3 个文件，**test-only + comment-only**（零生产行为变更）：

| 文件 | 变更 |
|------|------|
| `test/e2e/version-2.1.283-thinking-only-nudge.e2e.test.ts` | 306 → 660 行：四探针 checked-in wire e2e + byte-exact 全等升级（结转 P2 + P3-②） |
| `src/utils/__tests__/maxTokensRegistry283.test.ts` | +4 断言（fable-5 / sonnet-4-0 / sonnet-4-5 / opus-4-5）+ mythos-5 测试改题（结转 P3-①） |
| `src/utils/context.ts` | 仅注释：mythos-5 死分支的诚实性修正（canonical 映射说明，结转 P3-①） |

### 2.1 P2 — nudge 状态机四探针（wire 层 checked-in，脱离 /tmp 临时脚本）

四探针全部重建为 `version-2.1.283-thinking-only-nudge.e2e.test.ts` 内的 mock-SSE wire e2e
（真实子进程 `bun dist/cli.js -p` + 本地 HTTP 端点记录**每个请求体**）：

- **probe-a（one-shot 仅 next_turn 复位）**：thinking-only → nudge#1 → Read 工具轮成功（`PROBE_A_FILE_OK`
  进入下一请求的 tool_result）→ 第二次 thinking-only → **nudge#2 再次发出**（证明工具轮 next_turn
  复位了 `thinkingOnlyNudged`，query.ts @2044）→ 文本轮收尾；4 请求体逐一断言，nudge 两处全等，
  重试请求不含 thinking 块。
- **probe-b（`stop_sequence` 臂）**：`stop_reason:'stop_sequence'` + `stop_sequence:'\n\n'` 的
  thinking-only 轮同样触发 nudge（条件第二臂），2 请求体 + 全等断言。
- **probe-c（terminal-MCP walk-back guard）**：`CLAUDE_CODE_TERMINAL_MCP_TOOLS=Read` + 真实成功
  Read 轮 + thinking-only → **任何请求体都不得出现 nudge**；随后**负对照**（同转录、env 清除）→
  nudge 恢复发出。依据：OCC 中该 env 仅被 nudge guard 消费（grep 全仓核实）、按工具名匹配，
  故用真实 Read 轮驱动等价于 terminal-MCP 轮（免去 stdio MCP server 的 flaky/重量级）。
- **probe-d（StructuredOutput 排除）**：`-p --json-schema`（SyntheticOutputTool 注册，main.tsx @2204）
  → StructuredOutput 工具轮成功 → thinking-only → **无 nudge**（`isStructuredOutputTurn` guard）。

**变异验证（mutation testing，闭合 OCC-99 §6.1 "测试钉钉缺口"）**——每条 guard 单独删除、全量重建
dist 后跑探针，4/4 全部被对应探针击杀：

| 变异 | 击杀者 |
|------|--------|
| 删除 next_turn 复位（query.ts @2044） | probe-a FAIL ✓ |
| 删除 `stop_reason === 'stop_sequence'` 臂 | probe-b FAIL ✓ |
| 删除 `!isTerminalMcpToolTurn(...)` | probe-c FAIL ✓ |
| 删除 `!isStructuredOutputTurn(...)` | probe-d FAIL ✓ |

变异后源码经 `git checkout` 完整还原并重建 clean dist（本轮末次重建 md5 校验 `src/query.ts` OK）。

### 2.2 P3-① — max-tokens 注册表补钉 + mythos-5 死分支注释修正

- 新增 4 断言：`claude-fable-5`、`claude-sonnet-4-0`、`claude-sonnet-4-5`（不得落入 sonnet-5 tier）、
  `claude-opus-4-5`（**静默回归通道**：`m.includes('opus-4-5')` 是唯一阻止其落入 `opus-4-1||opus-4`
  分支（32000/32000）的子串；OCC-99 变异发现删除后全套件仍绿 → 本轮钉子已咬合，复验：删除该子串
  → 本测试 1 fail）。20 个 canonical id 全覆盖（18 pass / 24 expect）。
- mythos-5 修正：`getCanonicalName` 将 `claude-mythos-5(-1)` 映射为 `claude-fable-5(-1)`
  （`firstPartyNameToCanonical`），故 context.ts 的 mythos-5 分支对 canonical 名**不可达**，官方
  mythos 数值实际由 fable-5 组提供（同 64000/128000）。测试改题为 "via canonical fable-5 mapping —
  NOT the mythos-5 branch"，源码注释同步改写为诚实版本（不再宣称该分支即 mythos 覆盖）。

### 2.3 P3-② — "byte-exact" 注释与断言对齐（wire 层全等）

- 关键 wire 发现：`normalizeMessagesForAPI` 会**合并连续 user 消息** — nudge 重试请求中只有 1 条
  user 消息、多个 text block，nudge 是**最后一个 text block**（逐字节等于 `THINKING_ONLY_NUDGE_TEXT`）。
- 原 `toContain` 子串断言升级为 `lastMessageLastTextBlock(body) === THINKING_ONLY_NUDGE_TEXT` 全等
  （helper 处理 string/数组两种 content 形态并对异常形态返回可诊断哨兵）。注释不再过度承诺。

## 3. 严格自验收覆盖面（全部本轮实测）

### 3.1 2.1.283 轮特性复验 — 全绿

| 套件 | 结果 |
|------|------|
| 283 轮单测 9 文件（keybinding 修饰键校验 misspelledModifier283 / effort CLI flag / system-prompt dual-form merge / promptId header+resolver（`x-claude-code-prompt-id`）/ OTEL `tool.output` ×2 / `claude-ai` 保留命名空间 revert ×2（reservedNamespaces282 + SkillTool permissions）） | **188 pass / 0 fail / 568 expect** |
| 283 轮 e2e 4 文件（effort-cli-flag / model-governance-startup-gate / system-prompt-merge / thinking-only-nudge） | **16 pass / 0 fail / 80 expect** |
| nudge 单测 + 注册表（thinkingOnlyNudge + maxTokensRegistry283） | **35 pass / 0 fail** |
| occ-versioning + commands-alignment | **6 pass / 0 fail** |
| 最终交付态复跑（重建 dist 后：nudge e2e + 注册表 + nudge 单测） | **41 pass / 0 fail / 83 expect** |
| Biome lint（3 个变更文件） | clean |

### 3.2 REPL 真实任务（tmux，按 `repl-tmux-e2e-testing` skill）

- 启动：`tmux new-session -d -x 200 -y 50` + 构建产物 `dist/cli.js --dangerously-skip-permissions`，
  welcome 面板渲染（`OCC v2.1.358`、effort 指示、cwd、auth 双 token 环境警告*）。
- **真实工具任务**："Read the file hello.txt…" → `∴ Thinking…` → `● Read(/tmp/occ-repl-ab/hello.txt)`
  → `⎿ Read 2 lines` → 正确答案 `ZEBRA-42-CONTENT` 渲染（完整 wire 往返：thinking → tool_use →
  tool_result → 最终文本）。
- `/status`：Version 2.1.358 / Session ID / cwd / Model / MCP servers 计数 正常渲染；`/exit` 干净退出
  （session 消失）。
- `repl-interactive.e2e.test.ts` 回归：**2 pass / 1 fail**，唯一失败 = "Shift+Tab auto-mode opt-in
  dialog" — **OCC-44 起 git-stash A/B 核过的既有环境基线失败**（occ105/117/118/119 台账连续记录），
  与本轮 test-only 变更无关。
- \* 环境噪声：本机同时设 `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_API_KEY`（dashscope 代理环境），OCC 的
  双 token 警告与官方行为一致（官方同环境同样打出 unrecognized_model 遥测行）。

### 3.3 全量 src 套件零回归证明（stash A/B）

- 带本轮变更：5812 tests / **69 fail**；`git stash` 后纯净 origin/main 基线：5808 tests / **69 fail**
  （差值 = 本轮新增 4 条注册表断言）。**失败集与本环境（dashscope 代理 + 非识别模型解析 + 双 token）
  绑定，两树完全一致 → 本轮零回归。**

## 4. A/B 取证对照（官方 2.1.283 ELF vs OCC 2.1.358）

| 面 | 结论 |
|----|------|
| `--version` | `2.1.283 (Claude Code)` vs `OCC 2.1.358` — 品牌化差异，by design |
| 顶层 `--help` | 仅品牌 + 已记录 Gap-5 换行布局差异（bundled Commander 布局，occ 台账已deferred） |
| 选项集合 | 官方独有 flag：`--cloud`/`--environment`（occ110/111 分级保留）、`--teleport`（OCC 已注册）、`--restricted`（occ107/108 分级保留）、`--permission-prompts`（occ114 Gap-114a）、`--system-prompt-snapshot`（occ117 §5.5 记录未移植）、`--permission-prompt-tool`（OCC 已注册 hideHelp）— **全部有台账**；**新发现 1 项：`--client-data-url`（§5）**。OCC 独有：`--dangerously-skip-protected-paths`（OCC 加固项） |
| 子命令集合 | OCC 独有 `daemon`/`ssh`（自建 daemon 子系统，by design）；官方独有 `gateway`/`import`/`respawn`/`rm`（occ111 §120、occ125/130/133/134/138 台账分级保留） |
| 叶子 `--help` | `mcp login` / `doctor` / `auth` **字节一致**（仅品牌）；`mcp add` 仅品牌（含示例行）；`mcp --help` = Gap-5 已记录换行差异 |
| 错误处理 | 5 探针（未知 flag / 未知子命令 / `-p` 无输入 / 非法 `--output-format` / `--model` 缺参）**逐字节一致**（含 Commander 报错文案与 allowed-choices 列表） |
| live `-p` | 同一代理环境同一 prompt：双方 `PONG`，rc=0 |
| `-p --output-format json` init 工具集 | 与 OCC-24 台账一致：官方独有 Cron×3/DesignSync/PushNotification/ReportFindings/ScheduleWakeup/SendMessage/ListAgents（KAIROS 休眠，occ101/107/122）；OCC 独有 AskUserQuestion/Enter-ExitPlanMode/browser×4（by design）。**台账漂移观察**：官方 2.1.283 的 `-p` init 已不含 BriefTool/TaskCreate/TaskGet/TaskList/TaskUpdate（OCC-24 清单记录于 2.1.218 时代），且不含 Glob/Grep/TaskOutput（OCC 保留为超集，非回归） |

## 5. 本轮新发现 gap（记录 + 分级判定：**staged，不在本轮移植**）— `--client-data-url`

**取证**（官方 2.1.283 ELF strings + 受控运行，未发明任何行为）：

- help 文案（verbatim）：`URL for a signed configuration document. Claude Code exits if it cannot load it or it does not cover the selected model. Setting CLAUDE_CODE_CLIENT_DATA_URL instead keeps the URL out of the process list`
- 运行语义：`--client-data-url http://127.0.0.1:9/x -p hi` → 拒绝启动，报错（verbatim）：
  `Error: --client-data-url: the URL must be the https://downloads.claude.ai/ address Anthropic gave you, exactly as given. Claude Code does not start without the configuration it was given; to start without it, remove the flag, or remove CLAUDE_CODE_CLIENT_DATA_URL from your environment or settings.`
  → **host 硬钉 `https://downloads.claude.ai/`**，加载失败/未覆盖所选模型 = 硬退出（exit 1）。
- env 等价物 `CLAUDE_CODE_CLIENT_DATA_URL`（ELF 10 处字符串）；flag 在官方"转发给子代理/会话"的
  flag 集合内（与 `--settings`/`--system-prompt` 等同列）；cloud session 下不生效（"a cloud session
  loads its own configuration"）。
- 消费端：签名配置文档即 clientData 通道 — OCC 已有消费端（`src/services/api/bootstrap.ts` 拉取并
  持久化 `clientDataCache`；`src/utils/context.ts` 的 `coral_reef_sonnet`/`loud_sugary_rock` 门控读它），
  缺的是**签名 URL 装载端**（flag/env/host 校验/覆盖校验/硬退出语义/转发集合）。

**判定：staged（记录不移植）**。理由：(a) 企业专用面 — 文档只能由 Anthropic 企业渠道签发，OCC 无法
获得合法文档，host 硬钉 downloads.claude.ai 使 mock e2e 结构性不可行（改 host 校验即不忠实）；
(b) 忠实移植需完整反编译文档 schema/覆盖校验/遥测链路，无法验证的移植违反
`aligning-with-official-binary`"Never invent"纪律；(c) 与既有先例一致（`--system-prompt-snapshot`
occ117 §5.5 记录未移植、`--cloud`/`--environment`/`--restricted` 分级保留）。**建议**：后续轮次若
企业治理面成为优先级，做专项反编译轮（含 `Error: --client-data-url: ` 前缀全错误分支表）。

## 6. 结论

- OCC-99 三项结转：**3/3 完成**，含 4/4 变异击杀 + opus-4-5 钉子咬合复验。
- 严格自验收：2.1.283 轮特性 8 项全绿；REPL 真实任务通过；全量套件 stash A/B 证明**零回归**。
- A/B 对照：CLI 面/错误处理/叶子 help/live `-p` 与官方一致；全部差异均有既有台账，**新发现 1 项
  （`--client-data-url`）已取证记录并分级 staged**（§5）。
- 轮中官方前进至 **2.1.284**（Sonnet 5.5 launch，实质版本）→ **OCC-101 轮 gap 调研首要任务**。
- 本轮代码变更：3 文件（test-only + comment-only），已合入 main；发布（2.1.359 候选）按流程
  gated on 验收员通过。

## 7. 交接

→ **OCC 安全审核员**（后门审查：本轮 diff 极小且 test/comment-only，重点可查四探针 e2e 是否引入
外部可执行面 — 结论：仅本地 mock HTTP + 构建产物子进程，无网络外联、无新依赖）
→ **OCC 验收员**（功能对齐体验 + main 合入 + 残留分支清理）
→ **OCC Leader**（lark 汇报 + issue 翻 done；发版通知在验收通过后另行触发）。
