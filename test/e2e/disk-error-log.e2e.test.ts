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
