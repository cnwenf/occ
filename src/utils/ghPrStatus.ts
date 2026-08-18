import { execFileNoThrow } from './execFileNoThrow.js'
import { fetchMrStatus } from './glabMrStatus.js'
import { getBranch, getDefaultBranch, getIsGit } from './git.js'
import { jsonParse } from './slowOperations.js'

export type PrReviewState =
  | 'approved'
  | 'pending'
  | 'changes_requested'
  | 'draft'
  | 'merged'
  | 'closed'

export type PrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
  /** CC 2.1.234: 'mr' when the status came from the GitLab `glab`
   * fallback; absent/'pr' for the GitHub `gh` path. The footer badge renders
   * `!N` + "MR" for merge requests, `#N` + "PR" otherwise. */
  kind?: 'pr' | 'mr'
}

const GH_TIMEOUT_MS = 5000

/**
 * Derive review state from GitHub API values.
 * Draft PRs always show as 'draft' regardless of reviewDecision.
 * reviewDecision can be: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty string.
 */
export function deriveReviewState(
  isDraft: boolean,
  reviewDecision: string,
): PrReviewState {
  if (isDraft) return 'draft'
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    default:
      return 'pending'
  }
}

/**
 * Fetch PR status for the current branch using `gh pr view`.
 * Returns null on any failure (gh not installed, no PR, not in git repo, etc).
 * Also returns null if the PR's head branch is the default branch (e.g., main/master).
 *
 * CC 2.1.234 (binary `bpp`): when the `gh` path finds nothing, falls back to
 * the GitLab `glab` MR poller (`fetchMrStatus`) so repos hosted on GitLab get
 * a footer badge too. The 'fetch-failed' sentinel collapses to null here —
 * OCC has no poller-bad-streak consumer for it.
 */
export async function fetchPrStatus(): Promise<PrStatus | null> {
  const isGit = await getIsGit()
  if (!isGit) return null

  // Skip on the default branch — the pollers return the most recently
  // associated PR/MR there, which is misleading. Mirrors the official
  // top-level gate (binary `bpp`: current-branch === default-branch → null
  // before either the gh or glab path runs).
  const [branch, defaultBranch] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
  ])
  if (branch === defaultBranch) return null

  const ghStatus = await fetchGhPrStatus(defaultBranch)
  if (ghStatus !== null) return ghStatus

  const mrStatus = await fetchMrStatus()
  if (mrStatus === 'fetch-failed') return null
  return mrStatus
}

async function fetchGhPrStatus(
  defaultBranch: string,
): Promise<PrStatus | null> {
  const { stdout, code } = await execFileNoThrow(
    'gh',
    [
      'pr',
      'view',
      '--json',
      'number,url,reviewDecision,isDraft,headRefName,state',
    ],
    { timeout: GH_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (code !== 0 || !stdout.trim()) return null

  try {
    const data = jsonParse(stdout) as {
      number: number
      url: string
      reviewDecision: string
      isDraft: boolean
      headRefName: string
      state: string
    }

    // Don't show PR status for PRs from the default branch (e.g., main, master)
    // This can happen when someone opens a PR from main to another branch
    if (
      data.headRefName === defaultBranch ||
      data.headRefName === 'main' ||
      data.headRefName === 'master'
    ) {
      return null
    }

    // Don't show PR status for merged or closed PRs — `gh pr view` returns
    // the most recently associated PR for a branch, which may be merged/closed.
    // The status line should only display open PRs.
    if (data.state === 'MERGED' || data.state === 'CLOSED') {
      return null
    }

    return {
      number: data.number,
      url: data.url,
      reviewState: deriveReviewState(data.isDraft, data.reviewDecision),
      kind: 'pr',
    }
  } catch {
    return null
  }
}
