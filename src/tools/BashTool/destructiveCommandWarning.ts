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

import { homedir } from 'node:os'
import { splitCommand_DEPRECATED as splitCommandForRm } from '../../utils/bash/commands.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isDangerousRemovalPath } from '../../utils/permissions/pathValidation.js'

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
// biome-ignore lint/complexity/useRegexLiterals: the autofix mangles the `\\/` escapes — regex-literal form changes the pattern's meaning (a literal `/` would close the literal early).
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

// ─────────────────────────────────────────────────────────────────────────
// Official 2.1.281 `gFt` substitution-target pipeline (OCC-136 S1 port)
//
// v2.1.281 hardened the dangerous-rm guard against the attack shape where
// the rm TARGET ITSELF is command-substitution output (`rm -rf "$(pwd)"`):
// substitutions are normalized to `__CMDSUB__` placeholders, the normalized
// text is re-parsed per command, argv[0] is basenamed (NEW in 281), safe +
// privilege wrappers are stripped (`Rp`→`aFt`), and the resolved rm/rmdir
// args are checked for two new verdict kinds:
//
//   • emptyExpansion   — a target whose `__CMDSUB__` tail could expand to
//                        nothing, leaving a catastrophic residual path
//                        (`rm -rf /$(pwd)` → `/`).
//   • wholeSubstitution — a recursive rm whose target is PURELY substitution
//                        output (`rm -rf $(…)`), gated by env
//                        CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT and
//                        GrowthBook `tengu_iridescent_boot` (default true).
//
// Byte-exact ports below (verified against the v2.1.281 linux-x64 ELF,
// md5 d00df59384be94d0b5cac74849540075): normalizeCommandSubstitutions
// (gFt's three replace loops), skipTimeoutArgs (FMe), skipStdbufArgsLocal
// (nTo), skipEnvArgsLocal (oTo), stripSafeWrapperArgv (Rp),
// stripTimeFamilyArgv (uEo), stripPrivilegeWrapperArgv (aFt + fEo/pEo/mEo
// maps), resolveDestructiveVerb (Zw + Zvo set).
//
// OCC divergences (deliberate, documented in docs/upstream-version-gap-occ136.md):
//   1. The official parses the normalized text with tree-sitter
//      (`Ise(Ee)`, kind==="simple"); OCC has no WASM parser at runtime, so a
//      quote-aware tokenizer + splitCommandForRm reproduce the observable
//      contract (quotes consumed and concatenated within a word, splits on
//      unquoted whitespace/operators).
//   2. The official returns an ASK verdict with
//      `classifierApprovable:!1, circuitBreaker:"dangerousRemoval"`; OCC's
//      call site denies in ALL modes (established #41 divergence — strictly
//      stronger, bypass-immune).
//   3. The official gate is `!(value===!1&&source==="payload")`; OCC's
//      GrowthBook stub exposes no `source`, so an explicit `false` value
//      disables the guard (default true keeps it on).
//   4. Leading shell keywords (`then`/`do`/`else`/`elif`/`!`/`if`/`while`/
//      `until`/`for`/`select`/`case`) AND standalone structural group tokens
//      (`{`/`(`/`}`/`)`) are skipped before verb resolution — before AND
//      after wrapper stripping. The official AST nests brace groups,
//      subshells, and control flow structurally and visits the inner
//      `simple` command; OCC's string-level split surfaces the opener as
//      token 0 (`{ rm -rf $(pwd); }` → segment `{ rm -rf __CMDSUB__`). Glued
//      openers (`{rm`) are NOT stripped — bash requires whitespace after the
//      `{` reserved word, and the official AST agrees it is a plain command
//      name (same compensation pattern as the 2.1.273 per-segment port).
//   5. OCC's cheap `/\brm(?:dir)?\b/` raw-text word gates additionally test
//      a quote/backslash-stripped projection (passesRmVerbGate) so
//      quote-concatenated verbs (`r'm'`, `r"m"`, `r\m` — all executed by bash
//      as `rm`) reach the tokenizer, which resolves them to the real verb.
//      The official has no raw-text prefilter (tree-sitter parses every
//      command), so this restores official behavior; strictly stronger than
//      the raw-text form (same direction as divergence 2). The per-segment
//      resolved-verb check remains the source of truth — the projection
//      cannot create false denies.
// ─────────────────────────────────────────────────────────────────────────

