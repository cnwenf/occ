import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Official 2.1.299 port (#103) — space-in-filename diff view bug.
 *
 * The 296-era code trimmed the WHOLE `git ls-files` stdout before splitting,
 * silently corrupting the first/last filename when it legitimately started
 * or ended with spaces. The official 2.1.299 consumer (linux ELF @221653400)
 * drops the whole-output trim:
 *   `if(u!==0)return null;let p=i.split("\n").filter((T)=>T!==""&&...)`
 * with the per-line non-empty helper `function bxo(rr){return rr.trim()!==""}`
 * (s299 @17042895).
 *
 * OCC ports this as `parseUntrackedFileList` (src/utils/git.ts), shared by
 * `captureUntrackedFiles` (git.ts) and `fetchUntrackedFiles` (gitDiff.ts).
 *
 * Repo mock.module template (readTool281.test.ts): snapshot actuals BEFORE
 * mocking, dynamic-import the modules under test AFTER registration, restore
 * in afterAll — mock.module leaks across files in the same worker.
 */

const actualExecFileNoThrow = {
  ...(await import('../execFileNoThrow.js')),
}

let mockStdout = ''
let mockCode = 0

mock.module('../execFileNoThrow.js', () => ({
  ...actualExecFileNoThrow,
  execFileNoThrow: async () => ({
    stdout: mockStdout,
    stderr: '',
    code: mockCode,
  }),
  execFileNoThrowWithCwd: async () => ({
    stdout: mockStdout,
    stderr: '',
    code: mockCode,
  }),
}))

const { parseUntrackedFileList, captureUntrackedFiles } = await import(
  '../git.js'
)
const { fetchUntrackedFiles } = await import('../gitDiff.js')

afterAll(() => {
  mock.module('../execFileNoThrow.js', () => actualExecFileNoThrow)
})

describe('parseUntrackedFileList (official per-line bxo filter)', () => {
  test('preserves a leading-space filename exactly', () => {
    expect(parseUntrackedFileList(' new file .ts\n')).toEqual([
      ' new file .ts',
    ])
  })

  test('preserves a trailing-space filename on the last line', () => {
    expect(parseUntrackedFileList('a.txt\nb.txt ')).toEqual(['a.txt', 'b.txt '])
  })

  test('preserves interior spaces too (regression: normal output unchanged)', () => {
    expect(parseUntrackedFileList('src/a.ts\nmy dir/my file.ts\n')).toEqual([
      'src/a.ts',
      'my dir/my file.ts',
    ])
  })

  test('empty stdout yields an empty list', () => {
    expect(parseUntrackedFileList('')).toEqual([])
  })

  test('whitespace-only lines are dropped (official bxo: trim()!=="")', () => {
    expect(parseUntrackedFileList('  \n\t\n \n')).toEqual([])
    expect(parseUntrackedFileList('a.ts\n\n  \nb.ts\n')).toEqual([
      'a.ts',
      'b.ts',
    ])
  })
})

describe('fetchUntrackedFiles (gitDiff.ts, official 299 ls-files consumer)', () => {
  test('leading-space filename survives into the stats map key', async () => {
    mockCode = 0
    mockStdout = ' new file .ts\n'
    const result = await fetchUntrackedFiles(100)
    expect(result).not.toBeNull()
    expect(result?.size).toBe(1)
    expect(result?.has(' new file .ts')).toBe(true)
    expect(result?.get(' new file .ts')).toEqual({
      added: 0,
      removed: 0,
      isBinary: false,
      isUntracked: true,
    })
  })

  test('trailing-space last-line filename is preserved exactly', async () => {
    mockCode = 0
    mockStdout = 'a.ts\nb.txt '
    const result = await fetchUntrackedFiles(100)
    expect([...(result?.keys() ?? [])]).toEqual(['a.ts', 'b.txt '])
  })

  test('empty stdout returns null (contract preserved)', async () => {
    mockCode = 0
    mockStdout = ''
    expect(await fetchUntrackedFiles(100)).toBeNull()
  })

  test('whitespace-only stdout returns null (contract preserved)', async () => {
    mockCode = 0
    mockStdout = '   \n \n'
    expect(await fetchUntrackedFiles(100)).toBeNull()
  })

  test('non-zero exit code returns null even with stdout', async () => {
    mockCode = 128
    mockStdout = 'a.ts\n'
    expect(await fetchUntrackedFiles(100)).toBeNull()
    mockCode = 0
  })

  test('maxFiles slice still applies', async () => {
    mockCode = 0
    mockStdout = 'a.ts\nb.ts\nc.ts\n'
    const result = await fetchUntrackedFiles(2)
    expect(result?.size).toBe(2)
    expect([...(result?.keys() ?? [])]).toEqual(['a.ts', 'b.ts'])
  })
})

describe('captureUntrackedFiles (git.ts, identical 296-era pattern fixed)', () => {
  let tempDir: string
  let originalCwd: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'occ-untracked-299-'))
    // Files whose names start/end with a space — the #103 corruption case.
    await writeFile(join(tempDir, ' lead.txt'), 'hello')
    await writeFile(join(tempDir, 'trail.txt '), 'world')
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterAll(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  test('reads files whose names carry leading/trailing spaces', async () => {
    mockCode = 0
    mockStdout = ' lead.txt\ntrail.txt \n'
    const result = await captureUntrackedFiles()
    expect(result).toEqual([
      { path: ' lead.txt', content: 'hello' },
      { path: 'trail.txt ', content: 'world' },
    ])
  })

  test('empty stdout returns [] (contract preserved)', async () => {
    mockCode = 0
    mockStdout = ''
    expect(await captureUntrackedFiles()).toEqual([])
  })

  test('non-zero exit code returns []', async () => {
    mockCode = 1
    mockStdout = ' lead.txt\n'
    expect(await captureUntrackedFiles()).toEqual([])
    mockCode = 0
  })
})
