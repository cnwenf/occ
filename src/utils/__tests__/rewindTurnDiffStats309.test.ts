/**
 * CC 2.1.309 #23 (official changelog: "/rewind list showed 'No code changes'
 * for turns that changed checkpointed files via shell command, subagent, or
 * /code-review --fix") — new pairwise turn-diff port.
 *
 * Reverse-engineered read-only from the official 2.1.309 linux-x64 binary
 * (/tmp/cc-diff-309/vver/package/claude):
 *   - `async function Cwo(e,n,r,s)` @~250360556 — snapshot-store pairwise
 *     turn diff. Replaces the 2.1.308 `NNt` transcript structuredPatch scan
 *     (@BIN308:274189515, byte-identical logic to the removed OCC
 *     `computeDiffStatsBetweenMessages`), which only saw Edit/Write tool
 *     results and therefore rendered "No code changes" for bash/subagent
 *     mutations of checkpointed files. 0 hits for `pairCounts`/`countUntil`/
 *     "skipping turn diff stats" in BIN308 — the whole machinery is new in
 *     309.
 *   - Constants @~250360470: `wYe=1048576` (capped read maxBytes),
 *     `eYo=500` (diffLines maxEditLength), `Awo=1000` (default row-counting
 *     budget ms, MessageSelector prop `rowCountingMs:Ke=Awo` @275204134),
 *     `tYo=2000` (backup mtime freshness window).
 *   - `q6t(before,after)` @~250362600 — turn-change direction text diff:
 *     identical → undefined (unchanged); empty-side special case;
 *     `iKe(r,s,{maxEditLength:eYo})` (diffLines); multiset-line fallback.
 *   - Error string `FileHistory: skipping turn diff stats for ${path}: ...`
 *     @250361334 (pair build) and @250362378 (stats loop).
 *   - Semantics: per-file result is stats | null (counted, stats unknown) |
 *     undefined (unchanged, not counted); any null zeroes the aggregate
 *     totals but keeps filesChanged (`K?{...}:{filesChanged:w,0,0}`).
 *
 * Regression mandated by docs/gap-research-309/triage-T2.md item 23: a turn
 * whose only change is a shell mutation of a checkpointed file must NOT
 * compute as no-changes. Per item-52 consistency (sed -i simulation removed
 * in 309 — sed edits are plain bash now), the shell mutation here is an
 * append-redirect (`>>`), not sed.
 *
 * Env scaffolding mirrors fileHistory.restore275.test.ts (real temp dirs,
 * deterministic {sha256-prefix}@v{N} backup names under
 * $CLAUDE_CONFIG_DIR/file-history/<sessionId>/).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  type FileHistoryBackup,
  type FileHistorySnapshot,
  type FileHistoryState,
  fileHistoryGetTurnDiffStats,
  TURN_DIFF_ROW_COUNTING_MS,
  type TurnDiffStatsBudget,
} from '../fileHistory.js'

// ---------------------------------------------------------------------------
// Env + state scaffolding
// ---------------------------------------------------------------------------

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedEnableSdk = process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
const savedDisable = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
let tmp = ''

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'occ-fh-turndiff309-'))
  process.env.CLAUDE_CONFIG_DIR = tmp
  // Ensure fileHistoryEnabled() is true in the test process.
  process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  await mkdir(backupDir(), { recursive: true })
})

afterEach(async () => {
  for (const [k, v] of Object.entries({
    CLAUDE_CONFIG_DIR: savedConfigDir,
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: savedEnableSdk,
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: savedDisable,
  })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

function backupDir(): string {
  return join(getClaudeConfigHomeDir(), 'file-history', getSessionId())
}
/** Deterministic backup naming — must match fileHistory.ts getBackupFileName. */
function backupName(filePath: string, version: number): string {
  return (
    createHash('sha256').update(filePath).digest('hex').slice(0, 16) +
    `@v${version}`
  )
}
function backupPath(name: string): string {
  return join(backupDir(), name)
}
/** Writes a backup file with the given content; returns its backup name. */
async function writeBackup(
  filePath: string,
  version: number,
  content: string,
): Promise<string> {
  const name = backupName(filePath, version)
  await writeFile(backupPath(name), content)
  return name
}
function makeSnapshot(
  messageId: string,
  backups: Record<string, FileHistoryBackup>,
): FileHistorySnapshot {
  return {
    messageId: messageId as never,
    trackedFileBackups: backups,
    timestamp: new Date(),
  } as FileHistorySnapshot
}
function makeState(
  snapshots: FileHistorySnapshot[],
  trackedFiles: string[],
): FileHistoryState {
  return {
    snapshots,
    trackedFiles: new Set(trackedFiles),
    snapshotSequence: snapshots.length,
  } as FileHistoryState
}
function makeBudget(
  overrides: Partial<TurnDiffStatsBudget> = {},
): TurnDiffStatsBudget {
  return {
    pairCounts: new Map(),
    countUntil: performance.now() + TURN_DIFF_ROW_COUNTING_MS,
    signal: new AbortController().signal,
    ...overrides,
  }
}
function backupEntry(
  backupFileName: string | null,
  version: number,
): FileHistoryBackup {
  return { backupFileName, version, backupTime: new Date() }
}

