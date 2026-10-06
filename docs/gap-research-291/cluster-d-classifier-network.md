# Cluster D — plan/auto-mode 分类器 + 网络/代理/流式（2.1.290 → OCC gap 调研）

- 官方基线：`/tmp/cc289/package/claude`（2.1.289）、`/tmp/cc290/package/claude`（2.1.290）、`/tmp/cc291/package/claude`（2.1.291）。仅做 strings/字节取证，未执行官方二进制。
- strings 全量：`/tmp/gap291/strings-{289,290,291}.txt`；差集：`new-in-290.txt` / `new-in-291.txt` / `gone-from-289.txt`。
- 291 校验：本簇全部 290 新机制在 291 原样保留（`proxyConnectStatus` 0/5/5、`flag fetch held` 0/2/2、`counted after decompression` 0/3/3、`maxSleptThrough` 0/4/4、`before_held_growthbook_init` 0/2/2，格式 289/290/291）。以下偏移均为 290 二进制（另有说明除外）。
- 压缩标识符在版本间会改名、跨 chunk 会撞名；下文一律以字节偏移锚定，比对结构而非名字。

## 判定总表

| # | Changelog（2.1.290 原文） | 判定 | OCC 目标文件 |
|---|---|---|---|
| 1 | Fixed plan mode letting the auto mode classifier approve non-read-only connector tools that carry a server-pushed ask policy | **STAGED**（plan 结构门移植；mcpServerPolicy 分支 N-A，grep 证明缺失） | `src/utils/permissions/permissions.ts`、`src/Tool.ts` |
| 2 | Fixed auto mode denials suggesting a permission rule that would skip the classifier for a whole tool or that Claude Code would ignore | **STAGED** | `src/utils/permissions/allowRuleHint.ts`、`src/utils/permissions/permissions.ts` |
| 3 | Fixed requests failing behind proxies and gateways that reject one of Claude Code's beta headers with a status other than 400, or together with a second beta | **STAGED** | `src/services/api/advisorRetry.ts`（泛化为 beta-heal）、`src/services/api/claude.ts`、`src/services/api/errors.ts` |
| 4 | Fixed the first feature-flag request of a session ignoring a proxy or API endpoint set in a project's settings | **STAGED** | `src/services/analytics/growthbook.ts`、`src/entrypoints/init.ts`（或 `main.tsx` 启动序） |
| 5 | Fixed unbounded memory use when an HTTP MCP server sends a very large response | **STAGED** | `src/services/mcp/client.ts` |
| 6 | Improved MCP startup behind a network proxy: a server the proxy blocks (HTTP 403) is no longer retried three times | **NO-OP**（OCC 连接期无 3 次重试循环，官方修的回归在 OCC 不存在；289 代际的 [500,1500,4000] 连接重试循环本身是 OCC 既有缺口，另行立项） | — |
| 7 | Fixed a response interrupted by computer sleep being treated as a stalled stream on Bedrock, Vertex, Foundry, and custom gateways | **STAGED** | `src/services/api/claude.ts`、重试引擎（`src/query.ts` / api retry 路径） |

---

## Item 1 — plan mode 分类器批准携带 server-pushed ask policy 的非只读 connector 工具

### 官方机制

289 的分类器批准结构门（4 参）@289:210243951：

```js
function Q3t(e,n,r,s){switch(e){case"auto":return!0;case"plan":{if(!Ef())return!1;
let g=r.inputSchema.safeParse(s);
return g.success===!0&&r.isReadOnly(g.data)&&!(r.ignoresWholeToolAllowRule?.(g.data)??!1)||Gue(em(r),g.success?g.data:s)}...}
```

290 变为 5 参 `_rn` @213320210，`isReadOnly` 增加第二参（toolUseContext）：

```js
function _rn(e,n,r,s,g){...case"plan":{if(!Uf())return!1;let h=r.inputSchema.safeParse(s);
return h.success===!0&&r.isReadOnly(h.data,g)&&!(r.ignoresWholeToolAllowRule?.(h.data)??!1)||vye(Sf(r),h.success?h.data:s)}...}
```

两参 `isReadOnly(x,y)` 调用点：289 = 0 处，290 = 8 处（209904244、212344747、213224212、213361355、214306457、226654970、226667410、236822865）。调用侧 289 `Q3t(Xr,Fe,e,n)` @289:210259721 → 290 `_rn(ka,Ne,e,n,H)` @213336229（H=toolUseContext）。

290 新增 plan_mode_floor 析取项 @~213361355（`pgn`= rule 为 `ruleBehavior==="ask"&&rule.source==="mcpServerPolicy"`，两版本均已存在 1/1；`nkr`= MCP 工具判定；`Drn`= `decisionReason.type==="mode"&&mode==="plan"`）：

