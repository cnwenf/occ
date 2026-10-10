/**
 * AST-based bash command analysis using tree-sitter.
 *
 * This module replaces the shell-quote + hand-rolled char-walker approach in
 * bashSecurity.ts / commands.ts. Instead of detecting parser differentials
 * one-by-one, we parse with tree-sitter-bash and walk the tree with an
 * EXPLICIT allowlist of node types. Any node type not in the allowlist causes
 * the entire command to be classified as 'too-complex', which means it goes
 * through the normal permission prompt flow.
 *
 * The key design property is FAIL-CLOSED: we never interpret structure we
 * don't understand. If tree-sitter produces a node we haven't explicitly
 * allowlisted, we refuse to extract argv and the caller must ask the user.
 *
 * This is NOT a sandbox. It does not prevent dangerous commands from running.
 * It answers exactly one question: "Can we produce a trustworthy argv[] for
 * each simple command in this string?" If yes, downstream code can match
 * argv[0] against permission rules and flag allowlists. If no, ask the user.
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { SHELL_KEYWORDS } from './bashParser.js'
import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export type SimpleCommand = {
  /** argv[0] is the command name, rest are arguments with quotes already resolved */
  argv: string[]
  /** Leading VAR=val assignments */
  envVars: { name: string; value: string }[]
  /** Output/input redirects */
  redirects: Redirect[]
  /** Original source span for this command (for UI display) */
  text: string
  /**
   * CC 2.1.289+: quote-aware whole-text scan of the ORIGINAL source span
   * for unquoted glob chars (`*`, `?`, `[`). Official `hasUnquotedGlob`,
   * produced at every SimpleCommand construction site via `T(e.text)`
   * (2.1.289) / `I(e.text)` (2.1.290). Consumed by the awk/find gates in
   * checkSemantics: an unquoted glob can expand to a planted program or
   * flag before the command runs.
   */
  hasUnquotedGlob: boolean
  /**
   * CC 2.1.290: per-argv-element unquoted-glob record, parallel to argv.
   * Official `argvUnquotedGlob` — set only by the simple-command walker
   * (`Kt`); declaration/test/unset/redirect-only sites leave it undefined
   * and `kAn`'s undefined-fallback semantics apply. Element rule (official
   * verbatim): word-like node → `I(node.text) || me(node)`; bare
   * `$VAR` (simple_expansion) → `true` (resolved value's source quoting is
   * not visible in the node text).
   */
  argvUnquotedGlob?: boolean[]
  /**
   * CC 2.1.290: official `carveOutMayDesyncQuoteScan` — true when a
   * cat-heredoc command-substitution carve-out during this command's walk
   * had quote/backtick/backslash chars in its text (`gt.test(p.text) →
   * N++`), meaning the whole-text quote scan may desync from bash's real
   * quote state. `kAn` then falls back to the conservative resolved-argv
   * scan.
   */
  carveOutMayDesyncQuoteScan?: boolean
}

export type ParseForSecurityResult =
  | {
      kind: 'simple'
      commands: SimpleCommand[]
      /**
       * Official 2.1.290 #5 (gap-research-291 cluster-a): variable names set as
       * a PREFIX of a special declaration builtin (`X=v declare|typeset|export|
       * readonly|local …`). Bash persists these into the shell (unlike a normal
       * command's transient env prefix), so a later `$X` may resolve to the
       * assigned value. Present only on the BASE parse (no `declarationPrefix`
       * reading) and only when at least one prefix name was seen — mirrors
       * official's `declarationPrefixes` (count = `.length`) /
       * `declarationPrefixBashKeeps` (names) reporting when `s===void 0`.
       */
      declarationPrefixes?: string[]
    }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

/**
 * Options for `parseForSecurityFromAst`. `declarationPrefix` is the official
 * 2.1.290 `Az(…,{declarationPrefix:s})` reading: a boolean per prefix name
 * (in source order) saying whether that name is treated as PERSISTED into the
 * shell. `undefined` = base parse (persist all, report `declarationPrefixes`).
 */
export type ParseForSecurityOptions = {
  declarationPrefix?: boolean[]
}

/**
 * Structural node types that represent composition of commands. We recurse
 * through these to find the leaf `command` nodes. `program` is the root;
 * `list` is `a && b || c`; `pipeline` is `a | b`; `redirected_statement`
 * wraps a command with its redirects. Semicolon-separated commands appear
 * as direct siblings under `program` (no wrapper node).
 */
const STRUCTURAL_TYPES = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
])

/**
 * Operator tokens that separate commands. These are leaf nodes that appear
 * between commands in `list`/`pipeline`/`program` and carry no payload.
 */
const SEPARATOR_TYPES = new Set(['&&', '||', '|', ';', '&', '|&', '\n'])

/**
 * Placeholder string used in outer argv when a $() is recursively extracted.
 * The actual $() output is runtime-determined; the inner command(s) are
 * checked against permission rules separately. Using a placeholder keeps
 * the outer argv clean (no multi-line heredoc bodies polluting path
 * extraction or triggering newline checks).
 */
const CMDSUB_PLACEHOLDER = '__CMDSUB_OUTPUT__'

/**
 * Placeholder for simple_expansion ($VAR) references to variables set earlier
 * in the same command via variable_assignment. Since we tracked the assignment,
 * we know the var exists and its value is either a static string or
 * __CMDSUB_OUTPUT__ (if set via $()). Either way, safe to substitute.
 */
const VAR_PLACEHOLDER = '__TRACKED_VAR__'

/**
 * All placeholder strings. Used for defense-in-depth: if a varScope value
 * contains ANY placeholder (exact or embedded), the value is NOT a pure
 * literal and cannot be trusted as a bare argument. Covers composites like
 * `VAR="prefix$(cmd)"` → `"prefix__CMDSUB_OUTPUT__"` — the substring check
 * catches these where exact-match Set.has() would miss.
 *
 * Also catches user-typed literals that collide with placeholder strings:
 * `VAR=__TRACKED_VAR__ && rm $VAR` — treated as non-literal (conservative).
 */
function containsAnyPlaceholder(value: string): boolean {
  return value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER)
}

/*
 * ============================================================================
 * CC 2.1.289/2.1.290 unquoted-glob machinery — verbatim ports from the
 * official bash-security module (2.1.289 `T()`; 2.1.290 `I()`, `St`/`V()`,
 * `me()`, `kAn()`, `gt`/`N`). Consumed by the awk/find gates in
 * checkSemantics and produced by walkCommand / the SimpleCommand push sites.
 * ============================================================================
 */

/**
 * Quote-aware whole-text scan for unquoted glob characters. Official
 * 2.1.289 `T(e)` / 2.1.290 `I(e)`, verbatim state machine: tracks
 * single-quote, double-quote, backtick, backslash-escape and
 * word-start-`#`-comment states; returns true on the first `*`, `?` or `[`
 * that bash would glob-expand (i.e. appears outside quotes/comments).
 */
function hasUnquotedGlobChars(text: string): boolean {
  let inBacktick = false
  let inSingle = false
  let inDouble = false
  let atWordStart = true
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (inBacktick) {
      if (
        c === '\\' &&
        (text[i + 1] === '`' || text[i + 1] === '\\' || text[i + 1] === '$')
      ) {
        i += 2
      } else {
        if (c === '`') inBacktick = false
        i++
      }
    } else if (inSingle) {
      if (c === "'") inSingle = false
      i++
    } else if (inDouble) {
      if (
        c === '\\' &&
        (text[i + 1] === '"' || text[i + 1] === '\\' || text[i + 1] === '`')
      ) {
        i += 2
      } else if (c === '`') {
        inBacktick = true
        i++
      } else {
        if (c === '"') inDouble = false
        i++
      }
    } else if (c === '\\' && i + 1 < text.length) {
      // Escaped char: a line continuation (\<LF>) preserves word-start,
      // any other escape ends it (so `a\#b` is not a comment).
      if (text[i + 1] !== '\n') atWordStart = false
      i += 2
    } else if (c === '#' && atWordStart) {
      while (i < text.length && text[i] !== '\n') i++
      atWordStart = true
    } else if (c === '`') {
      inBacktick = true
      atWordStart = false
      i++
    } else {
      if (c === '*' || c === '?' || c === '[') return true
      if (c === "'") inSingle = true
      else if (c === '"') inDouble = true
      atWordStart =
        c === ' ' ||
        c === '\t' ||
        c === '\n' ||
        c === ';' ||
        c === '|' ||
        c === '&' ||
        c === '(' ||
        c === ')' ||
        c === '<' ||
        c === '>'
      i++
    }
  }
  return false
}

/**
 * Official 2.1.290 `St` — resolved-argument glob matcher. Unlike
 * hasUnquotedGlobChars this runs on the RESOLVED argv value (quotes
 * already stripped by the walker), and `[` only counts when a later `]`
 * exists (a bare `[` in a resolved value is literal to bash only if
 * unclosed... official keeps the class verbatim: `/[*?]|\[[^\]]*\]/`).
 */
const RESOLVED_ARG_GLOB_RE = /[*?]|\[[^\]]*\]/

/** Official 2.1.290 `V(e)`. */
function resolvedArgHasGlob(arg: string): boolean {
  return RESOLVED_ARG_GLOB_RE.test(arg)
}

/**
 * Official 2.1.290 `gt` — a carved-out command substitution whose text
 * contains quote/backtick/backslash chars may desync the whole-text quote
 * scan (the carve-out replaces a quoted region with a placeholder).
 */
const CMD_SUB_QUOTE_DESYNC_RE = /["`\\]/

/**
 * Official 2.1.290 module-global `N` — incremented by walkString's
 * cat-heredoc carve-out when `gt.test(p.text)`. walkCommand snapshots it
 * at entry (`l=N`) and sets `carveOutMayDesyncQuoteScan: N!==l`. Like the
 * official, the counter is never reset between parses — the per-command
 * snapshot diff is what matters.
 */
let quoteScanCarveOuts = 0

/**
 * Official 2.1.290 `kAn(e)` — verbatim. Decides whether a SimpleCommand's
 * RESOLVED argv/redirects still carry glob risk that the whole-text scan
 * could not see (e.g. a tracked var resolving to `*` inside quotes:
 * `VAR='*' && find . "$VAR"` — .text has no unquoted glob, but the
 * resolved argv element does).
 *
 * Branch semantics (official):
 * - carve-out desync possible, OR no per-arg record and some argv element
 *   holds a placeholder → conservative full scan of argv + non-heredoc
 *   redirect targets;
 * - no record, no placeholder → false (whole-text scan already covered it);
 * - record length mismatch (shouldn't happen) → conservative argv scan;
 * - else → an element counts only when it globs AND (its source was
 *   unquoted-globby OR it holds a placeholder).
 */
function commandHasResolvableUnquotedGlob(cmd: SimpleCommand): boolean {
  const record = cmd.argvUnquotedGlob
  if (
    cmd.carveOutMayDesyncQuoteScan === true ||
    (record === undefined && cmd.argv.some(containsAnyPlaceholder))
  ) {
    return (
      cmd.argv.some(resolvedArgHasGlob) ||
      cmd.redirects.some(
        r => r.op !== '<<' && r.op !== '<<<' && resolvedArgHasGlob(r.target),
      )
    )
  }
  if (record === undefined) return false
  if (record.length !== cmd.argv.length)
    return cmd.argv.some(resolvedArgHasGlob)
  return cmd.argv.some(
    (arg, i) =>
      resolvedArgHasGlob(arg) && (record[i] === true || containsAnyPlaceholder(arg)),
  )
}

/** Official 2.1.290 `Xt`. */
const GLOB_NODE_CHARS = '*?['

/**
 * Official 2.1.290 `me(e)` — verbatim per-node-type unquoted-glob check on
 * a tree-sitter argument node. word/number: raw scan skipping backslash
 * escapes; string/raw_string/simple_expansion/arithmetic_expansion: false
 * (their content is quoted or runtime-resolved — the resolved value is
 * handled by the `kAn` record); concatenation: any child; any other node
 * type: true (fail closed).
 */
function nodeMayContainUnquotedGlob(node: Node): boolean {
  switch (node.type) {
    case 'word':
    case 'number':
      for (let i = 0; i < node.text.length; i++) {
        if (node.text[i] === '\\') i++
        else if (GLOB_NODE_CHARS.includes(node.text[i]!)) return true
      }
      return false
    case 'string':
    case 'raw_string':
    case 'simple_expansion':
    case 'arithmetic_expansion':
      return false
    case 'concatenation':
      return node.children.some(c => c !== null && nodeMayContainUnquotedGlob(c))
    default:
      return true
  }
}

/**
 * Unquoted $VAR in bash undergoes word-splitting (on $IFS: space/tab/NL)
 * and pathname expansion (glob matching on * ? [). Our argv stores a
 * single string — but at runtime bash may produce MULTIPLE args, or paths
 * matched by a glob. A value containing these metacharacters cannot be
 * trusted as a bare arg: `VAR="-rf /" && rm $VAR` → bash runs `rm -rf /`
 * (two args) but our argv would have `['rm', '-rf /']` (one arg). Similarly
 * `VAR="/etc/*" && cat $VAR` → bash expands to all /etc files.
 *
 * Inside double-quotes ("$VAR"), neither splitting nor globbing applies —
 * the value IS a single literal argument.
 */
const BARE_VAR_UNSAFE_RE = /[ \t\n*?[]/

// stdbuf flag forms — hoisted from the wrapper-stripping while-loop
const STDBUF_SHORT_SEP_RE = /^-[ioe]$/
const STDBUF_SHORT_FUSED_RE = /^-[ioe]./
const STDBUF_LONG_RE = /^--(input|output|error)=/

/**
 * Known-safe environment variables that bash sets automatically. Their values
 * are controlled by the shell/OS, not arbitrary user input. Referencing these
 * via $VAR is safe — the expansion is deterministic and doesn't introduce
 * injection risk. Covers `$HOME`, `$PWD`, `$USER`, `$PATH`, `$SHELL`, etc.
 * Intentionally small: only vars that are always set by bash/login and whose
 * values are paths/names (not arbitrary content).
 */
const SAFE_ENV_VARS = new Set([
  'HOME', // user's home directory
  'PWD', // current working directory (bash maintains)
  'OLDPWD', // previous directory
  'USER', // current username
  'LOGNAME', // login name
  'SHELL', // user's login shell
  'PATH', // executable search path
  'HOSTNAME', // machine hostname
  'UID', // user id
  'EUID', // effective user id
  'PPID', // parent process id
  'RANDOM', // random number (bash builtin)
  'SECONDS', // seconds since shell start
  'LINENO', // current line number
  'TMPDIR', // temp directory
  // Special bash variables — always set, values are shell-controlled:
  'BASH_VERSION', // bash version string
  'BASHPID', // current bash process id
  'SHLVL', // shell nesting level
  'HISTFILE', // history file path
  'IFS', // field separator (NOTE: only safe INSIDE strings; as bare arg
  //       $IFS is the classic injection primitive and the insideString
  //       gate in resolveSimpleExpansion correctly blocks it)
])

/**
 * Special shell variables ($?, $$, $!, $#, $0-$9). tree-sitter uses
 * `special_variable_name` for these (not `variable_name`). Values are
 * shell-controlled: exit status, PIDs, positional args. Safe to resolve
 * ONLY inside strings (same rationale as SAFE_ENV_VARS — as bare args
 * their value IS the argument and might be a path/flag from $1 etc.).
 *
 * SECURITY: '@' and '*' are NOT in this set. Inside "...", they expand to
 * the positional params — which are EMPTY in a fresh BashTool shell (how we
 * always spawn). Returning VAR_PLACEHOLDER would lie: `git "push$*"` gives
 * argv ['git','push__TRACKED_VAR__'] while bash passes ['git','push']. Deny
 * rule Bash(git push:*) fails on both .text (raw `$*`) AND rebuilt argv
 * (placeholder). With them removed, resolveSimpleExpansion falls through to
 * tooComplex for `$*` / `$@`. `echo "args: $*"` becomes too-complex —
 * acceptable (rare in BashTool usage; `"$@"` even rarer).
 */
const SPECIAL_VAR_NAMES = new Set([
  '?', // exit status of last command
  '$', // current shell PID
  '!', // last background PID
  '#', // number of positional params
  '0', // script name
  '-', // shell option flags
])

/**
 * CC 2.1.251 security fix: "Bash permission checks auto-approved arithmetic
 * assignments to integer shell variables (OPTIND=1/0, RANDOM=2+2)".
 * Variables that carry a shell integer attribute: bash/zsh arithmetically
 * evaluate the RHS of `NAME=value` assignments to them (and the value of
 * env-prefix assignments), which executes `$(cmd)` inside subscripts and can
 * abort/diverge the shell at runtime. Recovered verbatim from the official
 * 2.1.251 binary (set `or`); CC 2.1.260 extended it with the zsh
 * REPORTTIME/REPORTMEMORY/DIRSTACKSIZE/BAUD integer-attr variables
 * (set `WYe` in the official 2.1.260 binary); CC 2.1.288 #28 ("prompt before
 * a BASHPID assignment whose value the shell would evaluate as arithmetic")
 * extended it to the current 42 members — set `fyt` @203549536 in the
 * official 2.1.288 binary adds BASHPID plus the pre-existing-gap
 * BASH_MONOSECONDS/BASH_TRAPSIG (all three between EPOCHREALTIME and
 * COLUMNS). Members and order below are byte-exact from the v288 `fyt` dump.
 */
const INTEGER_ATTR_SHELL_VARS = new Set([
  'RANDOM',
  'SECONDS',
  'LINENO',
  'OPTIND',
  'MAILCHECK',
  'HISTCMD',
  'SRANDOM',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'BASHPID', // v288 #28
  'BASH_MONOSECONDS', // v288 set member (pre-existing OCC gap closed)
  'BASH_TRAPSIG', // v288 set member (pre-existing OCC gap closed)
  'COLUMNS',
  'LINES',
  'SHLVL',
  'ERRNO',
  'TMOUT',
  'HISTSIZE',
  'SAVEHIST',
  'TRY_BLOCK_ERROR',
  'TRY_BLOCK_INTERRUPT',
  'KEYTIMEOUT',
  'LISTMAX',
  'LOGCHECK',
  'PERIOD',
  'FUNCNEST',
  'UID',
  'EUID',
  'GID',
  'EGID',
  'REPORTTIME',
  'REPORTMEMORY',
  'DIRSTACKSIZE',
  'BAUD',
  'ZLE_RPROMPT_INDENT',
  'MBEGIN',
  'MEND',
  'PPID',
  'ARGC',
  'ZSH_SUBSHELL',
  'TTYIDLE',
  'status',
])

/**
 * Variables whose value alters command lookup/execution for subsequent
 * commands (lowercase-compared): path search, shell/env bootstrap, locale.
 * Recovered verbatim from the official 2.1.251 binary (set `Va`).
 */
const EXEC_INFLUENCING_VARS = new Set([
  'path',
  'home',
  'tmpprefix',
  'bash_env',
  'env',
  'cdpath',
  'globignore',
  'shell',
  'fpath',
  'bash_loadables_path',
  'module_path',
  'manpath',
  'mailpath',
  'readnullcmd',
  'nullcmd',
  'histfile',
  'zdotdir',
  'functions',
  'commands',
  'aliases',
  'galiases',
  'saliases',
  'lang',
  'language',
  'lc_all',
  'lc_ctype',
  'lc_collate',
  'lc_messages',
  'lc_numeric',
  'lc_time',
  'histchars',
  'textdomain',
  'textdomaindir',
])

/**
 * Env-var-style shell variables the static model marks unknown when the
 * shell/host writes them. Recovered verbatim from the official 2.1.251
 * binary (set `Wn`).
 */
const ENV_INFLUENCING_VARS = new Set([
  'HOME',
  'PWD',
  'OLDPWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'HOSTNAME',
  'UID',
  'EUID',
  'PPID',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'TMPDIR',
  'BASH_VERSION',
  'BASHPID',
  'SHLVL',
  'HISTFILE',
  'IFS',
])

/**
 * Shell-managed variables whose value is runtime-determined or expanded by
 * the shell itself (prompts, matches, per-command state). Recovered verbatim
 * from the official 2.1.251 binary (set `Vo`).
 *
 * CC 2.1.296 (changelog: "Fixed Bash permission checks auto-approving some
 * commands that assign the BASH_ARGV0 shell variable and then use it"): the
 * official set — spelled `KLn` in the 2.1.296 binary (minified names drift per
 * build; the MEMBERS are the invariant) — carries three members OCC's `Vo`
 * port was missing: `BASH_MONOSECONDS` + `BASH_TRAPSIG` (already present in
 * OCC's INTEGER_ATTR set since v288 #28, but absent here) and `BASH_ARGV0`
 * (this round's delta). Members + order below are byte-aligned to the 2.1.296
 * `KLn` dump (ev-bashargv0.txt): the three additions slot in exactly where the
 * official places them (BASH_MONOSECONDS/BASH_TRAPSIG after BASHPID;
 * BASH_ARGV0 after BASH_LINENO).
 *
 * This set is consumed by BOTH official call sites OCC mirrors:
 *  - the for-loop guard (`${name} as loop variable bypasses assignment
 *    validation`) — official for_statement branch `KLn.has(n)`;
 *  - the variable-expansion resolver (`resolveSimpleExpansion` ≡ official
 *    `Z`) — official `if(KLn.has(s))return r&&le.has(s)&&s!=="BASHPID"?_:b(e)`,
 *    i.e. a tracked special var is NEVER trusted as a static literal.
 */
const SPECIAL_SHELL_VARS = new Set([
  '_',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'BASH_COMMAND',
  'FUNCNAME',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'SRANDOM',
  'BASHPID',
  'BASH_MONOSECONDS', // v296 KLn member (pre-existing OCC gap closed)
  'BASH_TRAPSIG', // v296 KLn member (pre-existing OCC gap closed)
  'HISTCMD',
  'ERRNO',
  'REPLY',
  'reply',
  'PIPESTATUS',
  'pipestatus',
  'BASH_SOURCE',
  'DIRSTACK',
  'GROUPS',
  'BASH_ARGV',
  'BASH_ARGC',
  'BASH_SUBSHELL',
  'BASH_LINENO',
  'BASH_ARGV0', // v296 delta — the changelog's named variable
  'BASH_REMATCH',
  'MATCH',
  'match',
  'MBEGIN',
  'MEND',
  'mbegin',
  'mend',
  'OPTARG',
  'OPTIND',
  'argv',
  'FIGNORE',
  'fignore',
  'PSVAR',
  'psvar',
  'WATCH',
  'watch',
  'HISTCHARS',
  'histchars',
  'PS1',
  'PROMPT',
  'prompt',
  'PS2',
  'PROMPT2',
  'PS3',
  'PROMPT3',
  'PS4',
  'PROMPT4',
  'RPS1',
  'RPROMPT',
  'RPS2',
  'RPROMPT2',
])

/**
 * True when `name` carries a shell integer attribute and `value` cannot be
 * statically verified as a plain decimal integer — the shell arithmetically
 * evaluates such an assignment RHS, which executes `$(cmd)` inside
 * subscripts and can abort/diverge at runtime. Verbatim port of the official
 * 2.1.251 binary's `Jo`; re-verified byte-for-byte unchanged against the
 * official 2.1.288 binary's `qe` (`if(!fyt.has(e))return!1;
 * if(n.includes("[")||n.includes("`")||/\$\(/.test(n)||Pi(n))return!0;
 * if(!/^(0|[1-9][0-9]{0,17})$/.test(n))return!0; return!1`) — the v288 #28
 * delta is the extended set only, not the checker logic.
 */
function hasIntegerAttrArithEvalRisk(name: string, value: string): boolean {
  if (!INTEGER_ATTR_SHELL_VARS.has(name)) return false
  if (
    value.includes('[') ||
    value.includes('`') ||
    /\$\(/.test(value) ||
    containsAnyPlaceholder(value)
  ) {
    return true
  }
  if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) return true
  return false
}

/**
 * True when assigning `name` alters command lookup/execution for subsequent
 * commands. Verbatim port of the official 2.1.251 binary's `Jn`.
 */
function isExecInfluencingVar(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    EXEC_INFLUENCING_VARS.has(lower) ||
    lower.startsWith('ld_') ||
    lower.startsWith('dyld_') ||
    lower.startsWith('bash_func_')
  )
}

/**
 * True when the shell variable needs special handling for
 * assignment/unset/write paths (exec-influencing / integer-attr / IFS /
 * PS4). Verbatim port of the official 2.1.251 binary's `Vwe`.
 */
function isSpecialShellVar(name: string): boolean {
  return (
    isExecInfluencingVar(name) ||
    name === 'IFS' ||
    name === 'PS4' ||
    name === 'PROMPT4' ||
    INTEGER_ATTR_SHELL_VARS.has(name)
  )
}

/**
 * Node types that mean "this command cannot be statically analyzed." These
 * either execute arbitrary code (substitutions, subshells, control flow) or
 * expand to values we can't determine statically (parameter/arithmetic
 * expansion, brace expressions).
 *
 * This set is not exhaustive — it documents KNOWN dangerous types. The real
 * safety property is the allowlist in walkArgument/walkCommand: any type NOT
 * explicitly handled there also triggers too-complex.
 */
const DANGEROUS_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
])

