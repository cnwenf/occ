/**
 * CC 2.1.288 changelog #54 (anthropics/claude-code#96300) — dangerous rm
 * inside an inline `bash -c` / `sh -c` script must never run without a
 * prompt, including under bypassPermissions or a shell allow rule.
 *
 * Official v2.1.288 subsystem (byte-verified against the linux-x64 ELF
 * dumps in /tmp/cc-diff-288: `pue`, `ZYt`, `DYt`, `C4o`, `uue`, `A4o`):
 * - `pue` gate: kill-switch CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT
 *   (RAW truthiness — any non-empty value including "0" disables).
 * - `C4o` extractor: argv0 after safe(`Rp`)/privilege(`aFt`) wrapper
 *   stripping must match /^(?:r?ba)?sh$/ (sh/bash/rsh/rbash — NOT zsh/ksh),
 *   busybox/toybox applet prefixes allowed; a `-c` flag (or combined short
 *   cluster containing c, e.g. `-lc`) selects the script argument; the
 *   long-flag whitelist is login/posix/noprofile/norc/noediting/verbose/
 *   restricted/debugger/dump-(po-)strings/wordexp/pretty-print/help/version
 *   plus value-taking rcfile/init-file.
 * - `ZYt`/`DYt` walker: resolves safe-literal assignments (/^[\w./@%+=:,-]*$/),
 *   rebuilds the script and re-judges it through the standard dangerous-rm
 *   checker `o4t` (recursion depth cap `P4o` = 8, telemetry
 *   uL("inline_shell_script")); unresolvable values become the
 *   `__INLINE_SHELL_VALUE__` sentinel and trigger the `A4o` runtime-target
 *   rewrite; unreadable constructs (eval/trap/source/`.`, read/declare/
 *   printf -v taint, ANSI-C `$'…\x…'` escapes, `$((`, `${!x}`) force the
 *   `uue` unchecked ask (uL("inline_shell_unchecked")).
 * - Verdicts carry decisionReason {type:'safetyCheck',
 *   classifierApprovable:!1, circuitBreaker:'dangerousRemoval'} so no
 *   permission rule, mode, or auto-classifier can approve them.
 *
 * OCC approximation (documented divergences — fail-safe direction per the
 * #54 port contract):
 * 1. String-level extractor (a quote-aware raw segmenter that keeps segment
 *    text verbatim — splitCommand_DEPRECATED's shell-quote round-trip
 *    re-serializes nested quotes and would break nested `bash -c` — plus
 *    the OCC 281-family quote-aware tokenizer/wrapper strippers) instead of
 *    tree-sitter, in line with OCC's whole dangerous-rm family.
 * 2. Script re-judgment = existing findCatastrophicSubstitutionBlock on the
 *    UNQUOTED script text, plus a runtime-value target scan (unresolved
 *    variable / command-substitution targets → verbatim `A4o` text) and a
 *    lexical traversal/tilde literal scan.
 * 3. Where the official emits `o4t`'s standard dangerous-rm wording for a
 *    judged-dangerous literal that OCC's detectors do not word (e.g. the
 *    traversal-resolved /etc from `rm -rf /tmp/../../etc`), this module
 *    uses the verbatim `uue` "could not check" text rather than inventing
 *    new wording — same circuitBreaker, still non-approvable.
 * 4. Blocks are consumed by bashPermissions.ts as deny-in-all-modes through
 *    the established dangerousRmAutoDeny resolver ($0t envelope) instead of
 *    the official ask — the established OCC divergence for this family,
 *    strictly stronger than ask.
 * 5. The `uue` rule-denied arm (first arg truthy) needs the official's
 *    inner rule-matching context (I4o/PC); OCC's pure detector cannot reach
 *    it, so the constants are staged verbatim for future wiring.
 * 6. Unreadable-construct handling fires `uue` for the whole script when
 *    ANY taint marker is present; the official may instead emit `A4o` when
 *    the tainted value flows into a parseable rm target. Both are
 *    non-approvable dangerousRemoval verdicts.
 * 7. Command-position words are resolved through the persisted assignment
 *    map before the rm-verb test (`x=rm; $x -rf /` ≡ `rm -rf /` — the
 *    official ZYt/DYt sentinel re-judgment applied at the verb position,
 *    closing the verb-indirection bypass). Unresolvable verb forms (an
 *    unmapped name, the Kk null sentinel, `$(…)`/backtick substitution,
 *    special params) yield a runtime verb: the `A4o` block fires only when
 *    the segment ALSO carries a dangerous rm-shaped target, bounding the
 *    deny-in-all-modes over-firing against non-rm runtime commands
 *    (`$LOGCMD done` stays allowed; `$LOGCMD -rf /` blocks).
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the official A4o message contains a literal bash `${NAME:?}` guard idiom, not a JS template placeholder.

import { homedir } from 'node:os'
import { posix as posixPath } from 'node:path'
import { isDangerousRemovalPath } from '../../utils/permissions/pathValidation.js'
import {
  ARGV_BASENAME_RE,
  type CatastrophicSubstitutionBlock,
  findCatastrophicSubstitutionBlock,
  stripPrivilegeWrapperArgv,
  stripSafeWrapperArgv,
  tokenizeNormalizedSegment,
} from './destructiveCommandWarning.js'

// ── Official constants ──────────────────────────────────────────────────

/**
 * Official `pue` kill-switch. RAW truthiness (deliberately NOT
 * isEnvTruthy): any non-empty value — including "0" — disables the guard,
 * matching `if(a.CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT||!h4())return
 * null` in the 2.1.288 binary. Same convention as
 * DANGEROUS_RM_TIMEOUT_KILL_SWITCH_ENV_VAR in dangerousRmAutoDeny.ts.
 */
