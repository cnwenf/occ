import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import type { PermissionRule } from '../../types/permissions.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { matchingRuleForInput } from './filesystem.js'
import { permissionRuleValueToString } from './permissionRuleParser.js'
import { getRuleListForToolName } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

/**
 * Shared Read-deny predicates (CC 2.1.290 cluster B).
 *
 * Extracted from `src/utils/attachments.ts` (where `isFileReadDenied` landed
 * for the 2.1.289 changelog #3 fix) so the three 2.1.290 surfaces can share
 * one predicate — official does the same (`UB`/`w2` is consumed by the mention
 * pipeline, the paste/drag guard `sgs/Ykt` and the instruction-file judges
 * `Bkt`/`Fne`). `attachments.ts` re-exports `isFileReadDenied` so its existing
 * importers/tests keep working.
 *
 * See `docs/gap-research-291/cluster-b-read-deny-mentions.md`.
 */

/**
 * Official `aje` (2.1.289) / `Drr` (2.1.290) gate: does this permission
 * context carry at least one Read deny rule that could match a path?
 * `Kn(ctx,"read","deny").size>0` in the binary. Used to skip the
 * symlink-spelling resolution (getPathsForPermissionCheck does sync fs
 * syscalls) when no read-deny rule exists — pure-context check, no I/O.
 *
 * Official `sy` (isReadBlocked) additionally ORs `restricted === true` and
 * `blockReadsOutsideWorkingDirectories === true`; neither surface exists in
 * OCC (grep-proven N-A, staged since OCC-107/108), so the deny-rule arm is
 * the whole predicate here.
 */
export function hasReadDenyRules(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  return (
    getRuleListForToolName(
      toolPermissionContext,
      FILE_READ_TOOL_NAME,
      'deny',
    ).length > 0
  )
}

/**
 * Deny gate for the auto-read attachment surfaces (@-mentioned, changed, and
 * IDE-selected files) plus — since 2.1.290 — pasted/dragged image paths,
 * @-mentioned directory listings and instruction (CLAUDE.md/rules/AGENTS.md)
 * files. CC 2.1.289 changelog #3 (SECURITY):
 * "Fixed `Read` deny rules not applying to files @-mentioned, changed, or
 * selected in the IDE through a symlink".
 *
 * Mirrors the official v289 landing gate `aje(ctx) && bge(Sge(path,ctx))`:
 *   - aje(ctx)  — only resolve spellings when a read-deny rule exists
 *                 (hasReadDenyRules above; skips getPathsForPermissionCheck's
 *                 sync fs syscalls otherwise). Official fidelity short-circuit.
 *   - Sge(path) — every spelling: original + each symlink target + canonical
 *                 landing. OCC analogue: getPathsForPermissionCheck.
 *   - bge(...)  — deny if ANY spelling matches a read-deny rule.
 *
 * The pre-fix (v288-equivalent) surface-only match was the vulnerability:
 * a symlink `./link -> ./secret/x` under deny `Read(./secret/**)` matched only
 * the surface `./link`, bypassing the rule. This is the single gate every
 * auto-read call site funnels through — hardening it closes every surface at
 * once and cannot regress the Read tool, which has its own separate
 * resolution-aware check (checkReadPermissionForTool).
 *
 * Exported for tests (OCC-146 readDenySymlink289 suite consumes it via the
 * `attachments.ts` re-export).
 */
export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  // Surface match (v288 behavior) — always computed, no fs syscalls.
  const surfaceDenied =
    matchingRuleForInput(
      filePath,
      toolPermissionContext,
      'read',
      'deny',
    ) !== null

  // aje(ctx) short-circuit: with zero read-deny rules no spelling can match,
  // so return the surface result directly and skip the resolution syscalls.
  if (!hasReadDenyRules(toolPermissionContext)) {
    return surfaceDenied
  }
  if (surfaceDenied) {
    return true
  }

  // bge(Sge(path), ctx): deny if ANY spelling (original + each symlink target
  // + canonical landing) matches a read-deny rule.
  return getPathsForPermissionCheck(filePath).some(
    spelling =>
      matchingRuleForInput(
        spelling,
        toolPermissionContext,
        'read',
        'deny',
      ) !== null,
  )
}

