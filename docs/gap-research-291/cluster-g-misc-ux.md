# Cluster G — misc UX / i18n / config 语义 · 2.1.289 → 2.1.290/291 gap 调研

调研方法：官方三个版本 ELF 二进制（/tmp/cc289|cc290|cc291/package/claude，**仅只读取证，从未执行**）
`grep -aboF` 字节偏移 + `tail -c/head -c` 上下文提取；strings 集差 new-in-290.txt / new-in-291.txt /
gone-from-289.txt；OCC 侧 `src/` file:line 逐条核对（3 个只读 Explore 子代理 + 主线复核）。
md5：289=`5c920e4c2e6c73c2858cc48e5123582e`，290=`acc2b427816611d7c48666fd4b1cf9b7`，291=`82c1f303d0dd7ef19d869f7b3d886043`。

判定口径：**PORTED**=OCC 已与修复后官方一致；**STAGED**=OCC 处于修复前状态/缺官方语义，给出移植方案+测试计划；
**NO-OP**=条目针对官方特有实现细节，OCC 架构不同且目标行为已满足或不可复现；**N-A**=OCC 无该 surface（grep 证明）。

## 判定总表

| # | 条目（2.1.290 changelog） | 判定 | 优先级 |
|---|---|---|---|
| 1 | "You should know" 笔记无视 `language` 设置写英文 | **N-A**（内置 mod，OCC 无 surface） | — |
| 2 | `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS=5m` 被读成 5ms | **N-A**（env/setting 均不存在，KAIROS 休眠） | — |
| 3 | `/`、`@` 建议列表选中行加 `❯` 指针 | **STAGED** | P2 |
| 4 | Bash changed-files 视图：链式 git merge/pull/checkout 只列文件名 | **N-A**（OCC 无该视图；官方改动为逻辑级、无字符串证据） | — |
| 5 | Read 二进制文件提示指向 skill / shell 命令 | **STAGED**（OCC 逐字保留修复前文案） | **P1（一行改动）** |
| 6 | "Press ← again" 确认去掉 1 秒等待、长按可切换 | **N-A**（OCC 的 ← 是单击直入，无确认态） | — |
| 7 | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 同时跳过启动 preconnect | **STAGED** | **P1（三行改动）** |
| 8 | WebSearch 预算按小时回填（100/时，`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`） | **STAGED**（官方令牌桶机制已逐字提取） | **P1** |
| 9 | 文件名含换行在文件工具报错/权限提示中显示错乱 | **STAGED**（官方 `&#NN;` 转义器已逐字提取；OCC 全部裸插值） | **P1（含安全含义）** |
| 10 | skill 按 SKILL.md `name:` 找不到；列表显示双名 | **一半 PORTED（调用已双名匹配）/ 一半 STAGED（列表单名）** | P2 |
| 11 | Bash 首命令在新配置目录上丢失 aliases/functions/PATH | **NO-OP**（OCC await 快照结构免疫；另有 OCC 特有退化路径已记录） | — |
| 12 | 未装 git/gh 时报 "Premature close" 而非程序名 | **NO-OP**（OCC 实测已报程序名；该串无法从 OCC src 产生） | — |
| 13 | skills/自定义命令拒绝含控制字符的 `!` 命令并指出位置 | **STAGED** | P2 |
| 14 | `plansDirectory` 项目根检查对反斜杠路径失效（macOS/Linux） | **STAGED** | P2 |
| 15 | 首次启动在 `claude auth login`/已有凭据后仍重问登录方式 | **STAGED** | P2 |
| 16 | macOS `/login` 在 keychain 拒绝写入并保留旧登录时谎报成功 | **NO-OP**（OCC 已有 #049 transient-throw + #30337 stale-delete + #35 outcome 上报） | — |
| 17 | Mac 睡眠期间 auto-compaction 以 "Prompt is too long" 放弃 | **NO-OP**（OCC 已有 290 时代 PTL 重试环 + 流 watchdog；官方睡眠逻辑不可提取） | — |
| 18 | mods `$.process.spawn` 拒绝语义变更 | **N-A**（OCC 无 mods `$` runtime，grep 证明） | — |
| 19 | `/code-review` medium 在无调优模型上也报 cleanup + CLAUDE.md conventions | **PORTED**（OCC 无任何模型调优分支，medium 天然含两类产出） | — |
| 20 | （属 cluster D，跳过） | — | — |

---

## 1. "You should know" 笔记语言跟随 `language` 设置 → **N-A**

### 官方机制
- 该功能是官方**内置 mod**（plugin 形态）：291 新串 `"You should know, a built-in mod where a side agent watches your back… Turn it on with /plugi[ns]"`；`cc-plugin-you-should-know` 在 new-in-291.txt 出现 4 次。
- 修复本体 = 笔记生成 prompt 新增语言指令（289 中 `Write the learn line` 0 命中；290/291 新增，逐字）：

```
Write the learn line, the title and the explanation in the language the
session's Language instruction names; if there is none, in the language the
user has been writing in. Keep the labels learn:, tag:, explain:, the word
none, and the tags You should know / Heads up exactly as written, in English.
```

### OCC 现状
- `grep -rniI "you should know|you_should_know|suggest-learning|Heads up" src packages test` → **0 命中**（仅 docs/ 旧调研文档提及）。
- 内置 plugin 注册表是空脚手架：`src/plugins/bundled/index.ts:22` `initBuiltinPlugins()` 注释 "No built-in plugins registered yet"；proactive 侧代理面是硬 stub（`src/proactive/index.ts`，`PROACTIVE`/`KAIROS` 均不在 `src/utils/featureFlags.ts:13` FEATURE_ALLOWLIST）。

### 判定
**N-A（NO-SURFACE）**。功能本体（内置 mod + 侧代理 + AbovePrompt 渲染）在 OCC 不存在，语言修复无从谈起。与 cluster F mods 文档的 13×NO-OP{NO-SURFACE} 结论一致。若未来移植 "You should know" mod 本体，此 prompt 语言指令必须一并带上（本文已存逐字文本）。

---

## 2. `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS=5m` 被读成 5ms → **N-A**

### 官方机制
- 289 @206497701（逐字）：

```js
var QJ=300000,jFr={"60s":60000,"5m":300000,"10m":600000};
function ZJ(e){switch(e){case"60s":case"5m":case"10m":return jFr[e];case"never":return 0;case void 0:return}}
function Mre(){return a.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS??ZJ(gKt())??QJ}
```

  即：env 原值优先 → `dialogExpiry` 设置枚举映射（60s/5m/10m/never）→ 默认 300000ms。bug：env 值 `"5m"` 直接进数值通道被解析为 5ms → 远程对话框立即取消。
- 291 @208849692 结构相同（`mse`/`UJ`/`I5t`/`BJ`），修复为带单位后缀的值改走 `dialogExpiry` 枚举通道；精确 parse 改动点不可字符串隔离（逻辑级）。
- 291 新增（@207679323）：该 env 名进入 settings-env 过滤表 `"CLAUDE_CODE_JOB_DIR","CLAUDE_CODE_REMOTE_TOOLS_FORWARD","CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS","CLAUDE_AFK_TIMEOUT_MS",…`（"this key can only come from the environment Claude Code is started with"）。

