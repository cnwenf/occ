import {
  checkSemantics,
  parseForSecurity,
  type ParseForSecurityResult,
  type SimpleCommand,
} from '../bash/ast.js'
import { getPlatform } from '../platform.js'

/**
 * CC 2.1.314 #94 — "macOS: `git grep` in Claude-run commands uses the C
 * locale" (regex memory-leak avoidance in Apple's git-grep under a UTF-8
 * locale).
 *
 * Faithful port of the official v314 mechanism, byte-verified against
 * scratch-occ138/v314/package/claude:
 *  - `ESn` (async decision fn) @256139513
 *  - `TSn`/`kwr` (wrapper function + install guard) @256139001
 *  - helper cluster `XC`/`JC`/`Lh`/`ju`/`QC`/`NKr`/`Fh`/`w2o` @251810800-251813000
 *  - `vSn` (single-quote wrap) @256140xxx, `_Vt` (eval guard) @250532471
 *  - preamble slot @256158096: pushed after the unsetenv cleanup (`eTr()`),
 *    awaited with the NORMALIZED command (`De=LSn(L)` — the `2>nul` →
 *    `2>/dev/null` rewrite; OCC: `normalizedCommand` in bashProvider.ts).
 *  - Absent from v312 (`function git { 'local'` → 0 hits; `case"gtimeout"` →
 *    0 hits vs 1 hit @251812249 in v314). NOT statsig-gated — the only
 *    platform gate is `M()!=="macos"`.
 *
 * The wrapper installs a `git` shell function (only when git is not already
 * a shell function or alias) that rewrites `git [global-opts] grep ...` into
 * `'/usr/bin/env' LC_ALL=C 'git' ...`, forcing the C locale for grep's regex
 * engine. Every other git invocation falls through to `'command' 'git'`.
 *
 * OCC parse-infra mapping (documented deviations, conservative direction):
 *  - Official `EN` also returns `bareAssignmentNames` and `hasLoop`; OCC's
 *    `parseForSecurity` has neither. Bare assignments are approximated
 *    conservatively (any command whose argv is empty or all-assignment
 *    tokens rejects the prefix), and `checkSemantics` is called without the
 *    official `{hasLoop}` option (OCC has no `Tt` declaration-builtin check
 *    at all — pre-existing gap, out of this cluster's scope).
 */

/** Official `ESn` gate: `e.length>1000` → null. */
export const GIT_GREP_LOCALE_COMMAND_LENGTH_LIMIT = 1000

/** Official `XC` — nice(1) adjustment option forms. */
const NICE_ADJUSTMENT_RE = /^(?:-n|-n?-?\d+|--adjustment(?:=.*)?)$/

/** Official `JC` — timeout(1) duration forms (dec/hex/inf + s/m/h/d suffix). */
const TIMEOUT_DURATION_RE =
  /^\+?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[\da-fA-F]+\.?[\da-fA-F]*|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)[smhd]?$/

/** Official `Lh` — exec(1) prefix options (`-a [name]`, `-c`, `-l`, combos). */
const EXEC_PREFIX_RE = /^-(?=[acl])[cl]*(?:a(.*))?$/

/** Official `ju` — a `VAR=`/`VAR[idx]=`/`VAR+=` assignment token. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

/** Official `QC` — git global options (used only inside `NKr`). */
const GIT_GLOBAL_PATH_OPTS = new Set([
  '--git-dir',
  '--separate-git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
])

/**
 * Official `NKr=new Set(["-C","-c","--attr-source","--shallow-file",...QC])`
 * @251811250 region — git global options whose value is the NEXT argv
 * element. INSERTION ORDER IS LOAD-BEARING: `[...NKr].join("|")` builds the
 * wrapper's `case` pattern (TSn element 5).
 */
const GIT_TWO_ARG_GLOBAL_OPTS = new Set([
  '-C',
  '-c',
  '--attr-source',
  '--shallow-file',
  ...GIT_GLOBAL_PATH_OPTS,
])

/**
 * Official tail gate in `ESn`: grep arguments that make the C-locale rewrite
 * unsafe/pointless — `-P`/`--perl-regexp`, `--paginate`, `--op*`,
 * `--textconv`, or any short cluster containing `O`, `P`, or `f`.
 */
const FORBIDDEN_GREP_OPTION_RE = /^(?:--p|--op|--textc|-[A-Za-z0-9]*[OPf])/

