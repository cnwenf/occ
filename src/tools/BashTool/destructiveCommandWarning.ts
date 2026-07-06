/**
 * Detects potentially destructive bash commands and returns a warning string
 * for display in the permission dialog. This is purely informational — it
 * doesn't affect permission logic or auto-approval.
 *
 * Each pattern carries a stable `category` slug (matching the official 2.1.200
 * `ujp` destructive-command list) so callers can label a matched command for
 * analytics/deny tracking without re-running the regex match. The category is
 * exposed via getDestructiveCommandCategory().
 */

type DestructivePattern = {
  pattern: RegExp
  /** Stable slug identifying the destructive command class (binary-aligned). */
  category: string
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — data loss / hard to reverse
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    category: 'git_reset_hard',
    warning: 'Note: may discard uncommitted changes',
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    category: 'git_force_push',
    warning: 'Note: may overwrite remote history',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    category: 'git_clean_force',
    warning: 'Note: may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    category: 'git_checkout_dot',
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    category: 'git_restore_dot',
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    category: 'git_stash_drop',
    warning: 'Note: may permanently remove stashed changes',
  },
  {
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    category: 'git_branch_force_delete',
    warning: 'Note: may force-delete a branch',
  },

  // Git — safety bypass
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    category: 'git_no_verify',
    warning: 'Note: may skip safety hooks',
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    category: 'git_commit_amend',
    warning: 'Note: may rewrite the last commit',
  },

  // File deletion (dangerous paths already handled by checkDangerousRemovalPaths)
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    category: 'rm_recursive_force',
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    category: 'rm_recursive',
    warning: 'Note: may recursively remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    category: 'rm_force',
    warning: 'Note: may force-remove files',
  },

  // Database
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    category: 'sql_drop_truncate',
    warning: 'Note: may drop or truncate database objects',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    category: 'sql_delete_from',
    warning: 'Note: may delete all rows from a database table',
  },

  // Infrastructure
  {
    pattern: /\bkubectl\s+delete\b/,
    category: 'kubectl_delete',
    warning: 'Note: may delete Kubernetes resources',
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    category: 'terraform_destroy',
    warning: 'Note: may destroy Terraform infrastructure',
  },
]

/**
 * Truncate a command to the same 10k-char ceiling the official matcher uses
 * before testing patterns, so pathological long commands don't blow up regex
 * backtracking.
 */
function truncateForMatch(command: string): string {
  return command.length > 1e4 ? command.slice(0, 1e4) : command
}

/**
 * Find the first destructive pattern matching a command. Returns the full
 * pattern object (with category + warning) or null. Mirrors the official
 * 2.1.200 `dFa` function.
 */
export function findDestructiveCommand(
  command: string,
): DestructivePattern | null {
  const truncated = truncateForMatch(command)
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(truncated)) {
      return entry
    }
  }
  return null
}

/**
 * Checks if a bash command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
export function getDestructiveCommandWarning(command: string): string | null {
  return findDestructiveCommand(command)?.warning ?? null
}

/**
 * Returns the stable category slug for a destructive command match, or null.
 * Mirrors the official 2.1.200 `H8e` function (dFa(e)?.category ?? null).
 */
export function getDestructiveCommandCategory(
  command: string,
): string | null {
  return findDestructiveCommand(command)?.category ?? null
}
