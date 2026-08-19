# OCC-99 — 2026-08-20 版本追齐 2.1.234 → 2.1.235(2 项 landed,17 项 staged)

## 1. 版本状态(三方核实,2026-08-20)

| 来源 | 结果 |
|------|------|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = `2.1.235`(published 2026-08-18T18:24Z) |
| GitHub releases (anthropics/claude-code) | latest release `v2.1.235`(published 2026-08-18T20:38Z) |
| 官方 linux-x64 ELF 下载核对 | 2.1.234 = 328,358,192 B;2.1.235 = 330,946,864 B(+2.59 MB) |
| 2.1.235 ELF strings 核验 | `2.1.235` 版本标记 120 处,无 `2.1.236+` 标记 |

**结论:官方前进到 `2.1.235`,本轮为实质追齐轮。** OCC 上一轮(OCC-98,
release `2.1.305`)已追平 2.1.234。changelog `2.1.235` 段共 **19 条**;
triage 后 **2 项可移植(全部 landed)**,**17 项 staged**(无 OCC 表面 /
依赖被裁剪子系统 / 二进制歧义需逐点位反编译 —— 见 §4)。

守卫检查(issue 要求):本轮开始时工作区内无其他正在运行的版本追齐
issue,正常推进。

**方法学**(按 `upstream-tracking` + `aligning-with-official-binary` skill):
changelog 为权威清单,每条用 2.1.234/2.1.235 两个官方 ELF 的 strings 差分
(`strings -n 8 | sort -u | comm -13`,新增 8,643 行)定位新增表面,再对
每个落地点位做**逐字节**提取核实(`grep -aboF` 字节偏移 + `dd` 窗口 /
语句切分)后才实现。strings 差分只作线索 —— minified JS 边界漂移会产生
大量假阳性,不作为证据。

## 2. Landed 项(2 项,全部逐字节核实)

### 2.1 changelog 第 14 条:context-limit 错误提示 auto-compact 已关闭

官方 2.1.235 在 "Context limit reached" 渲染站点新增后缀:auto-compact 被
用户**显式**关闭时追加 ` · auto-compact is off · /config to turn it on`。
逐字节核实链(2.1.235 ELF → OCC 实现):

| 官方(2.1.235 字节证据) | 语义 | OCC |
|------|------|-----|
| `WrD = K.DISABLE_COMPACT ? "/clear to continue" : "/compact or /clear to continue"` | 主继续提示(env 关闭时只提 /clear) | 既有逻辑,本轮改为经 `isEnvTruthy(process.env.DISABLE_COMPACT)` 选取,字节等价 |
| `qLl = !qrD && !VrD && kRa() ? " · auto-compact is off · /config to turn it on" : ""` | 新增后缀 | `autoCompactOffSuffix`(AssistantTextMessage.tsx) |
| `function PBp(){return Boolean(K.DISABLE_COMPACT \|\| K.DISABLE_AUTO_COMPACT)}` | env 关闭 → 不给后缀 | `isAutoCompactExplicitlyOff` 的 env 短路 |
| `function kRa(){if(PBp())return!1;let e=Vd("autoCompactEnabled",!0);…}` | 仅"用户显式关闭"为 true | `isAutoCompactExplicitlyOff()`(autoCompact.ts 新增) |

**归约说明**:`qrD`(`remoteAutocompactState`,云会话状态)与 `VrD`
(transcript-row provider 上下文)在 OCC 均无表面,恒为 false,后缀判定
归约为 `isAutoCompactExplicitlyOff()`(官方 `kRa`)单条件。官方 `kRa` 的
多来源设置解析(userSettings / legacyGlobalConfig / 其他来源返回 false)
在 OCC 归约为读 `~/.claude.json` 全局配置的 `autoCompactEnabled`:OCC 的
settings.json 多源体系中不存在该键,全局配置即官方 userSettings/legacy
来源的对应面,显式 false 即用户意图。2.1.234 ELF 中无 `qLl` 后缀与
`kRa` 链 —— 确认为 2.1.235 新增。

