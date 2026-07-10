# AI-Powered `/feedback` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/feedback <用户问题>` into a `prompt`-type command that collects process-exclusive diagnostics, redacts them, and hands a synthesized prompt to the main agent which files a GitHub issue on `cnwenf/occ` via `gh`.

**Architecture:** `getPromptForCommand(args, context)` collects OCC version/env/git/in-memory errors/last API request/transcript snapshot, redacts via `redactSensitiveInfo()`, returns one text block. The agent loop (main model + Bash/Read/Grep) synthesizes title+body in the user's language and runs `gh issue create`, falling back to a pre-filled `issues/new?…` URL if `gh` fails.

**Tech Stack:** Bun + TypeScript + React/Ink; OCC command system (`prompt` type); `redactSensitiveInfo` from `src/components/Feedback.tsx`; `gh` CLI for issue creation; `bun:test` for e2e.

## Global Constraints

- Command type is `prompt` (NOT `local`). Must export `getPromptForCommand(args, context): Promise<ContentBlockParam[]>` returning `[{ type: 'text', text }]`.
- `ContentBlockParam` imported from `@anthropic-ai/sdk/resources/messages.js` (matches `src/commands/review.ts:1`).
- Repo target is `cnwenf/occ` (constant `FEEDBACK_REPO`).
- All diagnostics pass through `redactSensitiveInfo()` from `../../components/Feedback.js` before embedding.
- `MACRO.VERSION` global is the version source (polyfilled in `cli.tsx`); fallback `process.env.OCC_VERSION ?? 'unknown'`.
- `env.isSSH` is a **function** — call as `env.isSSH()`.
- Issue language matches user's input language (instructed in the prompt text, not hard-coded).
- AI is hard-required: no `queryHaiku` fallback. If the agent API is down the turn fails normally.
- `gh` failure → agent prints pre-filled `https://github.com/cnwenf/occ/issues/new?title=…&body=…` URL.
- Lint (Biome) is the gate; `tsc` is NOT part of CI — loose types are fine, do not "fix" pre-existing tsc noise.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/commands/feedback/index.ts` | The `prompt` command: diagnostics collection + redaction + prompt assembly + `getPromptForCommand`. Default export. |
| `test/e2e/feedback-ai.e2e.test.ts` | E2e: source/functional (always runs) + live-agent path (opt-in via `ANTHROPIC_API_KEY`) with a fake `gh` shim. |

No other files touched. `src/commands/feedback/feedback.tsx` and `src/components/Feedback.tsx` untouched (only `redactSensitiveInfo` imported from the latter).

---

### Task 1: Rewrite `/feedback` as a `prompt` command with diagnostics collection

**Files:**
- Modify: `src/commands/feedback/index.ts` (full rewrite — currently `local` type, ~60 lines)
- Reference: `src/commands/review.ts:1-43` (the `prompt` command pattern to mirror)
- Reference: `src/components/Feedback.tsx:74-116` (`redactSensitiveInfo` source)

**Interfaces:**
- Consumes: `redactSensitiveInfo` from `../../components/Feedback.js`; `getInMemoryErrors` from `../../utils/log.js`; `getLastAPIRequest` from `../../bootstrap/state.js`; `env` from `../../utils/env.js`; `getGitState`,`getIsGit` from `../../utils/git.js`; `jsonStringify` from `../../utils/slowOperations.js`; `MACRO.VERSION` global.
- Produces: a default-exported `Command` of `type: 'prompt'` with `getPromptForCommand(args, context): Promise<ContentBlockParam[]>` registered in `src/commands.ts:16` (import already present, no change needed there).

- [ ] **Step 1: Write the failing test (source/functional — always runs, no API key)**

Create `test/e2e/feedback-ai.e2e.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

const FEEDBACK_SRC = `${REPO_ROOT}/src/commands/feedback/index.ts`