const CMDSUB_PLACEHOLDER = '__CMDSUB__'
const MAX_CMDSUB_NORMALIZE_ITERATIONS = 16

// Official `XNt`: simple argv token shape (timeout `-k`/`-s` flag values).
const SIMPLE_ARGV_TOKEN_RE = /^[A-Za-z0-9_.+-]+$/
// Official `JNt`: env-var assignment token (`FOO=…`, `FOO+=…`).
const ENV_ASSIGNMENT_ARGV_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
// Official duration shape accepted after timeout flags.
const TIMEOUT_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/
// Official v281 wholeSubstitution target shape: the arg consists solely of
// `__CMDSUB__` runs, optionally joined/trailed by `/`, `*`, `.` characters.
const WHOLE_SUBSTITUTION_TARGET_RE = /^(?:__CMDSUB__[/*.]*)+$/
// Official v281 emptyExpansion tail detect/strip regexes (byte-exact).
const SUBSTITUTION_TAIL_RE =
  /.(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+(?:\/\.\.)*\/*$/
// Official strip regex `/(.)(?:__CMDSUB__(?:(?!\.\.)[/*.])*)+((?:\/\.\.)*)\/*$/`
// replaced with `"$1$2"`. OCC keeps the run as an explicit capture group so
// the leftover can be reported; the `$1$3` replacement below drops it exactly
// like the official `$1$2` (group 1 = preceding char, group 3 = `/..` tail).
const SUBSTITUTION_TAIL_STRIP_RE =
  /(.)((?:__CMDSUB__(?:(?!\.\.)[/*.])*)+)((?:\/\.\.)*)\/*$/
const SUBSTITUTION_TAIL_STRIP_REPLACEMENT = '$1$3'
// Official v281 recursive-flag shapes checked BEFORE the first `--`.
const LONG_RECURSIVE_FLAG_RE = /^--r/
const SHORT_RECURSIVE_FLAG_RE = /^-[a-zA-Z]*[rR]/
// argv[0] basename step (NEW in v281: `De[0]=De[0].replace(/^.*[\\/]/,"")`).
const ARGV_BASENAME_RE = /^.*[\\/]/

// Official `jy` ask-builder message for the wholeSubstitution verdict
// (byte-exact v2.1.281 wording).
const WHOLE_SUBSTITUTION_MESSAGE =
  'Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints.'
// Official `jy` reason suffix (the builder prepends `Dangerous ${verb} operation `).
const WHOLE_SUBSTITUTION_REASON =
  'Dangerous rm operation on statically-unresolvable target: command substitution output'

// Shell keywords a string-level splitter can leave glued in front of the
// real command (the official AST nests them structurally instead). Control
// keywords (`if`/`while`/`until`/`for`/`select`/`case`) are reserved words —
// they can never be a command verb themselves, so skipping them in token-0
// position is safe (`if rm -rf $(pwd); then …` runs the rm as the condition).
const LEADING_SHELL_KEYWORDS = new Set([
  'then',
  'do',
  'else',
  'elif',
  '!',
  'if',
  'while',
  'until',
  'for',
  'select',
  'case',
])

// Standalone brace-group / subshell tokens left in token-0 position by the
// string-level splitter (`{ rm -rf $(pwd); }` → segment `{ rm -rf __CMDSUB__`).
// bash requires whitespace after the `{` reserved word, so a genuine brace
// group ALWAYS tokenizes `{` as a standalone word; a glued `{rm` stays one
// token and is NOT stripped — bash (and the official AST) treat it as a plain
// (nonexistent) command name, not a group. `(`/`)` normally arrive as their
// own segments from splitCommandForRm; they are listed for direct calls and
// degenerate splits. Closing tokens appear alone in their own segments.
const LEADING_STRUCTURAL_TOKENS = new Set(['{', '(', '}', ')'])

/**
 * OCC divergence 4 (extended): drop leading control-flow keywords and
 * structural group tokens until a real command word surfaces. The official
 * tree-sitter AST nests brace groups, subshells, and control flow
 * structurally and analyzes the inner `simple` command directly; OCC's
 * string-level split surfaces the opener as token 0 of the inner segment.
 * Fixpoint loop so stacked forms (`then {`, `if {`, `! {`) all resolve.
 * Immutable: returns a new array, never mutates the input.
 */
function stripLeadingShellSyntax(argv: readonly string[]): string[] {
  let out = argv.slice()
  while (
    out.length > 0 &&
    (LEADING_SHELL_KEYWORDS.has(out[0]!) ||
      LEADING_STRUCTURAL_TOKENS.has(out[0]!))
  ) {
    out = out.slice(1)
  }
  return out
}

// Raw-text rm word gate shared by the substitution guards.
const RM_VERB_GATE_RE = /\brm(?:dir)?\b/

/**
 * OCC divergence 5: sound quote-aware word gate. The official binary has no
 * raw-text prefilter (tree-sitter parses every command and resolves the verb
 * from word nodes, so quote-concatenated verbs like `r'm'`/`r"m"`/`r\m` —
 * which bash executes as `rm` — are caught). OCC's cheap raw-text gate
 * false-negatives on exactly those forms, so ALSO test a projection with
 * quote/backslash characters removed. Removal is monotonic: it can only fuse
 * characters into new `rm` matches, never destroy an existing one, so the
 * gate never false-negatives relative to the raw form. The projection is an
 * over-approximation — the per-segment resolved-verb check below stays the
 * source of truth, so a spurious gate pass costs at most a tokenize and can
 * never produce a false deny.
 */
function passesRmVerbGate(text: string): boolean {
  return (
    RM_VERB_GATE_RE.test(text) ||
    RM_VERB_GATE_RE.test(text.replace(/['"\\]/g, ''))
  )
}

/**
 * Official v281 `gFt` normalization (byte-exact regexes): backticks in one
 * pass, then `$(…)` to a fixpoint (≤16 iterations, handles nesting), then
 * `${VAR:-…}`-style defaults whose value is purely substitution output
 * collapse to that output (so `rm -rf "${X:-$(cmd)}"` normalizes like the
 * bare substitution).
 */
export function normalizeCommandSubstitutions(text: string): string {
  let out = text.replace(/`[^`]*`/g, CMDSUB_PLACEHOLDER)
  for (
    let prev = '', i = 0;
    prev !== out && i < MAX_CMDSUB_NORMALIZE_ITERATIONS;
    i++
  ) {
    prev = out
    out = out.replace(/\$\([^()]*\)/g, CMDSUB_PLACEHOLDER)
  }
  for (
    let prev = '', i = 0;
    prev !== out && i < MAX_CMDSUB_NORMALIZE_ITERATIONS;
    i++
  ) {
    prev = out
    out = out.replace(
      /\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-]):?[-=+?]"?((?:__CMDSUB__[/*.]*)+)"?\}/g,
      '$1',
    )
  }
  return out
}

/**
 * Quote-aware argv tokenizer for the normalized text. Reproduces the
 * observable contract of the official AST word nodes: quote characters are
 * consumed (not kept), adjacent quoted/unquoted runs concatenate into ONE
 * word (`"__CMDSUB__"/*` → `__CMDSUB__/*`), splits happen on unquoted
 * whitespace, and backslash escapes the next character.
 */
function tokenizeNormalizedSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[i + 1]!
      hasToken = true
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = segment.indexOf(ch, i + 1)
      if (close === -1) {
        // Unbalanced quote: consume the remainder as word content.
        current += segment.slice(i + 1)
        hasToken = true
        break
      }
      current += segment.slice(i + 1, close)
      hasToken = true
      i = close
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) {
    tokens.push(current)
  }
  return tokens
}

/** Official `FMe` (byte-exact): argv count consumed by timeout's flags. */
function skipTimeoutArgs(a: readonly string[]): number {
  let n = 1
  while (n < a.length) {
    const r = a[n]!
    const s = a[n + 1]
    if (r === '--foreground' || r === '--preserve-status' || r === '--verbose')
      n++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(r)) n++
    else if (
      (r === '--kill-after' || r === '--signal') &&
      s !== undefined &&
      SIMPLE_ARGV_TOKEN_RE.test(s)
    )
      n += 2
    else if (r === '--') {
      n++
      break
    } else if (r.startsWith('--')) return -1
    else if (r === '-v') n++
    else if (
      (r === '-k' || r === '-s') &&
      s !== undefined &&
      SIMPLE_ARGV_TOKEN_RE.test(s)
    )
      n += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(r)) n++
    else if (r.startsWith('-')) return -1
    else break
  }
  return n
}

/** Official `nTo` (byte-exact): argv count consumed by stdbuf's flags. */
function skipStdbufArgsLocal(a: readonly string[]): number {
  let n = 1
  while (n < a.length) {
    const r = a[n]!
    if (/^-[ioe]$/.test(r) && a[n + 1]) n += 2
    else if (/^-[ioe]./.test(r)) n++
    else if (/^--(input|output|error)=/.test(r)) n++
    else if (r.startsWith('-')) return -1
    else break
  }
  return n > 1 && n < a.length ? n : -1
}

/** Official `oTo` (byte-exact): argv count consumed by env's flags/vars. */
function skipEnvArgsLocal(a: readonly string[]): number {
  let n = 1
  while (n < a.length) {
    const r = a[n]!
    if (r.includes('=') && !r.startsWith('-')) n++
    else if (r === '-i' || r === '-0' || r === '-v') n++
    else if (r === '-u' && a[n + 1]) n += 2
    else if (r.startsWith('-')) return -1
    else break
  }
  return n < a.length ? n : -1
}

/**
 * Official `Rp` (byte-exact): strips the safe wrapper family
 * (time/nohup/timeout/nice/stdbuf/env/command/builtin/noglob) from argv.
 * argv[0] is basenamed for wrapper-name matching only (slices keep the
 * original token). Unparseable wrapper flags fail CLOSED (return unchanged).
 */
function stripSafeWrapperArgv(input: readonly string[]): string[] {
  let n = input.slice()
  for (;;) {
    const base = n[0]?.replace(ARGV_BASENAME_RE, '')
    const s =
      base === 'time' ||
      base === 'nohup' ||
      base === 'timeout' ||
      base === 'nice' ||
      base === 'stdbuf' ||
      base === 'env' ||
      base === 'command'
        ? base
        : n[0]
    if (s === 'time' || s === 'nohup') n = n.slice(n[1] === '--' ? 2 : 1)
    else if (s === 'timeout') {
      const g = skipTimeoutArgs(n)
      if (g < 0 || n[g] === undefined || !TIMEOUT_DURATION_RE.test(n[g]!))
        return n
      n = n.slice(g + 1)
    } else if (s === 'nice') {
      if (n[1] === '-n' && n[2] && /^-?\d+$/.test(n[2]))
        n = n.slice(n[3] === '--' ? 4 : 3)
      else if (n[1] && /^-\d+$/.test(n[1])) n = n.slice(n[2] === '--' ? 3 : 2)
      else n = n.slice(n[1] === '--' ? 2 : 1)
    } else if (s === 'stdbuf') {
      const g = skipStdbufArgsLocal(n)
      if (g < 0) return n
      n = n.slice(g)
    } else if (s === 'env') {
      const g = skipEnvArgsLocal(n)
      if (g < 0) return n
      n = n.slice(g)
    } else if (s === 'command') {
      let g = 1
      while (n[g] !== undefined && /^-p+$/.test(n[g]!)) g++
      if (n[g] === '--') g++
      if (g >= n.length || n[g]!.startsWith('-')) return n
      n = n.slice(g)
    } else if (n[0] === 'builtin') {
      const g = n[1] === '--' ? 2 : 1
      if (g >= n.length) return n
      n = n.slice(g)
    } else if (n[0] === 'noglob') {
      if (n.length <= 1) return n
      n = n.slice(1)
    } else return n
  }
}

/**
 * Official `uEo` (byte-exact): the narrower time-family strip applied inside
 * `aFt`'s loop (time/nohup/timeout/nice `-n N` only — no bare `nice cmd`,
 * matching the binary).
 */
function stripTimeFamilyArgv(input: readonly string[]): string[] {
  let n = input.slice()
  for (;;) {
    if (n[0] === 'time' || n[0] === 'nohup')
      n = n.slice(n[1] === '--' ? 2 : 1)
    else if (n[0] === 'timeout') {
      const r = skipTimeoutArgs(n)
      if (r < 0 || n[r] === undefined || !TIMEOUT_DURATION_RE.test(n[r]!))
        return n
      n = n.slice(r + 1)
    } else if (
      n[0] === 'nice' &&
      n[1] === '-n' &&
      n[2] &&
      /^-?\d+$/.test(n[2])
    )
      n = n.slice(n[3] === '--' ? 4 : 3)
    else return n
  }
}

// Official `fEo`: per-wrapper flags that consume a separate VALUE argument.
const PRIVILEGE_WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  sudo: new Set([
    '-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-R', '-t', '-T',
    '--user', '--group', '--other-user', '--close-from', '--chdir', '--host',
    '--prompt', '--role', '--chroot', '--type', '--command-timeout', '-a',
    '--auth-type',
  ]),
  doas: new Set(['-a', '-u', '-C']),
  pkexec: new Set(['--user']),
  watch: new Set(['-n', '--interval', '--equexit']),
  ionice: new Set([
    '-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid',
    '--uid',
  ]),
  setsid: new Set([]),
  taskset: new Set(['-c', '--cpu-list']),
  chrt: new Set([
    '-p', '--pid', '-T', '-P', '-D', '--sched-runtime', '--sched-period',
    '--sched-deadline',
  ]),
  strace: new Set([
    '-e', '-o', '-p', '-s', '-E', '-P', '-S', '-a', '-b', '-I', '-u', '-X',
    '-O', '-U', '--output', '--trace', '--expr', '--attach', '--string-limit',
    '--env', '--trace-path', '--columns', '--user', '--interruptible',
    '--detach-on', '--const-print-style', '--summary-sort-by',
    '--summary-syscall-overhead', '--summary-columns',
  ]),
  ltrace: new Set([
    '-a', '-A', '-e', '-l', '-n', '-o', '-p', '-s', '-u', '-x', '-D', '-F',
    '--align', '--config', '--debug', '--indent', '--library', '--output',
    '--string-max', '-w', '--where',
  ]),
  flock: new Set(['-w', '-E', '--timeout', '--wait', '--conflict-exit-code']),
  script: new Set([
    '-E', '-T', '-m', '-o', '-O', '-B', '-I', '--echo', '--log-timing',
    '--logging-format', '--output-limit', '--log-out', '--log-io', '--log-in',
  ]),
  unshare: new Set([
    '-R', '-w', '-S', '-G', '--setuid', '--setgid', '--root', '--wd',
    '--propagation', '--setgroups', '--monotonic', '--boottime',
  ]),
  nsenter: new Set(['-t', '-S', '-G', '--target', '--setuid', '--setgid']),
  exec: new Set(['-a']),
  command: new Set([]),
  builtin: new Set([]),
  noglob: new Set([]),
  nocorrect: new Set([]),
}

// Official `pEo`: flags whose value is a COMMAND STRING (`env -S`, `flock -c`,
// `script -c`) — the string is re-tokenized and the strip loop recurses.
const PRIVILEGE_WRAPPER_COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-S', '--split-string']),
  flock: new Set(['-c', '--command']),
  script: new Set(['-c', '--command']),
}

