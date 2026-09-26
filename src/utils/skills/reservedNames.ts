/**
 * CC 2.1.283 anthropic-skills reserved-namespace hardening.
 *
 * 2.1.283 REVERTED the 2.1.282 reservation of "claude-ai": the official
 * namespace array is back to a single element (zAe=["anthropic-skills"]
 * @197323070), the claude-ai:↔anthropic-skills: alias transform (282's pge)
 * is gone, and the 'renamed' held-back kind (syncedSkills formerDisplayName)
 * was removed with it. Skills/commands/workflows/MCP prompts named
 * "claude-ai:*" load again and Skill(claude-ai:*) rules are ordinary prefix
 * rules.
 *
 * Byte-exact port of the official minified clusters (v2.1.283 linux-x64 ELF,
 * md5 b5afa8208e39db13e13e89449b1825f2):
 *   - zAe @197323070   RESERVED_NAMESPACES (single element)
 *   - kdn @197323120   hasReservedNamespacePrefix
 *   - zat @201087884+  reservedNamespaceOf
 *   - jB               isReservedName
 *   - _Mt @201087884   reservedNameReason fallback (plural) + singular
 *   - Bee              isSyncedSkillHolder
 *   - dFn→(283 equiv)  isSquatter
 *   - Xot→(283 equiv)  shouldRefuseReservedName (plugin-prompt exemption)
 *   - R="tengu_plaid_harbor" @201087884 region — gate kept (Bge)
 *   - Ao @201086878    commandDisplayName (`e.userFacingName?.()??e.name`)
 *   - ae/te/ke @210623435+  rule parse / plain match / namespace-aware match
 *   - ue @210624361    deny-rule matcher (283 expansion: skill:<pattern>
 *                      rule form + w6 wildcard + ordinary/packaging split)
 *   - Be @210624663    /^\s*skill\s*:(.*)$/s rule form
 *   - w6 @196261877    wildcard matcher
 *   - Le @210624686    deny candidate split {ordinary, packaging}
 *   - dOo/uOo/le/d/JVn @197323070+/210623435+  packaging alias expansion
 *   - De @210623435    untrusted-plugin delivery filter (≡ false in OCC)
 *   - yu               Desktop-host gate (≡ false in OCC)
 *   - ye @210624900    matchSkillRuleForPermission (fMe third candidate)
 *   - Se @210625200    buildHeldBackRuleMessage (nonholder + boundary only)
 *   - kOe/nse/v$o      loader filter + once-per-key warn + offending-path walk
 *   - BGo              names_refused telemetry (once-per-session claim)
 *   - _e               held-back-rule telemetry (once-per-kind claim)
 *
 * Reserved namespaces belong to the skills synced from a claude.ai account.
 * OCC has no synced-skills infrastructure, so every reserved name in OCC is a
 * squatter: such skills are dropped at load time, and at permission time a
 * matching Skill() allow rule is held back (forced ask, never persistable).
 *
 * OCC deviations (documented, see gap report):
 *   - reservedNamespaceOf uses NFKC + lowercase instead of the official
 *     homoglyph-skeleton normalizer (xH/ty). Case and fullwidth-colon evasion
 *     are caught; Cyrillic-lookalike homoglyphs are not.
 *   - isSyncedSkillHolder is forward-compat only: OCC has no 'syncedSkills'
 *     loadedFrom and no account-wrapper plugin, so it always returns false.
 *   - isDesktopHostSession (official yu: entrypoint ∈ {claude-desktop,
 *     claude-desktop-3p, local-agent} && !childSession) is structurally false
 *     in OCC — no Desktop entrypoint surface (official nN() → undefined).
 *   - isUntrustedPluginDelivery (official De) is structurally false in OCC:
 *     its final gate requires nN() (entrypoint) to be defined, which OCC
 *     never has, so the whole predicate short-circuits to false officially.
 *   - matchSkillRuleForPermission omits the third candidate fMe(command)
 *     (syncedSkills-only unqualifiedName lookup → never defined in OCC).
 *   - Telemetry: official p("skill_reserved_namespace", action, props) wire
 *     mapping is unresolved in the binary; OCC logs event name
 *     'skill_reserved_namespace' with {action, ...props} (analytics stubbed).
 */