### OCC 现状
- `grep -rn "USER_DIALOG_TIMEOUT" src packages test scripts bin` → **0 命中**。
- `dialogExpiry` 在 src/ 仅 1 处**注释**：`src/utils/settings/policyLocks.ts:162-170`（官方锁表字节对位说明，非锁条目）；`src/utils/settings/types.ts` 无 `dialogExpiry`/`askUserQuestionTimeout` schema 键。
- 远程对话框转发存在两向：出站（本地→claude.ai 桥）被 `feature('BRIDGE_MODE')` 关死（`src/hooks/useCanUseTool.tsx:165`，不在 allowlist）；入站（远程→本地对话框，`src/hooks/useRemoteSession.ts:332-364`）活着但**无任何超时定时器**（`src/remote/*` 的 timeout 全是 WebSocket ping/重连）。
- `askUserQuestionTimeout` 仅出现在 `/config` 键列表（`src/commands/config/config-noninteractive.ts:22`），且写入器因 schema 无此键而**静默不落盘却打印成功**（`:156-169`，OCC 自有 cosmetic bug，另案）。

### 判定
**N-A（NO-SURFACE）**。被修的 env/setting 双通道在 OCC 都不存在，任何远程对话框路径上也没有到期定时器可被 5ms 误值取消。`dialogExpiry` 归属 KAIROS 休眠面（`docs/upstream-version-gap-occ65.md:94`）。若未来启用 KAIROS/BRIDGE_MODE，官方解析链（env 原值 → 枚举映射 → 300000 默认）需按上文逐字移植，且**不要**复刻 289 的裸 env 数值优先 bug。

---

## 3. `/`、`@` 建议列表选中行以 `❯` 开头 → **STAGED（P2）**

### 官方机制
- 字符串取证不可得：字面 `❯` 在 289/291 应用代码区 0 命中（仅 Bun 运行时数据区 289:7 / 291:6 处噪声）；`\u276f` 两版各 13 命中且全部位于 Unicode 标点正则表。**建议列表渲染器位于 bytecode chunk**（291 含 2235 个 `@bytecode` 标记），无文本证据。
- 依据 = changelog 本身（2.1.290，逐字）："Improved the / and @ suggestion lists: the selected row now starts with a ❯ pointer"。语义明确：选中行行首渲染 `❯ `，非选中行无指针。

### OCC 现状
- 渲染器 `src/components/PromptInput/PromptInputFooterSuggestions.tsx`（304 行，`/` 与 `@` 共用）：选中态**仅靠颜色**（`color="suggestion"` vs `dimColor`）。
  - `@` 行（`:24-29,56-57,112-118`）：行首是类型图标 `+`/`◇`/`*`，**每行都有**，不携带选中语义；
  - `/` 行（`:130-131,146-147,162`）：行首直接是补空格的 `/name`，无任何前缀槽。
- `grep -rnE "pointer|❯" PromptInputFooterSuggestions.tsx` → **0 命中**。`❯` 在 OCC 已存在于对话框体系：`src/components/design-system/ListItem.tsx:11`（`figures.pointer`，isFocused 时渲染）、FuzzyPicker/CustomSelect/SelectMulti；prompt 字符本身也用 `figures.pointer`（`PromptInputModeIndicator.tsx:54`）。
- 后果：NO_COLOR/单色终端/读屏用户无法分辨选中行——正是官方本条修复的动机。

### 判定 + 移植方案
**STAGED**。方案（对齐 ListItem 既有习惯，用 `figures.pointer` 而非硬编码 `❯`，Windows 自动降级 `>`）：
1. `PromptInputFooterSuggestions.tsx` 两个 row 分支（`SuggestionItemRow` 统一行 `:112-118`、命令行 `:146-162`）行首加固定宽前缀：`isSelected ? figures.pointer + ' ' : '  '`（非选中行用等宽空占位，防止列抖动；官方是否保留占位无字节证据，取无跳动实现并在 issue 里注明）。
2. 宽度计算（`maxColumnWidth`/`displayTextWidth` 补空格逻辑）相应减 2。
3. 测试计划：
   - 单测：渲染 3 项列表、selected=1，断言仅该行以 `❯ ` 开头且其余行等宽；
   - e2e（tmux capture-pane，行为级）：REPL 输入 `/hel`，capture 断言选中行含 `❯`，按 ↓ 后指针移动；
   - NO_COLOR=1 下重复 capture，断言指针仍在（颜色失效时的可辨性即本条修复目标）。

---

## 4. Bash changed-files 视图：链式 git merge/pull/checkout 只列文件名 → **N-A**

### 官方机制
- 视图本体在 289/291 都存在（非 290 新增）：289 @230123961 / 291 @233289650 渲染器逐字含
  `E.length>x3?r(n,{dimColor:!0,children:["diffs hidden above ",x3," files"]}):E.map(...)` ——
  折叠态（flag `H`）渲染 `{path, linesAdded, linesRemoved}` 名字行，展开态渲染 `{filePath,hunks,isBinary,isLargeFile,isTruncated,isUntracked}` 全 diff。
- 结果 schema（new-in-290 行内描述，逐字节选）：`"…the diff of the working-tree changes this command made, for rendering and for PostToolUse Bash hooks (changedFiles: absolute paths of every changed file known, shown or not, at most 200; cut when shorter than files.length + moreFiles)"`；形状 `{files:[{filePath,hunks,created,deleted}],moreFiles,changedFiles,unavailable,skipped,shared}`。
- 本条改进（链式命令含 git merge/pull/checkout → 只列名不出 diff）是**折叠判定的逻辑改动**：`rg` 过 new-in-290.txt 的 changedFiles/Vcs/collapsed/nameOnly 全 token 集，289↔291 计数一致（changedFiles 28/28、linesAdded 63/63、collapsed 系 token 集合相同），无新字符串 → 判定逻辑在 bytecode 或以纯控制流差异存在，**无法字节隔离**。（291 @213159743 的 `isNormalizedGitCommand` 属 cd+git 权限链，两版都有，与本条无关。）

### OCC 现状
- **整个 changed-files 视图不存在**：`grep -rniE "changedFiles|changed files" src/tools/BashTool/` → 0；`UI.tsx`/`BashToolResultMessage.tsx` 无任何 diff/文件列表逻辑（仅 sed 单文件特例与 tmux 提示）。
- `src/utils/git.ts:416 getChangedFiles()`（`git status --porcelain` 列名）**零调用方**，是现成的死代码积木。
- turn 级 diff 只来自文件工具（`src/hooks/useTurnDiffs.ts` 要求 structuredPatch）。

### 判定
**N-A（NO-SURFACE）**。被"改进"的宿主视图在 OCC 缺失，本条无从对齐。底层缺口（Bash 后置 changed-files 视图 + PostToolUse `changedFiles` 入参）是 289 之前的既有上游 gap，不属本轮 changelog，建议单独立项；届时本条的折叠语义（链式 git merge/pull/checkout → 名字列表，`diffs hidden above N files` 文案，200 路径上限）按上文证据一并实现。

---

## 5. Read 工具二进制文件提示指向 skill / shell 命令 → **STAGED（P1，一行）**

