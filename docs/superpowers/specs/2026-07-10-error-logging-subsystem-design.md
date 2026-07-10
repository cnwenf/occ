# 完整错误日志子系统 Design Spec

**Date:** 2026-07-10
**Status:** Approved
**Target repo:** `cnwenf/occ`

## 1. Goal

给 OCC 加一个 local-first 错误日志子系统：所有错误（含云厂商 Bedrock/Vertex/Foundry 用户 + 未捕获异常）既写内存又写一个轮转的全局磁盘文件。现有云厂商 gate 收窄为只拦「外发 analytics」，不再拦本地捕获。`/feedback` 同时读内存 + 磁盘 tail。

## 2. Non-Goals

- 不做跨进程错误聚合 / 不接 Sentry 或任何外部错误上报服务。
- 不改 ant-only `ErrorLogSink` 的内部实现（外发 analytics 路径保持原样）。
- 不读 transcript JSONL（全局 `occ-errors.log` 已是磁盘源）。
- 不改 `package.json` 版本号或发布流程。
- 不做日志查看 CLI 子命令（`loadErrorLogs()` 现有读取链路不动）。

## 3. Design Decisions (locked with user)

| Decision | Choice | Rationale |
|---|---|---|
| 范围深度 | 完整日志子系统 | 用户选：含云厂商修复 + 磁盘文件 + uncaught/unhandled 接入 + /feedback 读磁盘 |
| 磁盘日志位置 | 全局单文件 `~/.claude/occ-errors.log` | 跨项目汇总、好找；不复用项目作用域 `errors/` 目录 |
| 日志格式 | JSONL，每行一个 JSON 对象 | 机器可解析 + /feedback 易读 tail + 轮转友好 |
| 轮转策略 | 活动文件超 10MB → rename `.log.1`，逐级下移，删最旧；总 ≤ 100MB | 用户硬要求：轮转 + 总量 ≤100MB |
| 云厂商 gate | 只拦外发 sink（analytics），本地捕获（内存+磁盘）始终执行 | 修复 Bedrock/Vertex/Foundry 用户零本地捕获的缺口 |
| 方案选型 | A：重构 `logError` + 新磁盘 logger | 最小侵入，`logError` 的 1000+ 调用点 API 不变 |

## 4. Architecture

```
错误发生 (api/uncaught/mcp/tool)
  → logError(err)
     ├ addToInMemoryErrorLog (always)            [内存 100 条 FIFO]
     ├ appendToDiskLog (always, 新)               [~/.claude/occ-errors.log, 轮转 ≤100MB]
     └ errorLogSink.logError (gate: 仅外发 analytics，云厂商仍拦)
  uncaughtException/unhandledRejection → logError (新增)
  /feedback → getInMemoryErrors() ∪ readErrorLogTail(20)  [按 ts 去重 + 脱敏]
```

三层捕获：内存（快、会话级、100 条）→ 磁盘（持久、跨会话、轮转 ≤100MB）→ 外发 analytics（ant-only，云厂商拦）。`/feedback` 合并前两层。

## 5. Components

### 5.1 新文件 `src/utils/diskErrorLog.ts`（~130 行）

轮转 JSONL 磁盘 logger。

- **路径**：`~/.claude/occ-errors.log`（全局，跨项目）
- **条目结构**：`{ ts: ISO8601, level: 'error', kind: 'uncaught'|'unhandledRejection'|'api'|'mcp'|'tool'|'generic', message: string, stack?: string, project?: string, sessionId?: string }`
- **写**：`appendFile(path, line + '\n', { flag: 'a' })`，`line = JSON.stringify(entry)`。永不抛——写失败 catch 后降级为只用内存（logger 不能因自身失败抛错）。
- **轮转**：写前/写后检查文件大小。超过 `MAX_FILE_BYTES = 10 * 1024 * 1024`（10MB）→ 现有 `.log.N` 逐级下移（`.log.9` 删除），当前 rename 为 `.log.1`，新建空 `.log`。轮转后总数若仍超 `MAX_TOTAL_BYTES = 100 * 1024 * 1024`（100MB），从最旧 `.log.N` 起删，直到总量 ≤ 100MB。常量：`MAX_ROTATED_FILES = 10`（10MB × 10 = 100MB）。
- **导出**：
  - `appendToDiskLog(entry): Promise<void>` — 追加 + 必要时轮转。
  - `readErrorLogTail(n: number): Promise<DiskLogEntry[]>` — 读活动文件 + `.log.1`（如需补满 n），返回最后 n 条（倒序→正序）。解析失败的行跳过。
  - `getDiskErrorLogPath(): string` — 路径常量，供测试 + /feedback。
- **会话/项目信息**：`project` 取 `getCwd()` 的 basename；`sessionId` 取 `getSessionId()`（来自 `bootstrap/state.ts`）。两者都 try/catch，缺失则省略字段。

### 5.2 `src/utils/log.ts` 重构 `logError`（158-199）

- **gate 之前（新顺序）**：先 `addToInMemoryErrorLog(errorInfo)` + `appendToDiskLog({...errorInfo, kind})`（所有用户、所有 provider，无条件）。
- **gate 之后**：只 `errorLogSink?.logError(err)`（外发 analytics；云厂商 / `DISABLE_ERROR_REPORTING` / `isEssentialTrafficOnly()` 仍 early-return，逻辑不变）。
- **kind 传递**：`logError` 增加可选第二参数 `kind?: DiskLogEntry['kind']`（默认 `'generic'`），写入磁盘条目的 `kind` 字段。现有 1000+ 调用点不传 kind → 默认 generic，行为不变。
- **sink 队列**：sink 未 attach 时仍 queue（190-192），不变。
- **云厂商缺口修复**：`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY=1` 的用户现在本地仍写内存+磁盘；只有外发 analytics 被拦。