/**
 * Numeric IDs for analytics (logEvent doesn't accept strings). Index into
 * DANGEROUS_TYPES. Append new entries at the end to keep IDs stable.
 * 0 = unknown/other, -1 = ERROR (parse failure), -2 = pre-check.
 */
const DANGEROUS_TYPE_IDS = [...DANGEROUS_TYPES]
export function nodeTypeId(nodeType: string | undefined): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const i = DANGEROUS_TYPE_IDS.indexOf(nodeType)
  return i >= 0 ? i + 1 : 0
}

/**
 * Redirect operator tokens → canonical operator. tree-sitter produces these
 * as child nodes of `file_redirect`.
 */
const REDIRECT_OPS: Record<string, Redirect['op']> = {
  '>': '>',
  '>>': '>>',
  '<': '<',
  '>&': '>&',
  '<&': '<&',
  '>|': '>|',
  '&>': '&>',
  '&>>': '&>>',
  '<<<': '<<<',
}

/**
 * Brace expansion pattern: {a,b} or {a..b}. Must have , or .. inside
 * braces. We deliberately do NOT try to determine whether the opening brace
 * is backslash-escaped: tree-sitter doesn't unescape backslashes, so
 * distinguishing `\{a,b}` (escaped, literal) from `\\{a,b}` (literal
 * backslash + expansion) would require reimplementing bash quote removal.
 * Reject both — the escaped-brace case is rare and trivially rewritten
 * with single quotes.
 */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/

/**
 * Control characters that bash silently drops but confuse static analysis.
 * Includes CR (0x0D): tree-sitter treats CR as a word separator but bash's
 * default IFS does not include CR, so tree-sitter and bash disagree on
 * word boundaries.
 */
// eslint-disable-next-line no-control-regex
// This regex INTENTIONALLY matches control characters — it is the security
// pre-check that rejects commands containing them (parser-differential guard).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (security pre-check).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/

/**
 * Unicode whitespace beyond ASCII. These render invisibly (or as regular
 * spaces) in terminals so a user reviewing the command can't see them, but
 * bash treats them as literal word characters. Blocks NBSP, zero-width
 * spaces, line/paragraph separators, BOM.
 */
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/

/**
 * Backslash immediately before whitespace. bash treats `\ ` as a literal
 * space inside the current word, but tree-sitter returns the raw text with
 * the backslash still present. argv[0] from tree-sitter is `cat\ test`
 * while bash runs `cat test` (with a literal space). Rather than
 * reimplement bash's unescaping rules, we reject these — they're rare in
 * practice and trivial to rewrite with quotes.
 *
 * Also matches `\` before newline (line continuation) when adjacent to a
 * non-whitespace char. `tr\<NL>aceroute` — bash joins to `traceroute`, but
 * tree-sitter splits into two words (differential). When `\<NL>` is preceded
 * by whitespace (e.g. `foo && \<NL>bar`), there's no word to join — both
 * parsers agree, so we allow it.
 */
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/

/**
 * Zsh dynamic named directory expansion: ~[name]. In zsh this invokes the
 * zsh_directory_name hook, which can run arbitrary code. bash treats it as
 * a literal tilde followed by a glob character class. Since BashTool runs
 * via the user's default shell (often zsh), reject conservatively.
 */
const ZSH_TILDE_BRACKET_RE = /~\[/

/**
 * Zsh EQUALS expansion: word-initial `=cmd` expands to the absolute path of
 * `cmd` (equivalent to `$(which cmd)`). `=curl evil.com` runs as
 * `/usr/bin/curl evil.com`. tree-sitter parses `=curl` as a literal word, so
 * a `Bash(curl:*)` deny rule matching on base command name won't see `curl`.
 * Only matches word-initial `=` followed by a command-name char — `VAR=val`
 * and `--flag=val` have `=` mid-word and are not expanded by zsh.
 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/

/**
 * Official 2.1.290 reason string for the zsh/bash variable-name differential
 * (byte-verified @206342406 in the cc290 ELF; see
 * docs/gap-research-291/verify-290-snippets-report.md ITEM #2). Upstream authors
 * it in the per-node builder `b(e)` when an ERROR node's text matches `We` (or
 * `${`+`Lor`). OCC's pure-TS parser yields a `concatenation`/`simple_expansion`
 * (never ERROR) for these tokens, so the post-parse escalation
 * `escalateZshDifferentialVar` below sets this string directly to match the
 * official observable reason. This deviates from the gap doc's #2 point-3 (which
 * suggested an OCC-specific wording on the assumption no official string
 * existed); forensics found the real upstream string, and
 * aligning-with-official-binary mandates matching it verbatim.
 */
const ZSH_DIFFERENTIAL_VAR_REASON =
  "A $ followed by non-ASCII text in this command can't be checked before it runs"

/**
 * Official 2.1.290 `We` @206280333 (byte-verified): a whole token of the form
 * `$` + zero-or-more zsh expansion-flag chars (`#^=~+`) + a variable name,
 * where the token contains at least one NON-ASCII char. bash variable names are
 * ASCII-only, so `$=vær` is an inert literal in bash, but zsh applies expansion
 * flags (`$=var` word-splits, `$~var` globs, `$^var` rc-expands, `$+var`
 * exists-tests) — the two shells read the token differently and static analysis
 * can't reconcile them → ask. The `[\u0080-\uffff]` classes are LITERAL
 * backslash-u escapes in the official JS source (forensically confirmed), not
 * raw codepoints; the NON-ASCII restriction is load-bearing (pure-ASCII `$=var`
 * is NOT escalated upstream — do not over-tighten).
 */
const ZSH_DIFFERENTIAL_VAR_TOKEN_RE = /^\$[#^=~+]*[\w\u0080-\uffff]+$/
const NON_ASCII_RE = /[\u0080-\uffff]/

/** Official `We` — token-level zsh differential variable test. */
function isZshDifferentialVarToken(text: string): boolean {
  return ZSH_DIFFERENTIAL_VAR_TOKEN_RE.test(text) && NON_ASCII_RE.test(text)
}

/**
 * OCC adaptation of official 2.1.290 `Be` @206279777 (byte-verified):
 *   function Be(e){if(e.type==="ERROR"&&(e.text.startsWith("${")||We(e.text)))
 *     return!0; for(let t of e.children)if(t&&Be(t))return!0; return!1}
 * Official gates the `We` token test on the node being an ERROR node, because
 * upstream's tree-sitter WASM emits ERROR for `$=vær`-class tokens. OCC's
 * pure-TS parser instead emits a `concatenation` whose `.text` IS the whole
 * `$…` token (verified: `$=vær` → concatenation[$,word]), never an ERROR node.
 * So the faithful OCC equivalent tests `We` on ANY node's text — the `^…$`
 * anchors mean only a node whose entire text is a differential token matches
 * (the `$=vær` concatenation), never a wrapping `command`/`program` (those
 * contain spaces) nor a quoted `string` (text carries the `"` delimiters) nor a
 * `string_content` child (text lacks the leading `$`). The official
 * ERROR+`${`-prefix branch is retained verbatim for structural parity.
 */
function hasZshDifferentialVarNode(node: Node): boolean {
  if (
    isZshDifferentialVarToken(node.text) ||
    (node.type === 'ERROR' && node.text.startsWith('${'))
  ) {
    return true
  }
  for (const child of node.children) {
    if (child && hasZshDifferentialVarNode(child)) return true
  }
  return false
}

/**
 * Official 2.1.290 `Ue` @206279914 (byte-verified): recursive tree scan for a
 * `$#` simple_expansion (special_variable_name `#`) immediately followed by a
 * NON-ASCII variable name that is subscripted (`[`) or history-modified
 * (`:letter`/`:&`) — zsh `$#name[…]` / `$#name:x` syntax. Following-sibling
 * texts are accumulated while each is wholly word/non-ASCII; the first sibling
 * that isn't is appended, then the scan stops (matching the official loop, which
 * appends before testing).
 */
const ZSH_DIFFERENTIAL_SUBSCRIPT_NAME_RE = /^[\w\u0080-\uffff]*$/
const ZSH_DIFFERENTIAL_SUBSCRIPT_RE = /^[\w\u0080-\uffff]*(?=\[|:[a-zA-Z&])/
function hasZshDifferentialSubscript(node: Node): boolean {
  const children = node.children
  for (let r = 0; r < children.length; r++) {
    const s = children[r]
    if (!s) continue
    if (
      s.type === 'simple_expansion' &&
      s.children.some(
        o => o?.type === 'special_variable_name' && o.text === '#',
      )
    ) {
      let accumulated = ''
      for (let l = r + 1; l < children.length; l++) {
        const a = children[l]?.text ?? ''
        accumulated += a
        if (!ZSH_DIFFERENTIAL_SUBSCRIPT_NAME_RE.test(a)) break
      }
      const m = ZSH_DIFFERENTIAL_SUBSCRIPT_RE.exec(accumulated)
      if (m && NON_ASCII_RE.test(m[0])) return true
    }
    if (hasZshDifferentialSubscript(s)) return true
  }
  return false
}

/**
 * Official 2.1.290 `Az` tail escalation @206279674 (byte-verified):
 *   if (x.kind==="too-complex" && x.nodeType!=="ERROR" && (Be(t)||Ue(t)))
 *     return {...x, nodeType:"ERROR"}
 * Upstream overrides only `nodeType` (the reason was already authored by `b(e)`
 * on the ERROR node). OCC's parser produces no ERROR node for these tokens, so
 * the base result carries the generic `$`/variable reason — this adaptation also
 * sets the official reason string so the observable too-complex reason matches
 * upstream. `nodeType:'ERROR'` routes to analytics id -1 (parse failure) exactly
 * as official's `kgr` does (nodeTypeId, :461).
 */
function escalateZshDifferentialVar(
  result: ParseForSecurityResult,
  root: Node,
): ParseForSecurityResult {
  if (
    result.kind === 'too-complex' &&
    result.nodeType !== 'ERROR' &&
    (hasZshDifferentialVarNode(root) || hasZshDifferentialSubscript(root))
  ) {
    return {
      ...result,
      reason: ZSH_DIFFERENTIAL_VAR_REASON,
      nodeType: 'ERROR',
    }
  }
  return result
}

/**
 * Brace character combined with quote characters. Constructions like
 * `{a'}',b}` use quoted braces inside brace expansion context to obfuscate
 * the expansion from regex-based detection. In bash, `{a'}',b}` expands to
 * `a} b` (the quoted `}` becomes literal inside the first alternative).
 * These are hard to analyze correctly and have no legitimate use in
 * commands we'd want to auto-allow.
 *
 * This check runs on a version of the command with `{` masked out of
 * single-quoted and double-quoted spans, so JSON payloads like
 * `curl -d '{"k":"v"}'` don't trigger a false positive. Brace expansion
 * cannot occur inside quotes, so a `{` there can never start an obfuscation
 * pattern. The quote characters themselves stay visible so `{a'}',b}` and
 * `{@'{'0},...}` still match via the outer unquoted `{`.
 */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

/**
 * Mask `{` characters that appear inside single- or double-quoted contexts.
 * Uses a single-pass bash-aware quote-state scanner instead of a regex.
 *
 * A naive regex (`/'[^']*'/g`) mis-detects spans when a `'` appears inside
 * a double-quoted string: for `echo "it's" {a'}',b}`, it matches from the
 * `'` in `it's` across to the `'` in `{a'}`, masking the unquoted `{` and
 * producing a false negative. The scanner tracks actual bash quote state:
 * `'` toggles single-quote only in unquoted context; `"` toggles
 * double-quote only outside single quotes; `\` escapes the next char in
 * unquoted context and escapes `"` / `\\` inside double quotes.
 *
 * Brace expansion is impossible in both quote contexts, so masking `{` in
 * either is safe. Secondary defense: BRACE_EXPANSION_RE in walkArgument.
 */
function maskBracesInQuotedContexts(cmd: string): string {
  // Fast path: no `{` → nothing to mask. Skips the char-by-char scan for
  // the >90% of commands with no braces (`ls -la`, `git status`, etc).
  if (!cmd.includes('{')) return cmd
  const out: string[] = []
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]!
    if (inSingle) {
      // Bash single quotes: no escapes, `'` always terminates.
      if (c === "'") inSingle = false
      out.push(c === '{' ? ' ' : c)
      i++
    } else if (inDouble) {
      // Bash double quotes: `\` escapes `"` and `\` (also `$`, backtick,
      // newline — but those don't affect quote state so we let them pass).
      if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === '"') inDouble = false
        out.push(c === '{' ? ' ' : c)
        i++
      }
    } else {
      // Unquoted: `\` escapes any next char.
      if (c === '\\' && i + 1 < cmd.length) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === "'") inSingle = true
        else if (c === '"') inDouble = true
        out.push(c)
        i++
      }
    }
  }
  return out.join('')
}

const DOLLAR = String.fromCharCode(0x24)

/**
 * Parse a bash command string and extract a flat list of simple commands.
 * Returns 'too-complex' if the command uses any shell feature we can't
 * statically analyze. Returns 'parse-unavailable' if tree-sitter WASM isn't
 * loaded — caller should fall back to conservative behavior.
 */
export async function parseForSecurity(
  cmd: string,
): Promise<ParseForSecurityResult> {
  // parseCommandRaw('') returns null (falsy check), so short-circuit here.
  // Don't use .trim() — it strips Unicode whitespace (\u00a0 etc.) which the
  // pre-checks in parseForSecurityFromAst need to see and reject.
  if (cmd === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(cmd)
  return root === null
    ? { kind: 'parse-unavailable' }
    : parseForSecurityFromAst(cmd, root)
}

/**
 * Bash SPECIAL declaration builtins. A variable assignment placed in FRONT of
 * one of these (`X=evil declare -x X`) PERSISTS in the shell after the command
 * finishes — unlike an assignment in front of a normal command (`X=evil cmd`),
 * which is a transient env prefix visible only to `cmd`. Official 2.1.290 #5
 * keys its declaration-prefix handling off exactly this set. `local` is
 * included for parity with the official list even though it only persists
 * within a function body (OCC does not model function scope).
 */
const DECLARATION_BUILTINS = new Set([
  'declare',
  'typeset',
  'export',
  'readonly',
  'local',
])

/** Official 2.1.290 String#1 (@206279215, gate `B&&x.kind==="simple"`). */
const DECL_PREFIX_BRANCH_REASON =
  "A variable set in front of a declaration inside a branch or loop can't be checked before it runs"

/** Official 2.1.290 String#2 (@206279503, gate `s!==void 0&&…&&Gt()!==s.length`). */
const DECL_PREFIX_MISMATCH_REASON =
  "The variables set in front of declarations in this command can't be checked before it runs"

/**
 * Per-parse declaration-prefix state. Mirrors the official `Az` module state:
 * `names` = `Gt()` (ordered prefix names encountered), `inBranch` = `B` (inside
 * an if/while/for body), `reading` = the `declarationPrefix:s` option. Reset per
 * parse. (Official also tracks `Zt()` = the persisted-name array; on the base
 * parse every prefix persists, so `names` doubles as that report and no
 * separate `keeps` slot is needed.)
 */
type DeclPrefixCtx = {
  reading: boolean[] | undefined
  names: string[]
  inBranch: boolean
}

let declPrefixCtx: DeclPrefixCtx | null = null

/**
 * Official 2.1.290 `Ior(e,t)` (@206276467) — verbatim port. Enumerates the
 * possible "which prefix names actually persist" readings for `nameCount`
 * declaration-prefix names:
 *   - `nameCount ≤ 3` → all `2**nameCount` bitmask vectors, `exhaustive:true`.
 *   - `nameCount > 3` → heuristic set: [all-false, all-true] + one-hot per
 *     index while `nameCount ≤ 8 && o < nameCount`, plus the caller's
 *     `observed` reading iff it has the right length and isn't already present;
 *     `exhaustive:false`.
 * `observed` corresponds to the official's second arg `t` (the reading hint
 * from the inline-script decision loop).
 */
export function enumerateDeclarationPrefixReadings(
  nameCount: number,
  observed?: boolean[],
): { readings: boolean[][]; exhaustive: boolean } {
  const make = (fn: (index: number) => boolean): boolean[] =>
    Array.from({ length: nameCount }, (_n, l) => fn(l))
  if (nameCount <= 3) {
    return {
      readings: Array.from({ length: 2 ** nameCount }, (_o, n) =>
        make(l => Math.floor(n / 2 ** l) % 2 === 1),
      ),
      exhaustive: true,
    }
  }
  const readings: boolean[][] = [make(() => false), make(() => true)]
  for (let o = 0; nameCount <= 8 && o < nameCount; o++) {
    readings.push(make(n => n === o))
  }
  if (
    observed?.length === nameCount &&
    !readings.some(r => r.every((v, l) => v === observed[l]))
  ) {
    readings.push([...observed])
  }
  return { readings, exhaustive: false }
}

/**
 * Apply the official 2.1.290 declaration-prefix post-parse gates:
 *   - String#2: a reading was supplied but the parser counted a DIFFERENT number
 *     of prefix names than the reading predicted → too-complex (the reading is
 *     stale/misaligned; can't trust the resolution).
 *   - Base parse (`reading===undefined`) on a simple result with ≥1 prefix name
 *     → attach `declarationPrefixes` so the rule matcher knows to enumerate
 *     readings (official `x={...x,declarationPrefixes:y.length,
 *     declarationPrefixBashKeeps:y}`).
 */
function finalizeDeclarationPrefix(
  result: ParseForSecurityResult,
  ctx: DeclPrefixCtx,
): ParseForSecurityResult {
  if (
    ctx.reading !== undefined &&
    result.kind === 'simple' &&
    ctx.names.length !== ctx.reading.length
  ) {
    return { kind: 'too-complex', reason: DECL_PREFIX_MISMATCH_REASON }
  }
  if (ctx.reading === undefined && result.kind === 'simple') {
    if (ctx.names.length > 0) {
      return { ...result, declarationPrefixes: [...ctx.names] }
    }
  }
  return result
}

/**
 * Same as parseForSecurity but takes a pre-parsed AST root so callers that
 * need the tree for other purposes can parse once and share. Pre-checks
 * still run on `cmd` — they catch tree-sitter/bash differentials that a
 * successful parse doesn't.
 */
export function parseForSecurityFromAst(
  cmd: string,
  root: Node | typeof PARSE_ABORTED,
  opts?: ParseForSecurityOptions,
): ParseForSecurityResult {
  // Pre-checks: characters that cause tree-sitter and bash to disagree on
  // word boundaries. These run before tree-sitter because they're the known
  // tree-sitter/bash differentials. Everything after this point trusts
  // tree-sitter's tokenization.
  if (CONTROL_CHAR_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains control characters' }
  }
  if (UNICODE_WHITESPACE_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains Unicode whitespace' }
  }
  if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains backslash-escaped whitespace',
    }
  }
  if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh ~[ dynamic directory syntax',
    }
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh =cmd equals expansion',
    }
  }
  if (BRACE_WITH_QUOTE_RE.test(maskBracesInQuotedContexts(cmd))) {
    return {
      kind: 'too-complex',
      reason: 'Contains brace with quote character (expansion obfuscation)',
    }
  }

  const trimmed = cmd.trim()
  if (trimmed === '') {
    return { kind: 'simple', commands: [] }
  }

  if (root === PARSE_ABORTED) {
    // SECURITY: module loaded but parse aborted (timeout / node budget /
    // panic). Adversarially triggerable — `(( a[0][0]... ))` with ~2800
    // subscripts hits PARSE_TIMEOUT_MICROS under the 10K length limit.
    // Previously indistinguishable from module-not-loaded → routed to
    // legacy (parse-unavailable), which lacks EVAL_LIKE_BUILTINS — `trap`,
    // `enable`, `hash` leaked with Bash(*). Fail closed: too-complex → ask.
    return {
      kind: 'too-complex',
      reason:
        'Parser aborted (timeout or resource limit) — possible adversarial input',
      nodeType: 'PARSE_ABORT',
    }
  }

  // Official 2.1.290 #5: install a fresh declaration-prefix parse context
  // (mirrors upstream `Az`'s module state `Zt()`/`Gt()`/`B`, snapshotted and
  // restored around the parse). `parseForSecurityFromAst` is synchronous and
  // non-reentrant, so a single module slot is safe; the save/restore keeps a
  // nested call (should one ever be added) from corrupting the outer parse.
  const savedDeclPrefixCtx = declPrefixCtx
  declPrefixCtx = {
    reading: opts?.declarationPrefix,
    names: [],
    inBranch: false,
  }
  try {
    // Official 2.1.290 `Az` tail: after the walk, escalate a too-complex result
    // to the zsh variable-name differential (ERROR nodeType + official reason)
    // when the tree carries a `We`/`Ue` offending token, then apply the
    // declaration-prefix reading-mismatch / reporting gates.
    return finalizeDeclarationPrefix(
      escalateZshDifferentialVar(walkProgram(root), root),
      declPrefixCtx,
    )
  } finally {
    declPrefixCtx = savedDeclPrefixCtx
  }
}