import { basename, dirname } from 'path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../debug.js'

/** Official zAe @197323070: `["anthropic-skills"]` (2.1.283 reverted "claude-ai") */
export const RESERVED_NAMESPACES: readonly string[] = ['anthropic-skills']

/**
 * Official Bge (283): `x("tengu_plaid_harbor", true) !== false` — cached
 * feature value, default true (same gate pattern as
 * destructiveCommandWarning.ts's tengu_iridescent_boot).
 */
export function isPlaidHarborEnabled(): boolean {
  const gate = getFeatureValue_CACHED_MAY_BE_STALE<boolean>(
    'tengu_plaid_harbor',
    true,
  )
  return gate !== false
}

/** Official kdn @197323120: `zAe.some(n => e.startsWith(`${n}:`))` */
export function hasReservedNamespacePrefix(value: string): boolean {
  return RESERVED_NAMESPACES.some(ns => value.startsWith(`${ns}:`))
}

/**
 * Official zat (283, same body shape as 282's Yot but looping the
 * single-element zAe; simplified — see header deviations): returns the
 * reserved namespace a name belongs to, or undefined. Case-insensitive;
 * catches both the bare namespace ("anthropic-skills") and names inside it
 * ("anthropic-skills:foo").
 */
export function reservedNamespaceOf(name: string): string | undefined {
  const normalized = name.normalize('NFKC').trim().toLowerCase()
  for (const ns of RESERVED_NAMESPACES) {
    if (normalized === ns || normalized.startsWith(`${ns}:`)) {
      return ns
    }
  }
  return undefined
}

/** Official jB (283): `zat(e) !== void 0` */
export function isReservedName(name: string): boolean {
  return reservedNamespaceOf(name) !== undefined
}

/**
 * Official _Mt (283, byte-exact expansion):
 * `uses ${zAe.map(e=>`"${e}"`).join(" or ")}, the names reserved for the
 *  skills synced from your claude.ai account`
 */
export const RESERVED_NAMES_REASON_FALLBACK = `uses ${RESERVED_NAMESPACES.map(
  ns => `"${ns}"`,
).join(' or ')}, the names reserved for the skills synced from your claude.ai account`

/**
 * Official singular reason (283): first name that resolves to a reserved
 * namespace gets the singular reason; otherwise the plural fallback (_Mt).
 */
export function reservedNameReason(...names: string[]): string {
  for (const name of names) {
    const ns = reservedNamespaceOf(name)
    if (ns !== undefined) {
      return `uses "${ns}", a name reserved for the skills synced from your claude.ai account`
    }
  }
  return RESERVED_NAMES_REASON_FALLBACK
}

/** Minimal command shape consumed by the reserved-name predicates. */
export type ReservedNameCommandLike = {
  type?: string
  name: string
  source?: string
  loadedFrom?: string
  aliases?: string[]
  /** Official Le/fMe (283): prompt commands may carry an unqualified name. */
  unqualifiedName?: string | null
  pluginInfo?: {
    pluginManifest?: { name?: string }
    repository?: string
    accountSkillsWrapper?: boolean
  }
  userFacingName?: () => string
}

/** Official Ao @201086878: `e.userFacingName?.()??e.name` */
export function commandDisplayName(command: ReservedNameCommandLike): string {
  return command.userFacingName?.() ?? command.name
}

/**
 * Official Bee (283): a command legitimately holds a reserved name when it
 * was synced from the user's claude.ai account (loadedFrom ===
 * 'syncedSkills') or comes from the account-skills wrapper plugin
 * (repository 'anthropic-skills@inline' — built at runtime as
 * `${wdt}@${zd}`, with accountSkillsWrapper: true). OCC has neither —
 * always false in practice; kept forward-compatible.
 */