// Official `mEo`: wrappers taking a bare positional before the command.
const PRIVILEGE_WRAPPER_POSITIONAL_CHECKS: Record<
  string,
  (value: string) => boolean
> = {
  chrt: (v) => /^\d+$/.test(v),
  taskset: (v) => /^(0x[\da-f]+|\d+)$/i.test(v),
  flock: () => true,
  script: () => true,
}

/**
 * Official `aFt` (byte-exact): strips env-var assignments and the privilege /
 * tracer wrapper family (sudo/doas/pkexec/watch/ionice/setsid/taskset/chrt/
 * strace/ltrace/flock/script/unshare/nsenter/exec/command/builtin/noglob/
 * nocorrect/env) from argv, recursing through `-c`-style command strings.
 */
function stripPrivilegeWrapperArgv(input: readonly string[]): string[] {
  let n = input.slice()
  for (;;) {
    while (n[0] !== undefined && ENV_ASSIGNMENT_ARGV_RE.test(n[0]))
      n = n.slice(1)
    n = stripTimeFamilyArgv(n)
    const r = n[0]
    if (r === undefined) return n
    const s = PRIVILEGE_WRAPPER_VALUE_FLAGS[r]
    if (s === undefined) return n
    const g = PRIVILEGE_WRAPPER_COMMAND_FLAGS[r]
    const h = PRIVILEGE_WRAPPER_POSITIONAL_CHECKS[r]
    let i = 1
    let cmdString: string | undefined
    let positionalTaken = false
    while (i < n.length) {
      const N = n[i]!
      if (N === '--') {
        i++
        if (
          !positionalTaken &&
          h !== undefined &&
          i + 1 < n.length &&
          h(n[i]!)
        ) {
          positionalTaken = true
          i++
          continue
        }
        break
      }
      if (g !== undefined) {
        if (g.has(N) && n[i + 1] !== undefined) {
          const G = n[i + 1]!.trim()
          if (G !== '') {
            cmdString = G
            break
          }
          i += 2
          continue
        }
        const U = N.indexOf('=')
        if (U > 0 && g.has(N.slice(0, U))) {
          const G = N.slice(U + 1).trim()
          if (G !== '') {
            cmdString = G
            break
          }
          i++
          continue
        }
        if (N.length > 2 && N[1] !== '-' && g.has(N.slice(0, 2))) {
          const G = N.slice(2).trim()
          if (G !== '') {
            cmdString = G
            break
          }
          i++
          continue
        }
      }
      if (N.startsWith('-') && (N !== '-' || h === undefined)) {
        if (r === 'command' && /^-[pvV]+$/.test(N) && /[vV]/.test(N)) return n
        i += s.has(N) && i + 1 < n.length ? 2 : 1
        continue
      }
      if (r === 'env' && ENV_ASSIGNMENT_ARGV_RE.test(N)) {
        i++
        continue
      }
      if (!positionalTaken && h?.(N) && i + 1 < n.length) {
        positionalTaken = true
        i++
        continue
      }
      break
    }
    if (cmdString !== undefined) {
      n = cmdString.trim().split(/\s+/)
      if (n.length === 0 || n[0] === '') return input.slice()
      continue
    }
    if (i >= n.length) return n
    n = n.slice(i)
  }
}

