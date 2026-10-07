import { randomUUID } from 'crypto'
import { resolve as resolvePath } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../fsOperations.js'
import { expandPath } from '../path.js'
import { hasReadDenyRules, isFileReadDenied } from './readDeny.js'
import {
  assertSymlinkResolutionsUnchangedForRead,
  stashCheckTimeResolutions,
  type StashEntry,
} from './symlinkResolutionStash.js'

/**
 * Shared guarded read for the auto-read surfaces (CC 2.1.290 cluster B1/B2/B3).
 *
 * Official keeps ONE read-guard module (@210752500–210758104) serving the
 * paste/drag image path, the @-mention pipeline and the instruction-file
 * judges; this file is the OCC port of that module's read half:
 *
 * | official (cc290, byte-verified)        | OCC port                        |
 * |----------------------------------------|---------------------------------|
 * | `Gne` @210757584                       | `dotdotNormalizedReadPath`      |
 * | `Ykt` @210757639 (deny decision)       | `resolveGuardedRead`            |
 * | `sgs` @210758104 (refused/unexamined)  | `readPastedFileGuarded`         |
 * | `Vkt` @210757291 (verified landing)    | `readGuardedAtLanding`          |
 * | `Nkt` @210754824 (absent vs refused)   | `resolutionsUnchangedAndAbsent` |
 * | `LMe` @210753661 (attached-read id)    | `attachedReadContext`           |
 * | `sy`  @210756551 (reads blocked?)      | `hasReadDenyRules` (readDeny.ts)|
 *
 * Documented deviations (see
 * `docs/gap-research-291/cluster-b-read-deny-mentions.md` §B1–§B3):
 *
 * 1. `Vkt` reads through `MMe` — the verified-open helper (macOS identity
 *    `VOe`, linux/wsl `/proc/self/fd` `xkt`, mac/win `kMe` double-check).
 *    OCC reuses the 2.1.251 stash gate instead: stash the check-time landing
 *    spellings under a synthetic `attached-read-<uuid>` toolUseId and run
 *    `assertSymlinkResolutionsUnchangedForRead` immediately before the IO, so
 *    a link swapped mid-read raises `SymlinkReadRefusedError`. Same observable
 *    contract (bytes only from the approved landing), one mechanism with the
 *    file tools.
 * 2. `MD` (network/UNC shape) — its `Gf` binding is chunk-local and was not
 *    byte-recovered, and `Ke`(=expandPath) collapses a leading `//` before
 *    `MD` sees it, so neither `Ykt`'s `MD(s)&&!g.some(sy)` early bypass nor
 *    `Nkt`'s `!n.some(MD)` guard is reproduced verbatim. The bypass is dropped
 *    (perf-only; the `he` arm reaches the same `"unexamined"` verdict) and
 *    `Nkt`'s guard becomes OCC's own UNC predicate, which is a fail-closed
 *    superset (a UNC spelling can never yield `"absent"`).
 * 3. `sy(ctx)` = `Drr(ctx) || ctx.restricted === true ||
 *    ctx.blockReadsOutsideWorkingDirectories === true`; the last two surfaces
 *    do not exist in OCC (grep-proven, staged since OCC-107/108), so
 *    `hasReadDenyRules` is the whole predicate.
 * 4. `Y`'s `kme(spelling, ctx.trustedNetworkDirectories)` arm — field absent
 *    in OCC's `ToolPermissionContext` → N-A.
 * 5. `LMe`'s macOS `stashIdentity` arm — OCC's stash has no identity lane
 *    (deviation 1) → N-A.
 * 6. Landing-read timeout (验收 P3, 2026-10-07): official `Vkt`/`Nkt` open the
 *    verified landing with `AbortSignal.timeout(XA)` (cc291 `Nkt` @210714577
 *    `lMe(Ke(e),n,AbortSignal.timeout(jA))(...)`). OCC's `readFileBytes`
 *    abstraction takes no signal, so `readLandingBytes` RACES the read against
 *    `AbortSignal.timeout(GUARDED_READ_TIMEOUT_MS)` — same 1000 ms bound, same
 *    absent/refused landing on timeout. Two sub-points kept honest: (a) the
 *    `unexamined` branch of `readPastedFileGuarded` is NOT wrapped — official
 *    `ogs` (@210715481 `oe().readFileBytes(Une(e))`) carries no signal there
 *    either, so OCC matches (conformant, not a deviation); (b) OCC's absence
 *    probe (`resolutionsUnchangedAndAbsent`→lstat) is not itself
 *    timeout-wrapped, whereas official `Ekt` passes `AbortSignal.timeout(jA)`
 *    — a residual, low-risk (metadata lstat on a path already resolved once),
 *    recorded here rather than silently dropped.
 */

