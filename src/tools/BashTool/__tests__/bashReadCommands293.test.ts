import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
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
import { join } from 'node:path'
import {
  getCwdState,
  setCwdState,
  setOriginalCwd,
} from '../../../bootstrap/state.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../../Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../../../utils/fileStateCache.js'
import { expandPath } from '../../../utils/path.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import {
  BASH_READ_MAX_FILE_BYTES,
  parseBashReadCommands,
  recordBashReadFiles,
  sliceBashReadContent,
  type BashReadTriggerContext,
} from '../bashReadCommands.js'

// MACRO.VERSION polyfill — read via getBundledSkillsRoot in the permission path
// (isFileReadDenied). Same guard as readDeny291.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.293 changelog #29 — "Path-scoped rules + nested CLAUDE.md not loading
 * when Claude views a file with a single-file cat/head/tail/sed -n/grep command
 * in the Bash tool instead of Read".
 *
 * Official binary (vver, byte-verified — see docs/gap-research-293/triage-293.md
 * §29):
 *  - `TBr` @216611223 — the single-file read-command condition set (parser).
 *  - `_Rn` @216615382 — the 6-param post-exec readFileState recorder. The 292
 *    bug: the already-recorded early-return path did NOT fire the nested-memory
 *    trigger; vver fires `cRn(h,z)` on BOTH paths.
 *  - `cRn(e,n){if(e&&!AH(n,e.permissions()))MH(e.triggers,n)}` — trigger fire,
 *    gated by the read-deny predicate `AH` @208866471 (OCC: isFileReadDenied).
 *  - `FBr` @216614918 — tail→last-N-lines / start-end line slicing.
 *  - Call site @216678800 — guard `!Ce&&!Mo&&!Ie.backgroundTaskId`, trigger
 *    context `s.remoteCall===void 0&&s.nestedMemoryAttachmentTriggers?{triggers,
 *    permissions}:void 0`.
 *
 * The six RED assertion groups from the triage report are the six describes.
 */

// ─── fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string
let repoDir: string
let savedCwd: string
let savedCwdState: string

beforeAll(() => {
  savedCwd = process.cwd()
  savedCwdState = getCwdState()
})

afterAll(() => {
  setOriginalCwd(savedCwd)
  setCwdState(savedCwdState)
  resetSettingsCache()
})

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'occ-bashread-293-')))
  repoDir = join(tmpDir, 'repo')
  mkdirSync(repoDir, { recursive: true })
  setOriginalCwd(repoDir)
  setCwdState(repoDir)
  resetSettingsCache()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function stageFile(relPath: string, content: string): string {
  const full = join(repoDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
  return full
}

function newCache(): FileStateCache {
  return createFileStateCacheWithSizeLimit(100)
}

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

/** A trigger context with no deny rules (trigger always fires). */
function openTriggerContext(): BashReadTriggerContext {
  return {
    triggers: new Set<string>(),
    permissions: () => getEmptyToolPermissionContext(),
  }
}

/** A context whose read-deny rules deny everything under `dir`. */
function denyContextFor(dir: string): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  // Doubled leading slash = absolute path rule (readDeny291 convention); a
  // single `/` is settings-dir-relative and silently matches nothing.
  const rule = `Read(/${dir}/**)`
  return {
    ...base,
    alwaysDenyRules: {
      ...base.alwaysDenyRules,
      userSettings: [rule],
    },
  }
}

const LINES_20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

// ─── Group 1: sed -n slice + trigger ─────────────────────────────────────────