export function isSyncedSkillHolder(command: ReservedNameCommandLike): boolean {
  if (command.loadedFrom === 'syncedSkills') {
    return true
  }
  return (
    command.type === 'prompt' &&
    command.source === 'plugin' &&
    command.pluginInfo !== undefined &&
    command.pluginInfo.repository === 'anthropic-skills@inline' &&
    command.pluginInfo.accountSkillsWrapper === true
  )
}

/** Official dFn: `!iZ(e) && (wU(e.name) || wU(displayName))` */
export function isSquatter(command: ReservedNameCommandLike): boolean {
  return (
    !isSyncedSkillHolder(command) &&
    (isReservedName(command.name) || isReservedName(commandDisplayName(command)))
  )
}

/**
 * Official Xot: refuse (drop at load / hold back at permission time) unless
 * the command is a plugin-sourced prompt — plugin prompts are exempt (a
 * plugin legitimately named e.g. "anthropic-skills" still loads).
 */
export function shouldRefuseReservedName(
  command: ReservedNameCommandLike,
): boolean {
  return (
    !(command.type === 'prompt' && command.source === 'plugin') &&
    isSquatter(command) &&
    isPlaidHarborEnabled()
  )
}

// ---------------------------------------------------------------------------
// Loader refusal (official kOe / nse / v$o / BGo)
// ---------------------------------------------------------------------------

export type ReservedNameRefusalChange =
  | 'path'
  | 'frontmatter-name'
  | 'workflow-name'

export type ReservedNameRefusal = {
  name: string
  path?: string
  change: ReservedNameRefusalChange
}

/** Official Bm().refusedReservedNames — once-per-(path\0name\0change) session map. */
const refusedReservedNames = new Map<string, ReservedNameRefusal>()

/** Official Na().claim keys (names_refused + per-kind held-back claims). */
const reservedNamesTelemetryClaims = new Set<string>()

export function getRefusedReservedNames(): readonly ReservedNameRefusal[] {
  return [...refusedReservedNames.values()]
}

/** Test-only: clear session refusal + telemetry-claim state. */
export function resetReservedNamesSessionState_FOR_TESTING(): void {
  refusedReservedNames.clear()
  reservedNamesTelemetryClaims.clear()
}

/**
 * Official v$o: for a path-based reserved name ("a:b" from nested dirs),
 * walks up from the skill file/dir to the topmost directory that starts the
 * reserved name, so the warning points at the offending folder.
 */
export function reservedOffendingPath(filePath: string, name: string): string {
  const isSkillMd = basename(filePath).toLowerCase() === 'skill.md'
  const start = isSkillMd ? dirname(filePath) : filePath
  let current = start
  let accumulated = isSkillMd
    ? basename(current)
    : basename(current).replace(/\.md$/i, '')
  while (accumulated !== name) {
    const parent = dirname(current)
    if (parent === current || !name.endsWith(`:${accumulated}`)) {
      return start
    }
    current = parent
    accumulated = `${basename(current)}:${accumulated}`
  }
  return current
}

/**
 * Official nse (message string byte-verified @205992129 in v2.1.283):
 * `[skills] not loading ${b}${w}: that name ${reason}; ${change ===
 * "frontmatter-name" ? "change its name: line" : "rename it"}`
 * where b = `workflow "${name}"` for workflow-name, else `"${name}"`, and
 * w = ` (${path})` when a path is present. Once per `${path}\0${name}\0${change}`.
 */
