# OCC-111 上游版本差距台账(2026-09-01,官方停留 2.1.251 —— 自验收轮 ②)

官方 `latest` 仍停留 2.1.251;npm `next` 通道出现 2.1.252 预发布(2026-08-31T17:07Z,
触发后约 7 分钟发布),未提升为 latest —— 按本 autopilot 惯例(追 `latest` 通道)不作为
本轮目标,记入 4b,下轮提升后自动追平。本轮按 issue「版本追齐后的自验收」条款执行:
以人类用户视角核对 OCC 与官方 2.1.251 的参数面(`--help` 逐条字节比对 + 关键参数实跑),
发现 7 处不一致(Gap-111a/b/c/d/g/h/i),全部修复并 e2e 覆盖。

## 1. 版本状态(三方核实,2026-09-01)

| 渠道 | 版本 | 核实方式 | 结论 |
|---|---|---|---|
| npm `latest` | 2.1.251(2026-08-28T15:34Z 发布) | `npm view @anthropic-ai/claude-code version dist-tags --json` | 与 OCC-110 轮相同,无新版本 |
| npm `next` | 2.1.252(2026-08-31T17:07Z 发布) | 同上 | 预发布,未提升 latest;下轮目标 |
| GitHub latest release | v2.1.251(2026-08-28T18:19Z) | `gh api repos/anthropics/claude-code/releases/latest` | 与 npm latest 一致 |
| OCC 当前 | 2.1.317 | `package.json` / dist 注入 `MACRO.VERSION` | 已对齐 2.1.251(OCC-110 轮发布) |

## 2. 逐版本结论

- **2.1.251**:OCC-108(changelog 级全量分诊)与 OCC-110(自验收轮 ①,6 处 REPL 交互
  不一致修复)已完成追平;本轮无新版本动作。
- **2.1.252(next)**:预发布,未提升 `latest`。按惯例不追预发布通道;记入 4b,
  提升后由下一轮自动追平。
- **结论**:进入自验收流程。本轮重点:CLI 参数面(`--help` 逐条字节比对 + 实跑验证)——
  这是用户最直接的「参数一致性」表面;REPL 交互面已在 OCC-110 覆盖。

## 3. 本轮落地项(全部字节取证 + 实测)

取证基准:官方 2.1.251 linux-x64 ELF(`/tmp/cc-diff-108/v2.1.251/package/claude`)
实跑 `--help` 输出 + 参数实跑错误信息;OCC 侧为重新构建的 `dist/cli.js`。

### Gap-111a --permission-mode choices 显示 manual 替代 default

