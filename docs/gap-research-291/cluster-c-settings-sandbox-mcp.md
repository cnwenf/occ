# Cluster C — 设置文件 / Sandbox / MCP 配置（2.1.290 + 2.1.291）

OCC 追踪官方 **2.1.289**；官方已发布 **2.1.290**（本簇 11 条 changelog 全部来自 290）与 **2.1.291**。

**取证来源（只读，绝不执行）**：`/tmp/cc289/package/claude`（md5 `5c920e4c2e6c73c2858cc48e5123582e`）、`/tmp/cc291/package/claude`（md5 `82c1f303d0dd7ef19d869f7b3d886043`）；strings：`/tmp/gap291/strings-{289,290,291}.txt`；diff：`/tmp/gap291/{new-in-291,gone-from-289}.txt`。

**取证方法学备忘（供复现）**：官方二进制是 Bun 编译 ELF，JS 以字符串内嵌，minify 后短名在版本间漂移（289 `ae`/`DP`/`uyo`/`si`/`Zi`/`F3o`/`Fz`/`SJ`/`gMe`/`Fw`/`dB` ↔ 291 `pe`/`fA`/`d0o`/`Jo`/`Gi`/`Dhr`/`C4`/`Hce`/`ILo`/`sv`/`y1`）。同一个短名（`Ui` `Ii` `fA` `hN` `pe` `wB` `Id` `mj` `xe` `Rje` `C5t` `lon` `kwt`）在不同 chunk 指代不同函数，**必须以唯一字面串为锚**（`LC_ALL=C grep -aboF` 取偏移 → python3 字节切片取上下文），并把候选偏移过滤到 JS 区（>190,000,000），再挑函数体含预期字面量的那一处。以 `-` 开头的 needle（`--upload-pack`、`--config`）会被 ugrep 当自身 flag 吞掉，需在 python3 里 `re.escape(...).encode()` 搜索。

---

## 结论总表

| # | changelog（2.1.290 原文） | 官方实现版本 | OCC 判定 | 主要目标文件 |
|---|---|---|---|---|
| 1 | symlinked settings file 指向的目标被编辑时不弹权限问询 | 291 新增 | **STAGED** | `src/utils/permissions/filesystem.ts`、`src/types/permissions.ts`、新 `src/utils/permissions/settingsFileLinks.ts` |
| 2 | managed settings 文件是指向 managed 目录外的链接时告警 | 291 新增 | **STAGED**（工作量最大，整个 managed-document link-walk 子系统缺失） | 新 `src/utils/settings/managedDocumentLinks.ts`、`src/utils/settings/settings.ts`、`src/screens/Doctor.tsx`、`src/utils/status.tsx` |
| 3 | `/status` + doctor 告警"managed 设置忽略了你的 sandbox allowRead/allowedDomains" | 291 新增 | **STAGED**（`statusOnly` 管道已存在，只缺探测器） | `src/utils/settings/settings.ts`、`src/utils/sandbox/sandbox-adapter.ts`、`src/components/sandbox/SandboxDoctorSection.tsx` |
| 4 | `disableClaudeAiConnectors` / `allowedMcpServers` URL 规则未作用于 `.mcp.json`、plugin、agent 声明的 MCP 项 | 291 大改 | **N-A（主体）+ 局部可移植** | `src/services/mcp/config.ts`、`src/services/mcp/types.ts`、`src/utils/settings/types.ts` |
| 5 | `xn--` host label 内含通配符的 URL allow/deny 模式在不同进程间匹配结果不一致 | 291 新增 | **N-A**（附带记录一条既存差异：`*`→`.*` vs 官方 host 段 `[^/]*`） | `src/services/mcp/config.ts:327-341`、`src/utils/hooks/execHttpHook.ts:64-68` |
| 6 | sandbox 内 `cat <<EOF \| python3` 每次都问审批 | 291 新增 | **STAGED**（OCC 目前是 fail-closed，比 289 还严；也缺 289 的 `differential`/`tengu_amber_larch` 恢复路径） | `src/utils/bash/ast.ts`、`src/utils/bash/bashParser.ts`、`src/tools/BashTool/bashPermissions.ts` |
| 7 | `git clone` 短选项保留了 `sandbox.excludedCommands` 里 `git *` 的豁免 | 291 gate 修复 | **STAGED**（OCC 缺整张 `Thr`/`Bgr` 选项表，不只是 `-u`） | `src/tools/BashTool/shouldUseSandbox.ts`、`src/utils/sandbox/sandbox-adapter.ts` |
| 8 | sandbox auto-allow 下 Monitor 工具命令跳过权限提示 | 291 新增 | **N-A**（OCC MonitorTool 没有 `checkPermissions`、没有 sandbox 路径、没有 `permissionLayers`） | `src/tools/MonitorTool/MonitorTool.ts` |
| 9 | PreToolUse hook 改写 input 后部分权限规则/安全检查未生效 | 291 新增 | **N-A（实质修复）+ LOW（日志文本对齐）** | `src/services/tools/toolHooks.ts` |
| 10 | Linux 上 `.claude/settings.json` 不存在时 sandbox 内 Bash 触发 ConfigChange hook + 中途重载设置 | 291 新增 | **STAGED** | `src/utils/settings/changeDetector.ts` |
| 11 | Linux/WSL 上 `~/**/.env` 这类读规则覆盖大目录导致首个请求前 + `/sandbox` Config tab 卡死 | 291 新增 | **STAGED** | `src/utils/sandbox/sandbox-adapter.ts`（`getFsReadConfig` 目前是裸委托） |

---

## 1. symlinked settings file 指向的目标文件被编辑时不弹权限问询

### 官方机制

291 全新引入一张 **settings 文件链接拼写表**（`settingsFileLinks` 291=6 处 / 289=0 处；`the walk of the settings links` 291=2 / 289=0；`leads here through a link` 291 @100701341,@206563912 / 289=0）。

291 @206550900 —— 2 秒 TTL 的 link→settings 文件映射（`gf=2000`）：

```js
var gf=2000;function ol(){let e=new Map;try{let n=Lb(),r=D(n===void 0?Cr():[...Cr(),n]),s=qL(),
  g=r.join("\x00"),h=SJo().monotonicNow(),w=s.settingsFileLinks;
  if(w!==void 0&&w.key===g&&h-w.builtAt<gf)return w.files;
  s.settingsFileLinks={key:g,builtAt:h,files:e};let S=new Map;
  for(let R of r){let x=bi(R);
    if(x.unresolved)t(`permissions: the walk of settings file ${R} did not reach its end; only the links it met are recorded`);
    if(!x.leafIsSymlink)continue;
    for(let I of x.spellings)for(let L of D([I,$n(I)]))if(!il(L))S.set(TE(L),R)}
  return s.settingsFileLinks={key:g,builtAt:h,files:S},S}
catch(n){return c(Error("the walk of the settings links threw; for two seconds no settings file counts as a link"),{cause:n}),e}}
function nMe(e){return ol().has(TE(Ke(e)))||il(e)}
```

语义要点：`Cr()` = 全部 settings 文件路径，`Lb()` = `--settings` 传入的文件；`bi(R)` = symlink 逐跳 walk，返回 `{unresolved, spellings[], landing, leafIsSymlink}`；对每个 **是 symlink 叶子** 的 settings 文件，把它 walk 过程中遇到的**每一个中间拼写**（含 `$n(I)` 变体，即 `~` 展开/大小写归一）都登记进 map，value 是原始 settings 文件路径；`il(L)` 排除内部托管路径；`TE(L)` 做归一化 key。异常时降级为"两秒内没有任何 settings 文件算链接"，并 `c(Error(...))` 上报。

291 @~206563452 写入门禁 `y1`（289 对应 `dB` @~204091940）：

```js
let S=Mrr(w)!=="none"; …
if(S){let R=ol(),x=w.map((A)=>TE(Ke(A))),I=x.map((A)=>R.get(A)).find((A)=>A!==void 0),
  L=I===void 0||x.includes(TE(I))?"":` The Claude Code settings file ${ZI(I)} leads here through a link.`;
  return{safe:!1,
    message:`Claude requested permissions to write to ${ad(e)}, but you haven't granted it yet.${L}`,
    classifierApprovable:I===void 0,
    circuitBreaker:"claudeSettingsFile"}}
```

289 同一位置返回的是 `classifierApprovable:!0`，**没有 link 句子、没有 `circuitBreaker`**。三处变化：

1. `classifierApprovable` 从常量 `true` 变为 `I===void 0` —— 一旦确认这个路径是通过 settings 链接到达的，分类器**不允许**自动批准，必须真人回答。
2. message 追加 ` The Claude Code settings file <path> leads here through a link.`（`ZI` = 展示用路径美化）。
3. 新增 `circuitBreaker:"claudeSettingsFile"`，让"总是允许"类熔断规则不能吃掉这次问询。

配套的 settings-link 分类器 `Mrr`（替换 289 的 `zf`）：

```js
function Mrr(e){if(e.some((s)=>hf(s)||bf(s)))return"certain";
  let n=e.filter(MSt);if(n.length===0)return"none";
  let r=yf();if(n.some((s)=>xZe(s,r)))return"certain";
  return r.allResolved?"none":"possible"}
