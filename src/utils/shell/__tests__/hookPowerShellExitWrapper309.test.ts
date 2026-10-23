/**
 * CC 2.1.309 changelog #32: "Windows: Fixed PowerShell hooks not blocking on
 * hook program exit code 2 ... PreToolUse/PermissionRequest hooks with
 * `"shell":"powershell"` failed open when Git for Windows isn't installed."
 *
 * Official evidence (linux-x64 ELFs, read-only forensics):
 * - BIN309 hook spawn @~252637500:
 *   `let vs=n==="PermissionRequest"||IWe(to)?to:to+`
 *   `; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }`;`
 *   (n = hookEvent, to = finalCommand; the wrapper template literal begins
 *   with a REAL NEWLINE, then `; if (...)`)
 * - Wrapper string offsets: BIN309:126298081 & 252638083; ZERO hits in
 *   BIN308 (new in 2.1.309). 308 spawned the raw `-Command` with no wrapper,
 *   so `pwsh -Command "<native exe>"` swallowed the inner exit code 2 and a
 *   blocking PreToolUse hook failed open.
 * - `function IWe` @BIN309:249832507 (declaration-leading predicate; full
 *   source extracted — skips leading whitespace/`;`/`#` line comments/
 *   `<#...#>` block comments, then tests for `using namespace|module|
 *   assembly`, `param(`, `begin|process|end|clean|dynamicparam {`, or a
 *   `[word` attribute that is NOT a `[Type]::` static call).
 *
 * The wrapper is applied at the HOOK spawn site only (buildHookPowerShell
 * Command), NOT inside buildPowerShellArgs — the provider path
 * (buildExecCommand) has its own $LASTEXITCODE capture + `exit $_ec` and
 * would be corrupted by a second wrapper.
 */
import { describe, expect, test } from 'bun:test'
import {
  POWERSHELL_HOOK_EXIT_WRAPPER,
  buildHookPowerShellCommand,
  startsWithPowerShellDeclaration,
} from '../powershellProvider.js'

describe('CC 2.1.309 #32 PowerShell hook exit-code-2 wrapper', () => {
  test('wrapper string is byte-verbatim from BIN309 (leading real newline)', () => {
    // Arrange / Act / Assert — exact official literal:
    // "\n; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }"
    expect(POWERSHELL_HOOK_EXIT_WRAPPER).toBe(
      '\n; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }',
    )
  })

  test('plain command gets the wrapper appended (exit 2 propagates)', () => {
    // Arrange
    const command = 'C:\\hooks\\check.ps1'

    // Act
    const result = buildHookPowerShellCommand('PreToolUse', command)

    // Assert
    expect(result).toBe(command + POWERSHELL_HOOK_EXIT_WRAPPER)
  })

  test('native exe invocation gets the wrapper (the fail-open case)', () => {
    // Arrange — `pwsh -Command "myprog"` surfaces $? but not the exit code
    const command = 'myprog --flag'

    // Act
    const result = buildHookPowerShellCommand('PreToolUse', command)

    // Assert
    expect(result.endsWith(POWERSHELL_HOOK_EXIT_WRAPPER)).toBe(true)
  })

  test('PermissionRequest hooks never get the wrapper', () => {
    // Arrange / Act
    const result = buildHookPowerShellCommand(
      'PermissionRequest',
      'approve-check.ps1',
    )

    // Assert — official: `n==="PermissionRequest"||IWe(to)?to:...`
    expect(result).toBe('approve-check.ps1')
  })

  test('other hook events get the wrapper', () => {
    for (const event of ['PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      expect(buildHookPowerShellCommand(event, 'hook.exe')).toBe(
        'hook.exe' + POWERSHELL_HOOK_EXIT_WRAPPER,
      )
    }
  })
})

describe('CC 2.1.309 #32 declaration-leading predicate (official IWe @249832507)', () => {
  test('param( block commands are declarations — no wrapper (would corrupt them)', () => {
    // Arrange / Act / Assert
    expect(startsWithPowerShellDeclaration('param($x) exit 2')).toBe(true)
    expect(startsWithPowerShellDeclaration('Param ( $x )')).toBe(true)
    expect(startsWithPowerShellDeclaration('PARAM($x)')).toBe(true)
  })

  test('using namespace/module/assembly are declarations', () => {
    expect(startsWithPowerShellDeclaration('using namespace System.IO')).toBe(true)
    expect(startsWithPowerShellDeclaration('USING MODULE Foo')).toBe(true)
    expect(startsWithPowerShellDeclaration('using assembly Bar')).toBe(true)
    // `using` alone (alias form `using foo = bar`) is NOT in the official set
    expect(startsWithPowerShellDeclaration('using foo = System.IO')).toBe(false)
  })

  test('named blocks are declarations', () => {
    for (const block of ['begin', 'process', 'end', 'clean', 'dynamicparam']) {
      expect(startsWithPowerShellDeclaration(`${block} { Get-Item x }`)).toBe(true)
      expect(startsWithPowerShellDeclaration(`${block.toUpperCase()}{}`)).toBe(true)
    }
  })

  test('attribute-leading commands are declarations, but [Type]:: static calls are not', () => {
    // Arrange / Act / Assert — official: /^\[\w/ && !/^\[[\w.]+\]::/
    expect(startsWithPowerShellDeclaration('[CmdletBinding()] param()')).toBe(true)
    expect(startsWithPowerShellDeclaration('[OutputType([string])]')).toBe(true)
    expect(startsWithPowerShellDeclaration('[Console]::Out.WriteLine("x")')).toBe(false)
    expect(startsWithPowerShellDeclaration('[System.IO.Path]::GetTempPath()')).toBe(false)
  })

  test('leading whitespace, semicolons, line comments and block comments are skipped', () => {
    // Arrange / Act / Assert — the official scanner loops over [\s;], `#`...
    // and `<#...#>` before testing the declaration regexes.
    expect(startsWithPowerShellDeclaration('  \n\t param($x)')).toBe(true)
    expect(startsWithPowerShellDeclaration('; ; param($x)')).toBe(true)
    expect(startsWithPowerShellDeclaration('# comment line\nparam($x)')).toBe(true)
    expect(startsWithPowerShellDeclaration('<# block #>param($x)')).toBe(true)
    expect(startsWithPowerShellDeclaration('# one\n# two\n<# b #>begin{}')).toBe(true)
    // unterminated block comment → scanner stops at end, remainder empty
    expect(startsWithPowerShellDeclaration('<# never closed param(')).toBe(false)
  })

  test('plain commands are not declarations', () => {
    expect(startsWithPowerShellDeclaration('exit 2')).toBe(false)
    expect(startsWithPowerShellDeclaration('myprog.exe --strict')).toBe(false)
    expect(startsWithPowerShellDeclaration('if ($x) { exit 2 }')).toBe(false)
    expect(startsWithPowerShellDeclaration('')).toBe(false)
  })

  test('declaration-leading commands keep the raw command (no wrapper)', () => {
    // Arrange
    const command = 'param($Json) $Json | Out-File x; exit 2'

    // Act
    const result = buildHookPowerShellCommand('PreToolUse', command)

    // Assert — appending `; if (...)` after a param() block would still be
    // legal PS, but the official skips it; port the exact predicate.
    expect(result).toBe(command)
  })
})
