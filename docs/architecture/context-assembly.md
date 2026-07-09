# Context Assembly

Before each API request, OCC assembles a system prompt, user context, and
system context. This document traces where each piece comes from and how the
"lean prompt" and caching boundaries work.

## Three context objects

`QueryEngine.submitMessage` / the REPL gather three objects before calling
`query()`:

| Object | Source | Contents |
|---|---|---|
| `systemPrompt` | `getSystemPrompt()` (`src/constants/prompts.ts`) | The multi-section system prompt string array |
| `userContext` | `getUserContext()` (`src/context.ts`) | `claudeMd`, `currentDate` |
| `systemContext` | `getSystemContext()` (`src/context.ts`) | `gitStatus`, `cacheBreaker` |

`query()` then calls `asSystemPrompt(appendSystemContext(systemPrompt,
systemContext))` to merge system context into the prompt.

## `src/context.ts` — runtime context providers

Four memoized async providers (caches cleared on `/clear`, `/compact`, and
cache-breaker changes):

- **`getGitStatus`** (memoized) — runs `getBranch()`, `getDefaultBranch()`,
  `git status --short` (truncated at `MAX_STATUS_CHARS = 2000`),
  `git log --oneline -n 5`, and `git config user.name` in parallel. Skipped
  when `NODE_ENV === 'test'` or `!getIsGit()`. Returns a multi-line string
  prefixed "This is the git status at the start of the conversation…".
- **`getSystemContext`** (memoized) — returns `{ gitStatus?, cacheBreaker? }`.
  Skips git status when `CLAUDE_CODE_REMOTE` is truthy or
  `!shouldIncludeGitInstructions()`. `cacheBreaker` (format
  `[CACHE_BREAKER: <injection>]`) only when `feature('BREAK_CACHE_COMMAND')`
  is on.
- **`getUserContext`** (memoized) — returns `{ claudeMd?, currentDate }`.
  `currentDate` is `"Today's date is ${getLocalISODate()}."`. CLAUDE.md
  loading is disabled when `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is truthy,
  `isMemoryLoadingPaused()`, or bare mode with no `--add-dir` dirs. Calls
  `getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))` and
  caches via `setCachedClaudeMdContent` (read by the auto-mode classifier).
- **`shouldUseLeanSystemPrompt(model, effort?)`** / `getUltracodeSystemReminder()`
  — re-export the "K1 lean prompt" and "K3 ultracode" decisions from
  `src/utils/effort/`.

## `src/constants/prompts.ts` — the system prompt builder

**`getSystemPrompt(tools, model, additionalWorkingDirectories?, mcpClients?)`**
returns `string[]`. Structure (lines 450–600):

1. `CLAUDE_CODE_SIMPLE` fast path → 1-element array with CWD + date.
2. Parallel fetch of `getSkillToolCommands`, `getOutputStyleConfig`,
   `computeSimpleEnvInfo`.
3. `lean = shouldUseLeanSystemPrompt(model)` — strips non-essential expanded
   sections for lean_prompt-capable models.
4. Proactive/KAIROS fast path (feature-gated, off).
5. **Static (cacheable) sections**: `getSimpleIntroSection`,
   `getSimpleSystemSection`, `getSimpleDoingTasksSection` (skipped if output
   style drops coding instructions), `getActionsSection`,
   `getUsingYourToolsSection`, `getSimpleToneAndStyleSection`,
   `getOutputEfficiencySection`.
6. **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** marker
   (`'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'`) — only inserted when
   `shouldUseGlobalCacheScope()`. Everything before is cross-org cacheable
   (`scope: 'global'`); everything after is user/session-specific. Cache logic
   lives in `src/utils/api.ts` (`splitSysPromptPrefix`) and
   `src/services/api/claude.ts` (`buildSystemPromptBlocks`).
7. **Dynamic sections** via the registry: `session_guidance`, `memory`
   (`loadMemoryPrompt`), `ant_model_override`, `env_info_simple`, `language`,
   `output_style`, `thinking_guidance` (stripped when lean),
   `mcp_instructions` (DANGEROUS_uncached), `scratchpad`, `frc`,
   `summarize_tool_results`, plus feature-gated `numeric_length_anchors`,
   `token_budget`, `brief`.

Other exports: `computeEnvInfo`, `computeSimpleEnvInfo` (the `# Environment`
block: CWD, git-repo status, platform, shell, OS version, model name,
knowledge cutoff), `enhanceSystemPromptWithEnvDetails` (agent-thread notes +
DiscoverSkills guidance), `DEFAULT_AGENT_PROMPT`. Model knowledge cutoffs are
hardcoded in `getKnowledgeCutoff` (sonnet-4-6 = Aug 2025, opus-4-6/4-5 = May
2025, haiku-4 = Feb 2025).

## `src/constants/systemPromptSections.ts` — section registry