/** Official `Ykt` outcomes that are not a spelling set. */
export type GuardedReadSentinel = 'refused' | 'absent' | 'unexamined'

/** Official `Ykt` return: landing spellings, or a sentinel. */
export type GuardedResolution = StashEntry | 'refused' | 'unexamined'

/** Official `sgs`/`Vkt` return: bytes, or why there are none. */
export type GuardedReadResult = Buffer | 'refused' | 'absent'

/**
 * Official's context getter (`()=>{let he=o?.getState().toolPermissionContext;
 * return he?[he,igs(he)]:[]}`) — a live closure over app state, re-invoked on
 * both sides of the resolution. Returns BOTH the live context and the
 * persisted-deny-only view; an empty array means "no context" and fails
 * closed.
 */
export type PermissionContextGetter = () => readonly ToolPermissionContext[]

/** Official `XA` (cc291 `jA`) — resolution/absence probe timeout (ms). */
const GUARDED_READ_TIMEOUT_MS = 1000

/**
 * Live timeout for the verified-landing read. Defaults to the official `XA`;
 * the test seam `_setGuardedReadTimeoutForTesting` lowers it so a
 * hanging-read test resolves in milliseconds instead of a full second.
 */
let guardedReadTimeoutMs = GUARDED_READ_TIMEOUT_MS

/** Test-only: override the guarded-landing read timeout (undefined resets). */
export function _setGuardedReadTimeoutForTesting(
  ms: number | undefined,
): void {
  guardedReadTimeoutMs = ms ?? GUARDED_READ_TIMEOUT_MS
}

/**
 * Read the verified landing under the official `XA` timeout.
 *
 * Official `Vkt`/`Nkt` open the landing with `AbortSignal.timeout(jA)`:
 * `lMe(Ke(e),n,AbortSignal.timeout(jA))((h)=>h.handle.readFile())` (cc291
 * `Nkt` @210714577), so a landing that never returns bytes — a dangling
 * NFS/FUSE mount, a symlink target wedged on a stuck device — aborts after
 * `XA` ms instead of hanging the permission flow; on abort the read yields
 * `void 0` and official maps it to `"absent"`/`"refused"`.
 *
 * OCC's `readFileBytes(path, maxBytes?)` abstraction takes no signal, so the
 * same `AbortSignal.timeout(GUARDED_READ_TIMEOUT_MS)` is RACED against the
 * read here; on timeout the race rejects and the caller's catch maps it to
 * absent/refused exactly as official maps `r===void 0`.
 *
 * Scope: ONLY the verified-landing read is wrapped. Official's `unexamined`
 * branch (`ogs`: `oe().readFileBytes(Une(e))`, cc291 @210715481) carries NO
 * signal, and OCC's `readPastedFileGuarded` unexamined branch matches it — so
 * that call is deliberately left unwrapped (conformant, not a deviation).
 */
async function readLandingBytes(landing: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(guardedReadTimeoutMs)
  const timeout = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? new Error('guarded read timeout')),
      { once: true },
    )
  })
  return await Promise.race([
    getFsImplementation().readFileBytes(landing),
    timeout,
  ])
}


/** Official warn text emitted by `sgs` on refusal. */
const PASTED_READ_REFUSED_MESSAGE =
  'Pasted path is not read: the read is refused'

/** Official `Vkt` warn text template. */
function pastedReadNotAtLandingMessage(outcome: 'absent' | 'refused'): string {
  return `Pasted path is not read where it lands: ${outcome}`
}

/**
 * Official `Gne` @210757584, verbatim:
 *   `var Gne=(e)=>e.split(/[\\/]/).includes("..")?Ke(e):e`
 * `Ke` is `expandPath` (binary-proven via the export alias @225547173), so a
 * path carrying a `..` segment is normalized before it is read; anything else
 * is passed through untouched.
 */
export function dotdotNormalizedReadPath(path: string): string {
  return path.split(/[\\/]/).includes('..') ? expandPath(path) : path
}

/**
 * Official `LMe`'s id @210753661: `` `attached-read-${c3n()}` `` with
 * `c3n = randomUUID` from `crypto`.
 */
