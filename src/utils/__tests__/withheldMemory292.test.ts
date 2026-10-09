import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  getCwdState,
  getSessionId,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.292 (C10 carryover, docs/gap-research-293/cluster-c-h-carryover.md):
 * instruction-file freshness — the official session-scoped withheld store
 * (`rfe` @212089000) replacing the root-keyed told-map, the 4-reason table
 * (new `unjudged` arm), the shown-cap 20 + overflow row, and the
 * `withheld_memory` attachment (model renderer returns [] — UI/transcript
 * only). Official string set (10 strings), verbatim:
 *
 *   REASONS.denied:    "a Read deny rule covers it"
 *   REASONS.outside:   "it's read from outside your working directories, where reads are blocked"
 *   REASONS.unjudged:  "a Read deny rule couldn't be checked without a working directory"
 *   REASONS.unsettled: "where it leads couldn't be worked out"
 *   noteWithheld line: `Instruction file not loaded: ${path} (${reason})`
 *   withheldLine lead: `Instruction file not loaded (${reason}):`
 *   PATH_MARK:         "path:"
 *   withheldMore:      `and ${more} more instruction ${plural(more,'file')} not loaded`
 *   KEPT_MOST = 200 (XR), SHOWN_MOST = 20 (Soe)
 */

// Official reason strings (XB / 2.1.292 `rfe`), verbatim.
const REASON_DENIED = 'a Read deny rule covers it'
const REASON_OUTSIDE =
  "it's read from outside your working directories, where reads are blocked"
const REASON_UNJUDGED =
  "a Read deny rule couldn't be checked without a working directory"
const REASON_UNSETTLED = "where it leads couldn't be worked out"

// projectSettings + localSettings drive the fixtures; userSettings excluded so
// ~/.claude memory/rules can't pollute assertions (convention: claudemdReadDeny291).
import type { SettingSource } from '../settings/constants.js'
const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only logForDebugging, and restore after.
const actualDebug = await import('../debug.js')
let debugLogs: string[] = []

mock.module('../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugLogs.push(`${opts?.level ?? 'debug'}:${message}`)
  },
}))

const {
  KEPT_MOST,
  PATH_MARK,
  REASONS,
  SHOWN_MOST,
  noteWithheld,
  owedNoMore,
  owedWithheld,
  oweWithheld,
  resetWithheldToldsForTesting,
  toldBy,
  toldIn,
  withheldLine,
  withheldMore,
  withheldShown,
  withheldToldsOf,
} = await import('../withheldMemory.js')
const { normalizeAttachmentForAPI } = await import('../messages.js')
const {
  createWithheldMemoryAttachmentsForTesting,
  getNestedMemoryAttachmentsForTesting,
} = await import('../attachments.js')
const { resetPersistedReadDenyContextForTesting } = await import(
  '../permissions/readDeny.js'
)
const { resetGetMemoryFilesCache, safelyReadMemoryFileAsyncForTesting } =
  await import('../claudemd.js')
const { getAllowedSettingSources, setAllowedSettingSources } = await import(
  '../../bootstrap/state.js'
)
const { resetSettingsCache } = await import('../settings/settingsCache.js')

afterAll(() => {
  mock.module('../debug.js', () => ({ ...actualDebug }))
})

const SESSION_A = 'test-session-a' as SessionId
const SESSION_B = 'test-session-b' as SessionId

let tmpDir: string
let repoDir: string
let savedSources: SettingSource[]
let savedCwd: string
let savedCwdState: string
let savedAutoMemEnv: string | undefined

beforeAll(() => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedCwdState = getCwdState()
  savedAutoMemEnv = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  setAllowedSettingSources(FIXTURE_SOURCES)
})

afterAll(() => {
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  setCwdState(savedCwdState)
  resetSettingsCache()
  if (savedAutoMemEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  } else {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedAutoMemEnv
  }
})

beforeEach(() => {
  tmpDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'occ-withheld292-')),
  )
  repoDir = join(tmpDir, 'repo')
  mkdirSync(repoDir, { recursive: true })
  setOriginalCwd(repoDir)
  setCwdState(repoDir)
  resetSettingsCache()
  resetGetMemoryFilesCache()
  resetPersistedReadDenyContextForTesting()
  resetWithheldToldsForTesting()
  debugLogs = []
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function notLoadedLines(): string[] {
  return debugLogs.filter(l => l.includes('Instruction file not loaded:'))
}

// ─── store: constants + reason table (official rfe, verbatim) ───────────────

