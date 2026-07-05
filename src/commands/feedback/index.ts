import type { Command } from '../../commands.js'
import { execFileSync } from 'node:child_process'

// OCC customization: /feedback creates a GitHub issue on the OCC repo
// (cnwenf/occ) instead of submitting to Anthropic. Uses the `gh` CLI when
// available and authenticated; otherwise returns a pre-filled issue URL.

const FEEDBACK_REPO = 'cnwenf/occ'

function createGitHubIssue(title: string, body: string): { ok: boolean; url?: string; error?: string } {
  try {
    const out = execFileSync('gh', ['issue', 'create', '--repo', FEEDBACK_REPO, '--title', title, '--body', body], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = out.trim().split('\n')[0]
    if (url) return { ok: true, url }
    return { ok: false, error: 'gh returned no URL' }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

const feedback = {
  aliases: ['bug'],
  type: 'local',
  name: 'feedback',
  description: `Submit feedback — opens a GitHub issue on ${FEEDBACK_REPO}`,
  argumentHint: '<feedback>',
  supportsNonInteractive: true,
  isEnabled: () => true,
  async load() {
    return {
      async call(args: string) {
        const text = args.trim()
        const usage = `Usage: /feedback <description> — creates a GitHub issue on https://github.com/${FEEDBACK_REPO}/issues`
        if (!text) return { type: 'text' as const, value: usage }
        const title = text.length > 80 ? `${text.slice(0, 77)}...` : text
        const body = `Feedback submitted via \`/feedback\`:\n\n${text}\n\n- occ version: \`${process.env.OCC_VERSION ?? 'unknown'}\``
        const r = createGitHubIssue(title, body)
        if (r.ok && r.url) {
          return { type: 'text' as const, value: `✓ Issue created: ${r.url}` }
        }
        // Fallback: pre-filled issue URL for manual submission.
        const url = `https://github.com/${FEEDBACK_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
        return {
          type: 'text' as const,
          value: `Could not create the issue automatically (${r.error}). Please open one manually:\n${url}`,
        }
      },
    }
  },
} satisfies Command

export default feedback
