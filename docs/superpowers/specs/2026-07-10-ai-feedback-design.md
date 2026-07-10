# AI-Powered `/feedback` Command — Design Spec

**Date:** 2026-07-10
**Status:** Approved
**Target repo:** `cnwenf/occ`

## 1. Goal

Turn `/feedback <用户问题>` into an AI-driven command that, in one step, collects OCC runtime diagnostics, has the main agent synthesize a GitHub issue (title + structured body in the user's input language), and submits it via `gh issue create` against `cnwenf/occ`.

OCC is itself an agent — the command must not reimplement a separate AI call (`queryHaiku`). The agent loop is the AI; the command only gathers process-exclusive diagnostics and hands them to the agent.

## 2. Non-Goals

- No separate Haiku/model call for title generation.
- No interactive dialog (the `Feedback.tsx` component is dead code; not reactivated).
- No submission to Anthropic's feedback API or `anthropics/claude-code` repo.
- No disk-file persistence of collected diagnostics beyond the injected prompt.
- No unrelated refactoring of the `Feedback.tsx` component.

## 3. Design Decisions (locked with user)

| Decision | Choice | Rationale |
|---|---|---|
| Issue language | Match user's input language | Closest to the user; AI obeys the report's language |
| AI failure mode | Hard-require AI | The prompt *is* the agent task; if the agent API is down the turn fails normally and the user files manually on GitHub |
| `gh` failure mode | Pre-filled `issues/new?…` URL fallback | Keeps the user unblocked when only `gh` (not the AI) fails |
| Command type | `prompt` (was `local`) | Hands work to the main model with full tool access instead of a separate Haiku call |
| Implementation location | Inline in `src/commands/feedback/index.ts` | Matches existing OCC customization pattern; cohesive single-file flow |

## 4. Architecture

### 4.1 Command shape

```
type: 'prompt'
name: 'feedback'  (alias: 'bug')
progressMessage: 'filing feedback issue'
allowedTools: ['Bash', 'Read', 'Grep', 'Glob']
source: 'builtin'
getPromptForCommand(args, context) => Promise<ContentBlockParam[]>
```

The returned text block becomes a user turn the agent executes with Bash/Read/Grep/Glob + reasoning. No `load()` lazy wrapper needed — `prompt` commands carry `getPromptForCommand` directly (see `commit.ts`, `review.ts`).

### 4.2 Responsibility split

**Command collects (process-exclusive — agent cannot see these from disk):**
- OCC version — `MACRO.VERSION` (global; polyfilled at dev time in `cli.tsx`), fallback `process.env.OCC_VERSION`.
- Platform/terminal/arch/nodeVersion — `env` from `src/utils/env.ts`.
- Git state — `getGitState()` + `getIsGit()` from `src/utils/git.ts` (branch, commit, remote, sync/clean flags).
- In-memory errors with stacks — `getInMemoryErrors()` from `src/utils/log.ts` (capped to last 5, each truncated).
- Last API request params — `getLastAPIRequest()` from `src/bootstrap/state.ts` (model, betas, redacted headers).
- Recent transcript snapshot — last ~12 messages from `context.messages`, text + tool_use/tool_result summarized, redacted, capped (~8KB). Survives context compaction drift so the agent still has key context even if older turns were compacted.

All collected strings pass through `redactSensitiveInfo()` (from `src/components/Feedback.tsx`) before being embedded in the returned prompt — so the agent's input is already clean and any echoed content is safe for the GitHub body.

**Agent does (instructed by the injected prompt):**
1. Synthesize a concise issue title (≤80 chars; prefix `[Bug]` for broken behavior, `[Feedback]` otherwise) from the user's question + embedded diagnostics.
2. Compose a structured markdown body **in the user's input language** with sections: User Report, AI Analysis (2–6 bullets restating the problem + pointing at the failing area from the diagnostics + a first investigation step), Environment, Error Logs, Last API Request, Recent Transcript.
3. Submit via `gh issue create --repo cnwenf/occ --title <title> --body <body>`.
4. Report the created issue URL back to the user.
5. On `gh` failure — print a pre-filled `https://github.com/cnwenf/occ/issues/new?title=…&body=…` URL built from the synthesized title/body, so the user can file manually.

### 4.3 Data flow

```
/feedback <question>
  │
  ▼
getPromptForCommand(args, context)
  │  collect: version, env, git, in-memory errors, last API request, transcript snapshot
  │  redact all via redactSensitiveInfo()
  │  assemble: <user question> + <diagnostics block> + <agent instructions>
  ▼
returns ContentBlockParam[]  ──▶  agent turn (main model)
  │  reasoning synthesizes title + body (user's language)
  │  Bash: gh issue create --repo cnwenf/occ
  ▼
issue URL  ──▶  reported back to user
  │
  └─ on gh failure: pre-filled issues/new URL printed as fallback
```

## 5. The Injected Prompt (contract)

The returned prompt is a single text block structured as:

```
<role + context: you are filing a GitHub issue for OCC, an open-source Claude Code-style agent tracking 2.1.204, runs on Bun/TS/React+Ink>

<task: synthesize title+body in the user's input language, submit via gh, report URL, fallback URL on gh failure>

<rules: title ≤80 chars [Bug]/[Feedback] prefix; body sections = User Report / AI Analysis / Environment / Error Logs / Last API Request / Recent Transcript; don't invent stacks/paths not in diagnostics; LLM/API errors are Anthropic's; respond in user's input language>

---
## User Report
<redacted user question verbatim>

## Collected Diagnostics (auto-collected by /feedback, redacted)
- OCC version: <v>
- Platform: <p> (<arch>), terminal: <t>, runtime: Bun/Node <v>
- CI: <bool> / SSH: <bool>
- Git: <branch, commit, remote, sync, clean>
- Captured at: <ISO 8601 datetime>

### In-Memory Errors (last <N>, redacted, truncated)
<for each: timestamp + redacted error/stack>

### Last API Request (redacted)
<redacted JSON of lastAPIRequest>

### Recent Transcript Snapshot (redacted, truncated)
<compact redacted text of last ~12 messages>
```

The agent receives this and does the rest. The diagnostics are pre-collected so the agent has the load-bearing error stacks and last API request even if it can't (or won't) read the transcript JSONL from disk.