### 官方机制
- 289（@99591407、@208436591，逐字）：
  `` `This tool cannot read binary files. The file appears to be a binary ${V} file. Please use appropriate tools for binary file analysis.\`,errorCode:4 ``
- 291（@99735379、@213502921；289 中该新文案 0 命中，逐字）：
  `` `This tool cannot read binary files. The file appears to be a binary ${Y} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.\`,errorCode:4 ``
- 变化点仅尾句：`Please use appropriate tools for binary file analysis.` → `Use a skill for this file type if one is available, or a shell command or script that can read the format.`（errorCode、前半句、`${ext}` 插值不变。）

### OCC 现状
- `src/tools/FileReadTool/FileReadTool.ts:628` **逐字保留 289 修复前文案**：
  `` message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.` ``（`errorCode: 4`，扩展名判定链 `hasBinaryExtension && !isPDFExtension && !IMAGE_EXTENSIONS` 与官方一致）。
- `:628` 是该文件唯一用户可见 binary 文案（`:203/508/574/673` 为检测逻辑）。

### 判定 + 移植方案
**STAGED**。方案：把 `FileReadTool.ts:628` 尾句替换为官方 291 逐字文本（保持 `${ext}` 插值与 `errorCode: 4`）。
测试计划：
- 既有断言旧文案的单测同步更新（`grep -rn "appropriate tools for binary" test src` 全量替换为官方新句）；
- e2e：`occ -p` 让模型 Read 一个 `.zip`/`.png` 之外的真二进制文件（如 `.woff2`），断言 tool_result 文本 == 官方 291 逐字串（含扩展名插值）；
- 字节对位复检：新文案与 `/tmp/cc291/package/claude` @99735379 上下文逐字 diff 为空。

---

## 6. "Press ← again" 确认：去掉 1 秒等待、长按 ← 即切换 → **N-A**

### 官方机制
- 官方在 agents/fleet 入口有 "Press ← again" 二段确认（changelog 2.1.290 逐字："Changed the 'Press ← again' confirmation so it no longer makes you wait a second before the second ← counts; holding ← down now switches"）。确认文案/计时器均在 bytecode，字符串不可隔离（`← again` 类串在两版 strings 中 0 命中）。

### OCC 现状
- **OCC 从未有该确认态**：`←` 在空 prompt 上是**单击直入** FleetView（`src/components/FleetView/FleetViewScreen.tsx:112,126-137`：`inputValue !== '' return` 后 `key.leftArrow && leftArrowOpensAgents` → `setFleetActive(true)`，无计时器、无二段状态）。
- 全仓 `grep -rniE "← again|left again|press again|again to switch"` → 仅 `Esc again to clear`（`src/hooks/useTextInput.ts:160`，800ms `DOUBLE_PRESS_TIMEOUT_MS` 体系）；`isRepeat|keyRepeat|autoRepeat` 在 hooks/PromptInput → 0 命中（OCC 不检测键盘重复）。

### 判定
**N-A**。被调整的确认交互在 OCC 不存在：无 1 秒等待可去掉（首击即切换，行为已优于官方修复后状态）；"长按切换"在单击直入语义下天然满足首击。无需任何改动；若未来给 ← 入口加确认态，须直接采用官方修复后语义（无等待 + isRepeat 支持），本文存档。

---

## 7. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 跳过启动连接预热 → **STAGED（P1，三行）**

### 官方机制
- 289 @216080021 preconnect（逐字，函数 `C`）：

```js
function C(){let e=Or().providerCache;if(e.preconnectFired)return;
 if(e.preconnectFired=!0,Me()!=="firstParty"||e9()==="gateway"||PWe())return;
 if(a.HTTPS_PROXY||a.https_proxy||a.HTTP_PROXY||a.http_proxy||a.ANTHROPIC_UNIX_SOCKET
   ||a.CLAUDE_CODE_CLIENT_CERT||a.CLAUDE_CODE_CLIENT_KEY)return;
 let o=a.ANTHROPIC_BASE_URL||pn().BASE_API_URL;
 z7(`${o.replace(/\/+$/,"")}/api/hello`,{method:"HEAD",signal:AbortSignal.timeout(1e4)}).catch(()=>{})}
```

- 291 @218728135（函数 `P`）：在 gateway 检查之后**新插入一行** `if(Rt())return;`，其余逐字相同。
- `Rt` 定义（291 @202248771，逐字）：`function Rt(){return HCt()==="essential-traffic"}`，`HCt` 即隐私级读取器（`if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)return"essential-traffic"`，两版一致）。
- 净语义：隐私级为 essential-traffic 时，启动阶段不再向 `{BASE}/api/hello` 发 HEAD 预热。

### OCC 现状
- `src/utils/apiPreconnect.ts:31-71` `preconnectAnthropicApi()` 与官方 289 逐结构对齐（provider 检查、proxy/mTLS/unix-socket 检查、`HEAD ${baseUrl}` 10s 超时、fire-and-forget），唯一调用点 `src/entrypoints/init.ts:153-159`。
- **无隐私门**：`init.ts` 全文无 privacy 检查；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 时 OCC 仍会发出该 HEAD（= 官方 289 修复前行为）。
- OCC 已有现成判定函数：`src/utils/privacyLevel.ts:34-36` `isEssentialTrafficOnly()`（全仓 17 处 gate 使用）。

### 判定 + 移植方案
**STAGED**。方案：`apiPreconnect.ts` 在 `fired = true` 之后、provider 检查之前（对齐官方插入位置——官方在 gateway 检查后，OCC 结构里等价于 provider 检查前后皆可，取与官方相同的"早退但仍置 fired"语义）加：

```ts
if (isEssentialTrafficOnly()) return
```

测试计划：
- 单测：mock fetch + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，断言 `preconnectAnthropicApi()` 零 fetch；未设 env 时恰一次 `HEAD …/api/hello`（既有行为回归）。
- e2e：env=1 下 `occ -p "hi"`，用本地 `HTTPS_PROXY` 指向记录型代理或 fetch spy，断言启动阶段无 `/api/hello` 请求。
- 字节对位：改后函数与 291 @218728135 上下文逐行比对，门顺序一致（preconnectFired → firstParty/gateway → privacy → proxy 族）。

---

## 8. WebSearch 预算按小时回填 → **STAGED（P1）**

### 官方机制
- 289 @207205373（扁平上限，逐字）：`var G=200;function wzo(){return a.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION??G}` —— 每会话 200 次，用尽即止。
- 291 @207943252 完整令牌桶（逐字节选）：

```js
var rn=200,te=100,$e="tengu_memoized_turtle",ze=3600;
function eQn(){return a.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION??rn}
function Ke({refillsByDefault:e}){let n=a.CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR;
 if(n!==void 0)return n;if(!e)return 0;
 /* GrowthBook $e 值 */ …if(Number.isInteger(o)&&o>=0&&o<=ze)return o;
 return t(`WebSearch budget: ignoring the served ${$e} value ${b(s)} (not an integer from 0 to ${ze}); using ${te} refills per hour`,{level:"warn"}),te}
var ne=3600000;
function Ye({refillsByDefault:e,now:n=()=>Date.now()}){ …
 tryConsume(){if(u(),r>=eQn())return!1;return r++,!0},
 msUntilNextCall(){…if(i===0)return 1/0;let g=(f+1)*ne-s;return Math.max(1,Math.ceil(g/i))},
 refillsPerHour(){return i}}
```