```js
function nkr(e,n){if(e.mcpInfo)return!0;if(N9(n.session,e.name)===void 0)return!1;
return!((e.name===$e||e.name===Tt)&&Ii("plan",de(n).servedCall===!0))}
function Lrn(e,n,r){return de(r).mode==="plan"&&nkr(e,r)&&!e.isReadOnly(n,r)&&!vye(Sf(e),n)}
function o5n(e,n,r,s){if(!pgn(e))return!1;try{let{parsedInput:g}=xye(n,r,s);return Lrn(n,g,s)}catch{return de(s).mode==="plan"}}
```

分类器 allow 后的回退条件，289 @~210255484 `an=f9t(ye.decisionReason)&&!Gue(em(e),n)` → 290 @~213330711：

```js
Dn=Drn(ke.decisionReason)&&!vye(Sf(e),n)||!ot&&!Ye&&o5n(ke.decisionReason,e,n,H)
```

命中即回落为 ask，deny/ask 消息带 reason `"plan_mode_floor"`（字符串两版本均 2/2）。`Ii(e,s=!1){return e==="auto"||e==="plan"&&!s&&Uf()}` @203532991 为分类器激活门。MCP 工具工厂两版本相同（289@234688809/290@237978299）：`isReadOnly(){return x.annotations?.readOnlyHint??!1}`；`mcpServerPolicy` 规则合并（`Ecs`，服务器下推 alwaysAllow/Deny/AskRules）为两版本既有。

**语义**：plan 模式下分类器的 allow 只在「parse 成功 && isReadOnly(input, ctx) && 非 whole-tool-ignore」或 `vye`（whole-tool allow 规则被忽略判定）时生效；290 追加：即便分类器 allow，若工具是 MCP 工具、当前为 plan 模式、`isReadOnly(input,ctx)` 为假、且存在 server-pushed `mcpServerPolicy` ask 规则 → 强制回落 ask（plan_mode_floor）。

### OCC 现状

- 分类器门 `src/utils/permissions/permissions.ts:601-607`：`feature('TRANSCRIPT_CLASSIFIER') && (mode==='auto' || (mode==='plan' && (isAutoModeActive()||isPlanModeAutoBashActive())))` — plan 模式可进分类器。
- 分类器不 block 即放行（permissions.ts ~958 `if (classifierResult.shouldBlock)` 为唯一拦截点）；**无** plan 模式「只读才可被分类器批准」的结构门（`grep -n isReadOnly src/utils/permissions/classifierDecision.ts src/utils/permissions/yoloClassifier.ts` = 0 命中）。
- `src/Tool.ts:449` `isReadOnly(input: z.infer<Input>): boolean` — 单参，无 ctx。
- `mcpServerPolicy` 在 OCC 全源码 0 命中（`grep -rn mcpServerPolicy src --include='*.ts'` 空）— server-pushed ask policy 表面不存在。
- MCP 工具 `isReadOnly = tool.annotations?.readOnlyHint ?? false`（client.ts:2280/2283）与官方一致。

### 判定

**STAGED**（子分支 N-A：`o5n`/`pgn` 的 mcpServerPolicy 析取项在 OCC 无对应表面，grep 证明缺失；待 OCC 引入 server-pushed 权限规则时随该 feature 一并移植）。

### 移植方案 + 测试计划

方案（`src/utils/permissions/permissions.ts`）：
1. 在分类器 allow 落地前加官方 `_rn` 等价结构门：`mode==='plan'` 时，仅当 `parseOk && tool.isReadOnly(parsedInput, context) && !ignoresWholeToolAllowRule(parsedInput)`（OCC 无此 Tool 方法则跳过该合取项，按 false 处理，不发明）才承认 allow；否则回落 ask，decisionReason 带 `reason: 'plan_mode_floor'`。
2. `Tool.isReadOnly` 签名扩为可选第二参 `context?: ToolUseContext`（`src/Tool.ts`），默认实现不变；仅需要 ctx 的工具后续逐个对齐（本次不发明行为）。
3. `mode==='auto'` 分支保持无条件放行（官方 `case"auto":return!0`）。

测试：
- 单测：plan+auto-active 下，非只读工具（mock isReadOnly=false）分类器 allow → 最终 ask（reason=plan_mode_floor）；只读工具 → allow；auto 模式非只读 → allow（不回退）。
- 单测：plan 且分类器不可用（fail-closed）路径不受影响。
- e2e（真实 REPL，`occ` tmux）：plan 模式挂一个 readOnlyHint=false 的本地 MCP stub server，触发工具调用，断言出现权限询问而不是静默放行。

