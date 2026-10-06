/**
 * CC 2.1.291 (cluster C item 1, security 🔒) — settings-file link spelling
 * table.
 *
 * Official source (2.1.291 linux-x64 ELF @206550974, verbatim):
 *
 *   var gf=2000;function ol(){let e=new Map;try{let n=Lb(),
 *   r=D(n===void 0?Cr():[...Cr(),n]),s=qL(),g=r.join("\x00"),
 *   h=SJo().monotonicNow(),w=s.settingsFileLinks;
 *   if(w!==void 0&&w.key===g&&h-w.builtAt<gf)return w.files;
 *   s.settingsFileLinks={key:g,builtAt:h,files:e};let S=new Map;
 *   for(let R of r){let x=bi(R);
 *     if(x.unresolved)t(`permissions: the walk of settings file ${R} did not
 *       reach its end; only the links it met are recorded`);
 *     if(!x.leafIsSymlink)continue;
 *     for(let I of x.spellings)for(let L of D([I,$n(I)]))if(!il(L))
 *       S.set(TE(L),R)}
 *   return s.settingsFileLinks={key:g,builtAt:h,files:S},S}
 *   catch(n){return c(Error("the walk of the settings links threw; for two
 *     seconds no settings file counts as a link"),{cause:n}),e}}
 *   function nMe(e){return ol().has(TE(Ke(e)))||il(e)}
 *
 * Identity translations (all binary-verified):
 * - `Cr()` + `Lb()` (all settings files + the --settings flag file) → OCC
 *   `getSettingsFilePathForSource` over SETTING_SOURCES (which already
 *   includes 'flagSettings').
 * - `qL().settingsFileLinks` (session-state stash) → module-level cache
 *   (doc 移植方案 sanctions module state; same single-slot semantics).
 * - `SJo().monotonicNow()` → performance.now() (test seam below).
 * - `bi(R)` → resolveWritePathDescriptor (the 2.1.280 component walker).
 * - `Ke` = expandPath (export alias `Ke as expandPath` @225547173).
 * - `TE(e)` = `$e(e).split(sep).map(kl).join(sep)` @206557333 ≈ normalize +
 *   per-segment lowercase fold → normalizeCaseForComparison(normalize(p)).
 * - `$n(I)` (the second per-spelling variant) → expandPath(I) in OCC.
 * - `il(L)` → isClaudeSettingsPath (literal settings endings + exact match
 *   against every settings path). The official il also folds in the
 *   managed-settings-dir locate subsystem (MSt/yf) OCC lacks — that is doc
 *   item 2/4 territory, explicitly out of this wave.
 * - `t(...)` → logForDebugging; `c(...)` → logError.
 *
 * Fail-degraded semantics (official): the EMPTY map is stashed into the cache
 * BEFORE the walk, so a throw leaves "for two seconds no settings file counts
 * as a link" cached, and the catch returns that same empty map — degraded,
 * never crashing the permission check.
 */
import { normalize } from 'path'
import { logForDebugging } from '../debug.js'
import { resolveWritePathDescriptor } from '../fsOperations.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { isClaudeSettingsPath, normalizeCaseForComparison } from './filesystem.js'

/** Official `gf=2000` — the link table is rebuilt at most every 2 seconds. */
export const SETTINGS_LINK_TTL_MS = 2000

/** Official `qL().settingsFileLinks` single-slot cache. */
type SettingsFileLinksCacheEntry = {
  /** Official `g = r.join("\x00")` — the settings-path set identity. */
  key: string
  /** Official `builtAt` (monotonic ms). */
  builtAt: number
  /** Official `files`: fold-key(spelling) → original settings path. */
  files: Map<string, string>
}

let settingsFileLinksCache: SettingsFileLinksCacheEntry | undefined

let clockOverride: (() => number) | undefined

function monotonicNow(): number {
  return clockOverride !== undefined ? clockOverride() : performance.now()
}

/** Test seam for the monotonic clock (official SJo().monotonicNow()). */
export function _setSettingsLinkClockForTesting(
  clock: (() => number) | undefined,
): void {
  clockOverride = clock
}

