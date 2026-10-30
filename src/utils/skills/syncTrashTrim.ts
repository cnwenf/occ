import type { Dirent } from 'fs'
import { join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getFsImplementation } from '../fsOperations.js'

/**
 * CC 2.1.314 #66 — `~/.claude/skills/.trash` (and officially also
 * `~/.claude/plugins/.trash`) capped at ~1024 entries, whatever
 * `cleanupPeriodDays` says.
 *
 * Ported from official BIN314 (byte-verified via read-only forensics; the
 * binary was never executed). All markers below are ABSENT from BIN312.
 *
 * Constants — BIN314 @253720840:
 *   var FDt=3,jmo=1024,RBe=604800000,Wmo=5,Gmo=100,zmo="tengu_linked_cocoa",
 *       qmo=/^(\d+)-\d+-(?:([0-9a-f]{32})-)?[^-]+$/,Kmo=new W(()=>new Map);
 *
 * Window check `CW` — added.txt @27108592:
 *   function CW(e,r,n=Date.now()){return Number.isFinite(e)&&Math.abs(n-e)<r}
 *
 * Core trim `Ymo` — added.txt @35674200 (entry `L$r` @253721134; the cleanup
 * sweep calls it with no justMoved names → `countsUntagged=!0`, `justMoved`
 * empty). Sweep orchestration `De` — official cleanup module line 100920:
 *   async function De(e){...for(let n of[gYe,aFe]){...let m=await L$r(f);
 *   r=x(r,{..._(),messages:m.removed,errors:m.errors})}return r}
 * placed AFTER and OUTSIDE the cutoff-null guard (wpc-100920 @17420:
 * `...if(O!==null){...}w.push(await De(e)),w.push(await D())`) — i.e. the cap
 * applies regardless of `cleanupPeriodDays`.
 *
 * Documented OCC-scope reductions (official surfaces absent from OCC — none
 * of these were invented, they are verbatim-grounded snippets NOT ported):
 * - `gYe`/`aFe`: official sweeps skills/.trash AND plugins/.trash; OCC
 *   dropped plugins/marketplace (OCC-31) → skills/.trash only (N-A).
 * - `justMoved` (mover-protected entries): OCC has no sync mover → always
 *   empty; the `Number(n.justMoved)-Number(e.justMoved)` sort term
 *   (`xbe`) and the `!Z.justMoved` G-filter term drop out.
 * - `$Dt` in-use probe + forced second pass (`q.slice(0,L)`): depends on the
 *   sync claim-liveness subsystem (`SS`, pid/procStart markers) removed with
 *   the sync engine; `SS` semantics are UNVERIFIED across minified chunks,
 *   so the probe is not ported (nothing is ever deferred as in-use).
 * - `F0` retry wrapper (`for(let r=1;;r++)...if(r===Wmo||...!(h==="ENOTEMPTY"
 *   ||yq(h)))throw s;await J(r*Gmo)`): `yq` unresolved; OCC has no concurrent
 *   mover racing removals → not ported.
 * - `Rz` storageV5 root verification ("cleanup_sweep_root_refused"): no
 *   storageV5 in OCC; a missing root is handled as a no-op instead.
 * - `phe` Windows-junction reparse check: not ported (dirent flags + lstat
 *   fallback covers the `phe` contract on OCC's targets).
 * - Failure reporting: official `V("warn","sync_trash_trim_failed",
 *   {code:s.failure})` + `f(...)` are leveled-logger/metric channels; OCC's
 *   analytics metadata type cannot carry string codes, so failures go to
 *   logForDebugging (event names byte-verified, channel approximated).
 */

/** Official `yYt=".trash"` — shared by the trash trim and the watcher skip. */
export const TRASH_DIR_NAME = '.trash'

/** Official `FDt=3` — generations kept per tag group. */
const KEEP_GENERATIONS_PER_NAME = 3

/** Official `jmo=1024` — global per-root entry cap. */
const GLOBAL_TRASH_CAP = 1024

/** Official `RBe=604800000` — 7-day protection window in ms. */
const PROTECTION_WINDOW_MS = 604_800_000

/** Official `zmo="tengu_linked_cocoa"` — gate, default true (`v(zmo,!0)`). */
const TRASH_TRIM_GATE = 'tengu_linked_cocoa'

/**
 * Official `qmo=/^(\d+)-\d+-(?:([0-9a-f]{32})-)?[^-]+$/` — batch dir name
 * `<movedAtMs>-<pid>[-<hash32>]-<name>`.
 */
const BATCH_DIR_NAME_PATTERN = /^(\d+)-\d+-(?:([0-9a-f]{32})-)?[^-]+$/