---

## Item 2 — auto mode deny 提示了会整体跳过分类器 / 会被 Claude Code 忽略的权限规则

### 官方机制

289 deny 消息构造 `V7o` @~289:210280000 的 S 谓词（是否给出 allow-rule 提示）：

```js
S=!cY(g)&&g.decisionReason?.type!=="sandboxOverride"&&mu(g.decisionReason)===void 0
&&r.requiresUserInteraction?.()!==!0&&g.suppressAlwaysAllowRule!==!0
&&r.suppressesAlwaysAllowRule?.(s)!==!0&&r.suppressesAllPermissionUpdates?.(s)!==!0
&&r.ignoresWholeToolAllowRule?.(s)!==!0;
...allowRuleToolName:S?xVo(em(r)):void 0
```

290 对应函数 `Q_r` @~213356950（完整谓词自 @213356200 起），新增 5 个合取项并换名规范化函数：

```js
S=g!==void 0&&!LW(g)&&g.decisionReason?.type!=="hook"&&g.decisionReason?.type!=="sandboxOverride"
&&xd(g.decisionReason)===void 0&&r.requiresUserInteraction?.()!==!0&&g.suppressAlwaysAllowRule!==!0
&&r.suppressesAlwaysAllowRule?.(s)!==!0&&r.suppressesAllPermissionUpdates?.(s)!==!0
&&n.forRemoteExecution!==!0&&!EP(n)&&!see(r.name)&&r.ignoresWholeToolAllowRule?.(s)!==!0
&&Rye(r,s,$P(r,de(n)))===void 0&&!Tye(r.name);
...message:h?gjt(e.reason,{refused:!1}):tJn(e.reason,{autoModeConsentFlow:KUt(n.agentId),allowRuleToolName:S?lXo(Sf(r)):void 0})
```

新合取项定义（均 290 偏移）：
- `EP(e){return e.hookCaller!==void 0||e.pluginSteered===!0}` @205029407 — hook 触发或 plugin 引导的调用不给提示。
- `see(e)` @206369364 — `pr="WebFetch"`/`Df="WebSearch"`（常量确认）在 projects/远程会话语境（`Ls(O).value||a.CLAUDE_CODE_PROJECTS_SESSION||tkt(Bb())`）下抑制提示（payload 下发的 web 工具开关除外）。
- `Rye(e,n,r){if(!Ii(r))return;let s=fYe(Sf(e),n);return s==="observe"||s==="access"?void 0:s}` @213304369 — 分类器激活模式下（`Ii`= auto/plan 门），computer-use 工具动作按 `fYe`/`Eye` 分类（observe=screenshot/zoom/scroll…，access=request_access…，press=left_click…）；act 类动作返回非 undefined → 抑制提示。配套新 ask 强制（0→2 新字符串）@~213304700：`may act on this session's desktop, so each call is reviewed; allow rules, hooks and plugins cannot approve it.`
- `Tye(e){return s_r.has(e)}` @213302461，`s_r=new Set([ht,ku,zc,k7,FL,La,po,...L5?[L5.SPAWN_LOCAL_TOOL_NAME,L5.REQUEUE_SESSION_TOOL_NAME]:[],...zon?[zon]:[],...qon?[qon]:[],Ac])` @213302325 — 名字级 whole-tool-ignore 工具集（含 spawn_local/requeue_session 等会话类工具），紧邻 `vye`（=289 `Gue`，ignoresWholeToolAllowRule 逻辑）。
- `$P(e,n)` @202637102 — 由 `mcpPermissionModeOverrides`/bypass/auto 状态计算工具的有效权限模式，供 `Rye` 的 `Ii(r)` 判定。
- `lXo` @206375253 与 289 `xVo` @289:~210281000 结构逐字相同（Bash 系条件抑制、命名空间 MCP 工具抑制、`rn/ja→St` 映射），非新增。

**语义**：deny 消息只在「建议的 allow 规则真的会被 Claude Code 尊重」时给出：远程执行、hook/plugin 调用、projects 会话下的 Web 工具、computer-use act 动作（allow 规则不能批准）、名字级 whole-tool-ignore 工具，一律不给提示。

### OCC 现状

