/**
 * 2.1.280 #042: background shell task terminal-exit classifier.
 *
 * Byte-verified port of the official Claude Code v2.1.280 classifier chain
 * (changelog: "Fixed background shell tasks reporting benign non-zero exits
 * (e.g. grep with no matches) as failures"). Official symbols, extracted from
 * the 2.1.280 linux-x64 Bun-compiled ELF:
 *
 *   - `Oie(result, taskState)` @201157901 — top-level classifier, ported here
 *     as `classifyShellTaskResult` (branch order is load-bearing):
 *       interrupted      → { status: 'killed' }
 *       noExitStatus     → { status: 'failed' }
 *       task.shell undef → strict `code === 0 ? completed : failed`
 *       else             → dispatch `Rzr = { bash: o4t, powershell: u4t }`
 *                           on (command, code, stdout, stderr);
 *                           isError → failed, else completed + exitNote=message
 *   - `o4t` @201139166 (bash) = `m$e` + the `r4e` compound-command guard.
 *     `m$e` is byte-identical to OCC's existing `interpretCommandResult`
 *     (src/tools/BashTool/commandSemantics.ts), which is reused here.
 *   - `r4t` @201137577 — strict fallback (`Command failed with exit code N`).
 *   - `r4e` @197919047 — compound-command guard: TRUE (block the benign
 *     interpretation) when the exit code cannot be attributed to the final
 *     command. Official implementation walks a synchronous tree-sitter AST
 *     (`program`/`list`/`pipeline`/`redirected_statement` wrappers, `&&`
 *     join check at list levels, 10 000-char cap `hp=1e4`, parse failure →
 *     TRUE). OCC's tree-sitter parser is `feature('TREE_SITTER_BASH')`-gated
 *     (dead at runtime) and async, so — following the precedent set by
 *     commandSemantics.ts, which substitutes `splitCommand_DEPRECATED` for
 *     the official `Ul` splitter — this port substitutes a flat-token
 *     walk-back over `splitCommandWithOperators` implementing the same
 *     observable semantics (see `commandExitAttributionIsAmbiguous`).
 *   - PowerShell chain @201137577-region: `u4t`/`ntr`/`i4t`/`g$e`/`czr`/
 *     `azr`/`lzr`/`s4t`/`Sq` — ported verbatim below. STRUCTURAL-ONLY in
 *     the shipped build (same contract as `monitorCompletedSummary` in
 *     LocalShellTask.tsx): OCC on linux/macos spawns bash only and has no
 *     PowerShell producer, so the `powershell` dispatch arm is pinned by
 *     unit tests, awaiting a real producer.
 *
 * Not ported (out of #042 scope / no OCC producer — staged):
 *   - `f_t` / `Cvn` (@201157901 region) — notification-status wrappers;
 *     OCC's `enqueueShellNotification` covers the same surface.
 *   - `RV = { memory_pressure: ... }` stopCause table + pressure-reap that
 *     produces it (official `h$e` killed branch) — no OCC producer.
 *   - `noExitStatus` production (official exec layer @197625607:
 *     `if(this.#w)s.noExitStatus=!0`) — OCC's ExecResult lives in
 *     utils/ShellCommand.ts, outside this change's editable scope; the
 *     classifier branch is structural, pinned by unit tests.
 *   - commandSemantics table gaps vs official `nzr`/`rzr` (egrep, fgrep,
 *     `git grep`, `git diff` benign entries) — commandSemantics.ts is
 *     read-only for this change.
 */

import type { CommandSemantic } from '../../tools/BashTool/commandSemantics.js'
import { interpretCommandResult } from '../../tools/BashTool/commandSemantics.js'
import { splitCommandWithOperators } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

/** Official task-state shell dispatch key (persisted by spawn `Jhe`). */
export type ShellKind = 'bash' | 'powershell'

/** Official `Oie` return: `{status:'completed'|'failed'|'killed', exitNote}`. */
export type ShellTaskClassification = {
  status: 'completed' | 'failed' | 'killed'
  /** Benign-exit interpretation rendered in the completion summary, e.g.
   * "No matches found" (official h$e: `(exit code 1: No matches found)`). */
  exitNote?: string
}

