/**
 * Session skill allowlist (2.1.186+).
 *
 * When an agent (subagent) is launched with a `skills:` frontmatter list,
 * the official CLI restricts that agent's Skill tool to ONLY the listed
 * skills — the frontmatter is an allowlist, not just a preload hint. A skill
 * invoked via the Skill tool that is not in the allowlist is rejected with
 * errorCode 8 ("Skill X is not in this session's skills allowlist").
 *
 * Matching follows the same rules as AgentDefinition.skills resolution:
 * exact name, plugin-qualified name (plugin:skill), or a trailing ":name"
 * suffix match. This mirrors the official `tK` filter.
 *
 * The allowlist is session-scoped state (single active value), matching the
 * official `jt.sessionSkillAllowlist` field. It is set when a subagent with a
 * skills frontmatter starts and cleared when that subagent ends. Because a
 * parent turn blocks on the subagent tool call, a single module-level value
 * is correct in practice (no interleaving Skill tool calls across the
 * parent/child boundary).
 */

// `undefined` = no allowlist active (main session / agent without skills:).
// `string[]` = only these skill identifiers are invocable.
let sessionSkillAllowlist: string[] | undefined

/**
 * Set the session skill allowlist. Pass `undefined` to clear.
 */
export function setSessionSkillAllowlist(
  allowlist: string[] | undefined,
): void {
  sessionSkillAllowlist = allowlist
}

/**
 * Get the active session skill allowlist, or `undefined` if none is active.
 */
export function getSessionSkillAllowlist(): string[] | undefined {
  return sessionSkillAllowlist
}

/**
 * Clear the session skill allowlist (called when the owning subagent ends).
 */
export function clearSessionSkillAllowlist(): void {
  sessionSkillAllowlist = undefined
}

/**
 * Does a single allowlist entry match a skill name?
 *
 * Same rules as AgentDefinition.skills: exact name, plugin-qualified name
 * (plugin:skill), or ":name" suffix match.
 */
export function skillNameMatchesAllowlistEntry(
  skillName: string,
  entry: string,
): boolean {
  if (entry === skillName) return true
  // Plugin-qualified entry "plugin:skill" matches the skill's bare name only
  // if the skill is itself namespaced under that plugin. Compare the suffix
  // after the last ":" so "myplug:foo" matches a skill named "myplug:foo"
  // (exact, handled above) OR a bare "foo" when the entry is ":foo".
  const colonIdx = entry.lastIndexOf(':')
  if (colonIdx > 0) {
    const suffix = entry.slice(colonIdx + 1)
    if (suffix === skillName) return true
  }
  // Trailing ":name" entry matches any skill whose name ends with ":name".
  if (entry.startsWith(':')) {
    const suffix = entry.slice(1)
    if (skillName.endsWith(`:${suffix}`) || skillName === suffix) return true
  }
  return false
}

/**
 * Filter a list of skill names to those permitted by the active allowlist.
 * Returns the input unchanged when no allowlist is active.
 */
export function filterSkillsByAllowlist(
  skillNames: string[],
  allowlist: string[] | undefined = sessionSkillAllowlist,
): string[] {
  if (allowlist === undefined) return skillNames
  if (allowlist.length === 0) return []
  return skillNames.filter(name =>
    allowlist.some(entry => skillNameMatchesAllowlistEntry(name, entry)),
  )
}

/**
 * Is the given skill name permitted by the active session allowlist?
 * Returns `true` when no allowlist is active (open session).
 */
export function isSkillAllowedBySession(
  skillName: string,
): boolean {
  if (sessionSkillAllowlist === undefined) return true
  return sessionSkillAllowlist.some(entry =>
    skillNameMatchesAllowlistEntry(skillName, entry),
  )
}