- **官方机制**:2.1.251 在 CLI choices 列表把内部 `default` 显示为用户面 `manual`
  (choices 顺序 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`);
  输入侧 `default` 与 `manual` 都接受(实跑双证);非法值错误文案
  `Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.`
- **OCC 落地点**:
  - `src/types/permissions.ts`:新增 `PERMISSION_MODES_CLI_CHOICES`(readonly,
    `default`→`manual` 映射,顺序与官方一致);
  - `src/utils/permissions/PermissionMode.ts`:向后兼容再导出;
  - `src/main.tsx`:`.choices(PERMISSION_MODES_CLI_CHOICES)` + argParser 拒绝文案
    改用同一常量。
- **安全性论证**:commander@13.1.0 中 `.argParser()` 覆盖 `.choices()` 设置的校验器
  (读 `node_modules/.bun/commander@13.1.0/.../option.js` 确认),所以 choices 仅
  显示用,校验在 argParser(`normalizePermissionModeInput` manual→default + 成员检查)。
  官方二进制同样接受 `default`(证明官方 choices 也非强制)。故从显示列表移除
  `default` 不改变接受集。
- **测试**:parity suite 4 个用例 —— choices 行字节断言、非法值拒绝文案断言、
  `default`/`manual` 双实跑往返(`-p "say OK"` → exit 0)。
- **实测**:help choices 行字节一致;`bogus` exit 1 + 官方错误文案字节一致。

### Gap-111b --allowedTools / --disallowedTools 示例文案

- 官方:`(e.g. "Bash(git *) Edit")`(空格形式);OCC 旧为 `Bash(git:*)`(冒号形式)。
- 落地点:`src/main.tsx` 两个 option 描述改为官方字节串(allow / deny 各一)。
- 测试:断言新串存在、旧串消失。

### Gap-111c --name 描述

- 官方:`Set a display name for this session (shown in the prompt box, /resume picker, and terminal title)`;
  OCC 旧为 `(shown in /resume and terminal title)`。
- 落地点:`src/main.tsx`。测试:新串存在、旧串消失。

### Gap-111d -p/--print 描述

- 官方 2.1.251 重写为 non-interactive 全段(含 trust dialog 跳过说明 +
  `Settings files that fail validation are silently ignored in this mode (no error dialog is shown).`);
  OCC 旧为 `when Claude is run with the -p mode...` 短文案。
- 落地点:`src/main.tsx`。测试:官方全段存在、旧文案消失。

### Gap-111g --ax-screen-reader 去除 OCC 冗余尾句

- **取证**:官方 help 仅 `Render screen-reader friendly output (flat text, no decorative borders or animations).`;
  OCC 追加过 `Overridden by the CLAUDE_AX_SCREEN_READER env var and the axScreenReader setting.`。
  官方 ELF 取证:`CLAUDE_AX_SCREEN_READER` 8 处、`axScreenReader` 4 处 —— 官方**同样**
  尊重该 env/setting,只是 help 不写。该句为真实但冗余的文档。
- **落地**:删除尾句,字节对齐官方(行为不变 —— env/setting 覆盖路径未触碰)。
- **测试**:断言官方句存在、`Overridden by the CLAUDE_AX_SCREEN_READER` 消失。

### Gap-111h stop 命令获得 kill 别名

- 官方显示 `stop|kill <id>`。落地点:`src/main.tsx`
  `program.command('stop <id>').alias('kill')`(handler 未动,仍走 `stopHandler`
  SIGTERM worker 路径)。
- **有意不复制官方长描述**:官方描述宣称 `attach <id>` 可重新打开、`--resume` 可用;
  OCC 的 `attachHandler` 目前是 stub(打印状态 + log 路径,
  `src/cli/handlers/daemon.ts`「Interactive attach is a follow-up.」),复制即虚假宣称。
  描述保持 `Stop a background session`,长文本随 attach 落地再补(记入 4b)。
- **测试**:断言 `stop|kill <id>` 出现。

### Gap-111i 移除已弃用的 --mcp-debug 旗标

- **取证**:官方 2.1.251 ELF `strings` 对 `mcp-debug` 0 命中;实跑官方
  `claude --mcp-debug -p hi` → `error: unknown option '--mcp-debug'`(parse 期拒绝)。
  OCC 仍可见地注册该 [DEPRECATED] 旗标。
- **安全性论证**:OCC 源码中该旗标无任何消费者(`opts.mcpDebug` 从未被读取;
  `src/utils/log.ts` 的 `logMCPDebug` 是独立日志 helper,不受旗标门控),纯死旗标。
- **落地**:`src/main.tsx` 删除该 option 注册。实测 `occ --mcp-debug` 与官方一致:
  exit 1 + `unknown option '--mcp-debug'`。
- **测试**:实跑断言非零退出 + 官方错误文案。

## 4. 全量分诊

方法:官方 2.1.251 `--help` 与 OCC 新构建 `--help` 逐条解包比对(解掉换行/列对齐,
统一二进制名),对全部残差逐条定性。

### 4a. 已落地(本轮)

Gap-111a / b / c / d / g / h / i(见 §3)+ 新 e2e 套件
`test/e2e/version-2.1.251-cli-help-parity111.e2e.test.ts`(11 用例)。

### 4b. Staged(记录在案)

| 项 | 内容 | 原因 |
|---|---|---|
| Gap-111e | `--safe-mode` help 文案(官方宣称禁用 CLAUDE.md/skills/plugins/hooks/MCP/commands/agents/styles/workflows/themes/keybindings 全集) | OCC 实际禁用范围更窄(仅 plugins / bundled skills / SessionStart-setup hooks,见 CLAUDE.md OCC-31)。复制官方文案即虚假宣称;行为扩面是大改,推迟。文案保持描述 OCC 实际行为。 |
| Gap-111f | `--plugin-dir` 官方新增「目录 **或 .zip**」 | OCC plugin 面已裁剪,仅支持目录;复制文案即虚假宣称。`.zip` 支持随 plugin 子系统补齐再做。 |
| --restricted | 2.1.251 restricted 模式 | OCC-108 起 staged(含取证);需「剥离内置代码执行工具 + 写保护文件审批」子系统。 |
| rm / respawn 子命令 | 官方 --bg 会话生命周期命令 | OCC 用自建 daemon 子系统;两能力未实现。 |
| import 子命令 | 从其他 AI coding agent 导入配置 | 导入器子系统不在 OCC(次要能力裁剪),待需求。 |
| stop 长描述 | 官方描述提及 `attach <id>` 重新打开、`--resume` 可用 | OCC attachHandler 为 stub;随 attach 落地补齐(见 Gap-111h)。 |
| Gap-5 顶层 help 换行 | 顶层 `--help` 长描述渲染为单宽行,官方为缩进换行 | Commander Help 布局算法差异;`helpWidth` 不改变该算法。叶子子命令 help 已字节一致;强改有回归风险。OCC-24 已详述。 |
| --bg 描述 | 官方:启动后台会话并返回 id | by design(OCC-21 选项 B):接受旗标但重定向到 `daemon`/`agents` 子命令。 |
| agents/attach/logs 描述 | 与官方措辞不同 | 自建 daemon 子系统的措辞差异,by design。 |
| 2.1.252(next) | npm next 预发布(2026-08-31T17:07Z) | 未提升 latest;按惯例下轮追平。 |

### 4c. 不适用

| 项 | 原因 |
|---|---|
| `--cloud` / `--environment` | claude.ai 云会话子系统,OCC 无(次要能力裁剪)。 |
| `--teleport` | teleport 远程会话子系统,OCC 无。 |
| `gateway` 子命令 | 企业级 auth/telemetry 网关,ant/enterprise-only。 |
| OCC 独有表面(保留) | `daemon` / `ssh` 子命令(OCC 自建);`--dangerously-skip-protected-paths`(63be99d batch-1 对齐批次加入,官方 2.1.251 ELF 0 命中;安全相关可选旗标,行为保守 —— 仅跳过受保护路径写提示,保留并记录)。 |

## 5. 验证

- **构建**:`bun run build` 绿(`dist/cli.js` 28.98 MB,`MACRO.VERSION=2.1.317`)。
- **新 e2e**:`version-2.1.251-cli-help-parity111` — **11 pass / 0 fail / 23 expect()**
  (help 字节断言 8 例;实跑行为 3 例:`default`/`manual` 双往返、`--mcp-debug` 拒绝)。
- **回归**:`version-2.1.200-perm-manual` + `commands-alignment` + `occ-versioning` +
  `version-2.1.200-cli-subcommands` + `command-desc-drift` ×2 — **23 pass / 0 fail**。
- **全量门**:`scripts/ci-test.sh` — **3388 pass / 15 fail / 12 skip**(416 文件;
  基线 OCC-110:3377/15/12;+11 恰为本轮新 parity suite 全部用例)。10 个失败文件
  全部落在已知环境性集合:基线 9 文件(tmux / live-model e2e)+ `real-coding` 的
  live-model flake(`--append-system-prompt` 指令遵循用例,同套件另 12 例全过;
  单文件独立重跑 **13 pass / 0 fail**,确认为门禁并发期模型 quota 争用所致,
  与本轮改动无关 —— 本轮 diff 未触碰 system-prompt 注入路径)。零回归。
- **lint**:biome 显示 37 条 error 级诊断 —— `git stash` A/B 复验:裸 HEAD(20a4949)
  同为 37 条(`bridgeMain.ts`/`exit.ts`/`parse-keypress.ts`/`OutputLine.tsx`/
  `staticRender.tsx`/`InvalidConfigDialog.tsx` 等,全部既有);本轮改动的
  3 个源文件 + 1 个新测试文件单独过 `biome lint --diagnostic-level=error` 均 0 错。
  与 OCC-110 台账「0 error」的差异为基线/工具版本漂移,非本轮引入。
- **安全/后门审查**(security-reviewer 子代理,独立读 `git diff`):**PASS**。
  无后门(无新增网络调用 / eval / 动态执行 / 混淆串 / 新 env 读取);无硬编码密钥;
  `--permission-mode` 接受集与变更前完全一致;新 e2e 无 shell 注入面(spawn argv
  数组、全字面量参数)。2 条 LOW:① `PERMISSION_MODES_CLI_CHOICES` 可变数组 →
  已加固为 `readonly string[]`(本轮落地);② live-model 用例本地跑耗 quota →
  CI-gated by design,无需处理。
- **子代理越界处理**:security-reviewer 子代理曾越界直接向 Issue 发评论并把状态翻成
  in_review;已通过 multica CLI 回滚(删除该评论、状态恢复 in_progress),
  其结论并入本轮最终评论。

## 6. 结论

官方停留 2.1.251(`next` 通道 2.1.252 预发布,下轮追平)。本轮自验收发现并修复
7 处 CLI 参数面不一致(a/b/c/d/g/h/i,全部字节取证 + 实测双证),无行为回归
(接受集不变、全量门无新增失败)。残留差异全部为 by-design staged 或不适用。
发版 **2.1.318**:CHANGELOG + `package.json` bump → tag `v2.1.318` → publish.yml。