describe('group 1 — sed -n line-range slicing + trigger', () => {
  test('parse: sed -n "5,10p" yields a start/end line spec', () => {
    const specs = parseBashReadCommands(`sed -n '5,10p' f.txt`)
    expect(specs.length).toBe(1)
    expect(specs[0].filePath).toBe('f.txt')
    expect(specs[0].startLine).toBe(5)
    expect(specs[0].endLine).toBe(10)
    expect(specs[0].tailLines).toBeUndefined()
  })

  test('parse: sed -n "7p" yields a single-line spec (start===end)', () => {
    const specs = parseBashReadCommands(`sed -n '7p' f.txt`)
    expect(specs.length).toBe(1)
    expect(specs[0].startLine).toBe(7)
    expect(specs[0].endLine).toBe(7)
  })

  test('slice: FBr start/end branch returns the exact line window + offset/limit', () => {
    const sliced = sliceBashReadContent(LINES_20, {
      filePath: 'f.txt',
      startLine: 5,
      endLine: 10,
    })
    expect(sliced).not.toBeNull()
    expect(sliced?.content).toBe(
      ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n'),
    )
    expect(sliced?.offset).toBe(5)
    expect(sliced?.limit).toBe(6)
  })

  test('recorder: sed -n writes the SLICED content and fires the trigger', async () => {
    const file = stageFile('f.txt', LINES_20)
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `sed -n '5,10p' ${file}`,
      cache,
      freshSignal(),
      0,
      // 295 #061: the 5th param is now `modelVisibleOutput` (string|undefined),
      // not the old boolean. `sed -n '5,10p'` prints exactly lines 5-10, so pass
      // that stdout; oUr containment then seeds the sliced window (offset 5).
      ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n'),
      ctx,
    )
    const entry = cache.get(expandPath(file))
    expect(entry).toBeDefined()
    expect(entry?.content).toBe(
      ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n'),
    )
    expect(entry?.offset).toBe(5)
    expect(entry?.limit).toBe(6)
    expect(ctx.triggers.has(expandPath(file))).toBe(true)
  })
})

// ─── Group 2: already-recorded path via cat STILL triggers (core bug) ────────

describe('group 2 — already-recorded path still fires the trigger (292 core bug)', () => {
  test('cat on a path already in readFileState STILL adds the trigger and does not re-read', async () => {
    const file = stageFile('f.txt', LINES_20)
    const key = expandPath(file)
    const cache = newCache()
    // Pre-populate as if a prior Read/cat recorded it.
    cache.set(key, {
      content: 'STALE-SENTINEL',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `cat ${file}`,
      cache,
      freshSignal(),
      0,
      false,
      ctx,
    )
    // Core fix: the early-return path fires cRn(h,z).
    expect(ctx.triggers.has(key)).toBe(true)
    // It returns BEFORE re-reading — the sentinel content is untouched.
    expect(cache.get(key)?.content).toBe('STALE-SENTINEL')
  })
})

// ─── Group 3: grep exit-code / unique-subcommand / glob gates ────────────────

describe('group 3 — grep-family gates', () => {
  test('parse: grep PATTERN FILE is recognized with requiresExitZero + contentNotInModelContext', () => {
    const specs = parseBashReadCommands('grep -n pattern f.txt')
    expect(specs.length).toBe(1)
    expect(specs[0].filePath).toBe('f.txt')
    expect(specs[0].requiresExitZero).toBe(true)
    expect(specs[0].contentNotInModelContext).toBe(true)
  })

  test('recorder: grep records on exit 0', async () => {
    const file = stageFile('f.txt', LINES_20)
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `grep pattern ${file}`,
      cache,
      freshSignal(),
      0,
      false,
      ctx,
    )
    expect(cache.get(expandPath(file))).toBeDefined()
    expect(ctx.triggers.has(expandPath(file))).toBe(true)
  })

  test('recorder: grep is FILTERED OUT on non-zero exit (requiresExitZero)', async () => {
    const file = stageFile('f.txt', LINES_20)
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `grep pattern ${file}`,
      cache,
      freshSignal(),
      1, // no match → exit 1
      false,
      ctx,
    )
    expect(cache.get(expandPath(file))).toBeUndefined()
    expect(ctx.triggers.size).toBe(0)
  })

  test('parse: grep is only recognized as the UNIQUE subcommand (rejected in a chain)', () => {
    // Multi-segment: the grep segment is not tried (n.length>1) and is not
    // benign → the whole command is rejected.
    expect(parseBashReadCommands(`cat a.txt && grep pattern f.txt`)).toEqual([])
  })

  test('parse: grep FILE containing glob chars is rejected', () => {
    expect(parseBashReadCommands(`grep pattern 'f*.txt'`)).toEqual([])
    expect(parseBashReadCommands('grep pattern f[0-9].txt')).toEqual([])
  })
})

