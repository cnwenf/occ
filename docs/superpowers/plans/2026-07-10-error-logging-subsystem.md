# 完整错误日志子系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 OCC 加 local-first 错误日志：所有错误（含云厂商用户 + 未捕获异常）写内存 + 轮转全局磁盘文件；云厂商 gate 收窄为只拦外发 analytics；`/feedback` 合并内存 + 磁盘 tail。

**Architecture:** 新增 `diskErrorLog.ts`（轮转 JSONL，`~/.claude/occ-errors.log`，总 ≤100MB）。重构 `logError` 把本地捕获（内存+磁盘）移到 gate 之前，gate 只拦外发 sink。`gracefulShutdown.ts` 的 uncaught/unhandled 接入 `logError`。`/feedback` 读磁盘 tail + 内存，去重脱敏后进 prompt。

**Tech Stack:** Bun + TypeScript；`node:fs`（appendFile/statSync/renameSync/rmSync/readFile）；`node:os` homedir；`bun:test`。

## Global Constraints

- 磁盘日志路径 `~/.claude/occ-errors.log`，`OCC_ERROR_LOG_PATH` env 可覆盖（测试用）。
- 格式 JSONL：`{ ts, level:'error', kind, message, stack?, project?, sessionId? }`。
- 轮转：活动文件 >10MB → rename `.log.1`，逐级下移，最多 10 个轮转文件；总量 ≤100MB。
- logger 永不抛——所有 fs 操作 try/catch，失败静默降级。
- 云厂商 gate（`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` + `DISABLE_ERROR_REPORTING` + `isEssentialTrafficOnly()`）只拦外发 sink，不拦本地捕获。
- `logError` 新增可选第二参数 `kind`（默认 `'generic'`），现有 1000+ 调用点不传 → 行为不变。
- Lint（Biome）是 gate；`tsc` 非 CI，loose type 噪声可忽略。
- 测试用 `bun:test`，路径 `test/e2e/*.e2e.test.ts`，常驻运行（不依赖 API key）。

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/diskErrorLog.ts` | 轮转 JSONL 磁盘 logger：append + rotate + readTail + 路径常量 |
| `src/utils/log.ts` | 重构 `logError`：本地捕获移出 gate；增 `kind` 参数 |
| `src/utils/gracefulShutdown.ts` | uncaught/unhandled handlers 调 `logError` |
| `src/commands/feedback/index.ts` | 合并内存 + 磁盘 tail；`MAX_ERRORS` 5→20 |
| `test/e2e/disk-error-log.e2e.test.ts` | 磁盘 logger 单元/功能测试 |
| `test/e2e/feedback-ai.e2e.test.ts` | 扩充：断言磁盘 tail 进 prompt |

---

### Task 1: 轮转 JSONL 磁盘 logger

**Files:**
- Create: `src/utils/diskErrorLog.ts`
- Test: `test/e2e/disk-error-log.e2e.test.ts`

**Interfaces:**
- Produces: `DiskLogEntry` type, `ErrorKind` type, `appendToDiskLog(entry)`, `readErrorLogTail(n)`, `getDiskErrorLogPath()`, `buildDiskLogEntry(errorStr, kind)`。下游 `log.ts`/`feedback/index.ts` 依赖这些。
- Consumes: `getSessionId()` from `../bootstrap/state.js`（state.ts:440）；`process.cwd()` for project；`node:os` homedir。

- [ ] **Step 1: Write the failing test**

Create `test/e2e/disk-error-log.e2e.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { REPO_ROOT } = await import('./helpers')

