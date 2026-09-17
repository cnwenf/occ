# OCC-128 — 版本追齐自验收轮（2026-09-18）

**官方最新**: `2.1.274`（三方复核：npm dist-tags、GitHub releases、live ELF md5 `7137e84f2a7189e6190cf5af3de1dcc4`，230,580,536 bytes，npx 缓存精确解析到 `@anthropic-ai/claude-code-linux-x64@2.1.274`）
**OCC 版本**: `2.1.339`（已对齐 2.1.274，无版本 gap）
**轮次性质**: 严格自验收轮 — 像人类一样使用 OCC REPL，优先验收 OCC-127 移植的功能（displaySanitize 家族、bash 特殊变量守卫、worktree 嵌套 shell 展开守卫），再核心主干。**最高判据：与官方 Claude Code 交互一致性**。

---

## Gap-128a（已修复）: MCP OAuth auth-stub 工具族与官方 2.1.274 不一致

### 发现过程

REPL e2e 自验收 S3a：在 OCC 与官方 2.1.274 中同时配置一个会泄漏凭据的 needs-auth HTTP MCP server（`leaky-auth`，`http://leakuser:${MCP_SECRET_TOKEN}@127.0.0.1:18923/mcp`），对比两侧 REPL 暴露的 auth-stub 工具。官方 transcript ground truth：`/root/.claude/projects/-tmp-repl-e2e/49d98deb-0f95-4ae8-9191-5b614ab6f523.jsonl`。

### 官方 2.1.274 行为（live-binary 取证，逐字节验证）

取证方法纪律：**`strings` 提取会坍缩模板字面量中的真实换行字节**（官方 Bun 二进制内嵌的 JS 模板串含真 `\n`），本轮所有含换行的模板均以 Python bytes-search 直接读取 live ELF 校正（校正后权威 chunk 存于取证工作区 `mcpauth-chunk-corrected.js`）。

官方 `Qx(e,r)`（auth-stub 工厂）：

```js
Qx(e,r){ if(Te()) return []; let n=_R(e,r,{detail:"origin"}); return [D(e,r,n), v(e,r)] }
```

即官方为每个 needs-auth server 注册**两个** stub 工具：

1. `mcp__<server>__authenticate`（`D`）
2. `mcp__<server>__complete_authentication`（`v`）— **OCC 完全缺失**

且 `Te()`（非交互 session 判定）为真时**一个都不注册** — OCC 此前无条件注册（含 `-p` 模式）。

官方配套基础设施（OCC 均缺失或语义偏离）：

- **host-scoped 注册表** `Wt()`：`oauthCallbackSubmitters` / `activeOAuthFlows` 两个 Map + 访问器（FJr/UJr/BJr）。
- **manual callback submitter `F`**（返回 BOOLEAN），check 顺序逐字节验证：
  1. `!code && !error` → `false`（不是回调 URL，flow 不动）
  2. `state !== ie` → log `"Ignoring manual callback URL whose state belongs to a different flow"` → `false`（**274 关键行为变化：state 不匹配的粘贴 URL 不再以 CSRF 错误中止在跑的 flow，而是忽略并让 flow 继续等待**）
  3. `error` → cleanup + reject(`` `OAuth error: ${error} - ${description}` ``) → `true`
  4. `code` → log `"Received auth code via manual callback URL"` + cleanup + resolve → `true`
  5. catch → `false`
- **submitter 无条件注册**：`y.oauthCallbackSubmitters.set(e,F)`，随后 `d?.onWaitingForCallback?.(F,R,ie)`（不再被 options 开关闸住）。
- **`D.call()` gating 链**（顺序即官方顺序）：managed-policy（`Gf`→zQt 消息）→ disabled（`ts`→消息）→ project-approval（WQt 消息）→ ID 分类器：
  - `claudeai-proxy` → 专用消息
  - 非 sse/http → unsupported-transport 消息
  - anthropic-hosted blocklist `c(url)`：默认 `["microsoft365.mcp.claude.com","gmail.mcp.claude.com","gcal.mcp.claude.com"]`（statsig key `tengu_mcp_local_oauth_blocked_hosts`），hostname 归一化 `i(e)` = lowercase + 去尾点；命中 → `a(e,{scope})` 消息（scope∈{local,project,user} 时追加 `` Remove the stale entry with: `${hl("mcp remove",e)}` ``，`hl` 受 `GW=/^\w[\w.@-]*$/` 门控，整条消息 `[...s].length<=1024` 码点上限）
  - 否则 → `performMCPOAuthFlow(e,config,cb,void 0,{skipBrowserOpen:!0})` + `setActiveOAuthPromise`
