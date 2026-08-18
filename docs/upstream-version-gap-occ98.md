# OCC-98 — 2026-08-19 版本追齐 2.1.233 → 2.1.234(5 项 landed,21 项 staged)

## 1. 版本状态(三方核实,2026-08-19)

| 来源 | 结果 |
|------|------|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = `2.1.234`(published 2026-08-17T18:19Z) |
| GitHub releases (anthropics/claude-code) | latest release `v2.1.234`(published 2026-08-17T20:20:58Z) |
| 官方 linux-x64 ELF 下载核对 | 2.1.233 = 324,598,064 B;2.1.234 = 328,358,192 B(+3.76 MB) |
| 2.1.234 ELF strings 核验 | `2.1.234` 版本标记 114 处,无真实的 `2.1.235+` 标记 |

**结论:官方前进到 `2.1.234`,本轮为实质追齐轮。** OCC 上一轮(OCC-97,
release `2.1.304`)已追平 2.1.233。changelog `2.1.234` 段共 **26 条**;
triage 后 **5 项可移植(全部 landed)**,**21 项 staged**(无 OCC 表面 /
依赖被裁剪子系统 / 二进制歧义需逐点位反编译 —— 见 §4)。

**方法学**(按 `upstream-tracking` + `aligning-with-official-binary` skill):
changelog 为权威清单,每条用 2.1.233/2.1.234 两个官方 ELF 的 strings 差分
(`strings -n 8 | sort -u | comm -13`)定位新增表面,再对每个落地点位做
**逐字节**提取核实后才实现。minified 符号跨模块冲突(如 `su`/`hx`/`Lwe`
有多个同名定义),一律按上下文选择路径安全/功能对应的那个。strings 差分的
`comm -13` 结果(10,080 行)只作线索 —— minified JS 边界漂移会产生大量
假阳性,不作为证据。

## 2. Landed 项(5 项,全部逐字节核实)

### 2.1 `CLAUDE_CODE_PROJECT_DIR_NAME` 环境变量(changelog 新增 env 项)

官方 2.1.234 新增 `CLAUDE_CODE_PROJECT_DIR_NAME`:在 `CLAUDE_CONFIG_DIR`
同时设置时,用该值作为 `~/.claude/projects/<name>` 的目录名,取代默认的
路径 sanitize 名。逐字节核实链(官方函数 → OCC 实现):

| 官方 | 语义 | OCC |
|------|------|-----|
| `yws(e)` | 校验:`/^[A-Za-z0-9_-]{1,64}$/` 且非 Windows 保留名(`lfy` = con/prn/aux/nul/comN/lptN,大小写不敏感),否则 undefined | `validateProjectDirName` |
| `w8c` = `iu(() => UAo() ? yws(E8c()) : void 0, cfy)` | 仅在 `CLAUDE_CONFIG_DIR` 存在时生效;cache key = `CLAUDE_CONFIG_DIR\x00CLAUDE_CODE_PROJECT_DIR_NAME`(`cfy`) | `getProjectDirNameOverride` + `projectDirNameOverrideCache` |
| `sN(e) = w8c() ?? iV(e)` | 目录名 = override ?? sanitizePath | `getProjectDirName` |
| `K$e(e,t)` | 顶层解析入口,`t.CLAUDE_CONFIG_DIR` 为前置条件 | 同上(override 门控一致) |

落地文件:`src/utils/sessionStoragePortable.ts`(新增校验/override/目录名
三个函数,`getProjectDir` 改走 `getProjectDirName`),
`src/utils/sessionStorage.ts`(memoized `getProjectDir` 同步切换)。

**范围决定**:仓库内其他直接调用 `sanitizePath` 的点位(agentMemory、
projectPurge、bridgePointer、asciicast、memdir/paths)不改 —— 官方只在
规范的 `getProjectDir`(`sN`/`K$e`)链上接入了 override;其余点位在官方
同样走裸 sanitize。worktree 扫描站点(`sessionStorage.ts` ~4158/4416)
故意保留裸 `sanitizePath`(与官方一致)。

### 2.2 `selection:clear` 键位动作(changelog keybindings 项)

官方 2.1.234 动作枚举新增 `selection:clear`(位于 `selection:copy` 与
`selection:extendLeft` 之间;233→234 该枚举从 2 个 selection 动作增至 3
个),Scroll 上下文注册 `p9i(e,t=!0)`:有选区则清除,否则 no-op 返回
false;**无默认键绑定**。逐字节核实后落地:

- `src/keybindings/schema.ts`:`KEYBINDING_ACTIONS` 在 `selection:copy`
  后新增 `selection:clear`。
- `src/components/ScrollKeybindingHandler.tsx`:新增 `useKeybindings`
  块,`'selection:clear'` → `hasSelection()` 为假返回 false,否则
  `clearSelection()`(与 `p9i` 语义逐条一致)。

**说明**:`selection:extend*` 系列动作是 2.1.234 之前版本遗留的 OCC 债务
(不在本轮 changelog 范围),不在本轮处理。

