# OCC-110 上游版本差距台账(2026-08-31,官方停留 2.1.251 —— 自验收轮)

本轮是定时任务「OCC版本追齐官方Claude Code」在官方未发新版时的**自验收轮**:
像真实用户一样在 OCC REPL 里干活,优先盘点最近几轮新增功能,其次核心主干;
发现与官方交互不一致(REPL 行为、输出、参数、错误处理)即记录为差距并按流程修复。
方法:双 tmux 会话(OCC 新构建 `occ-acc` vs 官方 2.1.251 `ofc-acc`,均 200x50)
逐项对打 + 官方 ELF(`/tmp/cc-diff-108/v2.1.251/package/claude`,214,326,616 字节)
字节取证交叉验证。所有落地项均「字节取证 + 双 REPL 实测」双重确认。

## 1. 版本状态(三方核实,2026-08-31)

| 来源 | 版本 | 说明 |
|---|---|---|
| npm `@anthropic-ai/claude-code` latest | **2.1.251** | 官方未发新版(连续多轮停留) |
| npm `@anthropic-ai/claude-code` next | **2.1.251** | latest=next,无预览分支新版 |
| GitHub releases | v2.1.251 为最新 | 与 npm 一致 |
| 官方二进制 | `/tmp/cc-diff-108/v2.1.251/package/claude`(214,326,616 B)| 本轮字节取证基准 |
| OCC | package.json 2.1.316 → 本轮发布 **2.1.317** | 追平基准仍为 2.1.251 |

结论:官方无新版本可追;本轮全部产出来自自验收(与官方 2.1.251 实测对比)。

## 2. 逐版本结论

- **2.1.251**:官方停留。本轮对其 REPL 表面做自验收,发现并修复 6 处不一致
  (Gap-110a/110d/110e/110f/110g/110h),另记录 9 处分歧为 staged(§4b)。

## 3. 本轮落地项(全部字节取证 + 双 REPL 实测)

### Gap-110a effort 字形表错位(◍/◉ → ◉/◈)

- **官方机制**:2.1.251 二进制字形常量 `air="◉"`(◉)、`lir="◈"`(◈);
  effort 映射器 `je()`:low→○ medium→◐ high→● xhigh→**◉** fisheye、max→**◈** diamond-in-circle。
  此前 OCC 的 ◍ xhigh 来自旧版本二进制的陈旧最小化名 `oOs`,当前版本的映射器是 `je()`。
- **OCC落地点**:`src/constants/figures.ts` — `EFFORT_XHIGH='◉'`(U+25C9)、`EFFORT_MAX='◈'`(U+25C8)。
- **测试**:`src/constants/__tests__/effortGlyphs251.test.ts`(4 tests,含 codePoint 断言与五形互异)。
- **实测**:官方 REPL 状态条渲染 `◉ xhigh · /effort`;OCC 新构建一致。

### Gap-110d 未知斜杠命令消息(建议引擎整体重写)

- **官方机制**(自 `jee`/`zee` 最小化代码逐字节恢复):
  - 交互/非交互**同一条**消息:`Unknown command: /${name}. Did you mean /${suggestion}?`,
    无匹配时 `Unknown command: /${name}`。此前 OCC 的「REPL 说 Unknown skill」是对
    2.1.200 二进制的误读 —— "Unknown skill" 只属于 Skill 工具调用失败(`skill_invoke_not_found`)。
  - 候选 = 可见命令(`!isHidden`)的 `name + aliases` 展平;**距离严格最小者胜**
    (`if(v<d)d=v,u=y`,平手取先出现者),不是「第一个 ≤2 的候选」。
  - 长度预筛:`|len(candidate)-len(input)| > maxEditDistance(2)` 直接跳过。
  - 距离 = Damerau-Levenshtein(标准插入/删除/替换 DP + 相邻换位代价 1)。
  - 消息截断走官方 `Tr` 清洗链的可观测面:命令名 512、建议 200,超限 `slice(0,max)+'…'`;
    对 looksLikeCommand 门控输入(`[a-zA-Z0-9:_-]`),NFKC/引号/括号清洗是字节恒等无操作。
- **OCC落地点**:`src/utils/processUserInput/processSlashCommand.tsx` —
  旧 `levenshtein` 助手替换为三个导出函数:`findBestCommandSuggestion`、
  `damerauLevenshtein`、`truncateForUnknownMessage`;未知分支改用
  `context.options.commands` 过滤 `!isHidden` 后展平为候选。
- **测试**:`src/utils/processUserInput/__tests__/unknownCommandParity251.test.ts`(15 tests;
  用真实 `getCommands(process.cwd())` 注册表跑 e2e 路径)。
- **实测**:官方与 OCC 均为 `/hel` → "Did you mean /help?"(距离 1 胜过早注册的 `/new` 距离 2)、
  `/statu` → /status、`/definitely-not-a-cmd` → 无建议。
  初版移植曾取「第一个 ≤2」导致 `/hel` 建议 `/new`,被新测试 + 官方实测当场抓住并按上述重写。