describe('CC 2.1.292 C10 — withheld store constants + REASONS', () => {
  test('REASONS is the official 4-entry table including the new unjudged arm', () => {
    expect(REASONS).toEqual({
      denied: REASON_DENIED,
      outside: REASON_OUTSIDE,
      unjudged: REASON_UNJUDGED,
      unsettled: REASON_UNSETTLED,
    })
  })

  test('caps + path mark: KEPT_MOST 200 (XR), SHOWN_MOST 20 (Soe), PATH_MARK "path:" (vMe)', () => {
    expect(KEPT_MOST).toBe(200)
    expect(SHOWN_MOST).toBe(20)
    expect(PATH_MARK).toBe('path:')
  })
})

// ─── store: noteWithheld (official QB) — once-per-session logging ──────────

describe('CC 2.1.292 C10 — noteWithheld (QB): logged-set dedup, KEPT cap', () => {
  test('logs the official line once per session+path; second note is silent', () => {
    const entry = { path: join(repoDir, 'CLAUDE.md'), why: 'denied' as const }
    noteWithheld(SESSION_A, [entry])
    noteWithheld(SESSION_A, [entry])
    const lines = notLoadedLines()
    expect(lines).toEqual([
      `debug:Instruction file not loaded: ${entry.path} (${REASON_DENIED})`,
    ])
  })

  test('each reason renders its official wording', () => {
    noteWithheld(SESSION_A, [
      { path: '/w/a.md', why: 'denied' },
      { path: '/w/b.md', why: 'outside' },
      { path: '/w/c.md', why: 'unjudged' },
      { path: '/w/d.md', why: 'unsettled' },
    ])
    expect(notLoadedLines()).toEqual([
      `debug:Instruction file not loaded: /w/a.md (${REASON_DENIED})`,
      `debug:Instruction file not loaded: /w/b.md (${REASON_OUTSIDE})`,
      `debug:Instruction file not loaded: /w/c.md (${REASON_UNJUDGED})`,
      `debug:Instruction file not loaded: /w/d.md (${REASON_UNSETTLED})`,
    ])
  })

  test('logged set caps at KEPT_MOST (200): the 201st path is kept silent', () => {
    const entries = Array.from({ length: KEPT_MOST + 5 }, (_, i) => ({
      path: `/w/f${i}.md`,
      why: 'denied' as const,
    }))
    noteWithheld(SESSION_A, entries)
    expect(notLoadedLines()).toHaveLength(KEPT_MOST)
  })

  test('stores are session-keyed: session B re-logs what A already logged', () => {
    const entry = { path: '/w/shared.md', why: 'denied' as const }
    noteWithheld(SESSION_A, [entry])
    noteWithheld(SESSION_B, [entry])
    expect(notLoadedLines()).toHaveLength(2)
  })
})

// ─── store: /cd staleness — session store survives cwd/root change ─────────

describe('CC 2.1.292 C10 — /cd staleness: root-keyed behavior gone', () => {
  test('cwd change does not re-log an already-noted path (store survives /cd)', () => {
    const entry = { path: join(repoDir, 'CLAUDE.md'), why: 'denied' as const }
    noteWithheld(SESSION_A, [entry])
    expect(notLoadedLines()).toHaveLength(1)

    // Simulate /cd to a different project root: a root-keyed told-map would
    // reset here and re-log the same path; the session store must not.
    const otherRoot = join(tmpDir, 'other-root')
    mkdirSync(otherRoot, { recursive: true })
    setOriginalCwd(otherRoot)
    setCwdState(otherRoot)

    noteWithheld(SESSION_A, [entry])
    expect(notLoadedLines()).toHaveLength(1)
  })

  test('owed entries survive a cwd change (owed map is session-scoped)', () => {
    const entry = { path: '/w/owed.md', why: 'unsettled' as const }
    oweWithheld(SESSION_A, [entry])

    const otherRoot = join(tmpDir, 'other-root')
    mkdirSync(otherRoot, { recursive: true })
    setOriginalCwd(otherRoot)
    setCwdState(otherRoot)

    expect(owedWithheld(SESSION_A, [])).toEqual([entry])
  })
})

// ─── store: owed bookkeeping (official kMe/bMe/wMe) ─────────────────────────

