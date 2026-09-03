/**
 * Shell-agnostic git operation tracking for usage metrics.
 *
 * Detects `git commit`, `git push`, `gh pr <verb>` (create/edit/merge/comment/
 * close/reopen/ready), `glab mr <verb>` (create/update/merge/note/close/
 * reopen — CC 2.1.259 entry 003), and curl-based PR creation in command
 * strings, then increments OTLP counters and fires analytics events. The
 * regexes operate on raw command text so they work identically for Bash and
 * PowerShell (both invoke git/gh/glab/curl as external binaries with the same
 * argv syntax).
 */

import { getCommitCounter, getPrCounter } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { tailFile } from '../../utils/fsOperations.js'

/**
 * 2.1.205 #8: When `gh pr create` output exceeds the inline limit (~30K),
 * `result.stdout` is truncated to the first chunk and the PR URL — which gh
 * prints at the END of its output — is lost, so `findPrInStdout` never sees it
 * and the session is never linked to the PR.
 *
 * The fix reads the last `GIT_OUTPUT_TAIL_BYTES` of the output file (the tail,
 * where the URL lives) and appends it to the truncated stdout before scanning.
 * Mirrors the binary's `_zn(stdout, outputFilePath)` helper:
 *   `if(!t)return e; try{let{content:r}=await FR(t,ncg); return r?`${e}\n${r}`:e} catch{return e}`
 * where `FR(path, 8192)` reads the last 8192 bytes (`tailFile` here) and
 * `ncg = 8192`.
 *
 * No-op when `outputFilePath` is unset (output fit inline, or the shell didn't
 * file-back the output). Returns `stdout` unchanged on any read error.
 */
const GIT_OUTPUT_TAIL_BYTES = 8192

export async function getStdoutWithGitTail(
  stdout: string,
  outputFilePath?: string,
): Promise<string> {
  if (!outputFilePath) return stdout
  try {
    const { content } = await tailFile(outputFilePath, GIT_OUTPUT_TAIL_BYTES)
    return content ? `${stdout}\n${content}` : stdout
  } catch {
    return stdout
  }
}

/**
 * Build a regex that matches `git <subcmd>` while tolerating git's global
 * options between `git` and the subcommand (e.g. `-c key=val`, `-C path`,
 * `--git-dir=path`). Common when the model retries with
 * `git -c commit.gpgsign=false commit` after a signing failure.
 */
function gitCmdRe(subcmd: string, suffix = ''): RegExp {
  return new RegExp(
    `\\bgit(?:\\s+-[cC]\\s+\\S+|\\s+--\\S+=\\S+)*\\s+${subcmd}\\b${suffix}`,
  )
}

const GIT_COMMIT_RE = gitCmdRe('commit')
const GIT_PUSH_RE = gitCmdRe('push')
const GIT_CHERRY_PICK_RE = gitCmdRe('cherry-pick')
const GIT_MERGE_RE = gitCmdRe('merge', '(?!-)')
const GIT_REBASE_RE = gitCmdRe('rebase')

export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction =
  | 'created'
  | 'edited'
  | 'merged'
  | 'commented'
  | 'closed'
  | 'reopened'
  | 'ready'
  | 'draft'
  | 'auto-merge-enabled'
  | 'auto-merge-disabled'

/**
 * gh PR verb table — binary `Tot` (2.1.258) / `FLe` (2.1.259), byte-verified.
 * The 2.1.259 table is identical to 2.1.258 (reopen included in both).
 */
const GH_PR_ACTIONS: readonly { re: RegExp; action: PrAction; op: string }[] = [
  { re: /\bgh\s+pr\s+create\b/, action: 'created', op: 'pr_create' },
  { re: /\bgh\s+pr\s+edit\b/, action: 'edited', op: 'pr_edit' },
  { re: /\bgh\s+pr\s+merge\b/, action: 'merged', op: 'pr_merge' },
  { re: /\bgh\s+pr\s+comment\b/, action: 'commented', op: 'pr_comment' },
  { re: /\bgh\s+pr\s+close\b/, action: 'closed', op: 'pr_close' },
  { re: /\bgh\s+pr\s+reopen\b/, action: 'reopened', op: 'pr_reopen' },
  { re: /\bgh\s+pr\s+ready\b/, action: 'ready', op: 'pr_ready' },
]

