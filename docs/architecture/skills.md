# Skills System

Skills are reusable, frontmatter-driven prompt modules that extend the agent's
capabilities. A skill is a `SKILL.md` file with YAML frontmatter (description,
allowed tools, when-to-use, etc.) plus a markdown body. The agent invokes
skills via the `SkillTool` or by typing a slash command.

## Skill discovery — `src/skills/loadSkillsDir.ts`

### Directory format (primary)

`<skill-name>/SKILL.md`. `loadSkillsFromSkillsDir(basePath, source)` (line 608):

1. `fs.readdir(basePath)` → for each entry that is a directory or symlink.
2. Read `join(skillDirPath, 'SKILL.md')` (skip on ENOENT).
3. `parseSkillFrontmatter(content, skillFilePath, { normalizeKeys: true })`
   (line 234) — delegates to `parseFrontmatter`
   (`src/utils/frontmatterParser.ts`), then `normalizeFrontmatterKeys`
   (case-insensitive key matching).
4. `parseSkillFrontmatterFields` (line 322) — extracts: `displayName`,
   `description`, `allowedTools`, `disallowedTools`, `argumentHint`,
   `argumentNames`, `whenToUse`, `version`, `model`, `disableModelInvocation`,
   `userInvocable`, `hooks`, `executionContext` (`'fork'` | undefined), `agent`,
   `effort`, `shell`.
5. `parseSkillPaths(frontmatter)` (line 165) — path restrictions (same format
   as CLAUDE.md rules).
6. Compute SHA-256 `contentHash` of full file content (version tracking).
7. Skip if `defaultEnabled === false` (2.1.186).
8. `createSkillCommand({...parsed, skillName, markdownContent, contentHash,
   source, baseDir, loadedFrom: 'skills', paths})`.

The **`${CLAUDE_SKILL_DIR}`** placeholder (line 547) is replaced with the
skill's directory path so skills can reference bundled reference files.

### Legacy `/commands/` format

Single `.md` files in `/commands/` matching `/^skill\.md$/i` are also treated
as skills (line 706+).

### Skill directory discovery

`discoverSkillDirsForPaths(...)` (line 1094) walks paths looking for
`.claude/skills` dirs (gitignored ones skipped). `addSkillDirectories(dirs)`
(line 1156) registers dynamic skill dirs.

## SkillTool — `src/tools/SkillTool/SkillTool.ts`

`buildTool`, `name: SKILL_TOOL_NAME`, `searchHint: 'invoke a slash-command
skill'`, `maxResultSizeChars: 100_000`. Input schema:
`z.object({ skill: z.string(), args: z.string().optional() })`.

### `call({ skill, args }, context, canUseTool, parentMessage, onProgress)` (line 610)

1. Remote canonical skill interception (ant-only).
2. `getAllCommands(context)` → `findCommand(commandName)`.
3. `recordSkillUsage(commandName)` (ranking).
4. `setSkillAttribution(commandName, contentHash)` (turn-level attribution).
5. If `command.context === 'fork'` → `executeForkedSkill(...)` (runs via
   `runAgent` in an isolated sub-agent with its own budget).
6. Else inline: `processPromptSlashCommand(commandName, args, commands,
   context)` → extract `allowedTools`, `model`, `effort`.
7. Emits `tengu_skill_tool_invocation` telemetry.
8. Returns `ToolResult` with `newMessages` (the expanded prompt as user
   messages).

Re-invoking an already-loaded skill no longer appends a duplicate copy of its
instructions: `src/skills/loadedSkillsTracker.ts` (`isSkillAlreadyLoaded` /
`markSkillLoaded`, keyed by `${agentId ?? ''}:${skillName}` + the rendered
content hash) lets the skill-content injection path
(`getMessagesForPromptSlashCommand`) skip re-appending the body when the same
skill with the same rendered content is already in context this session
(2.1.202). Different args (different rendered content) are not a duplicate and
are re-appended; the tracker survives compaction.

### `getAllCommands(context)` (line 89)

Merges local commands (`getCommands(getProjectRoot())`) with MCP skills
(`appState.mcp.commands` filtered to `type === 'prompt' && loadedFrom ===
'mcp'`), then applies `dropShadowedSkills`.

### `validateInput` (line 369)

Trims, strips leading `/`, intercepts remote canonical skills, checks
`disableModelInvocation`, session skill allowlist (`isSkillAllowedBySession`),
`type === 'prompt'`.

## Skill search — `src/skills/searchSkills.ts` + `src/services/skillSearch/`

### Local search