/**
 * Structural view of the exec-result fields official `Oie` reads. OCC's
 * `ExecResult` (utils/ShellCommand.ts) satisfies this. `noExitStatus` is set
 * by the official exec layer when the shell died without reporting an exit
 * status; OCC's ExecResult does not carry it yet (file outside this change's
 * editable scope), so the branch is a structural port — see header.
 */
export type ShellTaskExecResult = {
  code: number
  interrupted: boolean
  stdout: string
  stderr: string
  noExitStatus?: boolean
}

/**
 * Structural view of the task-state fields official `Oie` reads (`n.shell`,
 * `n.command`). LocalShellTaskState passes directly: `command` is declared,
 * and `shell` is persisted at spawn via conditional spread (guards.ts is
 * outside this change's editable scope) and read back at runtime.
 */
export type ShellTaskCommandInfo = {
  command: string
  shell?: ShellKind
}

type ShellResultInterpretation = {
  isError: boolean
  message?: string
}

type ShellResultInterpreter = (
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
) => ShellResultInterpretation

// ---------------------------------------------------------------------------
// Official Oie @201157901 — top-level classifier.
// ---------------------------------------------------------------------------

/**
 * Classify a finished background shell task's terminal status.
 *
 * Official `Oie(e,n)`, verbatim branch order:
 * ```js
 * if(e.interrupted)return{status:"killed",exitNote:void 0};
 * if(e.noExitStatus)return{status:"failed",exitNote:void 0};
 * if(n?.shell===void 0)return{status:e.code===0?"completed":"failed",exitNote:void 0};
 * let{isError:r,message:s}=Rzr[n.shell](n.command,e.code,e.stdout,e.stderr);
 * return r?{status:"failed",exitNote:void 0}:{status:"completed",exitNote:s}
 * ```
 *
 * `task` is optional exactly as official (`n?.shell`, and the spawn handler
 * calls `Oie(L, void 0)` as its pre-state pass). With no shell info the
 * classification is the legacy strict `code === 0` rule.
 */
export function classifyShellTaskResult(
  result: ShellTaskExecResult,
  task?: ShellTaskCommandInfo,
): ShellTaskClassification {
  if (result.interrupted) {
    return { status: 'killed', exitNote: undefined }
  }
  if (result.noExitStatus) {
    return { status: 'failed', exitNote: undefined }
  }
  if (task?.shell === undefined) {
    return {
      status: result.code === 0 ? 'completed' : 'failed',
      exitNote: undefined,
    }
  }
  const { isError, message } = SHELL_INTERPRETERS[task.shell](
    task.command,
    result.code,
    result.stdout,
    result.stderr,
  )
  return isError
    ? { status: 'failed', exitNote: undefined }
    : { status: 'completed', exitNote: message }
}

/** Official `Rzr = { bash: o4t, powershell: u4t }` @201157901. */
const SHELL_INTERPRETERS: Record<ShellKind, ShellResultInterpreter> = {
  bash: interpretBashResult,
  powershell: interpretPowershellResult,
}

// ---------------------------------------------------------------------------
// Bash chain — official r4t / o4t / r4e.
// ---------------------------------------------------------------------------

/**
 * Official `r4t` @201137577 — strict interpretation, byte-identical to
 * commandSemantics.ts's DEFAULT_SEMANTIC:
 * `(e,n,r)=>({isError:e!==0,message:e!==0?`Command failed with exit code ${e}`:void 0})`
 */
const strictBashResult: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * Official `o4t` @201139166 — the bash interpreter:
 * ```js
 * function o4t(e,n,r,s){let g=m$e(e,n,r,s);
 *   return n!==0&&!g.isError&&r4e(e)?r4t(n,r,s):g}
 * ```
 * `m$e` is byte-identical to OCC's `interpretCommandResult` (same semantic
 * tables, same DEFAULT fallback, same last-segment base-command extraction),
 * so it is reused directly. The `r4e` compound-command guard revokes the
 * benign interpretation when the exit code cannot be attributed to the final
 * command (e.g. `cd /x && grep foo` — the nonzero exit may belong to any
 * `&&`-joined member).
 */
function interpretBashResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ShellResultInterpretation {
  const interpreted = interpretCommandResult(
    command,
    exitCode,
    stdout,
    stderr,
  )
  if (
    exitCode !== 0 &&
    !interpreted.isError &&
    commandExitAttributionIsAmbiguous(command)
  ) {
    return strictBashResult(exitCode, stdout, stderr)
  }
  return interpreted
}