function walkProgram(root: Node): ParseForSecurityResult {
  // ERROR-node check folded into collectCommands — any unhandled node type
  // (including ERROR) falls through to tooComplex() in the default branch.
  // Avoids a separate full-tree walk for error detection.
  const commands: SimpleCommand[] = []
  // Track variables assigned earlier in the same command. When a
  // simple_expansion ($VAR) references a tracked var, we can substitute
  // a placeholder instead of returning too-complex. Enables patterns like
  // `NOW=$(date) && jq --arg now "$NOW" ...` — $NOW is known to be the
  // $(date) output (already extracted as inner command).
  const varScope = new Map<string, string>()
  const err = collectCommands(root, commands, varScope)
  if (err) return err
  return { kind: 'simple', commands }
}

/**
 * Recursively collect leaf `command` nodes from a structural wrapper node.
 * Returns an error result on any disallowed node type, or null on success.
 */
function collectCommands(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  if (node.type === 'command') {
    // Pass `commands` as the innerCommands accumulator — any $() extracted
    // during walkCommand gets appended alongside the outer command.
    const result = walkCommand(node, [], commands, varScope)
    if (result.kind !== 'simple') return result
    commands.push(...result.commands)
    return null
  }

  if (node.type === 'redirected_statement') {
    return walkRedirectedStatement(node, commands, varScope)
  }

  if (node.type === 'comment') {
    return null
  }

  if (STRUCTURAL_TYPES.has(node.type)) {
    // SECURITY: `||`, `|`, `|&`, `&` must NOT carry varScope linearly. In bash:
    //   `||` RHS runs conditionally → vars set there MAY not be set
    //   `|`/`|&` stages run in subshells → vars set there are NEVER visible after
    //   `&` LHS runs in a background subshell → same as above
    // Flag-omission attack: `true || FLAG=--dry-run && cmd $FLAG` — bash skips
    // the `||` RHS (FLAG unset → $FLAG empty), runs `cmd` WITHOUT --dry-run.
    // With linear scope, our argv has ['cmd','--dry-run'] → looks SAFE → bypass.
    //
    // Fix: snapshot incoming scope at entry. After these separators, reset to
    // the snapshot — vars set in clauses between separators don't leak. `scope`
    // for clauses BETWEEN `&&`/`;` chains shares state (common `VAR=x && cmd
    // $VAR`). `scope` crosses `||`/`|`/`&` as the pre-structure snapshot only.
    //
    // `&&` and `;` DO carry scope: `VAR=x && cmd $VAR` is sequential, VAR is set.
    //
    // NOTE: `scope` and `varScope` diverge after the first `||`/`|`/`&`. The
    // caller's varScope is only mutated for the `&&`/`;` prefix — this is
    // conservative (vars set in `A && B | C && D` leak A+B into caller, not
    // C+D) but safe.
    //
    // Efficiency: snapshot is only needed if we hit `||`/`|`/`|&`/`&`. For
    // the dominant case (`ls`, `git status` — no such separators), skip the
    // Map alloc via a cheap pre-scan. For `pipeline`, node.type already tells
    // us stages are subshells — copy once at entry, no snapshot needed (each
    // reset uses the entry copy pattern via varScope, which is untouched).
    const isPipeline = node.type === 'pipeline'
    let needsSnapshot = false
    if (!isPipeline) {
      for (const c of node.children) {
        if (c && (c.type === '||' || c.type === '&')) {
          needsSnapshot = true
          break
        }
      }
    }
    const snapshot = needsSnapshot ? new Map(varScope) : null
    // For `pipeline`, ALL stages run in subshells — start with a copy so
    // nothing mutates caller's scope. For `list`/`program`, the `&&`/`;`
    // chain mutates caller's scope (sequential); fork only on `||`/`&`.
    let scope = isPipeline ? new Map(varScope) : varScope
    for (const child of node.children) {
      if (!child) continue
      if (SEPARATOR_TYPES.has(child.type)) {
        if (
          child.type === '||' ||
          child.type === '|' ||
          child.type === '|&' ||
          child.type === '&'
        ) {
          // For pipeline: varScope is untouched (we started with a copy).
          // For list/program: snapshot is non-null (pre-scan set it).
          // `|`/`|&` only appear under `pipeline` nodes; `||`/`&` under list.
          scope = new Map(snapshot ?? varScope)
        }
        continue
      }
      const err = collectCommands(child, commands, scope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'negated_command') {
    // `! cmd` inverts exit code only — doesn't execute code or affect
    // argv. Recurse into the wrapped command. Common in CI: `! grep err`,
    // `! test -f lock`, `! git diff --quiet`.
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '!') continue
      return collectCommands(child, commands, varScope)
    }
    return null
  }

  if (node.type === 'declaration_command') {
    // `export`/`local`/`readonly`/`declare`/`typeset`. tree-sitter emits
    // these as declaration_command, not command, so they previously fell
    // through to tooComplex. Values are validated via walkVariableAssignment:
    // `$()` in the value is recursively extracted (inner command pushed to
    // commands[], outer argv gets CMDSUB_PLACEHOLDER); other disallowed
    // expansions still reject via walkArgument. argv[0] is the builtin name so
    // `Bash(export:*)` rules match.
    const argv: string[] = []
    // CC 2.1.290: official declaration_command site snapshots the cat-heredoc
    // carve-out counter before walking children (`l=N`) and pushes
    // `carveOutMayDesyncQuoteScan:N!==l` alongside `hasUnquotedGlob:I(e.text)`.
    const carveOutsAtEntry = quoteScanCarveOuts
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'export':
        case 'local':
        case 'readonly':
        case 'declare':
        case 'typeset':
          argv.push(child.text)
          break
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation': {
          // Flags (`declare -r`), quoted names (`export "FOO=bar"`), numbers
          // (`declare -i 42`). Mirrors walkCommand's argv handling — before
          // this, `export "FOO=bar"` hit tooComplex on the `string` child.
          // walkArgument validates each (expansions still reject).
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          // SECURITY (official 2.1.271 fix C): declaration flags that change
          // assignment semantics break our static model — a tracked
          // `NAME=value` literal would misrepresent what a later `$var`
          // expansion yields. Charsets + reason strings are byte-exact from
          // the official 2.1.272 linux-x64 ELF declaration_command handler:
          //   declare/typeset/local: /^[+-].*[nialuAEFLRZ]/
          //   export/readonly:       /^[+-].*[iluEFLRZ]/
          // The 2.1.270→2.1.272 widening adds l/u/L/R/Z — the flags that
          // MUTATE the assigned value (case conversion, width
          // truncation/zero padding), so the stored literal no longer equals
          // the expanded value. -n (nameref) dereferences to the target's
          // VALUE; -i/-E/-F arithmetically evaluate the RHS (running $(cmd)
          // even from a single-quoted raw_string). Check the resolved arg
          // (not child.text) so `\-n` and quoted `-n` are caught; `[+-]`
          // covers both `-flag` and `+flag` forms.
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            /^[+-].*[nialuAEFLRZ]/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare flag ${arg} changes assignment semantics (nameref/integer/float/array/width-truncation/case-conversion)`,
              nodeType: 'declaration_command',
            }
          }
          if (
            (argv[0] === 'export' || argv[0] === 'readonly') &&
            /^[+-].*[iluEFLRZ]/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `${argv[0]} flag ${arg} — zsh bin_typeset mathevals (-i/-E/-F), width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`,
              nodeType: 'declaration_command',
            }
          }
          // SECURITY: bare positional assignment with a subscript also
          // evaluates — no -a/-i flag needed. `declare 'x[$(id)]=val'`
          // implicitly creates an array element, arithmetically evaluating
          // the subscript and running $(id). tree-sitter delivers the
          // single-quoted form as a raw_string leaf so walkArgument sees
          // only the literal text. Scoped to declare/typeset/local:
          // export/readonly reject `[` in identifiers before eval.
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            arg[0] !== '-' &&
            /^[^=]*\[/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare positional '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
              nodeType: 'declaration_command',
            }
          }
          argv.push(arg)
          break
        }
        case 'variable_assignment': {
          const ev = walkVariableAssignment(child, commands, varScope)
          if ('kind' in ev) return ev
          // export/declare assignments populate the scope so later $VAR refs resolve.
          applyVarToScope(varScope, ev)
          argv.push(`${ev.name}=${ev.value}`)
          break
        }
        case 'variable_name':
          // `export FOO` — bare name, no assignment.
          argv.push(child.text)
          break
        default:
          return tooComplex(child)
      }
    }
    commands.push({
      argv,
      envVars: [],
      redirects: [],
      text: node.text,
      hasUnquotedGlob: hasUnquotedGlobChars(node.text),
      carveOutMayDesyncQuoteScan: quoteScanCarveOuts !== carveOutsAtEntry,
    })
    return null
  }

  if (node.type === 'variable_assignment') {
    // Bare `VAR=value` at statement level (not a command env prefix).
    // Sets a shell variable — no code execution, no filesystem I/O.
    // The value is validated via walkVariableAssignment → walkArgument,
    // so `VAR=$(evil)` still recursively extracts/rejects based on the
    // inner command. Does NOT push to commands — a bare assignment needs
    // no permission rule (it's inert). Common pattern: `VAR=x && cmd`
    // where cmd references $VAR. ~35% of too-complex in top-5k ant cmds.
    const ev = walkVariableAssignment(node, commands, varScope)
    if ('kind' in ev) return ev
    // CC 2.1.251: assigning an exec-influencing variable (PATH-family,
    // LD_*, ...) changes command lookup/execution for subsequent commands —
    // the static model cannot verify downstream effects. Verbatim gate and
    // reason from the official binary.
    if (isExecInfluencingVar(ev.name)) {
      return {
        kind: 'too-complex',
        reason: `${ev.name} assignment alters command lookup/execution for subsequent commands`,
        nodeType: 'variable_assignment',
      }
    }
    // CC 2.1.251: integer-attribute shell variables arith-eval the
    // assignment RHS — `OPTIND=1/0`, `RANDOM=2+2`, `SECONDS=x[$(id)]`
    // execute/abort at runtime. Must not be auto-approved as inert.
    if (hasIntegerAttrArithEvalRisk(ev.name, ev.value)) {
      return {
        kind: 'too-complex',
        reason: `${ev.name} has integer attribute — assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime`,
        nodeType: 'variable_assignment',
      }
    }
    // Populate scope so later `$VAR` references resolve.
    applyVarToScope(varScope, ev)
    return null
  }

  if (node.type === 'for_statement') {
    // `for VAR in WORD...; do BODY; done` — iterate BODY once per word.
    // Body commands extracted once; every iteration runs the same commands.
    //
    // SECURITY: Loop var is ALWAYS treated as unknown-value (VAR_PLACEHOLDER).
    // Even "static" iteration words can be:
    //  - Absolute paths: `for i in /etc/passwd; do rm $i; done` — body argv
    //    would have placeholder, path validation never sees /etc/passwd.
    //  - Globs: `for i in /etc/*; do rm $i; done` — `/etc/*` is a static word
    //    at parse time but bash expands it at runtime.
    //  - Flags: `for i in -rf /; do rm $i; done` — flag smuggling.
    //
    // VAR_PLACEHOLDER means bare `$i` in body → too-complex. Only
    // string-embedding (`echo "item: $i"`) stays simple. This reverts some
    // of the too-complex→simple rescues in the original PR — each one was a
    // potential path-validation bypass.
    let loopVar: string | null = null
    let doGroup: Node | null = null
    for (const child of node.children) {
      if (!child) continue
      if (child.type === 'variable_name') {
        loopVar = child.text
      } else if (child.type === 'do_group') {
        doGroup = child
      } else if (
        child.type === 'for' ||
        child.type === 'in' ||
        child.type === 'select' ||
        child.type === ';'
      ) {
      } else if (child.type === 'command_substitution') {
        // `for i in $(seq 1 3)` — inner cmd IS extracted and rule-checked.
        const err = collectCommandSubstitution(child, commands, varScope)
        if (err) return err
      } else {
        // Iteration values — validated via walkArgument. Value discarded:
        // body argv gets VAR_PLACEHOLDER regardless of the iteration words,
        // and bare `$i` in body → too-complex (see SECURITY comment above).
        // We still validate to reject e.g. `for i in $(cmd); do ...; done`
        // where the iteration word itself is a disallowed expansion.
        const arg = walkArgument(child, commands, varScope)
        if (typeof arg !== 'string') return arg
      }
    }
    if (loopVar === null || doGroup === null) return tooComplex(node)
    // SECURITY: `for PS4 in '$(id)'; do set -x; :; done` sets PS4 directly
    // via varScope.set below — walkVariableAssignment's PS4/IFS checks never
    // fire. Trace-time RCE (PS4) or word-split bypass (IFS). No legit use.
    // CC 2.1.251: the loop-var guard covers the full special-variable
    // families (exec-influencing / integer-attr / env-influencing /
    // shell-managed) — a loop var bypasses assignment validation for all of
    // them. Verbatim set from the official binary.
    if (
      loopVar === 'PS4' ||
      loopVar === 'IFS' ||
      isExecInfluencingVar(loopVar) ||
      INTEGER_ATTR_SHELL_VARS.has(loopVar) ||
      ENV_INFLUENCING_VARS.has(loopVar) ||
      SPECIAL_SHELL_VARS.has(loopVar)
    ) {
      return {
        kind: 'too-complex',
        reason: `${loopVar} as loop variable bypasses assignment validation`,
        nodeType: 'for_statement',
      }
    }
    // SECURITY: Body uses a scope COPY — vars assigned inside the loop
    // body don't leak to commands after `done`. The loop var itself is
    // set in the REAL scope (bash semantics: $i still set after loop)
    // and copied into the body scope. ALWAYS VAR_PLACEHOLDER — see above.
    varScope.set(loopVar, VAR_PLACEHOLDER)
    const bodyScope = new Map(varScope)
    // Official 2.1.290 #5: a declaration prefix inside a loop body is
    // control-flow-conditional → the walkCommand #5 block emits String#1.
    const savedBranch = declPrefixCtx?.inBranch ?? false
    if (declPrefixCtx) declPrefixCtx.inBranch = true
    for (const c of doGroup.children) {
      if (!c) continue
      if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
      const err = collectCommands(c, commands, bodyScope)
      if (err) {
        if (declPrefixCtx) declPrefixCtx.inBranch = savedBranch
        return err
      }
    }
    if (declPrefixCtx) declPrefixCtx.inBranch = savedBranch
    return null
  }

  if (node.type === 'if_statement' || node.type === 'while_statement') {
    // `if COND; then BODY; [elif...; else...;] fi`
    // `while COND; do BODY; done`
    // Extract condition command(s) + all branch/body commands. All get
    // checked against permission rules. `while read VAR` tracks VAR so
    // body can reference $VAR.
    //
    // SECURITY: Branch bodies use scope COPIES — vars assigned inside a
    // conditional branch (which may not execute) must not leak to commands
    // after fi/done. `if false; then T=safe; fi && rm $T` must reject $T.
    // Condition commands use the REAL varScope (they always run for the
    // check, so assignments there are unconditional — e.g., `while read V`
    // tracking must persist to the body copy).
    //
    // tree-sitter if_statement children: if, COND..., then, THEN-BODY...,
    // [elif_clause...], [else_clause], fi. We distinguish condition from
    // then-body by tracking whether we've seen the `then` token.
    // Official 2.1.290 #5: everything inside an if/while construct (condition
    // and branches) is control-flow-conditional, so a declaration prefix here
    // → String#1. Restored before the final `return null`; the early returns
    // below all abort the parse (per-parse ctx is reset by the caller).
    const savedBranch = declPrefixCtx?.inBranch ?? false
    if (declPrefixCtx) declPrefixCtx.inBranch = true
    let seenThen = false
    for (const child of node.children) {
      if (!child) continue
      if (
        child.type === 'if' ||
        child.type === 'fi' ||
        child.type === 'else' ||
        child.type === 'elif' ||
        child.type === 'while' ||
        child.type === 'until' ||
        child.type === ';'
      ) {
        continue
      }
      if (child.type === 'then') {
        seenThen = true
        continue
      }
      if (child.type === 'do_group') {
        // while body: recurse with scope COPY (body assignments don't leak
        // past done). The COPY contains any `read VAR` tracking from the
        // condition (already in real varScope at this point).
        const bodyScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
          const err = collectCommands(c, commands, bodyScope)
          if (err) return err
        }
        continue
      }
      if (child.type === 'elif_clause' || child.type === 'else_clause') {
        // elif_clause: elif, cond, ;, then, body... / else_clause: else, body...
        // Scope COPY — elif/else branch assignments don't leak past fi.
        const branchScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (
            c.type === 'elif' ||
            c.type === 'else' ||
            c.type === 'then' ||
            c.type === ';'
          ) {
            continue
          }
          const err = collectCommands(c, commands, branchScope)
          if (err) return err
        }
        continue
      }
      // Condition (seenThen=false) or then-body (seenThen=true).
      // Condition uses REAL varScope (always runs). Then-body uses a COPY.
      // Special-case `while read VAR`: after condition `read VAR` is
      // collected, track VAR in the REAL scope so the body COPY inherits it.
      const targetScope = seenThen ? new Map(varScope) : varScope
      const before = commands.length
      const err = collectCommands(child, commands, targetScope)
      if (err) return err
      // If condition included `read VAR...`, track vars in REAL scope.
      // read var value is UNKNOWN (stdin input) → use VAR_PLACEHOLDER
      // (unknown-value sentinel, string-only).
      if (!seenThen) {
        for (let i = before; i < commands.length; i++) {
          const c = commands[i]
          if (c?.argv[0] === 'read') {
            for (const a of c.argv.slice(1)) {
              // Skip flags (-r, -d, etc.); track bare identifier args as var names.
              if (!a.startsWith('-') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
                // SECURITY: commands[] is a flat accumulator. `true || read
                // VAR` in the condition: the list handler correctly uses a
                // scope COPY for the ||-RHS (may not run), but `read VAR`
                // IS still pushed to commands[] — we can't tell it was
                // scope-isolated from here. Same for `echo | read VAR`
                // (pipeline, subshell in bash) and `(read VAR)` (subshell).
                // Overwriting a tracked literal with VAR_PLACEHOLDER hides
                // path traversal: `VAR=../../etc/passwd && if true || read
                // VAR; then cat "/tmp/$VAR"; fi` — parser would see
                // /tmp/__TRACKED_VAR__, bash reads /etc/passwd. Fail closed
                // when a tracked literal would be overwritten. Safe case
                // (no prior value or already a placeholder) → proceed.
                const existing = varScope.get(a)
                if (
                  existing !== undefined &&
                  !containsAnyPlaceholder(existing)
                ) {
                  return {
                    kind: 'too-complex',
                    reason: `'read ${a}' in condition may not execute (||/pipeline/subshell); cannot prove it overwrites tracked literal '${existing}'`,
                    nodeType: 'if_statement',
                  }
                }
                varScope.set(a, VAR_PLACEHOLDER)
              }
            }
          }
        }
      }
    }
    if (declPrefixCtx) declPrefixCtx.inBranch = savedBranch
    return null
  }

  if (node.type === 'subshell') {
    // `(cmd1; cmd2)` — run commands in a subshell. Inner commands ARE
    // executed, so extract them for permission checking. Subshell has
    // isolated scope: vars set inside don't leak out. Use a COPY of
    // varScope (outer vars visible, inner changes discarded).
    const innerScope = new Map(varScope)
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '(' || child.type === ')') continue
      const err = collectCommands(child, commands, innerScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'test_command') {
    // `[[ EXPR ]]` or `[ EXPR ]` — conditional test. Evaluates to true/false
    // based on file tests (-f, -d), string comparisons (==, !=), etc.
    // No code execution (no command_substitution inside — that would be a
    // child and we'd recurse into it via walkArgument and reject it).
    // Push as a synthetic command with argv[0]='[[' so permission rules
    // can match — `Bash([[ :*)` would be unusual but legal.
    // Walk arguments to validate (no cmdsub/expansion inside operands).
    //
    // 2.1.223 (P0): before walking, verify the parser did not drop any bytes
    // the shell will still see. Gaps between children (and after the last
    // child) must be whitespace-only — inside `[[ ]]` also newlines/comments,
    // matching the official binary's gap checker byte-for-byte. Anything
    // else means tree-sitter and the shell disagree about what belongs to
    // the conditional → too-complex → permission prompt.
    const inBracketBracket = node.children.some((c) => c?.type === '[[')
    const gapErr = checkTestCommandUnparsedBytes(node, inBracketBracket)
    if (gapErr) return gapErr
    const argv: string[] = ['[[']
    // CC 2.1.290: official test_command site snapshots the carve-out counter
    // before walking children (`h=N`) and pushes
    // `carveOutMayDesyncQuoteScan:N!==h`.
    const carveOutsAtEntry = quoteScanCarveOuts
    for (const child of node.children) {
      if (!child) continue
      if (
        child.type === '[[' ||
        child.type === ']]' ||
        child.type === '[' ||
        child.type === ']'
      ) {
        // 2.1.223: an empty operator token means a quote landed in operator
        // position and the parser closed the conditional early — the shell
        // sees a different structure. Fail closed.
        if (child.text === '') {
          return {
            kind: 'too-complex',
            reason: 'test_command early-close (quote in operator position)',
          }
        }
        continue
      }
      // Recurse into test expression structure: unary_expression,
      // binary_expression, parenthesized_expression, negated_expression.
      // The leaves are test_operator (-f, -d, ==) and operand words.
      const err = walkTestExpr(child, argv, commands, varScope, inBracketBracket)
      if (err) return err
    }
    commands.push({
      argv,
      envVars: [],
      redirects: [],
      text: node.text,
      hasUnquotedGlob: hasUnquotedGlobChars(node.text),
      carveOutMayDesyncQuoteScan: quoteScanCarveOuts !== carveOutsAtEntry,
    })
    return null
  }

  if (node.type === 'unset_command') {
    // `unset FOO BAR`, `unset -f func`. Safe: only removes shell
    // variables/functions from the current shell — no code execution, no
    // filesystem I/O. tree-sitter emits a dedicated node type so it
    // previously fell through to tooComplex. Children: `unset` keyword,
    // `variable_name` for each name, `word` for flags like `-f`/`-v`.
    //
    // CC 2.1.251 hardening (verbatim structure from the official binary):
    //  - operands must be bare identifiers (no expansion/glob slipping in),
    //  - only `-f`/`-v` flags, and never after the first name,
    //  - `unsetenv` (zsh) and `unset -f` target functions/env, not shell
    //    state, so they skip the special-variable gate,
    //  - unsetting a special shell variable (exec-influencing / integer-attr
    //    / IFS / PS4) is too-complex — removing e.g. PATH or IFS silently
    //    reconfigures every subsequent command.
    const argv: string[] = []
    // CC 2.1.290: official unset_command site snapshots the carve-out counter
    // before walking children (`l=N`) and pushes
    // `carveOutMayDesyncQuoteScan:N!==l`.
    const carveOutsAtEntry = quoteScanCarveOuts
    let sawFunctionFlag = false
    let sawName = false
    let isUnsetenv = false
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'unset':
          argv.push(child.text)
          isUnsetenv = child.text === 'unsetenv'
          break
        case 'variable_name': {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(child.text))
            return tooComplex(child)
          argv.push(child.text)
          sawName = true
          if (sawFunctionFlag || isUnsetenv) {
            // Function/env unset: the binary checks its tracked-literal model
            // here; OCC has no tracked-literal model — nothing to verify.
            break
          }
          if (isSpecialShellVar(child.text)) {
            return {
              kind: 'too-complex',
              reason: `'unset' targets shell variable ${child.text} (exec-influencing / integer-attr / IFS / PS4)`,
              nodeType: 'unset_command',
            }
          }
          // SECURITY: unset removes the var from bash's scope. Remove from
          // varScope so subsequent `$VAR` references correctly reject.
          // `VAR=safe && unset VAR && rm $VAR` must NOT resolve $VAR.
          varScope.delete(child.text)
          break
        }
        case 'word': {
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          if (arg.startsWith('-')) {
            // Flags only precede names, and only -f/-v are modelled.
            if (sawName) return tooComplex(child)
            if (arg !== '-f' && arg !== '-v') return tooComplex(child)
            if (arg === '-f') sawFunctionFlag = true
            argv.push(arg)
            break
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return tooComplex(child)
          argv.push(arg)
          sawName = true
          if (sawFunctionFlag || isUnsetenv) break
          if (isSpecialShellVar(arg)) {
            return {
              kind: 'too-complex',
              reason: `'unset' targets shell variable ${arg} (exec-influencing / integer-attr / IFS / PS4)`,
              nodeType: 'unset_command',
            }
          }
          varScope.delete(arg)
          break
        }
        default:
          return tooComplex(child)
      }
    }
    commands.push({
      argv,
      envVars: [],
      redirects: [],
      text: node.text,
      hasUnquotedGlob: hasUnquotedGlobChars(node.text),
      carveOutMayDesyncQuoteScan: quoteScanCarveOuts !== carveOutsAtEntry,
    })
    return null
  }

  return tooComplex(node)
}

/**
 * Node types that compose a test_command expression tree. Used by the
 * unparsed-bytes walker to recurse into expression children. Verbatim from
 * the official 2.1.223 binary's expression-type set.
 */
const TEST_EXPR_TYPES = new Set([
  'unary_expression',
  'binary_expression',
  'negated_expression',
  'parenthesized_expression',
])

/**
 * True when `text` consists solely of bytes the shell treats as
 * insignificant between test_command children: spaces/tabs and
 * backslash-newline continuations always; inside `[[ ]]`
 * (inBracketBracket) also newlines and `#` comments. Verbatim port of the
 * official 2.1.223 binary's gap checker.
 */
function isWhitespaceOrCommentGap(
  text: string,
  inBracketBracket: boolean,
): boolean {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2
      continue
    }
    if (inBracketBracket && ch === '\n') {
      i++
      continue
    }
    if (inBracketBracket && ch === '#') {
      i++
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    return false
  }
  return true
}

/**
 * Verify the parser did not drop any bytes of a test_command that the shell
 * will still see. Walks the children in source order; every gap between
 * children (and after the last child) must be whitespace/comment-only, and
 * no child may extend past the parent span. Recurses into expression nodes.
 * Verbatim port of the official 2.1.223 binary's test-command gap walker.
 */
function checkTestCommandUnparsedBytes(
  node: Node,
  inBracketBracket: boolean,
): ParseForSecurityResult | null {
  const bytes = Buffer.from(node.text, 'utf8')
  let cursor = node.startIndex
  for (const child of node.children) {
    if (!child) continue
    if (child.endIndex > node.endIndex || child.startIndex < node.startIndex) {
      return {
        kind: 'too-complex',
        reason:
          'Test command child extends past the node span — gap byte accounting is untrustworthy',
      }
    }
    if (child.startIndex > cursor) {
      const gap = bytes
        .subarray(
          cursor - node.startIndex,
          child.startIndex - node.startIndex,
        )
        .toString('utf8')
      if (!isWhitespaceOrCommentGap(gap, inBracketBracket)) {
        return {
          kind: 'too-complex',
          reason:
            'Test command has unparsed bytes between children — parser dropped content that shell will see',
        }
      }
    }
    cursor = Math.max(cursor, child.endIndex)
    if (TEST_EXPR_TYPES.has(child.type)) {
      const err = checkTestCommandUnparsedBytes(child, inBracketBracket)
      if (err) return err
    }
  }
  if (cursor < node.endIndex) {
    const tail = bytes.subarray(cursor - node.startIndex).toString('utf8')
    if (!isWhitespaceOrCommentGap(tail, inBracketBracket)) {
      return {
        kind: 'too-complex',
        reason:
          'Test command has unparsed bytes after its last child — parser dropped content that shell will see',
      }
    }
  }
  return null
}

/**
 * Detect a potential standalone `]]` closer inside pattern/operand text.
 * POSIX bracket-expression forms that legally END in `]]` (`[[:alpha:]]`,
 * `[=x=]`, `[.x.]`, `[]]`, `[^x]`) are masked first; any `]]` left whose
 * preceding or following character is not a word char could close a zsh
 * conditional early. Verbatim port of the official 2.1.223 binary helper —
 * masked positions become NUL bytes exactly as the binary does.
 */
function containsStandaloneBracketCloser(text: string): boolean {
  const masked = text.replace(
    /\[(?::[a-zA-Z]+:|=[A-Za-z0-9-]*=|\.[A-Za-z0-9-]*\.|[!^]?)\]\](?!\])/g,
    '\u0000',
  )
  const wordChar = /[A-Za-z0-9_]/
  let idx = masked.indexOf(']]')
  while (idx !== -1) {
    const before = idx > 0 ? masked[idx - 1] : ''
    const after = idx + 2 < masked.length ? masked[idx + 2] : ''
    if (!(wordChar.test(before) && wordChar.test(after))) return true
    idx = masked.indexOf(']]', idx + 1)
  }
  return false
}