export function nextAttachedReadToolUseId(): string {
  return `attached-read-${randomUUID()}`
}

/**
 * OCC's UNC/network shape predicate — the same one
 * `getPathsForPermissionCheck` applies before it refuses to walk. Stands in
 * for official `MD` inside the `Nkt` analogue only (deviation 2): a UNC
 * spelling can never be reported `"absent"`, which is the fail-closed
 * direction.
 */
export function isNetworkShapedPath(path: string): boolean {
  return path.startsWith('//') || path.startsWith('\\\\')
}

/**
 * Official `$ne`'s absence half: does this path not exist? `$ne` is
 * `!MD(e)&&await hd(O2(e),n,…).then(()=>!1,Iu)` — an lstat-style probe that
 * resolves to `false` when the path is there and to the error predicate when
 * it is not. Network shapes are never probed (no DNS/SMB from a paste).
 */
async function isAbsent(path: string): Promise<boolean> {
  if (isNetworkShapedPath(path)) {
    return false
  }
  try {
    await getFsImplementation().lstat(path)
    return false
  } catch {
    return true
  }
}

/**
 * Official `Nkt` @210754824, verbatim shape:
 * ```js
 * async function Nkt(e,n,r){let g=!e.split(/[\\/]/).includes("..")&&!n.some(MD)
 *   &&await $ne(Ke(e),r)?await Hne(Ke(e),r):void 0;
 *   return g?.length===n.length&&g.every((h,S)=>h===n[S])}
 * ```
 * True only when the path is genuinely absent AND its freshly recomputed
 * spellings are element-for-element identical to the check-time spellings —
 * i.e. nothing moved, there is simply nothing there.
 */
export async function resolutionsUnchangedAndAbsent(
  path: string,
  checkTimeSpellings: readonly string[],
): Promise<boolean> {
  const hasDotDotSegment = path.split(/[\\/]/).includes('..')
  const anyNetworkShaped = checkTimeSpellings.some(isNetworkShapedPath)
  if (hasDotDotSegment || anyNetworkShaped) {
    return false
  }
  const expanded = expandPath(path)
  if (!(await isAbsent(expanded))) {
    return false
  }
  const fresh = getPathsForPermissionCheck(expanded)
  return (
    fresh.length === checkTimeSpellings.length &&
    fresh.every((spelling, index) => spelling === checkTimeSpellings[index])
  )
}

function readContexts(
  getContexts: PermissionContextGetter,
): readonly ToolPermissionContext[] | null {
  try {
    const contexts = getContexts()
    return contexts.length === 0 ? null : contexts
  } catch {
    return null
  }
}

function isDeniedForAny(
  path: string,
  contexts: readonly ToolPermissionContext[],
): boolean {
  return contexts.some(context => isFileReadDenied(path, context))
}

function blocksReads(
  contexts: readonly ToolPermissionContext[],
): boolean {
  return contexts.some(hasReadDenyRules)
}

/**
 * Official `Ykt` @210757639 — the deny decision for one pasted/mentioned
 * path. Verbatim:
 * ```js
 * async function Ykt(e,n,r){let s=Ke(e),g=n();
 *   if(g.length===0||g.some((_e)=>r(e,_e)!==void 0))return"refused";
 *   if(MD(s)&&!g.some(sy))return"unexamined";
 *   let w=AbortSignal.timeout(XA),
 *       H=await Promise.all(D([s,f7n(Gne(e))]).map((_e)=>Hne(_e,w))),[W]=H,
 *       q=n(),
 *       Y=!H.includes(void 0)&&q.length>0&&!q.some((_e)=>[e,...H.flatMap((ke)=>ke??[])]
 *           .some((ke)=>r(ke,_e)!==void 0||kme(ke,_e.trustedNetworkDirectories))),
 *       he=q.some(sy)?W:"unexamined";
 *   return Y&&he!==void 0?he:"refused"}
 * ```
 *
 * - `r(path,ctx)!==void 0` is the unified lexical judge `Jhn` → OCC's
 *   `isFileReadDenied` (its `"network"` arm is deviation 2/4).
 * - `Hne` never yields `undefined` in OCC (`getPathsForPermissionCheck`
 *   always returns at least the surface path), so `!H.includes(void 0)` is
 *   structurally satisfied and omitted.
 * - The context getter is invoked TWICE — before and after the resolution —
 *   because it reads live app state; a deny rule that lands mid-flight is
 *   caught by the second consultation.
 * - Fail-closed: no contexts, or a throwing getter → `'refused'`.
 */