落地文件:`src/services/compact/autoCompact.ts`(新增
`isAutoCompactExplicitlyOff` + 官方链文档注释),
`src/components/messages/AssistantTextMessage.tsx`(PROMPT_TOO_LONG 分支
按官方渲染站点重写,保留 react-compiler `_c` 缓存槽语义,后缀作为缓存
依赖项)。

### 2.2 changelog 第 6 条:Agent 工具不再虚报 general-purpose 默认

官方 2.1.235 修复:在 general-purpose agent 不可用的会话里,Agent 工具
prompt 仍宣称"省略 subagent_type 即用 general-purpose",且省略时报错不
清。新版:prompt 按可用性换文案,运行时报专用错误并列出可用 agents。
逐字节核实链(2.1.235 ELF → OCC 实现):

| 官方(2.1.235 字节证据) | 语义 | OCC |
|------|------|-----|
| `T9o = "subagent_type is required: the general-purpose agent is not available in this session"`(2.1.234 ELF 中 0 处,确证新增) | 错误常量 | prompt.ts / AgentTool.tsx 两处字节一致引用 |
| `fhf({model,isCoordinator,forkAvailable,generalPurposeAvailable})` prompt 构建器;非 fork 分支 `${n?"If omitted, the general-purpose agent is used.":s}` | 可用性决定文案 | `getPrompt` 新增 `generalPurposeAvailable` 条件句 |
| `s = `${T9o}, so choose ${i?'`"fork"` or ':""}one of the listed agent types.`` | 不可用文案(i = fork 可用位) | OCC 的 FORK_SUBAGENT flag 关闭 → 取无 fork 变体,字节一致 |
| `_bf(e,t)`:精确名命中看 allowedAgentTypes;否则**单个**归一化别名才算可用 | 可用性判定 | `getPrompt` 中 `_bf` 逐条复刻(同样的归一化与单别名规则) |
| `if(t===void 0&&!_bf(T,C)) throw new Wyt(`${T9o}. Available agents: ${MEi(Cr)}`)` | 运行时报错 | AgentTool.tsx `!found` 分支:`subagent_type === undefined` 时抛同样消息 |
| `MEi(e){return e.join(", ")||"none"}` | 列表格式 | `.join(', ') \|\| 'none'` 字节一致 |

**归约说明**:官方 throw 的可用列表在 fork 可生成时前置 fork 类型
(`R&&bbf(W)===null?[fork,...At]:At`)—— OCC 的 fork 需 FORK_SUBAGENT
flag(不在 FEATURE_ALLOWLIST),恒不可用,普通列表即字节等价。OCC 原有
的 deny-rule 分支(agent 存在但被 permission 拒绝)保留且优先 —— 比官方
路径更精确,非分歧点。

落地文件:`src/tools/AgentTool/prompt.ts`(`_bf` 移植 + 条件文案),
`src/tools/AgentTool/AgentTool.tsx`(omitted 分支专用错误)。

## 3. 测试与验收

- 新增单测 10 个,全过:
  - `src/services/compact/__tests__/autoCompactExplicitlyOff.test.ts`(5):
    默认开 → false;显式关 → true;DISABLE_COMPACT/DISABLE_AUTO_COMPACT
    env 关闭 → false(官方 PBp 短路);falsy env 值不算设置。
  - `src/tools/AgentTool/__tests__/generalPurposeDefault235.test.ts`(5):
    可用 → "If omitted" 文案;allowedAgentTypes 排除 → required 文案;
    单个归一化别名算可用;别名被排除 → 不可用;多别名无精确命中 → 不可用
    (官方 `_bf` 单别名规则)。
- 全量 `bun test`:见 §3 尾注(套件结果)。
- `bun run build`:绿,`dist/cli.js` 28.91 MB。
- e2e smoke:`occ --version` + `echo "say PONG" | occ -p` 见尾注。

