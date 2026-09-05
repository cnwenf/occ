# OCC-116 — 版本追齐 2.1.260 → 2.1.261（gap 调研 + 对齐）

- **日期**：2026-09-06（autopilot 触发）
- **官方最新版**：`2.1.261`（npm `@anthropic-ai/claude-code` latest；三方核验：npm dist-tags + GitHub release + 官方 tgz 下载）
- **OCC 对齐点（本轮开始时）**：`2.1.260`（OCC 2.1.322）
- **取证材料**：`/tmp/cc-diff-116/`（官方 2.1.261 linux-x64 tgz 解包 `p261/`、`v261.strings`/`v260.strings` 全量 strings dump、`added.txt`/`removed.txt` 排序 diff、`entries-116.txt` 67 条 changelog 条目）。所有移植值均按 `aligning-with-official-binary` 纪律逐字节核验，未发明任何值。
- **本轮结论**：67 条 changelog 全量 triage —— **落地 3 条**（040 + 002 + 009，其中 009 经由 040 的新 backspace 路径一并修复），**分级保留 21 条**，**天然 no-op 43 条**。

---

## §1 已落地 — Gap-116a：`keybindingFlavor` 弃用（entry 040，连带 entry 009）

官方 2.1.261 entry 040：*"Changed the prompt's word-editing keys to match Bash: Ctrl+W deletes back to whitespace, Alt+F and Alt+D stop at word end, punctuation separates words; `keybindingFlavor` no longer has any effect."*

v261 二进制取证：classic（Segmenter 分词）路径的 Cursor 方法在 2.1.261 中**已整体删除**（`removed.txt` 交叉验证）；word 编辑只剩 Bash/readline 单位一套实现；settings schema 中 `keybindingFlavor` 键保留但 `.describe()` 改为弃用文案（旧 settings.json 解析兼容，值不再生效）。

**entry 009 连带修复**（*"Fixed being unable to delete the character immediately before an inline `[Image #N]` chip"*）：官方经由 040 的新 `backspace()` 实现落地 —— `backspace() = left().modifyText(this)`，而 `left()` 在 chip 末尾会整体跳到 chip 起点，因此普通退格即可原子删除整个 chip，无需 chip 感知的 word 移动方法。

### 逐文件表

| 文件 | 变更 |
|---|---|
| `src/utils/Cursor.ts` | 删除 classic 分词方法 `nextWord`/`prevWord`/`deleteWordBefore`/`deleteTokenBefore`/`deleteWordAfter`（上游已删）；`backspace()` 改为 `left().modifyText(this)`（entry 009 修复路径）；保留 `endOfWord`、vim word 方法（`nextVimWord`/`prevVimWord`，OCC vim 模式实装）、chip 跳跃的 `left`/`right`、`killRange`、readline 系（`forwardWord`/`backwardWord`/`killWord`/`backwardKillWord`/`deleteWORDBefore`/`prevWORD`/`nextWORD`/`endOfWORD`） |
| `src/utils/keybindingFlavor.ts` | **删除**（上游 flavor 分派层已不存在） |
| `src/utils/__tests__/keybindingFlavor.test.ts` | **删除** |
| `src/hooks/useTextInput.ts` | 去 flavor 化：word 编辑键一律走 readline 单位（官方 2.1.261 行为） |
| `src/hooks/useSearchInput.ts` | 同上 |
| `src/utils/settings/types.ts` | `keybindingFlavor` schema 键保留（解析兼容），`.describe()` 换成官方弃用文案 |
| `src/utils/settings/__tests__/keybindingFlavor.test.ts` | 改为解析兼容测试：旧值仍可解析、不再影响行为 |
| `src/utils/__tests__/cursor-version-2.1.239.test.ts` | §4 重写为 "word editing is always readline (2.1.261)"；entry-009 backspace describe 替换旧 chip-aware word 移动测试 |
| `src/utils/__tests__/cursor-deleteWORDBefore.test.ts` | 对齐删除后的方法集 |
| `test/e2e/version-2.1.238-keybinding-flavor.e2e.test.ts` | **删除**（flavor 行为面已不存在） |
| `test/e2e/version-2.1.239-keybinding-flavor.e2e.test.ts` | 重做：Alt+D 恒为 readline（显式 `keybindingFlavor: "classic"` 也被忽略）；chip 测试改为 readline `deleteWORDBefore` → `killRange` 吸附路径 |
| `test/e2e/version-2.1.261-keybinding-flavor-deprecated.e2e.test.ts` | **新增**：tmux REPL 实测 —— 默认 home 与 seeded `keybindingFlavor: "classic"` home 中 Ctrl+W 行为一致（whitespace 分词），设置被忽略 |