// ---------------------------------------------------------------------------
// 1. The changelog regression: shell mutation of a checkpointed file
// ---------------------------------------------------------------------------

describe('CC 2.1.309 #23 fileHistoryGetTurnDiffStats — live-disk turn diff', () => {
  test("a turn whose only change is a shell append to a checkpointed file counts as changed (was 'No code changes' under the 308 transcript scan)", async () => {
    const f = join(tmp, 'tracked.txt')
    const bn1 = await writeBackup(f, 1, 'line1\nline2\n')
    // The "shell command" mutation: `printf 'shell-appended\\n' >> tracked.txt`
    // — no Edit/Write tool result exists in the transcript for this turn, so
    // the old structuredPatch scan saw nothing. (Not sed — item-52 parity.)
    await writeFile(f, 'line1\nline2\nshell-appended\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 1, deletions: 0 })
  })

  test('a subagent-style direct write to a checkpointed file (no tool result) is detected against live disk', async () => {
    const f = join(tmp, 'agent-target.txt')
    const bn1 = await writeBackup(f, 1, 'original\n')
    await writeFile(f, 'original\nsubagent line\nanother\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 2, deletions: 0 })
  })

  test('unchanged tracked file computes as no changes (empty filesChanged, zero totals)', async () => {
    const f = join(tmp, 'same.txt')
    const bn1 = await writeBackup(f, 1, 'identical\ncontent\n')
    await writeFile(f, 'identical\ncontent\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [], insertions: 0, deletions: 0 })
  })

  test('file created after the snapshot (null before-backup) counts all live lines as insertions', async () => {
    const f = join(tmp, 'created.txt')
    // v1 backup entry with backupFileName null = file did not exist (official
    // TYe: null name → {stats:null}, q6t(undefined, text) → insertions only).
    await writeFile(f, 'created\nby shell\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(null, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 2, deletions: 0 })
  })

  test('file deleted after the snapshot counts backup lines as deletions', async () => {
    const f = join(tmp, 'deleted.txt')
    const bn1 = await writeBackup(f, 1, 'gone\nsoon\n')
    // Live file never written — absent (lstat ENOENT → stats null → usable
    // read, q6t(text, undefined) → deletions only). Link-safety tolerates
    // ENOENT (safe to re-create), mirroring official t3t.

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 0, deletions: 2 })
  })
})

// ---------------------------------------------------------------------------
// 2. Pairwise backup-vs-backup diff (toMessageId defined)
// ---------------------------------------------------------------------------

describe('CC 2.1.309 #23 fileHistoryGetTurnDiffStats — pairwise backups', () => {
  test('diffs the from-snapshot backup against the to-snapshot backup and caches the pair', async () => {
    const f = join(tmp, 'pair.txt')
    const bn1 = await writeBackup(f, 1, 'a\nb\n')
    const bn2 = await writeBackup(f, 2, 'a\nB\nc\n')
    // Live content is irrelevant for the pairwise branch — even matching the
    // from-backup, the stats must come from bn1→bn2 (turn-change direction).
    await writeFile(f, 'a\nb\n')

    const state = makeState(
      [
        makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) }),
        makeSnapshot('msg-2', { [f]: backupEntry(bn2, 2) }),
      ],
      [f],
    )
    const budget = makeBudget()
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      'msg-2' as never,
      budget,
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 2, deletions: 1 })
    // pairCounts cache keyed `${before}:${after}` (official Cwo).
    expect(budget.pairCounts.get(`${bn1}:${bn2}`)).toEqual({
      insertions: 2,
      deletions: 1,
    })
  })

  test('identical backup name on both ends skips the file entirely', async () => {
    const f = join(tmp, 'untouched-between.txt')
    const bn1 = await writeBackup(f, 1, 'a\nb\n')
    await writeFile(f, 'live drift must not matter for same-backup pairs\n')

    const state = makeState(
      [
        makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) }),
        // msg-2 records the SAME backup — the turn changed nothing tracked.
        makeSnapshot('msg-2', { [f]: backupEntry(bn1, 1) }),
      ],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      'msg-2' as never,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [], insertions: 0, deletions: 0 })
  })
})