- `systemPromptSection(name, compute)` — memoized, `cacheBreak: false`.
- `DANGEROUS_uncachedSystemPromptSection(name, compute, _reason)` — recomputes
  every turn, breaks prompt cache.
- `resolveSystemPromptSections(sections)` — reads/writes cache from
  `getSystemPromptSectionCache()` in `bootstrap/state.js`.
- `clearSystemPromptSections()` — called on `/clear` and `/compact`; also
  resets beta header latches.

## CLAUDE.md discovery — `src/utils/claudemd.ts`

The 4-tier loading order (low → high priority):

```
Managed  /etc/claude-code/CLAUDE.md
User     ~/.claude/CLAUDE.md
Project  CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md  (root → CWD)
Local    CLAUDE.local.md
```

Files closer to CWD load later (higher priority). Key exports:

- **`getMemoryFiles`** (memoized) — the main discovery walker. Processes
  Managed, then User (gated on `isSettingSourceEnabled('userSettings')`),
  then walks `getOriginalCwd()` up to root processing each dir's `CLAUDE.md` +
  `.claude/CLAUDE.md` + `.claude/rules/*.md` (Project) and `CLAUDE.local.md`
  (Local). Handles nested worktrees (skips checked-in files from main repo
  above worktree). Handles `--add-dir`. Loads AutoMem and TeamMem
  entrypoints. Fires `InstructionsLoaded` hooks.
- **`getClaudeMds(memoryFiles, filter?)`** — joins files into a single string
  prefixed by `MEMORY_INSTRUCTION_PROMPT`. Each entry is
  `Contents of <path> (<description>):\n\n<content>`.
- **`processMemoryFile`** — recursive `@include` resolver (max depth
  `MAX_INCLUDE_DEPTH = 5`). `parseMemoryFileContent` strips frontmatter +
  HTML comments + truncates MEMORY.md.
- **`parseFrontmatterPaths`** — extracts glob `paths` from frontmatter for
  conditional rules (rules apply only when the cwd matches the path globs).
- **`processMdRules` / `processConditionedMdRules`** — conditional
  (glob-matched) rule loading for nested directory access.
- **`filterInjectedMemoryFiles`** — when `tengu_moth_copse` is on, AutoMem/
  TeamMem are surfaced via attachments instead of the system prompt.

`clearMemoryFileCaches()` / `resetGetMemoryFilesCache(reason)` invalidate
caches (the latter re-enables the InstructionsLoaded hook).

## Memory types — `src/utils/memory/types.ts`

```
MEMORY_TYPE_VALUES = ['User', 'Project', 'Local', 'Managed', 'AutoMem',
                      ...(feature('TEAMMEM') ? ['TeamMem'] : [])]
```

## The lean prompt (K1) and ultracode (K3)

- **Lean prompt** (`src/utils/effort/leanPrompt.ts`) — lean_prompt-capable
  models get a stripped system prompt by default, dropping non-essential
  expanded sections. `shouldUseLeanSystemPrompt(model, effort?)` is the
  decision function.
- **Ultracode** (`src/utils/effort/ultracode.ts`) — `/effort ultracode` is
  the max-reasoning effort level with a badge + keyword trigger.
  `getUltracodeSystemReminder()` returns an extra system reminder.

Both are re-exported from `src/context.ts` so the context layer doesn't import
the effort module graph directly.

## How context reaches the API

```
QueryEngine / REPL
   ├─ getSystemContext()  → { gitStatus? }
   ├─ getUserContext()    → { claudeMd?, currentDate }
   ├─ getSystemPrompt()   → string[]  (constants/prompts.ts)
   │
   ▼
query({ systemPrompt, userContext, systemContext, ... })
   │
   ▼
asSystemPrompt(appendSystemContext(systemPrompt, systemContext))
   │
   ▼
queryModel → buildSystemPromptBlocks(systemPrompt, enablePromptCaching, ...)
   │   (adds cache-control markers; splits at SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
   ▼
anthropic.beta.messages.create({ system, messages, ... })
```

`userContext` is prepended to the user messages via `prependUserContext`;
`systemContext` is appended to the system prompt via
`appendSystemContext`.

## Key files

| File | Role |
|---|---|
| `src/context.ts` | `getGitStatus`, `getSystemContext`, `getUserContext`, lean/ultracode re-exports |
| `src/constants/prompts.ts` | `getSystemPrompt`, `computeSimpleEnvInfo`, `enhanceSystemPromptWithEnvDetails` |
| `src/constants/systemPromptSections.ts` | Section registry + caching (`DANGEROUS_uncached`) |
| `src/utils/claudemd.ts` | CLAUDE.md discovery, `@include`, conditional rules |
| `src/utils/memory/types.ts` | `MemoryType` values |
| `src/utils/effort/leanPrompt.ts` | Lean prompt decision (K1) |
| `src/utils/effort/ultracode.ts` | Ultracode effort (K3) |
| `src/utils/api.ts` | `appendSystemContext`, `splitSysPromptPrefix`, `CacheScope` |