/**
 * glab MR verb table — binary `Aat`, added in 2.1.259 (changelog entry 003),
 * byte-verified. Lets GitLab merge requests surface in the collapsed tool
 * summary and telemetry the same way gh PRs do.
 */
const GLAB_MR_ACTIONS: readonly {
  re: RegExp
  action: PrAction
  op: string
}[] = [
  { re: /\bglab\s+mr\s+create\b/, action: 'created', op: 'pr_create' },
  { re: /\bglab\s+mr\s+update\b/, action: 'edited', op: 'pr_edit' },
  { re: /\bglab\s+mr\s+merge\b/, action: 'merged', op: 'pr_merge' },
  { re: /\bglab\s+mr\s+note\b/, action: 'commented', op: 'pr_comment' },
  { re: /\bglab\s+mr\s+close\b/, action: 'closed', op: 'pr_close' },
  { re: /\bglab\s+mr\s+reopen\b/, action: 'reopened', op: 'pr_reopen' },
]

/**
 * Quoted-argument stripper — binary `Iue` (2.1.259), byte-verified. Flag
 * checks below run on the command with quoted strings blanked so flag-shaped
 * text inside quotes (e.g. a commit message containing `--auto`) is ignored.
 */
const QUOTED_ARGS_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g

/**
 * Resolve the effective PR/MR action of a command — binary `Rat` (2.1.259),
 * byte-verified. The gh table wins when it matches, with
 * `gh pr merge --auto/--disable-auto` and `gh pr ready --undo` refinements;
 * otherwise the glab table applies, with `glab mr update --ready/--draft`
 * refinements. Returns undefined when no PR/MR verb is present.
 */
export function resolvePrAction(command: string): PrAction | undefined {
  const ghAction = GH_PR_ACTIONS.find(a => a.re.test(command))?.action
  const unquoted = command.replace(QUOTED_ARGS_RE, ' ')
  if (ghAction === 'merged') {
    if (/--disable-auto\b/.test(unquoted)) return 'auto-merge-disabled'
    if (/--auto\b/.test(unquoted)) return 'auto-merge-enabled'
  } else if (ghAction === 'ready' && /--undo\b/.test(unquoted)) {
    return 'draft'
  }
  if (ghAction) return ghAction
  const glabAction = GLAB_MR_ACTIONS.find(a => a.re.test(command))?.action
  if (glabAction === 'edited') {
    if (/--ready\b/.test(unquoted)) return 'ready'
    if (/--draft\b/.test(unquoted)) return 'draft'
  }
  return glabAction
}

/**
 * PR/MR URL family matcher — binary `wgt` (2.1.259), byte-verified. Covers
 * GitHub `pull`, Bitbucket `pull-requests`, and GitLab `-/merge_requests`
 * URLs. (The 2.1.259 Gerrit URL matcher `Dvn` is staged — see
 * docs/upstream-version-gap-occ114.md.)
 */
const PR_URL_RE =
  /https?:\/\/[^/\s"]+\/([^\s"]+?)\/(?:pull|pull-requests|-\/merge_requests)\/(\d+)/

/**
 * GitLab MR URL check — binary `e6` (2.1.259), byte-verified. Drives the
 * `MR !N` label and the `kind: 'mr'` badge form.
 */
export function isMrUrl(url: string): boolean {
  return /\/-\/merge_requests\/\d/.test(url)
}

/** URL length cap for badge rendering — binary `wje` (2.1.259). */
export const PR_BADGE_URL_MAX_LENGTH = 2048

/**
 * Parse PR/MR info from a PR-family URL.
 * Returns { prNumber, prUrl, prRepository } or null if not a valid PR URL.
 */
function parsePrUrl(
  url: string,
): { prNumber: number; prUrl: string; prRepository: string } | null {
  const match = url.match(PR_URL_RE)
  if (match?.[1] && match?.[2]) {
    return {
      prNumber: parseInt(match[2], 10),
      prUrl: url,
      prRepository: match[1],
    }
  }
  return null
}