```

review store 谓词 291 `isSettingsFile:async(n)=>nMe(n)||MSt(n)&&xZe(n,await Z())` vs 289 `WPe(n)||FSe(n)&&$Se(n,await Z())` —— 多了 `nMe`（即链接表命中）这一支。

### OCC 现状

- `src/utils/permissions/filesystem.ts:221-243` `isClaudeSettingsPath(filePath)`：`expandPath` → `normalizeCaseForComparison` → `endsWith(`${sep}.claude${sep}settings.json`)` / `settings.local.json`（任意 project），或与 `getSettingsPaths()`（215-219，`SETTING_SOURCES.map(getSettingsFilePathForSource)`）精确相等。**完全没有 symlink 解析**。
- `src/utils/permissions/filesystem.ts:246-260` `isClaudeConfigFilePath`：settings OR 位于 `.claude/commands|agents|skills`（`pathInWorkingPath`）。
- 问询点 `src/utils/permissions/filesystem.ts:672-678`（`checkPathSafetyForAutoEdit` 内，`pathsToCheck` 由 `getPathsForPermissionCheck(path)` 生成，已含 symlink 落地路径）：

```ts
if (isClaudeConfigFilePath(pathToCheck)) {
  return { safe: false,
    message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
    classifierApprovable: true }
}
```

= 官方 **289** `dB` 的行为：无 link 句子、`classifierApprovable` 硬编码 `true`、无 `circuitBreaker`。

- `src/types/permissions.ts:358-367`：`classifierApprovable: boolean` + `circuitBreaker?: 'dangerousRemoval'`（CC 2.1.288 #54 引入）—— 需要扩到 `'claudeSettingsFile'`。
- **好消息**：官方所需的 symlink walk 原语 OCC 已具备，`src/utils/fsOperations.ts:392-500` 的返回形状与官方 `bi` 字节级对应：`{unresolved:false, requested, spellings:[...], landing, leafIsSymlink}` / `{unresolved:true, requested, spellings, stoppedAt, leafIsSymlink}`（TS 类型 410-424，降级接受 432-446，`onHop({composed,leaf})` 497）。另有 `src/utils/permissions/symlinkEquivalences.ts`、`symlinkResolutionStash.ts`，以及 2.1.280 的 `descriptor.spellings` 写权限 stash。
- 缺失面（grep 证明）：`settingsFileLinks` = 0；`leads here through a link` = 0；`claudeSettingsFile` = 0；settings review store（`settings-review|settingsReview|stagedForReview|staged_for_review`）= 0。
- 消费方：`src/utils/settings/validateEditTool.ts:2,20`；`src/tools/BashTool/pathValidation.ts:185`（注释）。

### 判定

**STAGED**。OCC 走的是 289 语义，官方 291 把它收紧成"链接目标 = settings 文件本身"，且不可被分类器批准、不可被熔断规则吃掉。这是**安全收紧**（防止 `~/.claude/settings.json -> /tmp/x.json` 时改 `/tmp/x.json` 绕过问询），优先级高。

### 移植方案 + 测试计划

**方案**

1. 新建 `src/utils/permissions/settingsFileLinks.ts`：
   - `const SETTINGS_LINK_TTL_MS = 2000`（官方 `gf`）。
   - `getSettingsFileLinkMap(): Map<string, string>` —— 复刻 `ol()`：key = 所有 settings 文件路径（含 `--settings`）以 `\x00` join，value = `{key, builtAt, files}` 缓存在一个模块级 stash 上（官方存在 `qL()` 会话态里，OCC 可放 `src/utils/permissions/symlinkResolutionStash.ts` 同层或独立模块态）；`builtAt` 用单调时钟。
   - walk 复用 `src/utils/fsOperations.ts` 的既有原语（不要自己写 `realpath`）；仅当 `leafIsSymlink` 为真才登记；对 `x.spellings` 每个 `I` 登记 `I` 与 `$n(I)` 对应的 OCC 变体（`~` 展开 + 大小写归一，OCC 已有 `expandPath`/`normalizeCaseForComparison`）；跳过内部托管路径（对应 `il`，OCC 侧即 `isInternalManagedPath` 一类，若无则先只跳过 managed settings 目录）。
   - `unresolved` 时打日志：`permissions: the walk of settings file ${path} did not reach its end; only the links it met are recorded`。
   - 整个函数包 try/catch，异常时上报 `Error('the walk of the settings links threw; for two seconds no settings file counts as a link')` 并返回空 Map。
   - 导出 `isSettingsFileLink(path): boolean` = `getSettingsFileLinkMap().has(normalize(realpathOrSelf(path))) || isInternalManagedPath(path)`（官方 `nMe`）。
2. `src/utils/permissions/filesystem.ts:672-678`：把常量 `classifierApprovable: true` 改为条件式，并加 link 句子与 circuitBreaker：
   - `const linkTarget = firstSettingsLinkFor(pathsToCheck)`（= `pathsToCheck.map(normalize).map(m.get).find(defined)`）；
   - `const suffix = linkTarget === undefined || pathsToCheck.map(normalize).includes(normalize(linkTarget)) ? '' : ` The Claude Code settings file ${prettyPath(linkTarget)} leads here through a link.``（官方刻意在"链接源本身就在待检集合里"时不加这句，避免自指啰嗦）；
   - `classifierApprovable: linkTarget === undefined`，`circuitBreaker: 'claudeSettingsFile'`。
3. `src/types/permissions.ts:358-367`：`circuitBreaker?: 'dangerousRemoval' | 'claudeSettingsFile'`；确认熔断/"总是允许"消费方（grep `circuitBreaker`）在遇到 `claudeSettingsFile` 时走人工问询而非静默允许。
4. 若 OCC 后续实现 settings review store，谓词用 `isSettingsFileLink(p) || (isClaudeSettingsPath(p) && matchesResolvedSettings(p, resolved))`。

**测试计划**

- 单测 `src/utils/permissions/__tests__/settingsFileLinks.test.ts`：
  - `~/.claude/settings.json` 是指向 `<tmp>/real.json` 的 symlink → `isSettingsFileLink('<tmp>/real.json')` 为 true，且 map value 为 `~/.claude/settings.json`。
  - 中间目录也是 symlink（`~/.claude` → `<tmp>/dotclaude`）→ 中间拼写同样登记（官方对 `x.spellings` 全量登记）。
  - 非 symlink 的 settings 文件 → map 为空。
  - 断链（dangling symlink）→ `unresolved` 日志 + 已遇到的链接仍登记。
  - TTL：连续两次调用只 walk 一次（spy fs 调用数）；>2s 后重 walk；settings 路径集合变化（换 `--settings`）→ key 变化立即重 walk。
  - walk 抛异常 → 返回空 map（fail-open 到"没有链接"），错误被上报，不冒泡。
- 单测 `checkPathSafetyForAutoEdit`：
  - 通过链接到达的目标 → `safe:false`、message 含 `The Claude Code settings file … leads here through a link.`、`classifierApprovable:false`、`circuitBreaker:'claudeSettingsFile'`。
  - 直接写 settings 文件本身（链接源在 `pathsToCheck` 内）→ 无 link 句子、`classifierApprovable:true`（与官方一致）、仍有 `circuitBreaker`。
  - 普通文件 → `safe:true`，无回归。
- **行为 e2e**（source-grep 不算完成门槛）：真实起 `occ` REPL，`ln -s $TMP/real.json ~/.claude/settings.json`，让模型 `Edit $TMP/real.json`，断言出现权限问询且分类器不自动放行；对照组：还原为普通文件，断言直接编辑 `.claude/settings.json` 的旧行为不变。

---

## 2. managed settings 文件是指向 managed 目录之外的链接时告警

### 官方机制

291 全新（`managedDocumentLinks` 291=6 / 289=0；`tengu_managed_settings_links` 291 @102082732,@204249341 / 289=0；`Suggested fix: Ask your administrator` 291 @102153036,@202887241 / 289=0）。

告警文案生成器，291 @202886904：

```js
function ucs(e){
  let n=`${BO(e.path)}: ${BO(I_(e.path))} is reached through a link`,s=BO(e.folder),r;
  switch(e.kind){
    case"inside":return null;
    case"outside":r=`${n} that leads outside ${s}.`;break;
    case"unverified":r=`${n}, and Claude Code couldn't tell whether the link leads outside ${s}.`;break}
  return[`${r} Claude Code still reads it.`,
    "Suggested fix: Ask your administrator to replace the link with the file or folder it points to."]}
```

聚合与遥测，291 @~204249257：

```js
function Tr(){return Hw(),[...qi().managedDocumentLinks.all(),...sY().managedDocumentLinks??[]]}
function C5t(){return Tr().flatMap((e)=>{let n=ucs(e);return n===null?[]:[n]})}
function rio(){let e=Tr();if(e.length===0)return;
  i("tengu_managed_settings_links",{inside_count:…,outside_count:…,unverified_count:…,
    outside_writable_count:…,outside_writable_unknown_count:…})}
```

分类引擎是一个**协作式 generator**：`nc(e,n,s,r)` 逐跳 yield `{ask:"isLink"|"networkJunction"|"realpath"|"writable", path}`，调用方回答，最终产出 `{path, folder, kind:"inside"|"outside"|"unverified", targetWritable}`。策略对象 `tc={unreadableAncestry:"unverified", surfaceNetworkRaw:!0, literalLinkText:"opaque"}` —— 祖路径不可读时判 `unverified`（不猜），网络 junction（Windows）原样上报，链接字面文本按"不透明"处理（不外泄）。存储类 `kKe` 新增 `managedDocumentLinks=new re`，提供 `.all()` / `.clearWalk()`，并在 `invalidateAll` 里清空。

三态语义：`inside` = 链接落在 managed 目录内 → **不告警**；`outside` = 明确指向 managed 目录外 → 告警（含 `targetWritable` 计入 `outside_writable_count`）；`unverified` = 无法判定（不可读祖先 / 网络 junction）→ 也告警，措辞降级为"Claude Code 无法判断"。两种情况都追加"Claude Code still reads it."与"建议让管理员把链接换成它指向的文件/目录"。

### OCC 现状

- `managedDocumentLinks`、`reached through a link`、`Suggested fix: Ask your administrator`、`networkJunction`、`unreadableAncestry` 全部 **0 命中**。
- 已有的 managed 面：`src/utils/settings/managedPath.ts:28-33` `getManagedSettingsDropInDir()` = `join(getManagedFilePath(),'managed-settings.d')`；`src/utils/settings/settings.ts:172,230,309,694,1025`；`src/utils/settings/policyStrictSchema.ts:703`；`src/utils/settings/mdm/settings.ts:325`；`src/utils/exitCommit.ts:15`。
- 展示管道**已就绪**：`statusOnly` 出现在 17 个文件，`src/utils/model/modelGovernanceWarnings.ts:19,31,50` 已经在用官方同形的记录 `{file, path, message, severity:"warning", statusOnly:true}`；渲染方 `src/screens/Doctor.tsx:145`（"statusOnly entries, rendered by the doctor CLI as bare `- message` lines"）与 `src/utils/status.tsx:196`。
- symlink walk 原语已有（见 item 1，`src/utils/fsOperations.ts:392-500`）。

### 判定

**STAGED**（本簇工作量最大：整个 managed-document link-walk 子系统缺失，且需要一个跨 managed-settings.json + managed-settings.d/* 的收集器、一个会话级 store、doctor/status 两个渲染点、一条遥测）。不是安全门禁，是**可见性/告警**，可独立于 item 1 排期，但共享 walk 原语，建议排在 item 1 之后。

### 移植方案 + 测试计划

**方案**

1. 新建 `src/utils/settings/managedDocumentLinks.ts`：
   - 类型 `ManagedDocumentLink = { path: string; folder: string; kind: 'inside'|'outside'|'unverified'; targetWritable: boolean|null }`。
   - `classifyManagedDocumentLink(path, folder): ManagedDocumentLink | null` —— 按官方 generator 的**问答序列**实现（`isLink` → 逐跳 `realpath` → `writable`），保持三态与官方一致：
     - 任何祖路径不可读 → `kind:'unverified'`；
     - Windows 网络 junction / UNC → `unverified`（不猜）；
     - 落地路径在 `folder` 之内 → `inside`（返回后由文案层丢弃）；
     - 落地路径在 `folder` 之外 → `outside`，并额外 `stat` 目标判断 `targetWritable`（失败则 `null` → 计入 `outside_writable_unknown_count`）。
   - `collectManagedDocumentLinks()` —— 遍历 `getManagedFilePath()` 与 `getManagedSettingsDropInDir()` 下的每个文档，`folder` 取各自所在目录，结果写入模块级 store（提供 `all()` / `clearWalk()`，并在设置失效路径 `invalidateAll` 对应点清空）。
2. `formatManagedDocumentLinkWarnings(links): string[][]` —— 逐字节复刻 `ucs` 的两行文案（`inside` 返回 null 被 flatMap 丢掉）。路径展示用 OCC 既有的美化函数（官方 `BO`/`I_`）。
3. 接入两个渲染点：把结果 push 进 `statusOnly` warning 列表（`src/screens/Doctor.tsx`、`src/utils/status.tsx` 消费的那条流），`severity:'warning'`，`file` 用 managed 路径。
4. 遥测 `tengu_managed_settings_links`，字段名严格照抄：`inside_count` / `outside_count` / `unverified_count` / `outside_writable_count` / `outside_writable_unknown_count`；links 为空时**不发**（官方 `if(e.length===0)return`）。

**测试计划**

- 单测：
  - managed-settings.json 是普通文件 → 无告警；
  - 是指向同目录内文件的 symlink → `kind:'inside'`，文案层丢弃，`inside_count=1`；
  - 是指向 `/etc/other.json` 的 symlink → `outside`，文案两行完全等于官方串（含 "Claude Code still reads it." 与 "Suggested fix: …"），`outside_writable_count` 随目标权限位变化；
  - 祖先目录 `chmod 000` → `unverified`，文案用 "couldn't tell whether the link leads outside"；
  - `managed-settings.d/` 下 drop-in 是外指链接 → 同样计入，`folder` 是 drop-in 目录而非 managed 根；
  - store `clearWalk()` 后重新收集。
- 行为 e2e：真实 `occ doctor` 与 REPL `/status`，在临时 managed 目录布置外指链接，`capture-pane` 断言两行文案出现且顺序正确；对照组（普通文件）断言不出现。

---

## 3. `/status` + doctor 告警：managed 设置忽略了用户配置的 sandbox allowRead / allowedDomains

### 官方机制

291 全新（`allowReadCount` 291 @102161784,@202958836,@202960567,@202960675 / 289=0）。

设置合并装载器 `tmr` @~202958204 —— 在逐文件装载时记录"非 managed 文件里配了多少条 sandbox 规则"：

```js
let h=new Set(m.map((P)=>fe(Se(P,"managed-settings.json")))),
    y=new Set(m.map((P)=>fe(Se(P,"managed-settings.d")))),
    _=(P)=>{let W=fe(P);return h.has(W)||y.has(ro(W))},
    S=(P,W,L)=>{
      if(L?.channelLabel!==!0&&_(P))return;                       // 跳过 managed 自身（channelLabel 例外）
      let H=W.sandbox?.filesystem?.allowRead?.length??0,
          V=W.sandbox?.network?.allowedDomains?.length??0;
      if(H>0||V>0)g.push({file:P,allowReadCount:H,allowedDomainsCount:V})};
```

合并完成后生成 warning：

```js
let P=U8t(e),
W=(L,H,V,ce,Z)=>({file:L,path:H,severity:"warning",statusOnly:!0,
  message:`${H} is ignored \u2014 managed settings set ${V}, so only ${ce} from managed settings are honored. `
        + `The ${Z===1?"entry":`${Z} entries`} in ${L} will NOT apply `
        + `(see https://code.claude.com/docs/en/settings#sandbox-settings).`});
if(P.some((L)=>L.sandbox?.filesystem?.allowManagedReadPathsOnly===!0))
  for(let L of g) if(L.allowReadCount>0)
    p([W(L.file,"sandbox.filesystem.allowRead","allowManagedReadPathsOnly","allowRead paths",L.allowReadCount)]);
if(P.some((L)=>L.sandbox?.network?.allowManagedDomainsOnly===!0))
  for(let L of g) if(L.allowedDomainsCount>0)
    p([W(L.file,"sandbox.network.allowedDomains","allowManagedDomainsOnly",
         "allowed domains (and WebFetch domain rules)",L.allowedDomainsCount)]);