// Official `Zvo` set + `Zw` verb resolution (byte-exact): basename first;
// rm/rmdir/tee match case-sensitively; otherwise only a case-insensitive
// `tee[.exe]` maps to `tee` and everything else is returned unchanged.
const DESTRUCTIVE_VERB_SET = new Set(['rm', 'rmdir', 'tee'])

function resolveDestructiveVerb(argv0: string | undefined): string | undefined {
  if (!argv0) return argv0
  const base = argv0.replace(ARGV_BASENAME_RE, '')
  if (DESTRUCTIVE_VERB_SET.has(base)) return base
  return base.toLowerCase().replace(/\.exe$/, '') === 'tee' ? 'tee' : argv0
}

/**
 * Residual-target check for the emptyExpansion verdict: after stripping the
 * `__CMDSUB__` tail, would the leftover path be a catastrophic removal
 * target? Tilde forms expand against the real home dir first (the official
 * `x$` classifier resolves `~` via `Pd` before its critical-path checks).
 */
function isDangerousResidualRemovalTarget(residual: string): boolean {
  if (residual === '') return false
  let expanded = residual
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\'))
    expanded = homedir() + expanded.slice(1)
  return isDangerousRemovalPath(expanded)
}

/**
 * Port of the official 2.1.281 `gFt` per-command substitution-target
 * analysis. Given a raw command text, normalizes substitutions to
 * `__CMDSUB__`, walks each operator-split segment, resolves the real command
 * verb through basename + wrapper stripping, and returns the first
 * emptyExpansion / wholeSubstitution verdict (official check order), or null.
 *
 * Exported for unit tests; production callers go through
 * findCatastrophicSubstitutionBlock.
 */