describe('/feedback command: prompt assembly + registration', () => {
  test('is a prompt-type command registered in commands.ts', async () => {
    const src = await Bun.file(FEEDBACK_SRC).text()
    expect(src).toContain("type: 'prompt'")
    expect(src).toContain('getPromptForCommand')
    expect(src).toContain("'filing feedback issue'")
    expect(src).toContain('cnwenf/occ')
  })

  test('collects + redacts diagnostics into the returned prompt', async () => {
    // Exercise the REAL getPromptForCommand, not a mock.
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const cmd = mod.default
    expect(cmd.type).toBe('prompt')

    // Seed an in-memory error + last API request via the same modules the
    // command reads from, so the prompt reflects them.
    const { addToInMemoryErrorLog, setLastAPIRequest } = await import(`${REPO_ROOT}/src/bootstrap/state.js`)
    addToInMemoryErrorLog({ error: 'TypeError: test boom at x.ts:42', timestamp: '2026-07-10T00:00:00.000Z' })
    setLastAPIRequest({ model: 'claude-sonnet-4-6', max_tokens: 8192 } as any)

    const blocks = await cmd.getPromptForCommand(
      '我的报错：TypeError: test boom',
      { messages: [], abortController: new AbortController() } as any,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    const text = (blocks[0] as { type: 'text'; text: string }).text

    // User question embedded verbatim (redacted).
    expect(text).toContain('我的报错：TypeError: test boom')
    // Seeded error survives into the prompt.
    expect(text).toContain('TypeError: test boom')
    // OCC version present.
    expect(text).toMatch(/2\.1\.204|unknown/)
    // Last API request model present.
    expect(text).toContain('claude-sonnet-4-6')
    // Agent instructions for gh submission + fallback URL.
    expect(text).toContain('gh issue create')
    expect(text).toContain('cnwenf/occ')
    expect(text).toContain('issues/new')
  })

  test('no-args returns a prompt asking the user what to report', async () => {
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const blocks = await mod.default.getPromptForCommand(
      '',
      { messages: [], abortController: new AbortController() } as any,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text.length).toBeGreaterThan(0)
    // Asks the user for their report.
    expect(text.toLowerCase()).toMatch(/ask|what|report/)
  })
})

describe('/feedback: redaction safety', () => {
  test('strips sk-ant keys from seeded errors before embedding', async () => {
    const { addToInMemoryErrorLog } = await import(`${REPO_ROOT}/src/bootstrap/state.js`)
    addToInMemoryErrorLog({
      error: 'Auth failed for key sk-ant-api03-deadbeef000000000000000000000000',
      timestamp: '2026-07-10T00:00:00.000Z',
    })
    const mod = await import(`${REPO_ROOT}/src/commands/feedback/index.ts`)
    const blocks = await mod.default.getPromptForCommand(
      'feedback about auth',
      { messages: [], abortController: new AbortController() } as any,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).not.toContain('sk-ant-api03-deadbeef')
    expect(text).toContain('[REDACTED_API_KEY]')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/e2e/feedback-ai.e2e.test.ts`
Expected: FAIL — `src/commands/feedback/index.ts` is still the old `local` command; `cmd.type` is `'local'`, no `getPromptForCommand`. The dynamic import + assertions fail.

- [ ] **Step 3: Write the implementation**

Full rewrite of `src/commands/feedback/index.ts`:

```ts
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { redactSensitiveInfo } from '../../components/Feedback.js'
import { getInMemoryErrors } from '../../utils/log.js'
import { getLastAPIRequest } from '../../bootstrap/state.js'
import { env } from '../../utils/env.js'
import { getGitState, getIsGit } from '../../utils/git.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// OCC customization: /feedback is AI-powered. It is a `prompt` command —
// getPromptForCommand collects process-exclusive diagnostics (version, env,
// git, in-memory errors, last API request, transcript snapshot), redacts
// them, and returns one text block. The main agent loop (with Bash/Read/Grep
// + reasoning) then synthesizes a GitHub issue title + body in the user's
// input language and submits it via `gh issue create` on cnwenf/occ, falling
// back to a pre-filled issues/new URL when `gh` fails.
//
// OCC is itself an agent — we do NOT call queryHaiku separately. The agent
// loop IS the AI step (hard-required by design: if the agent API is down, the
// turn fails like any agent turn and the user files manually on GitHub).

const FEEDBACK_REPO = 'cnwenf/occ'

const MAX_ERRORS = 5
const MAX_ERROR_LEN = 4000
const MAX_TRANSCRIPT_MESSAGES = 12
const MAX_TRANSCRIPT_LEN = 8000
const MAX_API_REQUEST_LEN = 6000

function getOccVersion(): string {
  try {
    const v = (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION
    if (v) return v
  } catch {
    // fall through
  }
  return process.env.OCC_VERSION ?? 'unknown'
}

interface GitInfo {
  isGit: boolean
  branchName?: string
  commitHash?: string
  remoteUrl?: string | null
  isHeadOnRemote?: boolean
  isClean?: boolean
}

async function collectGitInfo(): Promise<GitInfo> {
  try {
    const isGit = await getIsGit()
    if (!isGit) return { isGit: false }
    const state = await getGitState()
    if (!state) return { isGit: true }
    return {
      isGit: true,
      branchName: state.branchName,
      commitHash: state.commitHash,
      remoteUrl: state.remoteUrl,
      isHeadOnRemote: state.isHeadOnRemote,
      isClean: state.isClean,
    }
  } catch {
    return { isGit: false }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[truncated]`
}

// Compact redacted text snapshot of recent messages so the agent has key
// context even after compaction. Only keeps text + summarizes tool calls to
// avoid leaking large file contents or tool outputs.
function summarizeMessages(messages: unknown[]): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES)
  const lines: string[] = []
  for (const msg of recent) {
    const m = msg as { type?: string; role?: string; message?: { content?: unknown }; content?: unknown }
    const role = m.role ?? (m.type === 'assistant' ? 'assistant' : m.type === 'user' ? 'user' : m.type ?? 'unknown')
    const content = m.message?.content ?? m.content
    if (typeof content === 'string') {
      lines.push(`[${role}] ${truncate(redactSensitiveInfo(content), 1200)}`)
      continue
    }
    if (!Array.isArray(content)) {
      lines.push(`[${role}] (non-text content)`)
      continue
    }
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        lines.push(`[${role}] ${truncate(redactSensitiveInfo(b.text), 1200)}`)
      } else if (b.type === 'tool_use') {
        lines.push(`[${role} tool_use] ${b.name ?? 'unknown'}(${truncate(redactSensitiveInfo(jsonStringify(b.input ?? {})), 300)})`)
      } else if (b.type === 'tool_result') {
        const rc = typeof b.content === 'string' ? b.content : jsonStringify(b.content ?? '')
        lines.push(`[${role} tool_result] ${truncate(redactSensitiveInfo(rc), 300)}`)
      }
    }
  }
  return truncate(lines.join('\n'), MAX_TRANSCRIPT_LEN)
}

async function buildPromptText(question: string, messages: unknown[]): Promise<string> {
  const [git, errors, lastApiReq] = await Promise.all([
    collectGitInfo(),
    Promise.resolve(getInMemoryErrors()),
    Promise.resolve(getLastAPIRequest()),
  ])

  const errLines = errors
    .slice(-MAX_ERRORS)
    .map(e => `- [${e.timestamp ?? 'no-time'}] ${truncate(redactSensitiveInfo(e.error ?? ''), MAX_ERROR_LEN)}`)
    .join('\n') || '- (no in-memory errors captured this session)'

  const apiReqText = lastApiReq
    ? truncate(redactSensitiveInfo(jsonStringify(lastApiReq)), MAX_API_REQUEST_LEN)
    : '(no API request captured)'

  const transcriptText = summarizeMessages(messages)

  const gitLine = git.isGit
    ? `${git.branchName ?? 'unknown'}${git.commitHash ? `, ${git.commitHash.slice(0, 7)}` : ''}${git.remoteUrl ? ` @ ${git.remoteUrl}` : ''}${git.isHeadOnRemote === false ? ', not synced' : ''}${git.isClean === false ? ', has local changes' : ''}`
    : 'not a git repo'

  // The agent receives this prompt and does ALL the AI work: synthesize a
  // title + structured body in the user's input language, submit via gh,
  // report the URL, and on gh failure print a pre-filled issues/new URL.
  return `You are filing a GitHub issue for OCC, an independent open-source implementation of a Claude Code-style coding agent (tracks Claude Code 2.1.204, runs on Bun + TypeScript + React/Ink). The user ran \`/feedback\` with their report. You must turn it into a well-structured GitHub issue and submit it.

## Task
1. Synthesize a concise issue title (max 80 chars). Prefix with \`[Bug]\` if the report describes broken behavior, or \`[Feedback]\` if it is a suggestion/feature request. Extract the key error or symptom.
2. Compose a structured markdown issue body **in the same language the user wrote their report in** (if the report is Chinese, write Chinese; if English, write English). Use these sections:
   - **## 用户反馈 / User Report** — the user's report verbatim
   - **## AI 分析 / AI Analysis** — 2–6 bullets: restate the problem, point at the most likely failing area using the diagnostics below (error stacks, last API request, transcript), and suggest a first investigation step. Do NOT invent stack traces or file paths that are not in the diagnostics.
   - **## 环境信息 / Environment** — the environment block below
   - **## 错误日志 / Error Logs** — the error block below
   - **## 最近 API 请求 / Last API Request** — the API request block below
   - **## 最近会话 / Recent Transcript** — the transcript block below
3. Submit the issue by running: \`gh issue create --repo ${FEEDBACK_REPO} --title "<title>" --body "<body>"\` (pass title and body safely — prefer a heredoc or a temp file if the body is large).
4. Report the created issue URL back to the user.
5. If \`gh\` fails (not installed, not authed, network error), do NOT give up. Construct a pre-filled fallback URL: \`https://github.com/${FEEDBACK_REPO}/issues/new?title=<urlencoded title>&body=<urlencoded body>\` and print it so the user can open it manually.

## Rules
- Respond in the user's input language throughout.
- Any LLM/API errors mentioned are from the Anthropic API (OCC calls it), not another provider.
- The diagnostics below were auto-collected by the \`/feedback\` command and already redacted of secrets. You may quote them directly in the issue body.
- Do not include secrets. If you somehow spot one, redact it.

---
## 用户反馈 / User Report
${redactSensitiveInfo(question)}

---
## 环境信息 / Environment (auto-collected, redacted)
- OCC version: \`${getOccVersion()}\`
- Platform: \`${env.platform}\` (\`${env.arch}\`)
- Runtime: Bun on Node ${env.nodeVersion}
- Terminal: \`${env.terminal}\`
- CI: \`${env.isCI}\` / SSH: \`${env.isSSH()}\`
- Git: ${gitLine}
- Captured at: ${new Date().toISOString()}

## 错误日志 / Error Logs (in-memory, last ${MAX_ERRORS}, redacted)
${errLines}

## 最近 API 请求 / Last API Request (redacted)
\`\`\`json
${apiReqText}
\`\`\`

## 最近会话 / Recent Transcript (last ${MAX_TRANSCRIPT_MESSAGES} messages, redacted, truncated)
\`\`\`
${transcriptText || '(empty)'}
\`\`\`
`
}

const feedback: Command = {
  aliases: ['bug'],
  type: 'prompt',
  name: 'feedback',
  description: `Submit AI-triaged feedback — creates a GitHub issue on ${FEEDBACK_REPO}`,
  argumentHint: '<feedback>',
  progressMessage: 'filing feedback issue',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args: string, context): Promise<ContentBlockParam[]> {
    const text = args.trim()
    if (!text) {
      // No-args: ask the user what they want to report (one short turn, no issue filed).
      return [{
        type: 'text',
        text: 'The user ran `/feedback` with no description. Ask them what they want to report (a bug, a feature request, or general feedback), then file it as a GitHub issue on cnwenf/occ as described in the /feedback workflow.',
      }]
    }
    const promptText = await buildPromptText(text, context.messages)
    return [{ type: 'text', text: promptText }]
  },
}

export default feedback
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/e2e/feedback-ai.e2e.test.ts`
Expected: PASS — all 5 tests green (command is `prompt` type, prompt contains user question + seeded error + version + API model + gh instructions + issues/new fallback; no-args asks the user; redaction strips `sk-ant`).

- [ ] **Step 5: Lint + commit**

Run: `bun run lint`
Expected: clean on the new file (pre-existing noise elsewhere is fine).

```bash
git add src/commands/feedback/index.ts test/e2e/feedback-ai.e2e.test.ts
git commit -m "feat(feedback): AI-powered /feedback as prompt command

getPromptForCommand collects OCC version/env/git, in-memory errors,
last API request, and a redacted transcript snapshot, then hands a
synthesized prompt to the main agent which files a GitHub issue on
cnwenf/occ via gh (pre-filled issues/new URL fallback on gh failure).
No separate queryHaiku call — OCC is itself the agent.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Live-agent e2e with a fake `gh` shim (opt-in)

This task adds a real agent-turn e2e that runs only when `ANTHROPIC_API_KEY` is present. It uses a fake `gh` on `PATH` so no real GitHub issue is created — the shim asserts the title/body content and prints a fake issue URL.

**Files:**
- Modify: `test/e2e/feedback-ai.e2e.test.ts` (append a new `describe` block)
- Reference: `test/e2e/helpers.ts` (`runOcc`, `REPO_ROOT`, `tempFile`)

**Interfaces:**
- Consumes: `runOcc` from `./helpers`; `ANTHROPIC_API_KEY` env (live agent); a temp `bin/gh` shim.
- Produces: a guarded live test that the CI skips when no API key is set.

- [ ] **Step 1: Write the failing test (append to the existing file)**

Append this `describe` block at the end of `test/e2e/feedback-ai.e2e.test.ts` (add the imports at the top of the file):

```ts
// add to existing imports at top:
import { writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOcc } from './helpers'

// append at end of file:
const hasApiKey = !!process.env.ANTHROPIC_API_KEY
const live = hasApiKey ? describe : describe.skip

live('/feedback: live agent files an issue via fake gh', () => {
  test('agent runs gh issue create with a title+body reflecting the report', async () => {
    // Fake gh shim: asserts args, writes them to a capture file, prints a fake URL.
    const binDir = mkdtempSync(join(tmpdir(), 'occ-gh-shim-'))
    const capturePath = join(binDir, 'capture.json')
    const shim = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let title = '', body = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--title' && i + 1 < args.length) { title = args[++i]; }
  else if (args[i] === '--body' && i + 1 < args.length) { body = args[++i]; }
}
fs.writeFileSync('${capturePath}', JSON.stringify({ title, body, args }));
// Print a fake issue URL — the agent reports this back.
console.log('https://github.com/cnwenf/occ/issues/99999');
`
    const ghPath = join(binDir, 'gh')
    writeFileSync(ghPath, shim)
    chmodSync(ghPath, 0o755)

    try {
      // Run OCC in pipe mode with /feedback. --dangerously-skip-permissions
      // so gh (the shim) runs without a permission prompt.
      const result = await runOcc(
        ['-p', '--dangerously-skip-permissions', '/feedback 测试报错：TypeError: live boom at app.ts:10'],
        { PATH: `${binDir}:${process.env.PATH ?? ''}` },
        180_000,
      )

      // Agent should have run gh and printed the fake URL.
      expect(result.stdout + result.stderr).toContain('https://github.com/cnwenf/occ/issues/99999')

      // The shim captured the title + body the agent synthesized.
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'))
      expect(captured.title.length).toBeLessThanOrEqual(80)
      expect(captured.title).toMatch(/^\[Bug\]|^\[Feedback\]/)
      expect(captured.body).toContain('live boom')
      expect(captured.body).toMatch(/用户反馈|User Report/)
      expect(captured.body).toMatch(/环境信息|Environment/)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 200_000)
})
```

- [ ] **Step 2: Run the test (skipped without API key; live with one)**

Run: `bun test test/e2e/feedback-ai.e2e.test.ts`
Expected without `ANTHROPIC_API_KEY`: the `live` describe is skipped, the Task-1 tests still pass.
Expected with `ANTHROPIC_API_KEY`: the live test runs the agent, the fake `gh` captures title+body, the assertions pass.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/feedback-ai.e2e.test.ts
git commit -m "test(feedback): live-agent e2e with fake gh shim

Opt-in via ANTHROPIC_API_KEY: drives /feedback through the real agent
loop, asserts the synthesized title/body reflect the report and the
agent reports the gh-created issue URL. Uses a PATH shim for gh so no
real GitHub issue is created.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §3 command type `prompt` → Task 1 Step 3 (`type: 'prompt'`). ✅
- §3 issue language = match user → Task 1 prompt text ("in the same language the user wrote"). ✅
- §3 AI hard-required → no `queryHaiku` in impl; Global Constraints + design note. ✅
- §3 gh-failure pre-filled URL → prompt Step 5 instruction + test asserts `issues/new` presence. ✅
- §4.2 collect version/env/git/errors/API request/transcript → `buildPromptText`. ✅
- §4.2 redact via `redactSensitiveInfo` → every collected string wrapped. ✅
- §4.2 agent submits via `gh issue create` → prompt Task instruction. ✅
- §6 no-args → guard in `getPromptForCommand` + dedicated test. ✅
- §7 e2e (source/functional always + live opt-in) → Task 1 Step 1 + Task 2. ✅
- §8 only `index.ts` + new e2e file touched. ✅

**2. Placeholder scan:** none — every step has complete code/commands.

**3. Type consistency:** `ContentBlockParam` import path matches `review.ts:1`. `getPromptForCommand(args, context)` signature matches `types/command.ts:63-66`. `redactSensitiveInfo`, `getInMemoryErrors`, `getLastAPIRequest`, `getGitState`/`getIsGit`, `jsonStringify`, `env.isSSH()` all verified against source. `Command` default-export shape matches `review.ts:33-43`.
