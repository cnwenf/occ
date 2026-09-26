/**
 * CC 2.1.283 anthropic-skills reserved-namespace hardening.
 *
 * 2.1.283 REVERTED the 2.1.282 reservation of the `claude-ai` name (official
 * changelog: skills, commands, workflows and MCP servers' skills and prompts
 * so named load again, and `Skill(claude-ai:*)` rules are ordinary prefix
 * rules). Byte-verified against the official v2.1.283 linux-x64 ELF: the
 * RESERVED_NAMESPACES array is the single-element `zAe=["anthropic-skills"]`
 * (@197323150 region), `startsWith("claude-ai:")` has 0 code hits, and the
 * only `claude-ai:` string in the binary is the embedded changelog text.
 *
 * Byte-exact port of the official minified cluster (v2.1.283 linux-x64 ELF):
 *   - zAe @197323150   RESERVED_NAMESPACES (single-element in 283)
 *   - wdt              "anthropic-skills" namespace constant
 *   - vdt              qualifyAnthropicSkillsName
 *   - z$               unqualifyAnthropicSkillsName
 *   - d                selfQualifiedSkillName ("X:X" extraction)
 *   - JVn              packagingAliasOf
 *   - dOo              pluginPackagingNames
 *   - uOo              syncedPackagingNames
 *   - le               packagingNamesFor (dOo + uOo)
 *   - De               plugin-delivery exemption gate — STAGED, see deviations
 *   - w6               globPatternMatches ("*" wildcard, /s)
 *   - Be               SKILL_LITERAL_RULE_RE  /^\s*skill\s*:(.*)$/s
 *   - Le               ordinary/packaging name lists for the deny matcher
 *   - ue               deny-rule matcher
 *   - fMe              renamedCandidate (syncedSkills-only)
 *   - ye               allow-rule classifier (matchSkillRuleForPermission)
 *   - _Mt/zat/ULe      reason fallback / reservedNamespaceOf / reservedNameReason
 *   - Bee/RWn          isSyncedSkillHolder / isSquatter
 *   - Bge              isPlaidHarborEnabled (tengu_plaid_harbor, default true)
 *   - kOe/nse/v$o @203984300  loader filter + once-per-key warn + offending-path walk
 *   - BGo @204366800   names_refused telemetry (once-per-session claim)
 *   - _e @208588047    held-back-rule telemetry (once-per-kind claim)
 *
 * Reserved namespaces belong to the skills synced from a claude.ai account.
 * OCC has no synced-skills infrastructure, so every reserved name in OCC is a
 * squatter: such skills are dropped at load time, and at permission time a
 * matching Skill() allow rule is held back (forced ask, never persistable).
 *
 * OCC deviations (documented, see gap report):
 *   - reservedNamespaceOf uses NFKC + lowercase instead of the official
 *     homoglyph-skeleton normalizer (282 xH/ty, 283 _H/ez). Case and
 *     fullwidth-colon evasion are caught; Cyrillic-lookalike homoglyphs are
 *     not.
 *   - isSyncedSkillHolder is forward-compat only: OCC has no 'syncedSkills'
 *     loadedFrom and no account-wrapper plugin, so it always returns false.
 *   - The deny matcher (ue) ports the packaging list WITHOUT the De
 *     exemption gate. De's dependency chain (org-skeleton pP/lct/kJ/Jq sets,
 *     plugin-cache-kind L()===I, entrypoint set Ne) spans unrecovered
 *     subsystems; omitting it makes OCC include dOo packaging names for ALL
 *     plugin skills where official CLI exempts third-party-org plugins — a
 *     fail-closed over-block of deny matching in the narrow
 *     self-qualified-name ("X:X") plugin case. yu() (desktop-app gate) is
 *     ≡ false in OCC, likewise fail-closed (wildcard "skill:" rules never
 *     glob-match packaging names; prefix-constrained te matches only). The
 *     ordinary list honors the prompt unqualifiedName candidate when the
 *     field is present (OCC prompts don't populate it today).
 *   - renamedCandidate (fMe) is syncedSkills-only → always undefined in OCC;
 *     kept for parity. The 'renamed' held-back kind stays unreachable and is
 *     not wired into checkPermissions; the telemetry action mapping keeps the
 *     branch for parity.
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

/**
 * Official zAe @197323150 (2.1.283): `["anthropic-skills"]` — the 2.1.282
 * second element "claude-ai" was REVERTED upstream (byte-verified: 0 code
 * hits for `claude-ai:` in the 283 ELF; the alias interconversion from 282 is
 * gone, replaced by the one-way vdt/z$ qualify/unqualify pair below).
 */