- 语义拆解：每小时 `i` 次回填（`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR` env 优先，**0=关闭回填**；无 env 时走 GrowthBook `tengu_memoized_turtle`，默认值/兜底 `te=100`，合法域整数 [0,3600]，非法值 warn 后用 100）；两次回填间隔 `3600000/i` ms；会话累计上限 `rn=200`（`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` 可改）仍然生效；`msUntilNextCall()` 供 UI/提示报时。会话存储构造签名 `Wm(e,n,{refillWebSearchBudgetByDefault:r=!1}={})`（交互 REPL 传 true）。
- changelog 措辞核对："budget now refills over time (100 calls/hour; `CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`, 0 disables) instead of ending after 200"。

### OCC 现状
- 扁平 200 上限（= 289 修复前）：`src/tools/WebSearchTool/WebSearchTool.ts:257-276`（超限**不报错**，返回合成 tool_result 提示模型停止搜索）；`src/utils/sessionLimits.ts:29,56-74`（`DEFAULT_MAX_WEB_SEARCHES_PER_SESSION=200` + `parsePositiveIntEnv`）；计数器 `src/utils/taskRegistry.ts:34-49`（可变，`resetWebSearchCalls` 无生产调用方）。
- 回填机制 **0 命中**：`grep -rn "WEB_SEARCH_REFILLS|REFILLS_PER_HOUR|refill" src`（除 --prefill UI 噪声）。
- headless 空洞：`-p`/SDK 模式挂 noop registry（`src/bootstrap/state.ts:1868-1870`），计数恒 0，上限永不触发——移植时保持该既有语义不变。

### 判定 + 移植方案
**STAGED**。方案（令牌桶按官方逐字语义，落在 `sessionLimits.ts` + `taskRegistry.ts`）：
1. `sessionLimits.ts` 新增 `getWebSearchRefillsPerHour(): number`：env `CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR` 定义即返回其整数解析（解析失败按官方无 env 分支处理）；无 env 时 OCC 无 GrowthBook 实值 → 直接取默认 **100**（OCC 的 `getFeatureValue_CACHED_MAY_BE_STALE` stub 会返回 defaultValue，把 default 设为 100 即等价官方 `te`；合法域 [0,3600] 校验 + warn 文案逐字采用官方串，flag 名占位 `tengu_memoized_turtle` 保持一致以便未来接真值）。
2. `taskRegistry.ts` 计数器改为桶：记 `used`（累计消耗，仍对 `getMaxWebSearchesPerSession()` 封顶——官方 `tryConsume` 的 `r>=eQn()` 上限检查原样保留）、`windowStart`；`tryConsume()` 每次先按 `refillsPerHour` 折算自 windowStart 起应回填的量抵扣 used（官方 `u()` 刷新函数的等价实现，`msUntilNextCall()` 公式 `(f+1)*3600000 - s`、`Math.max(1,Math.ceil(g/i))`、`i===0 → Infinity` 逐字对齐）。
3. `WebSearchTool.ts` 超限合成消息补报 `msUntilNextCall()`（官方 UI 是否展示无字节证据，消息文本改动保持 OCC 现有风格、仅追加"下一次可用时间"信息，issue 里注明此为 OCC 自定表述）。
4. 交互 REPL 之外的路径（headless noop registry）不动。
5. 测试计划：
   - 单测（fake clock）：i=3600 → 每 1000ms 回填 1 次；消耗 200 后 `tryConsume()===false`；推进 1h → 可用 100 次；env=0 → 永不回填（200 用尽即止，回归 289 行为）；env 非法（`abc`、`-1`、`4000`、`1.5`）→ warn + 100；累计上限 env `MAX_WEB_SEARCHES_PER_SESSION=5` 时 5 次即挡。
   - e2e：`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR=3600 CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=2 occ -p` 连发 3 次搜索请求，断言第 3 次在 ~1s 后成功（回填生效）而非永远被挡。

---

## 9. 文件名含换行在报错/权限提示中显示错乱 → **STAGED（P1，含安全含义）**

### 官方机制
- 291 新增独立转义模块（@205899620，逐字；该 export chunk 289 中 0 命中）：

```js
var n=/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,Owt=256,
    aCn=/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]/;
function vie(e){return e.length>0&&e.length<=256&&!aCn.test(e)}
function ad(e){return e.replace(n,(t)=>`&#${t.charCodeAt(0)};`)}
function vV(e){return e.replaceAll("<","&lt;").replaceAll(">","&gt;")}
function du(e){return ad(vV(String(e??"")))}
function bsr(e){return du(e).replaceAll('"',"&quot;")}
export{Owt,aCn,vie,tGe,hQo,PXr,yR,ad,vV,du,bsr}
```

  即：C0/C1 控制符 + U+2028/2029 → HTML 数字实体 `&#NN;`（换行显示为 `&#10;` 而不是真换行）；`vV` 转 `<>`；`du`/`bsr` 为组合器。
- 调用点示例（289 raw → 291 转义）：`Cannot read '${g}': this device file…` → `Cannot read '${ad(g)}': …`，覆盖文件工具报错与权限提示中的路径插值。

### OCC 现状
- **全部裸插值**，无任何转义：
  - 文件工具报错：`src/tools/FileReadTool/FileReadTool.ts:638`（`` `Cannot read '${file_path}': this device file…` ``）、`:793-800`（`File does not exist. … Did you mean ${cwdSuggestion}?`，FileEditTool.ts:358 同型）；
  - 工具头路径：`src/utils/file.ts:155-170 getDisplayPath()`（仅 relative/tilde 化）→ `FileReadTool/UI.tsx:49,183` 等裸渲染；
  - 权限提示：`FileEditPermissionRequest.tsx:64-70`（title=`basename(file_path)`、subtitle=`relative(getCwd(),file_path)` 裸传 `PermissionRequestTitle.tsx:23,49`），FileWrite/Sed 同型；
  - 渲染链只剥 underline SGR（`OutputLine.tsx:113-117`），不中和控制符；`wrap="truncate-start"` 不断换行。
- `grep -rnE "&#10;|&#x0a;" src/` → **0 命中**；已有 `CONTROL_FORMAT_RE`（`src/utils/textSanitize.ts`，把控制符折叠为空格）但只接线到 desktop deep-link / plugin URL 校验，**不是**官方 `&#NN;` 实体语义。
- 安全含义：含 `\n` 的文件名可在权限对话框里伪造行/伪造成按钮文案（spoofing），官方修复同时是显示修复与安全加固。

### 判定 + 移植方案
**STAGED**。方案：
1. 新建 `src/utils/displayEscape.ts`：逐字移植官方 `ad`（`escapeControlCharsAsEntities`）、`vV`（`escapeAngleBrackets`）、`du`、`bsr` 与 `vie`（`isPlainShortPath`，256 上限常量同 `Owt`）；正则逐字 `/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g`。
2. 接线（对齐官方调用面）：
   - `FileReadTool.ts:638` 及 `Cannot read '${…}'` 全家族 → `ad(file_path)`；
   - `FileReadTool.ts:793-800`/`FileEditTool.ts:358` 的 `Did you mean ${…}` 两个插值 → `ad()`；
   - 权限提示 title/subtitle（FileEdit/FileWrite/SedEdit PermissionRequest + `ShowInIDEPrompt` 的 basename/symlinkTarget）→ `ad()`；
   - `getDisplayPath()` **不改**（工具头是 Ink Text 渲染，官方是否对头部转义无字节证据；先只覆盖报错与权限提示两个 changelog 明点面，issue 注明）。