export function findSubstitutionTargetBlock(
  rawText: string,
): CatastrophicSubstitutionBlock | null {
  const normalized = normalizeCommandSubstitutions(rawText)
  // Official `xe`: both new verdicts require that normalization changed the
  // text (i.e. a substitution is actually present in this scope).
  if (normalized === rawText) return null
  // Cheap word gate, made sound against bash quote-concatenated verbs
  // (`r'm'` → `rm`) — see passesRmVerbGate. The per-segment resolved-verb
  // check below remains the source of truth.
  if (!passesRmVerbGate(normalized)) return null
  for (const seg of splitCommandForRm(normalized)) {
    const tokens = tokenizeNormalizedSegment(seg)
    if (tokens.length === 0) continue
    // v281 NEW: basename argv[0] before wrapper resolution.
    let argv = [tokens[0]!.replace(ARGV_BASENAME_RE, ''), ...tokens.slice(1)]
    // OCC divergence 4: skip leading control-flow keywords and structural
    // group tokens the string-level splitter leaves in token 0
    // (`if x; then rm -rf $(pwd); fi`, `{ rm -rf $(pwd); }`).
    argv = stripLeadingShellSyntax(argv)
    if (argv.length === 0) continue
    // Official: `$e=aFt(Rp(De))`. The second structural pass handles a
    // wrapper preceding a group opener (`sudo { rm -rf $(pwd); }` → stripping
    // `sudo` surfaces `{`).
    const stripped = stripLeadingShellSyntax(
      stripPrivilegeWrapperArgv(stripSafeWrapperArgv(argv)),
    )
    if (stripped.length === 0) continue
    const verb = resolveDestructiveVerb(stripped[0])
    if (verb !== 'rm' && verb !== 'rmdir') continue
    const args = stripped.slice(1)
    // Official order: literalTarget (approximated by analyzeText's
    // RM_ROOT_HOME check, which runs BEFORE this function at the call site),
    // then emptyExpansion, then wholeSubstitution.
    if (args.some((t) => SUBSTITUTION_TAIL_RE.test(t))) {
      const residuals = args.map((t) =>
        t.replace(SUBSTITUTION_TAIL_STRIP_RE, SUBSTITUTION_TAIL_STRIP_REPLACEMENT),
      )
      const dangerous = residuals.find((t) =>
        isDangerousResidualRemovalTarget(t),
      )
      if (dangerous !== undefined) {
        return {
          category: 'rm_substitution_empty_expansion',
          kind: 'emptyExpansion',
          reason: `Dangerous ${verb} operation detected: a command substitution in the target may expand to nothing, leaving '${dangerous}'`,
        }
      }
    }
    const flagsBeforeSeparator = args.includes('--')
      ? args.slice(0, args.indexOf('--'))
      : args
    if (
      verb === 'rm' &&
      flagsBeforeSeparator.some(
        (t) => LONG_RECURSIVE_FLAG_RE.test(t) || SHORT_RECURSIVE_FLAG_RE.test(t),
      ) &&
      args.some((t) => WHOLE_SUBSTITUTION_TARGET_RE.test(t))
    ) {
      const envDisabled = Boolean(
        process.env.CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT,
      )
      const gate = getFeatureValue_CACHED_MAY_BE_STALE<boolean>(
        'tengu_iridescent_boot',
        true,
      )
      if (!envDisabled && gate !== false) {
        return {
          category: 'rm_substitution_whole_target',
          kind: 'wholeSubstitution',
          reason: WHOLE_SUBSTITUTION_REASON,
          message: WHOLE_SUBSTITUTION_MESSAGE,
        }
      }
      // Official logs `tengu_bash_dangerous_rm_too_complex {kind:"wholeSubstitution"}`
      // even on the gated-off path; OCC's stub analytics make that a no-op —
      // the gate decision itself is observable via the env/feature values.
    }
  }
  return null
}

