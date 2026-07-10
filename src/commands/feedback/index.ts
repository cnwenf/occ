import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { readErrorLogTail } from '../../utils/diskErrorLog.js'
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

// Redact secrets from any string before it reaches the model or GitHub.
// Mirrors the redactor in src/components/Feedback.tsx so behavior stays
// consistent with the original CC feedback path. Inlined here (rather than
// imported) to avoid a runtime cycle: Feedback.tsx transitively pulls in
// services/api/claude.ts → commands.ts, which references this module's
// default export at init time (TDZ).
function redactSensitiveInfo(text: string): string {
  let redacted = text

  // Anthropic API keys (sk-ant...) with or without quotes
  redacted = redacted.replace(/"(sk-ant[^\s"']{24,})"/g, '"[REDACTED_API_KEY]"')
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, string) on /bug path: no-match returns same string
  redacted = redacted.replace(
    /(?<![A-Za-z0-9"'])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9"'])/g,
    '[REDACTED_API_KEY]',
  )

  // AWS keys - AWSXXXX format
  redacted = redacted.replace(
    /AWS key: "(AWS[A-Z0-9]{20,})"/g,
    'AWS key: "[REDACTED_AWS_KEY]"',
  )
  // AWS AKIAXXX keys
  redacted = redacted.replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]')

  // Google Cloud keys
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
  redacted = redacted.replace(
    /(?<![A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_KEY]',
  )

  // Vertex AI service account keys
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
  redacted = redacted.replace(
    /(?<![A-Za-z0-9])([a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  )

  // Generic API keys in headers
  redacted = redacted.replace(
    /(["']?x-api-key["']?\s*[:=]\s*["']?)[^"',\s)}\]]+/gi,
    '$1[REDACTED_API_KEY]',
  )

  // Authorization headers and Bearer tokens
  redacted = redacted.replace(
    /(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^"',\s)}\]]+/gi,
    '$1[REDACTED_TOKEN]',
  )

  // AWS environment variables
  redacted = redacted.replace(
    /(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED_AWS_VALUE]',
  )

  // GCP environment variables
  redacted = redacted.replace(
    /(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED_GCP_VALUE]',
  )

  // Environment variables with keys
  redacted = redacted.replace(
    /((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED]',
  )
  return redacted
}

const MAX_ERRORS = 20
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
    const m = msg as {
      type?: string
      role?: string
      message?: { content?: unknown }
      content?: unknown
    }
    const role =
      m.role ??
      (m.type === 'assistant'
        ? 'assistant'
        : m.type === 'user'
          ? 'user'
          : (m.type ?? 'unknown'))
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
      const b = block as {
        type?: string
        text?: string
        name?: string
        input?: unknown
        content?: unknown
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        lines.push(`[${role}] ${truncate(redactSensitiveInfo(b.text), 1200)}`)
      } else if (b.type === 'tool_use') {
        lines.push(
          `[${role} tool_use] ${b.name ?? 'unknown'}(${truncate(
            redactSensitiveInfo(jsonStringify(b.input ?? {})),
            300,
          )})`,
        )
      } else if (b.type === 'tool_result') {
        const rc =
          typeof b.content === 'string' ? b.content : jsonStringify(b.content ?? '')
        lines.push(
          `[${role} tool_result] ${truncate(redactSensitiveInfo(rc), 300)}`,
        )
      }
    }
  }
  return truncate(lines.join('\n'), MAX_TRANSCRIPT_LEN)
}

async function buildPromptText(
  question: string,
  messages: unknown[],
): Promise<string> {
  const [git, memErrors, diskTail, lastApiReq] = await Promise.all([
    collectGitInfo(),
    Promise.resolve(getInMemoryErrors()),
    // Disk tail is best-effort — on read failure, fall back to memory only.
    readErrorLogTail(40).catch(() => []),
    Promise.resolve(getLastAPIRequest()),
  ])

  // Merge in-memory + disk tail, normalize to { timestamp, errorText }.
  const normalized: Array<{ timestamp: string; errorText: string }> = [
    ...memErrors.map(e => ({
      timestamp: e.timestamp ?? '',
      errorText: e.error ?? '',
    })),
    ...diskTail.map(e => ({
      timestamp: e.ts ?? '',
      errorText: e.stack ?? e.message ?? '',
    })),
  ]

  // Dedupe by (timestamp[:19]=seconds-precision, errorText[:200]) so the same
  // error captured to both memory + disk only appears once. Seconds precision
  // tolerates the sub-ms gap between the two new Date().toISOString() calls.
  const seen = new Set<string>()
  const deduped: typeof normalized = []
  for (const e of normalized) {
    const key = `${e.timestamp.slice(0, 19)}|${e.errorText.slice(0, 200)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(e)
  }

  // Sort by timestamp ascending, take the most recent MAX_ERRORS.
  deduped.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
  const recentErrors = deduped.slice(-MAX_ERRORS)

  const errLines =
    recentErrors
      .map(
        e =>
          `- [${e.timestamp || 'no-time'}] ${truncate(
            redactSensitiveInfo(e.errorText),
            MAX_ERROR_LEN,
          )}`,
      )
      .join('\n') || '- (no errors captured)'

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

## 错误日志 / Error Logs (in-memory + disk tail, last ${MAX_ERRORS}, redacted)
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
  isEnabled: () =>
    !isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) &&
    !isEnvTruthy(process.env.DISABLE_BUG_COMMAND),
  async getPromptForCommand(
    args: string,
    context,
  ): Promise<ContentBlockParam[]> {
    const text = args.trim()
    if (!text) {
      // No-args: ask the user what they want to report (one short turn, no issue filed).
      return [
        {
          type: 'text',
          text: 'The user ran `/feedback` with no description. Ask them what they want to report (a bug, a feature request, or general feedback), then file it as a GitHub issue on cnwenf/occ as described in the /feedback workflow.',
        },
      ]
    }
    const promptText = await buildPromptText(text, context.messages)
    return [{ type: 'text', text: promptText }]
  },
}

export default feedback