3. 测试计划：
   - 单测：`escapeControlCharsAsEntities("a\nb\rc\x00d\u2028e")` === `"a&#10;b&#13;c&#0;d&#8232;e"`；`vie` 边界（256/257、含 `<>`）；
   - 行为 e2e：`touch $'evil\napproved?.txt'` 后让模型 Read 它，断言 tool_result 单行显示 `&#10;` 且终端无额外换行；构造同名文件触发 Edit 权限对话框，tmux capture 断言对话框行数不随文件名内换行增长（反 spoofing）。

---

## 10. skill 按 SKILL.md `name:` 找不到；列表显示双名 → **调用侧 PORTED / 列表侧 STAGED（P2）**

### 官方机制
- 规范名模型（两版 settings 描述逐字）：skill 匹配 `"matching the exact canonical name (e.g. \"my-plugin:my-skill\") or a \":name\" suffix of it. Display names and aliases do not match…subagents use AgentDefinition.skills, which additionally resolves display names and aliases"`；canonical name 取 `name:e.directory||e.name||e.id`；skill 形状 `{name:w.name,displayName:w.display_name??w.name}`。
- 290 新增 MCP-skill 记录（@239826487，逐字节选）：`{...s({...n,…,displayName:sCn(n.displayName),skillName:P,markdownContent:f,source:"mcp",…})}`，`P=\`${Cn(e.name)}:${g}\``——即 displayName 与 canonical skillName **并存**于同一记录。
- 新报错文案（290+）：`"Invalid skill name …: parentheses, commas, and control characters are not allowed in skill names. Skill names match the skill's direct[ory]…"`。
- changelog 本条 = 文件夹名 ≠ SKILL.md `name:` 时按后者找不到（修复：双名解析）+ 列表同时显示两个名字。

### OCC 现状
- **调用侧已是修复后行为**：`src/skills/loadSkillsDir.ts:427-436` 把 frontmatter `name`/`display-name` 解析进 `displayName`；`createSkillCommand.userFacingName() = displayName || skillName`；`src/commands.ts:800-810 findCommand` 同时匹配 `_.name`（文件夹名）、`getCommandName()`（displayName）、`aliases` → 文件夹 `测试技能/` + `name: test-skill` 两个名字都能调起（`SkillTool.ts:525` 同链路）。
- **列表侧单名**（缺官方"双名"半条）：
  - 模型可见列表 `src/tools/SkillTool/prompt.ts:85-99`：只输出 `cmd.name`（文件夹名），displayName 不匹配时仅 `logForDebugging`（且仅 plugin skill）；
  - `/` 补全 `src/utils/suggestions/commandSuggestions.ts:278-291`：只显示 `getCommandName()`（displayName），alias 括注仅在用户恰好键入 alias 时出现；
  - `SkillsMenu.tsx:137,170,179` 同样单名。
- 附带核对：OCC 已有 skill 名字符校验（`src/utils/skills/reservedNames.ts:277-318` 区分 path/frontmatter-name 的拒绝文案）与 `isSkillNameSafeToDisplay`（`commands.ts:416-426`）。

### 判定 + 移植方案
**调用侧 PORTED，列表侧 STAGED**。方案（三名面统一"双名"显示，格式官方无字节证据，取信息完备的最小实现并在 issue 注明）：
1. `SkillTool/prompt.ts formatCommandDescription`：当 `getCommandName(cmd) !== cmd.name` 时输出 `` - ${cmd.name} (${getCommandName(cmd)}): ${desc} ``（模型同时看到两个可调用名，消除"按 SKILL.md name 找不到"的模型侧困惑）；去掉仅限 plugin 的 debug log 分支或保留均可。
2. `commandSuggestions.ts`：displayText 在两名不同时显示 `/${displayName}` 且 `aliasText` 位置补文件夹名（复用现有括注机制，`matchedAlias` 逻辑不动）。
3. `SkillsMenu.tsx` 行尾 dim 括注第二名字。
4. 测试计划：
   - fixture：`.claude/skills/测试技能/SKILL.md`（frontmatter `name: test-skill`）；
   - 单测：prompt 列表串含 `测试技能 (test-skill)`；suggestion displayText 含双名；
   - e2e：`occ -p` 触发 Skill 列表 attachment，断言两名同现；REPL 键入 `/test` capture 断言括注；两名分别调用均成功（回归调用侧 PORTED 行为）。

---

## 11. Bash 首命令丢失 aliases/functions/plugin PATH → **NO-OP**

### 官方机制
- 探针/快照机器两版字符串一致（修复是时序逻辑，不可字符串隔离）："Spawn-env probe failed: exit=/captured N keys/error:"（289/291 各 5 命中）、`Spawn-env probe captured ${r.length} keys`、"Creating shell snapshot for"。
- changelog 语义：新配置目录上、启动后数秒内跑首命令 → 快照/探针未完成即被采空并**缓存整会话**。

### OCC 现状
- 快照子系统完整且**结构免疫**该竞态：`src/utils/Shell.ts:144-150` `getShellConfig = memoize(...)` 懒初始化；`src/utils/shell/bashProvider.ts:60-65` 快照 promise 建一次，`:87` **每条命令都 `await snapshotPromise`**（首命令阻塞至多 10s `SNAPSHOT_CREATION_TIMEOUT`，`ShellSnapshot.ts:24`），不存在"未就绪→用默认→缓存默认"分支；`ShellSnapshot.ts:449` `mkdir(snapshotsDir,{recursive:true})` 在 execFile 前 await，新配置目录同步创建。
- 实测（Explore 代理，fresh `CLAUDE_CONFIG_DIR`）：25ms 产出完整快照（Functions/Aliases/PATH 三段俱全）。
- **OCC 特有相邻退化路径**（同族不同触发，记录备查，非本条移植）：
  (a) 快照失败一次性、永不重试（`snapshotPromise` 为闭包 const + memoize）→ 整会话 `bash -c -l` 无 aliases/functions；zsh 下 `-l` 不读 `.zshrc`，损失更大；
  (b) "成功"仅要求文件存在（`ShellSnapshot.ts:557` 只查 `snapshotSize !== undefined`）→ 0 字节/半截快照被接受，且 `lastSnapshotFilePath` 置位导致 `-l` 被跳过（`bashProvider.ts:236`），两头落空；
  (c) POSIX 快照的 `export PATH=` 写的是 JS 侧 `process.env.PATH` 且**最后追加**（`ShellSnapshot.ts:269,368`），会盖掉用户 rc 里 mise/pyenv/nvm 的 PATH 增量——正是"plugin PATH entries"类损失，官方是否从 source 后子 shell 取 `$PATH` 无字节证据（`Add PATH to the file` 在两版 diff 文件 0 命中）。