## §2 已落地 — Gap-116b：`bashOutputMaxChars` / `taskOutputMaxChars` 设置（entry 002）

官方 2.1.261 entry 002：新增两个设置项，控制命令 / 后台任务输出在存盘前内联给模型的字符上限（最高 128K）。

v261 二进制逐字节核验的官方形状：

- clamp：`ree(e)`，界 `Asr=4000` / `lge=128000`
- **settings-only 档**（喂 tool spec）：
  - Bash/PowerShell spec `get maxResultSizeChars(){return OBt()}`，`OBt(){return ree(ze().bashOutputMaxChars)??MBt}`，`MBt=30000`，env cap `fun=150000`
  - TaskOutput spec `CWn`：`get maxResultSizeChars(){return Kut()+TWn}`，`Kut(){return ree(ze().taskOutputMaxChars)??q8e}`，`q8e=32000`，`TWn=eN-q8e=50000-32000=18000`（TaskOutput 默认由此前静态 `1e5` 变为 50000）
- **settings-first + env fallback 档**（运行时截断窗口）：
  - `pHe`：over `BASH_MAX_OUTPUT_LENGTH`（cap 150000，default 30000）
  - `eVo`：over `TASK_MAX_OUTPUT_LENGTH`（cap `Rmn=160000`，default `q8e=32000`）

### 逐文件表

| 文件 | 变更 |
|---|---|
| `src/utils/settings/types.ts` | 新增 `bashOutputMaxChars` / `taskOutputMaxChars` zod 字段（`z.number().int().positive().optional().catch(undefined)` + 官方 `.describe()` 文案），插在 `defaultShell` 与 `respondToBashCommands` 之间（与官方 schema 键序一致） |
| `src/utils/shell/outputLimits.ts` | 重写：`BASH_MAX_OUTPUT_UPPER_LIMIT=150_000`、`BASH_MAX_OUTPUT_DEFAULT=30_000`、`OUTPUT_CHARS_MIN=4_000`、`OUTPUT_CHARS_MAX=128_000`、`clampOutputChars()`（官方 `ree`）、`getBashOutputMaxChars()`（官方 `OBt`，settings-only）、`getMaxOutputLength()`（官方 `pHe`，settings-first + env fallback） |
| `src/utils/task/outputFormatting.ts` | `TASK_MAX_OUTPUT_UPPER_LIMIT=160_000`、`TASK_MAX_OUTPUT_DEFAULT=32_000`、`TASK_OUTPUT_INLINE_HEADROOM=18_000`（官方 `TWn`）、`getTaskOutputMaxChars()`（官方 `Kut`）、`getMaxTaskOutputLength()`（官方 `eVo`）；`formatTaskOutput` 不动（既有文档化分歧） |
| `src/tools/BashTool/BashTool.tsx` | spec `maxResultSizeChars` 接官方 `OBt()`（live getter，见下） |
| `src/tools/PowerShellTool/PowerShellTool.tsx` | 同 Bash（官方 PowerShell spec 同用 `OBt()`） |
| `src/tools/TaskOutputTool/TaskOutputTool.tsx` | spec `maxResultSizeChars` 接官方 `Kut()+TWn`（live getter） |
| `src/utils/shell/__tests__/outputLimits261.test.ts` | **新增**：clamp 边界、两档 accessor 语义（settings-only vs settings-first+env）、BashTool spec live-getter 确定性断言 |
| `src/utils/task/__tests__/outputFormatting261.test.ts` | **新增**：同上（task 侧）+ 官方常量核验 + TaskOutputTool spec wiring |

消费端核验（未改，签名兼容）：`BashTool/utils.ts:148`、`PowerShellTool/prompt.ts:125`、`TaskOutput.ts:303`、`query.ts:432`、`toolResultStorage.ts:224`、`toolExecution.ts:1394`、`Doctor.tsx`。

### 关键实现发现：buildTool getter 展平 + TDZ 导入环（live-getter 模式）

`buildTool`（`src/Tool.ts:833-840`）以 `{...TOOL_DEFAULTS, ...def}` 展平 spec —— **spread 在模块加载时调用 def 上的 getter 一次**。而 `TaskOutputTool.tsx` ↔ `outputFormatting.ts` ↔ `diskOutput.ts` 之间存在导入环：从 `outputFormatting` 一侧进入环时，`TaskOutputTool` 模块体在其 const（`TASK_MAX_OUTPUT_DEFAULT` 等）尚处 TDZ 时执行，加载期 getter 调用直接 `ReferenceError: Cannot access 'TASK_MAX_OUTPUT_DEFAULT' before initialization`（实测复现：`bun -e "await import('./src/utils/task/outputFormatting.ts')"` 崩溃）。