export function warnReservedNameRefused(entry: ReservedNameRefusal): void {
  const key = `${entry.path ?? ''}\u0000${entry.name}\u0000${entry.change}`
  if (refusedReservedNames.has(key)) {
    return
  }
  refusedReservedNames.set(key, entry)
  const label =
    entry.change === 'workflow-name'
      ? `workflow "${entry.name}"`
      : `"${entry.name}"`
  const pathSuffix = entry.path ? ` (${entry.path})` : ''
  const reason = reservedNameReason(entry.name)
  logForDebugging(
    `[skills] not loading ${label}${pathSuffix}: that name ${reason}; ${
      entry.change === 'frontmatter-name' ? 'change its name: line' : 'rename it'
    }`,
    { level: 'warn' },
  )
}

/**
 * Official kOe: drop refused entries from a {skill, filePath} list, warning
 * once per refusal. Name-based refusals report the offending ancestor
 * directory (v$o) with change "path"; display-name-only refusals report the
 * file path with change "frontmatter-name".
 */
export function filterRefusedReservedNames<T extends ReservedNameCommandLike>(
  entries: ReadonlyArray<{ skill: T; filePath: string }>,
): Array<{ skill: T; filePath: string }> {
  return entries.filter(({ skill, filePath }) => {
    if (!shouldRefuseReservedName(skill)) {
      return true
    }
    const byPath = isReservedName(skill.name)
    warnReservedNameRefused({
      name: byPath ? skill.name : commandDisplayName(skill),
      path: byPath ? reservedOffendingPath(filePath, skill.name) : filePath,
      change: byPath ? 'path' : 'frontmatter-name',
    })
    return false
  })
}

/**
 * Official BGo: once per session (claim
 * "skill_reserved_namespace_refused"), emit names_refused with per-namespace
 * (ns_anthropic_skills) and per-change-kind (kind_path /
 * kind_frontmatter_name / kind_workflow_name) counters plus the total.
 */
export function logReservedNamesRefusedTelemetry(): void {
  const refused = getRefusedReservedNames()
  if (
    refused.length === 0 ||
    reservedNamesTelemetryClaims.has('skill_reserved_namespace_refused')
  ) {
    return
  }
  reservedNamesTelemetryClaims.add('skill_reserved_namespace_refused')
  const counters: Record<string, number> = { refused: refused.length }
  for (const { name, change } of refused) {
    const keys = [
      `ns_${(reservedNamespaceOf(name) ?? 'unknown').replaceAll('-', '_')}`,
      `kind_${change.replaceAll('-', '_')}`,
    ]
    for (const key of keys) {
      counters[key] = (counters[key] ?? 0) + 1
    }
  }
  logEvent('skill_reserved_namespace', {
    action:
      'names_refused' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...counters,
  })
}

/**
 * Official held-back-rule telemetry kinds (283). The 282-era 'renamed' kind
 * (syncedSkills formerDisplayName lookup) was removed in 283 along with the
 * claude-ai revert.
 */
export type HeldBackRuleKind = 'nonholder' | 'boundary'

/**
 * Official _e: once per session per kind (claim
 * `skill_reserved_namespace_rule_held_back_${kind}`), emit the held-back
 * allow-rule telemetry. host_prompt is false in OCC (no host-prompt
 * injection surface; official `iO() !== void 0`).
 */
export function logHeldBackRuleTelemetry(kind: HeldBackRuleKind): void {
  const claimKey = `skill_reserved_namespace_rule_held_back_${kind}`
  if (reservedNamesTelemetryClaims.has(claimKey)) {
    return
  }
  reservedNamesTelemetryClaims.add(claimKey)
  const action =
    kind === 'nonholder'
      ? 'nonholder_allow_rule'
      : 'prefix_at_namespace_boundary'
  logEvent('skill_reserved_namespace', {
    action:
      action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    interactive: !getIsNonInteractiveSession(),
    host_prompt: false,
  })
}

// ---------------------------------------------------------------------------
// Permission-rule matching (official ae / te / ke / ue / ye @210623435+)
// ---------------------------------------------------------------------------

export type ParsedSkillRule = { name: string; prefix?: string }