/**
 * Find PR/MR URLs embedded anywhere in stdout and parse the LAST one —
 * binary `Pat` (2.1.259), byte-verified: tools print the new PR/MR URL at
 * the end of their output, and earlier URLs in the same output (e.g. from
 * `gh pr view` noise) must not win.
 */
function findPrInStdout(stdout: string): ReturnType<typeof parsePrUrl> {
  const matches = stdout.match(new RegExp(PR_URL_RE.source, 'g'))
  if (!matches) return null
  const last = matches.at(-1)
  return last !== undefined ? parsePrUrl(last) : null
}

// Exported for testing purposes
export function parseGitCommitId(stdout: string): string | undefined {
  // git commit output: [branch abc1234] message
  // or for root commit: [branch (root-commit) abc1234] message
  const match = stdout.match(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]+)\]/)
  return match?.[1]
}

/**
 * Parse branch name from git push output. Push writes progress to stderr but
 * the ref update line ("abc..def  branch -> branch", "* [new branch]
 * branch -> branch", or " + abc...def  branch -> branch (forced update)") is
 * the signal. Works on either stdout or stderr. Git prefixes each ref line
 * with a status flag (space, +, -, *, !, =); the char class tolerates any.
 */
function parseGitPushBranch(output: string): string | undefined {
  const match = output.match(
    /^\s*[+\-*!= ]?\s*(?:\[new branch\]|\S+\.\.+\S+)\s+\S+\s*->\s*(\S+)/m,
  )
  return match?.[1]
}

/**
 * gh pr merge/close/ready print "✓ <Verb> pull request owner/repo#1234" with
 * no URL. Extract the PR number from the text.
 */