export type TrashTrimResult = {
  removed: number
  errors: number
  /** Official `s.failure` — error code of the first recorded failure. */
  failure?: string
}

type TrashCandidate = {
  dirent: Dirent
  movedAtMs: number
}

/**
 * Official `rQt` — BIN314 added.txt @24248824:
 *   function rQt(t){return!t.isDirectory()&&!t.isFile()&&!t.isSymbolicLink()
 *   &&!t.isFIFO()&&!t.isSocket()&&!t.isBlockDevice()&&!t.isCharacterDevice()}
 * (dirent whose type flags are all unset — some platforms don't populate
 * them, so the official falls back to lstat via `phe`).
 */
function isUnknownDirentType(dirent: Dirent): boolean {
  return (
    !dirent.isDirectory() &&
    !dirent.isFile() &&
    !dirent.isSymbolicLink() &&
    !dirent.isFIFO() &&
    !dirent.isSocket() &&
    !dirent.isBlockDevice() &&
    !dirent.isCharacterDevice()
  )
}

/**
 * Official `phe(t,o)` isDirectory contract — dirent flags when known, lstat
 * fallback for unknown-type dirents (Windows-junction branch not ported).
 */
async function entryIsDirectory(
  root: string,
  dirent: Dirent,
): Promise<boolean> {
  if (!isUnknownDirentType(dirent)) {
    return dirent.isDirectory()
  }
  const stats = await getFsImplementation().lstat(join(root, dirent.name))
  return stats.isDirectory()
}

/** Official `CW(e,r,n=Date.now())` — added.txt @27108592. */
function isWithinProtectionWindow(movedAtMs: number, now: number): boolean {
  return (
    Number.isFinite(movedAtMs) &&
    Math.abs(now - movedAtMs) < PROTECTION_WINDOW_MS
  )
}

/**
 * Official `xbe(e,n)` — `Number(n.justMoved)-Number(e.justMoved)||
 * n.movedAtMs-e.movedAtMs`. justMoved is always false in OCC (no sync
 * mover), leaving newest-first by movedAtMs.
 */
function compareTrashCandidates(a: TrashCandidate, b: TrashCandidate): number {
  return b.movedAtMs - a.movedAtMs
}

/** Official `vfe(e,n)` — `e.errors++,e.failure=k(n)??"unknown"`. */
function recordTrimError(result: TrashTrimResult, error: unknown): void {
  result.errors++
  if (result.failure === undefined) {
    const code = (error as { code?: unknown })?.code
    result.failure = typeof code === 'string' ? code : 'unknown'
  }
}

function getErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Trim one `.trash` root — official `Ymo(e,{justMoved:n,countsUntagged:r})`
 * with `n` empty and `r=true` (the cleanup-sweep call shape via `De`→`L$r(f)`).
 */