export const INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR =
  'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT'

/** Official `P4o` — inline-shell re-judgment recursion depth cap. */
const MAX_INLINE_SHELL_DEPTH = 8

/** Official `C4o` shell argv0 set: sh, bash, rsh, rbash. */
const SHELL_ARGV0_RE = /^(?:r?ba)?sh$/

/** Official `C4o` applet prefixes handled before the shell-name match. */
const BUSYBOX_ARGV0_RE = /^(?:busybox|toybox)$/

/** Official combined short-flag test `/^-[A-Za-z]*c[A-Za-z]*$/` (e.g. -c, -lc). */
const COMBINED_C_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/

/** Official `C4o` long flags that take NO value. */
const SHELL_LONG_NOVALUE_FLAG_RE =
  /^--?(?:login|posix|noprofile|norc|noediting|verbose|restricted|debugger|dump-(?:po-)?strings|wordexp|pretty-print|help|version)$/

/** Official `C4o` long flags that consume the next argument. */
const SHELL_LONG_VALUE_FLAG_RE = /^--?(?:rcfile|init-file)$/

/** rm-family verb gate (matches the OCC 281-family `cue` approximation). */
const RM_VERB_RE = /\brm(?:dir)?\b/

/** Official `be()` eval-family segment marker. */
const EVAL_FAMILY_RE = /\b(?:eval|trap|source)\b|(?:^|\s)\.\s/