### 5.3 `src/utils/gracefulShutdown.ts`（301-333）

- `uncaughtException` handler：在现有 `logForDiagnosticsNoPII` + `logEvent` 之前，新增 `logError(errWithKind, 'uncaught')`。
- `unhandledRejection` handler：同上，新增 `logError(reasonAsError, 'unhandledRejection')`。
- 不改退出行为（现有 handler 不强制 exit，保持原样）。
- `reason` 可能非 Error：用 `toError(reason)`（log.ts 已有）规整。

### 5.4 `src/commands/feedback/index.ts`

- `buildPromptText`：并行 `getInMemoryErrors()` + `readErrorLogTail(20)`，合并后按 `timestamp` 去重（同 timestamp + 同 error 截断取一），取最后 N 条。
- `MAX_ERRORS` 5→20。
- 两源都过 `redactSensitiveInfo`（已是现状，扩展覆盖磁盘条目）。
- 磁盘读取失败：catch → 只用内存（不阻塞 prompt 生成）。

## 6. Data Flow（详细）

```
1. 错误发生
   - API: logging.ts:305 logAPIError() → logError(err)  [kind 由 logAPIError 标 'api'? — 见 Open Questions]
   - uncaught: gracefulShutdown.ts:301 → logError(err, 'uncaught')
   - unhandledRejection: gracefulShutdown.ts:313 → logError(reason, 'unhandledRejection')
   - MCP/工具/通用: 现有 logError(err) 调用点

2. logError(err, kind='generic')
   a. toError(err) → err
   b. errorStr = err.stack || err.message
   c. errorInfo = { error: errorStr, timestamp: new Date().toISOString() }
   d. addToInMemoryErrorLog(errorInfo)              [内存 100 条]
   e. appendToDiskLog({ ...errorInfo, kind, project, sessionId })  [磁盘，轮转]
   f. if (gate) return                              [云厂商只拦这步往下]
   g. if sink null → queue; else errorLogSink.logError(err)

3. /feedback
   a. getInMemoryErrors()  → 内存最后 100 条
   b. readErrorLogTail(20) → 磁盘最后 20 条
   c. merge + dedupe by (timestamp, error[:200])
   d. slice last 20, redact, embed in prompt
```

## 7. Error Handling

| Scenario | Behavior |
|---|---|
| 磁盘写失败（权限/磁盘满） | `appendToDiskLog` catch → 静默降级只用内存；logger 永不抛 |
| 轮转 rename 失败 | catch → 继续用原文件追加（不阻塞日志写入） |
| `readErrorLogTail` 解析失败行 | 跳过坏行，返回可解析的 |
| `readErrorLogTail` 文件不存在 | 返回 `[]`（首次运行） |
| /feedback 磁盘读取失败 | catch → 只用内存源 |
| `getSessionId`/`getCwd` 抛 | 省略该字段，条目仍写 |

## 8. Testing

**单元/功能（`test/e2e/disk-error-log.e2e.test.ts`，新增，常驻）：**
- append 一条 → readErrorLogTail 返回它。
- 写满 >10MB → 触发轮转，`.log.1` 出现，`.log` 重置。
- 模拟总量 >100MB（写 11 × 10MB）→ 最旧被删，总 ≤100MB。
- JSONL 坏行 → readErrorLogTail 跳过。
- `logError(new Error('x'))` 在 `CLAUDE_CODE_USE_BEDROCK=1` 下仍写内存 + 磁盘（gate 只拦 sink）。
- uncaughtException 触发 → 磁盘 tail 含 `kind: 'uncaught'` 条目（模拟）。

**/feedback 扩充（`test/e2e/feedback-ai.e2e.test.ts`，已有文件加断言）：**
- seed `logError(new Error('disk test boom'))` → prompt 含该错误（来自内存，现状已覆盖）。
- 新断言：清空内存后，磁盘仍有该条 → prompt 仍含（证明读了磁盘 tail）。

## 9. Files Touched

| File | Change |
|---|---|
| `src/utils/diskErrorLog.ts` | 新增：轮转 JSONL 磁盘 logger（append + rotate + readTail + 路径常量） |
| `src/utils/log.ts` | 重构 `logError`：本地捕获移出 gate；增可选 `kind` 参数 |
| `src/utils/gracefulShutdown.ts` | uncaught/unhandled handlers 调 `logError` |
| `src/commands/feedback/index.ts` | 合并内存 + 磁盘 tail；`MAX_ERRORS` 5→20 |
| `test/e2e/disk-error-log.e2e.test.ts` | 新增：append/轮转/100MB cap/readTail/云厂商本地捕获/uncaught |
| `test/e2e/feedback-ai.e2e.test.ts` | 加断言：磁盘 tail 进 prompt |

## 10. Open Questions

- **`logAPIError` 的 kind 标记**：`logging.ts:305` 调 `logError(error as Error)`，不传 kind → 默认 `'generic'`。要不要改成 `logError(err, 'api')`？倾向：改（一个参数，让磁盘日志能区分 API 错误）。实现时确认 `logAPIError` 调用点签名兼容。