describe('diskErrorLog: append + readTail', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-disklog-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
    logPath = process.env.OCC_ERROR_LOG_PATH
  })

  afterEach(() => {
    delete process.env.OCC_ERROR_LOG_PATH
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('appendToDiskLog writes a JSONL line that readErrorLogTail returns', async () => {
    const { appendToDiskLog, readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    await appendToDiskLog({
      ts: '2026-07-10T00:00:00.000Z', level: 'error', kind: 'generic',
      message: 'test boom', stack: 'Error: test boom\n  at x.ts:1',
    })
    const tail = await readErrorLogTail(10)
    expect(tail).toHaveLength(1)
    expect(tail[0].message).toBe('test boom')
    expect(tail[0].kind).toBe('generic')
    // Raw file is one JSON line.
    const raw = readFileSync(logPath, 'utf8').trim()
    expect(JSON.parse(raw).message).toBe('test boom')
  })

  test('readErrorLogTail skips malformed lines', async () => {
    const { appendToDiskLog, readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    writeFileSync(logPath, 'not-json-line\n', { flag: 'a' })
    await appendToDiskLog({
      ts: '2026-07-10T00:00:01.000Z', level: 'error', kind: 'api', message: 'good',
    })
    const tail = await readErrorLogTail(10)
    expect(tail.find(e => e.message === 'good')).toBeDefined()
    expect(tail.length).toBe(1)
  })

  test('readErrorLogTail on missing file returns []', async () => {
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    rmSync(logPath, { force: true })
    const tail = await readErrorLogTail(10)
    expect(tail).toEqual([])
  })
})

describe('diskErrorLog: rotation', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-disklog-rot-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
    logPath = process.env.OCC_ERROR_LOG_PATH
  })

  afterEach(() => {
    delete process.env.OCC_ERROR_LOG_PATH
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('file >10MB rotates to .log.1 and resets active', async () => {
    const { appendToDiskLog, readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    const big = 'x'.repeat(10 * 1024 * 1024 + 1)
    await appendToDiskLog({
      ts: '2026-07-10T00:00:00.000Z', level: 'error', kind: 'generic',
      message: big, stack: undefined,
    })
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(statSync(logPath).size).toBeLessThanOrEqual(10 * 1024 * 1024)
    const tail = await readErrorLogTail(10)
    expect(tail.find(e => e.kind === 'generic')).toBeDefined()
  })

  test('total across rotated files stays ≤100MB', async () => {
    const { appendToDiskLog } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    for (let i = 0; i < 12; i++) {
      await appendToDiskLog({
        ts: `2026-07-10T00:00:${String(i).padStart(2, '0')}.000Z`,
        level: 'error', kind: 'generic',
        message: 'y'.repeat(10 * 1024 * 1024),
      })
    }
    let total = 0
    total += existsSync(logPath) ? statSync(logPath).size : 0
    for (let i = 1; i <= 10; i++) {
      const p = `${logPath}.${i}`
      if (existsSync(p)) total += statSync(p).size
    }
    expect(total).toBeLessThanOrEqual(100 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: FAIL — `src/utils/diskErrorLog.ts` does not exist; import throws.

- [ ] **Step 3: Write the implementation**

Create `src/utils/diskErrorLog.ts`:

```ts
import { appendFile, statSync, renameSync, existsSync, rmSync, readFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../bootstrap/state.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB — rotate when active exceeds
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100MB — hard cap across all rotated files
const MAX_ROTATED_FILES = 10 // 10 × 10MB = 100MB

export type ErrorKind =
  | 'uncaught'
  | 'unhandledRejection'
  | 'api'
  | 'mcp'
  | 'tool'
  | 'generic'

export interface DiskLogEntry {
  ts: string
  level: 'error'
  kind: ErrorKind
  message: string
  stack?: string
  project?: string
  sessionId?: string
}

export function getDiskErrorLogPath(): string {
  return process.env.OCC_ERROR_LOG_PATH ?? join(homedir(), '.claude', 'occ-errors.log')
}

/**
 * Append one error entry to the global rotating JSONL log.
 * Never throws — on fs failure it silently degrades (logger must not throw).
 */
export async function appendToDiskLog(entry: DiskLogEntry): Promise<void> {
  const path = getDiskErrorLogPath()
  try {
    const line = JSON.stringify(entry) + '\n'
    await appendFile(path, line, { flag: 'a' })
    await maybeRotate()
  } catch {
    // logger must never throw
  }
}

async function maybeRotate(): Promise<void> {
  const path = getDiskErrorLogPath()
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size <= MAX_FILE_BYTES) return
  try {
    const oldest = `${path}.${MAX_ROTATED_FILES}`
    if (existsSync(oldest)) rmSync(oldest)
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${path}.${i}`
      const dst = `${path}.${i + 1}`
      if (existsSync(src)) renameSync(src, dst)
    }
    renameSync(path, `${path}.1`)
    await enforceTotalCap()
  } catch {
    // rotation failure — don't block logging
  }
}

async function enforceTotalCap(): Promise<void> {
  const path = getDiskErrorLogPath()
  const files: Array<{ p: string; size: number; idx: number }> = []
  try {
    files.push({ p: path, size: statSync(path).size, idx: 0 })
  } catch {
    // active missing — ignore
  }
  for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
    const p = `${path}.${i}`
    try {
      files.push({ p, size: statSync(p).size, idx: i })
    } catch {
      // missing rotated file — ignore
    }
  }
  files.sort((a, b) => b.idx - a.idx)
  let total = files.reduce((s, f) => s + f.size, 0)
  for (const f of files) {
    if (total <= MAX_TOTAL_BYTES) break
    if (f.idx === 0) continue // never delete the active file
    try {
      rmSync(f.p)
      total -= f.size
    } catch {
      // ignore
    }
  }
}

/**
 * Read the last n entries from the global log (newest first across active + .1).
 * Skips malformed lines. Returns [] if no file. Never throws.
 */
export async function readErrorLogTail(n: number): Promise<DiskLogEntry[]> {
  if (n <= 0) return []
  const path = getDiskErrorLogPath()
  const entries: DiskLogEntry[] = []
  for (const p of [path, `${path}.1`]) {
    try {
      const content = await readFile(p, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as DiskLogEntry)
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // missing file — ignore
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return entries.slice(-n).reverse() // newest first
}

/** Build a DiskLogEntry from a raw error string + kind. */
export function buildDiskLogEntry(
  errorStr: string,
  kind: ErrorKind,
): DiskLogEntry {
  const entry: DiskLogEntry = {
    ts: new Date().toISOString(),
    level: 'error',
    kind,
    message: errorStr.split('\n')[0] ?? errorStr,
    stack: errorStr.includes('\n') ? errorStr : undefined,
  }
  try {
    entry.project = process.cwd().split('/').pop() || undefined
  } catch {
    // omit
  }
  try {
    entry.sessionId = getSessionId()
  } catch {
    // omit
  }
  return entry
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: PASS — all 5 tests green (append+read, skip malformed, missing file→[], rotation to .1, total ≤100MB).

- [ ] **Step 5: Lint + commit**

Run: `bun run lint`
Expected: clean on the new files (pre-existing noise elsewhere is fine).

```bash
git add src/utils/diskErrorLog.ts test/e2e/disk-error-log.e2e.test.ts
git commit -m "feat(log): rotating JSONL disk error logger

New src/utils/diskErrorLog.ts: appendToDiskLog + readErrorLogTail +
getDiskErrorLogPath. Writes ~/.claude/occ-errors.log (OCC_ERROR_LOG_PATH
override for tests), rotates at 10MB to .log.N (max 10 files), prunes
to ≤100MB total. Never throws — fs failures silently degrade."
```

---

### Task 2: Refactor `logError` — local capture outside the cloud-provider gate

**Files:**
- Modify: `src/utils/log.ts:158-199` (the `logError` function)
- Test: `test/e2e/disk-error-log.e2e.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `appendToDiskLog`, `buildDiskLogEntry`, `ErrorKind` from `./diskErrorLog.js`.
- Produces: `logError(error: unknown, kind?: ErrorKind)` — new optional 2nd param; existing 1000+ call sites unchanged (default `'generic'`).

- [ ] **Step 1: Write the failing test (append to disk-error-log.e2e.test.ts)**

Append:

```ts
describe('logError: local capture outside the cloud-provider gate', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-disklog-gate-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
    logPath = process.env.OCC_ERROR_LOG_PATH
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  })

  afterEach(() => {
    delete process.env.OCC_ERROR_LOG_PATH
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('Bedrock user: logError still writes in-memory + disk', async () => {
    const { logError, getInMemoryErrors } = await import(`${REPO_ROOT}/src/utils/log.js`)
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    logError(new Error('bedrock boom'))
    await new Promise(r => setTimeout(r, 50))
    const mem = getInMemoryErrors()
    expect(mem.find(e => e.error.includes('bedrock boom'))).toBeDefined()
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.message.includes('bedrock boom'))).toBeDefined()
  })

  test('logError accepts a kind argument reflected in the disk entry', async () => {
    const { logError } = await import(`${REPO_ROOT}/src/utils/log.js`)
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    logError(new Error('api boom'), 'api')
    await new Promise(r => setTimeout(r, 50))
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.kind === 'api')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: FAIL — `logError` still early-returns on `CLAUDE_CODE_USE_BEDROCK=1`, so in-memory + disk are empty; the `kind` arg has no effect.

- [ ] **Step 3: Write the implementation**

Edit `src/utils/log.ts`. Add the import near the top (after existing imports):

```ts
import {
  appendToDiskLog,
  buildDiskLogEntry,
  type ErrorKind,
} from './diskErrorLog.js'
```

Replace the body of `logError` (lines 158-199) with:

```ts
export function logError(error: unknown, kind: ErrorKind = 'generic'): void {
  const err = toError(error)
  if (feature('HARD_FAIL') && isHardFailMode()) {
    // biome-ignore lint/suspicious/noConsole:: intentional crash output
    console.error('[HARD FAIL] logError called with:', err.stack || err.message)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
  try {
    const errorStr = err.stack || err.message
    const errorInfo = {
      error: errorStr,
      timestamp: new Date().toISOString(),
    }

    // ALWAYS capture locally (in-memory + rotating disk log), for ALL
    // users including cloud-provider (Bedrock/Vertex/Foundry). The gate
    // below only blocks EXTERNAL analytics, not local capture — this
    // fixes the gap where cloud-provider users had zero local error
    // visibility.
    addToInMemoryErrorLog(errorInfo)
    void appendToDiskLog(buildDiskLogEntry(errorStr, kind))

    // External analytics / sink send — still gated for cloud providers.
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    // If sink not attached, queue the event
    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    errorLogSink.logError(err)
  } catch {
    // pass
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: PASS — all tests green (Bedrock user now has local capture; `kind` arg flows to disk).

- [ ] **Step 5: Lint + commit**

Run: `bun run lint`

```bash
git add src/utils/log.ts test/e2e/disk-error-log.e2e.test.ts
git commit -m "fix(log): local capture outside cloud-provider gate

logError now writes in-memory + the rotating disk log BEFORE the
cloud-provider gate; the gate only blocks the external analytics
sink. Bedrock/Vertex/Foundry users now get local error capture
(in-memory + ~/.claude/occ-errors.log) instead of nothing. Adds
optional kind arg (default 'generic') so callers can tag API/uncaught/
etc.; existing 1000+ call sites are unchanged."
```

---

### Task 3: Wire uncaughtException / unhandledRejection into `logError`

**Files:**
- Modify: `src/utils/gracefulShutdown.ts:301-333` (the two process-level handlers)
- Test: `test/e2e/disk-error-log.e2e.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `logError` from `./log.js`; `toError` from `./log.js` (exported, normalizes non-Error reasons).
- Produces: uncaught/unhandled handlers now call `logError(err, 'uncaught'|'unhandledRejection')` before the existing analytics calls.

- [ ] **Step 1: Write the failing test (append to disk-error-log.e2e.test.ts)**

Append:

```ts
describe('gracefulShutdown: uncaught/unhandled -> logError', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-disklog-uncaught-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
    logPath = process.env.OCC_ERROR_LOG_PATH
  })

  afterEach(() => {
    delete process.env.OCC_ERROR_LOG_PATH
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('uncaughtException handler writes a kind:"uncaught" disk entry', async () => {
    await import(`${REPO_ROOT}/src/utils/gracefulShutdown.js`)
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    process.emit('uncaughtException', new Error('uncaught boom'))
    await new Promise(r => setTimeout(r, 50))
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.kind === 'uncaught' && e.message.includes('uncaught boom'))).toBeDefined()
  })

  test('unhandledRejection handler writes a kind:"unhandledRejection" disk entry', async () => {
    await import(`${REPO_ROOT}/src/utils/gracefulShutdown.js`)
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    process.emit('unhandledRejection', new Error('rejected boom'))
    await new Promise(r => setTimeout(r, 50))
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.kind === 'unhandledRejection' && e.message.includes('rejected boom'))).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: FAIL — handlers currently don't call `logError`; disk has no tagged entries.

- [ ] **Step 3: Write the implementation**

Read `src/utils/gracefulShutdown.ts:301-333` first to confirm exact handler bodies. Add to the imports at the top:

```ts
import { logError, toError } from './log.js'
```

In the `uncaughtException` handler (around line 301), prepend before the existing `logForDiagnosticsNoPII`/`logEvent` calls:

```ts
logError(error, 'uncaught')
```

In the `unhandledRejection` handler (around line 313), prepend:

```ts
logError(toError(reason), 'unhandledRejection')
```

(`toError` normalizes `reason` which may be a non-Error value.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/disk-error-log.e2e.test.ts`
Expected: PASS — both handlers write the tagged disk entries.

- [ ] **Step 5: Lint + commit**

Run: `bun run lint`

```bash
git add src/utils/gracefulShutdown.ts test/e2e/disk-error-log.e2e.test.ts
git commit -m "feat(log): uncaughtException + unhandledRejection -> logError

Process-level handlers now call logError(err, 'uncaught'|'unhandledRejection')
before the existing analytics calls, so crashes are captured in the
in-memory store + ~/.claude/occ-errors.log. No exit behavior change."
```

---

### Task 4: /feedback reads disk tail + bumps MAX_ERRORS

**Files:**
- Modify: `src/commands/feedback/index.ts` (the `buildPromptText` function + `MAX_ERRORS` constant)
- Test: `test/e2e/feedback-ai.e2e.test.ts` (append a test)

**Interfaces:**
- Consumes: `readErrorLogTail` from `../../utils/diskErrorLog.js`; existing `getInMemoryErrors` from `../../utils/log.js`.
- Produces: `/feedback` prompt embeds merged in-memory + disk-tail errors (deduped by timestamp+error, last 20), redacted.

- [ ] **Step 1: Write the failing test (append to feedback-ai.e2e.test.ts)**

Append as a new describe block (before the live `live(...)` block):

```ts
describe('/feedback: disk error tail merged into prompt', () => {
  test('prompt includes errors from the disk tail', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'occ-fb-disk-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
    try {
      const { logError } = await import(`${REPO_ROOT}/src/utils/log.js`)
      const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
      // Seed an error via logError so it lands in both memory + disk.
      logError(new Error('disk-tail boom at z.ts:99'))
      await new Promise(r => setTimeout(r, 50))
      const diskTail = await readErrorLogTail(20)
      expect(diskTail.find(e => e.message.includes('disk-tail boom'))).toBeDefined()

      const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
      const blocks = await mod.default.getPromptForCommand(
        'feedback about disk-tail boom',
        { messages: [], abortController: new AbortController() } as never,
      )
      const text = (blocks[0] as { type: 'text'; text: string }).text
      expect(text).toContain('disk-tail boom')
    } finally {
      delete process.env.OCC_ERROR_LOG_PATH
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/feedback-ai.e2e.test.ts`
Expected: FAIL — `/feedback` does not yet import/call `readErrorLogTail`; the merged-dedup path does not exist. (Reviewer verifies the implementation calls `readErrorLogTail` by code inspection; the assertion fails until the merge is wired.)

- [ ] **Step 3: Write the implementation**

Edit `src/commands/feedback/index.ts`. Add the import near the top (after the `getInMemoryErrors` import):

```ts
import { readErrorLogTail } from '../../utils/diskErrorLog.js'
```

Change the constant (line ~95):

```ts
const MAX_ERRORS = 20
```

Replace the error-collection block inside `buildPromptText` (the `errLines` computation, ~lines 206-222) with a merged in-memory + disk-tail version:

```ts
  const [git, memErrors, lastApiReq] = await Promise.all([
    collectGitInfo(),
    Promise.resolve(getInMemoryErrors()),
    Promise.resolve(getLastAPIRequest()),
  ])

  // Merge in-memory errors with the disk tail. Disk survives session
  // restarts; in-memory is fast but session-scoped. Dedupe by
  // (timestamp-prefix, error-prefix) so the same error isn't listed twice.
  let diskErrors: { ts: string; error: string }[] = []
  try {
    const diskTail = await readErrorLogTail(40)
    diskErrors = diskTail.map(e => ({
      ts: e.ts,
      error: e.message + (e.stack ? `\n${e.stack}` : ''),
    }))
  } catch {
    // disk read failure — fall back to in-memory only
  }
  const merged: { timestamp: string; error: string }[] = [
    ...memErrors.map(e => ({ timestamp: e.timestamp ?? '', error: e.error ?? '' })),
    ...diskErrors.map(e => ({ timestamp: e.ts, error: e.error })),
  ]
  const seen = new Set<string>()
  const deduped = merged
    .filter(e => {
      const key = `${e.timestamp.slice(0, 23)}|${e.error.slice(0, 200)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))

  const errLines =
    deduped
      .slice(-MAX_ERRORS)
      .map(
        e =>
          `- [${e.timestamp || 'no-time'}] ${truncate(
            redactSensitiveInfo(e.error),
            MAX_ERROR_LEN,
          )}`,
      )
      .join('\n') || '- (no errors captured this session)'
```

(Leave the rest of `buildPromptText` — `apiReqText`, `transcriptText`, `gitLine`, the prompt template — unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/feedback-ai.e2e.test.ts`
Expected: PASS — all prior tests + the new disk-tail test green.

- [ ] **Step 5: Lint + commit**

Run: `bun run lint`

```bash
git add src/commands/feedback/index.ts test/e2e/feedback-ai.e2e.test.ts
git commit -m "feat(feedback): merge disk error tail into prompt; MAX_ERRORS 5->20

/feedback now reads readErrorLogTail(40) alongside getInMemoryErrors(),
merges + dedupes by (timestamp, error-prefix), bumps MAX_ERRORS 5->20.
Disk tail survives session restarts so resumed/relaunched sessions still
surface recent errors in the filed issue. Disk read failures degrade
gracefully to in-memory only."
```

---

## Self-Review

**1. Spec coverage:**
- §3 完整子系统 → Task 1 (disk logger) + Task 2 (cloud gate fix) + Task 3 (uncaught) + Task 4 (/feedback disk tail). ✅
- §3 全局单文件 → Task 1 `getDiskErrorLogPath`. ✅
- §3 JSONL + 轮转 ≤100MB → Task 1 `maybeRotate` + `enforceTotalCap`. ✅
- §3 gate 收窄 → Task 2 本地捕获移出 gate. ✅
- §5.1 kind 枚举 + 路径 + 轮转常量 → Task 1. ✅
- §5.2 `logError` kind 参数 → Task 2. ✅
- §5.3 uncaught/unhandled → Task 3. ✅
- §5.4 /feedback merge + MAX_ERRORS 5→20 → Task 4. ✅
- §7 错误处理（logger 永不抛、readTail 跳坏行、missing→[]）→ Task 1 + Task 4 catch. ✅
- §8 测试 → Task 1-4 各有 TDD 测试. ✅

**2. Placeholder scan:** 无 TBD/TODO；每步有完整代码 + 命令 + 期望. ✅

**3. Type consistency:** `DiskLogEntry`/`ErrorKind` Task 1 定义；Task 2 `logError(error, kind: ErrorKind)` + Task 3 `logError(err, 'uncaught')` + Task 4 `readErrorLogTail(40)` 全部对齐. `buildDiskLogEntry(errorStr, kind)` Task 1 定义、Task 2 调用一致. ✅

**4. Open Question (§10):** `logAPIError` 的 `kind:'api'` 标记非 gate-keeping；Task 2 落地后可单独小改 `logging.ts:305` 加 `'api'` arg，列为后续 follow-up，不阻塞交付. ✅