export async function resolveGuardedRead(
  path: string,
  getContexts: PermissionContextGetter,
): Promise<GuardedResolution> {
  let expanded: string
  try {
    expanded = expandPath(path)
  } catch {
    return 'refused'
  }

  const before = readContexts(getContexts)
  if (before === null) {
    return 'refused'
  }
  if (isDeniedForAny(path, before)) {
    return 'refused'
  }
  // Official's `if(MD(s)&&!g.some(sy))return"unexamined"` early bypass is NOT
  // ported: `MD`'s `Gf` binding is chunk-local and was not byte-recovered, and
  // `Ke` (= expandPath) already collapses the leading `//` of a UNC shape
  // before `MD` sees it, so the predicate cannot be reconstructed honestly.
  // It is a pure perf/network-IO bypass — the `he` arm below returns the same
  // `"unexamined"` verdict, and OCC's `getPathsForPermissionCheck` refuses to
  // touch the filesystem for UNC shapes anyway. See deviation 2.

  // Official `D([s, f7n(Gne(e))])` — dedupe the two input spellings, resolve
  // each, keep the first result (`[W]=H`) as the approved landing set.
  const inputs = [
    expanded,
    resolvePath(dotdotNormalizedReadPath(path)),
  ].filter((input, index, all) => all.indexOf(input) === index)
  const resolutions = inputs.map(input => getPathsForPermissionCheck(input))
  const landing = resolutions[0]
  if (landing === undefined) {
    return 'refused'
  }

  const after = readContexts(getContexts)
  if (after === null) {
    return 'refused'
  }
  const examined = [path, ...resolutions.flat()]
  if (examined.some(spelling => isDeniedForAny(spelling, after))) {
    return 'refused'
  }

  return blocksReads(after) ? landing : 'unexamined'
}

/**
 * Official `Vkt` @210757291 — read the approved landing, or say why not:
 * ```js
 * async function Vkt(e,n){let r=await MMe(Ke(e),n,AbortSignal.timeout(XA))(
 *     (h)=>h.handle.readFile()),
 *   g=r===void 0&&await Nkt(e,n,AbortSignal.timeout(XA))?"absent":"refused";
 *   if(r===void 0)t(`Pasted path is not read where it lands: ${g}`,{level:"warn"});
 *   return r??g}
 * ```
 * OCC reads through the 2.1.251 stash gate (deviation 1): the check-time
 * spellings are stashed under a fresh `attached-read-<uuid>` toolUseId and
 * `assertSymlinkResolutionsUnchangedForRead` re-resolves and refuses when any
 * fresh spelling was not approved. Bytes therefore only ever come from the
 * canonical landing that was examined.
 */
export async function readGuardedAtLanding(
  path: string,
  checkTimeSpellings: readonly string[],
): Promise<GuardedReadResult> {
  const toolUseId = nextAttachedReadToolUseId()
  try {
    stashCheckTimeResolutions(
      { toolUseId },
      path,
      'read',
      checkTimeSpellings,
    )
    assertSymlinkResolutionsUnchangedForRead({ toolUseId }, expandPath(path))
  } catch (error) {
    logForDebugging(
      `${pastedReadNotAtLandingMessage('refused')} (${
        error instanceof Error ? error.message : String(error)
      })`,
      { level: 'warn' },
    )
    return 'refused'
  }

  const landing =
    checkTimeSpellings[checkTimeSpellings.length - 1] ??
    dotdotNormalizedReadPath(path)
  try {
    return await readLandingBytes(landing)
  } catch {
    const outcome = (await resolutionsUnchangedAndAbsent(
      path,
      checkTimeSpellings,
    ))
      ? 'absent'
      : 'refused'
    logForDebugging(pastedReadNotAtLandingMessage(outcome), { level: 'warn' })
    return outcome
  }
}

/**
 * Official `sgs` @210758104 — the guarded paste read, verbatim:
 * ```js
 * async function sgs(e,n,r){let s=await Ykt(e,n,r).catch(()=>"refused");
 *   if(s==="refused")return t("Pasted path is not read: the read is refused",
 *     {level:"warn"}),"refused";
 *   return s==="unexamined"?oe().readFileBytes(Gne(e)):Vkt(e,s).catch(()=>"refused")}
 * ```
 * `"unexamined"` keeps the pre-290 raw read of the typed path (nothing blocks
 * reads, so there is no landing to verify); anything else goes through the
 * verified landing read.
 */
