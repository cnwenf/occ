# OCC-112 上游版本差距台账(2026-09-02,官方 2.1.251 → 2.1.252 追平轮)

官方 `latest` 于 2026-08-31 提升到 **2.1.252**(此前以 `next` 预发布 ~14 小时后提升)。
OCC 2.1.318 已对齐 2.1.251(OCC-110 追平 + OCC-111 参数面自验收修复),本轮追平
2.1.252。changelog 共 4 条:1 条移植(**Gap-112c**),1 条经探针证明 OCC 已达标
(无需动作),2 条不适用;另在二进制取证中发现并修复 2 处**存量偏差**
(**Gap-112a/b**,2.1.251/2.1.252 二进制均存在,本轮首次发现)。

## 1. 版本状态(三方核实,2026-09-02)

| 渠道 | 版本 | 核实方式 | 结论 |
|---|---|---|---|
| npm `latest` | 2.1.252(2026-08-31 发布) | `npm view @anthropic-ai/claude-code version dist-tags --json` | 比 OCC 对齐基线(2.1.251)高 1 版 |
| GitHub latest release | v2.1.252 | `gh api repos/anthropics/claude-code/releases/latest` | 与 npm latest 一致 |
| 官方二进制 | 2.1.252 linux-x64 ELF(≈205 MB) | `npm pack @anthropic-ai/claude-code-linux-x64@2.1.252` + strings 取证 | 347 个 `2.1.252` 串命中,无 `2.1.253+` 标记 |
| OCC 当前 | 2.1.318 | `package.json` / dist 注入 `MACRO.VERSION` | 本轮发布 2.1.319 |

## 2. 官方 2.1.252 changelog 逐条分诊

### 条目 1 —「Fixed Bash commands failing with "task output swap refused (tasks dir moved or linked)" on some Macs」

**判定:不适用。** 该修复针对官方 agent-view 后台会话的 tasks 目录 swap 机制
(macOS 上目录被移动/软链时的特定失败)。OCC src 中 `swap refused` / `tasks dir moved`
零命中 —— OCC 没有该 swap 表面,无可移植对象。

### 条目 2 —「Fixed "always allow" not saving in a project that has no .claude/settings.local.json yet」

**判定:OCC 已达标(探针实证,无需动作)。** 该修复点 = 「项目尚无
`.claude/settings.local.json` 时,权限对话框『always allow』写入失败」。OCC 侧探针
(在全新 git 目录、无 `.claude/` 下调用
`addPermissionRulesToSettings({ruleValues:[{toolName:'Bash',ruleContent:'touch:*'}],ruleBehavior:'allow'},'localSettings')`):
- 返回 `true`;
- `.claude/settings.local.json` 被**创建**,内容为
  `{"permissions":{"allow":["Bash(touch:*)"]}}`。

写入链路 `updateSettingsForSource` 会递归创建目录与文件
(`getSettingsRootPathForSource` → localSettings 取 canonical git root)。OCC 不存在
该 bug,changelog 级记录为「已达标」,不产生代码变更。

### 条目 3 —「Fixed Remote Control sessions hosted by Claude Desktop or VS Code stalling for minutes after a tool finished when the connection to claude.ai was degraded」

**判定:不适用。** Remote Control 会话宿主是 Claude Desktop / VS Code + claude.ai
连接,OCC 无此表面(src 中仅 ConfigTool/settings 表面出现名称引用,无会话宿主实现)。

### 条目 4 —「Fixed background task notifications with very large failure output (for example git errors on a full disk) making the conversation exceed the API request size limit」

**判定:移植 → Gap-112c(本轮核心落地项)。** 见 §3。

## 3. 本轮落地项(全部字节取证 + 实测)

取证基准:官方 2.1.252 linux-x64 ELF(`/tmp/cc-diff-112/v2.1.252/package/claude`,
strings -n 8 + `LC_ALL=C grep -aboF` + `dd` 字节窗口);对照 2.1.251
(`/tmp/cc-diff-108/v2.1.251/package/claude`)。

### Gap-112c(条目 4)— 任务通知入队前 100k 中段截断