export const RESERVED_NAMESPACES: readonly string[] = ['anthropic-skills']

/**
 * Official Bge (282 Nfe): `x("tengu_plaid_harbor", true) !== false` — cached feature
 * value, default true (same gate pattern as destructiveCommandWarning.ts's
 * tengu_iridescent_boot).
 */
export function isPlaidHarborEnabled(): boolean {
  const gate = getFeatureValue_CACHED_MAY_BE_STALE<boolean>(
    'tengu_plaid_harbor',
    true,
  )
  return gate !== false
}

/** Official kdn (282 Fae): `zAe.some(t => e.startsWith(`${t}:`))` */
export function hasReservedNamespacePrefix(value: string): boolean {
  return RESERVED_NAMESPACES.some(ns => value.startsWith(`${ns}:`))
}

/**
 * Official zat (282 Yot) (simplified — see header deviations): returns the
 * reserved namespace a name belongs to, or undefined. Case-insensitive;
 * catches both the bare namespace ("anthropic-skills") and names
 * inside it ("anthropic-skills:foo").
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

/** Official jB (282 wU): `Yot(e) !== void 0` */
export function isReservedName(name: string): boolean {
  return reservedNamespaceOf(name) !== undefined
}

/**
 * Official _Mt (282 WIt) (byte-exact expansion):
 * `uses ${zAe.map(e=>`"${e}"`).join(" or ")}, the names reserved for the
 *  skills synced from your claude.ai account` — single element in 283, so the
 * " or " join no longer survives into the string.
 */
export const RESERVED_NAMES_REASON_FALLBACK = `uses ${RESERVED_NAMESPACES.map(
  ns => `"${ns}"`,
).join(' or ')}, the names reserved for the skills synced from your claude.ai account`

/**
 * Official ULe (282 AMe): first name that resolves to a reserved namespace
 * gets the singular reason; otherwise the fallback (_Mt).
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
  /**
   * Official prompt-only unqualified name (283 Le ordinary-list candidate +
   * fMe renamed candidate). OCC prompts don't populate it today; the field
   * is honored when present (forward-compat parity).
   */
  unqualifiedName?: string
  pluginInfo?: {
    pluginManifest?: { name?: string }
    repository?: string
    accountSkillsWrapper?: boolean
  }
  userFacingName?: () => string
}

/** Official Ao (282 Yo) display-name resolution. */
export function commandDisplayName(command: ReservedNameCommandLike): string {
  return command.userFacingName?.() ?? command.name
}

/**
 * Official Bee (282 iZ): a command legitimately holds a reserved name when it was
 * synced from the user's claude.ai account (loadedFrom === 'syncedSkills') or
 * comes from the account-skills wrapper plugin (repository
 * 'anthropic-skills@inline' with accountSkillsWrapper: true). OCC has
 * neither — always false in practice; kept forward-compatible.
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

/** Official RWn (282 dFn): `!Bee(e) && (jB(e.name) || jB(Ao(e)))` */
export function isSquatter(command: ReservedNameCommandLike): boolean {
  return (
    !isSyncedSkillHolder(command) &&
    (isReservedName(command.name) || isReservedName(commandDisplayName(command)))
  )
}

/**
 * Official Xot-equivalent (283 gate inline): refuse (drop at load / hold back at permission time) unless
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
 * Official nse @203984600 (byte-exact message):
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
 * Official BGo @204366800: once per session (claim
 * "skill_reserved_namespace_refused"), emit names_refused with per-namespace
 * (ns_anthropic_skills / ns_claude_ai) and per-change-kind (kind_path /
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

/** Official _e @208588047 held-back-rule telemetry kinds. */
export type HeldBackRuleKind = 'nonholder' | 'boundary' | 'renamed'