/**
 * Recursively walk a test_command expression tree (unary/binary/negated/
 * parenthesized expressions). Leaves are test_operator tokens and operands
 * (word/string/number/etc). Operands are validated via walkArgument.
 *
 * `inBracketBracket` is true when the enclosing test_command is a `[[ ]]`
 * (vs single-bracket `[ ]`). It selects the gap-byte allowance (newlines and
 * comments are legal between `[[ ]]` children) and the quoted-operand
 * `]]`-desync reason wording, matching the official 2.1.223 binary exactly.
 */
function walkTestExpr(
  node: Node,
  argv: string[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
  inBracketBracket: boolean,
): ParseForSecurityResult | null {
  switch (node.type) {
    case 'unary_expression':
    case 'binary_expression':
    case 'negated_expression':
    case 'parenthesized_expression': {
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i]
        if (!c) continue
        // 2.1.221+ (zsh): `$name[expr]` / `$name:mod` inside a `[[ ]]`
        // operand is recursively evaluated by zsh — an expansion followed by
        // `[...` or a `:x` modifier (or a special variable whose name can
        // absorb the subscript) is code, not pattern text. Verbatim port of
        // the official binary's recursion-precheck.
        if (
          (c.type === 'simple_expansion' || c.type === 'expansion') &&
          (node.children[i + 1]?.text.startsWith('[') ||
            /^:[a-zA-Z&]/.test(node.children[i + 1]?.text ?? '') ||
            (c.children.some((cc) => cc?.type === 'special_variable_name') &&
              /^\w*(\[|:[a-zA-Z&])/.test(node.children[i + 1]?.text ?? '')))
        ) {
          return {
            kind: 'too-complex',
            reason:
              'zsh $name[expr] / $name:mod in [[ ]] operand — recursive eval',
          }
        }
        const err = walkTestExpr(c, argv, innerCommands, varScope, inBracketBracket)
        if (err) return err
      }
      return null
    }
    case 'test_operator':
    case '!':
    case '(':
    case ')':
    case '&&':
    case '||':
    case '==':
    case '=':
    case '!=':
    case '<':
    case '>':
    case '=~':
      // 2.1.223: an empty operator token means the parser synthesized a
      // zero-width token (quote in operator position) — it diverged from
      // what the shell will lex. Fail closed.
      if (node.text === '') {
        return {
          kind: 'too-complex',
          reason:
            'Test command has a synthesized zero-width token — parser diverged from shell',
        }
      }
      argv.push(node.text)
      return null
    case 'regex':
    case 'extglob_pattern': {
      // RHS of =~ or ==/!=/= in [[ ]]. Pattern text only — no code execution
      // in BASH, but zsh disagrees on what belongs to the pattern, so the
      // pattern text is defensively validated before being trusted as inert
      // (2.1.221 security fix — zsh could execute hidden commands smuggled
      // in `[[ ]]` regex conditionals; affected commands now prompt).
      // Verbatim port of the official binary's test-expression RHS case:
      // expansion check on both node types, unquoted-& scan for
      // extglob_pattern, and glued-|| / unquoted-& / paren-balance scan for
      // regex. 2.1.223 (P0) adds the leaf-level `&&` and standalone-`]]`
      // checks below — a crafted pattern leaf could otherwise hide part of
      // the command from permission checks (zsh cond-lexer divergence).
      // Anything suspicious → too-complex → permission prompt.
      if (/\$[({[\w#?!*@$'"+~^=-]|`|[<>]\(/.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: `[[ ]] ${node.type} contains expansion / command / process substitution`,
          nodeType: node.type,
        }
      }
      if (node.type === 'extglob_pattern') {
        const text = node.text
        let i = 0
        while (i < text.length) {
          if (text[i] === '\\' && i + 1 < text.length) {
            i += 2
            continue
          }
          if (text[i] === '&') {
            return {
              kind: 'too-complex',
              reason:
                '[[ ]] pattern contains unquoted & (zsh splits the word at & at any depth)',
            }
          }
          i++
        }
      }
      if (node.type === 'regex') {
        const text = node.text
        let parenDepth = 0
        let i = 0
        while (i < text.length) {
          const ch = text[i]!
          if (ch === '\\' && i + 1 < text.length) {
            i += 2
            continue
          }
          if (parenDepth === 0 && ch === '|' && text[i + 1] === ch) {
            return {
              kind: 'too-complex',
              reason:
                '[[ ]] regex contains glued || (zsh splits it as a cond operator)',
              nodeType: node.type,
            }
          }
          if (ch === '&') {
            return {
              kind: 'too-complex',
              reason:
                '[[ ]] regex contains unquoted & (zsh splits the word at & at any depth)',
              nodeType: node.type,
            }
          }
          if (ch === '"' || ch === "'") {
            const quote = ch
            i++
            while (i < text.length && text[i] !== quote) {
              if (quote === '"' && text[i] === '\\' && i + 1 < text.length) {
                i++
              }
              i++
            }
            if (i < text.length) i++
            continue
          }
          if (ch === '(') {
            parenDepth++
          } else if (ch === ')') {
            parenDepth--
            if (parenDepth < 0) {
              return {
                kind: 'too-complex',
                reason:
                  '[[ ]] regex has unbalanced parentheses (parser desync)',
                nodeType: node.type,
              }
            }
          }
          i++
        }
        if (parenDepth !== 0) {
          return {
            kind: 'too-complex',
            reason: '[[ ]] regex has unbalanced parentheses (parser desync)',
            nodeType: node.type,
          }
        }
      }
      // 2.1.223 (P0) leaf checks, applied to BOTH regex and extglob_pattern
      // after the type-specific scans. A pattern leaf carrying `&&` is split
      // by zsh's cond-lexer into a command separator; a standalone `]]` can
      // close the conditional early. Either lets a crafted command hide part
      // of itself from permission checks — fail closed.
      if (node.text.includes('&&')) {
        return {
          kind: 'too-complex',
          reason:
            '[[ ]] pattern leaf contains `&&` — shell cond-lexer divergence (zsh splits the word there)',
          nodeType: node.type,
        }
      }
      if (containsStandaloneBracketCloser(node.text)) {
        return {
          kind: 'too-complex',
          reason:
            '[[ ]] pattern leaf contains a potential standalone `]]` closer — shell cond-lexer divergence (zsh may close the conditional early)',
          nodeType: node.type,
        }
      }
      argv.push(node.text)
      return null
    }
    case 'test_rhs_missing':
      // 2.1.223: the parser consumed a comparison with no right-hand side —
      // dropped bytes the shell may still see. Fail closed.
      return {
        kind: 'too-complex',
        reason:
          'Test command comparison is missing its right-hand side — parser dropped consumed bytes',
      }
    default: {
      // Operand — word, string, number, etc. Validate via walkArgument.
      const arg = walkArgument(node, innerCommands, varScope)
      if (typeof arg !== 'string') return arg
      // 2.1.223 quoted-operand desync check. A `]]` followed by a command
      // separator inside the unquoted operand means the parser's quote state
      // desynced from the shell's — the shell may close the conditional and
      // execute the tail. In `[[ ]]` context additionally reject any
      // potential standalone `]]` closer (in the resolved text or the raw
      // node text). Reasons are byte-identical to the official binary and
      // branch on the bracket context.
      if (
        (inBracketBracket &&
          (containsStandaloneBracketCloser(arg) ||
            containsStandaloneBracketCloser(node.text))) ||
        /]].*[;\n&|<>]/s.test(arg)
      ) {
        return {
          kind: 'too-complex',
          reason: inBracketBracket
            ? '[[ ]] quoted operand contains `]]` closer or `]]`+separator bytes — possible parser quote-state desync'
            : 'test command quoted operand contains `]]`+separator bytes — possible parser quote-state desync',
          nodeType: node.type,
        }
      }
      argv.push(arg)
      return null
    }
  }
}

/**
 * A `redirected_statement` wraps a command (or pipeline) plus one or more
 * `file_redirect`/`heredoc_redirect` nodes. Extract redirects, walk the
 * inner command, attach redirects to the LAST command (the one whose output
 * is being redirected).
 */
function walkRedirectedStatement(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  const redirects: Redirect[] = []
  let innerCommand: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_redirect') {
      // Thread `commands` so $() in redirect targets (e.g., `> $(mktemp)`)
      // extracts the inner command for permission checking.
      const r = walkFileRedirect(child, commands, varScope)
      if ('kind' in r) return r
      redirects.push(r)
    } else if (child.type === 'heredoc_redirect') {
      const r = walkHeredocRedirect(child)
      if (r) return r
    } else if (
      child.type === 'command' ||
      child.type === 'pipeline' ||
      child.type === 'list' ||
      child.type === 'negated_command' ||
      child.type === 'declaration_command' ||
      child.type === 'unset_command'
    ) {
      innerCommand = child
    } else {
      return tooComplex(child)
    }
  }

  if (!innerCommand) {
    // `> file` alone is valid bash (truncates file). Represent as a command
    // with empty argv so downstream sees the write.
    commands.push({
      argv: [],
      envVars: [],
      redirects,
      text: node.text,
      hasUnquotedGlob: hasUnquotedGlobChars(node.text),
    })
    return null
  }

  const before = commands.length
  const err = collectCommands(innerCommand, commands, varScope)
  if (err) return err
  if (commands.length > before && redirects.length > 0) {
    const last = commands[commands.length - 1]
    if (last) last.redirects.push(...redirects)
  }
  return null
}

/**
 * Extract operator + target from a `file_redirect` node. The target must be
 * a static word or string.
 */
function walkFileRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): Redirect | ParseForSecurityResult {
  let op: Redirect['op'] | null = null
  let target: string | null = null
  let fd: number | undefined

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_descriptor') {
      fd = Number(child.text)
    } else if (child.type in REDIRECT_OPS) {
      op = REDIRECT_OPS[child.type] ?? null
    } else if (child.type === 'word' || child.type === 'number') {
      // SECURITY: `number` nodes can contain expansion children via the
      // `NN#<expansion>` arithmetic-base grammar quirk — same issue as
      // walkArgument's number case. `> 10#$(cmd)` runs cmd at runtime.
      // Plain word/number nodes have zero children.
      if (child.children.length > 0) return tooComplex(child)
      // Symmetry with walkArgument (~608): `echo foo > {a,b}` is an
      // ambiguous redirect in bash. tree-sitter actually emits a
      // `concatenation` node for brace targets (caught by the default
      // branch below), but check `word` text too for defense-in-depth.
      if (BRACE_EXPANSION_RE.test(child.text)) return tooComplex(child)
      // Unescape backslash sequences — same as walkArgument. Bash quote
      // removal turns `\X` → `X`. Without this, `cat < /proc/self/\environ`
      // stores target `/proc/self/\environ` which evades PROC_ENVIRON_RE,
      // but bash reads /proc/self/environ.
      target = child.text.replace(/\\(.)/g, '$1')
    } else if (child.type === 'raw_string') {
      target = stripRawString(child.text)
    } else if (child.type === 'string') {
      const s = walkString(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else if (child.type === 'concatenation') {
      // `echo > "foo"bar` — tree-sitter produces a concatenation of string +
      // word children. walkArgument already validates concatenation (rejects
      // expansions, checks brace syntax) and returns the joined text.
      const s = walkArgument(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else {
      return tooComplex(child)
    }
  }

  if (!op || target === null) {
    return {
      kind: 'too-complex',
      reason: 'Unrecognized redirect shape',
      nodeType: node.type,
    }
  }
  return { op, target, fd }
}

/**
 * Heredoc redirect. Only quoted-delimiter heredocs (<<'EOF') are safe —
 * their bodies are literal text. Unquoted-delimiter heredocs (<<EOF)
 * undergo full parameter/command/arithmetic expansion in the body.
 *
 * SECURITY: tree-sitter-bash has a grammar gap — backticks (`...`) inside
 * an unquoted heredoc body are NOT parsed as command_substitution nodes
 * (body.children is empty, backticks are in body.text). But bash DOES
 * execute them. We cannot safely relax the quoted-delimiter requirement
 * by checking body children for expansion nodes — we'd miss backtick
 * substitution. Keep rejecting all unquoted heredocs. Users should use
 * <<'EOF' to get a literal body, which the model already prefers.
 */
function walkHeredocRedirect(node: Node): ParseForSecurityResult | null {
  let startText: string | null = null
  let body: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'heredoc_start') startText = child.text
    else if (child.type === 'heredoc_body') body = child
    else if (
      child.type === '<<' ||
      child.type === '<<-' ||
      child.type === 'heredoc_end' ||
      child.type === 'file_descriptor'
    ) {
      // expected structural tokens — safe to skip. file_descriptor
      // covers fd-prefixed heredocs (`cat 3<<'EOF'`) — walkFileRedirect
      // already treats it as a benign structural token.
    } else {
      // SECURITY: tree-sitter places pipeline / command / file_redirect /
      // && / etc. as children of heredoc_redirect when they follow the
      // delimiter on the same line (e.g. `ls <<'EOF' | rm x`). Previously
      // these were silently skipped, hiding the piped command from
      // permission checks. Fail closed like every other walker.
      return tooComplex(child)
    }
  }

  const isQuoted =
    startText !== null &&
    ((startText.startsWith("'") && startText.endsWith("'")) ||
      (startText.startsWith('"') && startText.endsWith('"')) ||
      startText.startsWith('\\'))

  if (!isQuoted) {
    return {
      kind: 'too-complex',
      reason: 'Heredoc with unquoted delimiter undergoes shell expansion',
      nodeType: 'heredoc_redirect',
    }
  }

  if (body) {
    for (const child of body.children) {
      if (!child) continue
      if (child.type !== 'heredoc_content') {
        return tooComplex(child)
      }
    }
  }
  return null
}

/**
 * Here-string redirect (`<<< content`). The content becomes stdin — not
 * argv, not a path. Safe when content is a literal word, raw_string, or
 * string with no expansions. Reject when content contains $()/${}/$VAR —
 * those execute arbitrary code or inject runtime values.
 *
 * Reuses walkArgument for content validation: it already rejects
 * command_substitution, expansion, and (for strings) simple_expansion
 * unless the var is tracked/safe. The result string is discarded — we only
 * care that it's statically resolvable.
 *
 * NOTE: `VAR=$(cmd) && cat <<< "$VAR"` would be safe in principle (inner
 * cmd is extracted separately, herestring content is stdin) but is
 * currently rejected conservatively — walkString's solo-placeholder guard
 * fires because it has no awareness of herestring vs argv context.
 */
function walkHerestringRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.type === '<<<') continue
    // Content node: reuse walkArgument. It returns a string on success
    // (which we discard — content is stdin, irrelevant to permissions) or
    // a too-complex result on failure (expansion found, unresolvable var).
    const content = walkArgument(child, innerCommands, varScope)
    if (typeof content !== 'string') return content
    // Herestring content is discarded (not in argv/envVars/redirects) but
    // remains in .text via raw node.text. Scan it here so checkSemantics's
    // NEWLINE_HASH invariant (bashPermissions.ts relies on it) still holds.
    if (NEWLINE_HASH_RE.test(content)) return tooComplex(child)
  }
  return null
}

/**
 * Walk a `command` node and extract argv. Children appear in order:
 * [variable_assignment...] command_name [argument...] [file_redirect...]
 * Any child type not explicitly handled triggers too-complex.
 */
function walkCommand(
  node: Node,
  extraRedirects: Redirect[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  // Full prefix-assignment records (with `isAppend`) so a declaration-builtin
  // prefix can be applied to varScope faithfully. See the post-loop #5 block.
  const prefixAssignments: {
    name: string
    value: string
    isAppend: boolean
  }[] = []
  const redirects: Redirect[] = [...extraRedirects]
  // CC 2.1.290 official `Kt`: `h` (per-arg unquoted-glob record) and the
  // carve-out counter snapshot (`l=N`) for carveOutMayDesyncQuoteScan.
  const argvUnquotedGlob: boolean[] = []
  const carveOutsAtEntry = quoteScanCarveOuts

  for (const child of node.children) {
    if (!child) continue

    switch (child.type) {
      case 'variable_assignment': {
        const ev = walkVariableAssignment(child, innerCommands, varScope)
        if ('kind' in ev) return ev
        // CC 2.1.251: integer-attribute shell variables arith-eval the
        // env-prefix value too (`RANDOM=2+2 cmd`, `OPTIND=x[$(id)] cmd`).
        // Verbatim gate and reason from the official binary.
        if (hasIntegerAttrArithEvalRisk(ev.name, ev.value)) {
          return {
            kind: 'too-complex',
            reason: `${ev.name} has integer attribute — env-prefix arith-evals value, which can execute subscript command substitution or abort/diverge at runtime`,
            nodeType: 'variable_assignment',
          }
        }
        // SECURITY: Env-prefix assignments (`VAR=x cmd`) are command-local in
        // bash — VAR is only visible to `cmd` as an env var, NOT to
        // subsequent commands. Do NOT add to global varScope — that would
        // let `VAR=safe cmd1 && rm $VAR` resolve $VAR when bash has unset it.
        // EXCEPTION (official 2.1.290 #5): when `cmd` is a SPECIAL declaration
        // builtin (declare/typeset/export/readonly/local) the prefix DOES
        // persist — handled in the post-loop block below, not here.
        envVars.push({ name: ev.name, value: ev.value })
        prefixAssignments.push(ev)
        break
      }
      case 'command_name': {
        const nameNode = child.children[0] ?? child
        const arg = walkArgument(nameNode, innerCommands, varScope)
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        // Official: `a.push(x),h.push(I(m.text)||me(m))`
        argvUnquotedGlob.push(
          hasUnquotedGlobChars(nameNode.text) ||
            nodeMayContainUnquotedGlob(nameNode),
        )
        break
      }
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation':
      case 'arithmetic_expansion': {
        const arg = walkArgument(child, innerCommands, varScope)
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        // Official: `a.push(m),h.push(I(u.text)||me(u))`
        argvUnquotedGlob.push(
          hasUnquotedGlobChars(child.text) || nodeMayContainUnquotedGlob(child),
        )
        break
      }
      // NOTE: command_substitution as a BARE argument (not inside a string)
      // is intentionally NOT handled here — the $() output IS the argument,
      // and for path-sensitive commands (cd, rm, chmod) the placeholder would
      // hide the real path from downstream checks. `cd $(echo /etc)` must
      // stay too-complex so the path-check can't be bypassed. $() inside
      // strings ("Timer: $(date)") is handled in walkString where the output
      // is embedded in a longer string (safer).
      case 'simple_expansion': {
        // Bare `$VAR` as an argument. Tracked static vars return the ACTUAL
        // value (e.g. VAR=/etc → '/etc'). Values with IFS/glob chars or
        // placeholders reject. See resolveSimpleExpansion.
        const v = resolveSimpleExpansion(child, varScope, false)
        if (typeof v !== 'string') return v
        argv.push(v)
        // Official: `A++;a.push(m),h.push(!0)` — a bare $VAR's resolved
        // value is ALWAYS recorded as unquoted-glob-risky (the source node
        // text says nothing about the value's quoting).
        argvUnquotedGlob.push(true)
        break
      }
      case 'file_redirect': {
        const r = walkFileRedirect(child, innerCommands, varScope)
        if ('kind' in r) return r
        redirects.push(r)
        break
      }
      case 'herestring_redirect': {
        // `cmd <<< "content"` — content is stdin, not argv. Validate it's
        // literal (no expansion); discard the content string.
        const err = walkHerestringRedirect(child, innerCommands, varScope)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }

  // Official 2.1.290 #5: a prefix assignment in front of a SPECIAL declaration
  // builtin (declare/typeset/export/readonly/local) PERSISTS in the shell, so a
  // later `$X` can resolve to the assigned value and must be reachable by
  // deny/ask rules. Record the names as `declarationPrefixes` and persist them
  // into varScope per the current reading (base parse = persist all).
  //
  // Branch/loop guard (official String#1, gate `B&&x.kind==="simple"`): inside
  // an if/while/for body the persistence is conditional on control flow we
  // can't statically resolve → too-complex verbatim.
  if (
    declPrefixCtx !== null &&
    prefixAssignments.length > 0 &&
    DECLARATION_BUILTINS.has(argv[0] ?? '')
  ) {
    if (declPrefixCtx.inBranch) {
      return {
        kind: 'too-complex',
        reason: DECL_PREFIX_BRANCH_REASON,
        nodeType: 'declaration_command',
      }
    }
    for (const ev of prefixAssignments) {
      const index = declPrefixCtx.names.length
      declPrefixCtx.names.push(ev.name)
      // Base parse (no reading): persist every declaration prefix so `$X`
      // resolves — mirrors official reporting `declarationPrefixBashKeeps` on
      // the `s===void 0` parse. Under a reading: persist only names the reading
      // marks true; the rest stay transient (a later `$X` → too-complex).
      const persist =
        declPrefixCtx.reading === undefined
          ? true
          : declPrefixCtx.reading[index] === true
      if (persist) {
        applyVarToScope(varScope, ev)
      }
    }
  }

  // .text is the raw source span. Downstream (bashToolCheckPermission →
  // splitCommand_DEPRECATED) re-tokenizes it via shell-quote. Normally .text
  // is used unchanged — but if we resolved a $VAR into argv, .text diverges
  // (has raw `$VAR`) and downstream RULE MATCHING would miss deny rules.
  //
  // SECURITY: `SUB=push && git $SUB --force` with `Bash(git push:*)` deny:
  //   argv = ['git', 'push', '--force']  ← correct, path validation sees 'push'
  //   .text = 'git $SUB --force'         ← deny rule 'git push:*' doesn't match
  //
  // Detection: any `$<identifier>` in node.text means a simple_expansion was
  // resolved (or we'd have returned too-complex). This catches $VAR at any
  // position — command_name, word, string interior, concatenation part.
  // `$(...)` doesn't match (paren, not identifier start). `'$VAR'` in single
  // quotes: tree-sitter's .text includes the quotes, so a naive check would
  // FP on `echo '$VAR'`. But single-quoted $ is LITERAL in bash — argv has
  // the literal `$VAR` string, so rebuilding from argv produces `'$VAR'`
  // anyway (shell-escape wraps it). Same net .text. No rule-matching error.
  //
  // Rebuild .text from argv. Shell-escape each arg: single-quote wrap with
  // `'\''` for embedded single quotes. Empty string, metacharacters, and
  // placeholders all get quoted. Downstream shell-quote re-parse is correct.
  //
  // NOTE: This does NOT include redirects/envVars in the rebuilt .text —
  // walkFileRedirect rejects simple_expansion, and envVars aren't used for
  // rule matching. If either changes, this rebuild must include them.
  //
  // SECURITY: also rebuild when node.text contains a newline. Line
  // continuations `<space>\<LF>` are invisible to argv (tree-sitter collapses
  // them) but preserved in node.text. `timeout 5 \<LF>curl evil.com` → argv
  // is correct, but raw .text → stripSafeWrappers matches `timeout 5 ` (the
  // space before \), leaving `\<LF>curl evil.com` — Bash(curl:*) deny doesn't
  // prefix-match. Rebuilt .text joins argv with ' ' → no newlines →
  // stripSafeWrappers works. Also covers heredoc-body leakage.
  const text =
    /\$[A-Za-z_]/.test(node.text) || node.text.includes('\n')
      ? argv
          .map(a =>
            a === '' || /["'\\ \t\n$`;|&<>(){}*?[\]~#]/.test(a)
              ? `'${a.replace(/'/g, "'\\''")}'`
              : a,
          )
          .join(' ')
      : node.text
  return {
    kind: 'simple',
    // Official 2.1.290 `Kt` return: `{argv:a,envVars:p,redirects:c,text:f,
    // hasUnquotedGlob:I(e.text),argvSourceLiteral:A===n,
    // carveOutMayDesyncQuoteScan:N!==l,argvUnquotedGlob:h}`.
    // argvSourceLiteral is NOT ported — OCC has no consumer for it (the
    // official uses it for env-prefix/command-name provenance; nothing in
    // the kAn gate path reads it). See gap ledger OCC-148.
    commands: [
      {
        argv,
        envVars,
        redirects,
        text,
        hasUnquotedGlob: hasUnquotedGlobChars(node.text),
        argvUnquotedGlob,
        carveOutMayDesyncQuoteScan: quoteScanCarveOuts !== carveOutsAtEntry,
      },
    ],
  }
}

/**
 * Recurse into a command_substitution node's inner command(s). If the inner
 * command(s) parse cleanly (simple), add them to the innerCommands
 * accumulator and return null (success). If the inner command is itself
 * too-complex (e.g., nested arith expansion, process sub), return the error.
 * This enables recursive permission checking: `echo $(git rev-parse HEAD)`
 * extracts BOTH `echo $(git rev-parse HEAD)` (outer) AND `git rev-parse HEAD`
 * (inner) — permission rules must match BOTH for the whole command to allow.
 */
function collectCommandSubstitution(
  csNode: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // Vars set BEFORE the $() are visible inside (bash subshell semantics),
  // but vars set INSIDE don't leak out. Pass a COPY of the outer scope so
  // inner assignments don't mutate the outer map.
  const innerScope = new Map(varScope)
  // command_substitution children: `$(` or `` ` ``, inner statement(s), `)`
  for (const child of csNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === '`' || child.type === ')') {
      continue
    }
    const err = collectCommands(child, innerCommands, innerScope)
    if (err) return err
  }
  return null
}

/**
 * Convert an argument node to its literal string value. Quotes are resolved.
 * This function implements the argument-position allowlist.
 */
function walkArgument(
  node: Node | null,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  if (!node) {
    return { kind: 'too-complex', reason: 'Null argument node' }
  }

  switch (node.type) {
    case 'word': {
      // Unescape backslash sequences. In unquoted context, bash's quote
      // removal turns `\X` → `X` for any character X. tree-sitter preserves
      // the raw text. Required for checkSemantics: `\eval` must match
      // EVAL_LIKE_BUILTINS, `\zmodload` must match ZSH_DANGEROUS_BUILTINS.
      // Also makes argv accurate: `find -exec {} \;` → argv has `;` not
      // `\;`. (Deny-rule matching on .text already worked via downstream
      // splitCommand_DEPRECATED unescaping — see walkCommand comment.) `\<whitespace>`
      // is already rejected by BACKSLASH_WHITESPACE_RE.
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Word contains brace expansion syntax',
          nodeType: 'word',
        }
      }
      return node.text.replace(/\\(.)/g, '$1')
    }

    case 'number':
      // SECURITY: tree-sitter-bash parses `NN#<expansion>` (arithmetic base
      // syntax) as a `number` node with the expansion as a CHILD. `10#$(cmd)`
      // is a number node whose .text is the full literal but whose child is a
      // command_substitution — bash runs the substitution. .text on a node
      // with children would smuggle the expansion past permission checks.
      // Plain numbers (`10`, `16#ff`) have zero children.
      if (node.children.length > 0) {
        return {
          kind: 'too-complex',
          reason: 'Number node contains expansion (NN# arithmetic base syntax)',
          nodeType: node.children[0]?.type,
        }
      }
      return node.text

    case 'raw_string':
      return stripRawString(node.text)

    case 'string':
      return walkString(node, innerCommands, varScope)

    case 'concatenation': {
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Brace expansion',
          nodeType: 'concatenation',
        }
      }
      let result = ''
      for (const child of node.children) {
        if (!child) continue
        const part = walkArgument(child, innerCommands, varScope)
        if (typeof part !== 'string') return part
        result += part
      }
      return result
    }

    case 'arithmetic_expansion': {
      const err = walkArithmetic(node)
      if (err) return err
      return node.text
    }

    case 'simple_expansion': {
      // `$VAR` inside a concatenation (e.g., `prefix$VAR`). Same rules
      // as the bare case in walkCommand: must be tracked or SAFE_ENV_VARS.
      // inside-concatenation counts as bare arg (the whole concat IS the arg)
      return resolveSimpleExpansion(node, varScope, false)
    }

    // NOTE: command_substitution at arg position (bare or inside concatenation)
    // is intentionally NOT handled — the output is/becomes-part-of a positional
    // argument which might be a path or flag. `rm $(foo)` or `rm $(foo)bar`
    // would hide the real path behind the placeholder. Only $() inside a
    // `string` node (walkString) is extracted, since the output is embedded
    // in a longer string rather than BEING the argument.

    default:
      return tooComplex(node)
  }
}

/**
 * Extract literal content from a double-quoted string node. A `string` node's
 * children are `"` delimiters, `string_content` literals, and possibly
 * expansion nodes.
 *
 * tree-sitter quirk: literal newlines inside double quotes are NOT included
 * in `string_content` node text. bash preserves them. For `"a\nb"`,
 * tree-sitter produces two `string_content` children (`"a"`, `"b"`) with the
 * newline in neither. For `"\n#"`, it produces ONE child (`"#"`) with the
 * leading newline eaten. Concatenating children therefore loses newlines.
 *
 * Fix: track child `startIndex` and insert one `\n` per index gap. The gap
 * between children IS the dropped newline(s). This makes the argv value
 * match what bash actually sees.
 */