describe('CC 2.1.292 C10 — owed bookkeeping', () => {
  test('oweWithheld fills owed + logs; owedNoMore deletes; owedWithheld deletes-and-returns-rest', () => {
    const a = { path: '/w/a.md', why: 'denied' as const }
    const b = { path: '/w/b.md', why: 'unjudged' as const }
    oweWithheld(SESSION_A, [a, b])
    expect(owedWithheld(SESSION_A, [])).toEqual([a, b])
    expect(notLoadedLines()).toHaveLength(2)

    owedNoMore(SESSION_A, ['/w/a.md'])
    expect(owedWithheld(SESSION_A, [])).toEqual([b])

    // wMe: delete the named path, return what remains owed.
    expect(owedWithheld(SESSION_A, ['/w/b.md'])).toEqual([])
    expect(owedWithheld(SESSION_A, [])).toEqual([])
  })

  test('oweWithheld caps owed at KEPT_MOST', () => {
    const entries = Array.from({ length: KEPT_MOST + 5 }, (_, i) => ({
      path: `/w/f${i}.md`,
      why: 'denied' as const,
    }))
    oweWithheld(SESSION_A, entries)
    expect(owedWithheld(SESSION_A, [])).toHaveLength(KEPT_MOST)
  })

  test('each session store carries its own random token', () => {
    const ta = withheldToldsOf(SESSION_A).token
    const tb = withheldToldsOf(SESSION_B).token
    expect(typeof ta).toBe('string')
    expect(ta.length).toBeGreaterThan(0)
    expect(ta).not.toBe(tb)
  })
})

// ─── text helpers (official Zgt/F1t/U1t) ────────────────────────────────────

describe('CC 2.1.292 C10 — withheldShown / withheldLine / withheldMore', () => {
  test('withheldShown: 25 entries → 20 shown + more 5; ≤20 → more 0', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      path: `/w/f${i}.md`,
    }))
    const { shown, more } = withheldShown(entries)
    expect(shown).toHaveLength(SHOWN_MOST)
    expect(more).toBe(5)
    expect(withheldShown(entries.slice(0, 20)).more).toBe(0)
    expect(withheldShown([])).toEqual({ shown: [], more: 0 })
  })

  test('withheldLine: official lead/mark triplet + whitespace collapse', () => {
    expect(withheldLine('denied', '/w/CLAUDE.md')).toEqual({
      lead: `Instruction file not loaded (${REASON_DENIED}):`,
      mark: 'path:',
      path: '/w/CLAUDE.md',
    })
    expect(withheldLine('unjudged', '/w/a  b\n c.md').path).toBe('/w/a b c.md')
  })

  test('withheldMore: plural + singular overflow rows', () => {
    expect(withheldMore({ more: 5 })).toBe(
      'and 5 more instruction files not loaded',
    )
    expect(withheldMore({ more: 1 })).toBe(
      'and 1 more instruction file not loaded',
    )
  })
})

// ─── transcript scan (official TMe/EMe) ─────────────────────────────────────

describe('CC 2.1.292 C10 — toldIn / toldBy', () => {
  test('toldIn collects only paths from withheld_memory attachments stamped with this token', () => {
    const token = withheldToldsOf(SESSION_A).token
    const messages = [
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'attachment',
        attachment: {
          type: 'withheld_memory',
          by: token,
          entries: [{ path: '/w/a.md', why: 'denied', displayPath: 'a.md' }],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'withheld_memory',
          by: 'some-other-token',
          entries: [{ path: '/w/other.md', why: 'denied', displayPath: 'x' }],
        },
      },
      {
        type: 'attachment',
        attachment: { type: 'nested_memory', path: '/w/n.md' },
      },
    ]
    expect(toldIn(messages, token)).toEqual(new Set(['/w/a.md']))
  })

  test('toldBy merges the transcript scan into seen and returns the union', () => {
    const token = withheldToldsOf(SESSION_A).token
    const messages = [
      {
        type: 'attachment',
        attachment: {
          type: 'withheld_memory',
          by: token,
          entries: [{ path: '/w/a.md', why: 'denied', displayPath: 'a.md' }],
        },
      },
    ]
    expect(toldBy(SESSION_A, messages)).toEqual(new Set(['/w/a.md']))
    // seen was seeded — a later scan with no messages still reports the path.
    expect(toldBy(SESSION_A, [])).toEqual(new Set(['/w/a.md']))
    expect(withheldToldsOf(SESSION_A).seen.has('/w/a.md')).toBe(true)
  })
})

// ─── model renderer: withheld_memory is UI/transcript-only ─────────────────

describe('CC 2.1.292 C10 — model renderer returns [] (cer.withheld_memory)', () => {
  test('normalizeAttachmentForAPI renders no model content for withheld_memory', () => {
    const msgs = normalizeAttachmentForAPI({
      type: 'withheld_memory',
      entries: [{ path: '/w/a.md', why: 'denied', displayPath: 'a.md' }],
      by: 'token',
    })
    expect(msgs).toEqual([])
  })
})