- **auth_url 消息**：URL 嵌在两个空行之间 + callbackGuidance `b`（remote 变体判定 `I(){return a.isSSH()||a.CLAUDE_CODE_REMOTE||Wn()}`；两个变体都以**两个换行**开头；remote 变体内嵌 `z(s)` 提取的 redirect_uri），指引模型调用 `complete_authentication`。
- **`R()`/`T()` 在 2.1.274 坍缩为常量**（`gke(){return!1}` → `DI()` 死代码）：`"available automatically"` / `"The server's tools should now be available."`
- **`v.call()`**：getOAuthCallbackSubmitter → 无 flow 错误；URL 无 code/error → invalid-URL 错误（submitter 不被调用）；`A().getActiveOAuthPromise(e)` 在调用 submitter **之前**捕获；submitter 返回 false → different-sign-in-attempt 错误（flow 仍在等待）；await 成功 → `` `Authentication complete for ${xr(e)}. ${T(...)}` ``；`AuthenticationCancelledError` → cancelled 错误；其它 → `` `Authentication failed for ${xr(e)}: ${Xi(Cl(e,r,l(h)))}` ``（先 redactMcpErrorDetail 再 sanitizeForDisplay）。
- **后台续跑**：OAuth 完成后清缓存 → `ts(e)||eW(e,r)` 复查（disabled/policy 变化则 log `"OAuth completed but the server is now disabled or policy-blocked; not reconnecting"` 并跳过重连）→ 重连 → log `` `OAuth complete, reconnected with ${n} tool(s)` ``；失败 → `` ao(e,`OAuth flow failed after tool-triggered start: ${lg(Cl(...))}`) ``（lg = sanitizeForDisplay(…,2000)）。

### OCC 修复（本轮全部落地）

| 文件 | 变更 |
|---|---|
| `src/services/mcp/auth.ts` | 新增 `OAuthCallbackSubmitter` 类型、`oauthCallbackSubmitters`/`activeOAuthFlows` 注册表 + `getOAuthCallbackSubmitter`/`setActiveOAuthPromise`/`getActiveOAuthPromise`；新增纯工厂 `createManualCallbackSubmitter(serverName, oauthState, {cleanup, resolveCode, rejectFlow})`（官方 `F` 顺序逐分支移植）；flow 等待回调时**无条件**注册 submitter（identity-checked cleanup 注销）；`onWaitingForCallback` 签名改为 `(submitter, redirectUri, state)` |
| `src/services/mcp/config.ts` | `isMcpServerAllowedByPolicy` 导出（gating 链消费方在 tool 层） |
| `src/tools/McpAuthTool/mcpAuthStubShared.ts`（新） | 两个 stub 工具共享的常量与助手：suffix 常量、`TOOLS_BECOME_AVAILABLE_TEXT`/`TOOLS_NOW_AVAILABLE_SENTENCE`（R()/T() 坍缩常量）、`isRemoteOAuthSession()`（官方 `I()` 的 OCC 等价）、`extractOAuthRedirectUri()`（官方 `z()`） |
| `src/tools/McpAuthTool/McpCompleteAuthTool.ts`（新） | 官方 `v(e,r)` 全量移植：描述模板、`callback_url` zod describe 文本、name/userFacingName/renderToolUseMessage/maxResultSizeChars、call() 六分支（无 flow / 无 code-error / state 不匹配 / 成功 / cancelled / 失败+redact+sanitize） |
| `src/tools/McpAuthTool/McpAuthTool.ts` | 重写：官方 gating 链（managed-policy → disabled → project-approval → claudeai-proxy → unsupported-transport → anthropic-hosted blocklist+scope 消息+1024 码点上限）；OAuth 启动改 `undefined` signal + `setActiveOAuthPromise`；后台续跑加 disabled/policy 复查与官方 log 行；auth_url 消息追加 local/remote callbackGuidance（指向 complete_authentication）；silent/catch 消息对齐；新增 `createMcpAuthStubTools` 工厂（官方 `Qx`：非交互 → `[]`，交互 → 双工具） |
| `src/services/mcp/client.ts` | needs-auth 与错误路径的工具注册改走 `createMcpAuthStubTools`（3 处） |
| `src/cli/handlers/mcp.tsx` / `src/cli/print.ts` | `onWaitingForCallback` 注解同步为 boolean submitter（`mcp login --no-browser` 与 `-p` 的 `mcp_oauth_callback_url` 控制协议路径自有校验，不变） |
| `src/components/mcp/MCPRemoteServerMenu.tsx` | 无需改动 — `((url:string)=>boolean)` 可赋给 `((url:string)=>void)` 槽位（TS void-assignability），运行时兼容 |