### 判定
**NO-OP**（changelog 本条）。官方竞态的前提（首命令不等快照）在 OCC 架构中不成立。相邻发现 (a)(b)(c) 建议另立 OCC 自有 issue（(b) 最小修：`snapshotSize===0` 视为失败并走 `-l` 回退；(a) 最小修：失败后下次 exec 重建 promise），不混入上游对齐轮。

---

## 12. 未装 git/gh 报 "Premature close" → **NO-OP**

### 官方机制
- "Premature close" 两版都只在 Bun 运行时常量池（@518749 两版同位），非应用串；cross-spawn 的 `verifyENOENT/verifyENOENTSync/notFoundError/_enoent` 与 `safeSpawn: command not found or is in an unsafe location (current directory)` 两版都在 → 修复是把流关闭错误映射回 ENOENT 命名的**代码级**改动，字符串不可隔离。

### OCC 现状
- `grep -rniI "Premature close" src packages test` → **0 命中**；该串只存在于传递依赖（node-fetch/streamx/agent-sdk）与 dist bundle，OCC 的 git/gh 执行链（execa@9.6.1）无此串：`grep -rn "premature" node_modules/.bun/execa*/…/lib/` → 空。
- **实测已达标**：`execFileNoThrow`（`src/utils/execFileNoThrow.ts:81,141,160`）对缺失程序返回 `"Command failed with ENOENT: <prog> --version\nExecutable not found in $PATH: \"<prog>\""`；Bash 工具路径返回 127 + `/usr/bin/bash: line 1: <prog>: command not found`。`gh` 另有免 spawn 探测（`src/utils/github/ghAuthStatus.ts:18 which('gh') → 'not_installed'`）。
- 残留同类 outlier（记录，不属本条）：`src/utils/ShellCommand.ts:231` `#errorHandler(){this.#resolveExitCode(1)}` 把 shell 二进制自身的异步 spawn 错误整个丢弃 → exit 1 空输出不报程序名。

### 判定
**NO-OP**。目标行为（点名缺失程序）OCC 已满足且经实测验证；"Premature close" 无法从 OCC src 产生。`ShellCommand.ts:231` 建议另立小 issue（把 error 对象并入 stderr/exit 127 语义），非上游对齐项。

---

## 13. skills/自定义命令拒绝含裸控制字符的 `!` 命令并指出位置 → **STAGED（P2）**

### 官方机制
- 描述器两版同文（291 @202563947 / 289 @200151577，函数 `Xpr`，逐字节选）：

```js
case"control_character":
  return `it contains a control character at character ${e.index+1} (${i})`
```

  （同族 case：line_break/nul/whitespace/non_ascii/too_long。）
- 判定正则两版一致：`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]` —— 放行 `\x09`(tab)、`\x0a`(LF)、`\x0d`(CR)，其余 C0/C1 全拒。
- 290 的改动 = 把该验证接到 skills/custom commands 的 `!` bang 命令路径（新调用点无独立字符串，接线为逻辑级）；changelog 逐字："…refuse a `!` shell command containing raw control characters other than tab/newline, and the message now shows where"。
- 相邻既有文案（289 已有，非本条）："command contains control characters that would be hidden in the approval dialog"（Monitor 工具，4 命中）、"Refusing to send command containing control character U+…"（终端面板，2 命中）。

### OCC 现状
- bang 解析/执行链完整：`src/utils/promptShellExecution.ts:52-60`（BLOCK_PATTERN/INLINE_PATTERN）、`:168-189`（权限检查后**直接 `shellTool.call()`**，绕过 `validateInput`——`:21-22` 注释自认）。**命令串只 `.trim()`，零字符验证**。
- 下游仅有 Bash 安全层的弱化门：`bashSecurity.ts:2244-2272,2440-2452` `CONTROL_CHAR_RE=/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/` → `behavior:'ask'`（升级询问，非拒绝，且**无位置信息**）；`ast.ts:503,657-659` → `too-complex`；`\r` 单独处理（`bashSecurity.ts:1001-1012`）。
- `grep -nE "control|refuse|position" src/utils/promptShellExecution.ts` → **0 命中**；全仓无 "control character at position N" 类文案。

### 判定 + 移植方案
**STAGED**。方案：
1. `promptShellExecution.ts` 在权限检查**之前**（refuse 应先于 ask）对每个提取出的 `command` 跑官方正则 `/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/`（注意比 OCC 现有 bashSecurity 正则多 `\x7f-\x9f` 段，取官方域），命中即抛 `MalformedCommandError`，消息采用官方描述器格式：`Refusing to run this command from ${sourceName}: it contains a control character at character ${index+1} (${JSON.stringify(char)})`（前半句主语为 OCC 自定接线文案，`it contains…` 部分逐字官方；issue 注明）。
2. 同一路径同时覆盖 skills（`loadSkillsDir.ts:595-670 getPromptForCommand` → `executeShellCommandsInPrompt`）与自定义 prompt 命令（同一函数入口，天然全覆盖）。
3. 不改动 bashSecurity/ast 的既有 `ask` 门（那是模型侧 Bash 工具的官方既有行为，双门并存与官方一致）。
4. 测试计划：
   - 单测：fixture skill 含 !`printf 'a\x01b'` 内嵌 `\x01` → 抛错且消息含 `at character 2`；含 `\t`/`\n` 的命令**放行**；`\x7f`、`\x9f` 拒绝（官方域验证）；
   - e2e：`occ -p` 调该 skill，断言 tool 输出为拒绝消息而非执行结果；tmux 审批对话框不出现（refuse 先于 ask 的顺序断言）。

---

## 14. `plansDirectory` 项目根检查对反斜杠失效 → **STAGED（P2）**