## 4. Staged 项(17 条,逐条理由)

| # | changelog 条 | 结论 | 理由 |
|---|---|---|---|
| 1 | `spellcheck` 设置(as/hun/ispell 实时拼写检查) | staged | 全新可选功能子系统(新设置键 + 编辑器集成 + 外部拼写检查器进程),非 fix 移植;需专门设计轮,避免凭空实现(aligning skill: Never invent) |
| 2 | LSP 断连/重连导致 whole-prompt-cache 失效 | staged | OCC 已裁剪 LSP server(CLAUDE.md 模块表:Removed),无表面 |
| 3 | 嵌套 markdown 列表 depth 3+ 对齐 + 悬挂缩进 | staged | 差分中无新锚点字符串;改为 minified markdown 渲染器内的缩进计算,需对官方渲染器 vs OCC `Markdown` 组件做专门逐点位反编译 |
| 4 | 多行 prompt 高亮位移(slash/keyword/mention) | staged | PromptInput 高亮偏移计算修复,无新字符串锚点,需专门反编译 |
| 5 | 权限 prompt comment 字段的 Shift+Tab 误授权 | staged | comment 字段按键处理修复;需专门反编译官方 comment-field handler 并与 OCC 权限 prompt 对照 |
| 7 | notebook 删除/替换对话框读取失败时说明原因 | staged | 新增字符串 `the notebook could not be read` 等已字节确认,但 OCC 审批对话框**根本不渲染既有 cell 内容**(`NotebookEditTool/UI.tsx` 仅渲染 new_source,裁剪表面),修复无挂载点 |
| 8 | 响应中运行 slash 命令显示 HTML 实体 | staged | 差分短字符串中未定位到锚点;需专门反编译实体解码路径 |
| 9 | 后台自动更新后 footer 不显示 "Update installed" | staged | 差分中无新锚点字符串;footer 状态刷新逻辑需专门反编译 |
| 10 | 恢复会话时 ctrl+t 任务列表总是折叠 | staged | OCC 无展开式任务列表表面(REPL/components 中无 ctrl+t 任务 UI),无挂载点 |
| 11 | 云会话后台运行时内存/CPU 改进 | staged | OCC 无云会话(`/ultrareview`/`/autofix-pr` 类)表面 |
| 12 | "don't ask again" 与授权范围一致化 | staged | 权限对话框策略逻辑,需专门反编译;涉及 OCC 权限对话框多处渲染 |
| 13 | 内嵌 grep fail-fast 与 `-m N` 上下文修复 | staged | 官方修复针对其原生构建**内嵌**的 grep 引擎;OCC GrepTool 经 `execFile` 委托外部 ripgrep(`GrepTool.ts:509` 注释确认),行为由外部工具承载,无挂载点 |
| 15 | Vim NORMAL/光标在 ctrl+o 与关面板时保持 | staged | OCC 有完整 vim 引擎,但该修复需对官方 vim 状态保存点位专门反编译并与 OCC `src/vim/` 行为逐一验证后再动 |
| 16 | 对话框方向键+Enter 连按竞态 | staged | 输入竞态修复,需专门反编译官方对话框输入处理 |
| 17 | SendMessage 超大会话间消息直接拒绝 | staged | 官方 1 MiB 上限(`Q$r=1048576`,字节已核实)位于 UDS 发送路径 `K1d`;OCC 的 SendMessage 门控在 `isAgentSwarmsEnabled()` 且 UDS_INBOX flag 关闭,OCC 无 UDS inbox 传输面 |
| 18 | `claude rc` 企业网关可用性检查 | staged | OCC 无 Remote Control 表面 |
| 19 | VSCode 多面板焦点跳动 | staged | OCC 无 VSCode 扩展表面 |

## 5. 版本指针

本轮 landed 2 项后,OCC 的可移植表面追平至 **2.1.235**;17 项 staged
(上表)留待后续逐点位反编译轮。release `2.1.306`。
