import { toolMatchesName } from '../../Tool.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { clearCommandsCache, getCommands } from '../../commands.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isSafeMode } from '../../utils/envUtils.js'

/**
 * /reload-skills — re-scan the skills directories and reload skills mid-session.
 *
 * Official 2.1.299 (#145) message, byte-verified from the v299 ELF
 * (@236896600 region, chunk function `E`):
 *   `let r=N(e,(o)=>!d.has(o.name)),n=N(l,(o)=>!c.has(o.name)),a=[];
 *    if(r>0)a.push(`${r} added`);if(n>0)a.push(`${n} removed`);
 *    let p=a.length>0?a.join(", "):"none added or removed",
 *        f=Pr()?"; custom skills are disabled in safe mode":"",
 *        h=e.length>0&&t.options.tools.some((o)=>Tt(o,ho))?
 *          " Claude will get the full list of skills with your next message.":"";
 *    return{type:"text",
 *      value:`Reloaded skills: ${e.length} ${I(e.length,"skill")} available (${p}${f}).${h}`}`
 * i.e. vs v296: "no changes" → "none added or removed", the safe-mode note
 * moved inside the parens with a "; " prefix, and the NEW trailing sentence
 * says the full skill list is re-sent with the next message.
 *
 * OCC adaptation: the official `lR` skill loader + `soe` MCP filter map onto
 * OCC's memoized getCommands() (pre-clear call = "before" snapshot, post-clear
 * call = "after"); the skill filter keeps OCC's existing
 * `type === 'prompt' && source !== 'builtin'` shape. `Pr()` = isSafeMode(),
 * `Tt(o,ho)` = toolMatchesName(tool, SKILL_TOOL_NAME).
 */
export const call: LocalCommandCall = async (_args, context) => {
  const cwd = getProjectRoot()
  const isReloadableSkill = (c: { type: string; source: string }) =>
    c.type === 'prompt' && c.source !== 'builtin'

  // "Before" snapshot — getCommands is memoized, so this is the cached list
  // when one exists (same semantics as the official pre-clear lR() read).
  const before = (await getCommands(cwd)).filter(isReloadableSkill)
  const beforeNames = new Set(before.map(c => c.name))

  clearCommandsCache()

  const after = (await getCommands(cwd)).filter(isReloadableSkill)
  const afterNames = new Set(after.map(c => c.name))

  const added = after.filter(c => !beforeNames.has(c.name)).length
  const removed = before.filter(c => !afterNames.has(c.name)).length
  const changes: string[] = []
  if (added > 0) changes.push(`${added} added`)
  if (removed > 0) changes.push(`${removed} removed`)
  const changeSummary =
    changes.length > 0 ? changes.join(', ') : 'none added or removed'
  const safeModeNote = isSafeMode()
    ? '; custom skills are disabled in safe mode'
    : ''
  const fullListNote =
    after.length > 0 &&
    (context?.options?.tools ?? []).some(t =>
      toolMatchesName(t, SKILL_TOOL_NAME),
    )
      ? ' Claude will get the full list of skills with your next message.'
      : ''

  const noun = after.length === 1 ? 'skill' : 'skills'
  return {
    type: 'text',
    value: `Reloaded skills: ${after.length} ${noun} available (${changeSummary}${safeModeNote}).${fullListNote}`,
  }
}