### 新增测试（39 pass / 0 fail，4 文件）

- `src/services/mcp/__tests__/manualCallbackSubmitter274.test.ts`（7 tests）：submitter 全分支 — 非回调 URL、不可解析、错误 state 的 code（**flow 继续等待，不再 CSRF 中止**）、错误 state 的 error（state 检查先于 error 分支）、匹配 code、匹配 error（官方消息形状）、无 description 的空尾。
- `src/tools/McpAuthTool/__tests__/mcpCompleteAuthTool274.test.ts`（10 tests）：工具身份、描述逐字节、schema describe 文本、call() 六分支、mapper。
- `src/tools/McpAuthTool/__tests__/mcpAuthStubTools274.test.ts`（12 tests）：工厂双工具/非交互空数组、gating 顺序（managed-policy 压过 disabled 压过 project-approval）、claudeai-proxy/stdio/anthropic-hosted（含 hostname 归一化 + shell-unsafe 名不渲染 remove 命令 + Xi 引号中和后的逐字节消息）、auth_url local/remote 变体逐字节、silent 完成 + 前缀替换 setAppState、后台续跑 disabled 复查、启动失败消息。
- `src/tools/McpAuthTool/__tests__/mcpAuthToolDescription274.test.ts`（既有，OCC-127）：继续通过。

Mock 纪律：全部遵循 OCC-97（`mock.module` spread-real + afterAll 还原，防跨文件泄漏）。

### 已记录的移植分歧（by-design，均已在代码注释标注）

1. **无 `yr()` identity epoch**：官方后台续跑用身份纪元守卫防跨代续跑；OCC 无该子系统。
2. **无 storageV5/`Rne` 缓存清除**：OCC 用既有 `clearMcpAuthCache()` 等价。
3. **无 mcpSessionWiring/adoptServer/orphan clearServerCache**：OCC 保留前缀替换 setAppState swap。
4. **无 `Wn()` workspace-remote 判定**：`isRemoteOAuthSession()` 只覆盖 SSH + `CLAUDE_CODE_REMOTE`（OCC 无 workspace-remote 概念）。
5. **statsig blocklist → 常量默认值**：OCC analytics/statsig 层为 stub，anthropic-hosted blocklist 用官方默认常量。
6. **`iss`（RFC 9207）校验**：官方 submitter 有 iss 变体路径；OCC code-only（与既有 OAuth 实现一致）。
7. **`oauthCallbackListeners` map 缺失**：OCC 无该旁路监听器面。
8. **`mcpInfo.serverType/source/isAuthStub` 缺失**：OCC `Tool.mcpInfo` 类型只带 `{serverName, toolName}`（OCC-127 Part II 已记录）。
9. **`occ mcp remove` vs `claude mcp remove`**：OCC 用户可复制命令统一用 `occ` 二进制名（既有约定）。
10. **env 读取时机**：官方模块加载期快照，OCC call 时读取（测试可控性等价，行为无差异）。

## 自验收其余项

- OCC-127 displaySanitize 家族：S3a REPL 验证通过（leaky-auth 描述中扩展后 secret 不再出现，authored `${MCP_SECRET_TOKEN}` 原样保留）。
- bash 特殊变量守卫、worktree 嵌套 shell 展开守卫：见本轮 e2e 记录（issue 评论）。
- 核心主干（REPL 启动、模型往返、/status、-p 模式）：见本轮 e2e 记录。

## 行为 e2e（官方 vs OCC）

- 官方 2.1.274 REPL：`leaky-auth` server 暴露 `mcp__leaky-auth__authenticate` + `mcp__leaky-auth__complete_authentication` 双 stub（transcript ground truth 见上）。
- 修复后 OCC REPL：双 stub 与官方逐字节一致；OCC `-p` 模式：两个 stub 均不出现（与官方 `Te()` 门一致）。

## Gap-128b：OAuth 成功后 REPL 残留 auth stub（本轮自验收发现，已修复）

### 现象（官方 vs OCC）

官方 2.1.274 REPL：对 needs-auth server 完成 `authenticate` → `complete_authentication` 流程后，**下一轮请求的工具列表只含真实工具**（behavioral e2e 验证：turn-3 模型内省答复 "The only mcp__leaky-auth__ tool defined in my system is mcp__leaky-auth__leaky_hello"）。

OCC（修复前）：双 stub 与真实工具共存，残留在后续每一轮的工具列表里。

### 根因

