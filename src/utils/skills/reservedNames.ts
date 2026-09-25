/**
 * CC 2.1.282 anthropic-skills / claude-ai reserved-namespace hardening.
 *
 * Byte-exact port of the official minified cluster (v2.1.282 linux-x64 ELF):
 *   - ITe @195424850   RESERVED_NAMESPACES
 *   - Fae @195425105   hasReservedNamespacePrefix
 *   - Yot @199173460   reservedNamespaceOf
 *   - wU               isReservedName
 *   - AMe @199173767   reservedNameReason (singular) + WIt @199173200 fallback (plural)
 *   - iZ               isSyncedSkillHolder
 *   - dFn              isSquatter
 *   - Xot              shouldRefuseReservedName (plugin-prompt exemption)
 *   - Nfe              isPlaidHarborEnabled (tengu_plaid_harbor, default true)
 *   - le/W/ae/ke @208582600+  rule parse / plain match / namespace-aware match / classify
 *   - de               deny-rule matcher (OCC subset — see deviations)
 *   - ue @208584171    buildHeldBackRuleMessage (nonholder + boundary; renamed skipped)
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
 *     homoglyph-skeleton normalizer (xH/ty). Case and fullwidth-colon evasion
 *     are caught; Cyrillic-lookalike homoglyphs are not.
 *   - isSyncedSkillHolder is forward-compat only: OCC has no 'syncedSkills'
 *     loadedFrom and no account-wrapper plugin, so it always returns false.
 *   - The deny matcher (de) omits official fields OCC commands don't carry
 *     (unqualifiedName, formerDisplayName, bln() alias expansion).
 *   - 'renamed' held-back kind (ye, syncedSkills formerName lookup) is
 *     unreachable in OCC and not ported into checkPermissions; the telemetry
 *     action mapping keeps the branch for parity.
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

/** Official ITe @195424850: `["anthropic-skills","claude-ai"]` */
export const RESERVED_NAMESPACES: readonly string[] = [
  'anthropic-skills',
  'claude-ai',
]

/**
 * Official Nfe: `x("tengu_plaid_harbor", true) !== false` — cached feature
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

/** Official Fae @195425105: `ITe.some(t => e.startsWith(`${t}:`))` */
export function hasReservedNamespacePrefix(value: string): boolean {
  return RESERVED_NAMESPACES.some(ns => value.startsWith(`${ns}:`))
}

/**
 * Official Yot @199173460 (simplified — see header deviations): returns the
 * reserved namespace a name belongs to, or undefined. Case-insensitive;
 * catches both the bare namespace ("claude-ai") and names inside it
 * ("claude-ai:foo").
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

/** Official wU: `Yot(e) !== void 0` */
export function isReservedName(name: string): boolean {
  return reservedNamespaceOf(name) !== undefined
}

/**
 * Official WIt @199173200 (byte-exact expansion):
 * `uses ${ITe.map(e=>`"${e}"`).join(" or ")}, the names reserved for the
 *  skills synced from your claude.ai account`
 */
export const RESERVED_NAMES_REASON_FALLBACK = `uses ${RESERVED_NAMESPACES.map(
  ns => `"${ns}"`,
).join(' or ')}, the names reserved for the skills synced from your claude.ai account`

/**
 * Official AMe @199173767: first name that resolves to a reserved namespace
 * gets the singular reason; otherwise the plural fallback (WIt).
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
  pluginInfo?: {
    pluginManifest?: { name?: string }
    repository?: string
    accountSkillsWrapper?: boolean
  }
  userFacingName?: () => string
}

/** Official Yo-in-de / kOe display-name resolution. */
export function commandDisplayName(command: ReservedNameCommandLike): string {
  return command.userFacingName?.() ?? command.name
}

/**
 * Official iZ: a command legitimately holds a reserved name when it was
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
      : kind === 'boundary'
        ? 'prefix_at_namespace_boundary'
        : 'renamed_allow_rule'
  logEvent('skill_reserved_namespace', {
    action:
      action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    interactive: !getIsNonInteractiveSession(),
    host_prompt: false,
  })
}

// ---------------------------------------------------------------------------
// Permission-rule matching (official le / W / ae / de / ke)
// ---------------------------------------------------------------------------

export type ParsedSkillRule = { name: string; prefix?: string }

/**
 * Official le: strip a leading "/", then treat a trailing ":*" or " *" as a
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

/** Official W: exact name match, or skillName starts with the rule prefix. */
export function skillRuleMatchesPlain(
  ruleContent: string,
  skillName: string,
): boolean {
  const { name, prefix } = parseSkillRule(ruleContent)
  return name === skillName || (prefix !== undefined && skillName.startsWith(prefix))
}

/**
 * Official ae: namespace-aware match. For ordinary prefixes, the skill name
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
 * Official de (OCC subset): deny rules match the invoked name, the command's
 * registered name, its display name, or any alias.
 */
export function skillDenyRuleMatches(
  ruleContent: string,
  skillName: string,
  command?: ReservedNameCommandLike,
): boolean {
  if (skillRuleMatchesPlain(ruleContent, skillName)) {
    return true
  }
  if (command === undefined) {
    return false
  }
  return (
    skillRuleMatchesPlain(ruleContent, command.name) ||
    skillRuleMatchesPlain(ruleContent, commandDisplayName(command)) ||
    (command.aliases?.some(alias =>
      skillRuleMatchesPlain(ruleContent, alias),
    ) ?? false)
  )
}

export type SkillRuleMatchOutcome =
  | 'allow'
  | 'no-match'
  | 'held-back-nonholder'
  | 'held-back-boundary'

/**
 * Official ke: classify an allow rule against a skill invocation.
 * Candidates are the invoked name plus the command's registered name (the
 * official third candidate, tHe(command), is syncedSkills-only → never in
 * OCC). With the gate off, plain matching decides. With it on, a rule only
 * allows when it namespace-aware-matches a candidate that is either held by a
 * synced skill or not reserved; a plain-matching rule against a reserved name
 * is held back (nonholder when it also namespace-aware-matches, boundary
 * otherwise).
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
// Messages (official ue @208584171 + squatter ask)
// ---------------------------------------------------------------------------

export type HeldBackMessageOptions =
  | { kind: 'nonholder'; pluginName?: string }
  | { kind: 'boundary' }

/**
 * Official ue (byte-exact, nonholder + boundary kinds; the 'renamed' kind is
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

/** Official skills-funnel gate: `Nfe() && wU(`${vn(serverName)}:`)`. */
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
 * Official per-prompt message (byte-exact; always the plural fallback WIt):
 * `Prompt '${commandName}' not listed: the server name ${WIt}. Rename the
 *  server in your MCP configuration to list its prompts.`
 */
export function reservedMcpPromptMessage(promptCommandName: string): string {
  return `Prompt '${promptCommandName}' not listed: the server name ${RESERVED_NAMES_REASON_FALLBACK}. Rename the server in your MCP configuration to list its prompts.`
}
