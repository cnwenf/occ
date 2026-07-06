// C9 (cross): local skill keyword search backing for the DiscoverSkillsTool
// (SearchSkills). The official tool searches the user's remote claude.ai skill
// library via OAuth; OCC searches the locally-loaded skill set (project + user
// + bundled + plugin) — the set the model can actually invoke here.
import type { Command } from '../commands.js'
import {
  getSkillToolCommands,
} from '../commands.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { dropShadowedSkills } from './loadSkillsDir.js'

export interface SkillSearchResult {
  name: string
  description: string
  source?: string
  score: number
}

function normalize(text: string): string {
  return text.toLowerCase()
}

/**
 * Scores a skill against the keyword query. Matches against name (highest
 * weight), then description/whenToUse. A skill that matches every keyword
 * ranks above one matching only some.
 */
function scoreSkill(cmd: Command, keywords: string[]): number {
  if (keywords.length === 0) return 1
  const haystack = normalize(
    `${cmd.name} ${cmd.description ?? ''} ${cmd.whenToUse ?? ''}`,
  )
  let score = 0
  for (const kw of keywords) {
    const needle = normalize(kw)
    if (!needle) continue
    if (normalize(cmd.name).includes(needle)) score += 3
    if (haystack.includes(needle)) score += 1
  }
  return score
}

/**
 * Search loaded skills by keyword. Returns skills ranked by relevance, best
 * first. Skills scoring 0 (no keyword overlap) are excluded unless the query
 * is empty, in which case all skills are returned (list-everything mode, the
 * same behavior as the official tool's omit-keywords path).
 */
export async function searchSkills(
  keywords: string[],
  cwd: string = getProjectRoot(),
): Promise<SkillSearchResult[]> {
  const commands = dropShadowedSkills(await getSkillToolCommands(cwd))
  const scored = commands.map(cmd => ({
    name: cmd.name,
    description: cmd.description ?? '',
    source: cmd.source,
    score: scoreSkill(cmd, keywords),
  }))
  const filtered = keywords.length === 0 ? scored : scored.filter(s => s.score > 0)
  return filtered.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/**
 * Formats search results as the text the SearchSkills tool returns to the model.
 */
export function formatSkillSearchResults(results: SkillSearchResult[]): string {
  if (results.length === 0) return 'No skills matched the query.'
  return results.map(r => `- ${r.name}: ${r.description}`).join('\n')
}