```

要点：`P=U8t(e)` 是 **managed 层**的设置数组；两个开关分别独立判定（可以只锁读路径不锁域名）；`statusOnly:!0` 意味着只在 `/status` 与 doctor 显示，不进普通 warning 流；文案里带单复数（`entry`/`entries`）与官方文档锚点 `#sandbox-settings`。

### OCC 现状

- 两个开关 OCC **已实现**：`src/utils/sandbox/sandbox-adapter.ts:180` `shouldAllowManagedSandboxDomainsOnly()`、`:223` `allowManagedReadPathsOnly === true`、`:291` `const managedOnly = …`。
- `statusOnly` 管道 OCC **已有**：`src/utils/model/modelGovernanceWarnings.ts:19,31,50` 用官方同形记录；渲染 `src/screens/Doctor.tsx:145`、`src/utils/status.tsx:196`；另有 `src/utils/settings/policyStrictSchema.ts:197,229,300,399,415,571,662,673,690,696,717`、`src/utils/settings/validation.ts:105`、`src/utils/settings/allowedProviders.ts:79`。
- **缺的只是探测器**：`allowReadCount` = 0 命中；`src/components/sandbox/SandboxDoctorSection.tsx` 只渲染依赖错误/警告（20-27、41 行），没有"你的 sandbox 规则被忽略"这一块；设置装载器里没有"按文件统计 sandbox 条目数"的收集。

### 判定

**STAGED**（低风险、高性价比：管道全在，只加一个 per-file 计数 + 两条 warning 生成）。

### 移植方案 + 测试计划

**方案**

1. 在 OCC 设置装载/合并处（`src/utils/settings/settings.ts`，逐 source 读取原始 JSON 的那一层）新增收集：
   - `isManagedDocumentPath(p)`：等于 `join(managedDir,'managed-settings.json')`，或其父目录等于 `getManagedSettingsDropInDir()`（官方 `_(P)` = `h.has(fe(P)) || y.has(ro(fe(P)))`）。
   - 对每个 **非 managed** 文件（`channelLabel===true` 的来源例外，仍计入）统计 `sandbox.filesystem.allowRead.length` 与 `sandbox.network.allowedDomains.length`，>0 才记录 `{file, allowReadCount, allowedDomainsCount}`。
2. 合并完成后，取 managed 层的设置数组，按官方两条独立分支生成 warning，**文案逐字节照抄**（含 `\u2014` em dash、`will NOT apply`、`(see https://code.claude.com/docs/en/settings#sandbox-settings)`、单复数）。
3. push 进 `statusOnly` warning 流（与 `modelGovernanceWarnings` 同一形状），确保 `Doctor.tsx` 与 `status.tsx` 都能看到；`SandboxDoctorSection.tsx` 若要显示也走同一条记录，不要另造格式。

**测试计划**

- 单测：
  - managed 设 `allowManagedReadPathsOnly:true` + 用户 `.claude/settings.json` 有 2 条 allowRead → 1 条 warning，文案含 `The 2 entries in <file> will NOT apply`；
  - 只有 1 条 → `The 1 entry`；
  - managed 未设开关 → 无 warning；
  - managed 自身文件里的 allowRead → **不**产生 warning（`_()` 过滤）；
  - `allowManagedDomainsOnly:true` + 用户 3 条 allowedDomains → 文案用 `allowed domains (and WebFetch domain rules)`；
  - 两个开关同时开 → 两条 warning，顺序先 allowRead 后 allowedDomains（与官方分支顺序一致）；
  - 记录形状断言：`severity:'warning'`、`statusOnly:true`、`path` 为 `sandbox.filesystem.allowRead` / `sandbox.network.allowedDomains`。
- 行为 e2e：临时 managed 目录写入 `allowManagedReadPathsOnly:true`，项目 `.claude/settings.json` 写 allowRead，跑 `occ doctor` 与 REPL `/status`，`capture-pane` 断言整行文案（含文档链接）出现。

---

## 4. `disableClaudeAiConnectors` / `allowedMcpServers` URL 规则未作用于 `.mcp.json`、plugin、agent 声明的 MCP 项

### 官方机制

291 重写了准入判定 `WW(e,n)` @212191758（289 为 `Dj(e,n)` @207991360），新增子句：

```js
if(n!==void 0&&Gto(n))return!1;                                    // disableClaudeAiConnectors
if(n!==void 0&&J2t(e,n))return!1;                                  // deny 规则（URL 感知）
if(n!==void 0&&n.type==="claudeai-proxy"){
  if(O4(n)===null)return!1;                                        // 注册表解析不出 URL → 拒
  if(dN(n)&&Rje(n)!=="admit")return!1}                             // connector 注册表裁决非 admit → 拒
…
else{let H=e;
  if(dN(n)){let W=E4(n.id);if(W.kind!=="found")return!1;H=W.name}  // 用注册表里的真名比对
  for(let W of r.allowedMcpServers)if(P8t(W)&&W.serverName===H)return!0;
  return!1}
```

关键的 **URL 解析口径变了**：

```js
// 291
function ILo(e){if(dN(e))return O4(e);return FDe(e)}
// 289
function gMe(e){return "url"in e?e.url:null}
```

289 只看配置对象里字面的 `url` 字段；291 对 `claudeai-proxy` 类型走 `O4(e)` —— connector **注册表**解析。配套：`D2t(e)` 把 `mcpsrv` 形态重新拼成 `${MCP_PROXY_URL}${MCP_PROXY_PATH.replace("{server_id}",s)}`（即 `mcprs` 形态），`MLo(e)` 把 `siblingIds` 指向的兄弟 connector 的 URL 并入集合（`siblingIds` 291=3 处 / 289=1 处）。这就是"某些 `.mcp.json`/plugin/agent 声明项逃过 URL 规则"的根因：它们的 `url` 字段缺失或是 `mcpsrv` 简写，289 的 `gMe` 返回 null → URL 规则无从比对。

阻断判定 `sv`（291）相比 `Fw`（289）新增：

```js
if(n.type!=="sdk"&&y8t(e)&&il("hipaa"))return!0;
if(J2t(e,n))return!0;
if(n.type!=="sdk"&&Gto(n))return!0;
if(n.type==="claudeai-proxy"&&(jae()||O4(n)===null))return!0;
if(dN(n)&&Rje(n)!=="admit")return!0;
```

并新增第三个桶 `held`（注册表还没解析完 → 先挂起，不直接 block）：

```js
function USe(e){if(!e)return{configs:{},blocked:[],held:[]};
  let n={},r=[],s=[];
  for(let[g,h]of Object.entries(e))
    if(bXn(h)&&Rje(h)==="hold")s.push(g);
    else if(sv(g,h))r.push(g);
    else n[g]=h;
  return{configs:n,blocked:r,held:s}}
function bXn(e){return dN(e)&&O4(e)!==null&&!jae()&&m1e()}
function Rje(e){if(!m1e())return"admit";
  let n=E4(e.id);
  if(n.kind==="found")return Boe(n.name,n.config)?"refuse":"admit";
  return n.kind==="pending"?"hold":"refuse"}
```

`--mcp-config` 调用点 291 @~219601086：`let{configs:tn,blocked:De,held:ot}=USe(Oe); … let Zi={...tn,...Nr(Oe,(Yt,on)=>ot.includes(on))}`（held 的条目仍进 config 对象，但由 `Nr` 标记为待定）。

### OCC 现状

- `disableClaudeAiConnectors` **未实现**：全仓只有 `src/utils/settings/policyLocks.ts:70` 一句注释；`src/utils/settings/types.ts`、`src/utils/settings/policyStrictSchema.ts` 都没有这个 key。`src/utils/settings/types.ts:553-558` 有另一个 2.1.149 的 key（"When true, load all claude.ai cloud MCP connectors alongside managed-mcp.json servers."），不是同一个东西。
- **没有 connector 注册表**：`src/services/mcp/config.ts:167-169` `getServerUrl(config)` = `return 'url' in config ? config.url : null`，与官方 **289** 的 `gMe` 字节等价（无 `O4`/`E4`/`Boe` 那一套）。
- `held` 桶缺失：`src/services/mcp/config.ts:543-559` `filterMcpServersByPolicy<T>` 只返回 `{allowed, blocked}`，带 `c.type === 'sdk'` bypass。
- `siblingIds` 仅 1 处命中，在 `src/utils/plugins/pluginFolderCollision.ts`（无关语义）。
- `mcpsrv`/`mcprs` 重拼在 OCC 里存在于**客户端连接**侧而非策略侧：`src/services/mcp/client.ts:1256` `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`、`src/constants/oauth.ts:79-80,102-103`（`'https://mcp-proxy.anthropic.com'`、`'/v1/mcp/{server_id}'`）、`src/components/mcp/MCPRemoteServerMenu.tsx:235-236`、`src/skills/bundled/scheduleRemoteAgents.ts:27-36`。
- `src/services/mcp/types.ts:150-165` `McpClaudeAIProxyServerConfigSchema = z.object({type: z.literal('claudeai-proxy'), url: z.string(), id: z.string(), …})` —— **`url` 是必填字面量**，所以 OCC 的 claudeai-proxy 条目天然带 `url`，289 口径的 `getServerUrl` 对它是有效的。
- 已实现的策略面：`getMcpAllowlistSettings` 348-353（`shouldAllowManagedMcpServersOnly()` → policySettings，否则 `getInitialSettings()`）、`getMcpDenylistSettings` 360-362、`isMcpServerDenied` 371-415、`isMcpServerAllowedByPolicy` 424+（deny 优先；allowlist undefined → true；空 → false；`hasCommandEntries`/`hasUrlEntries`；stdio vs remote 分支）；调用点 551, 716, 1135, 1236, 1250, 1290；enterprise 独占块 1128-1141；manual+dynamic+extra 合并 1226-1239；plugin enabled/disabled 拆分 1241-1252；最终合并过滤 1285-1294；`getAllMcpConfigs` 对 claudeai connectors 也走 `filterMcpServersByPolicy`（~1320）；claude.ai 去重抑制 298-317。

### 判定

**N-A（主体）+ 局部可移植**。

- `disableClaudeAiConnectors` 子句：**N-A** —— 该设置键在 OCC 不存在（grep 证明只有注释），没有 connector 注册表，`O4`/`E4`/`Rje`/`held` 全部无从对应。要移植得先引入整个 claude.ai connector 注册表子系统，那是一次独立特性立项，不属于 291 追齐。
- plugin / agent 声明项逃逸：**N-A** —— OCC 的 plugin MCP 走 `src/services/mcp/config.ts:1241-1252` 的 enabled/disabled 拆分后同样进 `filterMcpServersByPolicy`（1285-1294），没有官方的注册表旁路。
- `.mcp.json` 的 URL 规则：**PORTED（等价）** —— OCC 的 remote 条目 schema 强制 `url` 字面量，`getServerUrl` 拿到非 null，URL allow/deny 规则可正常比对。
- 可顺手做的**低风险对齐**（记为 LOW，不阻塞）：`filterMcpServersByPolicy` 的 `{allowed, blocked}` 二桶在引入注册表时需扩成三桶；现阶段只需在代码注释里标注官方 291 的 `held` 语义，避免未来实现时漏掉。

### 移植方案 + 测试计划

现阶段**不写代码**，只做两件小事（可选）：

1. 在 `src/services/mcp/config.ts:543-559` 上方加一段对齐注释，记录官方 291 的 `USe` 三桶（`configs`/`blocked`/`held`）与 `Rje` 的 `admit|hold|refuse` 裁决，标注 OCC 缺 `disableClaudeAiConnectors` + connector 注册表，属于独立立项。
2. 若产品侧决定实现 `disableClaudeAiConnectors`：先在 `src/utils/settings/types.ts` + `policyStrictSchema.ts` 加键（policy 层可锁，参考 `policyLocks.ts:70` 既有注释），再在 `isMcpServerAllowedByPolicy` 的 deny 前置分支加 `if (config.type === 'claudeai-proxy' && disableClaudeAiConnectors) return false`，并同步 `sv` 的阻断口径。

**测试计划**（仅在实施第 2 步时）

- 单测 `filterMcpServersByPolicy`：`.mcp.json` 中 `type:'claudeai-proxy'` 条目在 `disableClaudeAiConnectors:true` 下落入 blocked；`allowedMcpServers` 含 URL 规则时按 `getServerUrl` 比对；stdio 条目不受影响；`type:'sdk'` 保持 bypass。
- 行为 e2e：临时项目 `.mcp.json` 放一个 claudeai-proxy 条目 + managed 设置开 `disableClaudeAiConnectors`，REPL `/mcp` 断言该服务器不出现在列表；关掉开关后出现。

---

## 5. `xn--` host label 内含通配符的 URL allow/deny 模式在不同进程间匹配不一致

### 官方机制

291 全新（`zzpunycode` 在 289 为 0 命中）。291 @~212175251：