/**
 * Official ae: strip a leading "/", then treat a trailing ":*" or " *" as a
 * prefix wildcard → {name, prefix} (prefix = rule minus the last 2 chars).
 */
export function parseSkillRule(ruleContent: string): ParsedSkillRule {
  const stripped = ruleContent.startsWith('/')
    ? ruleContent.substring(1)
    : ruleContent
  return stripped.endsWith(':*') || stripped.endsWith(' *')
    ? { name: stripped, prefix: stripped.slice(0, -2) }
    : { name: stripped }
}

/** Official te: exact name match, or skillName starts with the rule prefix. */
export function skillRuleMatchesPlain(
  ruleContent: string,
  skillName: string,
): boolean {
  const { name, prefix } = parseSkillRule(ruleContent)
  return name === skillName || (prefix !== undefined && skillName.startsWith(prefix))
}

/**
 * Official ke: namespace-aware match. For ordinary prefixes, the skill name
 * must plain-match AND not sit in a reserved namespace. For a reserved
 * namespace prefix ("anthropic-skills"), only "ns:..." names match; for a
 * prefix inside a reserved namespace ("anthropic-skills:foo"), the exact
 * prefix or "prefix:..." names match.
 */
export function skillRuleMatchesNamespaceAware(
  ruleContent: string,
  skillName: string,
): boolean {
  const { prefix } = parseSkillRule(ruleContent)
  if (prefix === undefined) {
    return skillRuleMatchesPlain(ruleContent, skillName)
  }
  const lowered = prefix.toLowerCase()
  const isBareNamespace = RESERVED_NAMESPACES.includes(lowered)
  const isInReservedNamespace = hasReservedNamespacePrefix(lowered)
  if (!isBareNamespace && !isInReservedNamespace) {
    return (
      !hasReservedNamespacePrefix(skillName.toLowerCase()) &&
      skillRuleMatchesPlain(ruleContent, skillName)
    )
  }
  return (
    (!isBareNamespace && skillName === prefix) ||
    skillName.startsWith(`${prefix}:`)
  )
}

/**
 * Official Be @210624663: `skill:<pattern>` rule form (whitespace tolerated
 * around "skill"), matched case-sensitively with the /s flag.
 */
const SKILL_RULE_FORM = /^\s*skill\s*:(.*)$/s

/**
 * Official w6 @196261877: glob-style wildcard match — the pattern is split on
 * "*", each literal segment regex-escaped, joined with ".*", anchored, /s.
 */
export function skillRuleMatchesWildcard(
  pattern: string,
  name: string,
): boolean {
  const source = `^${pattern
    .split('*')
    .map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')}$`
  return new RegExp(source, 's').test(name)
}

/**
 * Official yu: `E() && !childSession`, where E() tests entrypoint ∈
 * {"claude-desktop","claude-desktop-3p","local-agent"}. OCC has no
 * entrypoint surface (official nN() → undefined → E() false), so this is
 * structurally always false; kept as the forward-compat seam (same pattern
 * as isSyncedSkillHolder).
 */
export function isDesktopHostSession(): boolean {
  return false
}

/**
 * Official De @210623435: true when a plugin-delivered skill comes from an
 * untrusted repository AND the session runs inside a Desktop host (final
 * gate `nN() !== void 0 && Ne.has(nN())`). OCC has no entrypoint surface, so
 * the official predicate short-circuits to false here; kept as the
 * forward-compat seam.
 */
export function isUntrustedPluginDelivery(
  _command: ReservedNameCommandLike,
): boolean {
  return false
}

/**
 * Official d @197323070 region: unpack a self-namespaced name ("foo:foo" →
 * "foo") unless the namespace is reserved. Any other shape → undefined.
 */
function unpackSelfNamespace(name: string): string | undefined {
  const idx = name.indexOf(':')
  if (idx <= 0) {
    return undefined
  }
  const head = name.slice(0, idx)
  const rest = name.slice(idx + 1)
  return rest === head && !RESERVED_NAMESPACES.includes(head)
    ? rest
    : undefined
}

