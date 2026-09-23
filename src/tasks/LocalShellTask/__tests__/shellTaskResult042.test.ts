import { describe, expect, test } from 'bun:test'
import { backgroundCommandSummary } from '../LocalShellTask.js'
import {
  classifyShellTaskResult,
  commandExitAttributionIsAmbiguous,
  type ShellTaskExecResult,
} from '../shellTaskResult.js'

/**
 * 2.1.280 #042: "Fixed background shell tasks reporting benign non-zero
 * exits (e.g. grep with no matches) as failures" (changelog_280 line 43).
 *
 * CONTRACT tests of the byte-verified port of the official v2.1.280 exit
 * classifier chain (linux-x64 Bun ELF offsets):
 *   - `Oie(result, taskState)` @201157901 → `classifyShellTaskResult`
 *     (interrupted → killed; noExitStatus → failed; shell undefined → strict
 *     `code === 0`; else dispatch `Rzr={bash:o4t, powershell:u4t}`,
 *     isError → failed, else completed + exitNote = message).
 *   - `o4t` @201139166 (bash) = `m$e` (≡ OCC `interpretCommandResult`) +
 *     `r4e` compound-command guard @197919047 (flat-token substitution for
 *     the feature-gated-off tree-sitter AST walk — see shellTaskResult.ts).
 *   - `u4t`/`ntr`/`i4t`/`g$e`/`czr`/`azr`/`lzr` PowerShell chain —
 *     STRUCTURAL-ONLY in the shipped build (same contract as the qZs monitor
 *     port in monitorNoOutput221.test.ts): OCC spawns bash only, no
 *     PowerShell producer exists yet; pinned here awaiting a real producer.
 *   - `h$e` @201151000 non-monitor switch → `backgroundCommandSummary`
 *     (completed renders `(exit code N: exitNote)`).
 *
 * Known staged divergences (asserted as current behavior where relevant):
 *   - OCC's `interpretCommandResult` table lacks egrep/fgrep and the official
 *     `rzr` git-grep/git-diff bash entries (commandSemantics.ts read-only for
 *     this change) — bash `git grep` stays strict.
 *   - `(a && b)` subshell join: official r4e returns TRUE via the list-level
 *     `&&` check; the flat-token port returns FALSE at the paren boundary.
 *     Converges: a paren-prefixed base word never matches a benign table
 *     entry, so `interpretCommandResult` answers strict for those commands.
 */

function exec(overrides: Partial<ShellTaskExecResult>): ShellTaskExecResult {
  return { code: 0, stdout: '', stderr: '', interrupted: false, ...overrides }
}

const bash = (command: string) => ({ command, shell: 'bash' as const })
const powershell = (command: string) => ({
  command,
  shell: 'powershell' as const,
})

describe('2.1.280 #042: classifyShellTaskResult — official Oie branch order', () => {
  test('interrupted result → killed (the headline #042 fix: shell killed is not "failed")', () => {
    expect(
      classifyShellTaskResult(exec({ code: 137, interrupted: true }), bash('grep foo f')),
    ).toEqual({ status: 'killed', exitNote: undefined })
  })
  test('interrupted wins over noExitStatus (official checks interrupted first)', () => {
    expect(
      classifyShellTaskResult(
        exec({ code: 1, interrupted: true, noExitStatus: true }),
        bash('true'),
      ),
    ).toEqual({ status: 'killed', exitNote: undefined })
  })
  test('noExitStatus → failed even with code 0 (shell died without reporting a status)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 0, noExitStatus: true }), bash('true')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('no task info → strict code===0 (official x4t pre-state pass Oie(L,void 0))', () => {
    expect(classifyShellTaskResult(exec({ code: 0 }))).toEqual({
      status: 'completed',
      exitNote: undefined,
    })
    expect(classifyShellTaskResult(exec({ code: 1 }))).toEqual({
      status: 'failed',
      exitNote: undefined,
    })
  })
  test('task without shell → strict code===0 (official `n?.shell===void 0` branch)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), { command: 'grep foo f' }),
    ).toEqual({ status: 'failed', exitNote: undefined })
    expect(
      classifyShellTaskResult(exec({ code: 0 }), { command: 'grep foo f' }),
    ).toEqual({ status: 'completed', exitNote: undefined })
  })
})