```js
var kw=`zzwildcard${p2t(8).toString("hex")}zz`,
    m2t=`zzpunycode${p2t(8).toString("hex")}zz`,
    fLo=new Set(["http:","https:","ws:","wss:","ftp:","file:"]);
function g2t(e,n){return e.replace(/[a-z0-9-]+/gi,(r)=>
  /^xn--/i.test(r)&&(r.includes(kw)||n&&r.includes(n))?m2t+r:r)}
function nje(e){return e.replaceAll(m2t,"")}
function h2t(e,n){return fLo.has(e.protocol)&&e.hostname.split(".").some((r)=>
  r.startsWith("xn--")&&(r.includes(kw)||n&&r.includes(n)))}
```

根因：官方模式解析器会把 `*` 替换成一个**每进程随机**的哨兵 token `zzwildcard<hex>zz` 再交给 `new URL()`。若 `*` 落在 host 的 `xn--` label 内，`new URL()` 的 IDNA 处理对该 label 的归一化结果依赖具体字节，于是同一个模式在不同进程里解析出不同 host → 匹配漂移。291 的做法是给这类 label 再套一层 `zzpunycode<hex>zz` 前缀屏蔽 IDNA，解析阶段直接拒绝（`if(h2t(s,n))return null`），展示时再脱屏蔽（`g=(h)=>nje(h).replaceAll(kw,"*")`）。

解析器 `Hce(e,n)`（291；289 `SJ`）：先 `g2t` 预处理，`if(h2t(s,n))return null` 拒绝，`g` 反解。

匹配器 `C4(e,n)`（291；289 `Fz`）**同时重构了匹配算法**：丢掉 289 的内联 RegExp（289 是 `.replace(/[.+?^${}()|[\]\\]/g,"\\$&")` 后 host 段 `*`→`[^/]*`、path 段 `*`→`.*`），改用 `mj(H,S)` / `mj(W,r.pathname+r.search)`，并在 `if(!h||h2t(h))` 时退回逐段匹配：

```js
function X8t(e,n,t){let r=0,o=0;for(;;){
  let s=a(e,t,r),i=a(n,t,o);
  if(e.charAt(s)!==n.charAt(i)||!mj(e.slice(r,s),n.slice(o,i)))return!1;
  if(s===e.length)return!0;
  r=s+1,o=i+1}}
```

### OCC 现状

OCC 有两份 URL 通配匹配实现，**都不经过 `new URL()` 的 IDNA 归一化**：

- `src/services/mcp/config.ts:327-333` `urlPatternToRegex`：`escaped = pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&')` → `regexStr = escaped.replace(/\*/g,'.*')` → `new RegExp('^'+regexStr+'$')`；`urlMatchesPattern` 338-341 直接对**原始 URL 字符串**做正则匹配。
- `src/utils/hooks/execHttpHook.ts:64-68`：第二份重复实现（同样 escape，`*`→`.*`），139 行 `policy.allowedUrls.some(p => urlMatchesPattern(hook.url, p))`；策略来自 `settings.allowedHttpHookUrls` / `httpHookAllowedEnvVars`。

两处都不构造 `URL` 对象、不做 punycode/IDNA 转换、不使用随机哨兵 token（`zzwildcard` 在 OCC 为 0 命中）。因此"每进程随机 → 跨进程漂移"这个 bug 在 OCC **不存在**。

### 判定

**N-A**（bug 的前提条件——随机哨兵 + `new URL()` IDNA——在 OCC 两份实现里都不存在，grep 证明）。

**附带记录一条既存差异（不属本条 changelog，建议另开 issue）**：OCC 的 `*`→`.*` 对整串生效，官方 289 是 host 段 `[^/]*` + path 段 `.*`。后果：`https://*.example.com` 在 OCC 里会匹配 `https://evil.com/?.example.com`（`.*` 可跨 `/`），官方不会。这是**宽松于官方**的既存偏差，安全上应收紧；官方 291 进一步换成 `mj` + 逐段 `X8t`，语义等价于"按 `/` 分段、段内通配"。另：两份重复实现违反 DRY，应抽公共工具。

### 移植方案 + 测试计划

本条无移植动作。附带的既存差异若要修（**建议做，独立于 291 追齐**）：

1. 抽 `src/utils/urlPatternMatch.ts`，实现官方 291 的 `C4`/`mj`/`X8t` 语义：host 段通配不跨 `/`，path+search 段通配可跨 `/`；`src/services/mcp/config.ts` 与 `src/utils/hooks/execHttpHook.ts` 都改为引用它（消除重复）。
2. 不要引入随机哨兵 token（OCC 不走 `new URL()`，无需要）；若将来改为走 `new URL()`，必须同时移植 `g2t`/`h2t`/`nje` 三件套，否则会把官方这个 bug 一起引进来。

**测试计划**

- 单测：`https://*.example.com` 匹配 `https://a.example.com` ✔、不匹配 `https://evil.com/?.example.com` ✘、不匹配 `https://a.b.example.com`（官方 host 段 `[^/]*` 不跨 `.`？—— **需先在官方二进制上确认 `mj` 的分段分隔符**，`X8t(n,q,"/")` 传的是 `/`，说明按 `/` 分段，段内 `*` 是否跨 `.` 要用 `mj` 的实现确定，不可臆测）；`https://example.com/*` 匹配 `https://example.com/a/b` ✔；带 query 的匹配。
- 行为 e2e：`allowedHttpHookUrls` 配一条通配，起真实 http hook，断言允许/拒绝与官方一致。

---

## 6. sandbox 内 `cat <<EOF | python3` 每次都问审批

### 官方机制

291 全新字面串（289 全部 0 命中）：`Text after the heredoc start on the same line cannot be statically analyzed` 291=[100781632, 206270308, 206273988]；`More than a pipeline follows the heredoc delimiter on its line` 291=[100798000, 206274505]；`afterHeredocDelimiter` 291=[99461664, 206273921, 213222352]。

289 的 heredoc 分析器 `ae(e,n)` @~203809900 对 `heredoc_redirect` 的**任何**非白名单子节点一律 too-complex：

```js
function ae(e,n){let r=null,t=null,s=null,a=!1;
  for(let l of e.children){if(!l)continue;
    if(l.type==="heredoc_start")r=l.text;
    else if(l.type==="heredoc_body")s=l;
    else if(l.type==="<<-")a=!0;
    else if(l.type==="heredoc_end")t=l.text;
    else if(l.type==="<<"||l.type==="file_descriptor");
    else return _(l)}          // 其它子节点（含 pipeline）→ too-complex
```

291 `pe(e,t,r)` @206273444 加了第三个参数 `r` = **该 heredoc 所属的 pipeline 节点**，并区分对待：

```js
var Je=new Set(["heredoc_start","heredoc_body","<<","<<-","heredoc_end","file_descriptor"]),
    et=new Set(["file_redirect","pipeline"]);
function pe(e,t,r){let s=null,o=null,n=null,l=!1;
  for(let h of e.children){if(!h)continue;
    if(Je.has(h.type)){ …记录 start/body/end/<<-… }
    else if(h===r&&h.children.at(-1)?.type==="command"
         &&h.children.every((p)=>p?.type==="|"
             ||p?.type==="command"&&!p.children.some((c)=>c?.type.endsWith("_redirect"))));   // 放行：纯管道
    else if(et.has(h.type)){let p=b(h);
      return p.kind==="too-complex"?{...p,afterHeredocDelimiter:!0}:p}                          // 打标后继续走正常分析
    else return{kind:"too-complex",
      reason:"Text after the heredoc start on the same line cannot be statically analyzed"}}
  if(n===null)return{kind:"too-complex",reason:"Heredoc body was not scanned by the parser",nodeType:"heredoc_redirect"};
  if(r){let h=Buffer.from(e.text,"utf8").subarray(0,n.startIndex-e.startIndex).toString("utf8"),
        p=e.children.slice(0,e.children.indexOf(n)).map((c)=>(c===r?"|":"")+(c?.text??"")).join("");
    if(h.indexOf(`\n`)!==h.length-1||h.includes("\\")||h.replace(/[ \t\n]/g,"")!==p.replace(/[ \t]/g,""))
      return{kind:"too-complex",reason:"More than a pipeline follows the heredoc delimiter on its line"}}
  …（其余与 289 字节一致：isQuoted、differential 展开检查、引号 delimiter 含反斜杠、<<- 带 tab、body 行以 delimiter 开头且含元字符）
```

即：管道节点被**放行**（前提是它的子节点只有 `|` 和无重定向的 `command`），但随后用字节级校验确认"delimiter 那一行除了管道没别的东西"——把 `e.text` 从开头到 body 起点的原始字节与子节点文本拼接（管道节点替换成 `|`）后去空白比对，任何不一致（换行不在末尾、含反斜杠、文本不匹配）就 too-complex。这是防"解析器看到的和 shell 实际执行的不一样"的差分校验。

redirect 预扫描器 `nt(e)` @206269974 同步获得 `Je`/`et`：

```js
if(e.type==="heredoc_redirect"){for(let t of e.children)
  if(t&&!Je.has(t.type)&&!et.has(t.type))
    return{kind:"too-complex",reason:"Text after the heredoc start on the same line cannot be statically analyzed"}}
```

命令列表分析器 `Wt(e,t,r,s,o)` @~206266300 负责把 pipeline 节点**穿线**下去：

```js
let p=t.length,
c=D&&o&&l.type==="command"&&a.length===0&&h.length===1
    ?h[0]?.children.find((f)=>f?.type==="pipeline"):void 0,d;
… d=new Map(r);
let f=E(l,t,c?new Map(r):r,s);if(f)return f …
for(let f of h){let g=pe(f,d,c);if(g)return g}
if(c){let f=E(c,t,r,s);if(f)return f}
if(h.length>0)for(let f=p;f<t.length;f++){let g=t[f];if(g)g.argvSourceLiteral=!1}
```

（无复合命令的分支仍用两参 `pe(f,r)` @206266697。）注意 `E(c,t,r,s)` —— 管道节点**自身也被完整分析一遍**，所以 `cat <<EOF | python3` 里的 `python3` 会进命令列表，权限规则能看见它。

权限层消费者 `gVe` 291 @213222352（289 对应 @210070400）：

```js
let W=await pee(e.command),
q=W?Az(e.command,W,{declarationPrefix:h}):{kind:"simple",commands:[],bareAssignmentNames:[]},
Y=n.forRemoteExecution!==!0&&q.kind==="too-complex"
  &&(q.nodeType==="heredoc_redirect"&&q.differential===!0
     ||q.nodeType==="pipeline"&&q.afterHeredocDelimiter===!0)
  &&We.isSandboxingEnabled()&&We.isAutoAllowBashIfSandboxedEnabled()&&ly(e)
  &&T("tengu_amber_larch",!0);
if(S!==void 0){let Zn=q.declarationPrefixes===void 0&&W&&Y
    ?Az(e.command,W,{plainUnquotedHeredocs:!0}):void 0,
  no=q.declarationPrefixes===void 0?Zn:q;
  if(no?.declarationPrefixes!==void 0)S(no.declarationPrefixes,no.declarationPrefixBashKeeps)}
… if(W&&Y){
  let xo=Az(e.command,W,{plainUnquotedHeredocs:!0,declarationPrefix:h}),
      bo=xo.kind==="simple"&&Hor(xo.commands,{sourceGlobRecord:eye()}).ok
          ?dVe(e,w,xo.commands,xo.bareAssignmentNames,n):null;
  if(bo!==null)return bo}
```

289 只有 `B.nodeType==="heredoc_redirect"&&B.differential===!0` 这一支，且 `zSe(e.command,w,{plainUnquotedHeredocs:!0})` **不带 `declarationPrefix`**。291 新增 `q.nodeType==="pipeline"&&q.afterHeredocDelimiter===!0` 这一支（正是 item 6 的用户可见修复：sandbox + autoAllowBashIfSandboxed 下，管道跟在 heredoc delimiter 后也能走自动允许而不是每次问），并给两处重解析都加上 `declarationPrefix`。`declarationPrefixBashKeeps` 291=[99461756, 206236734, 213222692] / 289=[]。`plainUnquotedHeredocs` 与 gate `tengu_amber_larch` 在**两版都有**（289 @203773244 / @210070969）。

### OCC 现状