function parsePrNumberFromText(stdout: string): number | undefined {
  const match = stdout.match(/[Pp]ull request (?:\S+#)?#?(\d+)/)
  return match?.[1] ? parseInt(match[1], 10) : undefined
}

/**
 * Extract target ref from `git merge <ref>` / `git rebase <ref>` command.
 * Skips flags and keywords — first non-flag argument is the ref.
 */
function parseRefFromCommand(
  command: string,
  verb: string,
): string | undefined {
  const after = command.split(gitCmdRe(verb))[1]
  if (!after) return undefined
  for (const t of after.trim().split(/\s+/)) {
    if (/^[&|;><]/.test(t)) break
    if (t.startsWith('-')) continue
    return t
  }
  return undefined
}

/**
 * Scan bash command + output for git operations worth surfacing in the
 * collapsed tool-use summary ("committed a1b2c3, created PR #42, ran 3 bash
 * commands"). Checks the command to avoid matching SHAs/URLs that merely
 * appear in unrelated output (e.g. `git log`).
 *
 * Pass stdout+stderr concatenated — git push writes the ref update to stderr.
 */
export function detectGitOperation(
  command: string,
  output: string,
): {
  commit?: { sha: string; kind: CommitKind }
  push?: { branch: string }
  branch?: { ref: string; action: BranchAction }
  pr?: { number: number; url?: string; action: PrAction }
} {
  const result: ReturnType<typeof detectGitOperation> = {}
  // commit and cherry-pick both produce "[branch sha] msg" output
  const isCherryPick = GIT_CHERRY_PICK_RE.test(command)
  if (GIT_COMMIT_RE.test(command) || isCherryPick) {
    const sha = parseGitCommitId(output)
    if (sha) {
      result.commit = {
        sha: sha.slice(0, 6),
        kind: isCherryPick
          ? 'cherry-picked'
          : /--amend\b/.test(command)
            ? 'amended'
            : 'committed',
      }
    }
  }
  if (GIT_PUSH_RE.test(command)) {
    const branch = parseGitPushBranch(output)
    if (branch) result.push = { branch }
  }
  if (
    GIT_MERGE_RE.test(command) &&
    /(Fast-forward|Merge made by)/.test(output)
  ) {
    const ref = parseRefFromCommand(command, 'merge')
    if (ref) result.branch = { ref, action: 'merged' }
  }
  if (GIT_REBASE_RE.test(command) && /Successfully rebased/.test(output)) {
    const ref = parseRefFromCommand(command, 'rebase')
    if (ref) result.branch = { ref, action: 'rebased' }
  }
  // Binary `Rat` over the command (2.1.259): gh verbs first, then glab. The
  // text-number fallback is gh-only — binary: `else if(FLe.some(...))` — glab
  // output text ("merge request !N") is not parsed for a bare number.
  const prAction = resolvePrAction(command)
  if (prAction) {
    const pr = findPrInStdout(output)
    if (pr) {
      result.pr = { number: pr.prNumber, url: pr.prUrl, action: prAction }
    } else if (GH_PR_ACTIONS.some(a => a.re.test(command))) {
      const num = parsePrNumberFromText(output)
      if (num) result.pr = { number: num, action: prAction }
    }
  }
  return result
}

// Exported for testing purposes
export function trackGitOperations(
  command: string,
  exitCode: number,
  stdout?: string,
): void {
  const success = exitCode === 0
  if (!success) {
    return
  }

  if (GIT_COMMIT_RE.test(command)) {
    logEvent('tengu_git_operation', {
      operation:
        'commit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (command.match(/--amend\b/)) {
      logEvent('tengu_git_operation', {
        operation:
          'commit_amend' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    getCommitCounter()?.add(1)
  }
  if (GIT_PUSH_RE.test(command)) {
    logEvent('tengu_git_operation', {
      operation:
        'push' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  // Binary (2.1.259): `let v=FLe.find(...),x=Aat.find(...),F=v??x` — the
  // first gh hit wins, otherwise the first glab hit; both emit their op.
  const ghHit = GH_PR_ACTIONS.find(a => a.re.test(command))
  const glabHit = GLAB_MR_ACTIONS.find(a => a.re.test(command))
  const prHit = ghHit ?? glabHit
  if (prHit) {
    logEvent('tengu_git_operation', {
      operation:
        prHit.op as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  // Binary (2.1.259): `if(v?.action==="created"){...} else if(x?.action==="created"){...}`
  // — both branches bump the PR counter and link the session to the new
  // PR/MR found in stdout.
  if (ghHit?.action === 'created' || glabHit?.action === 'created') {
    getPrCounter()?.add(1)
    // Auto-link session to PR if we can extract PR URL from stdout
    if (stdout) {
      const prInfo = findPrInStdout(stdout)
      if (prInfo) {
        // Import is done dynamically to avoid circular dependency
        void import('../../utils/sessionStorage.js').then(
          ({ linkSessionToPR }) => {
            void import('../../bootstrap/state.js').then(({ getSessionId }) => {
              const sessionId = getSessionId()
              if (sessionId) {
                void linkSessionToPR(
                  sessionId as `${string}-${string}-${string}-${string}-${string}`,
                  prInfo.prNumber,
                  prInfo.prUrl,
                  prInfo.prRepository,
                )
              }
            })
          },
        )
      }
    }
  }
  // Detect PR creation via curl to REST APIs (Bitbucket, GitHub API, GitLab API)
  // Check for POST method and PR endpoint separately to handle any argument order
  // Also detect implicit POST when -d is used (curl defaults to POST with data)
  const isCurlPost =
    command.match(/\bcurl\b/) &&
    (command.match(/-X\s*POST\b/i) ||
      command.match(/--request\s*=?\s*POST\b/i) ||
      command.match(/\s-d\s/))
  // Match PR endpoints in URLs, but not sub-resources like /pulls/123/comments
  // Require https?:// prefix to avoid matching text in POST body or other params
  const isPrEndpoint = command.match(
    /https?:\/\/[^\s'"]*\/(pulls|pull-requests|merge[-_]requests)(?!\/\d)/i,
  )
  if (isCurlPost && isPrEndpoint) {
    logEvent('tengu_git_operation', {
      operation:
        'pr_create' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    getPrCounter()?.add(1)
  }
}