- **官方机制(2.1.252 新增,251↔52 字符串 diff 确认)**:通知入队函数在入队前
  对 `mode==="task-notification"` 的字符串值做上限截断:
  - 常量模块:`var T9=50000,dDe=500000;var Vgt=4,lYn=400000,cYn=200000,mw=50,uYn=1e4,k5e=1e4,dYn=1e5;`
    → 通知上限 **`dYn=100000`**(`k5e=10000` 是截断器默认值,通知处显式传 100000);
    字节偏移 @179431900。
  - 入队处:`if(Rn.mode==="task-notification"&&typeof Rn.value==="string"){let Mr=af(Rn.value,dYn);…lr={…Rn,value:Mr}}`,
    并打 warn 日志 `` `enqueuePendingNotification: task-notification capped from ${from} to ${to} chars` ``
    (@180252520)。
  - 截断器 `af`(@180243457):`e.length<=t+1024`(slack `f4t=1024`)原样返回;
    否则 head=⌊t/2⌋、tail=t-head,经 `Cke`(@174698656)拼接;
    标记 `` `\n\n... [${N} characters truncated] ...\n\n` ``(`h4t`),
    嵌套标记(g4t 正则 `/\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/g`)
    在删除中段里出现时,其「声称截断数 − 标记自身长度」折叠进 N。
  - `Cke` 调 `ce`(head,丢弃悬空高代理 0xD800-0xDBFF,@174698378)与
    `kg`(tail,丢弃悬空低代理 0xDC00-0xDFFF,@174698520),不劈裂代理对。
- **OCC 落地点**:
  - 新增 `src/utils/truncateMiddle.ts`:`TASK_NOTIFICATION_CHAR_CAP = 100_000` +
    `truncateMiddleWithMarker(value, cap)`(af/Cke/ce/kg 全量移植,行为契约逐条对应);
  - `src/utils/messageQueueManager.ts`:`enqueuePendingNotification` 入队前对
    `task-notification` 字符串值套上限,触发截断时打同文案 `logForDebugging(…, {level:'warn'})`,
    且以新对象入队(不改调用方命令对象)。
- **与既有代码的关系**:`src/utils/toolErrors.ts` `formatError` 已有 10000 字符同格式
  中段截断(OCC-107 遗留),那是工具错误格式化层;本次是**队列入队层**的独立上限,
  两层并存与官方一致(官方同样两处都有)。
- **测试**:`src/utils/__tests__/truncateMiddle.test.ts`(8 用例:边界 1024 slack、
  头尾切片、嵌套折叠、双向代理对、100k 常量、300k 值无孤代理)+
  `src/utils/__tests__/taskNotificationCap252.test.ts`(5 用例:超限入队被截 + 标记 +
  `later` 优先级、slack 内原样、非 task-notification 模式不动、非字符串值不动、
  调用方对象不被原地修改)。

### Gap-112a(存量偏差,本轮发现)— Bash 同意对话框只应用「已展示」建议类型

- **官方机制(2.1.251 与 2.1.252 均存在)**:Bash 权限对话框的建议束先经
  `DH(suggestions,{displayedTypes:WTt,…})` 过滤,`WTt=new Set(["addRules","addDirectories"])`;
  `yes-apply-suggestions` 分支应用的是过滤后的束(`I.applies`)—— `setMode` 等
  建议类型**从不**经该对话框被应用。
- **OCC 存量偏差**:OCC 直接应用原始建议束(含 `setMode`),即用户在 Bash 对话框
  选「yes, and don't ask again」时可能连带切换权限模式 —— 官方不会。
- **落地**:`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx`
  `yes-apply-suggestions` 分支改为只应用 `addRules`/`addDirectories` 类型。
- **行为影响**:收紧而非放宽(安全方向);配合 Gap-112b,「yes-apply-suggestions」
  后模式不再被意外切到 acceptEdits。
- **测试**:行为级由 REPL e2e 覆盖(选项 2 后 `/status` 模式不变);源码层改动为
  过滤表达式,单元层无独立纯函数可测。

### Gap-112b(存量偏差,本轮发现)— setMode 建议按会话模式门控(含 prePlanMode 子门)

- **官方机制(2.1.251 与 2.1.252 均存在,各 2 处命中;2.1.252 装饰点
  @180882400 字节窗口全文取证)**:路径校验为 write/create 生成建议时:
  ```
  let R=u.mode==="plan"&&(u.prePlanMode==="auto"||u.prePlanMode===
    "bypassPermissions"||u.prePlanMode==="acceptEdits"||u.prePlanMode===
    "dontAsk");
  if((v==="write"||v==="create")&&(u.mode==="default"||u.mode==="plan")&&!R)
    A.push({type:"setMode",mode:"acceptEdits",destination:"session"});
  ```
  —— 仅在会话处于 `default`/`plan` 模式时**提议**切 acceptEdits(已经在
  acceptEdits/bypassPermissions 等模式时提议无意义);且 `plan` 模式若是由
  已提权的 pre-plan 模式(auto/bypassPermissions/acceptEdits/dontAsk)进入,
  同样抑制 —— 接受该建议会降低有效权限级别。
- **OCC 存量偏差**:OCC 无门控,任何模式下都提议。
- **落地**:`src/tools/BashTool/pathValidation.ts` `createPathChecker` 建议生成处
  增加 `(context.mode === 'default' || context.mode === 'plan')` 门 +
  `!planFromElevatedPrePlanMode` 子门(`prePlanMode` 已在 OCC
  `ToolPermissionContext` 上,`src/types/permissions.ts:473`)。