修复（三个工具统一）：def getter 返回**本文件局部默认常量**（无跨模块加载期调用），buildTool 语句之后立即
`Object.defineProperty(<Tool>, 'maxResultSizeChars', { get: () => <官方 live 表达式>, enumerable: true, configurable: true })`
—— 装上**每次访问都重读 settings 的 live getter**，与官方 `OBt()`/`Kut()+TWn` 的 per-access 语义完全一致（同时消除了此前"加载期冻结"的既有分歧，spec-wiring 测试也因此可做确定性 seeded 断言）。修复后三种导入顺序探针全绿。

### 测试基建修复：`anthropicDefaultModel236` 的 mock.module 恢复失效（全量套件污染）

全量 `bun test src` 中本文件 seeded 测试失败、目录级单跑全绿 —— A/B 二分定位为 `src/utils/model/__tests__/anthropicDefaultModel236.test.ts`：Bun 的 `mock.module()` 会**就地改写已导入的 namespace 对象**（探针实证 `ns===ns2` 且导出函数被替换），该文件在 afterAll 里 `{...actualSettingsModule}` "恢复"时展开的是**已被 mock 改写的** namespace，等于把 mock 闭包（`getInitialSettings: () => mockedSettings`，冻结在最后一个测试的 `{model:'claude-sonnet-5'}`）永久重装给同 worker 后续所有文件。修复：在装 mock **之前**快照 `{...ns}`，afterAll 用快照恢复（探针实证恢复后取回原函数）。这是既有 OCC-97 泄漏类的一个新变种，修复惠及全仓测试。

## §3 分级保留（需逐点二进制取证，本轮不做 —— STOP per skill，不猜）

| entry | 内容 | 保留原因 |
|---|---|---|
| **035** | dangerous-`rm` 安全提示扩展：捕获位置参数上的 `rm -rf` 与双引号 `sh -c` 脚本内的形态 | **下一轮 P0**。官方为 ~6KB 新子系统（v260 二进制 0 处痕迹，v261 新增）：region 20101800-20108200，函数 `cpo`/`upo`/`Stt`/`dpo`/`fpo`/`ppo`/`mpo`/`gpo`/`hpo`/`ypo`/`aRe`/`Qcn`/`Ctt`/`Jcn`/`wtt`/`_po`/`bpo`/`xtt`/`Zcn`/`kpo`，调用点 20199146 + 20200781。安全类 + 体量需整轮专门移植 |
| 003 | `--append-subagent-system-prompt-file` | 新 CLI flag，解析/合并语义需逐点取证 |
| 004 | `/skill-doctor` 新命令 | 命令输出面较大，需整块反编译 |
| 006 | `/add-dir` /net automount 误报 | 路径解析 niche 修复，需取证官方 resolve 逻辑 |
| 036 | 无响应头时重试等待改为 `API_TIMEOUT_MS` | 传输层重试计时，需逐点取证 |
| 039 | auto mode：公共 diagram renderer URL 视为上传 | 分类器规则变更，需取证官方规则表 |
| 041 | `/context` token 计数本地估算 fallback | 估算逻辑需反编译 |
| 005 | 快速输入/按键重复时字符乱序丢失 | 时序敏感的 Ink 输入路径，需专门复现环境 |
| 007 | Bedrock setup wizard 超时/TLS 代理 | Bedrock 向导面，需逐点取证 |
| 010 | resume 丢失并行 tool call 周边的 hook 输出 | resume 请求构造变更，需取证 |
| 013 | 首个 prompt 后的 Stop/interrupt 被忽略 | SDK 半侧适用（cloud 半侧 no-op），需取证 |
| 019 | 后台 agent 无法 resume 时紧循环高 CPU | OCC daemon supervisor 结构不同，需对照取证 |
| 020 | feature flag 按版本门控串版本 | 需取证官方版本门控表 |
| 022 | `-p --resume <file>` 采纳畸形 session ID | 需取证官方校验点 |
| 023 | 终端进度指示器（iTerm2/Ghostty/ConEmu）后台任务误报完成 | 需取证 |
| 024 | row/column 切换后 box 高度布局 glitch | Ink 内部布局，需专门复现 |
| 030 | 后台 Bash 中 plugin install hint 检测 + `<claude-code-hint>` 泄漏 | OCC plugin 面为裁剪实装，需对照 |
| 031 | agent-team 队友二轮重发公告破坏 prompt cache | 需取证请求前缀构造 |
| 032 | `/model` picker 显示 Bedrock/Vertex/gateway ID 的友好名 | 需取证官方名称映射表 |
| 034 | 流式渲染已渲染 block 不再重复 layout | Ink 性能路径，需专门取证 |