// ─── producer (official Kun) ────────────────────────────────────────────────

describe('CC 2.1.292 C10 — createWithheldMemoryAttachments (Kun)', () => {
  test('fresh entries → one attachment with displayPath + session token; re-run → none', () => {
    const path = join(repoDir, 'CLAUDE.md')
    const entries = [{ path, why: 'denied' as const }]
    const first = createWithheldMemoryAttachmentsForTesting(SESSION_A, entries)
    expect(first).toHaveLength(1)
    expect(first[0]?.type).toBe('withheld_memory')
    if (first[0]?.type !== 'withheld_memory') {
      throw new Error(`unexpected type: ${first[0]?.type}`)
    }
    expect(first[0].entries).toEqual([
      { path, why: 'denied', displayPath: relative(repoDir, path) },
    ])
    expect(first[0].by).toBe(withheldToldsOf(SESSION_A).token)

    // Second turn, same entry: already told this session (seen) → no attachment.
    expect(createWithheldMemoryAttachmentsForTesting(SESSION_A, entries)).toEqual(
      [],
    )
  })

  test('empty candidates → no attachment', () => {
    expect(createWithheldMemoryAttachmentsForTesting(SESSION_A, [])).toEqual([])
  })

  test('owed entries are suppressed from the attachment and drained (official Kun)', () => {
    const entry = { path: '/w/owed.md', why: 'denied' as const }
    oweWithheld(SESSION_A, [entry])
    debugLogs = []
    expect(createWithheldMemoryAttachmentsForTesting(SESSION_A, [entry])).toEqual(
      [],
    )
    // wMe drain: the owed map is empty after the producer ran.
    expect(owedWithheld(SESSION_A, [])).toEqual([])
  })
})