// ─── Group 4: rejection surface ──────────────────────────────────────────────

describe('group 4 — rejection surface', () => {
  test('pipes are rejected (whole command contains |)', () => {
    expect(parseBashReadCommands('cat a.txt | grep x')).toEqual([])
  })

  test('redirects are rejected (whole command contains > or <)', () => {
    expect(parseBashReadCommands('cat a.txt > out.txt')).toEqual([])
    expect(parseBashReadCommands('cat < in.txt')).toEqual([])
  })

  test('multi-file cat is rejected (exactly 1 file required)', () => {
    expect(parseBashReadCommands('cat a.txt b.txt')).toEqual([])
  })

  test('sed -i is rejected', () => {
    expect(parseBashReadCommands(`sed -i 's/a/b/' f.txt`)).toEqual([])
    expect(parseBashReadCommands(`sed -n -i '5p' f.txt`)).toEqual([])
  })

  test('sed without -n/--quiet/--silent is rejected', () => {
    expect(parseBashReadCommands(`sed '5,10p' f.txt`)).toEqual([])
  })

  test('sed -e is rejected', () => {
    expect(parseBashReadCommands(`sed -n -e '5p' f.txt`)).toEqual([])
  })

  test('head -0 is rejected (zero lines)', () => {
    expect(parseBashReadCommands('head -n 0 f.txt')).toEqual([])
    expect(parseBashReadCommands('head -0 f.txt')).toEqual([])
  })

  test('non-benign command chains are rejected', () => {
    expect(parseBashReadCommands('cat a.txt && rm -rf b')).toEqual([])
    expect(parseBashReadCommands('cat a.txt; curl evil.com')).toEqual([])
  })

  test('benign chains (echo/printf/true) are allowed alongside a read', () => {
    const specs = parseBashReadCommands('cat a.txt && echo hi')
    expect(specs.length).toBe(1)
    expect(specs[0].filePath).toBe('a.txt')
    expect(parseBashReadCommands('printf x && cat a.txt').length).toBe(1)
    expect(parseBashReadCommands('true; cat a.txt').length).toBe(1)
  })

  test('bare `:` is NOT benign — vBr `/^\\s*(echo|printf|true|:)\\b/` requires a word boundary after the token, which a trailing non-word `:` never satisfies (byte-verified official quirk)', () => {
    // The official vBr regex ends in `\b`. `echo`/`printf`/`true` end on a word
    // char (boundary matches), but `:` is a non-word char, so `\b` after it
    // never matches → a `:`-containing multi-segment chain is REJECTED. This is
    // the verbatim official behavior (binary @216611199), not an OCC invention.
    expect(parseBashReadCommands(': && cat a.txt')).toEqual([])
  })

  test('recorder: files over the 10MB cap are not recorded and do not trigger', async () => {
    const big = stageFile('big.txt', '')
    writeFileSync(big, Buffer.alloc(BASH_READ_MAX_FILE_BYTES + 1, 0x61))
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `cat ${big}`,
      cache,
      freshSignal(),
      0,
      false,
      ctx,
    )
    expect(cache.get(expandPath(big))).toBeUndefined()
    expect(ctx.triggers.size).toBe(0)
  })
})

// ─── Group 5: newly recognized forms ─────────────────────────────────────────