/** Official `hp = 1e4` @197919047 — r4e's command-length cap. */
const MAX_GUARDED_COMMAND_LENGTH = 10_000

/** Official `_pe` operator vocabulary (minus pipeline `|`, handled separately):
 * `new Set(["&&","||","|",";","&","|&","\n"])`. Redirect ops are the
 * tree-sitter `*_redirect` node types r4e skips via `!g.type.endsWith("_redirect")`. */
const PIPELINE_OPERATORS: ReadonlySet<string> = new Set(['|', '|&'])
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  '>',
  '>>',
  '>&',
  '<',
  '<<',
  '<<<',
  '<&',
])
const LIST_TERMINATORS: ReadonlySet<string> = new Set([';', '&', '\n'])
const CONTROL_OPERATORS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  ';',
  ';;',
  '\n',
  ...PIPELINE_OPERATORS,
  ...LIST_TERMINATORS,
  ...REDIRECT_OPERATORS,
])

function isCommentToken(token: string): boolean {
  // splitCommandWithOperators maps shell-quote comment entries to '#'+text;
  // quoted words never yield a leading bare '#' (quote chars are restored
  // first). Mirrors r4e skipping `comment` children in findLastIndex.
  return token.startsWith('#')
}

function skipCommentsBackward(tokens: string[], index: number): number {
  let i = index
  while (i >= 0 && isCommentToken(tokens[i]!)) {
    i--
  }
  return i
}

/**
 * Flat-token port of official `r4e` @197919047:
 * ```js
 * var lY=new Set(["program","list","pipeline"]),
 *     _pe=new Set(["&&","||","|",";","&","|&","\n"]), hp=1e4;
 * function r4e(e){if(e.length>hp)return!0;let n=a_().parse(e);
 *   if(n?.type!=="program")return!0;let r=n;
 *   while(r!==void 0&&(lY.has(r.type)||r.type==="redirected_statement")){
 *     let s=r.children.findLastIndex(g=>!_pe.has(g.type)&&g.type!=="comment"
 *       &&!g.type.endsWith("_redirect"));
 *     if(r.type==="list"&&r.children[s-1]?.type==="&&")return!0;
 *     r=r.children[s]}return!1}
 * ```
 * TRUE = exit-code attribution is ambiguous → block the benign interpretation
 * (strict `r4t`). Semantics: descending from the root through wrapper levels
 * to the LAST substantive command, any list level joined by `&&` right before
 * that child makes the nonzero exit unattributable; pipeline (`|`), sequence
 * (`;`), or-(`||`), background (`&`) and newline joins attribute the exit to
 * the final command (FALSE). Subshell bodies are never descended.
 *
 * SUBSTITUTION (documented, see file header): OCC's tree-sitter parse is
 * feature-gated off and async, so the AST descent is implemented as a
 * walk-back over `splitCommandWithOperators`' flat token stream (command-run
 * strings interleaved with operator strings; newline boundaries appear as
 * adjacent strings). Equivalence on the wrapper descent:
 *   - `redirected_statement` ≡ skipping trailing redirect-op/target pairs;
 *   - `pipeline` level       ≡ stepping over `|`/`|&` and continuing back;
 *   - `list` level `&&` check ≡ first list-level operator hit is `&&` → TRUE;
 *   - comments skipped       ≡ `#`-prefixed tokens skipped;
 *   - subshell not descended ≡ paren tokens fall through to the non-`&&`
 *     branch (FALSE). The known divergence (`a && (b)`: official TRUE via the
 *     list check, this port FALSE at the paren boundary) converges to the same
 *     final classification because a paren-prefixed base word never matches a
 *     benign-semantics table entry, so `interpretCommandResult` already
 *     answers strict for those commands.
 *   - length cap (`hp`) and parse-failure (`n?.type!=="program"`) branches are
 *     ported 1:1 (`tryParseShellCommand` failure → TRUE, fail-closed).
 * Dangling trailing connectors (`cmd &&`, `cmd >`) have no final command to
 * attribute an exit to; the official resolves these through tree-sitter ERROR
 * nodes (not byte-recoverable), so this port fails CLOSED (TRUE = strict),
 * matching OCC's existing dangling-`&&`/`||` compensation-guard precedent
 * (OCC-46). Well-formed trailing terminators (`cmd;`, `cmd &`, `cmd\n`) are
 * stepped over — official `_pe` skips them in findLastIndex.
 */