/** Test seam: drop the single-slot cache (official session-state slot). */
export function _resetSettingsFileLinksCacheForTesting(): void {
  settingsFileLinksCache = undefined
}

/** Official `D(n===void 0?Cr():[...Cr(),n])` — every settings file path,
 * including the --settings flag file (OCC's SETTING_SOURCES covers it via
 * 'flagSettings'), deduped. */
function getAllSettingsFilePaths(): string[] {
  const paths = SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter((path): path is string => path !== undefined)
  return [...new Set(paths)]
}

/** Official `TE(L)` — registration key: normalize + per-segment lowercase
 * fold (@206557333: `$e(e).split(sep).map(kl).join(sep)`). */
export function settingsLinkFoldKey(path: string): string {
  return normalizeCaseForComparison(normalize(path))
}

/** Official `TE(Ke(e))` — lookup key (Ke = expandPath, binary-verified via
 * the `Ke as expandPath` export alias @225547173). */
export function settingsLinkLookupKey(path: string): string {
  return settingsLinkFoldKey(expandPath(path))
}

/** Official `il(L)` — internal settings spellings that must NOT be
 * registered as link-table entries. OCC analogue: isClaudeSettingsPath. */
function isInternalSettingsSpelling(path: string): boolean {
  return isClaudeSettingsPath(path)
}

/**
 * Official `ol()` — the settings-file link spelling table.
 *
 * Maps every intermediate spelling of every symlinked settings file (each
 * spelling recorded by the per-hop walk, plus its expanded variant) back to
 * the ORIGINAL settings path, so the write gate can tell the user which
 * settings file leads there and refuse classifier approval.
 *
 * Cached for SETTINGS_LINK_TTL_MS keyed on the joined settings-path set;
 * any throw degrades to an empty map ("for two seconds no settings file
 * counts as a link") which is what was stashed before the walk began.
 */
export function getSettingsFileLinkMap(): Map<string, string> {
  const degraded = new Map<string, string>()
  try {
    const settingsPaths = getAllSettingsFilePaths()
    const cacheKey = settingsPaths.join('\x00')
    const builtAt = monotonicNow()
    const cached = settingsFileLinksCache
    if (
      cached !== undefined &&
      cached.key === cacheKey &&
      builtAt - cached.builtAt < SETTINGS_LINK_TTL_MS
    ) {
      return cached.files
    }
    // Official stashes the EMPTY map before walking: a throw below leaves
    // this degraded entry cached for the rest of the window.
    settingsFileLinksCache = { key: cacheKey, builtAt, files: degraded }
    const files = new Map<string, string>()
    for (const settingsPath of settingsPaths) {
      const walk = resolveWritePathDescriptor(settingsPath)
      if (walk.unresolved) {
        logForDebugging(
          `permissions: the walk of settings file ${settingsPath} did not reach its end; only the links it met are recorded`,
        )
      }
      if (!walk.leafIsSymlink) continue
      for (const spelling of walk.spellings) {
        // Official `D([I,$n(I)])` — the spelling plus its expanded variant,
        // deduped.
        for (const variant of [...new Set([spelling, expandPath(spelling)])]) {
          if (!isInternalSettingsSpelling(variant)) {
            files.set(settingsLinkFoldKey(variant), settingsPath)
          }
        }
      }
    }
    settingsFileLinksCache = { key: cacheKey, builtAt, files }
    return files
  } catch (cause) {
    logError(
      new Error(
        'the walk of the settings links threw; for two seconds no settings file counts as a link',
        { cause },
      ),
    )
    return degraded
  }
}

/** Official `nMe(e)`: `return ol().has(TE(Ke(e)))||il(e)` — the path is a
 * settings-file link spelling, or an internal settings spelling itself. */
export function isSettingsFileLink(path: string): boolean {
  return (
    getSettingsFileLinkMap().has(settingsLinkLookupKey(path)) ||
    isInternalSettingsSpelling(path)
  )
}