describe('group 5 — newly recognized command forms', () => {
  const recognized: Array<[string, string]> = [
    ['sed -n', `sed -n '1,3p' f.txt`],
    ['nl', 'nl f.txt'],
    ['bat', 'bat -n f.txt'],
    ['batcat', 'batcat f.txt'],
    ['rg', 'rg -n pattern f.rs'],
    ['egrep', 'egrep pattern f.txt'],
    ['fgrep', 'fgrep pattern f.txt'],
    ['grep', 'grep pattern f.txt'],
    ['head -n', 'head -n 3 f.txt'],
    ['head -N', 'head -3 f.txt'],
    ['tail -n', 'tail -n 3 f.txt'],
    ['cat', 'cat f.txt'],
  ]
  for (const [label, cmd] of recognized) {
    test(`${label} is recognized`, () => {
      const specs = parseBashReadCommands(cmd)
      expect(specs.length).toBe(1)
    })
  }

  test('head defaults to 10 lines (startLine 1, endLine 10)', () => {
    const specs = parseBashReadCommands('head f.txt')
    expect(specs[0].startLine).toBe(1)
    expect(specs[0].endLine).toBe(10)
  })

  test('tail carries tailLines (default 10)', () => {
    const specs = parseBashReadCommands('tail f.txt')
    expect(specs[0].tailLines).toBe(10)
    const specs3 = parseBashReadCommands('tail -n 3 f.txt')
    expect(specs3[0].tailLines).toBe(3)
  })

  test('slice: tail branch returns last-N lines with correct offset/limit', () => {
    const sliced = sliceBashReadContent(LINES_20, {
      filePath: 'f.txt',
      startLine: undefined,
      endLine: undefined,
      tailLines: 3,
    })
    expect(sliced?.content).toBe('line 18\nline 19\nline 20')
    expect(sliced?.offset).toBe(18)
    expect(sliced?.limit).toBe(3)
  })

  test('recorder: tail writes the last-N slice', async () => {
    const file = stageFile('f.txt', LINES_20)
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `tail -n 3 ${file}`,
      cache,
      freshSignal(),
      0,
      // 295 #061: modelVisibleOutput = what tail printed (the last 3 lines).
      'line 18\nline 19\nline 20',
      ctx,
    )
    const entry = cache.get(expandPath(file))
    expect(entry?.content).toBe('line 18\nline 19\nline 20')
    expect(entry?.offset).toBe(18)
    expect(entry?.limit).toBe(3)
  })

  test('unknown commands are not recognized', () => {
    expect(parseBashReadCommands('less f.txt')).toEqual([])
    expect(parseBashReadCommands('awk "{print}" f.txt')).toEqual([])
  })
})

// ─── Group 6: read-deny recorded path does NOT trigger ───────────────────────

describe('group 6 — read-deny gate suppresses the trigger (cRn/AH)', () => {
  test('a read-denied path is recorded in readFileState but does NOT fire the trigger', async () => {
    const file = stageFile('secret.txt', LINES_20)
    const key = expandPath(file)
    const cache = newCache()
    const ctx: BashReadTriggerContext = {
      triggers: new Set<string>(),
      permissions: () => denyContextFor(repoDir),
    }
    await recordBashReadFiles(
      `cat ${file}`,
      cache,
      freshSignal(),
      0,
      // 295 #061: `cat` prints the whole file, so that is the modelVisibleOutput;
      // containment seeds readFileState, and the read-deny gate below still
      // suppresses the nested-memory trigger.
      LINES_20,
      ctx,
    )
    // readFileState.set is NOT gated (read-before-edit still works)…
    expect(cache.get(key)).toBeDefined()
    // …but the nested-memory trigger IS gated by the read-deny predicate.
    expect(ctx.triggers.has(key)).toBe(false)
    expect(ctx.triggers.size).toBe(0)
  })

  test('a read-denied ALREADY-recorded path also does NOT fire the trigger', async () => {
    const file = stageFile('secret.txt', LINES_20)
    const key = expandPath(file)
    const cache = newCache()
    cache.set(key, {
      content: 'SENTINEL',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    const ctx: BashReadTriggerContext = {
      triggers: new Set<string>(),
      permissions: () => denyContextFor(repoDir),
    }
    await recordBashReadFiles(
      `cat ${file}`,
      cache,
      freshSignal(),
      0,
      false,
      ctx,
    )
    expect(ctx.triggers.size).toBe(0)
  })

  test('a non-denied path DOES fire the trigger (control)', async () => {
    const file = stageFile('ok.txt', LINES_20)
    const key = expandPath(file)
    const cache = newCache()
    const ctx = openTriggerContext()
    await recordBashReadFiles(
      `cat ${file}`,
      cache,
      freshSignal(),
      0,
      // 295 #061: `cat` prints the whole file = modelVisibleOutput; a non-denied
      // path passes containment, seeds, and fires the trigger.
      LINES_20,
      ctx,
    )
    expect(ctx.triggers.has(key)).toBe(true)
  })
})