export function commandExitAttributionIsAmbiguous(command: string): boolean {
  if (command.length > MAX_GUARDED_COMMAND_LENGTH) {
    return true
  }
  if (!tryParseShellCommand(command).success) {
    return true
  }

  const tokens = splitCommandWithOperators(command)
  let i = skipCommentsBackward(tokens, tokens.length - 1)

  // Trailing operator handling (see doc): terminators step over, dangling
  // connectors/redirects fail closed.
  while (i >= 0 && CONTROL_OPERATORS.has(tokens[i]!)) {
    if (LIST_TERMINATORS.has(tokens[i]!)) {
      i--
      continue
    }
    return true
  }
  if (i < 0) {
    // Empty or comment-only command — official descent reaches `undefined`
    // children and returns false.
    return false
  }

  for (;;) {
    // Descend `redirected_statement` wrappers: skip `op target` pairs.
    while (i > 0 && REDIRECT_OPERATORS.has(tokens[i - 1]!)) {
      i -= 2
    }
    if (i < 0) {
      // Redirect operator with nothing before it — malformed, fail closed.
      return true
    }
    if (i === 0) {
      // Leading command span, nothing joins it → exit attributable.
      return false
    }

    const join = tokens[i - 1]!
    if (join === '&&') {
      // Official list-level `children[s-1].type === "&&"` check.
      return true
    }
    if (PIPELINE_OPERATORS.has(join)) {
      // Official descends through `pipeline` levels without a `&&` check.
      i = skipCommentsBackward(tokens, i - 2)
      if (i < 0) {
        return false
      }
      if (CONTROL_OPERATORS.has(tokens[i]!)) {
        // Adjacent operators (`a | ; b`) — malformed, fail closed.
        return true
      }
      continue
    }
    // `||`, `;`, `&`, `\n`, newline boundary (adjacent spans) or any other
    // token → the exit code belongs to the final command → benign
    // interpretation stands (official returns false at these joins).
    return false
  }
}

// ---------------------------------------------------------------------------
// PowerShell chain — official s4t / Sq / G$ / izr / azr / lzr / g$e / i4t /
// czr / l4t / c4t / ntr / u4t (v280 @201137577-region, newline-preserving
// extraction). STRUCTURAL-ONLY: no PowerShell producer in the shipped build.
// ---------------------------------------------------------------------------

/** Official `s4t` — strict PowerShell fallback (same shape as `r4t`). */
const strictPowershellResult: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/** Official `Sq = (e)=>(n,r,s)=>({isError:n!==0&&n!==1,message:n===1?e:void 0})`. */
function powershellBenignAtOne(message: string): CommandSemantic {
  return (exitCode, _stdout, _stderr) => ({
    isError: exitCode !== 0 && exitCode !== 1,
    message: exitCode === 1 ? message : undefined,
  })
}

/** Official `G$ = Sq("No matches found")`. */
const POWERSHELL_NO_MATCHES = powershellBenignAtOne('No matches found')
/** Official `izr = Sq("Files differ")`. */
const POWERSHELL_FILES_DIFFER = powershellBenignAtOne('Files differ')

/**
 * Official `azr` — cmdlet/native benign-exit table:
 * ```js
 * new Map([["grep",G$],["rg",G$],["egrep",G$],["fgrep",G$],["findstr",G$],
 *   ["robocopy",(e,n,r)=>({isError:e<0||e>=8,message:e===0?
 *     "No files copied (already in sync)":e>=1&&e<8?e&1?
 *     "Files copied successfully":"Robocopy completed (no errors)":void 0})]])
 * ```
 */
const POWERSHELL_BENIGN_EXITS: Map<string, CommandSemantic> = new Map([
  ['grep', POWERSHELL_NO_MATCHES],
  ['rg', POWERSHELL_NO_MATCHES],
  ['egrep', POWERSHELL_NO_MATCHES],
  ['fgrep', POWERSHELL_NO_MATCHES],
  ['findstr', POWERSHELL_NO_MATCHES],
  [
    'robocopy',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode < 0 || exitCode >= 8,
      message:
        exitCode === 0
          ? 'No files copied (already in sync)'
          : exitCode >= 1 && exitCode < 8
            ? exitCode & 1
              ? 'Files copied successfully'
              : 'Robocopy completed (no errors)'
            : undefined,
    }),
  ],
])