// ---------------------------------------------------------------------------
// 3. Budget machinery (countUntil / pairCounts) and abort
// ---------------------------------------------------------------------------

describe('CC 2.1.309 #23 fileHistoryGetTurnDiffStats — budget and abort', () => {
  test('exhausted budget: pairwise stats unknown → file counted, totals zeroed', async () => {
    const f = join(tmp, 'budget-pair.txt')
    const bn1 = await writeBackup(f, 1, 'a\n')
    const bn2 = await writeBackup(f, 2, 'a\nb\nc\n')

    const state = makeState(
      [
        makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) }),
        makeSnapshot('msg-2', { [f]: backupEntry(bn2, 2) }),
      ],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      'msg-2' as never,
      makeBudget({ countUntil: performance.now() - 1 }),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 0, deletions: 0 })
  })

  test('exhausted budget still serves a pre-cached pairCounts entry', async () => {
    const f = join(tmp, 'budget-cached.txt')
    const bn1 = await writeBackup(f, 1, 'a\n')
    const bn2 = await writeBackup(f, 2, 'a\nb\n')

    const state = makeState(
      [
        makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) }),
        makeSnapshot('msg-2', { [f]: backupEntry(bn2, 2) }),
      ],
      [f],
    )
    const pairCounts = new Map([
      [`${bn1}:${bn2}`, { insertions: 5, deletions: 2 }],
    ])
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      'msg-2' as never,
      makeBudget({ countUntil: performance.now() - 1, pairCounts }),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 5, deletions: 2 })
  })

  test('exhausted budget on the live branch: shell-mutated file counted via stat fallback, totals zeroed', async () => {
    const f = join(tmp, 'budget-live.txt')
    const bn1 = await writeBackup(f, 1, 'base\n')
    // Size differs from the backup → compareStatsAndContent reports changed
    // without any text read (official Cwo: maxBytes -1 → stats-only reads).
    await writeFile(f, 'base\nshell appended a lot of bytes\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget({ countUntil: performance.now() - 1 }),
    )

    expect(stats).toEqual({ filesChanged: [f], insertions: 0, deletions: 0 })
  })

  test('pre-aborted signal returns undefined without scanning', async () => {
    const f = join(tmp, 'aborted.txt')
    const bn1 = await writeBackup(f, 1, 'a\n')
    await writeFile(f, 'a\nb\n')

    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )
    const controller = new AbortController()
    controller.abort()
    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget({ signal: controller.signal }),
    )

    expect(stats).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Gates
// ---------------------------------------------------------------------------

describe('CC 2.1.309 #23 fileHistoryGetTurnDiffStats — gates', () => {
  test('unknown fromMessageId (no snapshot) returns undefined', async () => {
    const f = join(tmp, 'gated.txt')
    const bn1 = await writeBackup(f, 1, 'a\n')
    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )

    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-missing' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toBeUndefined()
  })

  test('file-history disabled returns undefined', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    const f = join(tmp, 'disabled.txt')
    const bn1 = await writeBackup(f, 1, 'a\n')
    await writeFile(f, 'a\nb\n')
    const state = makeState(
      [makeSnapshot('msg-1', { [f]: backupEntry(bn1, 1) })],
      [f],
    )

    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toBeUndefined()
  })

  test('missing backup entry with no first-version fallback skips the file (before undefined)', async () => {
    const f = join(tmp, 'no-entry.txt')
    await writeFile(f, 'live only\n')
    // Snapshot records NO entry for f and no v1 exists anywhere → Bke
    // fallback undefined → pair skipped, not counted.
    const state = makeState([makeSnapshot('msg-1', {})], [f])

    const stats = await fileHistoryGetTurnDiffStats(
      state,
      'msg-1' as never,
      undefined,
      makeBudget(),
    )

    expect(stats).toEqual({ filesChanged: [], insertions: 0, deletions: 0 })
  })
})
