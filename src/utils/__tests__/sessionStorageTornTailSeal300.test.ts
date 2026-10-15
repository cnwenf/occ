/**
 * CC 2.1.300 changelog #22 — "Fixed the first transcript entry after resume
 * being lost when a crash cut the transcript's last line short".
 *
 * Official delta (byte-verified from the v299/v300 linux-x64 ELFs):
 * - v299@223633467: `reAppendSessionMetadata(e=!1,n=!1,r=!1)` — 3 params,
 *   no torn-tail handling on adopt.
 * - v300@224821077: `reAppendSessionMetadata(e=!1,n=!1,r=!1,s=!1)` — NEW
 *   4th param; when set: `let h=gdo(this.sessionFile); if(s&&h!==""&&
 *   !h.endsWith("\n"))this.sealTornTailOnNextAppend(this.sessionFile)`
 *   (`gdo` = tail read @224899022, catch → ""). The resume-adopt caller
 *   passes the new flag, so a torn last line gets a sealing "\n" BEFORE the
 *   next blind append glues a fresh entry onto the torn fragment (which
 *   makes the entry unparseable → lost on the next resume/read).
 * - Official seal machinery (v300@224817300 region): `sealTornTailOnNext
 *   Append(e){this.tornTailToSeal=e}` + `sealTornTailSync(e){if(this.
 *   tornTailToSeal!==e)return;if(xa())return;… append "\n" …}`.
 *
 * OCC adaptation (documented deviations):
 * 1. OCC has no `tornTailToSeal` pending-marker machinery, so the seal is
 *    applied EAGERLY at adopt time (triage sketch step 3 explicitly prefers
 *    this: it protects BOTH blind-append paths — the async queue and
 *    appendEntryToFile).
 * 2. The official `if(xa())return` guard inside sealTornTailSync is an
 *    unresolvable minified symbol — not ported.
 *
 * Harness pattern: src/__tests__/transcriptWriteWarnings.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Env MUST be set before sessionStorage is imported (config-home memoization).
process.env.NODE_ENV = 'test'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY

const tmpRoot = mkdtempSync(join(tmpdir(), 'occ-torn-tail-300-'))
process.env.CLAUDE_CONFIG_DIR = tmpRoot

const {
  adoptResumedSessionFile,
  appendEntryForTesting,
  flushSessionStorage,
  getTranscriptPath,
  resetProjectForTesting,
} = await import('../sessionStorage.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_LINE = JSON.stringify({
  type: 'summary',
  summary: 'pre-crash-summary',
  leafUuid: 'aaaa-1111',
  timestamp: '2026-10-16T00:00:00.000Z',
})
// A crash-truncated last line: valid JSON prefix, NO trailing newline.
const TORN_FRAGMENT = '{"type":"user","message":{"role":"user","content":"hel'

const POST_RESUME_ENTRY = {
  type: 'summary' as const,
  summary: 'post-resume-entry',
  leafUuid: 'bbbb-2222',
  timestamp: '2026-10-16T00:00:01.000Z',
}

let transcriptPath = ''

function writeFixture(content: string): void {
  transcriptPath = getTranscriptPath()
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(transcriptPath, content, 'utf8')
}

function parseLines(content: string): unknown[] {
  return content
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as unknown)
}

beforeEach(() => {
  resetProjectForTesting()
})

afterEach(() => {
  resetProjectForTesting()
})

// ---------------------------------------------------------------------------
// CC 2.1.300 #22 — torn-tail seal on resume-adopt
// ---------------------------------------------------------------------------

describe('CC 2.1.300 #22 — resume-adopt seals a torn transcript tail', () => {
  test('the first entry appended after adopting a torn transcript survives as its own line', async () => {
    // Arrange — good line + '\n' + torn fragment (no trailing newline).
    writeFixture(`${GOOD_LINE}\n${TORN_FRAGMENT}`)

    // Act — adopt the resumed file, then append the first post-resume entry.
    adoptResumedSessionFile()
    await appendEntryForTesting(POST_RESUME_ENTRY)
    await flushSessionStorage()

    // Assert — the appended entry is a standalone parseable line (pre-fix it
    // was glued onto the torn fragment and lost), and the torn fragment now
    // stands alone on its own line.
    const content = readFileSync(transcriptPath, 'utf8')
    expect(content.endsWith('\n')).toBe(true)

    const lines = content.split('\n')
    expect(lines[0]).toBe(GOOD_LINE)
    expect(lines[1]).toBe(TORN_FRAGMENT)

    // The torn fragment itself is still unparseable — that is expected; the
    // fix protects the NEW entry, not the torn one. Pre-fix, the entry was
    // glued onto lines[1] and lines[2] did not exist / did not parse.
    expect(lines.length >= 3).toBe(true)
    expect(JSON.parse(lines[2] as string)).toMatchObject({
      summary: 'post-resume-entry',
    })
  })

  test('adopting a transcript that already ends with a newline adds no blank line', async () => {
    // Arrange — well-formed transcript, trailing newline present.
    writeFixture(`${GOOD_LINE}\n`)

    // Act
    adoptResumedSessionFile()
    await appendEntryForTesting(POST_RESUME_ENTRY)
    await flushSessionStorage()

    // Assert — no empty lines anywhere (the seal must NOT fire).
    const content = readFileSync(transcriptPath, 'utf8')
    expect(content.includes('\n\n')).toBe(false)
    expect(content.endsWith('\n')).toBe(true)
    const parsed = parseLines(content) as Array<{ summary?: string }>
    expect(parsed.some(e => e.summary === 'post-resume-entry')).toBe(true)
    expect(parsed.some(e => e.summary === 'pre-crash-summary')).toBe(true)
  })

  test('adopting an EMPTY transcript does not seal (official `h!==""` guard)', async () => {
    // Arrange — empty file: tail read is "" so the seal guard must skip.
    writeFixture('')

    // Act
    adoptResumedSessionFile()
    await appendEntryForTesting(POST_RESUME_ENTRY)
    await flushSessionStorage()

    // Assert — the appended entry is the very first line; no leading blank.
    const content = readFileSync(transcriptPath, 'utf8')
    expect(content.startsWith('\n')).toBe(false)
    const lines = content.split('\n').filter(l => l !== '')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      summary: 'post-resume-entry',
    })
  })
})

// Cleanup the temp config root once at process exit.
process.on('exit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best effort
  }
})