- `src/utils/permissions/allowRuleHint.ts`（已核对全文）实现的是 289 代 S 谓词子集：sandboxOverride、`result.suppressAlwaysAllowRule`（ask 变体）、`requiresUserInteraction` 三项抑制；头注明确记录了 `suppressesAlwaysAllowRule`/`ignoresWholeToolAllowRule` 等因 Tool 接口缺方法按不抑制处理。
- `forRemoteExecution`、`hookCaller`、`pluginSteered` 在 OCC 源码 0 命中（grep 空）。
- OCC 有 computer-use 痕迹（`src/query.ts:1203` `cleanupComputerUseAfterTurn`）但无 observe/press/access 动作分类与「desktop 每次审查」ask 强制。
- deny 文案 `src/utils/permissions/messages.ts:381-405`：`To allow this type of action in the future, the user can add a permission rule for <tool> to their settings.`

### 判定

**STAGED**（按表面存在性分合取项移植：远程执行/hook/plugin/computer-use 分类在 OCC 无表面 → 对应合取项 N-A，随表面引入时补；本条目核心可移植部分是「名字级 whole-tool-ignore 集」与「Web 工具会话语境抑制」的钩子位，以及把 S 谓词集中化以便追加）。

### 移植方案 + 测试计划

方案：
1. `allowRuleHint.ts`：`computeAutoModeAllowRuleToolName(tool, result, context?)` 增加可选 context 参数，按官方顺序补合取项，OCC 无表面的项显式注释「N-A until surface exists」：
   - `context?.forRemoteExecution !== true`（OCC 无字段则恒真，留位）；
   - `!isHookOrPluginCall(context)`（同上留位）；
   - Web 工具抑制：`tool.name` ∈ {WebSearch, WebFetch} 且处于 projects/远程会话语境时返回 undefined（OCC 若有 `CLAUDE_CODE_PROJECTS_SESSION` 等价物才生效，否则不触发）；
   - 名字级 ignore 集：新增常量 `WHOLE_TOOL_ALLOW_RULE_IGNORED_NAMES`（对齐官方 s_r 的可映射成员：Task/Agent 派生、spawn-local、requeue-session 等，按 OCC 实际工具名收敛，不发明官方没有的成员）。
2. `permissions.ts` deny 消息构造处传入 context。

测试：
- 单测：s_r 集内工具 deny → 无 allow-rule 提示；集外普通工具 → 有提示；sandboxOverride/requiresUserInteraction 回归不变。
- 单测：WebSearch/WebFetch 在 projects 会话标志置位/未置位两种情况下提示的有无。
- e2e：auto 模式触发一次分类器 deny，断言消息尾部提示与工具类别匹配（REPL 真实运行）。

---

## Item 3 — 代理/网关以非 400 状态或连同第二个 beta 一起拒绝 beta 头

### 官方机制

289 `MMe` @~207972xxx（见 /tmp/gap291/beta289.txt）带**硬 400 门**且按单 beta 匹配：

```js
function MMe(e,n){if(!(e instanceof xt)||e.status!==400||VO(e)||jE(e))return[];
let{message:r}=e;return AMe.filter((s)=>n.includes(s.header)&&(ub(r,s)||xMe.get(s)?.(r)===!0))}
```

289 已有 `OMe`（多 beta 正则匹配器）但**仅用于遥测**。290 改名为 `SDe` 并去掉 400 门、把多 beta 匹配器 `sse` 提升为判定路径：

```js
function SDe(e,n){if(!(e instanceof At)||tL(e)||OR(e))return[];let{message:r,status:s}=e;
return kDe.filter((g)=>n.includes(g.header)&&(sse(e,g)||s===400&&sw(r,g)))}
```

`sse(e,n)`（=289 `OMe` 逐字）：