/**
 * Official JVn: map a packaging alias to its reserved-namespace forms.
 * "foo:foo" → "anthropic-skills:foo"; "anthropic-skills:foo" → "foo:foo";
 * anything else → undefined.
 */
function toPackagingAlias(name: string): string | undefined {
  const unpacked = unpackSelfNamespace(name)
  if (unpacked !== undefined) {
    return `anthropic-skills:${unpacked}`
  }
  if (!name.startsWith('anthropic-skills:')) {
    return undefined
  }
  const short = name.slice('anthropic-skills:'.length)
  return short && !short.includes(':') ? `${short}:${short}` : undefined
}

/**
 * Official dOo: for a plugin-delivered skill whose name (or display name) is
 * self-namespaced ("foo:foo"), the packaging aliases a Desktop plugin
 * delivery could be denied under: the reserved form, the bare short name,
 * every alias in reserved form, and (when the registered tail differs) the
 * tail in both forms.
 */
function pluginPackagingAliases(command: ReservedNameCommandLike): string[] {
  if (command.loadedFrom !== 'plugin') {
    return []
  }
  const short =
    unpackSelfNamespace(command.name) ??
    unpackSelfNamespace(commandDisplayName(command))
  if (short === undefined) {
    return []
  }
  const tail = command.name.slice(command.name.indexOf(':') + 1)
  return [
    // Official first entry is JVn(`${short}:${short}`) — provably
    // `anthropic-skills:${short}` (short is never a reserved namespace).
    `anthropic-skills:${short}`,
    short,
    ...(command.aliases ?? [])
      .filter(alias => alias !== short)
      .map(alias => `anthropic-skills:${alias}`),
    ...(tail !== short && !tail.includes(':')
      ? [`anthropic-skills:${tail}`, tail]
      : []),
  ]
}

/**
 * Official uOo: for a synced/plugin skill already inside the reserved
 * namespace, the self-namespaced form ("foo:foo") plus — when the display
 * name is a different reserved-namespace name — its packaging forms.
 */
function syncedPackagingAliases(command: ReservedNameCommandLike): string[] {
  if (
    (command.loadedFrom !== 'syncedSkills' &&
      command.loadedFrom !== 'plugin') ||
    !command.name.startsWith('anthropic-skills:')
  ) {
    return []
  }
  const short = command.name.slice('anthropic-skills:'.length)
  const display = commandDisplayName(command)
  const displayShort = display.startsWith('anthropic-skills:')
    ? display.slice('anthropic-skills:'.length)
    : undefined
  if (!short || short.includes(':')) {
    return []
  }
  // Official first entry is JVn(name) — provably `${short}:${short}` here.
  return [
    `${short}:${short}`,
    ...(displayShort !== undefined &&
    displayShort !== short &&
    !displayShort.includes(':')
      ? [
          `${displayShort}:${displayShort}`,
          `${displayShort}:${short}`,
          displayShort,
        ]
      : []),
  ]
}

/**
 * Official le: packaging alias candidates. The dOo half is suppressed for
 * untrusted-plugin deliveries (De) — a filter that is structurally false in
 * OCC (see isUntrustedPluginDelivery).
 */
function packagingAliases(command: ReservedNameCommandLike): string[] {
  const pluginAliases = pluginPackagingAliases(command)
  return [
    ...(pluginAliases.length > 0 && isUntrustedPluginDelivery(command)
      ? []
      : pluginAliases),
    ...syncedPackagingAliases(command),
  ]
}

/**
 * Official Le @210624686: split deny-match candidates into ordinary names
 * (invoked name, registered name, display name, aliases, and a prompt's
 * unqualifiedName) and packaging aliases (le).
 */