- `src/utils/bash/ast.ts:1816` `walkHeredocRedirect(node)` —— **单参**，跳过 `heredoc_start`/`heredoc_body`/`<<`/`<<-`/`heredoc_end`/`file_descriptor`，对**任何其它子节点** `return tooComplex(child)`（1839 行），带 SECURITY 注释："tree-sitter places pipeline / command / file_redirect / && / etc. as children of heredoc_redirect when they follow the delimiter on the same line (e.g. `ls <<'EOF' | rm x`). Previously these were silently skipped, hiding the piped command from permission checks. Fail closed like every other walker."
- 未加引号 delimiter 返回 `{kind:'too-complex', reason:'Heredoc with unquoted delimiter undergoes shell expansion', nodeType:'heredoc_redirect'}` —— **没有 `differential` 标志**。
- `afterHeredocDelimiter`、`plainUnquotedHeredocs`、`tengu_amber_larch`、`declarationPrefixBashKeeps` 在 OCC 全部 **0 命中**。
- 调用链：`walkRedirectedStatement` @~1690 → `heredoc_redirect` 分支 1707-1708 → `walkHeredocRedirect`；另在 2434-2435、2450 被调用。`src/utils/bash/bashParser.ts` 的 heredoc 挂载（`heredocs` 117-118/140，body 附加 1363-1390：`heredocRedirect.children.push(bodyNode, endNode)`、`.endIndex = hd.endEnd`、`.text = sliceBytes(...)`）与官方一致；注释 1731-1733 明确写了 "Pipeline after heredoc_start: `one <<EOF | grep two` — tree-sitter nests the pipeline as a child of heredoc_redirect. ast.ts walkHeredocRedirect fails closed on pipeline/command via tooComplex"。
- 消费方：`src/tools/BashTool/bashPermissions.ts` 3123-3155、3190、3412、3505-3508、3587 处理 `astResult.kind === 'too-complex'`，2279 行 tooComplex 提前退出强制 deny，2898 行遥测。

**净结论**：OCC 在这一点上比官方 **289 更严**（289 对管道子节点也是 too-complex，但 289 有 `differential`+`tengu_amber_larch` 的 sandbox 恢复路径，OCC 连这条都没有）。所以 OCC 不会出现"绕过审批"的安全问题，但会出现官方 291 修的那个**用户体验 bug**：sandbox + autoAllowBashIfSandboxed 下 `cat <<EOF | python3` 每次都问。

### 判定

**STAGED**。分两层，建议按序：

- **6a（前置，属 289 追齐）**：`differential` 标志 + `tengu_amber_larch` gate + `plainUnquotedHeredocs` 重解析恢复路径。OCC 目前完全缺失。
- **6b（291 本体）**：`afterHeredocDelimiter` + pipeline 节点穿线 + delimiter 行字节级校验 + `declarationPrefix`/`declarationPrefixBashKeeps`。

### 移植方案 + 测试计划

**方案（6a → 6b 顺序）**

1. `src/utils/bash/ast.ts`：
   - `ParseForSecurityResult` 的 too-complex 变体（第 44 行）扩字段：`differential?: boolean`、`afterHeredocDelimiter?: boolean`（官方 `q.nodeType==="pipeline"&&q.afterHeredocDelimiter===!0`）。
   - `walkHeredocRedirect(node, varScope, pipelineNode?)` 加第三参；引入两个常量集合（官方 `Je` / `et`）：`HEREDOC_CHILD_TYPES = new Set(['heredoc_start','heredoc_body','<<','<<-','heredoc_end','file_descriptor'])`、`AFTER_DELIMITER_TYPES = new Set(['file_redirect','pipeline'])`。
   - 子节点循环按官方三分支：白名单记录；`child === pipelineNode && child.children.at(-1)?.type === 'command' && child.children.every(p => p?.type === '|' || (p?.type === 'command' && !p.children.some(c => c?.type.endsWith('_redirect'))))` → 放行（不落任何结论）；`AFTER_DELIMITER_TYPES.has(child.type)` → 走正常子 walker，若结果是 too-complex 则 `{...result, afterHeredocDelimiter: true}`；其它 → `{kind:'too-complex', reason:'Text after the heredoc start on the same line cannot be statically analyzed'}`。
   - body 缺失 → `{kind:'too-complex', reason:'Heredoc body was not scanned by the parser', nodeType:'heredoc_redirect'}`。
   - `pipelineNode` 存在时做官方那段**字节级校验**（`Buffer.from(node.text,'utf8').subarray(0, body.startIndex - node.startIndex)` 与"body 之前子节点文本拼接（pipelineNode 替换为 `|`）"比对；换行必须在末尾、不得含 `\`、去空白后必须相等），失败 → `{kind:'too-complex', reason:'More than a pipeline follows the heredoc delimiter on its line'}`。
   - 未加引号 delimiter 的返回值补 `differential: true`（官方 289/291 都有；这是 6a 的核心）。
2. `src/utils/bash/ast.ts` 的命令列表 walker（对应官方 `Wt`）：在"单一 command、无 `&&`/`||`、恰好一个 heredoc_redirect"的条件下，从其 children 里找 `pipeline` 节点并作为第三参传入；对 pipeline 节点**额外单独走一遍完整 walker**（官方 `E(c,t,r,s)`），使管道右侧命令进入命令列表；随后把新增命令的 `argvSourceLiteral` 置 false（官方 `g.argvSourceLiteral=!1`）。无复合命令分支保持两参调用。
3. `src/utils/bash/ast.ts` 的 redirect 预扫描器（对应官方 `nt`）：`heredoc_redirect` 的非白名单且非 `AFTER_DELIMITER_TYPES` 子节点 → 新 reason 字符串（同上）。
4. `src/tools/BashTool/bashPermissions.ts`：新增官方那条 sandbox 恢复判定，条件逐项照抄——`forRemoteExecution !== true` && too-complex && (`nodeType==='heredoc_redirect' && differential===true` || `nodeType==='pipeline' && afterHeredocDelimiter===true`) && sandbox 开启 && `autoAllowBashIfSandboxed` 开启 && 命令本身可 sandbox && gate `tengu_amber_larch`（默认 true）；命中时用 `{plainUnquotedHeredocs:true, declarationPrefix}` 重新解析，若结果 `kind==='simple'` 且命令集合通过既有 glob/source 校验，则走正常的 sandbox 自动允许分支。`declarationPrefixes` 回调同时传 `declarationPrefixBashKeeps`。
5. Gate 名严格用 `tengu_amber_larch`，默认值 `true`（官方 `T("tengu_amber_larch",!0)`）。**不要**自创开关名或改默认值。

**测试计划**

- 单测 `src/utils/bash/__tests__/`（parser + ast）：
  - `cat <<'EOF' | python3 -\n…\nEOF` → 不再 too-complex；命令列表含 `cat` 与 `python3`；`afterHeredocDelimiter` 不出现在最终 simple 结果里（因为管道被正常分析了）。
  - `cat <<EOF | python3`（未加引号 delimiter）→ too-complex 且 `nodeType:'heredoc_redirect'`、`differential:true`。
  - `ls <<'EOF' | rm x`（危险右端）→ 管道节点自身分析给出 rm 的 deny/ask，**不得**被 heredoc 放行逻辑吞掉。
  - `cat <<'EOF' | tee f | sh`、`cat <<'EOF' > out | sh` → 含 `_redirect` 的 command 使放行前提失败 → too-complex `Text after the heredoc start on the same line cannot be statically analyzed`。
  - delimiter 行有额外内容（`cat <<'EOF' # cmt | sh`、含 `\` 续行、多命令 `cat <<'EOF' | a; b`）→ `More than a pipeline follows the heredoc delimiter on its line`。
  - `<<-` 带 tab、body 行以 delimiter 开头且含元字符、引号 delimiter 含反斜杠 → 保持 289 既有的 too-complex reason 不变（回归）。
- 单测 `bashPermissions`：sandbox + `autoAllowBashIfSandboxed` 开启时，上述两类 too-complex 命中恢复路径 → 返回自动允许（不问）；sandbox 关闭 / gate 关闭 / `forRemoteExecution:true` → 仍问。
- **行为 e2e**（必须，source-grep 不算完成）：真实起 `occ` REPL，开 sandbox + autoAllowBashIfSandboxed，连续两次执行 `cat <<'EOF' | python3 -c 'import sys;print(sys.stdin.read())'`，断言**第二次不再弹审批**（第一次可能建立规则）；对照 `cat <<EOF | python3`（未引号）断言仍按官方策略处理。用 tmux `capture-pane` 抓真实交互，不要用 mock。

---

## 7. `git clone` 短选项保留了 `sandbox.excludedCommands` 里 `git *` 的豁免

### 官方机制

291 @213242966（gate `tengu_mossy_crayon` 291=[98491876, 213243852] / 289=[]；`"-u",["clone"]` 291=[213243831] / 289=[]）：

```js
=new Set(["git","deno","bun"]),
Thr={git:[["-x",["rebase","difftool"]],["-d",["instaweb"]],["--file",["config"]],["-f",["config"]],
  ["--prefix",["checkout-index"]],["-o",["archive","format-patch"]],["--output-directory",["format-patch"]],
  ["--rename-section",["config"]],["rename-section",["config"]],["--template",["clone","init"]],
  ["-c",["clone"]],["--config",["clone"]],["edit",["config"]],["--edit",["config"]],["-e",["config"]],
  ["-O",["grep"]],["--tree-filter",["filter-branch"]],…,["--cc-cmd",["send-email"]]]},
Ehr=["-u",["clone"]],Rhr="tengu_mossy_crayon";
function Chr(){return Yy(Rhr,{safe:!0})}
var Ahr={clone:["b","o","j","u"],rebase:["C","S","X","s"],difftool:["t"],instaweb:["b","m","p"],
  config:[],archive:[],format-patch:["v"],grep:["e","f","A","B","C","m"]}
function Dhr(e,n){let r=ya(Thr,e);if(r===void 0)return!1;
  let s=e==="git"&&Chr()?[...r,Ehr]:r,          // ← 291 的全部新增：把 -u 并进表
      g=XVe(n).map(mW),h=hon.has(e);
  return s.some(([S,w])=>{let H=g.find((Y)=>w.includes(Y));if(H===void 0)return!1;
    let W=/^-[A-Za-z]$/.test(S),q=ya(Ahr,H)??[];
    return n.some((Y)=>Y===S||S.startsWith("-")&&(Y.startsWith(S)||zVe(Y,S,!1,W,q,h)))})}
```

289 的 `F3o(e,n)` @210090842 与之**逐字节相同，只少 `Chr()` 那一行 gate 与 `Ehr` 合并**。所以 291 的实质变化就是：`git clone -u <…>`（`--upload-pack` 的短形式）现在也被视为危险选项，从而**不再**从 `sandbox.excludedCommands` 的 `git *` 里拿到豁免。

另一张独立的危险选项表 `Bgr`（291 @213233441）/ `t3o`（289 @210081259）**两版字节一致**，且早已包含长形式：`git:["--extcmd","--config-env","--exec-path","--upload-pack","--output","--unsafe-paths","--directory","--separate-git-dir","--open-files-in-pager","--httpd","--receive-pack","--access-hook"]` —— 长形式一直有覆盖，漏的正是短 `-u`。

调用链：`dnr()`(291 @207466190)/`vXn()`(289 @204993563) → trusted-tier 过滤 `kte()`(291 @207575958)/`ote()`(289 @205093860) → `uyr(e,n="bash")` @291:213250810 / `l9o` @289:210098564 → `gyr`/`h9o` → `ion`/`i6t` → `hye` → `lon`/`l6t` → `Dhr`/`F3o`。`hye` 还喂给 `MBo`（@291:213253040）/`HOo`（@289:210100790）。

### OCC 现状

- `src/tools/BashTool/shouldUseSandbox.ts:242` `containsExcludedCommand(command)`：先查 ant-only 的 `tengu_sandbox_disabled_commands`（命令 + 子串），再 `SandboxManager.getExcludedCommands()`（280）→ `splitCommand_DEPRECATED(command)`（296，try/catch 退回 `[command]`）→ `isEnvAssignmentSmuggling(subcommands)`（308，官方 2.1.277 `Avo`）→ 每个 part 都要 `matchWildcardPattern` 命中。239-241 行注释："excludedCommands is a user-facing convenience feature, not a security boundary."
- `src/utils/sandbox/sandbox-adapter.ts:1476-1496` `getExcludedCommands()` 实现了 trusted-tier 过滤，日志文本与官方逐字节一致：`[sandbox] excludedCommands restricted to trusted settings tiers: ignoring ${droppedCount} sandbox.excludedCommands entr${droppedCount===1?'y':'ies'} not set by managed, --settings, or user settings`。
- **两张选项表（`Thr` 的 per-subcommand 危险选项表 + `Bgr` 的独立危险选项表）在 OCC 完全不存在**：grep `extcmd|config-env|exec-path|unsafe-paths|separate-git-dir|open-files-in-pager|access-hook|receive-pack|rename-section|tree-filter|instaweb|checkout-index|format-patch|send-email|difftool` 只命中 `src/tools/PowerShellTool/readOnlyValidation.ts:1540,1541,1569,1570,1617`、`src/tools/BashTool/worktreeGitRedirectGuard.ts:40,47,206,550,598,601,603,605,615`（那是 `lzg` 的 `-c`/`--config-env` key-redirect 守卫）、`src/tools/BashTool/readOnlyValidation.ts:1733-1747`（正则 `/\s--exec-path[\s=]/`、`/\s--config-env[\s=]/`）、`src/utils/git.ts:584,857,862`。都不是 excludedCommands 豁免过滤。
- 头部辅助函数已有：`SAFE_ASSIGNMENT_VAR_NAMES`（官方 `nz`，39 项）、`LOCALE_ASSIGNMENT_VAR_NAMES`（`GEo`）、`PURE_ENV_ASSIGNMENT_PATTERN`（`zEo`）、`isPureEnvAssignment`（`asn`）、`unescapeBackslashesOutsideSingleQuotes`（`uSt`）。