- `src/main.tsx:3362` `const initialTools = mcpTools` 把**启动期** MCP 工具（含 needs-auth stub）冻结进 REPL 的会话常量 prop。
- `mergeAndFilterTools`（`src/utils/toolPool.ts`）`uniqBy([...initialTools, ...assembled], 'name')` 给 initialTools 去重优先权。
- 因此 OAuth continuation 对 `appState.mcp.tools` 的前缀替换 swap（单元级已验证正确）永远无法移除冻结的启动期 stub。

排除的假设（逐一验证）：needs-auth 15 分钟缓存（`clearMcpAuthCache()` 既置空 memoized promise 又 unlink `mcp-needs-auth-cache.json`）；`updateServer` 路径（同样做前缀替换）；`reconnectMcpServerImpl`（成功后返回真实工具）。

### 修复

新纯函数 `deferInitialMcpToolsToLiveState(initialTools, liveClients)`（`src/utils/toolPool.ts`）：一旦连接管理器把某 server 记入 `appState.mcp.clients`，冻结 initialTools 中该 server 前缀的条目让位给 live state。三个调用点：

1. `src/screens/REPL.tsx` — `effectiveInitialTools` memo → `useMergedTools`（渲染/agent 路径）。
2. `src/screens/REPL.tsx` — `computeTools()`（每请求权威路径，从 `store.getState()` 取新值）。
3. `src/cli/print.ts` — `buildAllTools`（headless 路径）。

幽灵工具安全性：连接管理器经 `flushPendingUpdates` **原子地**同时种入 clients+tools，故 client 条目存在即代表 live store 对该 server 工具集权威 —— 断连/禁用（client 条目保留、tools 清空）不会复活冻结的启动期工具；启动竞态安全（store clients 为空 → 冻结 prop 原样通过）。`useRemoteSession` 等远程会话 `tools:` prop（REPL.tsx:1465/1477/1488）刻意未动（远程会话作用域另议）。

### 测试 + e2e

- 新增 `src/utils/__tests__/toolPoolDeferMcp274.test.ts` 6 tests：空 clients 直通、live server 前缀条目剔除（内置工具+他 server 保留）、多 live clients、前缀匹配 server 作用域（`sr` 不吞 `mcp__srv__authenticate`）、非前缀 isMcp 工具不动。
- 定向套件 256 pass / 0 fail（19 files，mcp+toolPool 全家）。
- 行为 e2e（mock OAuth server + tmux REPL 全流程）：启动双 stub → `authenticate` 返回逐字节一致 auth_url（state `5bG7KgTmvcWq73M9sHOZzsNVKGhJwxwVVQ-U2AHLk-g`，port 57029）→ curl 302 Location 回调 → `complete_authentication` → "Authentication complete for leaky-auth. The server's tools should now be available." → **下一轮定义仅含 `mcp__leaky-auth__leaky_hello`** —— 与官方一致。

## 测试基建发现（本轮记录，非本轮引入）

- **共享进程 `bun test src` 不可作为验收门**：bun 1.3.14 `mock.module()` 进程内永久生效（`mock.restore()` 不撤销），单进程跑全量必然跨文件泄漏（`scripts/ci-test.sh` 头注释已记录该根因，CI 采用逐文件进程隔离）。本轮共享进程全量跑出的 ~47 项失败（E63 config 家族、attribution、telemetry、tips、unknownCommandParity251 SandboxManager TypeError 等）经逐文件复跑全部单独通过，且泄漏复现组合（15 文件子集）不含本轮任何新增/修改文件 —— 属既有基建危害，非本轮回归。另：当时机器上残留 e2e 进程（官方 claude 二进制 + mock server）抢占 CPU，拖慢整轮。
- **main CI 基线本身为红**（run 35178872177，2.1.339 发布 commit，早于本轮改动）：4210 pass / 10 fail / 333 skip，8 个既有失败文件：`authStatusConfigDirectory268`、`fastModeWatchdogRetry271`、`effort-xhigh`、`effortCap267`、`effortGap97`、`unknownCommandParity251`、`test/e2e/version-2.1.108`、`test/e2e/version-hooks-2.1.248`。本轮验收标准 = 不新增失败于此基线之上。
- 本地 `CI=true bash scripts/ci-test.sh` 全量逐文件隔离（485 文件）：**4270 pass / 1 fail / 114 skip**。唯一失败 `test/e2e/feedback-ai.e2e.test.ts` 为 live-model 自选测试（CI 无 ANTHROPIC_API_KEY 恒 skip；main CI run 35178872177 中即 "5 pass, 1 skip"）——本轮手工复跑同一场景（fake gh shim + `-p /feedback`）端到端通过（gh 被调用、title/body 断言全部成立），判定为 glm-5.2 现场波动，非本轮回归。main 基线 8 个失败文件在本树全部通过。