export function denyMatchCandidates(
  skillName: string,
  command?: ReservedNameCommandLike,
): { ordinary: string[]; packaging: string[] } {
  if (command === undefined) {
    return { ordinary: [skillName], packaging: [] }
  }
  return {
    ordinary: [
      skillName,
      command.name,
      commandDisplayName(command),
      ...(command.aliases ?? []),
      ...(command.type === 'prompt' && command.unqualifiedName != null
        ? [command.unqualifiedName]
        : []),
    ],
    packaging: packagingAliases(command),
  }
}

/**
 * Official ue @210624361 (283 expansion): deny rules match against the
 * ordinary/packaging candidate split. A `skill:<pattern>` rule form matches
 * candidates via the w6 wildcard matcher (packaging candidates only for
 * wildcard-free patterns, unless on a Desktop host). Otherwise, plain rules
 * match ordinary candidates directly; packaging candidates additionally
 * require the rule to be prefix-free or its prefix to equal the candidate
 * (Desktop hosts exempt).
 */
export function skillDenyRuleMatches(
  ruleContent: string,
  skillName: string,
  command?: ReservedNameCommandLike,
): boolean {
  const { ordinary, packaging } = denyMatchCandidates(skillName, command)
  const skillForm = SKILL_RULE_FORM.exec(ruleContent)
  if (skillForm !== null) {
    const pattern = skillForm[1].trim()
    if (
      ordinary.some(candidate =>
        skillRuleMatchesWildcard(pattern, candidate),
      ) ||
      ((!pattern.includes('*') || isDesktopHostSession()) &&
        packaging.some(candidate =>
          skillRuleMatchesWildcard(pattern, candidate),
        ))
    ) {
      return true
    }
  }
  return (
    ordinary.some(candidate =>
      skillRuleMatchesPlain(ruleContent, candidate),
    ) ||
    packaging.some(candidate => {
      if (!skillRuleMatchesPlain(ruleContent, candidate)) {
        return false
      }
      const { prefix } = parseSkillRule(ruleContent)
      return (
        prefix === undefined || prefix === candidate || isDesktopHostSession()
      )
    })
  )
}

export type SkillRuleMatchOutcome =
  | 'allow'
  | 'no-match'
  | 'held-back-nonholder'
  | 'held-back-boundary'

/**
 * Official ye @210624900: classify an allow rule against a skill invocation.
 * Candidates are the invoked name plus the command's registered name (the
 * official third candidate, fMe(command) @203646278, is syncedSkills-only →
 * never defined in OCC). With the gate off, plain matching decides. With it
 * on, a rule only allows when it namespace-aware-matches a candidate that is
 * either held by a synced skill or not reserved; a plain-matching rule
 * against a reserved name is held back (nonholder when it also
 * namespace-aware-matches, boundary otherwise).
 */
export function matchSkillRuleForPermission(
  ruleContent: string,
  skillName: string,
  command?: ReservedNameCommandLike,
): SkillRuleMatchOutcome {
  const candidates = [
    skillName,
    ...(command !== undefined ? [command.name] : []),
  ]
  const plain = candidates.some(candidate =>
    skillRuleMatchesPlain(ruleContent, candidate),
  )
  if (!isPlaidHarborEnabled()) {
    return plain ? 'allow' : 'no-match'
  }
  const isHolder = command !== undefined && isSyncedSkillHolder(command)
  const namespaceAware = candidates.some(candidate =>
    skillRuleMatchesNamespaceAware(ruleContent, candidate),
  )
  if (
    candidates.some(
      candidate =>
        skillRuleMatchesNamespaceAware(ruleContent, candidate) &&
        (isHolder || !isReservedName(candidate)),
    )
  ) {
    return 'allow'
  }
  if (!plain) {
    return 'no-match'
  }
  return namespaceAware ? 'held-back-nonholder' : 'held-back-boundary'
}

// ---------------------------------------------------------------------------
// Messages (official Se @210625200 region + squatter ask @210646440)
// ---------------------------------------------------------------------------