/** Official `Fh` — true when the word is a `git`/`git.exe` executable path. */
function isGitExecutablePath(word: string): boolean {
  return /(?:^|[\\/])git(?:\.exe)?$/.test(word)
}

/**
 * Official `w2o(e,n,r)` @251811250 region — wrapper-aware argv scanner.
 * Skips leading assignments and safe wrappers (noglob/nocorrect/builtin/
 * command/exec/nohup/time/nice/env/timeout/gtimeout) and returns the index of
 * the first word satisfying `predicate`.
 *
 * @param notFoundIsMinusOne official `n`: when true, exhaustion returns -1
 *   (instead of undefined) — `ESn` calls with `!0`.
 * @returns the matching word's index, -1 when a wrapper is malformed or the
 *   word fails the predicate, or `undefined` on exhaustion when
 *   `notFoundIsMinusOne` is false.
 */
export function findWrappedCommandIndex(
  argv: readonly string[],
  notFoundIsMinusOne: boolean,
  predicate: (word: string) => boolean,
): number | undefined {
  const notFound = notFoundIsMinusOne ? -1 : undefined
  let i = 0
  while (i < argv.length && ASSIGNMENT_RE.test(argv[i] ?? '')) i++
  while (i < argv.length) {
    const word = argv[i] ?? ''
    switch (word) {
      case 'noglob':
      case 'nocorrect':
        i++
        continue
      case 'builtin':
        i++
        if (argv[i] !== undefined && isGitExecutablePath(argv[i])) return -1
        continue
      case 'command':
        i++
        if (argv[i] === '-p') i++
        if (argv[i] === '--') i++
        continue
      case 'exec':
        i++
        for (
          let m = EXEC_PREFIX_RE.exec(argv[i] ?? '');
          m !== null;
          m = EXEC_PREFIX_RE.exec(argv[i] ?? '')
        )
          i += m[1] === '' ? 2 : 1
        if (argv[i] === '--') i++
        continue
      case 'nohup':
        i++
        if (argv[i] === '--') i++
        continue
      case 'time':
        i++
        if (argv[i] === '-p') i++
        if (argv[i] === '--') i++
        while (i < argv.length && ASSIGNMENT_RE.test(argv[i] ?? '')) i++
        continue
      case 'nice':
        i++
        for (let a = argv[i]; a !== undefined && NICE_ADJUSTMENT_RE.test(a); a = argv[i])
          i += a === '-n' || a === '--adjustment' ? 2 : 1
        if (argv[i] === '--') i++
        continue
      case 'env':
        i++
        while (
          argv[i] === '-i' ||
          argv[i] === '-' ||
          argv[i] === '--ignore-environment'
        )
          i++
        if (argv[i] === '--') i++
        while (i < argv.length && /^[^-=][^=]*=/.test(argv[i] ?? '')) i++
        if (argv[i]?.startsWith('-') === true) return -1
        continue
      case 'timeout':
      case 'gtimeout': {
        i++
        while (i < argv.length && (argv[i] ?? '').startsWith('-')) {
          const flag = argv[i] ?? ''
          if (flag === '--') {
            i++
            break
          }
          if (
            flag === '-k' ||
            flag === '-s' ||
            flag === '--kill-after' ||
            flag === '--signal'
          )
            i += 2
          else if (
            flag === '--preserve-status' ||
            flag === '--foreground' ||
            flag === '-v' ||
            flag === '--verbose' ||
            flag.startsWith('--kill-after=') ||
            flag.startsWith('--signal=') ||
            /^-[ks]\S+$/.test(flag)
          )
            i++
          else return -1
        }
        const duration = argv[i]
        if (duration === undefined) return notFound
        if (!TIMEOUT_DURATION_RE.test(duration)) return -1
        i++
        continue
      }
      default:
        return predicate(word) ? i : -1
    }
  }
  return notFound
}

