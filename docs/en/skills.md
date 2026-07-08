# Skills

Skills are markdown-defined capabilities that expand into prompts when invoked. They back slash commands and the model can invoke them autonomously via the `Skill` tool.

## What skills are

A skill is a `SKILL.md` file with YAML frontmatter and a prompt body. When invoked (by typing `/name` or by the model calling the `Skill` tool), the body is injected into the conversation as a prompt. Skills can override the allowed tools, model, and effort level for the duration of the invocation.

Skills differ from subagents: inline skills expand in the current conversation; a `context: 'fork'` skill runs in a subagent. Slash commands are skills with `user-invocable: true` (default for `/commands/`, default false for `/skills/`).

## Skill locations

Skills are loaded from (priority: built-in → plugin → user → project, first match wins):

| Source | Path | Notes |
|---|---|---|
| Managed | `<managed>/.claude/skills` | Policy skills |
| User | `~/.claude/skills/<name>/SKILL.md` | Personal skills |
| Project | `.claude/skills/<name>/SKILL.md` | Shared via VCS |
| Plugin | plugin `skills/` dir | Namespaced |
| Bundled | compiled into CLI | `claude-api`, `verify` |
| MCP | MCP servers declaring `io.modelcontextprotocol/skills` | Requires `MCP_SKILLS` flag |

Legacy `/commands/` directories support both directory (`SKILL.md`) and single `.md` file formats; `/skills/` supports directory format only.

## Frontmatter

| Field | Type | Purpose |
|---|---|---|
| `description` | string | What the skill does; shown in listings |
| `when_to_use` | string | Appended to description in listings |
| `allowed-tools` | string/list | Tools allowed while skill active |
| `disallowed-tools` | string/list | Tools blocked |
| `argument-hint` | string | Hint for arguments |
| `arguments` | string/list | Parsed arg names for `$ARG` substitution |
| `model` | string | Model override (`haiku`/`sonnet`/`opus`/`inherit`) |
| `effort` | string/number | Thinking effort |
| `user-invocable` | boolean | `true` = user can type `/name` |
| `disable-model-invocation` | boolean | Block the `Skill` tool from invoking |
| `context` | `inline`/`fork` | Execution mode |
| `agent` | string | Agent type when forked |
| `paths` | string/list | Glob patterns for conditional activation |
| `hooks` | object | Hooks to register on invocation |
| `shell` | `bash`/`powershell` | Shell for `!` blocks |
| `version` | string | Version string |
| `default-enabled` | boolean | `false` skips loading |
| `fallback` | boolean | Fallback skill, shadowed by real skills |

## The Skill tool

The `Skill` tool (`src/tools/SkillTool/`) is the unified invocation path. Whether you type `/commit` or the model decides to use a skill, the tool expands the skill's prompt. Input: `{ skill: string, args?: string }`.

- **Inline** (default): skill content expands into the current conversation. Applies `allowedTools`, `model`, and `effort` overrides.
- **Forked** (`context: 'fork'`): runs in a subagent via `runAgent` with a separate context/token budget. Agent type from `agent:` frontmatter.

The prompt instructs the model: "When users reference a 'slash command' or '/<something>', they are referring to a skill. Use this tool to invoke it." The model should invoke a matching skill before generating other response about the task.

### Token budget

Skill listings are capped to 1% of the context window (`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`). Per-skill descriptions are capped at 1536 chars. Bundled skills always get full descriptions; non-bundled are truncated to fit.

## Skill content processing

On invocation (`getPromptForCommand`):

1. Prepends `Base directory for this skill: <baseDir>` if set.
2. `substituteArguments()` — replaces `$ARGUMENTS`/`$1` etc.
3. Replaces `${CLAUDE_SKILL_DIR}` with the skill's directory.
4. Replaces `${CLAUDE_SESSION_ID}` with the current session ID.
5. Replaces `${CLAUDE_EFFORT}` with the current effort level.
6. Executes inline shell syntax (`!`cmd`` / ` ```! ` blocks) unless `disableSkillShellExecution` is set or the skill is from MCP (untrusted).

## DiscoverSkills (SearchSkills)

The `SearchSkills` tool (`src/tools/DiscoverSkillsTool/`) lets the model search skills by keyword. Input: `{ keywords: string[] }` (1-8 keywords). In OCC, it searches the locally-loaded skill set (keyword scoring: name match = 3 points, description match = 1 point). The official binary searches a remote claude.ai library; OCC is local-only.

## Skill discovery (turn-zero prefetch)

The `EXPERIMENTAL_SKILL_SEARCH` feature flag (live in OCC) un-gates skill prefetch in `src/query.ts`: at the start of each turn, OCC prefetches relevant skills so the model knows what's available. The prefetch module (`src/services/skillSearch/prefetch.ts`) is a stub in the OSS build (returns empty arrays), but the discovery wiring is live.

## Conditional skills

Skills with a `paths:` frontmatter field are conditional — they activate only when the model touches matching files. Stored separately and activated on first touch via `activateConditionalSkillsForPaths`.

Dynamic discovery (`discoverSkillDirsForPaths`) walks up from file paths to CWD looking for `.claude/skills` directories and loads them on first touch. Gitignored directories are skipped.

## Managing skills

### `/skills`

Opens `SkillsMenu` listing all commands grouped by source (Policy/User/Project, Plugin, MCP). Shows token estimates and filesystem paths. Searchable.

### `/reload-skills`

Clears the command cache, eagerly reloads, and reports the skill count.

### `/skill-doctor`

A prompt command that instructs the model to diagnose skill issues: missing/invalid frontmatter, invalid fields, broken paths, missing body, naming conflicts. Diagnostic only.

## Creating a custom skill

Create `~/.claude/skills/<skill-name>/SKILL.md` (user) or `.claude/skills/<skill-name>/SKILL.md` (project). Minimal example:

```markdown
---
description: Lint and fix the current file
argument-hint: <file>
allowed-tools: Bash(biome:*)
---

Run `biome check --apply $ARGUMENTS` and summarize any remaining issues.
```

Reference files can be placed alongside `SKILL.md` and referenced via `${CLAUDE_SKILL_DIR}`. The `/skill-create` and `/skill-health` skills assist with creation and health checks.

## Session skill allowlist

When a subagent is launched with a `skills:` frontmatter list, only those skills are invocable in that session. Matching: exact name, plugin-qualified name, or `:name` suffix.

## Related

- [Slash Commands](./slash-commands.md) — custom commands are skills
- [Sub-agents](./sub-agents.md) — `context: 'fork'` skills use the Agent tool
- [Hooks](./hooks.md) — skills can declare `hooks:` frontmatter
- [MCP](./mcp.md) — `MCP_SKILLS` flag fetches skills from MCP servers