export async function trimSyncTrashRoot(
  trashRoot: string,
  now: number = Date.now(),
): Promise<TrashTrimResult> {
  const result: TrashTrimResult = { removed: 0, errors: 0 }
  // Official: `if(!v(zmo,!0))return s` — gate defaults to true.
  if (!getFeatureValue_CACHED_MAY_BE_STALE(TRASH_TRIM_GATE, true)) {
    return result
  }
  const fsImpl = getFsImplementation()
  /** Official `y` — every qmo-matching directory entry, removed or not. */
  let total = 0
  try {
    let dirents: Dirent[]
    try {
      dirents = await fsImpl.readdir(trashRoot)
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return result
      }
      throw error
    }
    const groups = new Map<string, TrashCandidate[]>()
    for (const dirent of dirents) {
      // Official: `let ke=Z.isDirectory()||rQt(Z)?qmo.exec(Z.name):null;
      //              if(ke===null)continue;y++`
      if (!dirent.isDirectory() && !isUnknownDirentType(dirent)) continue
      const match = BATCH_DIR_NAME_PATTERN.exec(dirent.name)
      if (match === null) continue
      total++
      // Official groups by hash tag, or by full entry name when
      // countsUntagged (`let we=Se??Z.name` with `r=true`).
      const key = match[2] ?? dirent.name
      const group = groups.get(key) ?? []
      groups.set(key, group)
      group.push({ dirent, movedAtMs: Number(match[1] ?? 0) })
    }
    /** Official `S` — entries exempt from cap eviction. */
    const keepList: TrashCandidate[] = []
    /** Official `w` — entries evictable oldest-first once over the cap. */
    const evictableList: TrashCandidate[] = []
    for (const group of groups.values()) {
      /** Official `ke` — deferred candidates within the group. */
      const deferred: TrashCandidate[] = []
      /** Official `Se` — kept-generation counter. */
      let kept = 0
      for (const candidate of group.toSorted(compareTrashCandidates)) {
        const candidatePath = join(trashRoot, candidate.dirent.name)
        try {
          if (kept >= KEEP_GENERATIONS_PER_NAME) {
            // Official: `if(CW(Te.movedAtMs,RBe)||await F0(s,()=>$Dt(...)))
            //   ke.push(Te);else await F0(s,()=>za(Ee)),s.removed++`
            // ($Dt in-use probe not ported — see module header.)
            if (isWithinProtectionWindow(candidate.movedAtMs, now)) {
              deferred.push(candidate)
            } else {
              await fsImpl.rm(candidatePath, { recursive: true, force: true })
              result.removed++
            }
            continue
          }
          if (group.length > KEEP_GENERATIONS_PER_NAME) {
            // Official keep-candidate validation: `if(!(await phe(...))
            //   .isDirectory)continue;if((await PBe(Ee)).length===0)continue`
            if (!(await entryIsDirectory(trashRoot, candidate.dirent))) {
              continue
            }
            const children = await fsImpl.readdir(candidatePath)
            if (children.length === 0) continue
          }
          kept++
          if (kept === 1) keepList.push(candidate)
          else deferred.push(candidate)
        } catch (error) {
          recordTrimError(result, error)
        }
      }
      // Official: `let we=ke.findLast((Te)=>CW(Te.movedAtMs,RBe))` — ke is in
      // newest-first order, so findLast protects the OLDEST in-window entry.
      const protectedCandidate = deferred.findLast(c =>
        isWithinProtectionWindow(c.movedAtMs, now),
      )
      for (const candidate of deferred) {
        if (candidate === protectedCandidate) keepList.push(candidate)
        else evictableList.push(candidate)
      }
    }
    // Official: `let L=Math.max(0,S.length+w.length-jmo)`
    let overCap = Math.max(
      0,
      keepList.length + evictableList.length - GLOBAL_TRASH_CAP,
    )
    // Official `G=S.filter((Z)=>!Z.justMoved&&!CW(Z.movedAtMs,RBe))` — the
    // justMoved term drops out (always false in OCC).
    const lastResort = keepList.filter(
      c => !isWithinProtectionWindow(c.movedAtMs, now),
    )
    // Official: `for(let Z of[...w.toSorted(xBe).toReversed(),
    //   ...G.toSorted(xBe).toReversed()])` — oldest-first.
    const oldestFirst = [
      ...evictableList.toSorted(compareTrashCandidates).toReversed(),
      ...lastResort.toSorted(compareTrashCandidates).toReversed(),
    ]
    for (const candidate of oldestFirst) {
      if (overCap === 0) break
      try {
        // Official defers in-use entries to a second pass here ($Dt/q — not
        // ported, see module header); L-- runs on success AND on error.
        await fsImpl.rm(join(trashRoot, candidate.dirent.name), {
          recursive: true,
          force: true,
        })
        result.removed++
      } catch (error) {
        recordTrimError(result, error)
      }
      overCap--
    }
    if (result.removed > 0) {
      // Official: `g("sync_trash_trim",{removed_count:s.removed,
      //   total:y-s.removed})`
      logEvent('sync_trash_trim', {
        removed_count: result.removed,
        total: total - result.removed,
      })
    }
  } catch (error) {
    recordTrimError(result, error)
  }
  if (result.failure !== undefined) {
    // Official: `V("warn","sync_trash_trim_failed",{code:s.failure})` —
    // leveled-logger channel approximated with logForDebugging (OCC's
    // analytics metadata cannot carry string codes).
    logForDebugging(
      `sync_trash_trim_failed: code=${result.failure} removed=${result.removed} errors=${result.errors}`,
    )
  }
  return result
}

/**
 * OCC counterpart of the official `De` sweep for the skills root:
 * `~/.claude/skills/.trash` (official `gYe=P("skills",yYt)` under
 * `Ne()`). The plugins/.trash half (`aFe`) is N-A — plugins/marketplace
 * was removed from OCC (OCC-31). Runs unconditionally in the retention
 * sweep, outside the cutoff-null guard, exactly like the official.
 */
export async function cleanupSkillsTrashCap(): Promise<{
  messages: number
  errors: number
}> {
  const trashRoot = join(
    getClaudeConfigHomeDir(),
    'skills',
    TRASH_DIR_NAME,
  )
  const trimResult = await trimSyncTrashRoot(trashRoot)
  return { messages: trimResult.removed, errors: trimResult.errors }
}
