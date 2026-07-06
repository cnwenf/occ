// C9 (cross): DiscoverSkillsTool — on-demand skill search.
//
// The official 2.1.200 binary ships a `SearchSkills` tool (built via _Xa with
// run:s6n) that searches the user's claude.ai skill library by keyword over the
// OAuth org endpoint `/api/oauth/organizations/:orgUUID/skills/search`
// (auth:"teleport-org"). OCC has no teleport-org OAuth client, so the remote
// path is out of reach; this tool instead searches the LOCAL skill set already
// loaded by loadSkillsDir/bundledSkills (project + user + bundled + plugin
// skills), which is the set the model can actually invoke. Name/description/
// prompt match the binary exactly so the tool surface is identical.
export const DISCOVER_SKILLS_TOOL_NAME = 'SearchSkills' as const

export const DISCOVER_SKILLS_TOOL_DESCRIPTION =
  "Search the user's claude.ai skills by keyword to find skills that might help complete the task."

export const DISCOVER_SKILLS_TOOL_PROMPT = `Search the user's claude.ai skills by keyword. Call this when a skill (a reference document or instruction set the user has uploaded or enabled) might help complete the task.`