### 判定

**STAGED**，且缺口比 changelog 描述的大：OCC 不是"短 `-u` 漏了"，而是**整条"危险选项 → 撤销 excludedCommands 豁免"的链路都不存在**。也就是说 OCC 现在 `sandbox.excludedCommands: ["git *"]` 会对 `git clone --upload-pack=<任意命令>`、`git -c core.sshCommand=… `、`git rebase -x <cmd>` 等**全部**放行豁免——比官方 289 宽松得多，是安全缺口，优先级应高于本簇其它 STAGED 项。

### 移植方案 + 测试计划

**方案**

1. 新建 `src/utils/sandbox/excludedCommandOptions.ts`：
   - `TRUSTED_OPTION_TOOLS = new Set(['git','deno','bun'])`（官方 `hon`）。
   - `DANGEROUS_SUBCOMMAND_OPTIONS`：逐条抄 `Thr`（`git` 的 `[option, subcommands[]]` 数组；`deno`/`bun` 同表其它键——**需再从二进制把 `Thr` 完整 dump 一遍**，上面的片段用 `…` 省略了中段，实施时不得凭记忆补全）。
   - `EXTRA_GIT_CLONE_UPLOAD_PACK = ['-u', ['clone']]`（官方 `Ehr`）。
   - gate `tengu_mossy_crayon`，通过 OCC 既有 gate 助手读取，`{safe: true}` 语义（官方 `Yy(Rhr,{safe:!0})`，即 gate 不可用时按"启用"处理）。
   - `SHORT_OPTION_TAKES_VALUE` = 官方 `Ahr`（`clone:["b","o","j","u"]`、`rebase:["C","S","X","s"]`、`difftool:["t"]`、`instaweb:["b","m","p"]`、`config:[]`、`archive:[]`、`format-patch:["v"]`、`grep:["e","f","A","B","C","m"]`）。
   - `hasDangerousOption(tool, argv): boolean` = 官方 `Dhr`：取表；`tool === 'git' && gate` 时并入 `Ehr`；找出 argv 里第一个属于该选项 subcommand 列表的子命令；`/^-[A-Za-z]$/` 判定是否单字母短选项；再用官方 `zVe(Y,S,!1,W,q,h)` 的等价实现比对（含 `Y === S`、`S.startsWith('-') && Y.startsWith(S)`、以及短选项粘连/`=` 取值形态）。**`zVe` 需要单独从二进制取证后再实现，不可臆造。**
   - 另建 `DANGEROUS_OPTIONS_STANDALONE`（官方 `Bgr`/`t3o`，289 与 291 字节一致）用于独立检查。
2. `src/tools/BashTool/shouldUseSandbox.ts:242` `containsExcludedCommand`：在"每个 part 都 matchWildcardPattern"之后，加官方那层撤销——若某个 part 的工具在 `TRUSTED_OPTION_TOOLS` 且 `hasDangerousOption(tool, argv)` 为真，则该 part **不**算命中豁免（整条命令因此仍进 sandbox）。argv 切分复用 OCC 既有 `splitCommand_DEPRECATED` 的结果 + 一个 argv 归一化助手（官方 `XVe(n).map(mW)`）。
3. 保留 239-241 行"not a security boundary"注释，但补一句：官方仍对危险选项撤销豁免，OCC 跟随。

**测试计划**

- 单测 `hasDangerousOption`：
  - `git clone -u /tmp/evil.sh https://x` → true（291 修复点）；`git clone --upload-pack=/tmp/evil.sh …` → true（289 已覆盖，回归）；
  - `git clone -b main --depth 1 https://x` → false（`-b` 不在表里）；
  - `git -c core.sshCommand=x clone …` / `git clone -c …` → true；
  - `git rebase -x 'touch /tmp/pwn'` → true；`git rebase --onto a b` → false；
  - 短选项粘连形态（`git clone -ub main …`，`u` 在 `Ahr.clone` 里表示取值）→ 按 `zVe` 语义断言（**先取证 `zVe` 再写断言**）；
  - `deno`/`bun` 的表项各一例；
  - gate 关闭（`tengu_mossy_crayon` 返回 false）→ `-u` 不并入，回到 289 行为；gate 不可用 → 按 `safe:true` 视为开启。
- 单测 `containsExcludedCommand`：`excludedCommands:['git *']` 下，`git status` → 豁免（不进 sandbox）；`git clone -u …` → **不**豁免（进 sandbox）；`git clone --upload-pack=…` → 不豁免。
- **行为 e2e**：真实 `occ` REPL，项目设置 `sandbox.excludedCommands: ["git *"]` + `sandbox.enabled`，执行 `git clone -u /tmp/probe.sh <local-repo>`，断言命令**在 sandbox 内**运行（探针脚本对 sandbox 外路径的写入被拦），而 `git status` 不在 sandbox 内运行。tmux `capture-pane` + 文件系统副作用双重验证。

---

## 8. sandbox auto-allow 下 Monitor 工具命令跳过权限提示

### 官方机制

291 MonitorTool @~217393171：

```js
function xe(e,n){return zYn({...e,command:e.command},
  {...n,permissionLayers:[...n.permissionLayers??[],{kind:"sandbox_auto_allow_suspended"}]})}
async checkPermissions(n,s){
  let r=F(e,s);
  if(n.ws){let d=OBo("Monitor websocket",r.shellPermission);
    if(d!==void 0)return d;
    return Oe(n.ws)}
  return xe(n,r.shellPermission)}
```

289 同一位置是 `return mVn({...n,command:n.command},r.shellPermission)` —— 直接走 shell 权限检查，**不带** `sandbox_auto_allow_suspended` 层。字面串计数：`sandbox_auto_allow_suspended` 4→5（新增 @217394370）；`sandboxAutoAllowSuspended` 8→8（消费者两版都有，291 @~205873352 / 289 @~203417961）：

```js
case"sandbox_auto_allow_suspended":
  if(!o.sandboxAutoAllowSuspended)o={...o,sandboxAutoAllowSuspended:!0};
  break;
```

门禁 `S8t(e){return dp(e)||e.sandboxAutoAllowSuspended===!0}`（289 `e4t`）。即：Monitor 是长驻流式工具，一次批准要跑很久，官方认为它**不该**享受"sandbox 内 Bash 自动允许"的便利——挂起该层后，Monitor 命令必须按用户真实的权限规则走问询。

### OCC 现状

- `src/tools/MonitorTool/MonitorTool.ts`（19,980 B）：`export const MonitorTool = buildTool({name:'Monitor', shouldDefer:true, isConcurrencySafe(){return false}, isReadOnly(){return false}, toAutoClassifierInput(input){return input.description??''}, async call(input,_context){…}, renderToolUseMessage…})`（386 行）。**没有 `checkPermissions`**。
- shell 路径：`streamCommand`（278 行）→ `Bun.spawn([shellPath(),'-c',command])`（283 行）；ws 路径 `streamWs`（329 行）。
- `sandbox_auto_allow_suspended` / `sandboxAutoAllowSuspended` = **0 命中**。
- `permissionLayers` 在 OCC 只作为两处注释存在：`src/utils/permissions/fileStateGuard.ts:41,158`。没有 layer 数组、没有 reducer、没有 `S8t` 门禁。
- 98 行有明确的 OCC-divergence banner：事件投递尚未接通（occ127）。

### 判定

**N-A**（表面缺失，grep 证明）：OCC MonitorTool 没有 `checkPermissions`、没有 sandbox 集成、没有 `permissionLayers` 机制，因此不存在"sandbox auto-allow 让 Monitor 跳过权限提示"这条路径——OCC 的 Monitor 命令压根不走 sandbox 自动允许。

**但需登记一条独立的、更严重的 OCC 缺口（不属本条 changelog）**：Monitor 直接 `Bun.spawn` shell 命令且**没有任何权限检查**，这比官方 289 还宽松。建议另开 issue：先给 MonitorTool 补 `checkPermissions`（对齐官方 289 的 `mVn(...)` 即 shell 权限检查），再谈 291 的 `sandbox_auto_allow_suspended` 层。`permissionLayers` 机制本身是官方一整套权限层 reducer，属独立基建。

### 移植方案 + 测试计划

本条不移植。前置 issue 的方案（供排期参考）：

1. `src/tools/MonitorTool/MonitorTool.ts` 加 `checkPermissions(input, context)`：`ws` 分支走 ws 权限检查（官方 `OBo("Monitor websocket", …)` + `Oe(n.ws)`），shell 分支走与 BashTool 相同的命令权限检查（官方 289 `mVn`）。
2. 待 OCC 引入 `permissionLayers` 基建后，再补 `{kind:'sandbox_auto_allow_suspended'}` 层 + reducer case + `S8t` 等价门禁，字面串与官方一致。

**测试计划**（前置 issue）

- 单测：Monitor 的 shell 命令命中 deny 规则 → 拒绝；命中 ask 规则 → 问询；`ws` URL 不在允许列表 → 拒绝。
- 行为 e2e：REPL 里让模型调用 Monitor 跑一条未在 allow 列表的命令，tmux 断言出现权限问询；配 deny 规则后断言直接拒绝且不 spawn 进程。

---

## 9. PreToolUse hook 改写 input 后部分权限规则与安全检查未生效

### 官方机制

291 全新字面串：`but an ask rule, a safety check or a ToolHost's person-only ask requires the full permission pipeline` 291=[99444678, 212249234] / **289=[]**；`permissionModeAtRequest:` 291=6 处（211939154, 212290540, 212883786, 213284319, 213284902, **213322478**）vs 289=5 处（208866344, 209144224, 209735994, 210250790, 210251373）→ 第 6 处即新函数 `XBo`。

291 `d0o` @~212248300：

