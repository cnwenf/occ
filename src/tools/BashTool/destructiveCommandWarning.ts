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

// ─────────────────────────────────────────────────────────────────────────
// G3: Deterministic destructive-command BLOCKS (no classifier needed).
//
// The WARNING patterns above are purely informational — they decorate the
// permission dialog and are gated behind the `tengu_destructive_command_warning`
// Statsig flag. These BLOCK patterns instead HARD-DENY catastrophic commands
// in the permission path itself: no AI classifier, no feature flag, no
// network call. A regex match is sufficient to block.
//
// Scope (per the G3 alignment spec):
//   - Git destructive: force push, push --delete, reset --hard, clean -f,
//     commit --amend (amend is auto-mode-only — see autoModeOnly).
//   - Infrastructure: terraform/tofu/pulumi/cdk destroy (NOT plan/apply).
//   - Catastrophic: rm -rf targeting / or ~, dd to a raw block device, mkfs.
//
// Call site (bashToolHasPermission) skips bypassPermissions mode to respect
// the --dangerously-skip-permissions contract, and gates autoModeOnly
// patterns (just `--amend`) to the `auto` mode where the classifier would
// otherwise auto-approve them.
// ─────────────────────────────────────────────────────────────────────────

type DestructiveBlockPattern = {
  pattern: RegExp
  /** Stable slug identifying the destructive command class. */
  category: string
  /** Human-readable reason appended to the deny message. */
  reason: string
  /**
   * If true, the block only applies in `auto` mode (where the classifier
   * might otherwise auto-approve). False (default) means the block applies
   * in default/acceptEdits/auto modes. bypassPermissions is always skipped
   * at the call site.
   */
  autoModeOnly?: boolean
}

// rm with recursive+force flags targeting root (/), home (~), or $HOME.
// Uses \brm (word boundary) so sudo/env/time-prefixed invocations are caught
// too. Covers combined short flags (-rf/-fr/-Rf/-rfv), separate short flags
// (-r -f / -f -r), and long flags (--recursive --force). Only matches when
// the target path is the root dir (/), home dir (~/$HOME), or their glob
// equivalents (/* ~/* $HOME/*) — NOT /tmp/foo or ~/Documents, which are
// legitimate scoped deletions.
const RM_ROOT_HOME_PATTERN =
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|--recursive\b[^;&|\n]*--force\b|--force\b[^;&|\n]*--recursive\b|-[a-zA-Z]*[rR]\b[^;&|\n]*?-[a-zA-Z]*f\b|-[a-zA-Z]*f\b[^;&|\n]*?-[a-zA-Z]*[rR]\b)\s+(?:\/(?:\s|$|[;&|\n])|\/\*|~(?:\s|$|[;&|\n])|~\/(?:\s|$|[;&|\n])|~\/\*|\$HOME(?:\s|$|[;&|\n])|\$HOME\/(?:\s|$|[;&|\n])|\$HOME\/\*)/