export type HeldBackMessageOptions =
  | { kind: 'nonholder'; pluginName?: string }
  | { kind: 'boundary' }

/**
 * Official Se (byte-exact, nonholder + boundary kinds; 283 removed the
 * 282-era 'renamed' kind together with the claude-ai revert).
 */
export function buildHeldBackRuleMessage(
  ruleContent: string,
  skillName: string,
  options: HeldBackMessageOptions,
): string {
  const { prefix } = parseSkillRule(ruleContent)
  const loweredPrefix = prefix?.toLowerCase()
  const ruleTargetsReserved =
    loweredPrefix !== undefined
      ? RESERVED_NAMESPACES.includes(loweredPrefix) ||
        hasReservedNamespacePrefix(loweredPrefix)
      : hasReservedNamespacePrefix(ruleContent.toLowerCase())
  const ns = reservedNamespaceOf(skillName) ?? skillName
  const base = ruleTargetsReserved
    ? `Skill(${ruleContent}) only covers skills synced from your claude.ai account.`
    : `Skill(${ruleContent}) does not cover "${ns}:" names, which are reserved for skills synced from your claude.ai account.`
  switch (options.kind) {
    case 'nonholder':
      return `${base} ${skillName} ${
        options.pluginName !== undefined
          ? `comes from the plugin "${options.pluginName}"`
          : 'is not synced'
      }, so no rule for that name can pre-approve it; it needs approval each time.`
    case 'boundary':
      return loweredPrefix !== undefined &&
        RESERVED_NAMESPACES.includes(loweredPrefix)
        ? `Skill(${ruleContent}) only covers names starting with "${prefix}:". Add Skill(${skillName}) to allow ${skillName} without asking.`
        : ruleTargetsReserved
          ? `Skill(${ruleContent}) only covers ${prefix} and names starting with "${prefix}:". Add Skill(${skillName}) to allow ${skillName} without asking.`
          : `${base} Add Skill(${skillName}) to allow ${skillName} without asking.`
  }
}

/**
 * Official squatter ask message: `Execute skill: ${name}${reason ? ` — ${reason}` : ""}`
 * (em dash U+2014, byte-verified @210646440 in v2.1.283).
 */
export function buildSquatterAskMessage(
  skillName: string,
  reason?: string,
): string {
  return `Execute skill: ${skillName}${reason ? ` — ${reason}` : ''}`
}

// ---------------------------------------------------------------------------
// MCP server-name gates (official skills funnel + prompts filter @229358728
// region in v2.1.283)
// ---------------------------------------------------------------------------

/** Official skills-funnel gate: `Bge() && jB(`${vn(serverName)}:`)`. */
export function isReservedMcpServerName(normalizedServerName: string): boolean {
  return (
    isPlaidHarborEnabled() && isReservedName(`${normalizedServerName}:`)
  )
}

/**
 * Official skills-funnel message (byte-exact):
 * `Skills not loaded: the server name ${reason(`${vn(name)}:`)}. Rename the
 *  server in your MCP configuration to load its skills and prompts; its tools
 *  are unaffected.`
 */
export function reservedMcpServerSkillsMessage(
  normalizedServerName: string,
): string {
  return `Skills not loaded: the server name ${reservedNameReason(
    `${normalizedServerName}:`,
  )}. Rename the server in your MCP configuration to load its skills and prompts; its tools are unaffected.`
}

/**
 * Official per-prompt message (byte-exact @229358728 region; always the
 * plural fallback _Mt):
 * `Prompt '${commandName}' not listed: the server name ${_Mt}. Rename the
 *  server in your MCP configuration to list its prompts.`
 */
export function reservedMcpPromptMessage(promptCommandName: string): string {
  return `Prompt '${promptCommandName}' not listed: the server name ${RESERVED_NAMES_REASON_FALLBACK}. Rename the server in your MCP configuration to list its prompts.`
}