- **注**:官方 `-p /hel` 建议 `/seo` 是因为官方自带 `/seo` 命令(bundled agent 表面,OCC 未含);
  `help` 是 local-jsx(headless 下双方都过滤)、`clear`/`new` 因 `supportsNonInteractive:false`
  被过滤 —— 集合差异而非算法差异;已用 `/initt` → 双方字节一致 "Did you mean /init?" 证明算法对齐。

### Gap-110e 页脚模式文案(标题 → 指示语)

- **官方机制**:页脚模式徽章渲染 mode **indicator** 而非小写 title
  (二进制 `_ml[mode].indicator` 表;default 的 title 是 "Manual" 而 indicator 是 "manual mode")。
  官方 live 页脚:`⏸ manual mode on`(非 manual:`{symbol} {indicator} on (shift+tab to cycle)`)。
- **OCC落地点**:`src/utils/permissions/PermissionMode.ts` 已有 `permissionModeIndicator`;
  `src/components/PromptInput/PromptInputFooterLeftSide.tsx` 的 `ModeIndicator` 改用
  `{permissionModeSymbol(mode)} {permissionModeIndicator(mode)} on`。
- **测试**:`src/utils/permissions/__tests__/modeIndicatorParity251.test.ts`(7 tests,
  含六模式指示语表 + 两个页脚徽章构造断言)。
- **实测**:OCC 页脚现渲染 `⏵⏵ auto mode on (shift+tab to cycle)` / `⏸ manual mode on …`,与官方一致。

### Gap-110f /help 对话框整体对齐

- **官方机制**(二进制 + 官方 REPL 截图双证):窗体标题为字面 **"Help"**
  (`title:"Help",color:"professionalBlue"`),tab 名 **General / Commands / Custom commands**;
  General 页含 "New here? Run /powerup …" 行,受终端行数门控(`rows < 44` 隐藏且
  paddingY/gap 收为 0);`/feedback` 页脚行同样受 `rows >= 44` 门控
  (二进制常量 `Co=44`,`uo` 门控,`marginTop:1,flexShrink:0`);
  第一列快捷键菜单为 `[! for shell mode, / commands, @ file paths, /btw side question]` ——
  **"bash mode" 已改 "shell mode","& for background" 行已整行移除**;
  `to edit in $EDITOR` 行包 `flexShrink:0`。
- **OCC落地点**:
  - `src/components/HelpV2/HelpV2.tsx` — `title="Help"`、tab 标题改正式写法、
    feedbackBox(rows≥44 门控,专用 memo 槽 $[44]/$[45],Pane 依赖槽 $[46])、`_c(44)`→`_c(47)`。
  - `src/components/HelpV2/General.tsx` — 改普通组件(去陈旧 memo 缓存),
    `COMPACT_ROW_THRESHOLD=44`,powerup 行 + 紧凑间距。
  - `src/components/PromptInput/PromptInputHelpMenu.tsx` — "! for shell mode"、
    删除 "& for background" 行(连同其 memo 槽 $[29]/$[30] 与列组装依赖 $[37])、
    $EDITOR 行 flexShrink:0。
- **测试**:定向套件见 §5;/help 全量逐行比对通过双 REPL 抓屏完成
  (标题 Help、三 tab、描述、powerup 行、`! for shell mode`、无 `& for background`、
  `ctrl + shift + _ to undo`、`shift + tab to auto-accept edits`、`alt + p to switch model`、
  `ctrl + s to stash prompt`、`ctrl + g to edit in $EDITOR`、`/keybindings to customize`、
  "For more help: https://code.claude.com/docs/en/overview"、feedback 行、"Esc to cancel")。
- **实测**:OCC `/help` 与官方 2.1.251 抓屏字节一致。

### Gap-110g undo 键位四别名

- **官方机制**:二进制中 `chat:undo` 按序注册四个别名
  `"ctrl+_","ctrl+-","ctrl+shift+-","ctrl+shift+_"`;显示解析取**最后一个**,
  故帮助浮层渲染 `ctrl + shift + _ to undo`。
- **OCC落地点**:`src/keybindings/defaultBindings.ts` — 按官方顺序补齐四别名
  (`ctrl+_` 覆盖旧终端 \x1f;`-`/`_` + shift 变体覆盖 Kitty 协议物理键)。
- **测试**:`src/keybindings/__tests__/shortcutDisplayParity251.test.ts`(别名集 + 顺序 +
  `getBindingDisplayText('chat:undo','Chat')==='ctrl+shift+_'`)。
- **实测**:OCC /help 渲染 `ctrl + shift + _ to undo`,与官方一致。

### Gap-110h 快捷键显示格式(规范串 vs 平台显示串)

- **官方机制**:官方有三套独立的击键格式化器 —— 规范串 `c(r)`(ctrl/alt/shift/meta 序,
  super→"cmd",space 小写)、按平台显示串 `QHe`(alt||meta→"alt"/"opt")、ShortcutHint `b(t)`。
  `getDisplayText` 路径(`Sue`)= 解析**最后一个**绑定 → 平台显示格式化器。
  因此 `meta+p` 显示为 **"alt + p"**,此前 OCC 用规范串显示成 "meta+p"。