```js
/^Unexpected value\(s\) ((?:`[^`]+`(?:, )?)+) for the `anthropic[-_]beta`/.exec(Jre(e))?.[1]?.includes(`\`${n.header}\``)===!0
||Jx(e.message,`beta_header:${n.header}`)||XRt.get(n)?.(e.message)===!0
```

`Jre` 取 `e.error?.error?.message`，否则 `e.message.replace(/^\d{3} /,"")` 截到换行。heal 点 290 `NJe`：剥离命中 beta、一次性闩锁、`tengu_beta_400_healed` 遥测新增 `status` 字段、返回重试标记 `retry:beta-rejected:<names>`。可 heal 集 `XRt`/`xMe`：cache_diagnosis(null 匹配器)、prompt_caching_evict(`evict_on_complete`+`beta`)、thinking_display_updates(KRt 正则)、thinking_token_count(null)。beta 注册表 @203535205。

**语义**：任何状态码（不再限 400）下，只要错误文本按多 beta 语法点名了本次请求携带的 beta（或 telemetry 标记/专用匹配器命中），就剥掉该 beta 并重试一次；同时解决「网关把两个 beta 一起报出来」的场景（filter 可返回多个）。

### OCC 现状

- `src/services/api/advisorRetry.ts:221-264`：beta strip-and-retry 仅针对 advisor beta（`ADVISOR_BETA_HEADER`），一次性闩锁；`afk-mode` 拒绝走 `errors.ts:719-745` 的报错文案。
- 无通用「被拒绝 beta 自愈」路径；`getMergedBetas`（claude.ts:1678）+ betasParams live binding（@2036/2198/2380/2521-2524）具备剥离后重试所需的可变 beta 集。

### 判定

**STAGED**。

### 移植方案 + 测试计划

方案：
1. 新增 `src/services/api/betaHeal.ts`：`findRejectedBetas(error, sentBetas)` 对齐 `SDe`——去掉 status===400 前置（保留 400 专属的文本匹配分支 `s===400&&sw(r,g)` 语义），实现多 beta 正则 `sse`、`beta_header:<name>` 遥测标记匹配、可 heal 集专用匹配器（按 OCC 实际发送的 beta 收敛，官方注册表中 OCC 未实现的 beta 直接不注册）。
2. claude.ts 请求失败路径：命中则从当前 betas 集剥离全部命中项、闩锁（每会话一次）、`logEvent('tengu_beta_400_healed', {..., status})`、重试一次。
3. `Jre` 等价的消息提取（error.error.message 优先、剥 `\d{3} ` 前缀、截断换行）逐字对齐。

测试：
- 单测：403/422/400 + `Unexpected value(s) \`foo\`, \`bar\` for the \`anthropic-beta\`` → 返回 [foo,bar]（限已发送集内）；400 专属匹配器在非 400 下不触发；闩锁第二次不再 heal。
- e2e：本地 mock 网关对某 beta 返回 403 + 官方文案，`occ -p` 真实请求断言重试成功且遥测含 status。

---

## Item 4 — 会话首个 feature-flag 请求忽略项目 settings 里的代理/API endpoint

### 官方机制

290 新增 GrowthBook「fetch hold」原语 @~204679800：

```js
var Lxn=(e)=>!e.isOver&&e.isPending===!0;
var eR=()=>({isPending:void 0,hasHeld:!1,isOver:!1,over:Promise.withResolvers()});
```

单例 @205071363 `class xos{client=null;fetchHold=eR();slackTagConnected=!1}`；deps 注入 `isFetchHeld:()=>Lxn(e.fetchHold)` @205071716。`initialize()` @~204725950 在 hold 期间直接返回 null：

```js
let e=this.initializePromise===null&&this.deps.isFetchHeld();
if(this.disposed||e)return Promise.resolve(null);
```

臂/释放 @~219547330：

```js
function nnn(e){let o=RQe(e),n=Zje(o);if(o.hasHeld||=n,o.isOver=!0,o.over.resolve(),n)xa().catch((r)=>t(`flag fetch after the hold did not begin (${l(r)})`,{level:"error"}))}
var bd=(e,o,n)=>{RQe(e.host).isPending??=cs(o,n)};
var us=(e)=>e||Ote.some((o)=>An(o)&&Object.keys(HV(me(o)?.env,o)).length>0);
```

规则 `us`：已 hold 或**任一可读 settings 作用域声明了非空 `env`** → 挂起。臂点 @219653985 `bd(F(),us,Me)`（主 action 内、权限上下文构建后）；释放点两处：headless @219660035（setup 应用后 `nnn(X.host)` 再踢 flag fetch）与交互 @219667733（onboarding 后 `nnn(X.host)`，计时打点 `_d={before:"before_held_growthbook_init",after:"after_held_growthbook_init"}`）。新字符串 0→2：`before_held_growthbook_init`（@95284224,219547733）、`flag fetch held: the rule for pending settings environment threw`、`flag fetch after the hold did not begin`。启动序其余部分（mTLS→proxy→configureGlobalAgents→preconnect→startupGrowthBookKick；kick @289:216083429/290:218778500）、SDK 适配层、apiHost（`https://api.anthropic.com/`）两版本逐字不变 — 修复完全靠 hold 实现。

**语义**：只要项目/本地 settings 可能改写环境（`env` 非空，可能含 HTTPS_PROXY / ANTHROPIC_BASE_URL），首个 flag fetch 就挂起，等 settings 应用完毕再发，保证走项目配置的代理/端点。

### OCC 现状

