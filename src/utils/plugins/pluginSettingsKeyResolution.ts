/**
 * Plugin settings-key resolution (official Claude Code 2.1.285, changelog:
 * "Fixed `claude plugin disable` and `enable` with a full `name@marketplace`
 * id changing a settings entry in another letter case instead of the installed
 * plugin's own").
 *
 * Ported from the decompiled official 2.1.285 linux-x64 ELF (alias-machinery
 * chunk-2sb5hqyj.js @196749514 region; writer chunk region dumped at
 * /tmp/agentE/pn_28{4,5}.txt):
 *
 *   official            here
 *   --------            ----
 *   `sf(e,n)`           matchesPluginIdCaseInsensitive
 *   `Uo(e)`             foldPluginSettingsKey (NFC + lowercase)
 *   `AA(e,n)`           findStoredPluginKey (exact-first, then folded find)
 *   `Ke` writer sweep   planEnabledPluginsWrite (see below)
 *
 * The official 2.1.285 fix has two halves:
 *
 * 1. RESOLUTION (portable, this file): when reading/writing
 *    `enabledPlugins`, resolve the requested id against the STORED keys —
 *    exact match first, then a case-insensitive/NFC-folded match — so an id
 *    typed in another letter case operates on the installed plugin's own
 *    entry. This existed partially in 2.1.284 (`Me`/`xn` reads were already
 *    fold-aware) but the WRITE path was exact-match, which is the bug.
 *
 * 2. BUILTIN-ALIAS canonicalization (NO-OP in OCC): the official `fpt`/`g2`/
 *    `F_`/`nT`/`_` machinery canonicalizes `name@builtin` ids through an
 *    alias table (`p()` registry, folded fallback `_`). OCC's
 *    builtinPlugins.ts has no alias table — builtin plugins have exactly one
 *    canonical id — so alias canonicalization has no OCC surface and is
 *    deliberately not ported (never invent).
 *
 * The official 2.1.285 writer (`Ke`, replacing 2.1.284's `We`) verbatim:
 *
 *   function Ke(e,n,i,s,o){return ta(e,(r)=>{let p=Object.fromEntries(
 *     Object.entries({...s,[n]:i}).flatMap(([g,d])=>{
 *       let I=fpt(r?.enabledPlugins,g);
 *       return[...I.replaced.map((u)=>[u,void 0]),[I.written,d]]}));
 *     return{enabledPlugins:{...r?.enabledPlugins,...Object.fromEntries(
 *       Object.keys(p).flatMap((g)=>_n(r?.enabledPlugins,g)
 *         .filter((d)=>d!==g).map((d)=>[d,void 0]))),...p}}},void 0,o)}
 *
 * i.e. for every key being written: null out the case-variant keys already
 * stored (`_n` sweep + `fpt.replaced`), then write the canonical key.
 * `planEnabledPluginsWrite` below is the alias-free degenerate of that sweep
 * (fpt without an alias table → `{written: id, replaced: []}`; the `_n`
 * sweep still nulls case-variant duplicates).
 *
 * NOTE: `_n` guards folding with `_pt(n)` (a "foldable id" predicate whose
 * body was not recovered from the binary). `planEnabledPluginsWrite` folds
 * unguarded — for `name@marketplace` ids this matches the official; for
 * degenerate non-id keys the fold reduces to case-insensitive equality.
 */

/**
 * Official `sf(e,n)`: plugin-id equality ignoring letter case.
 * `return e===n||e.toLowerCase()===n.toLowerCase()`
 */
export function matchesPluginIdCaseInsensitive(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/**
 * Official `Uo(e)`: the fold used for `enabledPlugins` key comparison —
 * NFC-normalize, then lowercase.
 */
export function foldPluginSettingsKey(key: string): string {
  return key.normalize('NFC').toLowerCase()
}

/**
 * Official `AA(e,n)`: find the stored spelling of an id among `keys` —
 * exact match wins; otherwise the first case-insensitive match.
 * Returns undefined when no stored key spells the id in any case.
 */
export function findStoredPluginKey(
  keys: ReadonlyArray<string>,
  pluginId: string,
): string | undefined {
  return (
    keys.find(key => key === pluginId) ??
    keys.find(key => matchesPluginIdCaseInsensitive(key, pluginId))
  )
}

/**
 * Resolve which key of an `enabledPlugins` record the requested id refers to.
 * This is the read-side half of the 2.1.285 fix: `disable`/`enable` with a
 * full `name@marketplace` id in another letter case must operate on the
 * installed plugin's OWN stored entry, not write a second entry.
 */
export function resolveEnabledPluginsKey(
  enabledPlugins: Readonly<Record<string, unknown>> | undefined,
  pluginId: string,
): string | undefined {
  return findStoredPluginKey(Object.keys(enabledPlugins ?? {}), pluginId)
}

/** Result of planning an `enabledPlugins` write (official `Ke` sweep). */
export interface EnabledPluginsWritePlan {
  /** The key to write the new value under (canonical requested spelling). */
  readonly written: string
  /** Stored case-variant spellings of the same id to null out (set undefined). */
  readonly replaced: ReadonlyArray<string>
}

/**
 * Alias-free degenerate of the official 2.1.285 writer sweep (`Ke` + `fpt`):
 * writing `pluginId` nulls out every OTHER stored key that folds to the same
 * id, so a disable/enable in another letter case can never leave a stale
 * opposite-case entry behind. Apply `replaced` keys as `undefined` (the
 * settings mergeWith-deletion convention) alongside the `written` value.
 */
export function planEnabledPluginsWrite(
  enabledPlugins: Readonly<Record<string, unknown>> | undefined,
  pluginId: string,
): EnabledPluginsWritePlan {
  const folded = foldPluginSettingsKey(pluginId)
  const replaced = Object.keys(enabledPlugins ?? {}).filter(
    key => key !== pluginId && foldPluginSettingsKey(key) === folded,
  )
  return { written: pluginId, replaced }
}
