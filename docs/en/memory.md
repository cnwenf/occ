# Memory

OCC has a layered memory system: CLAUDE.md project/user instructions, conditional `.claude/rules/*.md` files, and an auto-memory system that persists learnings across conversations.

## CLAUDE.md hierarchy

CLAUDE.md files are discovered and loaded by `src/utils/claudemd.ts`. The load order (lowest to highest priority — later files get more attention):

1. **Managed memory** — `/etc/claude-code/CLAUDE.md` (global policy) + `.claude/rules/*.md` in the managed dir.
2. **User memory** — `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md`.
3. **Project memory** — `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` in project roots, discovered by walking from CWD up to root. Files closer to CWD have higher priority (loaded last).
4. **Local memory** — `CLAUDE.local.md` in project roots (gitignored, private per-user).

`getMemoryFiles()` walks `getOriginalCwd()` up to root. For each directory it loads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, and `CLAUDE.local.md`.

### Context injection

Memory content is injected into every API call via `getUserContext()` in `src/context.ts`. Each file is wrapped:

```
Contents of <path> (project instructions, checked into the codebase):
<content>
```

Type descriptions: Project = "project instructions, checked into the codebase"; Local = "user's private project instructions, not checked in"; User = "user's private global instructions for all projects"; AutoMem = "user's auto-memory, persists across conversations".

### `@include` directive

Memory files can include other files with `@` notation: `@path`, `@./relative/path`, `@~/home/path`, `@/absolute/path`. Works in leaf text nodes only (not code blocks). Max depth 5. Only text-file extensions are allowed.

### Conditional rules (`.claude/rules/*.md`)

Rule files can declare a `paths:` frontmatter field (gitignore-style globs). When set, the rule only applies when the model touches matching files. For Project rules, globs are relative to the directory containing `.claude/`; for Managed/User rules, relative to the original CWD.

### Disabling memory

- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` — hard off
- `--bare` mode — skips auto-discovery (but honors explicit `--add-dir`)
- `claudeMdExcludes` setting — glob patterns to exclude specific CLAUDE.md files
- `--setting-sources` — gates which sources load

## Managing memory files

### `/memory`

Opens a `MemoryFileSelector` listing available memory files (user, project, local, auto-memory). On select, creates the file if missing and opens it in `$VISUAL`/`$EDITOR`. Clears caches before rendering.

### `/pause-memory`

Toggles loading of CLAUDE.md and memory files into context. When paused: "CLAUDE.md and memory files will not be injected into context." Resuming re-injects on the next query. Clears the `getUserContext`/`getMemoryFiles` caches.

## Auto-memory

Auto-memory is a persistent, cross-conversation memory system (`src/memdir/`). It learns from your conversations and saves memories to disk, surfacing relevant ones in future sessions.

### Enablement

`isAutoMemoryEnabled()` priority chain: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env (1→off, 0→on) → `--bare`/`CLAUDE_CODE_SIMPLE` → off → `autoMemoryEnabled` setting → default on.

### Directory location

Default: `~/.claude/projects/<sanitized-git-root>/memory/`. The git root is canonicalized via `findCanonicalGitRoot()` so all worktrees of the same repo share one memory dir. Example: `/root/code/occ` → `~/.claude/projects/-root-code-occ/memory/`. Override with `autoMemoryDirectory` (trusted sources only) or `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`.

### MEMORY.md — the index

The entrypoint is `MEMORY.md` in the memory directory. It is an **index**, not a memory itself. Each entry is one line under ~150 chars:

```markdown
- [Title](file.md) — one-line hook
```

It has no frontmatter. Lines after 200 (or 25KB) are truncated. Detail goes in separate topic files in the same directory.

### Memory file format

Topic files use frontmatter:

```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance}}
type: {{user, feedback, project, reference}}
---

{{memory content}}
```

Four memory types: `user` (who you are), `feedback` (how you like to work), `project` (how the codebase is organized), `reference` (external docs/APIs).

### What not to save

Code patterns/architecture/file paths (derivable), git history, debugging solutions, anything already in CLAUDE.md, ephemeral task state. These exclusions apply even when you explicitly ask to save.

### Extraction

A forked agent runs at the end of each complete query loop (`src/services/extractMemories/`). It shares the prompt cache, gets a restricted tool set (Read/Grep/Glob unrestricted; read-only Bash; Edit/Write only within the memory dir), and writes memories using a two-step process: write a topic file, then add a pointer to `MEMORY.md`. Max 5 turns. Skipped when the main agent already wrote memories that turn.

### Relevant memory prefetch

`findRelevantMemories()` scans the memory dir, reads frontmatter, and asks Sonnet to select up to 5 relevant memories for the current query. Called from `src/utils/attachments.ts` at query start.

### The `#` quick-add pattern

Typing `#` at the prompt to add a memory is rendered by `UserMemoryInputMessage.tsx`, but the input-interception handler lives in the compiled binary's input layer and is **not present in the open-source OCC source**. The display components exist, but the trigger does not.

## Memory size thresholds

`MIN_MEMORY_CHARACTER_COUNT = 40000` (floor). `MAX_CLAUDE_MD_TOKEN_CONTEXT_RATIO = 0.05` (5% of context window). A 200k-token context allows 40k chars; a 1M-token context allows 200k chars. Oversized CLAUDE.md files trigger a warning in `/doctor`.

## Related

- [Settings](./settings.md) — `autoMemoryEnabled`, `claudeMdExcludes`, `autoMemoryDirectory`
- [Skills](./skills.md) — skills can declare `paths:` frontmatter like rules
- [Troubleshooting](./troubleshooting.md) — `/doctor` checks for oversized memory files