function walkString(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  let result = ''
  let cursor = -1
  // SECURITY: Track whether the string contains a runtime-unknown
  // placeholder ($() output or unknown-value tracked var) vs any literal
  // content. A string that is ONLY a placeholder (`"$(cmd)"`, `"$VAR"`
  // where VAR holds an unknown sentinel) produces an argv element that IS
  // the placeholder — which downstream path validation resolves as a
  // relative filename within cwd, bypassing the check. `cd "$(echo /etc)"`
  // would pass validation but runtime-cd into /etc. We reject
  // solo-placeholder strings; placeholders mixed with literal content
  // (`"prefix: $(cmd)"`) are safe — runtime value can't equal a bare path.
  let sawDynamicPlaceholder = false
  let sawLiteralContent = false
  for (const child of node.children) {
    if (!child) continue
    // Index gap between this child and the previous one = dropped newline(s).
    // Ignore the gap before the first non-delimiter child (cursor === -1).
    // Skip gap-fill for `"` delimiters: a gap before the closing `"` is the
    // tree-sitter whitespace-only-string quirk (space/tab, not newline) — let
    // the Fix C check below catch it as too-complex instead of mis-filling
    // with `\n` and diverging from bash.
    if (cursor !== -1 && child.startIndex > cursor && child.type !== '"') {
      result += '\n'.repeat(child.startIndex - cursor)
      sawLiteralContent = true
    }
    cursor = child.endIndex
    switch (child.type) {
      case '"':
        // Reset cursor after opening quote so the gap between `"` and the
        // first content child is captured.
        cursor = child.endIndex
        break
      case 'string_content':
        // Bash double-quote escape rules (NOT the generic /\\(.)/g used for
        // unquoted words in walkArgument): inside "...", a backslash only
        // escapes $ ` " \ — other sequences like \n stay literal. So
        // `"fix \"bug\""` → `fix "bug"`, but `"a\nb"` → `a\nb` (backslash
        // kept). tree-sitter preserves the raw escapes in .text; we resolve
        // them here so argv matches what bash actually passes.
        result += child.text.replace(/\\([$`"\\])/g, '$1')
        sawLiteralContent = true
        break
      case DOLLAR:
        // A bare dollar sign before closing quote or a non-name char is
        // literal in bash. tree-sitter emits it as a standalone node.
        result += DOLLAR
        sawLiteralContent = true
        break
      case 'command_substitution': {
        // Carve-out: `$(cat <<'EOF' ... EOF)` is safe. The quoted-delimiter
        // heredoc body is literal (no expansion), and `cat` just prints it.
        // The substitution result is therefore a known static string. This
        // pattern is the idiomatic way to pass multi-line content to tools
        // like `gh pr create --body`. We replace the substitution with a
        // placeholder argv value — the actual content doesn't matter for
        // permission checking, only that it IS static.
        const heredocBody = extractSafeCatHeredoc(child)
        if (heredocBody === 'DANGEROUS') return tooComplex(child)
        if (heredocBody !== null) {
          // CC 2.1.290: official string walker increments the module-global
          // carve-out counter here (`if(gt.test(p.text))N++`) when the
          // substitution text contains quote/backtick/backslash chars — the
          // whole-text quote scan (hasUnquotedGlobChars) may then desync
          // from bash's real quote state across the carve-out. walkCommand
          // snapshots the counter to set carveOutMayDesyncQuoteScan.
          if (CMD_SUB_QUOTE_DESYNC_RE.test(child.text)) quoteScanCarveOuts++
          // SECURITY: the body IS the substitution result. Previously we
          // dropped it → `rm "$(cat <<'EOF'\n/etc/passwd\nEOF)"` produced
          // argv ['rm',''] while bash runs `rm /etc/passwd`. validatePath('')
          // resolves to cwd → allowed. Every path-constrained command
          // bypassed via this. Now: append the body (trailing LF trimmed —
          // bash $() strips trailing newlines).
          //
          // Tradeoff: bodies with internal newlines are multi-line text
          // (markdown, scripts) which cannot be valid paths — safe to drop
          // to avoid NEWLINE_HASH_RE false positives on `## Summary`. A
          // single-line body (like `/etc/passwd`) MUST go into argv so
          // downstream path validation sees the real target.
          const trimmed = heredocBody.replace(/\n+$/, '')
          if (trimmed.includes('\n')) {
            sawLiteralContent = true
            break
          }
          result += trimmed
          sawLiteralContent = true
          break
        }
        // General $() inside "...": recurse into inner command(s). If they
        // parse cleanly, they become additional subcommands that the
        // permission system must match rules against. The outer argv gets
        // the original $() text as placeholder (runtime-determined value).
        // `echo "SHA: $(git rev-parse HEAD)"` → extracts BOTH
        // `echo "SHA: $(...)"` AND `git rev-parse HEAD` — both must match
        // permission rules. ~27% of too-complex in top-5k ant cmds.
        const err = collectCommandSubstitution(child, innerCommands, varScope)
        if (err) return err
        result += CMDSUB_PLACEHOLDER
        sawDynamicPlaceholder = true
        break
      }
      case 'simple_expansion': {
        // `$VAR` inside "...". Tracked/safe vars resolve; untracked reject.
        const v = resolveSimpleExpansion(child, varScope, true)
        if (typeof v !== 'string') return v
        // VAR_PLACEHOLDER = runtime-unknown (loop var, read var, $() output,
        // SAFE_ENV_VARS, special vars). Any other string = actual literal
        // value from a tracked static var (e.g. VAR=/tmp → v='/tmp').
        if (v === VAR_PLACEHOLDER) sawDynamicPlaceholder = true
        else sawLiteralContent = true
        result += v
        break
      }
      case 'arithmetic_expansion': {
        const err = walkArithmetic(child)
        if (err) return err
        result += child.text
        // Validated to be literal-numeric — static content.
        sawLiteralContent = true
        break
      }
      default:
        // expansion (${...}) inside "..."
        return tooComplex(child)
    }
  }
  // SECURITY: Reject solo-placeholder strings. `"$(cmd)"` or `"$VAR"` (where
  // VAR holds an unknown value) would produce an argv element that IS the
  // placeholder — which bypasses downstream path validation (validatePath
  // resolves placeholders as relative filenames within cwd). Only allow
  // placeholders embedded alongside literal content (`"prefix: $(cmd)"`).
  if (sawDynamicPlaceholder && !sawLiteralContent) {
    return tooComplex(node)
  }
  // SECURITY: tree-sitter-bash quirk — a double-quoted string containing
  // ONLY whitespace (` "`, `" "`, `"\t"`) produces NO string_content child;
  // the whitespace is attributed to the closing `"` node's text. Our loop
  // only adds to `result` from string_content/expansion children, so we'd
  // return "" when bash sees " ". Detect: we saw no content children
  // (both flags false — neither literal nor placeholder added) but the
  // source span is longer than bare `""`. Genuine `""` has text.length==2.
  // `"$V"` with V="" doesn't hit this — the simple_expansion child sets
  // sawLiteralContent via the `else` branch even when v is empty.
  if (!sawLiteralContent && !sawDynamicPlaceholder && node.text.length > 2) {
    return tooComplex(node)
  }
  return result
}

/**
 * Safe leaf nodes inside arithmetic expansion: integer literals (decimal,
 * hex, octal, bash base#digits) and operator/paren tokens. Anything else at
 * leaf position (notably variable_name that isn't a numeric literal) rejects.
 */
const ARITH_LEAF_RE =
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[-+*/%^&|~!<>=?:(),]+|<<|>>|\*\*|&&|\|\||[<>=!]=|\$\(\(|\)\))$/

/**
 * Recursively validate an arithmetic_expansion node. Allows only literal
 * numeric expressions — no variables, no substitutions. Returns null if
 * safe, or a too-complex result if not.
 *
 * Variables are rejected because bash arithmetic recursively evaluates
 * variable values: if x='a[$(cmd)]' then $((x)) executes cmd. See
 * https://www.vidarholen.net/contents/blog/?p=716 (arithmetic injection).
 *
 * When safe, the caller puts the full `$((…))` span into argv as a literal
 * string. bash will expand it to an integer at runtime; the static string
 * won't match any sensitive path/deny patterns.
 */
function walkArithmetic(node: Node): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.children.length === 0) {
      if (!ARITH_LEAF_RE.test(child.text)) {
        return {
          kind: 'too-complex',
          reason: `Arithmetic expansion references variable or non-literal: ${child.text}`,
          nodeType: 'arithmetic_expansion',
        }
      }
      continue
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression': {
        const err = walkArithmetic(child)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }
  return null
}

/**
 * Check if a command_substitution node is exactly `$(cat <<'DELIM'...DELIM)`
 * and return the heredoc body if so. Any deviation (extra args to cat,
 * unquoted delimiter, additional commands) returns null.
 *
 * tree-sitter structure:
 *   command_substitution
 *     $(
 *     redirected_statement
 *       command → command_name → word "cat"    (exactly one child)
 *       heredoc_redirect
 *         <<
 *         heredoc_start 'DELIM'                (quoted)
 *         heredoc_body                         (pure heredoc_content)
 *         heredoc_end
 *     )
 */
function extractSafeCatHeredoc(subNode: Node): string | 'DANGEROUS' | null {
  // Expect exactly: $( + one redirected_statement + )
  let stmt: Node | null = null
  for (const child of subNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === ')') continue
    if (child.type === 'redirected_statement' && stmt === null) {
      stmt = child
    } else {
      return null
    }
  }
  if (!stmt) return null

  // redirected_statement must be: command(cat) + heredoc_redirect (quoted)
  let sawCat = false
  let body: string | null = null
  for (const child of stmt.children) {
    if (!child) continue
    if (child.type === 'command') {
      // Must be bare `cat` — no args, no env vars
      const cmdChildren = child.children.filter(c => c)
      if (cmdChildren.length !== 1) return null
      const nameNode = cmdChildren[0]
      if (nameNode?.type !== 'command_name' || nameNode.text !== 'cat') {
        return null
      }
      sawCat = true
    } else if (child.type === 'heredoc_redirect') {
      // Reuse the existing validator: quoted delimiter, body is pure text.
      // walkHeredocRedirect returns null on success, non-null on rejection.
      if (walkHeredocRedirect(child) !== null) return null
      for (const hc of child.children) {
        if (hc?.type === 'heredoc_body') body = hc.text
      }
    } else {
      return null
    }
  }

  if (!sawCat || body === null) return null
  // SECURITY: the heredoc body becomes the outer command's argv value via
  // substitution, so a body like `/proc/self/environ` is semantically
  // `cat /proc/self/environ`. checkSemantics never sees the body (we drop it
  // at the walkString call site to avoid newline+# FPs). Returning `null`
  // here would fall through to collectCommandSubstitution in walkString,
  // which would extract the inner `cat` via walkHeredocRedirect (body text
  // not inspected there) — effectively bypassing this check. Return a
  // distinct sentinel so the caller can reject instead of falling through.
  if (PROC_ENVIRON_RE.test(body)) return 'DANGEROUS'
  // Same for jq system(): checkSemantics checks argv but never sees the
  // heredoc body. Check unconditionally (we don't know the outer command).
  if (/\bsystem\s*\(/.test(body)) return 'DANGEROUS'
  return body
}

function walkVariableAssignment(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): { name: string; value: string; isAppend: boolean } | ParseForSecurityResult {
  let name: string | null = null
  let value = ''
  let isAppend = false

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'variable_name') {
      name = child.text
    } else if (child.type === '=' || child.type === '+=') {
      // `PATH+=":/new"` — tree-sitter emits `+=` as a distinct operator
      // node. Without this case it falls through to walkArgument below
      // → tooComplex on unknown type `+=`.
      isAppend = child.type === '+='
    } else if (child.type === 'command_substitution') {
      // $() as the variable's value. The output becomes a STRING stored in
      // the variable — it's NOT a positional argument (no path/flag concern).
      // `VAR=$(date)` runs `date`, stores output. `VAR=$(rm -rf /)` runs
      // `rm` — the inner command IS checked against permission rules, so
      // `rm` must match a rule. The variable just holds whatever `rm` prints.
      const err = collectCommandSubstitution(child, innerCommands, varScope)
      if (err) return err
      value = CMDSUB_PLACEHOLDER
    } else if (child.type === 'simple_expansion') {
      // `VAR=$OTHER` — assignment RHS does NOT word-split or glob-expand
      // in bash (unlike command arguments). So `A="a b"; B=$A` sets B to
      // the literal "a b". Resolve as if inside a string (insideString=true)
      // so BARE_VAR_UNSAFE_RE doesn't over-reject. The resulting value may
      // contain spaces/globs — if B is later used as a bare arg, THAT use
      // will correctly reject via BARE_VAR_UNSAFE_RE.
      const v = resolveSimpleExpansion(child, varScope, true)
      if (typeof v !== 'string') return v
      // If v is VAR_PLACEHOLDER (OTHER holds unknown), store it — combined
      // with containsAnyPlaceholder in the caller to treat as unknown.
      value = v
    } else {
      const v = walkArgument(child, innerCommands, varScope)
      if (typeof v !== 'string') return v
      value = v
    }
  }

  if (name === null) {
    return {
      kind: 'too-complex',
      reason: 'Variable assignment without name',
      nodeType: 'variable_assignment',
    }
  }
  // SECURITY: tree-sitter-bash accepts invalid var names (e.g. `1VAR=value`)
  // as variable_assignment. Bash only recognizes [A-Za-z_][A-Za-z0-9_]* —
  // anything else is run as a COMMAND. `1VAR=value` → bash tries to execute
  // `1VAR=value` from PATH. We must not treat it as an inert assignment.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      kind: 'too-complex',
      reason: `Invalid variable name (bash treats as command): ${name}`,
      nodeType: 'variable_assignment',
    }
  }
  // SECURITY: Setting IFS changes word-splitting behavior for subsequent
  // unquoted $VAR expansions. `IFS=: && VAR=a:b && rm $VAR` → bash splits
  // on `:` → `rm a b`. Our BARE_VAR_UNSAFE_RE only checks default IFS
  // chars (space/tab/NL) — we can't model custom IFS. Reject.
  if (name === 'IFS') {
    return {
      kind: 'too-complex',
      reason: 'IFS assignment changes word-splitting — cannot model statically',
      nodeType: 'variable_assignment',
    }
  }
  // SECURITY: PS4 is expanded via promptvars (default on) on every command
  // traced after `set -x`. A raw_string value containing $(cmd) or `cmd`
  // executes at trace time: `PS4='$(id)' && set -x && :` runs id, but our
  // argv is only [["set","-x"],[":"]] — the payload is invisible to
  // permission checks. PS0-3 and PROMPT_COMMAND are not expanded in
  // non-interactive shells (BashTool).
  //
  // ALLOWLIST, not blocklist. 5 rounds of bypass patches taught us that a
  // value-dependent blocklist is structurally fragile:
  //   - `+=` effective-value computation diverges from bash in multiple
  //     scope-model gaps: `||` reset, env-prefix chain (PS4='' && PS4='$'
  //     PS4+='(id)' cmd reads stale parent value), subshell.
  //   - bash's decode_prompt_string runs BEFORE promptvars, so `\044(id)`
  //     (octal for `$`) becomes `$(id)` at trace time — any literal-char
  //     check must model prompt-escape decoding exactly.
  //   - assignment paths exist outside walkVariableAssignment (for_statement
  //     sets loopVar directly, see that handler's PS4 check).
  //
  // Policy: (1) reject += outright — no scope-tracking dependency; user can
  // combine into one PS4=... (2) reject placeholders — runtime unknowable.
  // (3) allowlist remaining value: ${identifier} refs (value-read only, safe)
  // plus [A-Za-z0-9 _+:.\/=[\]-]. No bare `$` (blocks split primitive), no
  // `\` (blocks octal \044/\140), no backtick, no parens. Covers all known
  // encoding vectors and future ones — anything off the allowlist fails.
  // Legit `PS4='+${BASH_SOURCE}:${LINENO}: '` still passes.
  if (name === 'PS4') {
    if (isAppend) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 += cannot be statically verified — combine into a single PS4= assignment',
        nodeType: 'variable_assignment',
      }
    }
    if (containsAnyPlaceholder(value)) {
      return {
        kind: 'too-complex',
        reason: 'PS4 value derived from cmdsub/variable — runtime unknowable',
        nodeType: 'variable_assignment',
      }
    }
    if (
      !/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
        value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''),
      )
    ) {
      return {
        kind: 'too-complex',
        reason:
          `PS4 value outside safe charset — only \${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed`,
        nodeType: 'variable_assignment',
      }
    }
  }
  // SECURITY: Tilde expansion in assignment RHS. `VAR=~/x` (unquoted) →
  // bash expands `~` at ASSIGNMENT time → VAR='/home/user/x'. We see the
  // literal `~/x`. Later `cd $VAR` → our argv `['cd','~/x']`, bash runs
  // `cd /home/user/x`. Tilde expansion also happens after `=` and `:` in
  // assignment values (e.g. PATH=~/bin:~/sbin). We can't model it — reject
  // any value containing `~` that isn't already quoted-literal (where bash
  // doesn't expand). Conservative: any `~` in value → reject.
  if (value.includes('~')) {
    return {
      kind: 'too-complex',
      reason: 'Tilde in assignment value — bash may expand at assignment time',
      nodeType: 'variable_assignment',
    }
  }
  return { name, value, isAppend }
}

/**
 * Resolve a `simple_expansion` ($VAR) node. Returns VAR_PLACEHOLDER if
 * resolvable, too-complex otherwise.
 *
 * @param insideString true when $VAR is inside a `string` node ("...$VAR...")
 *   rather than a bare/concatenation argument. SAFE_ENV_VARS and unknown-value
 *   tracked vars are only allowed inside strings — as bare args their runtime
 *   value IS the argument and we don't know it statically.
 *   `cd $HOME/../x` would hide the real path behind the placeholder;
 *   `echo "Home: $HOME"` just embeds text in a string. Tracked vars holding
 *   STATIC strings (VAR=literal) are allowed in both positions since their
 *   value IS known.
 */
function resolveSimpleExpansion(
  node: Node,
  varScope: Map<string, string>,
  insideString: boolean,
): string | ParseForSecurityResult {
  let varName: string | null = null
  let isSpecial = false
  for (const c of node.children) {
    if (c?.type === 'variable_name') {
      varName = c.text
      break
    }
    if (c?.type === 'special_variable_name') {
      varName = c.text
      isSpecial = true
      break
    }
  }
  if (varName === null) return tooComplex(node)
  // Tracked vars: check stored value. Literal strings (VAR=/tmp) are
  // returned DIRECTLY so downstream path validation sees the real path.
  // Non-literal values (containing any placeholder — loop vars, $() output,
  // read vars, composites like `VAR="prefix$(cmd)"`) are ONLY safe inside
  // strings; as bare args they'd hide the runtime path/flag from validation.
  //
  // SECURITY: Returning the actual trackedValue (not a placeholder) is the
  // critical fix. `VAR=/etc && rm $VAR` → argv ['rm', '/etc'] → validatePath
  // correctly rejects. Previously returned a placeholder → validatePath saw
  // '__LOOP_STATIC__', resolved as cwd-relative → PASSED → bypass.
  const trackedValue = varScope.get(varName)
  if (trackedValue !== undefined) {
    // CC 2.1.296 (official Z / KLn guard, ev-bashargv0.txt:
    // `if(KLn.has(s))return r&&le.has(s)&&s!=="BASHPID"?_:b(e)`): a
    // shell-managed special variable (BASH_ARGV0, PIPESTATUS, BASH_REMATCH,
    // PS1..PS4, RANDOM, …) can be reassigned by the shell itself between the
    // assignment and the use, so its tracked literal value cannot be trusted
    // statically — even when we just saw `BASH_ARGV0=foo`. Without this guard
    // `BASH_ARGV0=x cmd; … $BASH_ARGV0` resolved to the literal `x` and
    // auto-approved (the 2.1.296 changelog bug). Map: r=insideString,
    // le=SAFE_ENV_VARS, _=VAR_PLACEHOLDER, b(e)=tooComplex. The BASHPID
    // carve-out (`s!=="BASHPID"`) is verbatim: BASHPID is the shell PID, never
    // a stable literal, so it is always too-complex on use (existing v288 #28
    // BASHPID assignment-gate behavior is untouched — that gate fires on the
    // assignment node, not here).
    if (SPECIAL_SHELL_VARS.has(varName)) {
      return insideString &&
        SAFE_ENV_VARS.has(varName) &&
        varName !== 'BASHPID'
        ? VAR_PLACEHOLDER
        : tooComplex(node)
    }
    if (containsAnyPlaceholder(trackedValue)) {
      // Non-literal: bare → reject, inside string → VAR_PLACEHOLDER
      // (walkString's solo-placeholder gate rejects `"$VAR"` alone).
      if (!insideString) return tooComplex(node)
      return VAR_PLACEHOLDER
    }
    // Pure literal (e.g. '/tmp', 'foo') — return it directly. Downstream
    // path validation / checkSemantics operate on the REAL value.
    //
    // SECURITY: For BARE args (not inside a string), bash word-splits on
    // $IFS and glob-expands the result. `VAR="-rf /" && rm $VAR` → bash
    // runs `rm -rf /` (two args); `VAR="/etc/*" && cat $VAR` → expands to
    // all files. Reject values containing IFS/glob chars unless in "...".
    //
    // SECURITY: Empty value as bare arg. Bash word-splitting on "" produces
    // ZERO fields — the expansion disappears. `V="" && $V eval x` → bash
    // runs `eval x` (our argv would be ["","eval","x"] with name="" —
    // every EVAL_LIKE/ZSH/keyword check misses). `V="" && ls $V /etc` →
    // bash runs `ls /etc`, our argv has a phantom "" shifting positions.
    // Inside "...": `"$V"` → bash produces one empty-string arg → our ""
    // is correct, keep allowing.
    if (!insideString) {
      if (trackedValue === '') return tooComplex(node)
      if (BARE_VAR_UNSAFE_RE.test(trackedValue)) return tooComplex(node)
    }
    return trackedValue
  }
  // SAFE_ENV_VARS + special vars ($?, $$, $@, $1, etc.): value unknown
  // (shell-controlled). Only safe when embedded in a string, NOT as a
  // bare argument to a path-sensitive command.
  if (insideString) {
    if (SAFE_ENV_VARS.has(varName)) return VAR_PLACEHOLDER
    if (
      isSpecial &&
      (SPECIAL_VAR_NAMES.has(varName) || /^[0-9]+$/.test(varName))
    ) {
      return VAR_PLACEHOLDER
    }
  }
  return tooComplex(node)
}

/**
 * Apply a variable assignment to the scope, handling `+=` append semantics.
 * SECURITY: If EITHER side (existing value or appended value) contains a
 * placeholder, the result is non-literal — store VAR_PLACEHOLDER so later
 * $VAR correctly rejects as bare arg.
 * `VAR=/etc && VAR+=$(cmd)` must not leave VAR looking static.
 */
function applyVarToScope(
  varScope: Map<string, string>,
  ev: { name: string; value: string; isAppend: boolean },
): void {
  const existing = varScope.get(ev.name) ?? ''
  const combined = ev.isAppend ? existing + ev.value : ev.value
  varScope.set(
    ev.name,
    containsAnyPlaceholder(combined) ? VAR_PLACEHOLDER : combined,
  )
}

function stripRawString(text: string): string {
  return text.slice(1, -1)
}