/**
 * Official qe (283; 282 _e): once per session per kind (claim
 * `skill_reserved_namespace_rule_held_back_${kind}`), emit the held-back
 * allow-rule telemetry. The 283 action map is BINARY —
 * `e==="nonholder"?"nonholder_allow_rule":"prefix_at_namespace_boundary"`
 * (byte-verified @210630306); 282's third action `renamed_allow_rule` was
 * REMOVED (282: 2 string hits → 283: 0), so any non-nonholder kind emits
 * `prefix_at_namespace_boundary`. host_prompt is false in OCC (no host-prompt
 * injection surface; official `eM() !== void 0`).
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
// Permission-rule matching (official ae / te / ke / ue / ye + packaging le)
// ---------------------------------------------------------------------------

export type ParsedSkillRule = { name: string; prefix?: string }

/**
 * Official ae (282 le): strip a leading "/", then treat a trailing ":*" or " *" as a
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

/** Official te (282 W): exact name match, or skillName starts with the rule prefix. */
export function skillRuleMatchesPlain(
  ruleContent: string,
  skillName: string,
): boolean {
  const { name, prefix } = parseSkillRule(ruleContent)
  return name === skillName || (prefix !== undefined && skillName.startsWith(prefix))
}

/**
 * Official ke (282 ae): namespace-aware match. For ordinary prefixes, the skill name
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

// ---------------------------------------------------------------------------
// 2.1.283 packaging-name machinery (official vdt / z$ / d / JVn / dOo / uOo /
// le / w6 / Be / Le / ue). "Packaging names" are the extra identities a skill
// carries when it is delivered as a plugin or synced from a claude.ai account:
// `Skill(anthropic-skills:<name>)` deny rules now also block a plugin-delivered
// skill under those names, and `Skill(skill:<name>)` deny rules match via glob.
// ---------------------------------------------------------------------------

/** The reserved namespace constant (official wdt). */
export const ANTHROPIC_SKILLS_NAMESPACE = 'anthropic-skills'

/** Official vdt: qualify a bare skill name into the reserved namespace. */
export function qualifyAnthropicSkillsName(name: string): string {
  return name.startsWith(`${ANTHROPIC_SKILLS_NAMESPACE}:`)
    ? name
    : `${ANTHROPIC_SKILLS_NAMESPACE}:${name}`
}

/** Official z$: strip the reserved-namespace qualifier (slice(17)). */
export function unqualifyAnthropicSkillsName(name: string): string {
  return name.startsWith(`${ANTHROPIC_SKILLS_NAMESPACE}:`)
    ? name.slice(ANTHROPIC_SKILLS_NAMESPACE.length + 1)
    : name
}

/**
 * Official d: extract the skill name from the self-qualified "X:X" form.
 * `n=e.indexOf(":"); if(n<=0)return; t=e.slice(0,n); r=e.slice(n+1);
 * return r===t && !zAe.includes(t) ? r : void 0`
 */
export function selfQualifiedSkillName(name: string): string | undefined {
  const idx = name.indexOf(':')
  if (idx <= 0) {
    return undefined
  }
  const head = name.slice(0, idx)
  const tail = name.slice(idx + 1)
  return tail === head && !RESERVED_NAMESPACES.includes(head)
    ? tail
    : undefined
}

/**
 * Official JVn: the "X:X" ↔ "anthropic-skills:X" packaging alias.
 * `d(e)!==void 0` → qualify it; else a reserved-qualified name with a simple
 * tail ("anthropic-skills:X", no further colon) → the self-qualified "X:X".
 */
export function packagingAliasOf(name: string): string | undefined {
  const self = selfQualifiedSkillName(name)
  if (self !== undefined) {
    return qualifyAnthropicSkillsName(self)
  }
  if (!name.startsWith(`${ANTHROPIC_SKILLS_NAMESPACE}:`)) {
    return undefined
  }
  const tail = unqualifyAnthropicSkillsName(name)
  return tail && !tail.includes(':') ? `${tail}:${tail}` : undefined
}

/**
 * Official dOo: packaging names for a PLUGIN-delivered skill. Empty unless
 * loadedFrom === "plugin" AND either the registered name or the display name
 * is self-qualified ("X:X"). Returns the qualified alias, the bare name, the
 * qualified aliases, and (for "P:X" plugin names whose tail is the extracted
 * name) the qualified/bare tail.
 */