### 官方机制
- 报错文案两版同文（4 命中；291 二进制 @100746005、@205760591，逐字）：
  `plansDirectory must be within project root, with no backslash in its path off Windows:` ——
  即官方语义：off-Windows 平台路径含 `\` 直接**拒绝**（连同越界拒绝共用该消息），随后走默认目录兜底；`validatedDir` 相邻。修复点是检查逻辑（289 已有文案但检查漏反斜杠 → 290 补上），逻辑差异不可字符串隔离。

### OCC 现状
- `src/utils/plans.ts:79-111`：`resolve(cwd, settingsDir)` 后仅 `!resolved.startsWith(cwd + sep) && resolved !== cwd` 判定；**无分隔符感知**（`grep -nE "replace|normalize|realpath|win32" plans.ts` 仅 `sep` import）。
- 后果（Explore 代理推演）：POSIX 上 `plansDirectory: "..\\..\\evil"` / `"C:\\plans"` 全部**通过**检查并被 `mkdirSync` 成项目根内字面反斜杠目录名——官方修复正是要拒绝这类值；越界 POSIX 路径（`/tmp/plans`、`../plans`）OCC 能正确拦。
- 次要偏差：guard 比较对象是 `getCwd()`（可变工作目录）而文案/schema 说 "project root"；错误消息与官方不同文；`memoize` 后 `/cd` 不复验；`grep -rn plansDirectory test/` → **0 测试覆盖**。

### 判定 + 移植方案
**STAGED**。方案（`src/utils/plans.ts:88-93`）：
1. 条件改为官方双语义：`const offWindows = process.platform !== 'win32'; if (offWindows && settingsDir.includes('\\')) → 拒绝`，与既有越界拒绝合并进同一分支；
2. `logError` 消息替换为官方逐字前缀：`` `plansDirectory must be within project root, with no backslash in its path off Windows: ${settingsDir}` ``；拒绝后维持既有兜底 `join(getClaudeConfigHomeDir(),'plans')`；
3. 测试计划（补 0 覆盖）：
   - 单测（POSIX）：`..\\..\\evil`、`C:\\plans`、`plans\\x` → 兜底目录 + 错误消息逐字；`../plans`、`/tmp/plans` → 兜底（回归）；`docs/plans` → 通过；win32 mock 平台下 `..\plans` 不因反斜杠被拒；
   - e2e：settings 写 `plansDirectory: "a\\b"` 启动，断言 `~/.claude/plans` 被用且项目根**无** `a\b` 目录生成。

---

## 15. 首次启动在 `auth login`/已有凭据后仍重问登录方式 → **STAGED（P2）**

### 官方机制
- 预选文案两版同文（3 命中）："Login method pre-selected: Subscription Plan (Claude Pro/Max)" / "Login method pre-selected: API usage billing (Anthropic Console)" —— 官方存在凭据探测→预选/跳过逻辑；290 修复的是其门控（首启时探测 `claude auth login` 产物或既有凭据文件则不再重问），具体判定为逻辑级、不可字符串隔离。

### OCC 现状
- 选择器存在：`src/components/ConsoleOAuthFlow.tsx:479-507`（"Select login method:" 3 项），入口 onboarding（`Onboarding.tsx:135-141`）与 `/login`（`login.tsx:150`）。
- 首启门 `src/interactiveHelpers.tsx:109-121`：只看 `config.theme`/`hasCompletedOnboarding`，**不查任何已存凭据**（keychain、`.credentials.json`、`getOauthAccountInfo()` 均不读）。
- `isAnthropicAuthEnabled()`（`src/utils/auth.ts:108-157`）只对 **env/settings 来源**的 3P/key/token 关 oauth 步骤，不认 OCC 已存 OAuth tokens。
- **同类 bug 实锤**：`occ auth login` 浏览器成功路径（`src/cli/handlers/auth.ts:360-372`）`installOAuthTokens → 'Login successful.' → exit 0`，**从不写 `hasCompletedOnboarding`**（仅 env-refresh-token 快路径 `:306-311` 写）→ CLI 登录后首次交互启动仍进 Onboarding + 登录方式选择器，与官方修复前症状一致。

### 判定 + 移植方案
**STAGED**。方案（两点，均为官方语义的最小对齐）：
1. `installOAuthTokens` 成功尾部（`auth.ts` return 前）补 `saveGlobalConfig(current => current.hasCompletedOnboarding ? current : {...current, hasCompletedOnboarding: true})`——与 env 路径 `:306-311` 同型，消除"CLI 登录后重问"主症状；
2. Onboarding oauth 步骤前加凭据探测：`getClaudeAIOAuthTokens()` 非空（keychain/`.credentials.json` 命中）时走 `skipOAuth`（复用 `Onboarding.tsx:206-241 SkippableStep` 机制，与 ApproveApiKey 同路），对应官方"existing credentials file"分支；探测需容忍 transient（锁 keychain）失败——`readStrict` sentinel 时**不**跳过（宁可多问不可漏登）。
3. 测试计划：
   - e2e A：全新 `CLAUDE_CONFIG_DIR` + 预置合法 `.credentials.json`（fixture token）→ 启动 capture 断言不出现 "Select login method"；
   - e2e B：`occ auth login`（mock OAuth 回调）成功后二次启动 → 不重问；
   - 回归：无凭据全新目录 → Onboarding 完整出现；锁 keychain（mock transient）→ 仍出现选择器。

---

## 16. macOS `/login` keychain 拒写保留旧登录时谎报成功 → **NO-OP**

### 官方机制
- keychain 模块（chunk-72pzw556.js，291 @102118000）：状态机 `lastKnown, readInFlight, lastReadFailure, keychainHoldsItem`、service `claude-code-user`、错误分类学（`errsecduplicateitem→already exists/duplicate_item`、`unable|could not open→keychain_unavailable`、`errsecitemnotfound→item_not_found`、`errsecinteractionnotallowed→interaction_not_allowed`、`errsecusercanceled`、`errsecauthfailed→"name or passphrase"`、`keychain_locked`）——两版字符串一致（各 2 命中），290 修复为写入被拒后的**成功上报逻辑**（代码级，不可字符串隔离）。

### OCC 现状（三层防护已齐）
1. **transient 拒写直接 throw**：`installOAuthTokens`（`src/cli/handlers/auth.ts:186-201`）——锁 keychain 类保存失败经 `resolveTransientLoginSaveMessage` 抛平台化错误，登录**不会**被报成功（2.1.281 #049）；
2. **旧条目遮蔽已消除**：`fallbackStorage.ts update()`——primary（keychain）写失败、secondary（plaintext）写成功且 primary 仍持有旧值时，**best-effort `primary.delete()`** 防止 stale keychain 条目在 read() 优先级下遮蔽新凭据（#30337 注释逐字说明 `/login` 循环成因）；
3. **结果如实上报**：`saveOAuthTokensIfNeeded` 返回 `{success,warning,transient}`（`src/utils/auth.ts:1510-1531`），`installOAuthTokens` 尾部按**当前**凭据解析结果分类 `sessionAuth` 返回（2.1.288 #35），`ConsoleOAuthFlow.tsx:307` 消费 `installResult`。
- 架构差异备注：OCC 在 macOS 有 plaintext 兜底（官方 keychain-only），keychain 拒写但兜底成功时 OCC 报 success+warning——这是 OCC 既有的、先于 289 的文档化设计（凭据确实持久化了），不属于官方本条修复的"谎报"情形（官方情形 = 什么都没写进去/旧值还在却报成功）。

### 判定
**NO-OP**。官方修复目标（拒写不谎报、旧登录不遮蔽新登录）在 OCC 由 #049/#30337/#35 三层机制覆盖，且各自有既有测试锚点。无移植动作。

---

## 17. Mac 睡眠期间 auto-compaction 以 "Prompt is too long" 放弃 → **NO-OP**

### 官方机制
- PTL 检测器两版逐字同构（291 @210943346 / 289 @208574613）：`var fL="Prompt is too long";function iSe(e){…n.some((r)=>r.type==="text"&&r.text.startsWith(fL))}`。
- 290 新增重试遥测 token：new-in-290.txt 含 `tengu_compact_ptl_retry`、`[earlier conversation truncated for compaction retry]` —— 即 290 时代官方已有 **PTL 头部截断重试环**。
- 本条（睡眠中 compaction 请求挂起/时钟跳变 → 误报 PTL 放弃）为逻辑级修复，无独立字符串。

### OCC 现状
- **290 时代重试环 OCC 已有**：`src/services/compact/compact.ts:254-255`（`MAX_PTL_RETRIES=3` + `[earlier conversation truncated for compaction retry]` 逐字 marker）、`:498-540`/`:940-978` 双路径重试、`tengu_compact_ptl_retry` 遥测（`:531-535`）、放弃文案 `:320-321`；autocompact 熔断 `autoCompact.ts:84-88`（3 连败停试）。
- 挂死流兜底：`src/services/api/claude.ts:2682-2698` 流式 idle watchdog（默认 300s，`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 可调）→ 睡眠挂起的 compaction 流会被 abort 成 `ERROR_MESSAGE_INCOMPLETE_RESPONSE`（"Compaction interrupted…network issues"），**不落进 PTL 分支**。
- 无睡眠/时钟感知（与官方修复前相同）：compaction 路径 `grep -rni "clock|monotonic|suspend" src/services/compact` → 仅 prompt 散文 1 命中；`monotonicNow` 只用于 QueryEngine 时长遥测。
- watch 项（OCC 自有，非本条）：`microCompact.ts:438-441` 用裸 `Date.now()` 差值做 gap 触发，时钟回拨→静默不触发（当前 `tengu_slate_heron` stub 默认关，无实害）。