const DESTRUCTIVE_BLOCK_PATTERNS: DestructiveBlockPattern[] = [
  // Git — irreversible history/branch destruction
  {
    // --force matches both --force and --force-with-lease (substring).
    // \s-[a-zA-Z]*f[a-zA-Z]*\b matches -f and combined short flags containing
    // f (-fu, -qf) — for git push, f in a short flag always means force. The
    // leading \s- (space + single dash) excludes long flags like --follow-tags.
    pattern: /\bgit\s+push\b[^;&|\n]*(?:--force|\s-[a-zA-Z]*f[a-zA-Z]*\b)/,
    category: 'git_force_push',
    reason: 'git push --force overwrites remote history',
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*\s--delete\b/,
    category: 'git_push_delete',
    reason: 'git push --delete removes a remote branch/tag',
  },
  {
    pattern: /\bgit\s+reset\b[^;&|\n]*\s--hard\b/,
    category: 'git_reset_hard',
    reason: 'git reset --hard discards uncommitted changes',
  },
  {
    // git clean with -f (force) but not -n/--dry-run. Matches -fd, -df, -fxd.
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    category: 'git_clean_force',
    reason: 'git clean -f permanently removes untracked files',
  },
  {
    // Amend is only dangerous when auto-approved (rewrites history without
    // a prompt). In default mode it naturally prompts, so no hard-deny.
    pattern: /\bgit\s+commit\b[^;&|\n]*\s--amend\b/,
    category: 'git_commit_amend',
    reason: 'git commit --amend rewrites the last commit',
    autoModeOnly: true,
  },

  // Infrastructure — tears down managed cloud resources
  {
    pattern: /\b(?:terraform|tofu)\s+destroy\b/,
    category: 'terraform_destroy',
    reason: 'terraform/tofu destroy tears down infrastructure',
  },
  {
    pattern: /\bpulumi\s+destroy\b/,
    category: 'pulumi_destroy',
    reason: 'pulumi destroy tears down infrastructure',
  },
  {
    pattern: /\bcdk\s+destroy\b/,
    category: 'cdk_destroy',
    reason: 'cdk destroy tears down infrastructure',
  },

  // Other — catastrophic, non-recoverable
  {
    pattern: RM_ROOT_HOME_PATTERN,
    category: 'rm_root_home',
    reason: 'rm -rf targets the root or home directory',
  },
  {
    // dd writing TO a raw block device (of=/dev/sd*, nvme, disk, etc.).
    // Reading FROM a device (if=/dev/sda of=/tmp/img) is NOT matched.
    pattern:
      /\bdd\b[^;&|\n]*of=\s*['"]?\/dev\/(?:sd|nvme|disk|hd|vd|xvd|mmcblk)/,
    category: 'dd_disk_wipe',
    reason: 'dd writes to a raw block device',
  },
  {
    // mkfs and its typed variants (mkfs.ext4, mkfs.vfat, mkfs.xfs, ...).
    // Command-position match (segment start or after ;/&/|, optionally
    // preceded by sudo/env/time/nice/nohup) so `grep mkfs README.md` is not
    // a false positive.
    pattern:
      /(?:^|[;&|\n]\s*)(?:sudo\s+|env\s+|time\s+|nice\s+|nohup\s+)*mkfs(?:\.[a-z0-9]+)?\b/,
    category: 'mkfs_format',
    reason: 'mkfs formats a disk',
  },
]

export type DestructiveCommandBlock = {
  category: string
  reason: string
  autoModeOnly: boolean
}

/**
 * Find the first destructive BLOCK pattern matching a command. Returns the
 * block info (category + reason + autoModeOnly) or null. Unlike
 * findDestructiveCommand (informational warnings), a match here means the
 * command should be HARD-DENIED in the permission path without consulting
 * the AI classifier.
 */
export function findDestructiveCommandBlock(
  command: string,
): DestructiveCommandBlock | null {
  const truncated = truncateForMatch(command)
  for (const entry of DESTRUCTIVE_BLOCK_PATTERNS) {
    if (entry.pattern.test(truncated)) {
      return {
        category: entry.category,
        reason: entry.reason,
        autoModeOnly: entry.autoModeOnly ?? false,
      }
    }
  }
  return null
}

/**
 * Boolean wrapper over findDestructiveCommandBlock. Satisfies the G3 spec's
 * requested `isDestructiveCommand(command): boolean` API.
 */
export function isDestructiveCommand(command: string): boolean {
  return findDestructiveCommandBlock(command) !== null
}

// ─────────────────────────────────────────────────────────────────────────
// 2.1.208 #41: Catastrophic removals inside command substitutions.
//
// A `rm -rf $VAR/*` (or `rm -rf ~` / `rm -rf /`) hidden inside `$(…)`,
// backticks, or `<(…)` must trigger the same destructive-command block as the
// plain form — even under `--dangerously-skip-permissions` (bypassPermissions)
// and in auto mode, where the classifier would otherwise auto-approve. The
// official 2.1.210 binary implements this in `GRg` (substitution extractor) +
// `hXi` (per-command rm-target detector). `hXi`'s `GGe` return carries
// `classifierApprovable: false`, which is what stops the auto-mode classifier
// from overriding the block.
//
// OCC ports `hXi` + `GRg` here as pure functions and calls them from
// bashToolHasPermission in ALL permission modes (the call site deliberately
// does NOT skip bypassPermissions, so catastrophic removals inside
// substitutions are blocked even with --dangerously-skip-permissions).
//
// In addition to the binary's variable-path detector (`eIg`/`hXi`, which
// catches `rm -rf $UNSET/*`-style removals that turn into a root wipe when the
// variable is empty), OCC also re-applies RM_ROOT_HOME_PATTERN to each
// extracted substitution so a literal `rm -rf ~` / `rm -rf /` inside a
// substitution is caught — the plain form already blocks these, and #41 says
// the substitution form must "match the plain form".
// ─────────────────────────────────────────────────────────────────────────

import { splitCommand_DEPRECATED as splitCommandForRm } from '../../utils/bash/commands.js'

// Binary `tIg`: matches a command segment that is an `rm`/`rmdir` invocation,
// allowing an env-var-assignment prefix (VAR=value) and a path-prefixed binary
// (e.g. /usr/bin/rm). Capture group 1 is the command name.
const CATASTROPHIC_RM_COMMAND_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*\+?=[^\s]*\s+)*\\?(?:[^\s=]*\/)?(rm|rmdir)(?:\s|$)/