/** Official `vSn(e){return`'${e.replaceAll("'","'\\''")}'`}`. */
function singleQuoteWrap(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Official `_Vt(e){return`'eval' '${e.replaceAll("'","'\\''")}' 2>/dev/null || 'true'`}` @250532471. */
function evalGuard(value: string): string {
  return `'eval' ${singleQuoteWrap(value)} 2>/dev/null || 'true'`
}

/**
 * Official `TSn` @256139001 — the `git` wrapper function definition, joined
 * with single spaces. Byte-exact (element 5 is `[...NKr].join("|")`).
 */
export const GIT_GREP_WRAPPER_FUNCTION = [
  "function git { 'local' _cc_skip= _cc_word;",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the ported wrapper text, not a JS template placeholder.
  'for _cc_word in ${1+"$@"}; do',
  'if [ -n "$_cc_skip" ]; then _cc_skip=; continue; fi;',
  'case "$_cc_word" in',
  `${[...GIT_TWO_ARG_GLOBAL_OPTS].join('|')}) _cc_skip=1 ;;`,
  '-*) ;;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the ported wrapper text, not a JS template placeholder.
  "grep) '/usr/bin/env' LC_ALL=C 'git' ${1+\"$@\"}; 'return' ;;",
  '*) break ;;',
  'esac; done;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the ported wrapper text, not a JS template placeholder.
  "'command' 'git' ${1+\"$@\"}; }",
].join(' ')

/**
 * Official `kwr` @256139001 — installs the wrapper only when `git` is not
 * already a shell function or alias (never clobbers user-defined gits), with
 * a dry-run eval in a subshell as a syntax sanity check.
 */
export const GIT_GREP_WRAPPER_INSTALL_GUARD = [
  "if ! 'typeset' -f 'git' >/dev/null 2>&1 && ! 'alias' 'git' >/dev/null 2>&1 &&",
  `( 'eval' ${singleQuoteWrap(GIT_GREP_WRAPPER_FUNCTION)} ) >/dev/null 2>&1;`,
  `then 'eval' ${singleQuoteWrap(GIT_GREP_WRAPPER_FUNCTION)}; fi`,
].join(' ')

/**
 * Official conservative equivalent of the `bareAssignmentNames.length>0`
 * gate: OCC's parser has no bareAssignmentNames field, so reject when any
 * simple command has an empty argv (pure `VAR=val` statement) or every argv
 * token is an assignment. Direction of the deviation: rejects a strict
 * superset — never installs the wrapper where the official wouldn't.
 */
function hasBareAssignmentCommand(commands: SimpleCommand[]): boolean {
  return commands.some(
    cmd =>
      cmd.argv.length === 0 ||
      cmd.argv.every(word => ASSIGNMENT_RE.test(word)),
  )
}

/**
 * Official `ESn(e)` @256139513 — returns the shell preamble part
 * `{ ${_Vt(kwr)}; }` when `command` is a safe macOS `git grep` invocation,
 * else null. Call with the NORMALIZED command (official `De=LSn(L)`).
 */
export async function buildGitGrepLocalePrefix(
  command: string,
): Promise<string | null> {
  if (getPlatform() !== 'macos') return null
  if (!command.includes('git') || !command.includes('grep')) return null
  if (command.length > GIT_GREP_LOCALE_COMMAND_LENGTH_LIMIT) return null
  if (/[\u0080-\uFFFF]/.test(command)) return null
  let parsed: ParseForSecurityResult | undefined
  try {
    parsed = await parseForSecurity(command)
  } catch {
    // Official: `await EN(e).catch(()=>{return})` → undefined → null below.
    return null
  }
  if (parsed?.kind !== 'simple') return null
  // Official: `!yst(n.commands,{hasLoop:n.hasLoop}).ok` — OCC has no hasLoop
  // option (see header note).
  if (!checkSemantics(parsed.commands).ok) return null
  if (hasBareAssignmentCommand(parsed.commands)) return null
  if (parsed.commands.some(({ envVars }) => envVars.length > 0)) return null
  const grepArgLists = parsed.commands.flatMap(({ argv }) => {
    const gitIndex = findWrappedCommandIndex(
      argv,
      true,
      (word: string) => word === 'git',
    )
    if (gitIndex === undefined || gitIndex === -1) return []
    let y = gitIndex + 1
    while (argv[y]?.startsWith('-') === true)
      y += GIT_TWO_ARG_GLOBAL_OPTS.has(argv[y] as string) ? 2 : 1
    return argv[y] === 'grep' ? [argv.slice(y + 1)] : []
  })
  if (grepArgLists.length === 0) return null
  if (grepArgLists.flat().some(arg => FORBIDDEN_GREP_OPTION_RE.test(arg)))
    return null
  return `{ ${evalGuard(GIT_GREP_WRAPPER_INSTALL_GUARD)}; }`
}