### 判定
**NO-OP**。官方睡眠修复的不可见逻辑无法逐字提取；OCC 的 watchdog + 既有 PTL 重试环已把"挂起 → 误判 PTL 放弃"路径改为"挂起 → abort → incomplete-response 可重试"，症状面（用户被 PTL 卡死）不成立。microCompact 时钟项记入 watch 清单。

---

## 18. mods `$.process.spawn` 拒绝语义变更 → **N-A**

### 官方机制
- 291 @37841846（new-in-291.txt，逐字节选）：`var hWe="$.process.spawn";async function*GHo({argv:e,cwd:n,env:r,input:s},g,{signal:h,cwd:S}={}){…}`；`another mod` 7 命中（mod 间拒绝仲裁文案）。

### OCC 现状
- mods `$` runtime 完全缺失（grep 证明）：`$.process`/`$.agent`/`$.ui`/`$.tool`/`ui.render`/`AbovePrompt`/`class Client` 在 src 全 0；17 处 `mods` 命中全是键盘修饰键/ES module 局部量；`src/types/plugin.ts:71` PluginComponent 仅声明式五类；`HOOK_EVENTS`（28 events）无 `ui.*`/`process.*` 命名空间。前轮结论存档：`docs/gap-research-289/cluster-f-mods-ui-runtime.md`（13×NO-OP{NO-SURFACE}）。

### 判定
**N-A（NO-SURFACE）**。与 cluster F mods 结论一致；mods runtime 移植是独立大项，本条随宿主立项。

---

## 19. `/code-review` medium 在无调优模型上报告 cleanup + CLAUDE.md conventions → **PORTED**

### 官方机制
- review prompt（291 @95377436，两版同文）："### Reuse — The angles above hunt for bugs; this one and the next two hunt for cleanup in the changed code." + "Cleanup, altitude, and conventions candidates use the same `file`/`line`/`summary` shape; in `failure_scenario`, state the concrete cost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule is broken)…Correctness bugs always outrank cleanup, altitude, and conventions findings when the output cap forces a cut."（`conventions findings` 两版各 2 命中——文案先于 290 存在。）
- 调优模型表（291 @231833838，逐字节选）：`nq=["high","xhigh","max"],m9=["medium","high","xhigh"],Zpt=["high"],mRe="medium"`；`LN={"claude-opus-5":{flag:"tengu_radiant_island",from:["high"]},"claude-fable-5-1":{flag:"tengu_steady_plum",from:["high","xhigh","max"]}},gRe="claude-opus-5"` —— 只有 claude-opus-5 / claude-fable-5-1 有调优档位；290 改动 = **无调优设置的模型**（含 claude-opus-5-5 / claude-sonnet-5-5，两版 binary 均含该二 ID）在 medium 也产出 cleanup + conventions 两类。
- 291 追加（new-in-291）：`codeReviewLastEffort` 状态记忆、``codeReview?`/${Dz} medium`:void 0`` 建议、`includeCodeReviewSuggestion`（属 291 增强，非本条）。

### OCC 现状
- `/code-review` = bundled skill（`src/skills/bundled/simplify.ts:282` 注册，`context:'fork'`，live）。medium 档 `EFFORT_CONFIG`（`:123`）= 2 correctness angles ×5 + **合并 cleanup finder**（Reuse/Simplification/Efficiency/Altitude 四角度，budget 20，`:191`）；Phase 1 Scope 明令收集 "applicable CLAUDE.md files, and conventions"（`:166`）；Phase 6 合并排序封顶 6 条。实测 prompt 输出确认两段俱在（Explore 代理 bun 实跑）。
- **零模型调优分支**：`grep -rniI "reviewSettings|reviewModel|tunedReview" src` → 0；`EFFORT_CONFIG` 仅按 effort 键控 → 所有模型（含 Opus 5.5/Sonnet 5.5，OCC 已识 ID：`claudeApiContent.ts:67,71`）行为一致，天然落在官方"无调优模型"的目标行为上。
- 差异备注（watch，不移植）：官方把 conventions 列为与 cleanup/altitude 并列的**候选类别**（`file/line/summary` 同形 + 排序规则"correctness 恒压 cleanup/altitude/conventions"）；OCC 的 conventions 是 Scope 阶段收集指令，靠四个 cleanup 角度兜住，未单列类别、也无该排序明文。官方调优/门控（GrowthBook flag、fromEffort/toEffort 对话框 schema）依赖真 GrowthBook，OCC stub 环境无对应物。

### 判定
**PORTED**（结果对齐：medium 在所有模型上报告 cleanup + CLAUDE.md conventions 两类产出；机制不同——OCC 以"全员无调优"达成官方"无调优模型"的目标态）。conventions 单列类别 + 排序明文记为 P3 watch（若未来对齐官方 review prompt 全文，一并带上 @95377436 逐字段落）。

---

## 移植批次建议（供 issue 拆分）

| 批次 | 条目 | 目标文件 | 规模 |
|---|---|---|---|
| G-1（P1 快赢） | #5 二进制文案、#7 preconnect 门 | `src/tools/FileReadTool/FileReadTool.ts:628`；`src/utils/apiPreconnect.ts` | 各 1-3 行 |
| G-2（P1 机制） | #8 WebSearch 令牌桶、#9 路径实体转义 | `src/utils/sessionLimits.ts`+`src/utils/taskRegistry.ts`+`WebSearchTool.ts`；新建 `src/utils/displayEscape.ts`+FileRead/Edit 报错与权限提示接线 | 中 |
| G-3（P2） | #3 ❯ 指针、#10 双名列表、#13 bang 控制字符、#14 plansDirectory、#15 登录门控 | `PromptInputFooterSuggestions.tsx`；`SkillTool/prompt.ts`+`commandSuggestions.ts`+`SkillsMenu.tsx`；`promptShellExecution.ts`；`utils/plans.ts`；`cli/handlers/auth.ts`+`Onboarding.tsx` | 中小 ×5 |
| 另立 OCC 自有 issue（非上游对齐） | #11(a)(b)(c) 快照退化、#12 `ShellCommand.ts:231` 吞错、#2 `/config askUserQuestionTimeout` 假成功、#17 microCompact 时钟 | 见各节 | — |

字节证据文件（本轮临时产物，路径仅本机有效）：`/tmp/gap291/strings-{289,290,291}.txt`、`new-in-{290,291}.txt`、`gone-from-289.txt`、`ctx.sh`；官方二进制 `/tmp/cc{289,290,291}/package/claude`（未执行）。