// Binary `eIg`: matches a rm/rmdir TARGET that is a shell variable expansion
// pointing at the filesystem root (or a top-level dir) when the variable is
// unset/empty. e.g. `$UNSET/*` → `/*` (root wipe). `$VAR/`, `${VAR}/*`,
// `$VAR/$`, `$VAR//`, `$VAR/"'`, `$VAR/` (end) all match.
//
// Constructed via new RegExp to avoid the slash-escaping ambiguity of a
// regex literal (the pattern contains a literal `/` that must not close the
// literal prematurely).
const CATASTROPHIC_VAR_PATH_TARGET_RE = new RegExp(
  '^"?\\$(?:\\{[A-Za-z_][A-Za-z0-9_]*\\}|[A-Za-z_][A-Za-z0-9_]*)"?\\/(?:\\*|\\$|\\/|["\']|$)',
)

// Redirect token that may carry a filename operand in the next argv slot, so
// hXi can skip over it without mistaking the operand for a target. Mirrors
// the binary's `/^(?:[0-9]+|&)?(?:>>?[|&]?|<<?<?|<>)$/`.
const REDIRECT_OP_RE = /^(?:[0-9]+|&)?(?:>>?[|&]?|<<?<?|<>)$/

// A token that starts with an optional fd/& prefix and a redirect char — used
// to detect redirect operators among rm args. Mirrors `/^[\d&]*[<>]/`.
const REDIRECT_TOKEN_START_RE = /^[\d&]*[<>]/

export type CatastrophicRmMatch = { command: string; target: string }

/**
 * Port of the official 2.1.210 `hXi(e)`. Detects a `rm`/`rmdir` invocation
 * targeting a shell-variable path that resolves to the filesystem root (or a
 * top-level directory) when the variable is unset/empty — e.g.
 * `rm -rf $UNSET/*` becomes `rm -rf /*`.
 *
 * Returns `{command, target}` on the first dangerous match, or null.
 *
 * Statically walks splitCommand output, strips command substitutions and
 * grouping braces/parens, splits on `;|&` and newlines, then for each `rm`/
 * `rmdir` segment inspects each non-flag operand. A target matching
 * CATASTROPHIC_VAR_PATH_TARGET_RE (`eIg`) is returned.
 */
export function findCatastrophicRmInCommand(
  command: string,
): CatastrophicRmMatch | null {
  // Gate: only analyze commands that contain a `$` and an `rm`/`rmdir` token.
  // (Mirrors `if(!e.includes("$")||!/\brm(?:dir)?\b/.test(e))return null`.)
  if (!command.includes('$') || !/\brm(?:dir)?\b/.test(command)) {
    return null
  }
  for (const sub of splitCommandForRm(command)) {
    let r = sub
      .replace(/\\\r?\n/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .trimStart()
    while (r.startsWith('(') || r.startsWith('{')) {
      r = r.slice(1).trimStart()
    }
    // Collapse `$(…)` and bare `(…)` groups so their contents don't masquerade
    // as rm targets at the top level (the substitution form is handled by
    // findCatastrophicSubstitutionBlock, which calls this on each extracted
    // substitution body).
    for (let prev = ''; prev !== r; ) {
      prev = r
      r = r.replace(/\$\([^()]*\)/g, ' ').replace(/(?<!\$)\([^()]*\)/g, ' ')
    }
    r = r.replace(/(?<![<>&])&(?![<>&])/g, ';')
    for (const seg of r.split(/[;|\n\r]|&&/)) {
      const o = seg.trimStart()
      const m = o.match(CATASTROPHIC_RM_COMMAND_RE)
      if (m === null) {
        continue
      }
      const cmd = m[1] === 'rmdir' ? 'rmdir' : 'rm'
      const args = o.slice(m[0].length).split(/\s+/)
      for (let l = 0; l < args.length; l++) {
        const c = args[l]!.replace(/[)\]}]+$/, '')
        if (c === '' || c.startsWith('-') || c.startsWith("'")) {
          continue
        }
        if (REDIRECT_TOKEN_START_RE.test(c)) {
          if (REDIRECT_OP_RE.test(c)) {
            l++ // consume the redirect operator, skip its filename operand
          }
          continue
        }
        if (CATASTROPHIC_VAR_PATH_TARGET_RE.test(c)) {
          return { command: cmd, target: c }
        }
      }
    }
  }
  return null
}