/** Official `be()` unreadable-construct marker (verbatim regex). */
const UNREADABLE_CONSTRUCT_RE =
  /\beval\b|\bprintf\b[^;&|\n]*\s-v|\b(?:read|declare|typeset|local|export|readonly|mapfile|readarray|getopts)\b[^;&|\n]*\$|\b(?:declare|typeset|local)\b[^;&|\n]*\s-\w*n|\$\{!?[A-Za-z_]\w*:{0,2}=|\$\(\(/

/** Official `be()` unquoted-text taint marker (verbatim regex). */
const UNREADABLE_UNQUOTED_RE =
  /\bprintf\b[^;&|\n]*\s-v|\b(?:unset|export|declare|typeset|local|readonly)\b[^;&|\n]*\$/

/** Official ANSI-C escape bail `/\$'[^']*\\[xuUc0-7]/` (verbatim). */
const ANSI_C_HEX_ESCAPE_RE = /\$'[^']*\\[xuUc0-7]/

/** Official `${NAME:?}` guard idiom (the A4o text's own escape hatch). */
const GUARDED_EXPANSION_RE = /^\$\{[A-Za-z_]\w*:\?/

/** Official `$t` safe-literal assignment value (verbatim). */
const SAFE_LITERAL_VALUE_RE = /^[\w./@%+=:,-]*$/

/** Shell assignment token `NAME=value`. */
const ASSIGNMENT_TOKEN_RE = /^([A-Za-z_]\w*)=(.*)$/

// ── Official verbatim messages (2.1.288 ELF, `A4o` and `uue`) ──────────

/** Official `A4o` runtime-target message (verbatim). */
export const INLINE_SHELL_RUNTIME_TARGET_MESSAGE =
  'Dangerous rm operation in a shell -c script: its target is built from a variable or command output known only when it runs, and if that is empty the rm can reach a directory like / or your home directory. This requires explicit approval and cannot be auto-allowed by permission rules. Pass a literal path, or guard the value with ${NAME:?}.'

/** Official `A4o` runtime-target decisionReason text (verbatim). */
export const INLINE_SHELL_RUNTIME_TARGET_REASON =
  'Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs'

/** Official `uue` unchecked-script message, e=false arm (verbatim). */
export const INLINE_SHELL_UNCHECKED_MESSAGE =
  'This command passes a shell -c script that runs rm, and Claude Code could not check the script for dangerous removals. Approve only if you have read the script.'

/** Official `uue` unchecked-script decisionReason text, e=false arm (verbatim). */
export const INLINE_SHELL_UNCHECKED_REASON =
  'This shell -c script runs rm and could not be checked'

/**
 * Official `uue` rule-denied message, e=true arm (verbatim). STAGED: the
 * arm needs the official's inner rule-matching context (a permission rule
 * denying a command inside the script); OCC's pure detector cannot reach
 * it — see divergence note 5 in the file header.
 */
export const INLINE_SHELL_RULE_DENIED_MESSAGE =
  'A permission rule denies a command inside this shell -c script, so Claude Code could not check it for dangerous removals. Approving runs the whole script, including that command.'

/** Official `uue` rule-denied decisionReason text, e=true arm (verbatim, staged). */
export const INLINE_SHELL_RULE_DENIED_REASON =
  'A permission rule denies a command in this shell -c script'

// ── Types ───────────────────────────────────────────────────────────────

/** Telemetry discriminator: which official uL() event the block maps to. */
export type InlineShellRmKind = 'inline_shell_script' | 'inline_shell_unchecked'

/** Which analysis pass produced the block. */
export type InlineShellRmCategory =
  | 'inlineShellRuntimeTarget'
  | 'inlineShellDetectorTarget'
  | 'inlineShellUnchecked'

/** A dangerous-rm verdict for an inline shell `-c` script. */
export type InlineShellRmBlock = {
  readonly category: InlineShellRmCategory
  readonly kind: InlineShellRmKind
  /** Short decisionReason text (official A4o/uue reason strings). */
  readonly reason: string
  /** User-facing flagged text (official A4o/uue/detector wording). */
  readonly message: string
}

/** One extracted inline shell `-c` script. */
export type InlineShellScript = {
  readonly script: string
  /** Raw segment contained an ANSI-C `$'…'` quote (official Ot flag). */
  readonly ansiCQuoted: boolean
  /** Raw segment matches the official ANSI-C hex-escape bail regex. */
  readonly ansiCHexEscaped: boolean
}

/** Per-target classification result. */
type TargetVerdict = 'safe' | 'runtime' | 'literalDanger'

/**
 * Command verb resolved from one script segment. `runtime` = the verb-position
 * word is not statically resolvable (unmapped variable, official `Kk` null
 * sentinel, command substitution, or special parameter) — the segment MAY be
 * an rm, so its targets still get judged (divergence note 7).
 */
type ResolvedVerb =
  | {
      readonly kind: 'literal'
      readonly verb: 'rm' | 'rmdir'
      readonly args: readonly string[]
    }
  | { readonly kind: 'runtime'; readonly args: readonly string[] }

// Assignment map: name → safe literal value, or null when the assignment
// exists but is not statically resolvable (official `Kk` sentinel).
type AssignmentMap = ReadonlyMap<string, string | null>

// ── Verdict builders ────────────────────────────────────────────────────

function runtimeTargetBlock(): InlineShellRmBlock {
  return {
    category: 'inlineShellRuntimeTarget',
    kind: 'inline_shell_script',
    reason: INLINE_SHELL_RUNTIME_TARGET_REASON,
    message: INLINE_SHELL_RUNTIME_TARGET_MESSAGE,
  }
}

function uncheckedBlock(): InlineShellRmBlock {
  return {
    category: 'inlineShellUnchecked',
    kind: 'inline_shell_unchecked',
    reason: INLINE_SHELL_UNCHECKED_REASON,
    message: INLINE_SHELL_UNCHECKED_MESSAGE,
  }
}

/**
 * Detector kinds whose targets are built from runtime values — the official
 * `A4o` rewrite fires for these (their reasons carry the __CMDSUB /
 * __INLINE_SHELL_VALUE__ sentinels in the binary).
 */
const RUNTIME_DETECTOR_KINDS: ReadonlySet<string> = new Set([
  'wholeSubstitution',
  'emptyExpansion',
  'emptyVariable',
])

function detectorBlock(sub: CatastrophicSubstitutionBlock): InlineShellRmBlock {
  if (RUNTIME_DETECTOR_KINDS.has(sub.kind)) return runtimeTargetBlock()
  // Non-runtime detector verdicts pass their official 281-family wording
  // through unchanged (the official A4o rewriter leaves them alone). The
  // fallback envelope matches the established bashPermissions convention.
  return {
    category: 'inlineShellDetectorTarget',
    kind: 'inline_shell_script',
    reason: sub.decisionReason ?? sub.reason,
    message: sub.message ?? `Destructive command blocked: ${sub.reason}`,
  }
}

// ── Kill switch (official `pue` gate) ───────────────────────────────────

/** True when the guard is disabled via the official kill-switch env var. */
export function inlineShellRmKillSwitchActive(): boolean {
  return Boolean(process.env[INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR])
}

// ── Extractor (official `C4o`) ──────────────────────────────────────────

/**
 * Quote-aware raw segmenter (mirrors the observable contract of the official
 * `wd` raw parse: segment TEXT stays verbatim). splitCommand_DEPRECATED is
 * deliberately NOT used here — its shell-quote round-trip re-serializes
 * nested quotes (`'rm -rf /'` → `''rm -rf /''`), which breaks nested `bash
 * -c` extraction. Splits on unquoted `;`, newline, `|`, and `&`; quote runs
 * use the same raw-scan semantics as tokenizeNormalizedSegment (no
 * backslash escapes inside quotes; backslash escapes the next char outside).
 */
function splitRawCommandSegments(text: string): readonly string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') {
      current += ch
      if (i + 1 < text.length) {
        current += text[i + 1]!
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++
      if (current.trim() !== '') segments.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') segments.push(current.trim())
  return segments
}

/**
 * Extract every inline shell `-c` script from a command line. Returns an
 * empty list when no segment is a recognizable shell invocation.
 */
export function extractInlineShellScripts(
  command: string,
): readonly InlineShellScript[] {
  const scripts: InlineShellScript[] = []
  for (const rawSegment of splitRawCommandSegments(command)) {
    const extracted = extractFromSegment(rawSegment)
    if (extracted !== null) scripts.push(extracted)
  }
  return scripts
}

function extractFromSegment(rawSegment: string): InlineShellScript | null {
  const tokens = tokenizeNormalizedSegment(rawSegment.trim())
  if (tokens.length === 0) return null
  const argv = [tokens[0]!.replace(ARGV_BASENAME_RE, ''), ...tokens.slice(1)]
  let stripped = stripPrivilegeWrapperArgv(stripSafeWrapperArgv(argv))
  while (
    stripped.length > 0 &&
    BUSYBOX_ARGV0_RE.test(stripped[0]!.replace(ARGV_BASENAME_RE, ''))
  ) {
    stripped = stripped.slice(1)
  }
  if (stripped.length === 0) return null
  if (!SHELL_ARGV0_RE.test(stripped[0]!.replace(ARGV_BASENAME_RE, ''))) {
    return null
  }
  const scriptIndex = findDashCScriptIndex(stripped)
  if (scriptIndex === null) return null
  const script = stripped[scriptIndex]
  if (script === undefined) return null
  return {
    script,
    ansiCQuoted: /\$'/.test(rawSegment),
    ansiCHexEscaped: ANSI_C_HEX_ESCAPE_RE.test(rawSegment),
  }
}

/**
 * Locate the script argument of a `-c`-style shell invocation. Returns the
 * index into `stripped`, or null when the argv cannot be judged (unknown
 * long flag, positional file argument before any -c, or missing script).
 */
function findDashCScriptIndex(stripped: readonly string[]): number | null {
  for (let i = 1; i < stripped.length; i++) {
    const tok = stripped[i]!
    // `--` ends option parsing; a bare `-` means stdin; a positional means
    // bash runs a script FILE and any later -c is not a script argument.
    if (tok === '--' || tok === '-' || !tok.startsWith('-')) return null
    if (SHELL_LONG_VALUE_FLAG_RE.test(tok)) {
      i++
      continue
    }
    if (SHELL_LONG_NOVALUE_FLAG_RE.test(tok)) continue
    if (tok.startsWith('--')) return null
    if (COMBINED_C_FLAG_RE.test(tok)) return i + 1
  }
  return null
}

// ── Analysis (official `ZYt`/`DYt`/`uue`/`A4o` approximation) ──────────

/**
 * Main entry: detect a dangerous rm inside any inline shell `-c` script of
 * the command. Returns the first verdict, or null when nothing is flagged
 * (including when the kill-switch is active).
 */
export function findDangerousInlineShellRm(
  command: string,
): InlineShellRmBlock | null {
  if (inlineShellRmKillSwitchActive()) return null
  for (const entry of extractInlineShellScripts(command)) {
    const block = analyzeInlineShellScript(entry, 0)
    if (block !== null) return block
  }
  return null
}

function analyzeInlineShellScript(
  entry: InlineShellScript,
  depth: number,
): InlineShellRmBlock | null {
  const { script } = entry
  // Official ANSI-C bail: hex-escaped $'…' fires even without a visible rm;
  // a plain $'…' fires when an rm survives the \n\t\r unescape.
  if (entry.ansiCHexEscaped) return uncheckedBlock()
  if (entry.ansiCQuoted && RM_VERB_RE.test(script.replace(/\\[ntr]/g, '\n'))) {
    return uncheckedBlock()
  }
  if (!RM_VERB_RE.test(script)) return null
  // Official `P4o` depth cap: rm present but recursion exhausted → uue.
  if (depth >= MAX_INLINE_SHELL_DEPTH) return uncheckedBlock()
  // Official `be()` taint: unreadable constructs → Ze → uue.
  if (isScriptUnreadable(script)) return uncheckedBlock()
  // Pass B: the existing OCC detectors re-judge the UNQUOTED script text.
  const detector = findCatastrophicSubstitutionBlock(script)
  if (detector !== null) return detectorBlock(detector)
  // Passes A+C: per-target classification (runtime values → A4o; literal
  // targets resolved through traversal/tilde/glob → uue when dangerous).
  const target = findDangerousTargetBlock(script)
  if (target !== null) return target
  // Nested `bash -c` inside the script (official ZYt recursion).
  for (const nested of extractInlineShellScripts(script)) {
    const block = analyzeInlineShellScript(nested, depth + 1)
    if (block !== null) return block
  }
  return null
}

function isScriptUnreadable(script: string): boolean {
  if (EVAL_FAMILY_RE.test(script)) return true
  if (UNREADABLE_CONSTRUCT_RE.test(script)) return true
  return UNREADABLE_UNQUOTED_RE.test(script.replace(/["'\\]/g, ''))
}

// ── Target scan (official `DYt` variable-resolution approximation) ──────

function findDangerousTargetBlock(script: string): InlineShellRmBlock | null {
  let persisted: AssignmentMap = new Map()
  for (const rawSegment of splitRawCommandSegments(script)) {
    const tokens = tokenizeNormalizedSegment(rawSegment.trim())
    if (tokens.length === 0) continue
    const prefix = takePrefixAssignments(tokens)
    // Prefix assignments AND the ones persisted from earlier standalone
    // assignment segments both scope this segment's verb + target resolution
    // (divergence note 7: the verb word goes through the same sentinel
    // re-judgment as leading-`$` targets).
    const effective = mergeAssignments(persisted, prefix.map)
    const verb = resolveCommandVerb(tokens.slice(prefix.count), effective)
    if (verb === null) {
      // Standalone assignment segments persist (official ye list); prefix
      // assignments on a verb segment are scoped to that segment only.
      if (prefix.map.size > 0 && prefix.count === tokens.length) {
        persisted = mergeAssignments(persisted, prefix.map)
      }
      continue
    }
    for (const target of collectRmTargets(verb.args)) {
      const verdict = classifyTarget(target, effective)
      if (verdict === 'runtime') return runtimeTargetBlock()
      if (verdict === 'literalDanger') {
        // An unresolvable runtime verb next to a dangerous target is the
        // official A4o sentinel re-judgment: the actual command is known only
        // when it runs, so it cannot be promised NOT to be an rm on it.
        return verb.kind === 'runtime' ? runtimeTargetBlock() : uncheckedBlock()
      }
    }
  }
  return null
}

function takePrefixAssignments(tokens: readonly string[]): {
  readonly map: AssignmentMap
  readonly count: number
} {
  let map: AssignmentMap = new Map()
  let count = 0
  for (const token of tokens) {
    const match = ASSIGNMENT_TOKEN_RE.exec(token)
    if (match === null) break
    const value = match[2]!
    // Official `$t`: values outside /^[\w./@%+=:,-]*$/ resolve to the Kk
    // sentinel (represented here as null = unresolvable).
    map = new Map([
      ...map,
      [match[1]!, SAFE_LITERAL_VALUE_RE.test(value) ? value : null],
    ])
    count++
  }
  return { map, count }
}

function mergeAssignments(base: AssignmentMap, overlay: AssignmentMap): AssignmentMap {
  if (overlay.size === 0) return base
  return new Map([...base, ...overlay])
}

function resolveCommandVerb(
  tokens: readonly string[],
  assignments: AssignmentMap,
): ResolvedVerb | null {
  if (tokens.length === 0) return null
  const argv = [tokens[0]!.replace(ARGV_BASENAME_RE, ''), ...tokens.slice(1)]
  const stripped = stripPrivilegeWrapperArgv(stripSafeWrapperArgv(argv))
  const verbWord = stripped[0]
  if (verbWord === undefined) return null
  const args = stripped.slice(1)
  const resolved = resolveVerbWord(verbWord, assignments)
  if (resolved.status === 'runtime') return { kind: 'runtime', args }
  if (resolved.value !== 'rm' && resolved.value !== 'rmdir') return null
  return { kind: 'literal', verb: resolved.value, args }
}

/**
 * Resolve a single command-position word (official ZYt/DYt sentinel
 * re-judgment at the verb position — the `r=rm; $r -rf /` bypass fix):
 * - `$(` or a backtick anywhere in the word → runtime (known only when it
 *   runs; the quote-stripping tokenizer delivers `"$(echo rm)"` as
 *   `$(echo rm)`).
 * - A leading named-variable expansion resolves through the assignment map;
 *   a safe-literal value re-joins the remainder (`${x}dir` → value+`dir`).
 *   An unmapped name or the Kk null sentinel → runtime.
 * - Any other leading `$` (special params `$@`, `$1`, `$?`, …) → runtime.
 * - A plain word → itself, literal.
 */
function resolveVerbWord(
  word: string,
  assignments: AssignmentMap,
):
  | { readonly status: 'literal'; readonly value: string }
  | { readonly status: 'runtime' } {
  if (word.includes('$(') || word.includes('`')) return { status: 'runtime' }
  const resolved = resolveLeadingVariable(word, assignments)
  if (resolved !== null) {
    const { value, remainder } = resolved
    if (remainder.includes('$') || remainder.includes('`')) {
      return { status: 'runtime' }
    }
    return { status: 'literal', value: value + remainder }
  }
  if (word.startsWith('$')) return { status: 'runtime' }
  return { status: 'literal', value: word }
}

function collectRmTargets(args: readonly string[]): readonly string[] {
  const targets: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      targets.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) continue
    targets.push(arg)
  }
  return targets
}

function classifyTarget(target: string, assignments: AssignmentMap): TargetVerdict {
  if (target === '') return 'safe'
  // Official guard idiom — the A4o message's own recommended escape hatch.
  if (GUARDED_EXPANSION_RE.test(target)) return 'safe'
  // Command substitution in leading position → official __CMDSUB__ sentinel.
  if (target.startsWith('`') || target.startsWith('$(')) return 'runtime'
  if (target.startsWith('$')) {
    const resolved = resolveLeadingVariable(target, assignments)
    if (resolved !== null) {
      return classifyResolvedLiteral(resolved.value, resolved.remainder)
    }
    // Unresolved leading expansion: dangerous when the whole target is the
    // expansion (empty → rm on nothing/glob) or the remainder is rooted
    // (empty → reaches / or a root child), matching the official empty-
    // expansion family.
    return leadingExpansionRemainderIsDangerous(target) ? 'runtime' : 'safe'
  }
  // Embedded (non-leading) expansions are left to the detector pass, which
  // owns the emptyExpansion tail-strip semantics.
  if (target.includes('$') || target.includes('`')) return 'safe'
  return isDangerousLiteralTarget(resolveLiteralTarget(target))
    ? 'literalDanger'
    : 'safe'
}

function resolveLeadingVariable(
  target: string,
  assignments: AssignmentMap,
): { readonly value: string; readonly remainder: string } | null {
  const match =
    /^\$\{([A-Za-z_]\w*)\}/.exec(target) ?? /^\$([A-Za-z_]\w*)/.exec(target)
  if (match === null) return null
  const value = assignments.get(match[1]!)
  if (value === undefined || value === null) return null
  return { value, remainder: target.slice(match[0].length) }
}

function classifyResolvedLiteral(value: string, remainder: string): TargetVerdict {
  if (remainder.includes('$') || remainder.includes('`')) return 'runtime'
  return isDangerousLiteralTarget(resolveLiteralTarget(value + remainder))
    ? 'literalDanger'
    : 'safe'
}

function leadingExpansionRemainderIsDangerous(target: string): boolean {
  const remainder = leadingExpansionRemainder(target)
  return remainder === '' || remainder.startsWith('/')
}

function leadingExpansionRemainder(target: string): string {
  if (target.startsWith('${')) {
    const close = findClosingIndex(target, 2, '{', '}')
    return close === -1 ? '' : target.slice(close + 1)
  }
  if (target.startsWith('$(')) {
    const close = findClosingIndex(target, 2, '(', ')')
    return close === -1 ? '' : target.slice(close + 1)
  }
  const named = /^\$[A-Za-z_]\w*/.exec(target)
  if (named !== null) return target.slice(named[0].length)
  // Special params ($@ $* $# $$ $! $? $- $0…$9): value unknown at check
  // time, same Kk treatment as an unresolved named variable.
  const special = /^\$[^A-Za-z_{(]/.exec(target)
  if (special !== null) return target.slice(special[0].length)
  return ''
}

function findClosingIndex(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function resolveLiteralTarget(target: string): string {
  const home = homedir()
  const expanded =
    target === '~' ? home : target.startsWith('~/') ? home + target.slice(1) : target
  return posixPath.normalize(expanded)
}

function isDangerousLiteralTarget(resolved: string): boolean {
  // A bare glob wipes the working directory contents — fail-safe ask.
  if (resolved === '*') return true
  // `X/*` deletes the CONTENTS of X: dangerous only when X itself is a
  // dangerous removal path (or the glob is the root `/*`).
  const globBase = resolved.replace(/\/\*$/, '')
  if (globBase !== resolved) {
    return globBase === '' || isDangerousRemovalPath(globBase)
  }
  return isDangerousRemovalPath(resolved)
}
