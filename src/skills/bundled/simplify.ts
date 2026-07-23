import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { registerBundledSkill } from '../bundledSkills.js'

// 2.1.147: Renamed /simplify to /code-review (old name still works as alias).
// 2.1.154 (E14): Split back apart. /code-review hunts for correctness bugs AND
//   cleanups (effort-scoped, --fix/--comment); /simplify is a CLEANUP-ONLY review
//   that applies fixes (no bug hunting — "use /code-review for that").
// 2.1.196 (E15): /code-review's Find phase uses one finder per correctness angle
//   plus ONE merged finder covering all cleanup angles (was one finder per cleanup
//   angle), capped at (cleanup-angle count × perAngle).

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CODE_REVIEW_ARGUMENT_HINT =
  '[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]'

// 2.1.204 (#19): /code-review <level> <pr#>. The <target> may be a PR number,
// a branch name, or omitted (reviews the current working diff). Mirrors the
// official usage message: "PR number, a branch name, or no argument".
const CODE_REVIEW_USAGE = `Usage: /code-review ${CODE_REVIEW_ARGUMENT_HINT}

Multi-agent code review at a chosen effort level. The target may be a PR number, a branch name, or no argument (reviews your current working diff).

- Effort: ${EFFORT_LEVELS.join(', ')} (default: high). Lower levels return fewer, high-confidence findings; higher levels broaden coverage and may include uncertain findings.
- --fix: apply the verified findings to the working tree after the review.
- --comment: post the verified findings as inline PR comments.

Examples:
  /code-review                # review your working diff at high effort
  /code-review medium         # review working diff at medium effort
  /code-review high 1234      # review GitHub PR #1234 at high effort
  /code-review max --fix 1234 # review PR #1234 at max effort and apply fixes`

// Per-effort finder budget. high/xhigh/max are verbatim from the official
// 2.1.200 binary; low/medium are the smaller tiers that precede them.
const EFFORT_CONFIG: Record<
  string,
  { correctnessAngles: number; perAngle: number; maxFindings: number; sweep: boolean }
> = {
  low: { correctnessAngles: 1, perAngle: 3, maxFindings: 3, sweep: false },
  medium: { correctnessAngles: 2, perAngle: 5, maxFindings: 6, sweep: false },
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
}

const CORRECTNESS_ANGLES = [
  'Logic / state correctness',
  'Error / edge-case handling',
  'Concurrency / ordering',
  'API / contract conformance',
  'Security / data integrity',
]

const CLEANUP_ANGLES = [
  'Reuse (duplicate of an existing utility)',
  'Simplification (redundant state, copy-paste, leaky abstractions)',
  'Efficiency (unnecessary work, missed concurrency, hot-path bloat)',
  'Altitude (unnecessary comments, wrapper noise, stringly-typed code)',
]

const CODE_REVIEW_PROMPT = (opts: {
  effort: string
  fix: boolean
  comment: boolean
  target: string
  prNumber?: string
}) => {
  const cfg = EFFORT_CONFIG[opts.effort] ?? EFFORT_CONFIG.high
  const cleanupBudget = CLEANUP_ANGLES.length * cfg.perAngle
  // 2.1.204 (#19): a numeric target is a GitHub PR number — fetch its diff
  // with `gh pr diff` instead of the local working diff.
  const targetLine = opts.prNumber
    ? `\nReview target: GitHub pull request #${opts.prNumber}\n`
    : opts.target
      ? `\nReview target: \`${opts.target}\`\n`
      : ''
  const modeLine = opts.fix
    ? '\nMode: --fix — apply the verified findings to the working tree after the review.\n'
    : opts.comment
      ? '\nMode: --comment — post the verified findings as inline PR comments.\n'
      : '\nMode: report only — present findings; do not edit files.\n'
  const scopePhase = opts.prNumber
    ? `This reviews GitHub PR #${opts.prNumber}. Run \`gh pr view ${opts.prNumber}\` for context (title, description, base) and \`gh pr diff ${opts.prNumber}\` to get the unified diff under review. Review ONLY the PR diff — do not use the local working diff.`
    : `Run \`git diff\` (or \`git diff HEAD\` if staged changes exist) to gather the changed files, applicable CLAUDE.md files, and conventions. If there are no git changes, review the most recently modified files.`
  return `# Code Review${targetLine}${modeLine}
Effort: ${opts.effort} → { correctnessAngles: ${cfg.correctnessAngles}, perAngle: ${cfg.perAngle}, maxFindings: ${cfg.maxFindings}, sweep: ${cfg.sweep} }

Workflow: Scope → Find (barrier) → group-by-location → Verify → Sweep (xhigh/max) → Synthesize

## Phase 1: Scope
${scopePhase}

## Phase 2: Find (barrier)
One finder per correctness angle plus one finder covering all cleanup angles, pooled before verify.

- **Correctness**: launch one finder per correctness angle (up to ${cfg.correctnessAngles} of: ${CORRECTNESS_ANGLES.join('; ')}). Each finder is capped at ${cfg.perAngle} candidate findings.
- **Cleanup**: ONE merged finder covering all cleanup angles (${CLEANUP_ANGLES.join('; ')}), capped at ${cleanupBudget} (cleanup-angle count × perAngle) so the merged finder has the same total cleanup-candidate budget the old per-angle finders had.
  // keeps one finder per angle; cleanup is one finder covering all cleanup angles

Launch all finders concurrently in a single ${AGENT_TOOL_NAME} message, each receiving the full diff. Pool every candidate finding before proceeding.

## Phase 3: group-by-location
Group the pooled candidates by file/location so a single verifier sees all findings touching the same code.

## Phase 4: Verify
Re-read the actual code at each location and drop false positives. A finding survives only if the defect is real given the surrounding code.

## Phase 5: Sweep (xhigh/max)
${cfg.sweep ? `Fresh finder hunting only for gaps (xhigh/max) — a fresh finder re-scans the diff for anything the first pass missed.` : `Skipped at this effort level (sweep: false).`}

## Phase 6: Synthesize
Merge duplicates, rank by severity/confidence, and cap the report at ${cfg.maxFindings} findings. Report code-review findings as a typed list so the host UI can render them${opts.fix ? ', then apply each verified finding to the working tree' : ''}.
`
}