- `src/services/analytics/growthbook.ts:503-506`：baseUrl 硬编码 `https://api.anthropic.com/`（`CLAUDE_CODE_GB_BASE_URL` 仅 USER_TYPE=ant 生效）。
- 启动序：`applySafeConfigEnvironmentVariables`（早，SAFE_ENV_VARS 白名单**有意排除** ANTHROPIC_BASE_URL / HTTP(S)_PROXY / NO_PROXY，managedEnv.ts:793-797,869-880）→ mTLS → configureGlobalAgents → preconnect；完整 `applyConfigEnvironmentVariables` 在 init.ts:269 / main.tsx:2318 才执行。无 fetch-hold：首个 flag 请求可能在项目 env 应用前发出。

### 判定

**STAGED**。

### 移植方案 + 测试计划

方案（`growthbook.ts` + 启动序）：
1. 移植 hold 原语（`{isPending,hasHeld,isOver,over:Promise.withResolvers()}` + `isFetchHeld`）；`initialize()`/首次 fetch 在 `isPending===true && !isOver` 时短路返回 null。
2. 臂规则对齐 `us`：任一可读 settings 作用域（user/project/local）声明非空 `env` → hold；规则抛错 → 保守 hold + 官方日志文案。
3. 释放点：headless 与交互路径都在 settings/环境应用完成后 `release()` 并踢一次 flag fetch；打点 `before/after_held_growthbook_init`。
4. 确认 OCC 的 global agent（proxy dispatcher）在释放后的 fetch 时已按项目 env 重建；若不是，释放点须在 `applyConfigEnvironmentVariables` + `configureGlobalAgents` 之后。

测试：
- 单测：settings env 非空 → 首个 initialize 返回 null 且不发 HTTP；release 后 fetch 发出；env 全空 → 不 hold。
- e2e：项目 `.claude/settings.json` 设 `env.HTTPS_PROXY` 指向本地 mitm stub，`occ -p` 冷启动，断言 stub 收到 `/api/features/` 请求（即首个 flag 请求走了项目代理）。

---

## Item 5 — HTTP MCP server 超大响应导致无界内存

### 官方机制

289 @~234631097 只有 per-SSE-event 上限（`bxe`=16777216 @289:207400875，"without an SSE event boundary"，HttpBodyOverflowError，`pr(e)` transform，`it(e)` wrapper 跳过 locked/<=200/>599）。290 @~237918961 重写：

```js
at=rIe /*16777216 @210033370*/; fr=4*at /*64MiB*/; hr=/^\s*text\/event-stream\s*(?:;|$)/i;
// 错误类 ot：事件变体 "sent more than ${n}MB in one event of an event stream (no blank line ended it)"
//           整体变体 "sent a response larger than ${n}MB (counted after decompression)"
// transform yr(e,r)：累计"解压后"字节总量 + 当前事件字节，空行扫描分帧，每轮 setImmediate 8ms 让出
// wrapper ct(e)：有 DecompressionStream 时 fetch 用 decompress:!1，手动解压并计数；
//   content-encoding br/zstd → 直接抛 "sent a response compressed with br or zstd. Claude Code reads only gzip and deflate, so it did not read the response."
```

上限选择：默认 `L=at`(16MiB)；SSE 响应 `L = status===200 && 无 r/S 覆盖 && (method GET || header mcp-method===subscriptions/listen) ? Infinity : fr(64MiB)`。新字符串 0→3：`so Claude Code stopped reading it`、`counted after decompression`。

**语义**：总响应体（解压后计数）64MiB 硬顶 + 单事件 16MiB；gzip/deflate 手动解压计数（防压缩炸弹），br/zstd 拒读；长连 SSE 订阅流（GET/listen）不限总量但仍限单事件。

### OCC 现状

- `src/services/mcp/client.ts:786-830`：`MAX_MCP_RESPONSE_BYTES = 16MiB` 单一上限；`capMcpResponseBody` 把 body **全量累积在内存**再判断（content-length 预判 + 流式累计），无解压后计数（fetch 自动解压发生在计数之前/之后未区分）、无 64MiB 总量上限、无 per-event 上限。
- client.ts:841-843（GET/SSE 路径）**绕过** cap 与 timeout — 恰是官方 290 覆盖的场景（POST 响应 64MiB 顶；GET SSE 单事件 16MiB 顶）。

### 判定

**STAGED**。

### 移植方案 + 测试计划

方案（`src/services/mcp/client.ts`）：
1. 常量：`MCP_EVENT_MAX_BYTES = 16MiB`、`MCP_BODY_MAX_BYTES = 64MiB`。
2. 请求侧 `decompress: false`（Bun fetch 支持时），自建 `DecompressionStream('gzip'|'deflate')` 管道并在解压后计数；`br`/`zstd` → 抛官方文案错误。
3. 流式 transform：空行分帧计 per-event 字节（超限抛 "sent more than 16MB in one event…"），累计总量（超 64MiB 抛 "sent a response larger than 64MB (counted after decompression)"），周期性 `setTimeout(0)` 让出事件循环。
4. 上限选择对齐官方：SSE content-type（`hr` 正则）+ 200 + GET 或 `mcp-method: subscriptions/listen` → 总量不限、单事件 16MiB；其余 → 64MiB 总量。移除现有 GET/SSE 绕过。
5. 错误消息统一追加 `so Claude Code stopped reading it` 语义（对齐官方字符串）。