### 2.3 NT-namespace 路径安全修复(changelog 安全项)

changelog:"Fixed a security issue where NT-namespace paths (`\??\...`)
could be read"。Windows 上 `\??\` 与 NT 对象管理器命名空间
(`\GLOBAL??\`/`\GLOBALROOT\`/`\DosDevices\`/`\Device\`)经内核对象管理器
解析,可绕过字符串路径检查直接寻址设备/卷。官方 2.1.234 在文件系统访问
**之前**拒绝这些路径。逐字节核实并移植:

- 新增 `src/utils/ntNamespacePaths.ts`,全部 regex 逐字节来自官方:
  - `Xw` = `/^[\\/]\?\?[\\/]/` → `isNtNamespaceDevicePath`
  - `Rys` = `/^[\\/](GLOBAL\?\?|GLOBALROOT|DosDevices|Device)[\\/]/i` → `isNtObjectNamespacePath`
  - `Lwe(e) = HWc.test(e) || (e.includes('??') && HWc.test(win32.normalize(e)))` → `containsNtNamespacePath`(捕获混合分隔符输入经 win32 normalize 后产生的 `\??\`)
  - `c6t` automount 行走器(`/net/<share>` 前缀检测,`.`/`..` 处理)→ `detectAutomountPath` / `isAutomountPath`
- **workflow scriptPath 门**(`src/tools/WorkflowTool/scriptLoader.ts`,
  官方 `sYt` 逐字节):对原始 scriptPath 检查 UNC 前缀 + NT-namespace,
  对原始与 cwd-resolved 路径都检查 automount;拒绝消息与官方 2.1.234
  逐字节一致:`Network (UNC, NT-namespace, or automount) paths are not
  allowed for workflow scriptPath: ${scriptPath}`(233 的旧文案
  "UNC paths are not allowed…" 已被官方替换)。
- **read_file 门**(`src/tools/FileReadTool/FileReadTool.ts`):UNC 检查
  之后新增 NT-namespace 拒绝,消息逐字节:`read_file: NT-namespace path
  rejected before filesystem access`。

**范围决定(staged 子项)**:官方 2.1.234 还有若干同名守卫出现在
session-restore transcript 路径、shell-cwd-readback、file-publish 与
`validatePath` UNC 块等点位。这些点位在 OCC 要么不存在
(shell-cwd-readback),要么需要逐点位反编译才能无歧义落地;本轮只移植
上述两个消息可逐字节核实的表面,其余记录为 staged(§4)。

### 2.4 GitLab MR badge:`glab` 回退(changelog GitLab 项)

官方 2.1.234 新增 footer badge:当 `gh` PR 路径无结果时,回退轮询
`glab mr view -F json` 拿当前仓库的 open MR。顶层组合 `bpp`(flag
`tengu_harbor_prism` 关闭 → 走 `h3b ?? cpp`,即 OCC 移植路径)逐字节
核实;`cpp` glab poller 完整移植为 `src/utils/glabMrStatus.ts`:

- 门序(与官方一致):非 git 仓库 → null;`glab` 不在 PATH(缓存)→
  null;无 remote host → null;host 归类为 github(`om`/`DLs`/`ACt`,
  含 www 剥离与 `L9e` host 归一化)→ null;该 host 已知未认证 → null。
- `glab mr view -F json`:**timeout 2500ms**(`s3b`),
  `preserveOutputOnError: true`,`useCwd`,并**从子进程 env 中抹掉**
  `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN`(官方安全语义:glab
  必须用自己的登录态)。
- 失败分类:未认证消息(`/^\s*\S+ has not been authenticated with glab\s*$/m`,
  `ipp`,匹配 stdout/stderr)→ 记住该 host 不再轮询;可解析的
  `{error:{...}}` 对象(`app`)→ 静默 null;不可解析/无响应 →
  `gitlab_mr_badge` telemetry(`glab_unresponsive`/`parse_failed`)。
- zod schema(`c3b`):`iid`(1..MAX_SAFE_INTEGER)、`state`、可选
  `draft`/`detailed_merge_status`、`web_url`。
- `web_url` 链接安全(`u3b`):≤2048 字符;严格 MR URL 正则(`opp`,由
  官方 `Ker`/`hya`/`gya` 片段逐字节构造,拒绝 `.`/`..` 路径段);URL 尾
  号必须等于 iid。
- 状态映射(`d3b`):仅 `opened`;draft → `draft`;
  `detailed_merge_status === 'mergeable'` → `approved`,否则 `pending`。
- 组合:`ghPrStatus.ts` `fetchPrStatus()` = gh 路径 → glab 回退
  (`'fetch-failed'` 哨兵在此收敛为 null —— OCC 无 poller-bad-streak
  消费者);`PrStatus` 增加 `kind?: 'pr' | 'mr'`;默认分支门
  (branch === defaultBranch)按官方 `bpp` 提前到两条路径之前。
- 渲染:`PrBadge.tsx` 按官方 `AIl` 渲染 —— `kind === 'mr'` 显示
  `MR !N`,否则 `PR #N`;footer(`PromptInputFooterLeftSide.tsx`)透传
  `kind`。

### 2.5 内容块修复:API 返回畸形块不再崩溃(changelog 崩溃修复项)

changelog:"Fixed a crash when the API returns content blocks with no
text"。官方 2.1.234 的 `zKn`(`normalizeContentFromAPI`)改为 flatMap
并对畸形块做 healing。逐字节核实后移植(`src/utils/messages.ts`):

- `case 'text'`:`typeof text !== 'string'` → 丢弃该块并发
  `tengu_content_block_healed`(`{blockType:'text', action:'dropped',
  missingText:true, request_id, messageID}`)。这就是原崩溃点
  (旧代码直接 `.trim()`)。
- `case 'thinking'`(新增):`thinking`/`signature` 均为字符串 → 原样;
  否则发 `tengu_content_block_healed`(`{blockType:'thinking',
  action:'healed', missingThinking, missingSignature}`)并把缺失字段补为
  `""` 后放行。
- 空白 text 块事件 `tengu_model_whitespace_response` 补齐
  `request_id`/`messageID`(官方 2.1.233 即有,OCC 此前缺失)。
- 第 4 参数 `messageMeta = { requestId, messageId }`;
  `src/services/api/claude.ts` 三个调用点(streaming 单块、fallback ×2)
  传入 `requestId: streamRequestId ?? undefined, messageId: result.id /
  partialMessage.id`。
- tool-input 归一化失败日志补齐 `(requestId=..., messageId=...)`
  上下文(与官方 233/234 消息一致)。

## 3. 测试

- 新增单测(全部通过):
  - `src/utils/__tests__/projectDirNameOverride234.test.ts`(14)
  - `src/utils/__tests__/ntNamespacePaths234.test.ts`(16)
  - `src/utils/__tests__/glabMrStatus234.test.ts`(helper 层 17 + poller 门 1)
  - `src/utils/__tests__/contentBlockHealing234.test.ts`(9,mock telemetry)
  - `src/keybindings/__tests__/selectionClear234.test.ts`(3)
  - `src/tools/WorkflowTool/__tests__/scriptPathValidation234.test.ts`(7)
  - `src/tools/FileReadTool/__tests__/ntNamespaceGate234.test.ts`(3)
- 全量 `bun test` 与 Docker e2e(`bash test/e2e/run.sh`)结果见收尾评论。
- REPL 冒烟:`occ --version`、`echo "say PONG" | occ -p`(真实 API key)。

## 4. Staged 项(21 条,逐条理由)

**无 OCC 表面 / 依赖被裁剪子系统:**

| changelog 项 | staged 理由 |
|------|------|
| email 隐私文本调整 | OCC 用户上下文无 email 段(已裁剪);grep 证实 email 仅存在于 analytics(`firstPartyEventLogger.ts`),无可改表面 |
| usage-limit 自动继续 | OCC 无 usage-limit 机制(裁剪) |
| Remote Control 上传修复 | Remote Control 子系统已裁剪 |
| strictKnownMarketplaces SCP | marketplace 子系统已裁剪 |
| SendMessage 200 字符修复 | `KAIROS` flag 关闭,SendMessage 处于 dormant |
| 纯 UI 修复(queued messages / dialog dismissal / shell-row splitting / hr rendering / modal copy / fullscreen restart / /tui tool rules / trust-prompt warning / IDE diff tab / OAUTH_TOKEN reminder) | 无新增 strings、无可逐字节核实的落点;OCC 渲染层为重建实现,逐条移植需逐点位反编译且收益不可验证 |

**二进制歧义 / 需逐点位反编译(按 `aligning-with-official-binary` STOP):**

| changelog 项 | staged 理由 |
|------|------|
| git remote userinfo 修复 | strings 中命中的 `new URL(r).hostname` 位于 proxy no_proxy 逻辑,非 git-remote 解析;无逐点位反编译无法无歧义落地 |
| auto-mode sandbox network 复查 | 依赖 OCC 不存在的 sandbox 网络运行时耦合 |
| 后台子代理的会话级权限答复 | 依赖被裁剪的 bg-session 权限状态机 |
| markdown Unicode 渲染慢 | 性能修复,无行为表面可对齐 |
| MCP diagnostics secrets 修复 | OCC MCP diagnostics 表面为简化实现,官方点位无法一一对应 |
| NT-namespace 其余点位(session-restore transcript / file-publish / validatePath UNC 块 / shell-cwd-readback) | 见 §2.3 范围决定 |

## 5. 版本指针

- OCC 跟踪基线:`2.1.233` → 本轮后 **`2.1.234`**(可移植子集已全部 landed)。
- OCC 自身版本:`2.1.304` → 发版 **`2.1.305`**。
- 下一轮关注:2.1.234 之后官方若发新版,优先消化本轮 staged 中
  "二进制歧义" 类条目(若新版 strings 给出更多上下文)。
