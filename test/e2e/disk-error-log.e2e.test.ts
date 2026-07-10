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

describe('gracefulShutdown: uncaught/unhandled -> logError', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'occ-disklog-uncaught-'))
    process.env.OCC_ERROR_LOG_PATH = join(tmpDir, 'occ-errors.log')
  })

  afterEach(() => {
    delete process.env.OCC_ERROR_LOG_PATH
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('uncaughtException handler writes a kind:"uncaught" disk entry', async () => {
    const { setupGracefulShutdown } = await import(`${REPO_ROOT}/src/utils/gracefulShutdown.js`)
    setupGracefulShutdown()
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    process.emit('uncaughtException', new Error('uncaught boom'))
    await new Promise(r => setTimeout(r, 50))
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.kind === 'uncaught' && e.message.includes('uncaught boom'))).toBeDefined()
  })

  test('unhandledRejection handler writes a kind:"unhandledRejection" disk entry', async () => {
    const { setupGracefulShutdown } = await import(`${REPO_ROOT}/src/utils/gracefulShutdown.js`)
    setupGracefulShutdown()
    const { readErrorLogTail } = await import(`${REPO_ROOT}/src/utils/diskErrorLog.js`)
    process.emit('unhandledRejection', new Error('rejected boom'))
    await new Promise(r => setTimeout(r, 50))
    const disk = await readErrorLogTail(20)
    expect(disk.find(e => e.kind === 'unhandledRejection' && e.message.includes('rejected boom'))).toBeDefined()
  })
})