/**
 * Regex-based extraction of command-substitution bodies from a command string,
 * mirroring the official `GRg` AST walker. Returns the inner command text for
 * each `$(…)`, backtick, `<(…)`, `>(…)`, and `${ |…}` (the expansion form
 * whose `${` is followed by whitespace/`|`/newline — a command substitution,
 * not a variable). Nested `$(…)` one level deep is preserved.
 */
export function extractCommandSubstitutions(command: string): string[] {
  const out: string[] = []
  // $( … ) and <( … ) / >( … ) — one level of nested parens allowed.
  // Prefix must be non-empty ($, <, or >) so a bare grouping ( … ) is NOT
  // mistaken for a command substitution (the binary's GRg walker only visits
  // command_substitution / process_substitution nodes).
  const parenRe = /(?:\$|[<>])\(((?:[^()]|\([^()]*\))*)\)/g
  let m: RegExpExecArray | null
  while ((m = parenRe.exec(command)) !== null) {
    if (m[1] !== undefined) {
      out.push(m[1].trim())
    }
  }
  // Backtick command substitutions.
  const backtickRe = /`([^`]*)`/g
  while ((m = backtickRe.exec(command)) !== null) {
    if (m[1] !== undefined) {
      out.push(m[1].trim())
    }
  }
  // `${ |…}` / `${\n…}` — the expansion form that is actually a command
  // substitution (bash treats `${ ls; }` as a command, not a variable).
  const braceSubRe = /\$\{[ \t\n|]([^}]*)\}/g
  while ((m = braceSubRe.exec(command)) !== null) {
    if (m[1] !== undefined) {
      out.push(m[1].replace(/^\|/, '').replace(/;$/, '').trim())
    }
  }
  return out
}

export type CatastrophicSubstitutionBlock = {
  category: string
  reason: string
}

/**
 * Port of the official 2.1.210 `GRg(e, t, r)`. Detects a catastrophic
 * `rm`/`rmdir` hidden inside a command substitution (`$(…)`, backticks,
 * `<(…)`, `${ |…}`).
 *
 * Two detection paths, both mirroring the binary:
 *  1. >64 substitutions + the command contains `rm`/`rmdir` → block with
 *     "too many to analyze for catastrophic removals" (can't statically prove
 *     safety).
 *  2. For each substitution body (and the outer command text), run
 *     findCatastrophicRmInCommand (`hXi`) — a variable-path target like
 *     `$UNSET/*` inside the substitution is caught.
 *
 * OCC additionally re-applies RM_ROOT_HOME_PATTERN to each body so a literal
 * `rm -rf ~` / `rm -rf /` inside a substitution is caught too — the plain form
 * already blocks these and #41 requires the substitution form to match.
 *
 * Returns the block info or null.
 */
export function findCatastrophicSubstitutionBlock(
  command: string,
): CatastrophicSubstitutionBlock | null {
  const subs = extractCommandSubstitutions(command)
  if (subs.length > 64) {
    if (/\brm(?:dir)?\b/.test(command)) {
      return {
        category: 'rm_substitution_too_many',
        reason: `This command contains ${subs.length} command substitutions — too many to analyze for catastrophic removals. This requires explicit approval.`,
      }
    }
    return null
  }
  for (const body of [command, ...subs]) {
    let c = body.trim()
    // Strip a single layer of grouping braces/parens so `{ rm -rf $x/*; }`
    // and `( rm -rf $x/* )` are analyzed as their inner command.
    if (
      (c.startsWith('{') && /;?\s*\}$/.test(c)) ||
      (c.startsWith('(') && c.endsWith(')'))
    ) {
      c = c.slice(1).replace(/;?\s*[)}]$/, '').trim()
    }
    const varMatch = findCatastrophicRmInCommand(c)
    if (varMatch !== null) {
      return {
        category: 'rm_substitution_var_path',
        reason: `Dangerous ${varMatch.command} operation detected inside command substitution: '${varMatch.target}'`,
      }
    }
    // Literal root/home catastrophic removal inside the substitution body.
    // RM_ROOT_HOME_PATTERN's `~`/`/`/`$HOME` follow-set matches end-of-string,
    // so a body like `rm -rf ~` or `rm -rf /` is caught here.
    if (RM_ROOT_HOME_PATTERN.test(c)) {
      return {
        category: 'rm_substitution_root_home',
        reason:
          'rm -rf targeting the root or home directory detected inside command substitution',
      }
    }
  }
  return null
}
