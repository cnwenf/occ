# OCC-100 — 2026-08-21 版本追齐 2.1.235 → 2.1.237(2 项 landed,其余 staged/已对齐)

## 1. 版本状态(三方核实,2026-08-21)

| 来源 | 状态 |
|------|------|
| npm `@anthropic-ai/claude-code` | latest = 2.1.237,next = 2.1.237,stable = 2.1.228 |
| GitHub releases | v2.1.237(2026-08-20T00:54Z)、v2.1.236 |
| OCC(追齐前) | 2.1.306,行为面对齐官方 2.1.235 → 本轮 gap = **2 个版本** |

二进制取证(官方 npm 包,2.1.113+ 为 Bun 编译 ELF,JS 以字符串内嵌):

| 文件 | 字节数 | 版本标记计数 |
|------|--------|--------------|
| 2.1.235 `cli.js` ELF | 330,946,864 | "2.1.235" ×120 |
| 2.1.236 `cli.js` ELF | 334,645,552 | "2.1.236" ×122 |
| 2.1.237 `cli.js` ELF | 334,715,184 | "2.1.237" ×122 |

交叉污染为 0(每个二进制不含相邻版本字符串)。strings 转储(`strings -n 8 | sort -u`):s235 288,083 行 / s236 289,831 / s237 289,861;差集 new236 = 9,348 行,new237 = 6,607 行。

官方 CHANGELOG(抓自 GitHub raw):**2.1.237** 2 条;**2.1.236** 33 条。

## 2. Landed 项(2 项,全部逐字节核实)

### 2.1 内置 Concise output style(2.1.237 changelog 第 2 条)

新特性取证:`Concise` 在 s235/s236 中命中 0 次 → 2.1.237 真新增。

v237 ELF 偏移 312621400 提取的完整定义(逐字节):

```js
Concise:{
  name:"Concise",
  source:"built-in",
  description:"Claude responds tersely, leading with results and skipping preamble and narration",
  keepCodingInstructions:!0,
  prompt:`You are an interactive CLI tool that helps users with software engineering tasks. Keep your responses short and direct while doing the work just as thoroughly.\n\n# Concise Style Active\n${Rkw}`,
  turnReminder:Lkw
}
```

- `Rkw`(偏移 312618602):6 条规则全文(Lead with the result / Cut narration, keep substance / Short by default / State things plainly / Give full detail on request / Never trade correctness for brevity),结尾 "Where these rules conflict with more general communication or formatting guidance elsewhere in your instructions, these rules win."
- `Lkw`(turnReminder):`Be concise: lead with the result, skip preamble and narration, keep only what the user needs.`
- 官方样式顺序:default, Proactive, Concise, Explanatory, Learning。
- 官方渲染模板:`${t.name} output style is active. ${e.turnReminder ?? "Remember to follow the specific guidelines for this style."}`
- 官方 attachment:`{type:"output_style", style:t, turnReminder:r?.turnReminder}`

Port:`src/constants/outputStyles.ts`(新增 `turnReminder?: string` 字段 + Concise 条目)、`src/utils/attachments.ts`(attachment 携带 turnReminder)、`src/utils/messages.ts`(渲染模板带 fallback)。Proactive 仍不 port(属休眠 PROACTIVE 子系统,上一轮遗留 staged,不在本 gap)。

### 2.2 ANTHROPIC_DEFAULT_MODEL 环境变量(2.1.236 changelog 第 1 条)

官方实现取证(v236 ELF):

- 解析器 `jxt()`(偏移 299727414)完整守卫链:
  1. 值为 null → 无效;2. trim+lowercase 后为 `default`/`inherit` → 无效(哨兵);3. 去掉 `[1m]` 后缀后若是 `opusplan`/`haiku` 别名 → 拒绝;4. 模型发现进行中或 `enforceAvailableModels===true` → 无效(让位强制 allowlist);5. entitlement/allowlist 校验不过 → 无效;6. first-party disabled/absent 校验命中 → 无效;否则返回原值。
- 归因文本 `lCn("env")` = `" · Set by ANTHROPIC_DEFAULT_MODEL"`。
- 生效链路:`N6()` 返回 `odt().setting`,`gH()=hs(N6())` 即默认模型;`odt()` 优先级 **org default > ANTHROPIC_DEFAULT_MODEL(attribution:"env")> enforced > entitlement > tier**。启动解析 `UOd()` 链:`--model` flag > agent frontmatter > `ANTHROPIC_MODEL` > settings.model > 默认模型(即 `gH()`,env default 由此进入)。这与 changelog 描述一致:"/model 选择仍覆盖它且跨重启持久(不像 ANTHROPIC_MODEL)"——因为持久化的 settings.model 在链中更高。
- 启动遥测:`model_env_default` 事件(inert / outranked_by_org_default);`Nif` 持久化仅服务于 Fable 场景。

Port(OCC 无 org default / entitlement / 模型发现 / picker 归因 UI,取行为核心):

- 新增 `resolveAnthropicDefaultModel()`:env 读取 + 哨兵(default/inherit)+ `[1m]` 剥离 + opusplan/haiku 别名拒绝 + `getEnforceAvailableModels()` 时让位 + `isModelAllowed` 校验。
- 接入 `getDefaultMainLoopModelSetting()`:在 tier 默认(Max→Opus / 其余→Sonnet)之前采用 env default,其后照旧过 `enforceDefaultModelAllowlist`。最终优先级:`/model` override > `--model` > `ANTHROPIC_MODEL` > settings.model > **ANTHROPIC_DEFAULT_MODEL** > tier default,与官方一致。
- Staged 残留:picker/status 归因 UI(OCC 无任何归因显示面,不新造 UI)、`model_env_default` 遥测、org default 交互。

## 3. 已对齐项(无需动作)

- **slash-command 拼错上报(不模糊执行)**(2.1.236 changelog):s235 与 s236 的 `cmd_dispatch","cmd_unknown"` 分派点逐字节同构(仅压缩变量名不同),`Unknown command: /X. Did you mean /Y?` 模板在两版各 2 处;OCC 已在早前轮次实现 Levenshtein≤2 建议上报(`src/utils/processUserInput/processSlashCommand.tsx`)。

