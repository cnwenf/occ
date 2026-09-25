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
// literal prematurely). The biome-ignore is load-bearing: the
// useRegexLiterals autofix converts this to a literal whose bare `/` closes
// the regex early — a PARSE ERROR that takes down every BashTool test — and
// has re-broken this line repeatedly when `biome lint --fix src/` runs.
// biome-ignore lint/complexity/useRegexLiterals: autofix output is a syntax error (bare / closes the literal)
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

export type CatastrophicRmMatch = {
  command: string
  target: string
  /**
   * 2.1.281 #110 (binary `avo` env Set): the matched variable is a tracked
   * home/cwd-derived path variable, so the match belongs to the v281
   * "possibly-empty variable path" family (binary `tIe`→`Voe` arm) and gets
   * the v281 message instead of the OCC 2.1.210-era substitution message.
   */
  arm?: 'possiblyEmptyVar'
  /** Shell variable name (without `$`) for the possiblyEmptyVar arm. */
  varName?: string
  /** The rm/rmdir segment text, for the v281 message's invocation display. */
  invocation?: string
}

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
          const varName = extractShellVarName(c)
          if (varName !== null && TRACKED_PATH_ENV_VARS.has(varName)) {
            // 2.1.281 #110 (binary `avo`): tracked home/cwd-derived variable
            // path (e.g. `"$HOME/"`) → the v281 "possibly-empty variable
            // path" family (binary `tIe`→`Voe`), not the 2.1.210-era text.
            return {
              command: cmd,
              target: c,
              arm: 'possiblyEmptyVar',
              varName,
              invocation: o,
            }
          }
          return { command: cmd, target: c, invocation: o }
        }
        // 2.1.281 #110 (binary `avo` arm): the target is a BARE tracked
        // variable expansion (`$TMPDIR`, `${TMPDIR}`, `${TMPDIR:-…}`, quoted
        // or with a trailing slash). These vars are home/cwd-derived and
        // their runtime value cannot be read statically, so v281 asks. The
        // exact literal `$HOME` is excluded: OCC's RM_ROOT_HOME_PATTERN block
        // owns that form and existing consumers/tests rely on its
        // 'rm_substitution_root_home' category (braced/quoted HOME still
        // prompts here — fail-safe direction).
        const bareToken = unquoteToken(args[l]!)
        if (bareToken !== '$HOME') {
          const bareMatch = BARE_TRACKED_VAR_TARGET_RE.exec(bareToken)
          const bareVarName = bareMatch?.[1] ?? bareMatch?.[2]
          if (
            bareVarName !== undefined &&
            TRACKED_PATH_ENV_VARS.has(bareVarName)
          ) {
            return {
              command: cmd,
              target: bareToken,
              arm: 'possiblyEmptyVar',
              varName: bareVarName,
              invocation: o,
            }
          }
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
  /**
   * Official 2.1.281 decisionReason text (binary `jy` builds
   * `Dangerous ${cmd} operation ${reasonFragment}`). Informational for
   * telemetry/analytics parity — the permission consumer only reads
   * category + reason, so this field is additive and optional.
   */
  decisionReason?: string
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
 * 2.1.273 port — per-segment analysis (byte-verified): the official walker
 * (`_5o`→`rxn`) splits EVERY body on shell operators via tree-sitter
 * (`Hg`/`Fp`: skip-set `&&`,`||`,`|`,`;`,`&`,`|&`,newline; recurse-set
 * `program`,`list`,`pipeline`), strips one layer of `{…;}`/`(…)` per segment,
 * and analyzes each segment. 2.1.272 analyzed only the unsplit body and ran
 * the walker only on the too-complex classification path, so a simple compound
 * like `echo hi && (rm -rf /)` produced a plain shell-operators ask — NOT
 * `bypassImmune` — and bypass mode auto-allowed it (the 2.1.273 changelog
 * "subshell hiding a dangerous rm in bypass mode" bug). The official fix
 * re-runs the walker from `Mzo`'s shell-operators branch
 * (`if(d&&d!==kz){let Pn=await rxn(d,te(),s);if(Pn!==null)return Pn}`), whose
 * verdict carries `circuitBreaker:"dangerousRemoval"` (bypassImmune). OCC
 * mirrors that by ALSO checking each splitCommandForRm segment of every body —
 * the quote-aware splitter surfaces `(rm -rf /)` as a bare `rm -rf /` segment
 * (`echo "a && rm -rf /"` stays a single segment — no false positives). The
 * guard's call site runs in ALL modes and returns deny, so this is OCC's
 * bypass-immune equivalent of the official bypassImmune ask.
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
  const analyzeText = (text: string): CatastrophicSubstitutionBlock | null => {
    let c = text.trim()
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
      if (varMatch.arm === 'possiblyEmptyVar' && varMatch.varName !== undefined) {
        // 2.1.281 #110: tracked-variable arm → binary `Voe` message family.
        return buildPossiblyEmptyVarBlock(
          varMatch.command,
          varMatch.target,
          varMatch.varName,
          varMatch.invocation ?? c,
        )
      }
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
    // 2.1.281 #034 + #110: the v281 dangerous-rm analyzer arms that OCC's
    // 2.1.210-era checks don't cover (whole-substitution targets, empty
    // expansion, backslash-only drive root, tracked-var + top-level dir).
    return findDangerousRmV281Block(c)
  }
  for (const body of [command, ...subs]) {
    // Check the body itself first (preserves the pre-273 whole-body
    // detection), then each operator-split segment (2.1.273 parity — catches
    // a dangerous rm hidden in a bare subshell/group segment like
    // `echo hi && (rm -rf /)` → segments `["echo hi","(","rm -rf /",")"]`).
    for (const text of [body, ...splitCommandForRm(body)]) {
      if (text.trim() === '') {
        continue
      }
      const block = analyzeText(text)
      if (block !== null) {
        return block
      }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────
// 2.1.281 #034 + #110 (🔒 security): dangerous-rm static analyzer upgrades.
//
// Official 2.1.281 rewrote the rm/rmdir static analyzer (binary `x$()` +
// its substitution-context caller `pMe` + the `Voe` message builder). Before
// this port, a recursive `rm` whose target is ONLY command-substitution
// output — e.g. `rm -rf "$(pwd)"` — ran UNPROMPTED in auto mode and under
// --dangerously-skip-permissions, because OCC's 2.1.210-era checks only fire
// on literal root/home targets or `$VAR/`-style variable paths.
//
// Arms ported here (message strings recovered byte-exact from the official
// 2.1.281 linux-x64 ELF):
//  1. wholeSubstitution (#034, ELF @202903176): recursive `rm` whose target
//     tokenizes to only `__CMDSUB__` runs (`/^(?:__CMDSUB__[/*.]*)+$/`) →
//     ask, unless the CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT kill-switch
//     env var is set. Official gate `Hl("tengu_iridescent_boot",!0)` is
//     default-on (off only via a remote "payload" override) — always-on in
//     OCC per the tengu_* porting convention (GrowthBook is stubbed and
//     returns the default).
//  2. emptyExpansion (#034, ELF @202902929): a target with a literal prefix
//     followed by a `__CMDSUB__` run — if the substitution expands to empty
//     the target reduces to the prefix; when the reduced target is the root
//     or home (`/`, `/*`, `~`…), ask with the binary's critical-path
//     message. `${VAR:-$(…)}` targets are folded to their cmdsub default
//     first (binary tokenizer rule), so they flow into arms 1/2.
//  3. backslash-only (#110, ELF @202783355): a `/^\\+$/` target is the drive
//     root in Git Bash on Windows → ask.
//  4. var+top-level (#110, ELF @202783019, binary regex `pvo`): a target of
//     tracked-var placeholder(s) + `/` + a top-level directory name (binary
//     `mNt` list) → ask; if the expansion is empty this removes '/<dir>'.
//     Telemetry kind `placeholder_root_child` (binary `lNt`). Official gate
//     `Qoe()`=`Hl("tengu_bright_lake",!0)` — default-on, always-on in OCC.
//  5. cwd-derived vars (#110, binary env Set `avo` @202782129): a bare
//     `$VAR`/`${VAR}` target (optionally quoted / trailing slash / default
//     expansion) where VAR is a tracked home/cwd-derived path variable
//     (HOME, PWD, OLDPWD, TMPDIR, TMP, TEMP, …) → ask with the binary `Voe`
//     "possibly-empty variable path" message. Implemented inside
//     findCatastrophicRmInCommand above (it is the v281 successor of the
//     same `tIe`/`eIg` target walk), with the message built by
//     buildPossiblyEmptyVarBlock below.
//
// All arms flow through findCatastrophicSubstitutionBlock's existing
// {category, reason} return shape, so bashPermissions.ts (which turns any
// non-null block into an all-modes deny — OCC's bypass-immune equivalent of
// the official ask) needs no change. Fail-safe direction: when a target
// cannot be statically resolved, prompt — never auto-allow.
// ─────────────────────────────────────────────────────────────────────────

/** Binary `pMe` tokenizer placeholder for a command substitution. */
const CMDSUB_TOKEN = '__CMDSUB__'
/** Binary placeholder for a tracked (avo) shell-variable expansion. */
const TRACKED_VAR_TOKEN = '__TRACKED_VAR__'
/** Binary `Dot` display rendering of the placeholders. */
const CMDSUB_TOKEN_DISPLAY = '$(…)'
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${…}` is the binary's Dot display string, not a template
const TRACKED_VAR_TOKEN_DISPLAY = '${…}'
/** Binary tokenizer iteration ceiling for nested `$(…)`. */
const MAX_CMDSUB_TOKENIZE_PASSES = 16

/**
 * Binary `mNt` — directory names that sit at the top level of a filesystem
 * root. A variable expansion followed by one of these means an empty
 * expansion removes '/<name>'.
 */
const TOP_LEVEL_DIR_NAMES =
  'bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive'

/** Binary `pvo` — tracked-var prefix ending in a top-level directory name. */
const VAR_TOP_LEVEL_TARGET_RE = new RegExp(
  String.raw`^(?:${TRACKED_VAR_TOKEN})+[\\/]+(${TOP_LEVEL_DIR_NAMES})(?:[\\/]+\*+)*[\\/]*$`,
  'i',
)

/** Binary wholeSubstitution arm target test (ELF @202903176). */
const WHOLE_SUBSTITUTION_TARGET_RE = new RegExp(
  `^(?:${CMDSUB_TOKEN}[/*.]*)+$`,
)

/**
 * Binary emptyExpansion arm test (ELF @202902929): any char followed by a
 * `__CMDSUB__` run (no `..` inside), optional trailing `/..` parts and
 * slashes, anchored at end. NOTE: the leading `.` is "any char" — in the
 * binary's regex literal the first `/` is the delimiter.
 */
const EMPTY_EXPANSION_TARGET_RE = new RegExp(
  String.raw`.(?:${CMDSUB_TOKEN}(?:(?!\.\.)[/*.])*)+(?:\/\.\.)*\/*$`,
)

/** Binary emptyExpansion strip: keeps the literal char + `/..` tail. */
const EMPTY_EXPANSION_STRIP_RE = new RegExp(
  String.raw`(.)(?:${CMDSUB_TOKEN}(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$`,
)

/**
 * Binary `${VAR:-<cmdsub>}` fold (ELF @202902104): a parameter expansion
 * whose default value is only command-substitution output collapses to that
 * output, so `${X:-$(pwd)}` is analyzed as a whole-substitution target.
 */
const PARAM_EXPANSION_CMDSUB_FOLD_RE = new RegExp(
  String.raw`\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-]):?[-=+?]"?((?:${CMDSUB_TOKEN}[/*.]*)+)"?\}`,
  'g',
)

/** Binary #110 backslash-only drive-root arm (ELF @202783355). */
const BACKSLASH_ONLY_TARGET_RE = /^\\+$/

/** Binary recursive-flag detection for the wholeSubstitution arm. */
const RECURSIVE_LONG_FLAG_RE = /^--r/
const RECURSIVE_SHORT_FLAG_RE = /^-[a-zA-Z]*[rR]/

/** Reduced (expansion-emptied) targets OCC treats as critical root/home. */
const REDUCED_ROOT_HOME_TARGET_RE = /^(?:\/\*?|~\/?\*?)$/

/**
 * Binary `avo` (ELF @202782129) — home/cwd-derived environment variables
 * whose runtime value this check cannot read. v281 extends the tracked set
 * with the cwd-derived PWD/OLDPWD/TMPDIR/TMP/TEMP.
 */
const TRACKED_PATH_ENV_VARS: ReadonlySet<string> = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEPATH',
  'HOMEDRIVE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'HOMESHARE',
  'XDG_RUNTIME_DIR',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
])

/**
 * A target that is ONLY a tracked-variable expansion: `$VAR`, `${VAR}`,
 * `${VAR:-default}`/`${VAR:?}`-style, optional trailing slash. Group 1 is
 * the braced name, group 2 the bare name.
 */
const BARE_TRACKED_VAR_TARGET_RE =
  /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[?]?:?[-=?+][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))\/?$/

/** First shell-variable name in a target (`${VAR}` or `$VAR` form). */
const SHELL_VAR_NAME_RE =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/

/**
 * Variable occurrences replaced when building the binary `Voe` guarded
 * rewrite (`M`): each `$VAR`/`${VAR}` becomes `"${VAR:?}"` so the shell
 * stops with an error instead of running the rm on an empty expansion.
 */
const VAR_OCCURRENCE_RE =
  /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g

/** Byte-exact v281 wholeSubstitution ask message (ELF @202903176). */
const WHOLE_SUBSTITUTION_RM_MESSAGE =
  'Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints.'

/** Byte-exact v281 wholeSubstitution decisionReason (binary `jy` wrap). */
const WHOLE_SUBSTITUTION_DECISION_REASON =
  'Dangerous rm operation on statically-unresolvable target: command substitution output'

/**
 * Binary argv unquote helper (ELF @196790259): strip matching surrounding
 * quotes so `"$(pwd)"` analyzes as the placeholder token.
 */
function unquoteToken(token: string): string {
  const first = token[0]
  const last = token[token.length - 1]
  return token.length >= 2 && (first === '"' || first === "'") && first === last
    ? token.slice(1, -1)
    : token
}

/** Name of the first shell variable in a target, or null. */
function extractShellVarName(target: string): string | null {
  const m = SHELL_VAR_NAME_RE.exec(target)
  if (m === null) {
    return null
  }
  return m[1] ?? m[2] ?? null
}

/**
 * Binary `pMe` text tokenizer (ELF @202902104): backtick bodies and
 * `$(…)` runs (nested, ≤16 passes) become `__CMDSUB__`; `${VAR:-<cmdsub>}`
 * folds to the cmdsub run; tracked (avo) variable expansions become
 * `__TRACKED_VAR__` so `pvo` can see a var+top-level shape.
 */
function tokenizeForDangerousRm281(text: string): string {
  let out = text.replace(/`[^`]*`/g, CMDSUB_TOKEN)
  for (let pass = 0; pass < MAX_CMDSUB_TOKENIZE_PASSES; pass++) {
    const prev = out
    out = out.replace(/\$\([^()]*\)/g, CMDSUB_TOKEN)
    if (out === prev) {
      break
    }
  }
  out = out.replace(PARAM_EXPANSION_CMDSUB_FOLD_RE, '$1')
  return out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match: string, braced?: string, bare?: string) => {
      const name = braced ?? bare
      return name !== undefined && TRACKED_PATH_ENV_VARS.has(name)
        ? TRACKED_VAR_TOKEN
        : match
    },
  )
}

/** Binary `Dot` — render placeholders back to display form for messages. */
function displayTokenizedTarget(token: string): string {
  return token
    .replaceAll(TRACKED_VAR_TOKEN, TRACKED_VAR_TOKEN_DISPLAY)
    .replaceAll(CMDSUB_TOKEN, CMDSUB_TOKEN_DISPLAY)
}

/**
 * Kill-switch for the wholeSubstitution arm (binary:
 * `!a.CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` — any non-empty value
 * disables the prompt; the key is on the official managed-env list, so
 * project-scoped settings cannot set it).
 */
function isSubstitutionRmPromptDisabled(): boolean {
  return Boolean(process.env.CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT)
}

/**
 * Binary `Voe` (ELF @202781621), rootChild===undefined branch, non-reparsed:
 * the "possibly-empty variable path" ask for tracked (avo) variable targets.
 * Byte-exact except: (a) the binary's " (inside a command substitution)"
 * suffix (`ge`) is omitted — OCC analyzes plain text and substitution bodies
 * through one entry and the binary only sets it from its substitution-only
 * walker; (b) the `qoe` quoted-match probe is approximated by whole-target
 * quote detection when building the guarded rewrite `M`.
 */
function buildPossiblyEmptyVarBlock(
  cmd: string,
  target: string,
  varName: string,
  invocation: string,
): CatastrophicSubstitutionBlock {
  const varDisplay = `$${varName}`
  const guarded = `\${${varName}:?}`
  const isQuotedTarget = unquoteToken(target) !== target
  const rewrittenTarget = target.replace(
    VAR_OCCURRENCE_RE,
    isQuotedTarget ? guarded : `"${guarded}"`,
  )
  const message =
    `Dangerous ${cmd} operation detected in \`${invocation}\`. The target '${target}' is a shell variable expansion: when ${varDisplay} is unset or empty it becomes \`/\`, \`/*\` or a top-level path. This requires explicit approval and cannot be auto-allowed by permission rules.\n\n` +
    `This check does not fire on a target that cannot expand to the filesystem root: rewrite it as \`${rewrittenTarget}\`, which makes the shell stop with an error instead of running ${cmd} when ${varDisplay} is unset or empty, or use a literal absolute path.`
  return {
    category: 'rm_possibly_empty_var_path',
    reason: message,
    decisionReason: `Dangerous ${cmd} operation on possibly-empty variable path: ${target} in \`${invocation}\` (rewrite it as ${rewrittenTarget} or use a literal path)`,
  }
}

/**
 * Per-rm-segment v281 arms (binary `x$` new-v281 checks + the `pMe`
 * emptyExpansion/wholeSubstitution arms). `args` are the tokenized argv
 * after the program name. Order mirrors the binary: per-target
 * var+top-level → backslash-only → emptyExpansion, then the segment-level
 * wholeSubstitution arm.
 */
function analyzeRmArgsV281(
  cmd: string,
  args: ReadonlyArray<string>,
): CatastrophicSubstitutionBlock | null {
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!
    if (raw.startsWith('-')) {
      continue
    }
    if (REDIRECT_TOKEN_START_RE.test(raw)) {
      if (REDIRECT_OP_RE.test(raw)) {
        i++ // consume the redirect operator, skip its filename operand
      }
      continue
    }
    const token = unquoteToken(raw.replace(/[)\]}]+$/, ''))
    targets.push(token)
    // #110 var+top-level (binary `pvo`, gate tengu_bright_lake always-on).
    const topLevelDir = VAR_TOP_LEVEL_TARGET_RE.exec(token)?.[1]
    if (topLevelDir !== undefined) {
      const display = displayTokenizedTarget(token)
      return {
        category: 'rm_placeholder_root_child',
        reason: `Dangerous ${cmd} operation detected: '${display}'\n\nThe target starts with a shell expansion this check cannot read and ends in a top-level directory name: if the expansion is empty, this removes '/${topLevelDir}'. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nUse a literal absolute path instead.`,
        decisionReason: `Dangerous ${cmd} operation on possibly-empty variable path: ${display} (use a literal path: when the expansion is empty this removes /${topLevelDir})`,
      }
    }
    // #110 backslash-only target = drive root in Git Bash on Windows.
    if (BACKSLASH_ONLY_TARGET_RE.test(token)) {
      return {
        category: 'rm_backslash_only_drive_root',
        reason: `Dangerous ${cmd} operation detected: '${token}'\n\nA backslash-only target is the drive root in Git Bash on Windows. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nWrite the directory you mean as a path, for example /c/work/build or C:/work/build.`,
        decisionReason: `Dangerous ${cmd} operation on drive root: ${token}`,
      }
    }
    // #034 emptyExpansion: literal prefix + cmdsub run — if the expansion
    // is empty the target reduces to the prefix; only root/home reductions
    // ask (binary re-runs `x$` on the reduced target; OCC scopes the
    // reduced-target check to its critical root/home forms).
    if (EMPTY_EXPANSION_TARGET_RE.test(token)) {
      const reduced = token.replace(EMPTY_EXPANSION_STRIP_RE, '$1$2')
      if (REDUCED_ROOT_HOME_TARGET_RE.test(reduced)) {
        const display = displayTokenizedTarget(reduced)
        return {
          category: 'rm_substitution_empty_expansion',
          reason: `Dangerous ${cmd} operation detected: '${display}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
          decisionReason: `Dangerous ${cmd} operation on critical path: ${display}`,
        }
      }
    }
  }
  // #034 wholeSubstitution: recursive rm, targets are ONLY command-
  // substitution output. Flags after `--` don't count (binary `st`).
  const flagEnd = args.indexOf('--')
  const flagArgs = flagEnd === -1 ? args : args.slice(0, flagEnd)
  const isRecursiveRm =
    cmd === 'rm' &&
    flagArgs.some(
      (a) => RECURSIVE_LONG_FLAG_RE.test(a) || RECURSIVE_SHORT_FLAG_RE.test(a),
    )
  if (
    isRecursiveRm &&
    !isSubstitutionRmPromptDisabled() &&
    targets.some((t) => WHOLE_SUBSTITUTION_TARGET_RE.test(t))
  ) {
    return {
      category: 'rm_substitution_whole_target',
      reason: WHOLE_SUBSTITUTION_RM_MESSAGE,
      decisionReason: WHOLE_SUBSTITUTION_DECISION_REASON,
    }
  }
  return null
}

/**
 * Port of the official 2.1.281 `x$()`/`pMe` dangerous-rm arms (see the
 * section header for the per-arm ELF offsets). Walks the tokenized text
 * with the same segment logic as findCatastrophicRmInCommand, but WITHOUT
 * collapsing `$(…)` away — the substitutions are the signal here.
 */
function findDangerousRmV281Block(
  text: string,
): CatastrophicSubstitutionBlock | null {
  if (!/\brm(?:dir)?\b/.test(text)) {
    return null
  }
  const tokenized = tokenizeForDangerousRm281(text)
  // splitCommandForRm unescapes backslashes per shell semantics — and eats
  // an unpaired trailing `\` entirely — so ALSO walk naive operator splits
  // of the tokenized text. Without the fallback a backslash-only target
  // (the #110 Git Bash drive-root arm) never reaches the analyzer.
  // Fail-safe direction: analyze more views, never fewer; the v281 arms are
  // narrow enough (exact target shapes) that the extra views add no false
  // positives on quoted text.
  const naiveSegments = tokenized.split(/[;|\n\r]|&&/)
  for (const sub of [...splitCommandForRm(tokenized), ...naiveSegments]) {
    let r = sub.replace(/\\\r?\n/g, ' ').trimStart()
    while (r.startsWith('(') || r.startsWith('{')) {
      r = r.slice(1).trimStart()
    }
    for (let prev = ''; prev !== r; ) {
      prev = r
      r = r.replace(/(?<!\$)\([^()]*\)/g, ' ')
    }
    r = r.replace(/(?<![<>&])&(?![<>&])/g, ';')
    for (const seg of r.split(/[;|\n\r]|&&/)) {
      const o = seg.trimStart()
      const m = o.match(CATASTROPHIC_RM_COMMAND_RE)
      if (m === null) {
        continue
      }
      const cmd = m[1] === 'rmdir' ? 'rmdir' : 'rm'
      const args = o
        .slice(m[0].length)
        .split(/\s+/)
        .filter((a) => a !== '')
      const block = analyzeRmArgsV281(cmd, args)
      if (block !== null) {
        return block
      }
    }
  }
  return null
}