## §4 OCC 天然 no-op（对应面为 stub/删除/OCC 未实装，按设计不追）

- **001**（org policy 加载失败原因行）：OCC 无 org-policy 端点加载路径（stub），无可解释对象
- **008**（cloud session plugin 同步回退）：OCC 无 cloud sessions
- **011/012/014/015/016**（Remote Control 系列）：OCC 的 Remote Control 面为 stub（`feature()` 未开）
- **017**（`gcpAuthRefresh` 启动开浏览器）：OCC 无该启动刷新流程
- **018**（claude.ai connector 启动超时重试）：OCC connector 面简化（MCP OAuth simplified）
- **021**（`/usage` 周限额行）：OCC 未接官方 usage endpoint
- **025/026**（Claude apps gateway XFF/OTel）：gateway 服务端行为，CLI 侧无可移植面
- **027**（Desktop/web artifact watch busy 态）：OCC 无 Desktop 面
- **028**（Chrome `file_upload` Cowork）：OCC 无 Cowork/Chrome 扩展面
- **029**（SendMessage 离线 Remote Control 投递语义）：依赖 Remote Control 实面
- **033**（Vertex 启动不再重复 project discovery/gcloud）：OCC Vertex 客户端创建无该重复发现行为
- **037/038**（gateway 403 文案 / `forceLoginMethod: "gateway"`）：gateway 登录面 OCC 未实装
- **042–067**（26 条 [VSCode]）：OCC 无 VSCode 扩展，全部 no-op

## §5 测试与验证

- **新增/改造单测**：`outputLimits261.test.ts`（新）、`outputFormatting261.test.ts`（新）、`cursor-version-2.1.239.test.ts`（§4 重写）、`cursor-deleteWORDBefore.test.ts`、`settings/__tests__/keybindingFlavor.test.ts`（解析兼容）—— 目标集 **83 pass / 0 fail / 171 expect()**
- **全量 `bun test src`**：**2486 pass / 1 skip / 31 fail**。git-stash A/B：31 fail 与未含本轮改动的 baseline **逐条相同**（既有环境类失败：drain-guard-247 ×6、unknownCommandParity251 ×4、frontend-design-tip ×4、registerMainThreadAgentHooks ×3、sandbox-ripgrep-232 ×3、autoMode-#20 ×3、isAgentHooksOriginTrusted ×2、needs-auth-#20 ×2、agent-spawn-telemetry ×2、2.1.216-telemetry ×1、read-side-errno ×1）—— **本轮改动零回归，净增 23 pass**
- **TDZ 探针**：`outputFormatting`-first / `PowerShellTool`-first / `outputLimits`-first 三种导入顺序全部 OK；`PowerShellTool.maxResultSizeChars` = 30000（无 seed）
- **构建**：`bun run build` 绿，`dist/cli.js` 28.97 MB
- **e2e**：见 §7（发版前实测记录）

## §6 安全审查记录（全 diff）

- 全 diff 无硬编码 secret/token/API key；新增测试仅写 tmp 目录 settings.json（seed 值均为普通数字/字符串）
- 新增设置字段走 zod `.catch(undefined)`：非法值静默回退默认，不会把异常输入带进截断窗口计算
- clamp（4000–128000）双档一致，杜绝 0/负数/超大值造成的输出截断绕过或内存放大
- `Object.defineProperty` live getter 仅作用于工具 spec 数值属性，不引入任何执行面
- Cursor 方法删除面：全仓 grep 无残留调用点（`nextWord|prevWord|deleteWordBefore|deleteTokenBefore|deleteWordAfter` 0 hits）
- entry 035（dangerous-rm 强化）为官方安全类改进，已列下一轮 P0 —— 本轮 OCC 既有 rm 防护不弱于 2.1.260 对齐点，无回退

## §7 发版

- OCC 版本：`2.1.322` → **`2.1.323`**（对应官方 `2.1.260` → `2.1.261`）
- 流程（固化）：合入 main → bump `package.json` + `CHANGELOG.md` → tag `v2.1.323` → push 触发 `.github/workflows/publish.yml`（build → set version → npm publish → `gh release create`）→ 核验 `/releases` 数 == `/tags` 数且 `comm -23` 差集为空 → 在 issue 上回报 /releases 总数 + Release 链接
- e2e/REPL 实测记录：见 issue 最终结果评论