/**
 * Plain-language explanations for parser node types, shown in the Bash
 * permission prompt when a command is too complex to statically analyze.
 * Byte-exact port of the official Claude Code 2.1.288 `vt` map (@203543557
 * region — the 26-entry sentence-case node-type → explanation table consumed
 * by the too-complex builder `_()`). The 2.1.287 `Rt` map OCC previously
 * matched used lowercase explanations; v288 (#72, "shorter reason when part
 * of a command can't be checked before it runs") replaced both the map
 * strings and the builder template. Insertion order matches the official
 * `new Map([...])`. See docs/gap-research-288/cluster-a-permission-sandbox.md
 * #72 and /tmp/cc-diff-288/r72_builder.txt.
 */
export const NODE_TYPE_EXPLANATIONS: ReadonlyMap<string, string> = new Map([
  ['simple_expansion', 'A variable'],
  ['expansion', 'A variable in braces'],
  ['command_substitution', 'A nested command'],
  ['process_substitution', 'A command used as a file'],
  ['brace_expression', 'A brace pattern'],
  ['ansi_c_string', 'Text with escape codes'],
  ['translated_string', 'Translatable text'],
  ['test_command', 'A test in brackets'],
  ['herestring_redirect', 'A here-string'],
  ['heredoc_redirect', 'A here-document'],
  ['subshell', 'A group in parentheses'],
  ['compound_statement', 'A group in braces or double parentheses'],
  ['for_statement', 'A for or select loop'],
  ['c_style_for_statement', 'A counting for loop'],
  ['while_statement', 'A while or until loop'],
  ['until_statement', 'An until loop'],
  ['if_statement', 'An if statement'],
  ['case_statement', 'A case statement'],
  ['function_definition', 'A function definition'],
  ['array', 'A list of values'],
  ['string', 'Quoted text'],
  ['file_redirect', 'A file redirect'],
  ['pipeline', 'A pipeline'],
  ['concatenation', 'Joined pieces of text'],
  ['variable_assignment', 'A variable assignment'],
  ['variable_assignments', 'Variable assignments'],
])

/**
 * Build the 'too-complex' rejection for a node we can't statically analyze.
 * Byte-exact port of the official Claude Code 2.1.288 `_()` builder:
 *   - ERROR node            → reason 'Parse error'
 *   - mapped node type      → '<Explanation> in this command can't be checked
 *                             before it runs'
 *   - unmapped/unknown type → 'This command can't be checked before it runs'
 * Official v288 template (verbatim):
 *   `${n===void 0 ? "This command" : `${n} in this command`} can't be checked
 *    before it runs`
 * Replaces the v287 long form ("Part of this command (…) cannot be checked
 * in advance"). The return shape (`{ kind, reason, nodeType }`) is unchanged;
 * only the `reason` strings differ. See
 * docs/gap-research-288/cluster-a-permission-sandbox.md #72.
 */
export function tooComplex(node: Node): ParseForSecurityResult {
  if (node.type === 'ERROR')
    return { kind: 'too-complex', reason: 'Parse error', nodeType: node.type }
  const explanation = NODE_TYPE_EXPLANATIONS.get(node.type)
  return {
    kind: 'too-complex',
    reason: `${
      explanation === undefined ? 'This command' : `${explanation} in this command`
    } can't be checked before it runs`,
    nodeType: node.type,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Post-argv semantic checks
//
// Everything above answers "can we tokenize?". Everything below answers
// "is the resulting argv dangerous in ways that don't involve parsing?".
// These are checks on argv[0] or argv content that the old bashSecurity.ts
// validators performed but which have nothing to do with parser
// differentials. They're here (not in bashSecurity.ts) because they operate
// on SimpleCommand and need to run for every extracted command.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Zsh module builtins. These are not binaries on PATH — they're zsh
 * internals loaded via zmodload. Since BashTool runs via the user's default
 * shell (often zsh), and these parse as plain `command` nodes with no
 * distinguishing syntax, we can only catch them by name.
 */
const ZSH_DANGEROUS_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

/**
 * Shell builtins that evaluate their arguments as code or otherwise escape
 * the argv abstraction. A command like `eval "rm -rf /"` has argv
 * ['eval', 'rm -rf /'] which looks inert to flag validation but executes
 * the string. Treat these the same as command substitution.
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  // NOTE (v288 #72): 'command', 'builtin' and 'noglob' are intentionally
  // NOT members — the official v288 `d8` set (@203561310 region: eval,
  // source, ., exec, nocorrect, fc, coproc, trap, enable, mapfile,
  // readarray, hash, bind, complete, compgen, alias, let) omits them
  // because the wrapper strip loop in checkSemantics unwraps them first
  // (`command rm` is checked as `rm`). Keeping them here would over-block
  // the inert bare forms (`command`, `builtin --`) the official allows.
  'fc',
  // `coproc rm -rf /` spawns rm as a coprocess. tree-sitter parses it as
  // a plain command with argv[0]='coproc', so permission rules and path
  // validation would check 'coproc' not 'rm'.
  'coproc',
  'nocorrect',
  // `trap 'cmd' SIGNAL` — cmd runs as shell code on signal/exit. EXIT fires
  // at end of every BashTool invocation, so this is guaranteed execution.
  'trap',
  // `enable -f /path/lib.so name` — dlopen arbitrary .so as a builtin.
  // Native code execution.
  'enable',
  // `mapfile -C callback -c N` / `readarray -C callback` — callback runs as
  // shell code every N input lines.
  'mapfile',
  'readarray',
  // `hash -p /path cmd` — poisons bash's command-lookup cache. Subsequent
  // `cmd` in the same command resolves to /path instead of PATH lookup.
  'hash',
  // `bind -x '"key":cmd'` / `complete -C cmd` — interactive-only callbacks
  // but still code-string arguments. Low impact in non-interactive BashTool
  // shells, blocked for consistency. `compgen -C cmd` is NOT interactive-only:
  // it immediately executes the -C argument to generate completions.
  'bind',
  'complete',
  'compgen',
  // `alias name='cmd'` — aliases not expanded in non-interactive bash by
  // default, but `shopt -s expand_aliases` enables them. Also blocked as
  // defense-in-depth (alias followed by name use in same command).
  'alias',
  // `let EXPR` arithmetically evaluates EXPR — identical to $(( EXPR )).
  // Array subscripts in the expression expand $(cmd) at eval time even when
  // the argument arrived single-quoted: `let 'x=a[$(id)]'` executes id.
  // tree-sitter sees the raw_string as an opaque leaf. Same primitive
  // walkArithmetic guards, but `let` is a plain command node.
  'let',
])

/**
 * Builtins that re-parse a NAME operand internally and arithmetically
 * evaluate `arr[EXPR]` subscripts — including $(cmd) in the subscript —
 * even when the argv element arrived from a single-quoted raw_string.
 * `test -v 'a[$(id)]'` → tree-sitter sees an opaque leaf, bash runs id.
 * Maps: builtin name → set of flags whose next argument is a NAME.
 */
const SUBSCRIPT_EVAL_FLAGS: Record<string, Set<string>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  // bash 5.1+: `wait -p VAR [id...]` stores the waited PID into VAR. When VAR
  // is `arr[EXPR]`, bash arithmetically evaluates the subscript — running
  // $(cmd) even from a single-quoted raw_string. Verified bash 5.3.9:
  // `: & wait -p 'a[$(id)]' %1` executes id.
  wait: new Set(['-p']),
}

/**
 * `[[ ARG1 OP ARG2 ]]` where OP is an arithmetic comparison. bash manual:
 * "When used with [[, Arg1 and Arg2 are evaluated as arithmetic
 * expressions." Arithmetic evaluation recursively expands array subscripts,
 * so `[[ 'a[$(id)]' -eq 0 ]]` executes `id` even though tree-sitter sees
 * the operand as an opaque raw_string leaf. Unlike -v/-R (unary, NAME after
 * flag), these are binary — the subscript can appear on EITHER side, so
 * SUBSCRIPT_EVAL_FLAGS's "next arg" logic is insufficient.
 * `[` / `test` are not vulnerable (bash errors with "integer expression
 * expected"), but the test_command handler normalizes argv[0]='[[' for
 * both forms, so they get this check too — mild over-blocking, safe side.
 */
const TEST_ARITH_CMP_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/**
 * Builtins where EVERY non-flag positional argument is a NAME that bash
 * re-parses and arithmetically evaluates subscripts on — no flag required.
 * `read 'a[$(id)]'` executes id: each positional is a variable name to
 * assign into, and `arr[EXPR]` is valid syntax there. `unset NAME...` is
 * the same (though tree-sitter's unset_command handler currently rejects
 * raw_string children before reaching here — this is defense-in-depth).
 * NOT printf (positional args are FORMAT/data), NOT test/[ (operands are
 * values, only -v/-R take a NAME). declare/typeset/local handled in
 * declaration_command since they never reach here as plain commands.
 */
const BARE_SUBSCRIPT_NAME_BUILTINS = new Set(['read', 'unset'])

/**
 * `read` flags whose NEXT argument is data (prompt/delimiter/count/fd),
 * not a NAME. `read -p '[foo] ' var` must not trip on the `[` in the
 * prompt string. `-a` is intentionally absent — its operand IS a NAME.
 */
const READ_DATA_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

// SHELL_KEYWORDS imported from bashParser.ts — shell reserved words can never
// be legitimate argv[0]; if they appear, the parser mis-parsed a compound
// command. Reject to avoid nonsense argv reaching downstream.

// Use `.*` not `[^/]*` — Linux resolves `..` in procfs, so
// `/proc/self/../self/environ` works and must be caught.
const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/**
 * Newline followed by `#` in an argv element, env var value, or redirect target.
 * Downstream stripSafeWrappers re-tokenizes .text line-by-line and treats `#`
 * after a newline as a comment, hiding arguments that follow.
 */
const NEWLINE_HASH_RE = /\n[ \t]*#/

/**
 * Awk-family interpreters (official v288 `NSe` @203546798, verbatim).
 * An awk program is source code passed as an argument — system(), pipes,
 * @load and /inet/ sockets inside it execute arbitrary commands.
 */
const AWK_FAMILY = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/**
 * Awk options whose NEXT argument is the program/file operand, not program
 * text (official v288 `Pt`, verbatim). Used by the xargs-gives-awk scan to
 * skip option operands when looking for the program text.
 */
const AWK_NEXT_ARG_OPTION_RE = /^(?:-[FvW]$|--(?:fie|a$|as))/

/*
 * CC 2.1.290 find semantic block — constants and predicates verbatim from
 * the official bash-security module (`nn`, `rn`, `an`, `lt`, `sn`, `PVt`,
 * `OVt`, `IVt`, `mwt`, `xOn`). The whole `if(a==="find"){…}` block in
 * checkSemantics was absent from OCC before this port (the v288 #72 round
 * only ported the wrapper-strip + awk blocks and its STAGED note understated
 * the find gap — see docs/upstream-version-gap-occ148-2026-10.md).
 */

/** Official `nn` — find primaries that execute commands or modify files. */
const FIND_ACTION_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-rm',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '-files0-from',
])

/**
 * Official `xOn(e)`: `e!=="-rm"||o()` — `-rm` counts as an action unless
 * the `tengu_warm_sunrise` remote gate explicitly disables it (official
 * `o()` requires value===false AND source==="payload" AND defaultHost).
 * Divergence note (same pattern as dangerousRmAutoDeny.ts): OCC's
 * getFeatureValue_CACHED_MAY_BE_STALE does not expose source/defaultHost,
 * so any resolved `false` is treated as the kill-switch; with no live
 * GrowthBook client the default (true) applies and `-rm` is an action.
 */
function findFlagIsAction(arg: string): boolean {
  if (!FIND_ACTION_FLAGS.has(arg)) return false
  if (arg !== '-rm') return true
  try {
    const value = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
      'tengu_warm_sunrise',
      true,
    )
    return value !== false
  } catch {
    return true
  }
}

/** Official `an` (`OVt`) — options read differently by find versions. */
const FIND_VERSION_DIVERGENT_OPTION_RE = /^-[dsx]+f$/

/** Official `lt` (`IVt`) — bundled flag forms whose value follows. */
const FIND_VALUE_TAKING_FLAG_RE =
  /^-(?:[EHLPXdsx]*D|f|[dsx]*[EHLPX][EHLPXdsx]*f)$/

/** Official `sn` — the `-newerXY` family. */
const FIND_NEWER_FAMILY_RE = /^-newer[aBcm][aBcmt]$/

/** Official `rn` — named options whose NEXT argument is their value. */
const FIND_NAMED_VALUE_OPTIONS = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-lname',
  '-ilname',
  '-regex',
  '-iregex',
  '-wholename',
  '-iwholename',
  '-samefile',
  '-newer',
  '-anewer',
  '-cnewer',
  '-mnewer',
  '-perm',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-size',
  '-type',
  '-xtype',
  '-fstype',
  '-inum',
  '-links',
  '-used',
  '-context',
  '-amin',
  '-cmin',
  '-mmin',
  '-atime',
  '-ctime',
  '-mtime',
  '-mindepth',
  '-maxdepth',
  '-printf',
  '-regextype',
  '-D',
  '-f',
  '-flags',
  '-Bnewer',
  '-Btime',
  '-Bmin',
  '-files0-from',
  '-xattrname',
])

/** Official `mwt(e)`: `rn.has(e)||sn.test(e)||lt.test(e)`. */
function findOptionTakesValue(arg: string): boolean {
  return (
    FIND_NAMED_VALUE_OPTIONS.has(arg) ||
    FIND_NEWER_FAMILY_RE.test(arg) ||
    FIND_VALUE_TAKING_FLAG_RE.test(arg)
  )
}

/** Official find-block resolved-argument glob class: `/[[\]*?]/`. */
const FIND_ARG_GLOB_RE = /[[\]*?]/

/**
 * Process-wrapper commands that start another program (official v288 `W4`
 * @203547944, verbatim). What they start can't be checked statically —
 * `watch rm -rf /` re-runs rm on a timer, `strace`/`nsenter` change the
 * execution context. Rejected with args; bare `watch` alone is inert.
 */
const PROCESS_WRAPPER_COMMANDS = new Set([
  'watch',
  'ionice',
  'chrt',
  'setsid',
  'taskset',
  'strace',
  'ltrace',
  'script',
  'flock',
  'unshare',
  'nsenter',
])

/**
 * Inspect an awk argument for execution primitives. Official v288 `pyt()`
 * @203546874, byte-exact port: 5 regex→reason pairs, returns false when the
 * text is inert. SECURITY: without this, a literal `awk '{system("id")}'`
 * (no placeholder — a fully static program) passes every other argv check.
 */