## 6. Error Handling

| Scenario | Behavior |
|---|---|
| User runs `/feedback` with no args | `getPromptForCommand` returns a text block instructing the agent to ask the user what they want to report (one short turn, no issue filed). |
| Agent API broken (can't reach Anthropic) | Turn fails like any agent turn. No silent issue. User files manually on GitHub. This is the "hard-require AI" semantics. |
| `gh` CLI missing / not authed | Agent detects `gh` failure, prints pre-filled `issues/new?…` URL fallback, reports to user. |
| `redactSensitiveInfo` misses a secret | Acceptable risk; same redactor as the original CC `Feedback` component. Diagnostics are also truncated/capped. |

## 7. Testing Strategy

**E2E (real, tmux REPL):**
- Start OCC REPL in tmux (`bun run dev`).
- Submit `/feedback <中文问题>` with a deliberately seeded in-memory error.
- Assert: agent produces an issue, calls `gh issue create` (against a controlled repo or `--dry-run` / a sandbox token), and reports a GitHub issue URL.
- Assert: title/body reflect the seeded error and the user's question; language matches input (Chinese).
- Failure path: set `gh` to a non-existent path → assert agent prints the pre-filled `issues/new?…` URL.

**Unit (optional, light):**
- `getPromptForCommand` returns a text block containing the user's question + version + redacted error + redacted last API request + transcript snapshot; no raw `sk-ant`/`AKIA` strings survive.

## 8. Files Touched

| File | Change |
|---|---|
| `src/commands/feedback/index.ts` | Rewrite from `local` → `prompt`; implement `getPromptForCommand` with diagnostics collection + redaction + prompt assembly. |
| `test/e2e/feedback-ai.e2e.test.ts` (new) | Real e2e test driving the REPL. |

No other files changed. `src/commands/feedback/feedback.tsx` and `src/components/Feedback.tsx` left untouched (only `redactSensitiveInfo` imported from the latter).

## 9. Open Questions

None remaining — all locked in §3.