/**
 * Official `lzr` — benign table applied ONLY to native `.exe` invocations
 * that produced output (`ntr`'s `y==="exe"&&w` gate):
 * `new Map([["where",Sq("No matching files found")],["fc",Sz("Files differ")],["diff",Sz(...)]])`
 */
const POWERSHELL_NATIVE_EXE_WITH_OUTPUT: Map<string, CommandSemantic> = new Map([
  ['where', powershellBenignAtOne('No matching files found')],
  ['fc', POWERSHELL_FILES_DIFFER],
  ['diff', POWERSHELL_FILES_DIFFER],
])

/** Official `l4t=/is not recognized as (a name of a cmdlet|the name of a cmdlet|an? internal)/i`. */
const PS_NOT_RECOGNIZED_RE =
  /is not recognized as (a name of a cmdlet|the name of a cmdlet|an? internal)/i
/** Official `c4t=/CommandNotFoundException/`. */
const PS_COMMAND_NOT_FOUND_RE = /CommandNotFoundException/
/** Official `/^FINDSTR: /m` (inline in `u4t`). */
const PS_FINDSTR_ERROR_RE = /^FINDSTR: /m

/**
 * Official `g$e` — extract the invoked command word from a PowerShell
 * segment: strips call operators (`&`/`.`), unwraps quotes, takes the path
 * basename, and detects a native `.exe`/`.cmd`/`.bat` extension:
 * ```js
 * function g$e(e){let n=e.trim().replace(/^[&.]\s+/,""),
 *   r=/^"([^"]*)"|^'([^']*)'/.exec(n),
 *   s=r?.[1]??r?.[2]??(n.split(/\s+/)[0]||"").replace(/^["']|["']$/g,""),
 *   h=(s.split(/[\\/]/).pop()||s).toLowerCase(),
 *   y=["exe","cmd","bat"].find(w=>h.endsWith("."+w))??null;
 *   return{base:y?h.slice(0,-(y.length+1)):h,hadNativeExt:y!==null,nativeExt:y}}
 * ```
 */
function parsePowershellCommandWord(segment: string): {
  base: string
  hadNativeExt: boolean
  nativeExt: string | null
} {
  const trimmed = segment.trim().replace(/^[&.]\s+/, '')
  const quoted = /^"([^"]*)"|^'([^']*)'/.exec(trimmed)
  const word =
    quoted?.[1] ??
    quoted?.[2] ??
    (trimmed.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '')
  const lowered = (word.split(/[\\/]/).pop() || word).toLowerCase()
  const nativeExt =
    ['exe', 'cmd', 'bat'].find(ext => lowered.endsWith(`.${ext}`)) ?? null
  return {
    base: nativeExt ? lowered.slice(0, -(nativeExt.length + 1)) : lowered,
    hadNativeExt: nativeExt !== null,
    nativeExt,
  }
}

/**
 * Official `i4t` — split a PowerShell command line into segments on `;`,
 * `|`, newlines, `&&`, background `&`, and `#` comments (quote- and
 * backtick-escape-aware), returning the LAST non-empty segment plus whether
 * it was `&&`-gated. Verbatim control flow; the binary's raw-newline template
 * literals are written as '\n' escapes (identical runtime bytes).
 */
function lastPowershellSegment(command: string): {
  segment: string
  andGated: boolean
} {
  const segments: { text: string; andGated: boolean }[] = []
  let start = 0
  let andGated = false
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false
      continue
    }
    if (inDoubleQuote) {
      if (ch === '`') i++
      else if (ch === '"') inDoubleQuote = false
      continue
    }
    if (
      ch === '#' &&
      (i === 0 ||
        command[i - 1] === ' ' ||
        command[i - 1] === '\t' ||
        command[i - 1] === '\n' ||
        command[i - 1] === '\r')
    ) {
      segments.push({ text: command.slice(start, i), andGated })
      while (i + 1 < command.length && command[i + 1] !== '\n' && command[i + 1] !== '\r') {
        i++
      }
      start = i + 1
      continue
    }
    if (ch === "'") {
      inSingleQuote = true
      continue
    }
    if (ch === '"') {
      inDoubleQuote = true
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push({ text: command.slice(start, i), andGated })
      start = i + 1
      if (ch !== '|') andGated = false
      continue
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        segments.push({ text: command.slice(start, i), andGated })
        i++
        start = i + 1
        andGated = true
        continue
      }
      const prev = command[i - 1]
      if ((prev === ' ' || prev === '\t') && command.slice(start, i).trim() !== '') {
        segments.push({ text: command.slice(start, i), andGated })
        start = i + 1
        andGated = false
      }
    }
  }
  segments.push({ text: command.slice(start), andGated })
  const last = segments.findLast(s => s.text.trim())
  return last
    ? { segment: last.text, andGated: last.andGated }
    : { segment: command, andGated: false }
}