describe('2.1.280 #042: bash benign exits (o4t = interpretCommandResult + r4e guard)', () => {
  test('grep exit 1 (no matches) → completed with exitNote', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('grep foo f')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('grep exit 0 → completed without exitNote', () => {
    expect(
      classifyShellTaskResult(exec({ code: 0 }), bash('grep foo f')),
    ).toEqual({ status: 'completed', exitNote: undefined })
  })
  test('grep exit 2 (real error) → failed, never an exitNote', () => {
    expect(
      classifyShellTaskResult(exec({ code: 2 }), bash('grep foo f')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('find exit 1 → completed "Some directories were inaccessible"', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('find . -name x')),
    ).toEqual({
      status: 'completed',
      exitNote: 'Some directories were inaccessible',
    })
  })
  test('diff exit 1 → completed "Files differ"', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('diff a b')),
    ).toEqual({ status: 'completed', exitNote: 'Files differ' })
  })
  test('test/[ exit 1 → completed "Condition is false"', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('test -f x')),
    ).toEqual({ status: 'completed', exitNote: 'Condition is false' })
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('[ -f x ]')),
    ).toEqual({ status: 'completed', exitNote: 'Condition is false' })
  })
  test('command without benign semantics, exit 1 → failed', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('make build')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('redirect tail keeps exit attributable → benign stands', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('grep foo f > out 2>&1')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('sequence join (`;`) attributes exit to last command → benign stands', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('true; grep foo f')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('pipeline attributes exit to last command → benign stands', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('cat x | grep foo f')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('newline join attributes exit to last command → benign stands', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('echo hi\ngrep foo f')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('&& compound revokes the benign interpretation → failed (exit unattributable)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('cd /x && grep foo f')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('dangling && fails closed → failed', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('grep foo f &&')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('trailing terminator `;` is well-formed → benign stands', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('grep foo f;')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
  test('&& before a newline boundary: exit belongs to the newline-joined last command → strict via its own base', () => {
    // Official: list[a,&&,b,'\n',c] — the last join is '\n', not '&&' → r4e
    // FALSE; base 'c' has no benign semantics → strict either way.
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('a && b\nc')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('subshell after && converges to failed (guard divergence neutralized by base extraction)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('a && (b; c)')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
})

describe('2.1.280 #042: commandExitAttributionIsAmbiguous — r4e flat-token port', () => {
  test('simple command → false', () => {
    expect(commandExitAttributionIsAmbiguous('grep foo f')).toBe(false)
  })
  test('&& join → true', () => {
    expect(commandExitAttributionIsAmbiguous('a && grep foo f')).toBe(true)
    expect(commandExitAttributionIsAmbiguous('grep foo f && a')).toBe(true)
  })
  test('; / || / & joins → false', () => {
    expect(commandExitAttributionIsAmbiguous('a; grep foo f')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('a || grep foo f')).toBe(false)
  })
  test('pipeline descent: `a && b | c` → true, `a; b | c` → false', () => {
    expect(commandExitAttributionIsAmbiguous('a && b | c')).toBe(true)
    expect(commandExitAttributionIsAmbiguous('a; b | c')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('cat x | grep foo f')).toBe(false)
  })
  test('redirect descent (redirected_statement): `a > out && grep f` → true, `grep f > out` → false', () => {
    expect(commandExitAttributionIsAmbiguous('grep foo f > out')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('grep foo f > out 2>&1')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('a > out && grep foo f')).toBe(true)
  })
  test('comments are skipped like official findLastIndex', () => {
    expect(commandExitAttributionIsAmbiguous('grep foo f # note')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('a && grep foo f # hi')).toBe(true)
  })
  test('well-formed trailing terminators step over', () => {
    expect(commandExitAttributionIsAmbiguous('grep foo f;')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('grep foo f &')).toBe(false)
  })
  test('dangling connectors/redirects fail closed (documented substitution)', () => {
    expect(commandExitAttributionIsAmbiguous('grep foo f &&')).toBe(true)
    expect(commandExitAttributionIsAmbiguous('grep foo f |')).toBe(true)
    expect(commandExitAttributionIsAmbiguous('grep foo f >')).toBe(true)
  })
  test('newline joins → false (last command owns the exit)', () => {
    expect(commandExitAttributionIsAmbiguous('echo hi\ngrep foo f')).toBe(false)
    expect(commandExitAttributionIsAmbiguous('a && b\nc')).toBe(false)
  })
  test('length cap: commands over 10000 chars → true (official hp=1e4)', () => {
    expect(commandExitAttributionIsAmbiguous(`grep ${'a'.repeat(10_001)}`)).toBe(
      true,
    )
    expect(commandExitAttributionIsAmbiguous(`grep ${'a'.repeat(9_000)}`)).toBe(
      false,
    )
  })
  test('subshell boundary → false (documented divergence; converges via base extraction)', () => {
    expect(commandExitAttributionIsAmbiguous('(a && b)')).toBe(false)
  })
})

describe('2.1.280 #042: powershell dispatch (u4t — STRUCTURAL-ONLY, no producer yet)', () => {
  test('findstr exit 1 → completed "No matches found" (bash has no findstr entry → failed: dispatch proven)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('findstr foo f.txt')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
    expect(
      classifyShellTaskResult(exec({ code: 1 }), bash('findstr foo f.txt')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('git grep / git diff subcommand semantics (czr skips -C/-c value pairs)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('git grep foo')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('git -C repo diff a b')),
    ).toEqual({ status: 'completed', exitNote: 'Files differ' })
  })
  test('robocopy exit-code bands (azr entry)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 0 }), powershell('robocopy a b')),
    ).toEqual({
      status: 'completed',
      exitNote: 'No files copied (already in sync)',
    })
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('robocopy a b')),
    ).toEqual({ status: 'completed', exitNote: 'Files copied successfully' })
    expect(
      classifyShellTaskResult(exec({ code: 2 }), powershell('robocopy a b')),
    ).toEqual({
      status: 'completed',
      exitNote: 'Robocopy completed (no errors)',
    })
    expect(
      classifyShellTaskResult(exec({ code: 8 }), powershell('robocopy a b')),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('&&-gated last segment revokes benign (i4t andGated → s4t)', () => {
    expect(
      classifyShellTaskResult(
        exec({ code: 1 }),
        powershell('Write-Output hi && findstr foo f.txt'),
      ),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('cmdlet-not-recognized output revokes benign (l4t)', () => {
    expect(
      classifyShellTaskResult(
        exec({
          code: 1,
          stderr:
            "grep : The term 'grep' is not recognized as the name of a cmdlet, function, script file, or operable program.",
        }),
        powershell('grep foo f'),
      ),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('CommandNotFoundException output revokes benign (c4t)', () => {
    expect(
      classifyShellTaskResult(
        exec({ code: 1, stderr: 'FullyQualifiedErrorId : CommandNotFoundException' }),
        powershell('grep foo f'),
      ),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('FINDSTR: error output revokes benign', () => {
    expect(
      classifyShellTaskResult(
        exec({ code: 1, stderr: 'FINDSTR: Failed to open f.txt' }),
        powershell('findstr foo f.txt'),
      ),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('native .exe benign table applies only with output (ntr `y==="exe"&&w` gate)', () => {
    expect(
      classifyShellTaskResult(
        exec({ code: 1, stdout: 'C:\\x\\foo.exe' }),
        powershell('where.exe foo'),
      ),
    ).toEqual({ status: 'completed', exitNote: 'No matching files found' })
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('where.exe foo')),
    ).toEqual({ status: 'failed', exitNote: undefined })
    expect(
      classifyShellTaskResult(
        exec({ code: 1, stdout: 'C:\\x\\foo.exe' }),
        powershell('where foo'),
      ),
    ).toEqual({ status: 'failed', exitNote: undefined })
  })
  test('call-operator prefixed segment still resolves the base word (g$e strips leading &/.)', () => {
    expect(
      classifyShellTaskResult(exec({ code: 1 }), powershell('& findstr foo f.txt')),
    ).toEqual({ status: 'completed', exitNote: 'No matches found' })
  })
})

describe('2.1.280 #042: backgroundCommandSummary — official h$e non-monitor switch', () => {
  test('completed with exitNote renders "(exit code N: note)"', () => {
    expect(
      backgroundCommandSummary('grep foo f', 'completed', 1, 'No matches found'),
    ).toBe(
      'Background command "grep foo f" completed (exit code 1: No matches found)',
    )
  })
  test('completed without exitNote keeps the pre-#042 shape', () => {
    expect(backgroundCommandSummary('make build', 'completed', 0)).toBe(
      'Background command "make build" completed (exit code 0)',
    )
  })
  test('completed without a known exit code omits the suffix entirely', () => {
    expect(backgroundCommandSummary('w', 'completed', undefined)).toBe(
      'Background command "w" completed',
    )
  })
  test('failed renders "with exit code N"', () => {
    expect(backgroundCommandSummary('make build', 'failed', 2)).toBe(
      'Background command "make build" failed with exit code 2',
    )
    expect(backgroundCommandSummary('make build', 'failed', undefined)).toBe(
      'Background command "make build" failed',
    )
  })
  test('killed renders "was stopped" (undefined-stopCause arm of the official RV lookup)', () => {
    expect(backgroundCommandSummary('make build', 'killed', 137)).toBe(
      'Background command "make build" was stopped',
    )
  })
})