`searchSkills(keywords, cwd)` (line 49) — scores loaded skills
(`dropShadowedSkills(await getSkillToolCommands(cwd))`) by keyword match
against `name` (weight 3) + `description`/`whenToUse` (weight 1); returns
best-first, excludes 0-score unless the query is empty.
`formatSkillSearchResults(results)` (line 67).

### Remote skill search (gated `EXPERIMENTAL_SKILL_SEARCH`)

`src/services/skillSearch/` contains `remoteSkillLoader.ts`,
`remoteSkillState.ts` (skill state/caching), `featureCheck.ts`, `telemetry.ts`,
`prefetch.ts`, `localSearch.ts`, `signals.ts`. The `DiscoverSkillsTool`
(`src/tools/DiscoverSkillsTool/`) triggers discovery. Skill prefetch is fired
in `query.ts` per-iteration when the flag is on.

## Skill attribution — `src/tools/SkillTool/skillAttribution.ts`

Turn-level attribution tracking (2.1.186+):

- Module-level `attributionSkillName` / `attributionContentHash`.
- `setSkillAttribution(skillName, contentHash)` (line 72) — called by
  `SkillTool.call()`; `undefined` clears at turn boundaries.
- `getAttributionSkillName()`, `getAttributionSkillHash()` (falls back to
  `djb2Hash` of name), `getAttributionPlugin()` (derives from `plugin:skill`
  syntax).
- `getSkillAttribution()` (line 113) → `{ attributionSkill, attributionPlugin? }`
  for API request telemetry (`_PROTO_skill_name` on request events).
- `hashSkillContent(content)` (line 50) — SHA-256 digest.

## Skill shadowing — `dropShadowedSkills` (loadSkillsDir.ts line 313)

`dropShadowedSkills(skills) = dropShadowedFallbackSkills(
dropShadowedBundledSkills(skills))`:

- **`dropShadowedBundledSkills`** (line 255) — if a `source === 'bundled'`
  skill has the same name as an already-seen skill, drop the bundled one.
- **`dropShadowedFallbackSkills`** (line 281, 2.1.186+) — collect names of
  non-fallback, model-invocable skills from `plugin`/`bundled`/`mcp` sources;
  drop any `fallback === true` skill whose name appears in that set.

This lets user/plugin skills override bundled/fallback skills of the same
name.

## Bundled skills — `src/skills/bundled/index.ts` + `bundledSkills.ts`

`initBundledSkills()` (line 26) registers at startup (skipped in `--safe-mode`).
`registerBundledSkill(definition: BundledSkillDefinition)` (line 54 of
`bundledSkills.ts`) programmatically registers.

### Unconditional bundled skills

`updateConfig` (`/update-config`), `keybindings` (`/keybindings-help`),
`verify`, `debug`, `loremIpsum`, `skillify`, `remember`, `code-review`
(2.1.154; extended in 2.1.204 to `/code-review <level> <PR#>` so the target
may be a GitHub PR number, e.g. `/code-review high 1234`), `simplify`
(cleanup-only), `batch`, `stuck`.

### Conditional bundled skills

`dream` (KAIROS|KAIROS_DREAM), `hunter` (REVIEW_ARTIFACT), `loop`
(AGENT_TRIGGERS), `scheduleRemoteAgents` (AGENT_TRIGGERS_REMOTE), `claudeApi`
(BUILDING_CLAUDE_APPS), `claudeInChrome` (`shouldAutoEnableClaudeInChrome()`),
`runSkillGenerator` (RUN_SKILL_GENERATOR).

## MCP skills (gated `MCP_SKILLS`)

Fetches skill modules exposed by MCP servers that declare the
`io.modelcontextprotocol/skills` extension. Wired through
`src/services/mcp/client.ts` + `useManageMCPConnections.ts`. Built by
`src/skills/mcpSkillBuilders.ts` / `mcpSkills.ts`.

## Other skills utilities

| File | Role |
|---|---|
| `src/skills/sessionSkillAllowlist.ts` | `getSessionSkillAllowlist`, `isSkillAllowedBySession` (subagent `skills:` frontmatter) |
| `src/skills/stackedSlashCommands.ts` | Stacked slash command handling |
| `src/skills/mcpSkillBuilders.ts` / `mcpSkills.ts` | MCP skill construction |
| `src/utils/skills/skillChangeDetector.ts` | Detects skill file changes for hot-reload |

## How it differs from Claude Code

OCC's skills system is feature-gated via `EXPERIMENTAL_SKILL_SEARCH` and
`MCP_SKILLS` (both live in the `FEATURE_ALLOWLIST`). Local skill discovery,
shadowing, attribution, and the forked execution context are all present.
Remote skill search (the ant-only canonical skill system) is partially
present via `EXPERIMENTAL_SKILL_SEARCH` but the remote canonical skill
interception paths in SkillTool are ant-only stubs.