## 4. Staged 项(逐条理由)

**2.1.237**(共 2 条,1 landed + 1 staged):

| changelog 条目 | 裁决 | 理由 |
|---|---|---|
| 修复 LLM gateway / 自定义 base URL 的 prompt caching | staged | new237 无新增 cache 相关字符串(prompt-caching-evict-2026-05-12 等三版均存在,属边界噪音);修复无可识别字符串表面,需逐站点反编译定位,歧义风险高 |

**2.1.236**(共 33 条,1 landed + 1 已对齐 + 31 staged):

子系统缺失/休眠(OCC 无对应实现面,不新造):
- SendMessage `notify_when_idle`(UDS 跨会话消息协议扩展,24 处新字符串,含 peer_idle_notice 协议帧/权限交互/多错误路径——需专门轮次)
- macOS sandbox 通配 read-deny、fullscreen renderer ×3(fallback / resize 后消息 / 空白带)、tmux 标签标题动画、Clawd 吉祥物 iTerm2、Remote Control ×3(Fable 5 credits 提示 / 离线标记)、[VSCode] 屏幕阅读器、cloud environments 错误、self-hosted runner resume、/goal idle check-in(30m/1h/2h)、auto mode ×3(Monitor allow-rules / classifier 默认 / git status showUntrackedFiles)

无可移植字符串表面(纯行为/性能/UI 微调,无新字符串可对齐):
- dir-removed 修复 ×4(剪贴板 / 内务 / 后台会话 / MCP 日志)、SIGTERM print/SDK 不记录 interrupted turn(exit 143)、recap 400 字符上限、启动性能(session 计数后台化)、/model picker 滚动 + 仅高亮最新、SendMessage malformed tag / burst rejection、WSL 子进程 spawn unhandled rejection、managed-settings 审批提示、spinner tips guest-pass 格式、skills 热加载(cwd 被删后)、session title chip 对齐、footer 右边距一致性

## 5. 版本指针

- 本轮发布 **OCC 2.1.307** = 官方 2.1.237 行为面(全部可移植项已 landed;staged 项均附逐字节取证理由)。
- 下一轮起点:官方 2.1.237 之后的版本(如有)。