/**
 * Persisted Read deny rules, straight off disk. Official `f1({
 * strictPersistedTrust:!0}).filter(n=>n.ruleBehavior==="deny")` — the first
 * half of the `N2` context extender (@210758348).
 */
export function loadPersistedReadDenyRules(): PermissionRule[] {
  return loadAllPermissionRulesFromDisk().filter(
    rule => rule.ruleBehavior === 'deny',
  )
}

/**
 * Official `N2` (@210758348): copy `context` with every persisted deny rule
 * merged into `alwaysDenyRules`, keyed by source and de-duplicated
 * (`n.alwaysDenyRules[r]?.includes(s)?n:{...}`). Immutable — the input
 * context is never mutated.
 *
 * The official also forces `blockReadsOutsideWorkingDirectories: true` when
 * `Tze()`; that setting does not exist in OCC (N-A), so the merge covers the
 * deny-rule arm only.
 *
 * Needed because instruction files and startup paths load BEFORE any engine
 * permission context exists — they must still honour the user's persisted
 * `Read(...)` deny rules.
 *
 * `rules` may be supplied by a caller that already loaded them (avoids a
 * second disk/cache pass when several paths are judged in one sweep).
 */
export function extendContextWithPersistedReadDenyRules(
  context: ToolPermissionContext,
  rules: readonly PermissionRule[] = loadPersistedReadDenyRules(),
): ToolPermissionContext {
  return rules.reduce<ToolPermissionContext>((extended, rule) => {
    const ruleValue = permissionRuleValueToString(rule.ruleValue)
    const existing = extended.alwaysDenyRules[rule.source] ?? []
    if (existing.includes(ruleValue)) {
      return extended
    }
    return {
      ...extended,
      alwaysDenyRules: {
        ...extended.alwaysDenyRules,
        [rule.source]: [...existing, ruleValue],
      },
    }
  }, context)
}

/** Stable identity for a rule set — used to invalidate the memo below. */
function rulesFingerprint(rules: readonly PermissionRule[]): string {
  return rules
    .map(
      rule =>
        `${rule.source}\u0000${permissionRuleValueToString(rule.ruleValue)}`,
    )
    .join('\u0001')
}

let persistedDenyContextMemo:
  | { fingerprint: string; context: ToolPermissionContext }
  | undefined

/**
 * Official `igs` (@210758348): `N2({...e, alwaysDenyRules:{}})` — a context
 * whose deny rules come ONLY from persisted settings. Callers that do have a
 * live context pass it to `extendContextWithPersistedReadDenyRules` instead
 * (official: `he?[he,igs(he)]:[]`, i.e. both the live and the persisted-only
 * view are consulted); startup callers with no live context use this.
 *
 * Memoized on the loaded rule set's fingerprint, NOT on time: the memory-file
 * walk probes dozens of paths per startup and `matchingRuleForInput` caches its
 * compiled gitignore matchers by rules-object identity, so a fresh object per
 * probe would rebuild them every time. Any settings change (which goes through
 * `resetSettingsCache()`) alters the fingerprint and yields a new context.
 */
export function getPersistedReadDenyContext(): ToolPermissionContext {
  const rules = loadPersistedReadDenyRules()
  const fingerprint = rulesFingerprint(rules)
  if (persistedDenyContextMemo?.fingerprint === fingerprint) {
    return persistedDenyContextMemo.context
  }
  const context = extendContextWithPersistedReadDenyRules(
    getEmptyToolPermissionContext(),
    rules,
  )
  persistedDenyContextMemo = { fingerprint, context }
  return context
}

/** Test hook: drop the memoized persisted-deny context. */
export function resetPersistedReadDenyContextForTesting(): void {
  persistedDenyContextMemo = undefined
}