export function pluginPackagingNames(
  command: ReservedNameCommandLike,
): string[] {
  if (command.loadedFrom !== 'plugin') {
    return []
  }
  const extracted =
    selfQualifiedSkillName(command.name) ??
    selfQualifiedSkillName(commandDisplayName(command))
  if (extracted === undefined) {
    return []
  }
  const tail = command.name.slice(command.name.indexOf(':') + 1)
  return [
    packagingAliasOf(`${extracted}:${extracted}`) as string,
    extracted,
    ...(command.aliases ?? [])
      .filter(alias => alias !== extracted)
      .map(alias => qualifyAnthropicSkillsName(alias)),
    ...(tail !== extracted && !tail.includes(':')
      ? [qualifyAnthropicSkillsName(tail), tail]
      : []),
  ]
}

/**
 * Official uOo: packaging names for a synced/plugin skill already carrying a
 * reserved-qualified name — adds the self-qualified alias and, when the
 * display name is a DIFFERENT reserved-qualified name, its "R:R"/"R:N"/bare
 * variants.
 */
export function syncedPackagingNames(
  command: ReservedNameCommandLike,
): string[] {
  if (
    (command.loadedFrom !== 'syncedSkills' &&
      command.loadedFrom !== 'plugin') ||
    !command.name.startsWith(`${ANTHROPIC_SKILLS_NAMESPACE}:`)
  ) {
    return []
  }
  const name = unqualifyAnthropicSkillsName(command.name)
  const display = commandDisplayName(command)
  const displayTail = display.startsWith(`${ANTHROPIC_SKILLS_NAMESPACE}:`)
    ? unqualifyAnthropicSkillsName(display)
    : undefined
  if (!name || name.includes(':')) {
    return []
  }
  const alias = packagingAliasOf(command.name)
  return [
    ...(alias !== undefined ? [alias] : []),
    ...(displayTail !== undefined &&
    displayTail !== name &&
    !displayTail.includes(':')
      ? [`${displayTail}:${displayTail}`, `${displayTail}:${name}`, displayTail]
      : []),
  ]
}

/**
 * Official le: `[...dOo-names, ...uOo-names]`. The official gates the dOo
 * half behind De (CLI + third-party-org plugin exemption); De is STAGED in
 * OCC — see the header deviations (omitting it over-blocks deny matching,
 * fail-closed).
 */
export function packagingNamesFor(command: ReservedNameCommandLike): string[] {
  return [...pluginPackagingNames(command), ...syncedPackagingNames(command)]
}

/**
 * Official w6: glob match — escape regex metacharacters, turn "*" into ".*",
 * anchor, /s flag.
 */