测试：
- 单测（本地 HTTP stub）：70MiB JSON POST → 64MiB 处中断抛错；20MiB 单 SSE 事件 → 16MiB 处抛错；gzip 压缩的 70MiB（压缩后 2MiB）→ 仍被解压计数拦截；br 编码 → 拒读文案；GET SSE 长流多事件各 <16MiB → 不中断。
- 内存断言：处理 64MiB 响应时 RSS 峰值增量 < 128MiB（流式，不全量缓存）。

---

## Item 6 — 代理封锁（403）的 MCP server 启动时不再重试三次

### 官方机制

289 失败可重试谓词 `mCe` @~289:207975150 + `jWe`(@289:202590698) 把 `ERR_PROXY_TUNNEL` 一律视为可重试 → 代理 403 会在**所有**尝试中重试（延迟 `[500,1500,4000]` @289:217135707，循环 `ETt`/`DOn` @~289:217139400）。290 新增 `proxyConnectStatus`（0→5：@98606616、212262455、212262602、237965875、238261246）：失败路径 @~237966600 从 ERR_PROXY_TUNNEL 错误/cause 提取 CONNECT 状态：

```js
let E=x==="ERR_PROXY_TUNNEL"?[q,j].map((v)=>v&&typeof v==="object"&&("status"in v)?v.status:void 0).find((v)=>typeof v==="number"):void 0;
return{name:e,type:"failed",config:r,error:A,errorCode:x,...E!==void 0&&{proxyConnectStatus:E}}
```

新谓词 @~212262200：`HBt` = mCe + `if(e.proxyConnectStatus===403)return!1;`；`DBt(e){return e.type==="failed"&&e.proxyConnectStatus===403&&zVt.has(e.config.type??"")}`，`zVt=new Set(["http","sse","claudeai-proxy"])`；`LBt=HBt||DBt`。重试循环 `Pxt`/`U7t` @~219844000（延迟 `xxt=[500,1500,4000]` @219839923，与 289 相同）：`U7t(n,r,e=!0)` 过滤 `(HBt(d)||e&&DBt(d))`，`let C=m===xxt.length-1` → 代理 403 的 server **跳过中间重试**，只在最后一次尝试时再拨一次。遥测 `tengu_mcp_connect_retry_attempt` 不变；新增 `tengu_mcp_first_tools_list`。

### OCC 现状

- `src/services/mcp/client.ts:938`：`connectToServer` memoize 单次尝试；无 `[500,1500,4000]` 连接期重试循环（官方 289 已有的循环本身是 OCC 既有缺口，非本条目范围）。
- 403+`insufficient_scope` → OAuth step-up（auth.ts:1664-1684）；`requestToolsListWithRetry`（client.ts:2137-2170）只针对**已连接** server 的 tools/list（3 次/500ms 线性）；断线重连退避在 useManageMCPConnections.ts:89-91,484（5 次 1s→30s）。
- `ERR_PROXY_TUNNEL`/`proxyConnectStatus` 源码 0 命中（grep 空）。

### 判定

**NO-OP** — 官方修的是「连接期 3 次重试循环对代理 403 也重试」的回归；OCC 连接期根本没有该重试循环，回归不存在，无可移植的 delta。备注：若日后移植官方 289 代际的 MCP 连接重试循环（`[500,1500,4000]`），必须连同 290 的 `proxyConnectStatus` 提取 + `HBt/DBt` 谓词一起落地，避免把已修复的回归重新引入。

### 测试计划

无代码变更。防回归断言（可并入现有 MCP 单测）：mock 代理对 http server CONNECT 返回 403 → `connectToServer` 只拨号一次（拨号计数===1），失败结果直达 UI。

---

## Item 7 — 睡眠中断的响应在 Bedrock/Vertex/Foundry/自定义网关上被误判为 stalled stream

### 官方机制

290 新增睡眠/挂起判定 `hI` @~208934xxx：

```js
hI(e,{armedAt,wallArmedAt,idleMs}) → {lateMs,sleptMs,suspended:lateMs<-idleMs/2&&sleptMs>idleMs/2}
```