function inspectAwkProgram(arg: string): string | false {
  if (/(?<![A-Za-z_])system[\s\\]*\(/.test(arg)) {
    return 'awk program contains system() which executes arbitrary commands'
  }
  if (
    /(?:^|[^|])\|&?[^/|%";#{}]*"/.test(arg) ||
    /(?:^|[^|])\|&?[\s\\]*getline\b/.test(arg)
  ) {
    return 'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands'
  }
  if (
    /@[\s\\]*(?:load|include)\b|@[\s\\]*\w+(?:::\w+)?(?:\[[^\]]*\])*[\s\\]*\(/.test(
      arg,
    )
  ) {
    return 'awk program contains @load/@include or an @indirect call which can execute arbitrary code'
  }
  if (/(?<![A-Za-z_])extension[\s\\]*\(/.test(arg)) {
    return 'awk program contains extension() which loads arbitrary native code (legacy gawk)'
  }
  if (/"\/inet[46]?\//.test(arg)) {
    return 'awk program opens a gawk /inet/ network socket which can exfiltrate data'
  }
  return false
}

/**
 * True when the value contains a runtime placeholder — the official v288
 * `Pi()` predicate: the real text is only known at execution time, so it
 * can't be checked before the command runs.
 */
function containsPlaceholder(value: string): boolean {
  return (
    value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER)
  )
}

export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

/**
 * Post-argv semantic checks. Run after parseForSecurity returns 'simple' to
 * catch commands that tokenize fine but are dangerous by name or argument
 * content. Returns the first failure or {ok: true}.
 */
export function checkSemantics(
  commands: SimpleCommand[],
  options?: { sourceGlobRecord?: boolean },
): SemanticCheckResult {
  // Official 2.1.290 `Hor(e,t)`: `let r=t?.sourceGlobRecord!==!1` — the
  // per-arg argvUnquotedGlob record is honored unless the caller explicitly
  // says the source glob record is unavailable. Both OCC call sites
  // (bashPermissions.ts) pass no options → true, matching the official
  // default.
  const useGlobRecord = options?.sourceGlobRecord !== false
  for (const cmd of commands) {
    // Strip safe wrapper commands (nohup, time, timeout N, nice -n N) so
    // `nohup eval "..."` and `timeout 5 jq 'system(...)'` are checked
    // against the wrapped command, not the wrapper. Inlined here to avoid
    // circular import with bashPermissions.ts.
    //
    // v288 #72: wrapper failure reasons use the official 2.1.288 short
    // forms ("'timeout --x' can't be checked before it runs" etc.), and the
    // strip loop mirrors the official `FJn` region (@203550620-203553200)
    // byte-for-byte: basename normalization (so `/usr/bin/timeout` strips
    // too), plus `command` (flags /^-[pvV]+$/ only; -v/-V keep name
    // 'command'), `builtin`/`noglob` (raw argv[0], optional `--` after
    // builtin), and `xargs` (only when argv[1] is not a flag; sets
    // viaXargs for the post-strip xargs checks). All wrapper reason strings
    // verbatim from the binary — see
    // docs/gap-research-288/cluster-a-permission-sandbox.md #72.
    // STAGED gap CLOSED (CC 2.1.290 round, was v288 #72 sole remaining
    // gap): the official awk/find blocks gate their first branch on
    // `o.hasUnquotedGlob||r&&kAn(o)`. SimpleCommand now carries
    // hasUnquotedGlob (2.1.289 `T(e.text)`) + argvUnquotedGlob/
    // carveOutMayDesyncQuoteScan (2.1.290 `Kt`), and the gates are
    // implemented below at the awk-family and find blocks.
    let a = cmd.argv
    let viaXargs = false
    for (;;) {
      const base = a[0]?.replace(/^.*[\\/]/, '')
      const wrapper =
        base === 'time' ||
        base === 'nohup' ||
        base === 'timeout' ||
        base === 'nice' ||
        base === 'stdbuf' ||
        base === 'env' ||
        base === 'command' ||
        base === 'xargs'
          ? base
          : a[0]
      if (wrapper === 'time' || wrapper === 'nohup') {
        a = a.slice(1)
      } else if (wrapper === 'timeout') {
        // `timeout 5`, `timeout 5s`, `timeout 5.5`, plus optional GNU flags
        // preceding the duration. Long: --foreground, --kill-after=N,
        // --signal=SIG, --preserve-status. Short: -k DUR, -s SIG, -v (also
        // fused: -k5, -sTERM).
        // SECURITY (SAST Mar 2026): the previous loop only skipped `--long`
        // flags, so `timeout -k 5 10 eval ...` broke out with name='timeout'
        // and the wrapped eval was never checked. Now handle known short
        // flags AND fail closed on any unrecognized flag — an unknown flag
        // means we can't locate the wrapped command, so we must not silently
        // fall through to name='timeout'.
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (
            arg === '--foreground' ||
            arg === '--preserve-status' ||
            arg === '--verbose'
          ) {
            i++ // known no-value long flags
          } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // --kill-after=5, --signal=TERM (value fused with =)
          } else if (
            (arg === '--kill-after' || arg === '--signal') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // --kill-after 5, --signal TERM (space-separated)
          } else if (arg.startsWith('--')) {
            // Unknown long flag, OR --kill-after/--signal with non-allowlisted
            // value (e.g. placeholder from $() substitution). Fail closed.
            // Reason: official v288 short form (FJn @203551221), verbatim.
            return {
              ok: false,
              reason: `'timeout ${arg}' can't be checked before it runs`,
            }
          } else if (arg === '-v') {
            i++ // --verbose, no argument
          } else if (
            (arg === '-k' || arg === '-s') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // -k DURATION / -s SIGNAL — separate value
          } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // fused: -k5, -sTERM
          } else if (arg.startsWith('-')) {
            // Unknown flag OR -k/-s with non-allowlisted value — can't locate
            // wrapped cmd. Reject, don't fall through to name='timeout'.
            // Reason: official v288 short form (FJn @203551221), verbatim.
            return {
              ok: false,
              reason: `'timeout ${arg}' can't be checked before it runs`,
            }
          } else {
            break // non-flag — should be the duration
          }
        }
        if (a[i] && /^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
          a = a.slice(i + 1)
        } else if (a[i]) {
          // SECURITY (PR #21503 round 3): a[i] exists but doesn't match our
          // duration regex. GNU timeout parses via xstrtod() (libc strtod) and
          // accepts `.5`, `+5`, `5e-1`, `inf`, `infinity`, hex floats — none
          // of which match `/^\d+(\.\d+)?[smhd]?$/`. Empirically verified:
          // `timeout .5 echo ok` works. Previously this branch `break`ed
          // (fail-OPEN) so `timeout .5 eval "id"` with `Bash(timeout:*)` left
          // name='timeout' and eval was never checked. Now fail CLOSED —
          // consistent with the unknown-FLAG handling above (lines ~1895,1912).
          // Reason: official v288 short form (FJn @203551221), verbatim.
          return {
            ok: false,
            reason: `timeout duration '${a[i]}' can't be checked before it runs`,
          }
        } else {
          break // no more args — `timeout` alone, inert
        }
      } else if (wrapper === 'nice') {
        // `nice cmd`, `nice -n N cmd`, `nice -N cmd` (legacy). All run cmd
        // at a lower priority. argv[0] check must see the wrapped cmd.
        if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
          a = a.slice(3)
        } else if (a[1] && /^-\d+$/.test(a[1])) {
          a = a.slice(2) // `nice -10 cmd`
        } else if (
          a[1] &&
          (/[$(`]/.test(a[1]) || containsPlaceholder(a[1]))
        ) {
          // SECURITY: walkArgument returns node.text for arithmetic_expansion,
          // so `nice $((0-5)) jq ...` has a[1]='$((0-5))'. Bash expands it to
          // '-5' (legacy nice syntax) and execs jq; we'd slice(1) here and
          // set name='$((0-5))' which skips the jq system() check entirely.
          // Fail closed — mirrors the timeout-duration fail-closed above.
          // NOTE (v288 #72): the official v288 `FJn` dump retains this long
          // reason verbatim (`nice argument '${t[1]}' contains expansion —
          // cannot statically determine wrapped command`) — nice was NOT
          // shortened, so OCC stays byte-identical to official here.
          return {
            ok: false,
            reason: `nice argument '${a[1]}' contains expansion — cannot statically determine wrapped command`,
          }
        } else {
          a = a.slice(1) // bare `nice cmd`
        }
      } else if (wrapper === 'env') {
        // `env [VAR=val...] [-i] [-0] [-v] [-u NAME...] cmd args` runs cmd.
        // argv[0] check must see cmd, not env. Skip known-safe forms only.
        // SECURITY: -S splits a string into argv (mini-shell) — must reject.
        // -C/-P change cwd/PATH — wrapped cmd runs elsewhere, reject.
        // Any OTHER flag → reject (fail-closed, not fail-open to name='env').
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (arg.includes('=') && !arg.startsWith('-')) {
            i++ // VAR=val assignment
          } else if (arg === '-i' || arg === '-0' || arg === '-v') {
            i++ // flags with no argument
          } else if (arg === '-u' && a[i + 1]) {
            i += 2 // -u NAME unsets; takes one arg
          } else if (arg.startsWith('-')) {
            // -S (argv splitter), -C (altwd), -P (altpath), --anything,
            // or unknown flag. Can't model — reject the whole command.
            // Reason: official v288 short form (FJn @203551221), verbatim.
            return {
              ok: false,
              reason: `'env ${arg}' can't be checked before it runs`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i < a.length) {
          a = a.slice(i)
        } else {
          break // `env` alone (no wrapped cmd) — inert, name='env'
        }
      } else if (wrapper === 'stdbuf') {
        // `stdbuf -o0 cmd` (fused), `stdbuf -o 0 cmd` (space-separated),
        // multiple flags (`stdbuf -o0 -eL cmd`), long forms (`--output=0`).
        // SECURITY: previous handling only stripped ONE flag and fell through
        // to slice(2) for anything unrecognized, so `stdbuf --output 0 eval`
        // → ['0','eval',...] → name='0' hid eval. Now iterate all known flag
        // forms and fail closed on any unknown flag.
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
            i += 2 // -o MODE (space-separated)
          } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
            i++ // -o0 (fused)
          } else if (STDBUF_LONG_RE.test(arg)) {
            i++ // --output=MODE (fused long)
          } else if (arg.startsWith('-')) {
            // --output MODE (space-separated long) or unknown flag. GNU
            // stdbuf long options use `=` syntax, but getopt_long also
            // accepts space-separated — we can't enumerate safely, reject.
            // Reason: official v288 short form (FJn @203551221), verbatim.
            return {
              ok: false,
              reason: `'stdbuf ${arg}' can't be checked before it runs`,
            }
          } else {
            break // the wrapped command
          }
        }
        if (i > 1 && i < a.length) {
          a = a.slice(i)
        } else {
          break // `stdbuf` with no flags or no wrapped cmd — inert
        }
      } else if (wrapper === 'command') {
        // `command [-p] [-v|-V] [--] cmd args` runs cmd bypassing shell
        // functions. Official v288 (@203552202): only /^-[pvV]+$/ flags are
        // strippable; -v/-V are existence checks that never execute argv[1],
        // so the loop breaks with name='command' (which then passes the
        // eval-like check — 'command' is NOT in the official `d8` set).
        let i = 1
        let sawV = false
        while (i < a.length && a[i]!.startsWith('-') && a[i] !== '--') {
          const flag = a[i]!
          if (!/^-[pvV]+$/.test(flag)) {
            // Reason: official v288 short form (@203552202), verbatim.
            return {
              ok: false,
              reason: `'command ${flag}' can't be checked before it runs`,
            }
          }
          if (flag.includes('v') || flag.includes('V')) sawV = true
          i++
        }
        if (a[i] === '--') i++
        if (sawV || i >= a.length) break
        a = a.slice(i)
      } else if (a[0] === 'builtin' || a[0] === 'noglob') {
        // Official v288 checks the RAW argv[0] here (not the basename):
        // `builtin [--] cmd` / `noglob cmd` (zsh precommand modifier).
        const skip = a[0] === 'builtin' && a[1] === '--' ? 2 : 1
        if (skip < a.length) {
          a = a.slice(skip)
        } else {
          break // bare `builtin`/`noglob` — inert
        }
      } else if (wrapper === 'xargs') {
        // Official v288 (@203552995): strip `xargs` only when argv[1] is not
        // a flag — otherwise xargs' own flags could rewrite what runs
        // (-I, -P, -n change the invoked program's argv). viaXargs gates the
        // post-strip "What xargs adds/gives" checks below.
        if (a.length >= 2 && !a[1]!.startsWith('-')) {
          a = a.slice(1)
          viaXargs = true
        } else {
          break
        }
      } else {
        break
      }
    }
    const name = a[0]
    if (name === undefined) continue

    // SECURITY: Empty command name. Quoted empty (`"" cmd`) is harmless —
    // bash tries to exec "" and fails with "command not found". But an
    // UNQUOTED empty expansion at command position (`V="" && $V cmd`) is a
    // bypass: bash drops the empty field and runs `cmd` as argv[0], while
    // our name="" skips every builtin check below. resolveSimpleExpansion
    // rejects the $V case; this catches any other path to empty argv[0]
    // (concatenation of empties, walkString whitespace-quirk, future bugs).
    if (name === '') {
      return {
        ok: false,
        reason: 'Empty command name — argv[0] may not reflect what bash runs',
      }
    }

    // Defense-in-depth: argv[0] should never be a placeholder after the
    // var-tracking fix (static vars return real value, unknown vars reject).
    // But if a bug upstream ever lets one through, catch it here — a
    // placeholder-as-command-name means runtime-determined command → unsafe.
    if (name.includes(CMDSUB_PLACEHOLDER) || name.includes(VAR_PLACEHOLDER)) {
      return {
        ok: false,
        reason: 'Command name is runtime-determined (placeholder argv[0])',
      }
    }

    // argv[0] starts with an operator/flag: this is a fragment, not a
    // command. Likely a line-continuation leak or a mistake.
    if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
      return {
        ok: false,
        reason: 'Command appears to be an incomplete fragment',
      }
    }

    // SECURITY: builtins that re-parse a NAME operand internally. bash
    // arithmetically evaluates `arr[EXPR]` in NAME position, running $(cmd)
    // in the subscript even when the argv element arrived from a
    // single-quoted raw_string (opaque leaf to tree-sitter). Two forms:
    // separate (`printf -v NAME`) and fused (`printf -vNAME`, getopt-style).
    // `printf '[%s]' x` stays safe — `[` in format string, not after `-v`.
    const dangerFlags = SUBSCRIPT_EVAL_FLAGS[name]
    if (dangerFlags !== undefined) {
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        // Separate form: `-v` then NAME in next arg.
        if (dangerFlags.has(arg) && a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'${name} ${arg}' operand contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
        // Combined short flags: `-ra` is bash shorthand for `-r -a`.
        // Check if any danger flag character appears in a combined flag
        // string. The danger flag's NAME operand is the next argument.
        if (
          arg.length > 2 &&
          arg[0] === '-' &&
          arg[1] !== '-' &&
          !arg.includes('[')
        ) {
          for (const flag of dangerFlags) {
            if (flag.length === 2 && arg.includes(flag[1]!)) {
              if (a[i + 1]?.includes('[')) {
                return {
                  ok: false,
                  reason: `'${name} ${flag}' (combined in '${arg}') operand contains array subscript — bash evaluates $(cmd) in subscripts`,
                }
              }
            }
          }
        }
        // Fused form: `-vNAME` in one arg. Only short-option flags fuse
        // (getopt), so check -v/-a/-R. `[[` uses test_operator nodes only.
        for (const flag of dangerFlags) {
          if (
            flag.length === 2 &&
            arg.startsWith(flag) &&
            arg.length > 2 &&
            arg.includes('[')
          ) {
            return {
              ok: false,
              reason: `'${name} ${flag}' (fused) operand contains array subscript — bash evaluates $(cmd) in subscripts`,
            }
          }
        }
      }
    }

    // SECURITY: `[[ ARG OP ARG ]]` arithmetic comparison. bash evaluates
    // BOTH operands as arithmetic expressions, recursively expanding
    // `arr[$(cmd)]` subscripts even from single-quoted raw_string. Check
    // the operand adjacent to each arith-cmp operator on BOTH sides —
    // SUBSCRIPT_EVAL_FLAGS's "flag then next-arg" pattern can't express
    // "either side of a binary op". String comparisons (==/!=/=~) do NOT
    // trigger arithmetic eval — `[[ 'a[x]' == y ]]` is a literal string cmp.
    if (name === '[[') {
      // i starts at 2: a[0]='[[' (contains '['), a[1] is the first real
      // operand. A binary op can't appear before index 2.
      for (let i = 2; i < a.length; i++) {
        if (!TEST_ARITH_CMP_OPS.has(a[i]!)) continue
        if (a[i - 1]?.includes('[') || a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'[[ ... ${a[i]} ... ]]' operand contains array subscript — bash arithmetically evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // SECURITY: `read`/`unset` treat EVERY bare positional as a NAME —
    // no flag needed. `read 'a[$(id)]' <<< data` executes id even though
    // argv[1] arrived from a single-quoted raw_string and no -a flag is
    // present. Same primitive as SUBSCRIPT_EVAL_FLAGS but the trigger is
    // positional, not flag-gated. Skip operands of read's data-taking
    // flags (-p PROMPT etc.) to avoid blocking `read -p '[foo] ' var`.
    if (BARE_SUBSCRIPT_NAME_BUILTINS.has(name)) {
      let skipNext = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        if (skipNext) {
          skipNext = false
          continue
        }
        if (arg[0] === '-') {
          if (name === 'read') {
            if (READ_DATA_FLAGS.has(arg)) {
              skipNext = true
            } else if (arg.length > 2 && arg[1] !== '-') {
              // Combined short flag like `-rp`. Getopt-style: first
              // data-flag char consumes rest-of-arg as its operand
              // (`-p[foo]` → prompt=`[foo]`), or next-arg if last
              // (`-rp '[foo]'` → prompt=`[foo]`). So skipNext iff a
              // data-flag char appears at the END after only no-arg
              // flags like `-r`/`-s`.
              for (let j = 1; j < arg.length; j++) {
                if (READ_DATA_FLAGS.has('-' + arg[j])) {
                  if (j === arg.length - 1) skipNext = true
                  break
                }
              }
            }
          }
          continue
        }
        if (arg.includes('[')) {
          return {
            ok: false,
            reason: `'${name}' positional NAME '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // `jobs -x cmd` (or +x) runs cmd in each job's context — what it starts
    // is only resolved at runtime. Official v288 (@203559309): any arg
    // matching /^[+-].*x/ trips the check. Reason verbatim.
    if (name === 'jobs') {
      for (let i = 1; i < a.length; i++) {
        if (/^[+-].*x/.test(a[i]!)) {
          return {
            ok: false,
            reason: "What 'jobs -x' starts can't be checked before it runs",
          }
        }
      }
    }

    // SECURITY: Shell reserved keywords as argv[0] indicate a tree-sitter
    // mis-parse. `! for i in a; do :; done` parses as `command "for i in a"`
    // + `command "do :"` + `command "done"` — tree-sitter fails to recognize
    // `for` after `!` as a compound command start. Reject: keywords can never
    // be legitimate command names, and argv like ['do','false'] is nonsense.
    if (SHELL_KEYWORDS.has(name)) {
      return {
        ok: false,
        reason: `Shell keyword '${name}' as command name — tree-sitter mis-parse`,
      }
    }

    // Post-xargs-strip checks (official v288 @203559521/@203559787, gated
    // on the `s` flag set when `xargs` was stripped above).
    // - `xargs find`/`xargs jq`: xargs APPENDS runtime-determined paths to
    //   the program's argv — find's -exec/-delete and jq's file reads then
    //   operate on unchecked input. Reason verbatim.
    // - `xargs awk...`: scan for program text (a non-flag operand, or
    //   anything after `--`, skipping -F/-v/-W/--fie*/-a/--as* operands).
    //   No program text means awk would read its program from the piped
    //   input at runtime. Reason verbatim.
    if (viaXargs) {
      if (name === 'find' || name === 'jq') {
        return {
          ok: false,
          reason: `What xargs adds to ${name} can't be checked before it runs`,
        }
      }
      if (AWK_FAMILY.has(name)) {
        let hasProgramText = false
        for (let i = 1; i < a.length; i++) {
          const arg = a[i]!
          if (arg === '--') {
            hasProgramText = i + 1 < a.length
            break
          }
          if (arg === '-' || !arg.startsWith('-')) {
            hasProgramText = true
            break
          }
          if (!arg.includes('=') && AWK_NEXT_ARG_OPTION_RE.test(arg)) i++
        }
        if (!hasProgramText) {
          return {
            ok: false,
            reason: `The program xargs gives ${name} can't be checked before it runs`,
          }
        }
      }
    }

    // Check argv (not .text) to catch both single-quote (`'\n#'`) and
    // double-quote (`"\n#"`) variants. Env vars and redirects are also
    // part of the .text span so the same downstream bug applies.
    // Heredoc bodies are excluded from argv so markdown `##` headers
    // don't trigger this.
    // TODO: remove once downstream path validation operates on argv.
    for (const arg of cmd.argv) {
      if (arg.includes('\n') && NEWLINE_HASH_RE.test(arg)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a quoted argument can hide arguments from path validation',
        }
      }
    }
    for (const ev of cmd.envVars) {
      if (ev.value.includes('\n') && NEWLINE_HASH_RE.test(ev.value)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside an env var value can hide arguments from path validation',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('\n') && NEWLINE_HASH_RE.test(r.target)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a redirect target can hide arguments from path validation',
        }
      }
    }

    // jq's system() built-in executes arbitrary shell commands, and flags
    // like --from-file can read arbitrary files into jq variables. On the
    // legacy path these are caught by validateJqCommand in bashSecurity.ts,
    // but that validator is gated behind `astSubcommands === null` and
    // never runs when the AST parse succeeds. Mirror the checks here so
    // the AST path has the same defence.
    if (name === 'jq') {
      for (const arg of a) {
        if (/\bsystem\s*\(/.test(arg)) {
          return {
            ok: false,
            reason:
              'jq command contains system() function which executes arbitrary commands',
          }
        }
      }
      if (
        a.some(arg =>
          /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
            arg,
          ),
        )
      ) {
        return {
          ok: false,
          reason:
            'jq command contains dangerous flags that could execute code or read arbitrary files',
        }
      }
    }

    // Awk-family program checks (official v288 @203560400-203560826). The
    // program text is an argument, so system()/pipes/@load inside it never
    // trip the command-name or substitution checks above.
    // CC 2.1.289/290: FIRST branch is the unquoted-glob gate — official
    // `if(Zve.has(a)){if(o.hasUnquotedGlob||r&&kAn(o))return{ok:!1,…}}`.
    // An unquoted glob in the source (or a resolved argv element the record
    // flags) can glob-expand to a planted program file or flag before awk
    // runs. Reason verbatim.
    if (AWK_FAMILY.has(name)) {
      if (
        cmd.hasUnquotedGlob ||
        (useGlobRecord && commandHasResolvableUnquotedGlob(cmd))
      ) {
        return {
          ok: false,
          reason:
            'awk command contains unquoted glob characters — could glob-expand to a planted program or flag before awk runs',
        }
      }
      for (const arg of a) {
        const programReason = inspectAwkProgram(arg)
        if (programReason !== false) {
          return { ok: false, reason: programReason }
        }
        if (containsPlaceholder(arg)) {
          // Reason: official v288 short form (@203560656), verbatim.
          return {
            ok: false,
            reason: "awk is given text that can't be checked before it runs",
          }
        }
      }
      if (
        a.some(
          arg =>
            /^-[bcCghIkMnNOPrsStV]*[fEileDW]/.test(arg) ||
            /^--(?:fil|e|i|lo|s|de)/.test(arg),
        )
      ) {
        // -f/-E/-i program-file and -D/-W debug options load text OCC never
        // sees. Reason: official v288 short form (@203560826), verbatim.
        return {
          ok: false,
          reason: "awk has an option that can't be checked before it runs",
        }
      }
    }

    // CC 2.1.290 find block — official `if(a==="find"){…}`, verbatim
    // structure. Iterates the STRIPPED argv (`n` in the official, `a` here)
    // from index 1; the gate itself reads the ORIGINAL command object (`o`)
    // so hasUnquotedGlob/kAn see the full source text and resolved argv.
    // The `prev` carry (`g`/`c` officially) tracks lt-form flags whose
    // value follows: the value still gets the zs/glob checks (official
    // `!g&&` guards), matching the binary exactly.
    if (name === 'find') {
      if (
        cmd.hasUnquotedGlob ||
        (useGlobRecord && commandHasResolvableUnquotedGlob(cmd))
      ) {
        return {
          ok: false,
          reason:
            'find contains unquoted glob characters — could glob-expand to a dangerous action before find runs',
        }
      }
      let prevWasValueFlag = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        const prev = prevWasValueFlag
        prevWasValueFlag = false
        if (findFlagIsAction(arg)) {
          return {
            ok: false,
            reason: `find with '${arg}' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule`,
          }
        }
        if (FIND_VERSION_DIVERGENT_OPTION_RE.test(arg)) {
          return {
            ok: false,
            reason: `find option '${arg}' is read differently by different versions of find — could hide a following action`,
          }
        }
        if (!prev && FIND_VALUE_TAKING_FLAG_RE.test(arg)) {
          prevWasValueFlag = true
          continue
        }
        if (!prev && findOptionTakesValue(arg)) {
          i++
          continue
        }
        if (containsAnyPlaceholder(arg)) {
          return {
            ok: false,
            reason:
              'find argument is runtime-determined — could resolve to a dangerous action',
          }
        }
        if (FIND_ARG_GLOB_RE.test(arg)) {
          return {
            ok: false,
            reason: `find argument '${arg}' contains glob characters — could glob-expand to a dangerous action`,
          }
        }
      }
    }

    if (ZSH_DANGEROUS_BUILTINS.has(name)) {
      return {
        ok: false,
        reason: `Zsh builtin '${name}' can bypass security checks`,
      }
    }

    if (EVAL_LIKE_BUILTINS.has(name)) {
      if (
        name === 'fc' &&
        !a.slice(1).some(arg => /^-[^-]*[es]/.test(arg))
      ) {
        // `fc -l`, `fc -ln` list history — safe. `fc -e ed` invokes an
        // editor then executes. `fc -s [pat=rep]` RE-EXECUTES the last
        // matching command (optionally with substitution) — as dangerous
        // as eval. Block any short-opt containing `e` or `s`.
        // to avoid introducing FPs for `fc -l` (list history).
      } else if (
        name === 'compgen' &&
        !a.slice(1).some(arg => /^-[^-]*[CFW]/.test(arg))
      ) {
        // `compgen -c/-f/-v` only list completions — safe. `compgen -C cmd`
        // immediately executes cmd; `-F func` calls a shell function; `-W list`
        // word-expands its argument (including $(cmd) even from single-quoted
        // raw_string). Block any short-opt containing C/F/W (case-sensitive:
        // -c/-f are safe).
      } else {
        return {
          ok: false,
          reason: `'${name}' evaluates arguments as shell code`,
        }
      }
    }

    // Process wrappers (watch/strace/nsenter/…): with at least one argument
    // they start another program whose argv OCC's permission matching never
    // sees (it matches argv[0]=the wrapper). Official v288 (@203561860):
    // `W4.has(a) && t.length>1` — bare `watch` with no args is inert.
    // Reason verbatim.
    if (PROCESS_WRAPPER_COMMANDS.has(name) && a.length > 1) {
      return {
        ok: false,
        reason: `What '${name}' starts can't be checked before it runs`,
      }
    }

    // /proc/*/environ exposes env vars (including secrets) of other processes.
    // Check argv and redirect targets — `cat /proc/self/environ` and
    // `cat < /proc/self/environ` both read it.
    for (const arg of cmd.argv) {
      if (arg.includes('/proc/') && PROC_ENVIRON_RE.test(arg)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('/proc/') && PROC_ENVIRON_RE.test(r.target)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
  }
  return { ok: true }
}