export async function readPastedFileGuarded(
  path: string,
  getContexts: PermissionContextGetter,
): Promise<GuardedReadResult> {
  const resolution = await resolveGuardedRead(path, getContexts).catch(
    (): 'refused' => 'refused',
  )
  if (resolution === 'refused') {
    logForDebugging(PASTED_READ_REFUSED_MESSAGE, { level: 'warn' })
    return 'refused'
  }
  if (resolution === 'unexamined') {
    try {
      return await getFsImplementation().readFileBytes(
        dotdotNormalizedReadPath(path),
      )
    } catch {
      return 'absent'
    }
  }
  return await readGuardedAtLanding(path, resolution).catch(
    (): 'refused' => 'refused',
  )
}

/**
 * Official `LMe` @210753661 — the @-mention/attachment read context, verbatim
 * minus the macOS identity arm (deviation 5):
 * ```js
 * async function LMe(e,n,r){let s=`attached-read-${c3n()}`,g=jv(e);
 *   if(r.session.writePermissionStash.stash(s,g,n,"read"),O()==="macos")
 *     r.session.writePermissionStash.stashIdentity(s,g,await VOe(n));
 *   return{...r,toolUseId:s}}
 * ```
 * Called from the mention pipeline as `Qb.call(input, H ? await LMe(path,
 * spellings, ctx) : ctx)` (@213674546 / @213690234 / @213690750), so the
 * FileReadTool's own `assertSymlinkResolutionsUnchangedForRead` gate consumes
 * the entry — without it the assert falls back to a fresh resolution and
 * no-ops (the 289-shaped hole).
 */
export function attachedReadContext(
  path: string,
  checkTimeSpellings: readonly string[],
  context: ToolUseContext,
): ToolUseContext {
  const toolUseId = nextAttachedReadToolUseId()
  stashCheckTimeResolutions(
    { toolUseId },
    path,
    'read',
    checkTimeSpellings,
  )
  return { ...context, toolUseId }
}

/**
 * Official's check-time spelling set for an auto-read surface — `A1t`'s
 * `W=!H?[e]:h?.landing??await TB(e,…)` (@213687900) and `GTr`'s
 * `be=h?await TB(he,…):[he]` (@213674200): the symlink spellings are resolved
 * ONLY when reads are blocked (`sy(ctx)`), otherwise the surface path stands in
 * for itself and no resolution syscalls are spent.
 */
export function checkTimeReadResolutions(
  path: string,
  readsBlocked: boolean,
): readonly string[] {
  return readsBlocked ? getPathsForPermissionCheck(path) : [path]
}

/**
 * Official `H ? await LMe(e,q,r) : r` — the exact expression at all three
 * auto-read `FileReadTool.call` sites (@213674546 getChangedFiles,
 * @213690234 readTruncatedFile, @213690750 generateFileAttachment). When reads
 * are not blocked the untouched context is passed, so no stash entry is
 * created and the pre-290 behavior is preserved bit for bit.
 */
export function guardedAttachedReadContext(
  path: string,
  readsBlocked: boolean,
  checkTimeSpellings: readonly string[],
  context: ToolUseContext,
): ToolUseContext {
  return readsBlocked
    ? attachedReadContext(path, checkTimeSpellings, context)
    : context
}

/**
 * Official `h?await PMe(he,be,…)` (@213674600) — the changed-file IMAGE read is
 * guarded by the same verified-open mechanism as the text read, with the same
 * check-time spellings. OCC has no verified-open helper (deviation 1), so this
 * runs the 2.1.251 stash gate directly before the caller's raw read: it throws
 * `SymlinkReadRefusedError` when a link moved since the check, and is a no-op
 * when reads are not blocked.
 */
export function assertGuardedReadUnchanged(
  path: string,
  readsBlocked: boolean,
  checkTimeSpellings: readonly string[],
): void {
  if (!readsBlocked) {
    return
  }
  const toolUseId = nextAttachedReadToolUseId()
  stashCheckTimeResolutions({ toolUseId }, path, 'read', checkTimeSpellings)
  assertSymlinkResolutionsUnchangedForRead({ toolUseId }, expandPath(path))
}

/** Official's `XA` timeout, exposed for callers that need the same budget. */
export { GUARDED_READ_TIMEOUT_MS }