- **行为影响**:仅影响「对话框里展示哪些建议」,不影响允许/拒绝判定(安全中性)。
- **测试**:`src/tools/BashTool/__tests__/acceptEditsModeGate252.test.ts`
  (6 用例:default/plan 提议、acceptEdits/bypassPermissions 不再提议、
  plan+4 种提权 prePlanMode 抑制、plan+default prePlanMode 不抑制,
  addDirectories 不受影响)。

## 4. 验收门

- **新增单测**:19 用例(3 个新测试文件),全绿。
- **全量门**:`scripts/ci-test.sh`(逐文件进程隔离)—— 3407 pass / 15 fail /
  12 skip(基线 3388 + 19 新增;15 个失败全部为此前轮次已记录在案的环境性
  tmux/模型 e2e,与本轮改动无关;零回归)。
- **构建**:`bun run build` 绿(`dist/cli.js` ≈28.98 MB,`MACRO.VERSION=2.1.318` →
  发版时 2.1.319)。
- **REPL e2e**:真机 tmux REPL(`/debug` 调试日志全程开启)——
  - Gap-112a 行为实证(两轮):Bash 权限对话框选项 2(yes-apply-suggestions)
    应用后 `/status` 权限模式保持 `⏸ manual mode on` 不变(官方行为);
    debug 日志证实仅 `addDirectories` 被 reducer 应用
    (`Applying permission update: Adding 1 directory with destination
    'session'`),`setMode` 未被应用。
  - **授权后对同目录第二个写文件再次弹同一 addDirectories 对话框 —— 经二进制
    取证判定为官方同等行为,非缺陷**(见 §5)。

## 5. 遗留 / 下轮关注

- **「目录授权后写操作再次询问」= 官方同等行为(本轮取证结案)。**
  2.1.252 二进制 `_w`(isPathAllowed 等价物,@178998030)与 OCC
  `src/utils/permissions/pathValidation.ts` 第 3 步字节级一致:
  ```
  let c=Y_(t,e,s);if(c){if(i==="read"||e.mode==="acceptEdits")return{allowed:!0}}
  … return{allowed:!1,isInWorkingDir:c}
  ```
  即 default/manual 模式下,工作目录内的 write/create **不因目录授权自动放行**,
  落入 allow 规则检查;官方 ask 生成点(@180881100 `Otn`)对此场景返回
  `{behavior:"ask",blockedPath,…,bashAllowRuleOverridable:true}`,装饰点照样
  附 addDirectories+setMode 建议 —— 与 REPL 观察到的 d2 再次询问逐字一致。
  目录授权自动放行的是**读取**与 **acceptEdits 模式下的写**;default 模式下
  止住写询问的正确路径是命令级 allow 规则(如 `touch:*`)或 acceptEdits 模式。
  Gap-112a 结论不受影响(该取证恰恰依赖「选项 2 不切模式」这一已实证行为)。
- **staged:`bashAllowRuleOverridable` 多路径延迟返回。** 官方
  `_w` 在 not-allowed 结果里回传 `isInWorkingDir`,`Otn`/`F` 编排对
  「目录内但无规则」的软 ask 做延迟(`O??=Ee;continue`),让其他路径的硬
  block 优先呈现。OCC 未移植该编排细节(2.1.251/252 均存在):单路径命令
  (绝大多数场景)可见行为完全一致;仅多路径命令中「软 ask 与硬 block 并存」
  时呈现顺序可能不同。涉及 isPathAllowed 返回面 + 校验编排两层结构改动,
  回归风险与收益不成比例,按纪律不在本轮扩面,留档下轮评估。
- 2.1.252 无其他可移植表面:4 条 changelog 全部分诊完毕(1 移植 / 1 已达标 /
  2 不适用);251↔252 二进制 strings diff 中的其余新增项为此前轮次已记录在案的
  staged 面(后端/平台专属或需要专项反编译),维持 staged。
- Gap-112a/b 为存量偏差,2.1.251 也存在 —— 说明上一轮(2.1.251)分诊未覆盖到
  「建议束过滤」这一细粒度表面;本轮已补(含 prePlanMode 子门),无进一步欠账。

## 6. 发版

- **2.1.319**:本轮全部变更(3 源文件改动 + 4 新文件)合入 `main`,
  `CHANGELOG.md` + `package.json` 版本提升,`v2.1.319` tag 触发
  `.github/workflows/publish.yml`(build → npm publish → `gh release create`)。
- releases/tags 数量对账:`gh api repos/cnwenf/occ/releases` 与 `/tags` 一致
  (`comm -23` 为空)。