// ─── nested pipeline integration (official Vun): no silent skips ───────────

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeToolUseContext(agentId?: string): ToolUseContext {
  return {
    options: { mcpClients: [], tools: [], mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths: new Set(),
    ...(agentId !== undefined ? { agentId } : {}),
    getAppState: () => ({ toolPermissionContext: makePermissionContext() }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

function stageProjectSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.claude'), { recursive: true })
  writeFileSync(
    join(repoDir, '.claude', 'settings.json'),
    JSON.stringify(settings),
    'utf-8',
  )
  resetSettingsCache()
  resetPersistedReadDenyContextForTesting()
}

/** repoDir/src/{index.ts, CLAUDE.md} with the nested CLAUDE.md deny-ruled. */
function stageDeniedNestedClaudeMd(): { nested: string; target: string; denied: string } {
  const nested = join(repoDir, 'src')
  mkdirSync(nested, { recursive: true })
  const target = join(nested, 'index.ts')
  writeFileSync(target, 'export const x = 1\n', 'utf-8')
  const denied = join(nested, 'CLAUDE.md')
  writeFileSync(denied, '# NESTED-DENIED-292\n', 'utf-8')
  stageProjectSettings({ permissions: { deny: [`Read(//${denied})`] } })
  return { nested, target, denied }
}

describe('CC 2.1.292 C10 — nested pipeline (Vun): denied CLAUDE.md is not silently skipped', () => {
  test('main thread: withheld_memory attachment carries the denied nested CLAUDE.md', async () => {
    const { target, denied } = stageDeniedNestedClaudeMd()
    const ctx = makeToolUseContext()

    const attachments = await getNestedMemoryAttachmentsForTesting(
      target,
      ctx,
      { toolPermissionContext: makePermissionContext() },
    )

    const withheld = attachments.filter(a => a.type === 'withheld_memory')
    expect(withheld).toHaveLength(1)
    if (withheld[0]?.type !== 'withheld_memory') {
      throw new Error('expected withheld_memory')
    }
    expect(withheld[0].entries).toEqual([
      { path: denied, why: 'denied', displayPath: relative(repoDir, denied) },
    ])
    expect(withheld[0].by).toBe(withheldToldsOf(getSessionId()).token)
    // The denied content never reaches any attachment (model never sees it).
    expect(JSON.stringify(attachments)).not.toContain('NESTED-DENIED-292')
    // Official QB line was logged for the withheld file.
    expect(
      notLoadedLines().some(l => l.includes(denied) && l.includes(REASON_DENIED)),
    ).toBe(true)
  })

  test('main thread second pass: already-told entry is not re-attached', async () => {
    const { target } = stageDeniedNestedClaudeMd()
    const ctx = makeToolUseContext()
    const appState = { toolPermissionContext: makePermissionContext() }

    const first = await getNestedMemoryAttachmentsForTesting(target, ctx, appState)
    expect(first.some(a => a.type === 'withheld_memory')).toBe(true)

    const second = await getNestedMemoryAttachmentsForTesting(target, ctx, appState)
    expect(second.filter(a => a.type === 'withheld_memory')).toEqual([])
  })

  test('inside an agent (agentId set): owed only, no attachment (official kMe branch)', async () => {
    const { target, denied } = stageDeniedNestedClaudeMd()
    const ctx = makeToolUseContext('agent-test-292')

    const attachments = await getNestedMemoryAttachmentsForTesting(
      target,
      ctx,
      { toolPermissionContext: makePermissionContext() },
    )

    expect(attachments.filter(a => a.type === 'withheld_memory')).toEqual([])
    expect(
      owedWithheld(getSessionId(), []).map(e => e.path),
    ).toContain(denied)
  })

  test('benign nested CLAUDE.md still loads as nested_memory (no false positive)', async () => {
    const nested = join(repoDir, 'src')
    mkdirSync(nested, { recursive: true })
    const target = join(nested, 'index.ts')
    writeFileSync(target, 'export const x = 1\n', 'utf-8')
    writeFileSync(join(nested, 'CLAUDE.md'), '# NESTED-OK-292\n', 'utf-8')

    const attachments = await getNestedMemoryAttachmentsForTesting(
      target,
      makeToolUseContext(),
      { toolPermissionContext: makePermissionContext() },
    )

    const nestedMem = attachments.filter(a => a.type === 'nested_memory')
    expect(nestedMem.map(a => a.type === 'nested_memory' && a.path)).toContain(
      join(nested, 'CLAUDE.md'),
    )
    expect(attachments.filter(a => a.type === 'withheld_memory')).toEqual([])
    expect(notLoadedLines()).toEqual([])
  })
})

// ─── unjudged reason (official kbt second arm) ─────────────────────────────

describe('CC 2.1.292 C10 — unjudged arm (deny rules without a working directory)', () => {
  test('judge: denied wins; deny rules + no working directory → unjudged; else undefined', async () => {
    const { judgeInstructionWithheldForTesting } = await import('../claudemd.js')
    const { getPersistedReadDenyContext } = await import(
      '../permissions/readDeny.js'
    )
    const denied = join(repoDir, 'CLAUDE.md')
    writeFileSync(denied, '# DENIED-292\n', 'utf-8')
    stageProjectSettings({ permissions: { deny: ['Read(CLAUDE.md)'] } })
    const ctx = getPersistedReadDenyContext()

    // Working directory present → the rule is judged: plain denied.
    expect(judgeInstructionWithheldForTesting(denied, ctx, true)).toBe('denied')
    expect(judgeInstructionWithheldForTesting(join(repoDir, 'other.md'), ctx, true)).toBe(
      undefined,
    )
    // No working directory to resolve relative deny rules against → unjudged
    // fail-closed for ANY candidate (the rule set cannot be evaluated).
    expect(judgeInstructionWithheldForTesting(join(repoDir, 'other.md'), ctx, false)).toBe(
      'unjudged',
    )
  })

  test('chokepoint withholds with the unjudged reason when the cwd is unavailable', async () => {
    const candidate = join(repoDir, 'CLAUDE.md')
    writeFileSync(candidate, '# UNJUDGED-292\n', 'utf-8')
    // A deny rule EXISTS (hasReadDenyRules → true) but does not decide this
    // candidate; with no working directory the rule set cannot be resolved
    // against it → fail-closed `unjudged` (official kbt second arm).
    stageProjectSettings({ permissions: { deny: ['Read(unrelated.md)'] } })

    // Warm the memoized persisted-deny context while the cwd is still valid
    // (project settings are located relative to the original cwd).
    const { getPersistedReadDenyContext } = await import(
      '../permissions/readDeny.js'
    )
    getPersistedReadDenyContext()

    // Simulate the no-working-directory state (official: reads can't be
    // judged without one) by blanking the original cwd for this call.
    setOriginalCwd('')
    try {
      const { info } = await safelyReadMemoryFileAsyncForTesting(
        candidate,
        'Project',
      )
      expect(info).toBeNull()
      expect(
        notLoadedLines().some(
          l => l.includes(candidate) && l.includes(REASON_UNJUDGED),
        ),
      ).toBe(true)
    } finally {
      setOriginalCwd(repoDir)
    }
  })
})