`uVo` 包装**事件级** idle timer 触发：挂起时日志 `Streaming idle timer fired across sleep/suspend: late=...ms slept=...ms, aborting stream` 并返回 `Pyt`（StreamSuspendedError，code `"StreamSuspended"`）。290 timer：`Gb=he.setTimeout(()=>{if(y_=uVo(he,{armedAt:Qa,wallArmedAt:wa,idleMs:Ob}),y_!==void 0){Q_();return}...`；query 循环 `if(y_!==void 0)throw y_` @~212881651。289 的事件 timer（`CS=he.setTimeout(()=>{Dp=!0,...`）**无**睡眠检查 — 这就是 Bedrock/Vertex/Foundry/gateway 误判 stalled 的根因：字节看门狗按 provider 门控（`hw(e)=e==="firstParty"&&ri()||e==="anthropicAws"&&!process.env.ANTHROPIC_AWS_BASE_URL`，`dI(e)=hw(e)||e==="bedrock"&&CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK`），这些 provider 依赖事件级 timer，而它用墙钟差值判 idle。重试引擎新增 `maxSleptThrough` 预算（偏移 98842564、212763504、212765190、212826997）：

```js
zJt(e,n,r){return e.sleptThrough<n.maxSleptThrough?{decision:"retry",counts:{...e,sleptThrough:e.sleptThrough+1}}:UM(e,n,r)}
// car case"suspended": if(r)return W; return n==="partialOutput"?UM(g,h,W):zJt(g,h,W)
// hKe case"noResponse": return e.suspended?zJt(n,r):UM(n,r)
```

即：挂起导致的中断在预算内按「可重试」处理（换新连接重发），而不是当 stall 消耗普通重试预算/直接失败。`StreamSuspended` 字符串 289:8/290:9/291:9（289 已有字节看门狗路径的 `RFt` 类；290 把它接到事件级 timer + 重试预算）。

### OCC 现状

- `src/services/api/claude.ts:2714-2747` `resetStreamIdleTimer`：纯墙钟 `setTimeout` + `Date.now()`（`STREAM_IDLE_TIMEOUT_MS` 默认 300s，`STALL_THRESHOLD_MS=30s`）；**无** monotonic/wall 差值比较，睡眠唤醒后 timer 立即触发即按 stalled 处理。
- `QueryEngine.ts:157-162` 已有 `monotonicNow`（performance.now）但未接线到流式 idle 判定。
- `StreamSuspended`/`sleptThrough`/`maxSleptThrough` 源码 0 命中（grep 空）；仅 `src/cli/transports/WebSocketTransport.ts:705-734` 对 WS 有睡眠检测。

### 判定

**STAGED**。

### 移植方案 + 测试计划

方案：
1. `claude.ts`：idle timer 臂时同时记 `armedAt=performance.now()` 与 `wallArmedAt=Date.now()`；触发时算 `lateMs = (monoNow-armedAt) - idleMs`、`sleptMs = (wallNow-wallArmedAt) - (monoNow-armedAt)`；`suspended = lateMs < -idleMs/2 && sleptMs > idleMs/2`（官方 `hI` 逐字）。
2. 挂起 → abort 并抛 `StreamSuspendedError`（`code: 'StreamSuspended'`），日志对齐官方文案；否则走现有 stalled 路径。
3. 重试引擎：新增 `maxSleptThrough` 计数预算（对齐 `zJt`）：suspended 且无 partial output → 预算内 retry（fresh connection），超预算走普通错误路径；`noResponse` 变体对齐 `hKe`。
4. 该修复对所有非 firstParty provider（bedrock/vertex/foundry/gateway）生效——OCC 无字节看门狗 provider 门控差异，直接在事件级 timer 统一接线即可（等价于官方对这些 provider 的行为）。

测试：
- 单测（fake clock）：mono 走 10s、wall 走 400s（idleMs=300s）→ 判 suspended，不判 stalled；mono/wall 同步超时 → stalled 原路径。
- 单测：suspended 错误在预算内触发重试且计数 +1，超预算不再重试。
- e2e：mock 网关流中途挂起响应头后延迟投递（模拟睡眠），`occ -p` 断言最终成功完成而非 stalled 错误。

---

## 附：取证方法备注

- 宽 `grep -oE` 在 55MB 单行 strings 文件上会超时；一律用 `grep -aboF` 定位偏移 + `tail -c +N | head -c M | tr -c '[:print:]\n' ' '` 取上下文。
- 计数用 `grep -oF ... | wc -l`（`grep -c` 数行不数次数，strings 文件单行巨大，会漏计）。
- 290→291 无本簇相关 delta（关键字符串计数全等），291 无需单列。