export type CatastrophicSubstitutionKind =
  | 'wholeSubstitution'
  | 'literalTarget'
  | 'emptyExpansion'
  | 'emptyVariable'
  | 'tooManySubstitutions'

export type CatastrophicSubstitutionBlock = {
  category: string
  reason: string
  /**
   * Official 2.1.281 verdict kind — `gFt` returns `{result, kind}` and the
   * kind feeds the `tengu_bash_dangerous_rm_too_complex` telemetry payload
   * (byte-verified: kinds are wholeSubstitution / literalTarget /
   * emptyExpansion / emptyVariable / tooManySubstitutions).
   */
  kind: CatastrophicSubstitutionKind
  /**
   * Rich user-facing message from the official `jy` ask builder. When set,
   * the call site surfaces this text verbatim (byte-exact official wording)
   * instead of the generic "Destructive command blocked: …" wrapper.
   */
  message?: string
  /**
   * Official `tengu_bash_dangerous_rm_shape` telemetry shape, when the
   * detection corresponds to a `$z(…)` call site in the binary. OCC's
   * regex-level variable-path detector only distinguishes the root-child
   * shape (`$z("var_root_child")`); `derived_var`/`eval_trap_string` need the
   * official's full `Joe`/`MMe` variable-tracking analyzer (not ported).
   */
  shape?: 'var_root_child' | 'derived_var' | 'eval_trap_string'
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
    // Sound quote-aware gate (divergence 5): this path EARLY-RETURNS, so a
    // raw-text miss on `r'm'` would skip the whole substitution analysis.
    if (passesRmVerbGate(command)) {
      return {
        category: 'rm_substitution_too_many',
        kind: 'tooManySubstitutions',
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
      return {
        category: 'rm_substitution_var_path',
        // Closest official verdict: the variable may expand to nothing,
        // leaving a root-level glob (`$UNSET/*` → `/*`).
        kind: 'emptyVariable',
        shape: 'var_root_child',
        reason: `Dangerous ${varMatch.command} operation detected inside command substitution: '${varMatch.target}'`,
      }
    }
    // Literal root/home catastrophic removal inside the substitution body.
    // RM_ROOT_HOME_PATTERN's `~`/`/`/`$HOME` follow-set matches end-of-string,
    // so a body like `rm -rf ~` or `rm -rf /` is caught here.
    if (RM_ROOT_HOME_PATTERN.test(c)) {
      return {
        category: 'rm_substitution_root_home',
        kind: 'literalTarget',
        reason:
          'rm -rf targeting the root or home directory detected inside command substitution',
      }
    }
    return null
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
      // Official 2.1.281 `gFt` per-command order: literalTarget (approximated
      // by the RM_ROOT_HOME check in analyzeText above), then emptyExpansion,
      // then wholeSubstitution — both new v281 verdicts live here.
      const substBlock = findSubstitutionTargetBlock(text)
      if (substBlock !== null) {
        return substBlock
      }
    }
  }
  return null
}