```js
function Wje(e,n){return(e?.behavior==="allow"||e?.behavior==="ask"?e.updatedInput:void 0)??n}
async function d0o(e,n,r,s,g,h,S){…
  let H=e.behavior,W=Wje(e,r),q=kUe(W);if(q!==null)return{decision:q,input:W};
  let Y=await fA(n,W,{...s,toolUseId:S},{hookUpdatedInput:e.updatedInput})
        ?? await XBo(n,W,s,h,S);                                   // ← 291 新增的 ?? 兜底
  if(Y?.behavior==="deny")return t(`Hook returned '${H}' for ${n.name}, but deny rule overrides `
      +`(deny's reason type: ${Y.decisionReason?.type??"none"})`),Jce(qce(Y),{…});
  if(Y?.behavior==="ask"){let he=H==="ask";
    return t(`Hook returned '${H}' for ${n.name}, but an ask rule, a safety check or a ToolHost's `
      +`person-only ask requires the full permission pipeline`
      +`${he?" (hookAskFloor \u2014 a classifier allow re-surfaces as this ask)":""}`),
    {decision:await g(n,W,he?{...s,hookAskFloor:!0}:s,h,S),input:W}}
  if(H==="allow"){…
    let he=de(s),_e=$P(n,he),ke=Ii(_e)&&aXo(n.name),
        be=!ke&&_e==="auto"&&T("tengu_virtual_knuth",!1),
        Te=!ke&&!be&&hN(n,he);
    if(!n.requiresUserInteraction?.()&&(ke||be||Te)){
      …i("tengu_auto_mode_hook_allow_funneled",{toolName:…,isMcp:…,remoteSessionMcp:Te,…}),
      t(`Hook approved tool use for ${n.name}, but auto mode requires classifier adjudication`),
      {decision:await g(n,W,{...s,hookAllowVouched:!0},h,S),input:W}}}
```

289 `uyo` @209099707 与之相同，**除三点**：
1. `let V=await DP(n,H,{...s,toolUseId:S},{hookUpdatedInput:e.updatedInput});` —— **没有 `??` 兜底**；
2. 旧日志文本：`but deny rule overrides: ${V.message}`、`but ask rule/safety check requires full permission pipeline`；
3. auto-mode 漏斗条件更窄：`if(!n.requiresUserInteraction?.()&&T0(n,de(s))==="auto"&&A("tengu_virtual_knuth",!1))`，遥测无 `remoteSessionMcp`。

291 新增的兜底 `XBo` @213322376 是**完整的 served-call / ToolHost 权限管线**：

```js
function XBo(e,n,r,s,g){let h=kwt(r.session,e.name);if(h===void 0)return null;
  let S={...r,toolUseId:g,permissionModeAtRequest:S4(s,g,r)},
  w=await Irn(h,e,n,S,s,g,()=>Promise.resolve({behavior:"deny",
    message:`${e.name} was not run: its permission check could not be completed.`,
    decisionReason:{type:"other",reason:"permission check failed"}}));
  return w.behavior==="deny"||w.behavior==="ask"&&(LW(w)||xd…
function hN(e,n){return e.mcpInfo!==void 0&&BBr($P(e,n),n)}
function BBr(e,n){return a.CLAUDE_CODE_REMOTE&&Ii(e,n.servedCall===!0)&&mL(n.mode)==="arbiter"&&T(a0o,!1)}
```

即：快速路径 `fA`（≡289 `DP` @210285997，deny 规则 + auto-mode 快查）返回 `null`（"我没有意见"）时，291 会再问一次**远程 served-call / ToolHost** 的完整管线；只有当它对 hook 改写后的 input 给出 deny/ask，才推翻 hook 的 allow。这修的是"PreToolUse hook 改了 input，但只跑了快速规则检查，没跑 ToolHost 的 person-only ask 与安全检查"。

其它：`kUe`(291 @211948008) ≡ `nLe`(289 @209092933) —— `__artifact*` key 拒绝；两遍 managed-hook 编排 `Eut`/`Tzn`(291 @210576400) 与 289 的 `jat`/`SBn`(@208046450) **字节一致**，不是本条的 delta。

### OCC 现状

- `src/services/tools/toolHooks.ts:395-527` `resolveHookPermissionDecision(hookPermissionResult, tool, input, toolUseContext, canUseTool, assistantMessage, toolUseID)` —— 精确对齐官方 **289**，包括两条 289 日志串：
  - 476 行 `` `Hook returned '${hookBehavior}' for ${tool.name}, but deny rule overrides: ${ruleCheck.message}` ``
  - 488 行 `` `Hook returned '${hookBehavior}' for ${tool.name}, but ask rule/safety check requires full permission pipeline${isHookAsk ? ' (hookAskFloor — a classifier allow re-surfaces as this ask)' : ''}` ``
  - `hookInput = hookPermissionResult.updatedInput ?? input`（435）；`checkRuleBasedPermissions(tool, hookInput, {...toolUseContext, toolUseId: toolUseID})`（468）；`canUseTool(..., undefined, isHookAsk)`（491-499）；forceDecision 路径（516-525）。
- **没有 `??` 全管线兜底**；`hookAllowVouched` = 0 命中；`servedCall` / `arbiter` / `effectiveMaxPermission` = **0 命中**。
- `src/services/tools/toolExecution.ts`：`checkPermissionsAndCallTool` @541；input 强制转换在 hooks **之前**（2.1.280 对齐注释）；`tool.validateInput?.(parsedInput.data, toolUseContext)` @661 跑在 **pre-hook** input 上；`deniedByPermissionRule` → `onPermissionDenial`（2.1.269 E29）；speculative bash classifier；`_simulatedSedEdit` 剥离；`backfillObservableInput` clone；`for await (const result of runPreToolUseHooks(...))` 带 `case 'hookUpdatedInput': processedInput = result.updatedInput`；随后 @~924 `resolveHookPermissionDecision(hookPermissionResult, tool, processedInput, …)` 并 `processedInput = resolved.input`。
- `hookAskFloor` 存在于 `src/QueryEngine.ts`、`src/hooks/useCanUseTool.tsx`、`toolHooks.ts`、`src/utils/permissions/permissions.ts`。

### 判定

**N-A（实质修复）+ LOW（日志文本对齐）**。

- 实质修复依赖 `kwt(session, toolName)` 的 ToolHost 注册表、`servedCall`、`arbiter` 模式、`permissionModeAtRequest`、`Irn` 完整管线 —— OCC 全部不存在（grep 0 命中），且属于 CLAUDE_CODE_REMOTE 远程会话基建。OCC 的 hook allow 之后走的是 `checkRuleBasedPermissions` + `canUseTool`，本地场景下 deny/ask 规则确实会推翻 hook allow（476、488 行），**没有官方那个漏洞的本地对应面**。
- 可做的 LOW 项：把两条日志文本对齐 291 措辞（`but deny rule overrides (deny's reason type: ${…??'none'})`、`but an ask rule, a safety check or a ToolHost's person-only ask requires the full permission pipeline`），并把 auto-mode 漏斗从"`==='auto' && tengu_virtual_knuth`"扩成官方 291 的三支（`ke||be||Te`）+ `hookAllowVouched` + 遥测 `remoteSessionMcp` 字段——**但 `ke`/`Te` 两支依赖 OCC 没有的 `aXo`/`hN` 语义，故只能落地 `be` 支**，其余留 TODO 注释指向官方符号。

### 移植方案 + 测试计划

**方案（仅 LOW 部分，可选）**

1. `src/services/tools/toolHooks.ts:476`：日志改为 `` `Hook returned '${hookBehavior}' for ${tool.name}, but deny rule overrides (deny's reason type: ${ruleCheck.decisionReason?.type ?? 'none'})` ``。
2. `:488`：改为 `` `Hook returned '${hookBehavior}' for ${tool.name}, but an ask rule, a safety check or a ToolHost's person-only ask requires full permission pipeline${isHookAsk ? ' (hookAskFloor — a classifier allow re-surfaces as this ask)' : ''}` ``。
3. auto-mode 漏斗：在既有 `=== 'auto' && gate('tengu_virtual_knuth', false)` 之外，加 `hookAllowVouched: true` 传给 `canUseTool`，遥测事件 `tengu_auto_mode_hook_allow_funneled` 补 `remoteSessionMcp: false`（OCC 无远程 served-call，恒 false）并加注释说明官方 `ke`/`Te` 两支依赖 `aXo`/`hN`，OCC 待远程基建后补。
4. 明确注释：官方 291 的 `?? await XBo(...)` 兜底在 OCC 无对应面，**不要**造一个假的 ToolHost 兜底。

**测试计划**

- 单测：PreToolUse hook 返回 allow 且改写了 input，同时存在 deny 规则命中改写后的 input → 最终 deny，日志文本精确匹配新串；存在 ask 规则 → 走完整 `canUseTool` 且 `hookAskFloor` 为真（当 hook behavior 是 ask）；auto 模式 + `tengu_virtual_knuth` 开 → `canUseTool` 收到 `hookAllowVouched:true`，遥测含 `remoteSessionMcp:false`。
- 行为 e2e：真实 `occ` REPL 配一个改写 Bash command 的 PreToolUse hook + 一条 deny 规则匹配改写后的命令，断言命令被拒且日志（`--debug`）出现新文本。

---

## 10. Linux 上 `.claude/settings.json` 不存在时 sandbox 内 Bash 触发 ConfigChange hook + 中途重载设置

### 官方机制

291 全新（`projectScoped` 291=3 处：100726692, 206385936, 206394039 / **289=0**）。核心谓词 291 @206394845（`isFile()&&e.size===0` @206394869 与 `nlink===1&&(e.mode&511)===292` @206394893 在 289 均 0 命中）：

```js
function Ui(e){return e.isFile()&&e.size===0&&e.nlink===1&&(e.mode&511)===292}   // 292 = 0o444
```

这是识别 **sandbox-runtime 为"被拒绝读的文件"放置的占位文件**（0 字节、单硬链接、只读 0444）——sandbox 会把宿主上不存在的 `.claude/settings.json` 以这种占位形式呈现给沙箱内进程。

291 `Jo(W,H)` @206384500 vs 289 `si(B,V)` @203905800，四处差异：

```js
// 291 only:
let Ge=new Set;                                            // 空集 = 默认不启用占位过滤
ignored:(Pe,ct)=>{…; let qn=ke.normalize(Pe);
  if(Me.has(qn))return Ge.has(qn)&&Ui(ct);                 // 289: if(Re.has(Br))return!1;
  if(Ce&&qn.startsWith(Ce+ke.sep)&&qn.endsWith(".json"))return!1;
  return!0},
if(L=at,at.options?.usePolling===!1&&(O()==="linux"||O()==="wsl"))Ge=W.projectScoped;   // 仅 linux/wsl + inotify 模式启用
at.on("unlinkDir",(Pe)=>{if(Me.has(ke.normalize(Pe)))ii(Pe)}),                          // 291 only (@206386068)
…Qo(Me,Ql,Ge)                                              // 289: ai(Re,hc)
async function Qo(W,H,le){… let Kn=le.has(Ce)&&Ui(Ge);
  if(he.has(ke.dirname(Ce))&&!Kn||Me!==null&&Ge.mtimeMs>=Me)Vn(Ce)}
```

`ignored` 的语义反转是关键：289 对"我关心的 settings 文件"**一律返回 false（= 监视）**；291 变成 `Ge.has(qn) && Ui(ct)` —— 只有当该文件属于 `projectScoped` 集合**且**当前 stats 是 sandbox 占位文件时，才返回 true（= **忽略**）。即：项目级 settings 文件在 sandbox 里呈现为 0 字节 0444 占位时，chokidar 不去 watch 它，于是 sandbox 内 Bash 命令不会触发假的 change 事件 → 不跑 ConfigChange hook、不中途重载设置。同时新增 `unlinkDir` 监听，让目录被移除时也能清理（占位文件消失）。

计划构造器 291 `Gi(e)` @206391600 返回 `{dirs:[...de], settingsFiles:L, projectScoped:w, dropInDir:A, realpathToCanonical:s, servedByV5:S, pendingDirs:I}`；289 `Zi(e)` @203913000 相同但**无 `projectScoped`**。`w` 的构造两版都有：`if(X==="projectSettings"||X==="localSettings")w.add(J)` 与 `let R=Lb();if(R)h.push(R),w.add(R)`。

### OCC 现状

- `src/utils/settings/changeDetector.ts`（488 行）`initialize()` @84：remote 模式早退；`startMdmPoll()`；`registerCleanup(dispose)`；`const {dirs, settingsFiles, dropInDir} = await getWatchTargets()`；`chokidar.watch(dirs, {persistent:true, ignoreInitial:true, depth:0, awaitWriteFinish:{stabilityThreshold:…, pollInterval:…}, ignored:(path,stats)=>{…}, ignorePermissionErrors:true, usePolling:false, atomic:true})`；`.on('change',handleChange)`、`.on('unlink',handleDelete)`、`.on('add',handleAdd)` —— **没有 `unlinkDir`**。
- `ignored` @113-137：`if (stats && !stats.isFile() && !stats.isDirectory()) return true` → `.git` 段检查 → `if (!stats || stats.isDirectory()) return false` → `const normalized = platformPath.normalize(path)` → `if (settingsFiles.has(normalized)) return false`（**即 289 的一律 watch 语义**）→ drop-in `.json` 前缀检查 → `return true`。
- `getWatchTargets()` @180-250 返回 `{dirs, settingsFiles:Set<string>, dropInDir}`（跳过 `flagSettings`，建 `dirToSettingsFiles`/`dirsWithExistingFiles`）—— **无 `projectScoped` / `realpathToCanonical` / `servedByV5` / `pendingDirs`**。
- `projectScoped` 在 OCC = **0 命中**。
- 其余：`handleChange` @268 → `executeConfigChangeHooks(settingSourceToConfigChangeSource(source), …)` @292，block 检查 @297；`handleAdd` @308；`handleDelete` @330（hook @344-349）；`getSourceForPath` @362；`startMdmPoll` @381；`fanOut` @437；`notifyChange` @447；`resetForTesting` @461；`settingsChangeDetector` @482。`src/utils/settings/internalWrites.ts` 提供 `markInternalWrite`/`consumeInternalWrite`/`clearInternalWrites`。

### 判定

**STAGED**。OCC 精确停在 289 语义（`settingsFiles.has(normalized) → return false`），因此 OCC 在 Linux sandbox 下会有同样的 bug：sandbox-runtime 为不存在的 `.claude/settings.json` 放 0444 空占位 → chokidar 看到"新文件/变更" → 跑 ConfigChange hook + 中途重载设置。

### 移植方案 + 测试计划

**方案**

1. `src/utils/settings/changeDetector.ts`：
   - 加常量 `const SANDBOX_PLACEHOLDER_MODE = 0o444`，实现 `isSandboxPlaceholderFile(stats): boolean` = `stats.isFile() && stats.size === 0 && stats.nlink === 1 && (stats.mode & 0o777) === SANDBOX_PLACEHOLDER_MODE`（官方 `Ui`）。
   - `getWatchTargets()` 返回值增加 `projectScoped: Set<string>`：对 `projectSettings` / `localSettings` 两个 source 的路径 `add`，以及 `--settings` 指定的文件（官方 `let R=Lb();if(R)h.push(R),w.add(R)`）。命名与官方一致，便于后续对齐 `realpathToCanonical`/`servedByV5`/`pendingDirs`。
   - `initialize()` 内新增 `let placeholderScoped = new Set<string>()`（官方 `Ge`），在 watcher 建好后：`if (watcher.options?.usePolling === false && (platform() === 'linux' || platform() === 'wsl')) placeholderScoped = projectScoped`。**严格保留这两个前提**（inotify 模式 + linux/wsl），其它平台/polling 模式行为不变。
   - `ignored(path, stats)` 把 `if (settingsFiles.has(normalized)) return false` 改为 `if (settingsFiles.has(normalized)) return placeholderScoped.has(normalized) && isSandboxPlaceholderFile(stats)`（`stats` 可能为 undefined → 返回 false，与官方 `Ui(undefined)` 会抛的语义不同，需用 `!!stats && isSandboxPlaceholderFile(stats)` 保护；官方在此处 stats 恒有值，因为 chokidar 对已存在路径会带 stats）。
   - 新增 `.on('unlinkDir', (p) => { if (settingsFiles.has(platformPath.normalize(p))) handleDelete(p) })`（官方 @206386068 调 `ii(Pe)`，即与 unlink 同一处理）。
   - 目录级重扫判定（官方 `Qo` 里的 `Kn=le.has(Ce)&&Ui(Ge)`）：在 OCC 对应的"目录 mtime 变化 → 重扫"逻辑里加同样的占位例外——若目录属于 `placeholderScoped` 且其 stats 是占位文件，则**不**触发重扫。OCC 当前若无该分支，则记 TODO 并在实现时对齐。
2. 不改 `internalWrites.ts`、不改 hook 执行路径。

**测试计划**

- 单测 `src/utils/settings/__tests__/changeDetector.test.ts`：
  - `isSandboxPlaceholderFile`：0 字节 + nlink 1 + mode 0444 → true；0 字节 + 0644 → false；非空 + 0444 → false；nlink 2 → false；目录 → false。
  - `ignored`：linux + `usePolling:false` + 项目级 settings 路径 + 占位 stats → true（忽略）；同样路径但 stats 是真实文件 → false（watch）；用户级 settings 路径（不在 `projectScoped`）+ 占位 stats → false（watch，官方只对 projectScoped 生效）；非 settings 路径 → true（不变）。
  - 平台门禁：mock platform 为 `darwin` → `placeholderScoped` 保持空集，行为回到 289；`usePolling:true` → 同样空集。
  - `unlinkDir`：目录被移除且属于 settingsFiles → `handleDelete` 被调用一次。
  - `getWatchTargets()` 返回的 `projectScoped` 恰含 projectSettings/localSettings/`--settings` 三类，不含 user/managed/flag。
- **行为 e2e**（Linux，必须真实 sandbox）：起 `occ` REPL，项目内**不存在** `.claude/settings.json`，配一个 ConfigChange hook 写标记文件；在 sandbox 内跑一条 Bash 命令；断言标记文件**未**被写、设置未重载；对照组：真实创建 `.claude/settings.json` 并修改，断言 hook **被**触发（无回归）。

---

## 11. Linux/WSL 上 `~/**/.env` 这类 sandbox 读规则覆盖大目录导致卡死

### 官方机制

`getFsReadConfig` 291 @207583900 vs 289 @205101400：

```js
getFsReadConfig:()=>{
  let e=jt.getConfig();
  if(e?.filesystem.disabled)
    return{denyOnly:e.filesystem.denyRead.map(tm),allowWithinDeny:(e.filesystem.allowRead??[]).map(tm)};
  let r=xt();
  if(r.fsReadConfigMemo!==void 0&&r.fsReadConfigMemo.cfg===e)return r.fsReadConfigMemo.result;   // 记忆化
  let n=O(),s=e?.credentials?.files??[],h=s.filter((g)=>g.mode==="deny").map((g)=>g.path);
  if((n==="linux"||n==="wsl")
     &&[...e?.filesystem.denyRead??[],...e?.filesystem.allowRead??[],...h].some((g)=>Id(tm(g)))){
    let g=wB(e,h);return r.fsReadConfigMemo={cfg:e,result:g},g}                                  // ← 291 新增：绕开 glob 展开
  try{let g=jt.getFsReadConfig();return r.fsReadConfigMemo={cfg:e,result:g},g}
  catch(g){t(`[sandbox] getFsReadConfig threw; falling back to raw deny lists: ${g}`);
    let E=wB(e,s.map((S)=>S.path));return r.fsReadConfigMemo={cfg:e,result:E},E}}}
```

新共享助手 291 @207587071：

```js
function wB(e,r){return{
  denyOnly:D([...e?.filesystem.denyRead??[],...r].map(tm)),
  allowWithinDeny:(e?.filesystem.allowRead??[]).map(tm)}}
```

glob 谓词 291 @206613927：

```js
function Id(e){return e.includes("*")||e.includes("?")||e.includes("[")||e.includes("]")}
function Fbt(e){return e.includes("*")||e.includes("?")}
function ikn(e){return MS()==="windows"?Fbt(e):Id(e)}
function tm(e){return e.replace(/\/\*\*$/,"")||"/"}
```

新颖性验证：`==="wsl")&&[` 291=1 / 289=0；`function wB(e,r){return{denyOnly` 291=1 / 289=0；`fsReadConfigMemo` 8 vs 7（289 已有记忆化，291 增加了新分支的写入点）。未变：`function vw(e){let r=F2t(e);return kt(`[Sandbox] Expanded allowRead glob pattern "${e}" to ${r.length} paths on Linux`),r}`（291 @207451402 ≡ 289 `XT` @204978782）—— 即真正的 glob 展开函数没变，291 是**在 linux/wsl 上干脆不调它**，改为把原始（去尾 `/**` 后的）模式直接交给 sandbox-runtime，由内核侧做匹配，避免 CLI 侧遍历大目录树。

### OCC 现状

- `src/utils/sandbox/sandbox-adapter.ts:18-22` 从 `@anthropic-ai/sandbox-runtime` 导入 `SandboxManager as BaseSandboxManager, SandboxRuntimeConfigSchema, SandboxViolationStore`。
- 导出的 `SandboxManager` 对象里 `getFsReadConfig: BaseSandboxManager.getFsReadConfig`（**1795 行**）—— **裸委托，没有任何 CLI 侧包装**：`fsReadConfigMemo` = 0 命中；没有 `filesystem.disabled` 早退；没有 `credentials.files` 的 deny 合并；没有 linux/wsl glob 守卫；没有 `wB` 兜底；没有 try/catch 日志 `[sandbox] getFsReadConfig threw; falling back to raw deny lists:`。接口声明在 1746-1771。
- 调用点：`src/tools/BashTool/prompt.ts:255` `const fsReadConfig = SandboxManager.getFsReadConfig()`（272-274 用 `denyOnly` / `allowWithinDeny`）；`src/components/sandbox/SandboxConfigTab.tsx:29`（**同步调用**，35 行渲染 Denied / Allowed-within-denied + `globPatternWarnings`）；`:34` 调 `getLinuxGlobPatternWarnings()`；`src/utils/doctorDiagnostic.ts:541`。
- `getLinuxGlobPatternWarnings()` 1314-1360：非 linux/wsl 返回 `[]`；要求 `settings.sandbox.enabled`；`hasGlobs` 先剥尾部 `/**` 再 `/[*?[\]]/`；扫 `permissions.allow` + `permissions.deny` 中 toolName 为 FileEdit/FileRead 的规则。**这只是告警，不改变 `getFsReadConfig` 的行为**，因此 OCC 在 linux/wsl 上仍会走 `BaseSandboxManager.getFsReadConfig()` 内部的 glob 展开 → 同一个卡死。

### 判定

**STAGED**。OCC 连官方的 CLI 侧包装层都没有（不只是缺 291 的新分支），所以：(a) 卡死 bug 存在；(b) `filesystem.disabled` 早退、`credentials.files` deny 合并、异常兜底这三项 289 既有语义也缺。应一次性把整个 `getFsReadConfig` 包装补齐到 291。

### 移植方案 + 测试计划

**方案**

1. `src/utils/sandbox/sandbox-adapter.ts`：新增模块级助手（官方 `wB` / `tm` / `Id`）：
   - `stripTrailingGlob(p)` = `p.replace(/\/\*\*$/, '') || '/'`（官方 `tm`）。
   - `hasGlobChars(p)` = `p.includes('*') || p.includes('?') || p.includes('[') || p.includes(']')`（官方 `Id`）；`hasSimpleGlobChars(p)` = 只含 `*`/`?`（官方 `Fbt`）；`shouldTreatAsGlob(p)` = windows 用 `hasSimpleGlobChars`，否则 `hasGlobChars`（官方 `ikn`）。
   - `buildRawFsReadConfig(config, extraDenyPaths)` = `{denyOnly: dedupe([...(config?.filesystem.denyRead ?? []), ...extraDenyPaths].map(stripTrailingGlob)), allowWithinDeny: (config?.filesystem.allowRead ?? []).map(stripTrailingGlob)}`（官方 `wB`，`D` 是去重）。
2. 把 1795 行的裸委托换成完整包装，逐分支照抄官方顺序：
   - `filesystem.disabled` → `{denyOnly: denyRead.map(stripTrailingGlob), allowWithinDeny: (allowRead ?? []).map(stripTrailingGlob)}`；
   - 记忆化：模块态 `fsReadConfigMemo: {cfg, result} | undefined`，`cfg === currentConfig`（引用相等）时直接返回；
   - `credentials.files` 里 `mode === 'deny'` 的路径并入 `extraDeny`；
   - **linux/wsl 守卫**：`if ((platform === 'linux' || platform === 'wsl') && [...denyRead, ...allowRead, ...credDeny].some(p => hasGlobChars(stripTrailingGlob(p))))` → 返回 `buildRawFsReadConfig(config, credDeny)`，**不调用** `BaseSandboxManager.getFsReadConfig()`；
   - 否则 `try { BaseSandboxManager.getFsReadConfig() }`，`catch (e) { log('[sandbox] getFsReadConfig threw; falling back to raw deny lists: ' + e); return buildRawFsReadConfig(config, allCredPaths) }`（注意兜底用的是 `s.map(S=>S.path)` 全部凭据文件路径，不只 deny）；
   - 每个返回点都写记忆化。
3. `SandboxConfigTab.tsx:29` 的同步调用：包装后 linux/wsl 大目录场景不再遍历，卡顿自然消失；**不要**改成 async（官方也是同步），只确保包装是纯计算。
4. `getLinuxGlobPatternWarnings()` 保持不变（它对应官方的告警面，与本条修复正交）。

**测试计划**

- 单测 `src/utils/sandbox/__tests__/getFsReadConfig.test.ts`：
  - `filesystem.disabled:true` → 只返回 deny/allow 的 `stripTrailingGlob` 结果，不调 base；
  - linux + `allowRead:['~/**/.env']` → 走守卫分支，`denyOnly` 含凭据 deny 路径，**base `getFsReadConfig` 未被调用**（spy）；
  - darwin + 同样规则 → 调用 base；
  - base 抛异常 → 日志文本精确等于 `[sandbox] getFsReadConfig threw; falling back to raw deny lists: <err>`，返回 `buildRawFsReadConfig(config, 全部凭据路径)`；
  - 记忆化：同一 config 连续两次调用只算一次；config 变化（新引用）后重算；
  - `stripTrailingGlob('/a/**')` → `/a`；`stripTrailingGlob('/**')` → `/`；`hasGlobChars`/`hasSimpleGlobChars`/`shouldTreatAsGlob` 各形态（含 `[`、`]`、`?`、windows 下 `[` 不算）。
- **行为 e2e**（Linux，必须真实）：造一个大目录树（如 20k 文件），项目设置 `sandbox.filesystem.allowRead: ["~/**/.env"]`，计时 `occ` 首个请求前的启动耗时与打开 `/sandbox` → Config tab 的耗时（tmux `capture-pane` + 时间戳），断言在合理阈值内且不遍历该树；对照：把规则改成非 glob 的具体路径，断言仍走 base 且行为正确。同时断言 Config tab 渲染的 Denied / Allowed-within-denied 列表内容正确（去尾 `/**` 后的形态）。

---

## 附：本次排查中确认的死路（勿重复追）

- `hookGuardHere`（291 新）= `tengu_home_seed_hook_guard`，属 consent-mode 云设置 seeding，**不是**本簇。
- `Eut`/`Tzn` 两遍 managed-hook 编排（291 @210576400）与 289 `jat`/`SBn`（@208046450）**字节一致**，不是 item 9 的 delta。
- `structuredClone`、jsbn `BigInteger.clone`、bashEditDiff 的 git 正则、worktree 隔离校验器 `Ysn` 的字符串、291 的 git env 加固 hook 禁用列表（`egr=ut.map(e=>[`hook.${e}.enabled`,"false"])`）—— 均与本簇无关。