/**
 * Official `czr` — resolve the git subcommand from a PowerShell segment
 * (quote-aware first word must be `git`; skips `-C`/`-c` value pairs and
 * other dash-flags; returns the first positional word).
 */
function powershellGitSubcommand(segment: string): string | undefined {
  const trimmed = segment.trim().replace(/^[&.]\s+/, '')
  const firstWord =
    /^"[^"]*"|^'[^']*'/.exec(trimmed)?.[0] ?? trimmed.split(/\s+/)[0] ?? ''
  if (parsePowershellCommandWord(firstWord).base !== 'git') {
    return undefined
  }
  const rest = trimmed.slice(firstWord.length)
  const words = ['git', ...rest.trim().split(/\s+/).filter(Boolean)]
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    if (word.startsWith('-')) {
      if (word === '-C' || word === '-c') i++
      continue
    }
    return word
  }
  return undefined
}

/**
 * Official `ntr` — inner PowerShell interpretation:
 * ```js
 * function ntr(e,n,r,s){let{segment:g}=i4t(e),{base:h,nativeExt:y}=g$e(g);
 *   if(h==="git"){let L=czr(g);if(L==="grep")return G$(n,r,s);
 *     if(L==="diff")return izr(n,r,s)}
 *   let w=r.trim()!==""||s.trim()!=="";
 *   return((y==="exe"&&w?lzr.get(h):void 0)??azr.get(h)??s4t)(n,r,s)}
 * ```
 */
function interpretPowershellInner(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ShellResultInterpretation {
  const { segment } = lastPowershellSegment(command)
  const { base, nativeExt } = parsePowershellCommandWord(segment)
  if (base === 'git') {
    const subcommand = powershellGitSubcommand(segment)
    if (subcommand === 'grep') {
      return POWERSHELL_NO_MATCHES(exitCode, stdout, stderr)
    }
    if (subcommand === 'diff') {
      return POWERSHELL_FILES_DIFFER(exitCode, stdout, stderr)
    }
  }
  const hasOutput = stdout.trim() !== '' || stderr.trim() !== ''
  const semantic =
    (nativeExt === 'exe' && hasOutput
      ? POWERSHELL_NATIVE_EXE_WITH_OUTPUT.get(base)
      : undefined) ??
    POWERSHELL_BENIGN_EXITS.get(base) ??
    strictPowershellResult
  return semantic(exitCode, stdout, stderr)
}

/**
 * Official `u4t` — the PowerShell interpreter (dispatch arm of `Rzr`):
 * ```js
 * function u4t(e,n,r,s){let g=ntr(e,n,r,s);if(n===0||g.isError)return g;
 *   let h=`${r}\n${s}`;
 *   return i4t(e).andGated||l4t.test(h)||c4t.test(h)||/^FINDSTR: /m.test(h)
 *     ?s4t(n,r,s):g}
 * ```
 * A benign nonzero exit is revoked (strict) when the last segment was
 * `&&`-gated (exit may belong to an earlier member) or when combined output
 * shows a command-resolution failure that PowerShell reports WITHOUT a
 * nonzero native exit code.
 */
function interpretPowershellResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ShellResultInterpretation {
  const interpreted = interpretPowershellInner(
    command,
    exitCode,
    stdout,
    stderr,
  )
  if (exitCode === 0 || interpreted.isError) {
    return interpreted
  }
  const combined = `${stdout}\n${stderr}`
  return lastPowershellSegment(command).andGated ||
    PS_NOT_RECOGNIZED_RE.test(combined) ||
    PS_COMMAND_NOT_FOUND_RE.test(combined) ||
    PS_FINDSTR_ERROR_RE.test(combined)
    ? strictPowershellResult(exitCode, stdout, stderr)
    : interpreted
}