export function globPatternMatches(pattern: string, value: string): boolean {
  return new RegExp(
    `^${pattern
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    's',
  ).test(value)
}

/** Official Be: rule content that literally starts with "skill:". */
const SKILL_LITERAL_RULE_RE = /^\s*skill\s*:(.*)$/s

/**
 * Official fMe: the renamed candidate for the allow-rule classifier —
 * syncedSkills-only (prompt + loadedFrom syncedSkills + unqualifiedName in
 * aliases) → always undefined in OCC; kept for parity.
 */
export function renamedCandidate(
  command: ReservedNameCommandLike | undefined,
): string | undefined {
  return command !== undefined &&
    command.type === 'prompt' &&
    command.loadedFrom === 'syncedSkills' &&
    command.unqualifiedName != null &&
    (command.aliases?.includes(command.unqualifiedName) ?? false)
    ? command.unqualifiedName
    : undefined
}

/**
 * Official Le: the ordinary-name list for the deny matcher — invoked name,
 * registered name, display name, aliases, and (prompt-only) unqualifiedName.
 */
export function denyMatchOrdinaryNames(
  invokedName: string,
  command?: ReservedNameCommandLike,
): string[] {
  if (command === undefined) {
    return [invokedName]
  }
  return [
    invokedName,
    command.name,
    commandDisplayName(command),
    ...(command.aliases ?? []),
    ...(command.type === 'prompt' && command.unqualifiedName != null
      ? [command.unqualifiedName]
      : []),
  ]
}

/**
 * Official ue (2.1.283; 282 de subset superseded): deny-rule matcher.
 * A literal `skill:X` rule glob-matches (w6) any ordinary name, and — when X
 * has no "*" (official widens with yu(), the desktop-app gate ≡ false in OCC)
 * — any packaging name. Any other rule plain-matches (te) the ordinary names,
 * or a packaging name when the rule is exact or its prefix IS that packaging
 * name (yu() ≡ false).
 */
export function skillDenyRuleMatches(
  ruleContent: string,
  skillName: string,
  command?: ReservedNameCommandLike,
): boolean {
  const ordinary = denyMatchOrdinaryNames(skillName, command)
  const packaging =
    command !== undefined ? packagingNamesFor(command) : []
  const literal = SKILL_LITERAL_RULE_RE.exec(ruleContent)
  if (literal !== null) {
    const target = literal[1].trim()
    if (
      ordinary.some(name => globPatternMatches(target, name)) ||
      (!target.includes('*') &&
        packaging.some(name => globPatternMatches(target, name)))
    ) {
      return true
    }
  }
  const { prefix } = parseSkillRule(ruleContent)
  return (
    ordinary.some(name => skillRuleMatchesPlain(ruleContent, name)) ||
    packaging.some(
      name =>
        skillRuleMatchesPlain(ruleContent, name) &&
        (prefix === undefined || prefix === name),
    )
  )
}

export type SkillRuleMatchOutcome =
  | 'allow'
  | 'no-match'
  | 'held-back-nonholder'
  | 'held-back-boundary'

/**
 * Official ye (282 ke): classify an allow rule against a skill invocation.
 * Candidates are the invoked name, the command's registered name, and the
 * official third candidate fMe(command) — the syncedSkills-only renamed
 * lookup, always undefined in OCC (parity kept). With the gate off, plain
 * matching decides. With it on, a rule only allows when it
 * namespace-aware-matches a candidate that is either held by a synced skill
 * or not reserved; a plain-matching rule against a reserved name is held
 * back (nonholder when it also namespace-aware-matches, boundary otherwise).
 */
export function matchSkillRuleForPermission(
  ruleContent: string,
  skillName: string,
  command?: ReservedNameCommandLike,
): SkillRuleMatchOutcome {
  const renamed = renamedCandidate(command)
  const candidates = [
    skillName,
    ...(command !== undefined ? [command.name] : []),
    ...(renamed !== undefined ? [renamed] : []),
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
// Messages (official ue @208584171 + squatter ask)
// ---------------------------------------------------------------------------

export type HeldBackMessageOptions =
  | { kind: 'nonholder'; pluginName?: string }
  | { kind: 'boundary' }

/**
 * Official Se (282 ue) (byte-exact, nonholder + boundary kinds; the 'renamed' kind is
 * syncedSkills-only and unreachable in OCC).
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
 * (em dash U+2014, byte-verified @208604766).
 */
export function buildSquatterAskMessage(
  skillName: string,
  reason?: string,
): string {
  return `Execute skill: ${skillName}${reason ? ` — ${reason}` : ''}`
}

// ---------------------------------------------------------------------------
// MCP server-name gates (official skills funnel @228602466 + prompts filter)
// ---------------------------------------------------------------------------

/** Official skills-funnel gate: `Bge() && jB(`${vn(serverName)}:`)`. */
export function isReservedMcpServerName(normalizedServerName: string): boolean {
  return (
    isPlaidHarborEnabled() && isReservedName(`${normalizedServerName}:`)
  )
}

/**
 * Official skills-funnel message (byte-exact):
 * `Skills not loaded: the server name ${AMe(`${vn(name)}:`)}. Rename the
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
 * Official per-prompt message (byte-exact; always the fallback _Mt):
 * `Prompt '${commandName}' not listed: the server name ${_Mt}. Rename the
 *  server in your MCP configuration to list its prompts.`
 */
export function reservedMcpPromptMessage(promptCommandName: string): string {
  return `Prompt '${promptCommandName}' not listed: the server name ${RESERVED_NAMES_REASON_FALLBACK}. Rename the server in your MCP configuration to list its prompts.`
}