- **OCC落地点**:
  - `src/keybindings/parser.ts` — `keystrokeToString` 规范序(ctrl/alt/shift/meta/cmd)、
    `keyToDisplayName` space 小写;显示串经 `chordToDisplayString(chord, platform)`。
  - `src/keybindings/resolver.ts` — `getBindingDisplayText` 改用
    `bindings.findLast(…)` + `chordToDisplayString(binding.chord, getPlatform())`。
- **测试**:同一 `shortcutDisplayParity251.test.ts`(meta+p→alt+p、shift+tab、
  ctrl+shift+_ 渲染序、modelPicker 解析为 alt+p、规范序、space 小写)。
- **实测**:OCC /help 渲染 `alt + p to switch model`,与官方一致。

## 4. 全量分诊

### 4a. 已落地(本轮)

Gap-110a / 110d / 110e / 110f / 110g / 110h(见 §3,全部有测试 + 双 REPL 实测)。

### 4b. Staged(记录在案,待后续轮次或需先补齐子系统)

| 项 | 内容 | 不动的理由 |
|---|---|---|
| Gap-110i | `chat:queueSubmit`(ctrl+x enter)+ `chat:workflowKeywordToggle`(meta+w) | 依赖「回合排队」子系统,OCC 尚无;孤立加键位是发明行为 |
| Gap-110b | 官方 2.1.246 移除欢迎框 | 用户在 OCC-18/20/25/45/50/60 明确要保留,产品决策差异 |
| Gap-110c | /model 选择器若干细节分歧 | 需逐项二进制取证,本轮未展开 |
| Gap-97e | /effort 滑条 | 承自 occ109 staged |
| Gap-97d | /status 五 tab(Settings/Stats 缺失) | 承自 occ109 staged |
| C2 | 页脚 `← for agents` 提示 | 依赖 agents 侧栏子系统 |
| 提示槽 | manual 模式官方页脚为 `⏸ manual mode on · ? for shortcuts · ← for agents`(官方在 manual 模式下隐藏 cycle 提示) | 依赖 `?` 快捷键浮层 + agents 子系统;本轮保持 `⏸ manual mode on (shift+tab to cycle)` |
| token 计数位置 | 计数器在页脚的位置差异 | 低优先,需整页脚布局重排 |
| CLI --help | `--cloud/--environment/--restricted/--teleport` 云参数 | 云端能力 OCC 未实现 |
| OCC-only 旗标 | `--mcp-debug`、`--dangerously-skip-protected-paths`(官方二进制 0 命中) | 记录为将来移除候选 |
| 承自 occ109 §4b | `--restricted` 模式、`Cwt` noteHookFailure pill 等 | 见 occ109 台账 |

### 4c. 不适用

- 官方 2.1.251 无新增可追内容(本轮官方未发版);云端/平台专属项(同 4b)。

## 5. 验证

- **定向套件**:4 个新 251 套件 35 tests 全过
  (effortGlyphs 4 + shortcutDisplay 9 + modeIndicator 7 + unknownCommand 15)。
- **全量门**:`scripts/ci-test.sh` — **3377 pass / 15 fail / 12 skip**(基线 3344/13/12,+33 新过)。
  15 个失败全部为已知环境性失败:A/B 复验确认
  `workflow-save-dialog-config-dir`(live-model workflow 30s 超时)在**无本轮改动的基线树上
  同样失败**;`commands-behavior` 的 `/feedback` 用例为 live-model/gh 抖动,重跑即过。
  其余 8 文件为台账既有环境性失败(feedback-ai、goal-gate、goal-panel、repl-interactive、
  resume-command-name、trust-gate、version-2.1.208-screen-reader、version-2.1.210-plan-approval)。
- **lint**:biome 0 error(7 条 warning 为 voice-hint 区既有,HEAD 上相同)。
- **构建冒烟**:`bun run build` 绿(`dist/cli.js` 28.98 MB);`occ -p` PONG 冒烟绿。
- **REPL e2e**(skill `repl-tmux-e2e-testing`):双 200x50 tmux 会话(OCC 新构建 + 官方 2.1.251)
  对打:`◉ xhigh · /effort` 状态条、模式页脚徽章、`/hel`/`/statu`/`/definitely-not-a-cmd`
  未知命令消息、/help 全对话框逐行一致、`! for shell mode`、`ctrl + shift + _ to undo`、
  `alt + p to switch model`。
- **安全自查**(本轮兼安全评审):全部改动 9 改 4 新共 13 个文件,均为纯
  UI 文案/键位/格式化/字符串算法逻辑;无硬编码密钥、无 eval/child_process/网络原语、
  无新增 URL、无混淆;`truncateForUnknownMessage` 反而为消息长度加了上限。结论:**无后门,通过**。

## 6. 结论

官方停留 2.1.251;本轮自验收发现并修复 6 处 REPL 交互不一致(全部字节取证 + 实测双证),
其余分歧记入 4b。OCC 与官方 2.1.251 的可追平表面进一步收敛。发布 **2.1.317**。