const SIMPLIFY_PROMPT = `# Simplify: Cleanup-Only Review

Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch One Merged Cleanup Finder

Use the ${AGENT_TOOL_NAME} tool to launch a SINGLE merged finder covering all cleanup angles concurrently. Pass it the full diff so it has the complete context.
// keeps one finder covering all cleanup angles (merged finder) rather than one finder per cleanup angle.

The merged finder reviews the diff for:

1. **Reuse** — Search for existing utilities/helpers that could replace newly written code. Flag any new function that duplicates existing functionality, and any inline logic (hand-rolled string manipulation, manual path handling, ad-hoc type guards) that could call an existing utility.
2. **Simplification** — redundant state, parameter sprawl, copy-paste with slight variation, leaky abstractions, stringly-typed code, unnecessary JSX nesting, and unnecessary comments (narrating WHAT or referencing the task/caller — keep only non-obvious WHY).
3. **Efficiency** — redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns, missed concurrency, hot-path bloat, recurring no-op updates (add a change-detection guard), unnecessary existence checks (TOCTOU), unbounded data structures, event listener leaks, overly broad operations.
4. **Altitude** — wrapper noise, dead abstraction layers, and code written at the wrong altitude for its context.

## Phase 3: Apply Fixes

Wait for the merged finder to complete. Aggregate its findings and fix each issue directly. If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

When done, briefly summarize what was fixed (or confirm the code was already clean).
`

function parseCodeReviewArgs(args: string): {
  effort: string
  fix: boolean
  comment: boolean
  target: string
  prNumber?: string
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let effort = 'high'
  const fix = tokens.includes('--fix')
  const comment = tokens.includes('--comment')
  const rest: string[] = []
  for (const tok of tokens) {
    if (tok === '--fix' || tok === '--comment') continue
    const lower = tok.toLowerCase()
    const matched = EFFORT_LEVELS.find(
      (lvl) => lower === lvl || lower.startsWith(lvl.slice(0, 3)),
    )
    if (matched) {
      effort = matched
      continue
    }
    rest.push(tok)
  }
  const target = rest.join(' ')
  // 2.1.204 (#19): a purely-numeric target is a GitHub PR number — review
  // that PR's diff (gh pr diff) instead of the local working diff. Anything
  // else (branch/path/file) stays a verbatim review target label.
  const prNumber = /^\d+$/.test(target) ? target : undefined
  return { effort, fix, comment, target: prNumber ? '' : target, prNumber }
}

export function registerCodeReviewSkill(): void {
  registerBundledSkill({
    // 2.1.154 (E14): /code-review is the bug-finding + cleanup review.
    // /simplify is now its own cleanup-only skill (no longer an alias here).
    name: 'code-review',
    // CC 2.1.218 #1: run as a background subagent so review work no longer
    // fills the main conversation and keeps stacked slash commands as its
    // review target. `context: 'fork'` routes through executeForkedSkill;
    // `background` is unset → default background (shouldForkedSkillRunAsync
    // returns true). Inner finders (AGENT_TOOL_NAME calls in the prompt) are
    // not blocked by the spawn-depth cap — createSubagentContext does not
    // propagate subagentDepth into the subagent's own ToolUseContext.
    context: 'fork',
    description:
      'Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence findings; high→max: broader coverage, may include uncertain findings). Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review.',
    argumentHint: CODE_REVIEW_ARGUMENT_HINT,
    userInvocable: true,
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (trimmed === '--help' || trimmed === '-h') {
        return [{ type: 'text', text: CODE_REVIEW_USAGE }]
      }
      const { effort, fix, comment, target, prNumber } = parseCodeReviewArgs(args)
      return [{ type: 'text', text: CODE_REVIEW_PROMPT({ effort, fix, comment, target, prNumber }) }]
    },
  })
}

export function registerSimplifySkill(): void {
  registerBundledSkill({
    // 2.1.154 (E14): /simplify split back out as a cleanup-only review that
    // applies fixes. Does not hunt for bugs — use /code-review for that.
    name: 'simplify',
    description:
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.',
    argumentHint: '[<target>]',
    userInvocable: true,
    async getPromptForCommand(args) {
      const t = args.trim()
      const prompt = t ? `Review target: \`${t}\`\n\n${SIMPLIFY_PROMPT}` : SIMPLIFY_PROMPT
      return [{ type: 'text', text: prompt }]
    },
  })
}
