import { describe, expect, test } from 'bun:test'
import { BashTool } from '../BashTool.js'
import { renderToolUseMessage } from '../UI.js'
import { getFileExtensionsFromBashCommand } from '../../../services/analytics/metadata.js'

/**
 * Official Claude Code v2.1.309 item #52 — "`sed -i` file edits no longer show
 * the simulated file-edit preview; the command now gets the standard Bash
 * permission prompt, runs as written, and is no longer restored by /rewind."
 *
 * Binary evidence (BIN308=/tmp/cc-diff-309/vprev, BIN309=/tmp/cc-diff-309/vver,
 * read-only strings/grep/dd forensics):
 *
 * - sed-edit parser `J1e` @BIN308:253021236 (`function J1e(e){...
 *   if(!H.match(/^s\//))return null...extendedRegex:w}`) is GONE in BIN309:
 *   distinctive body markers `if(!H.match(/^s\//))return null` 308:1 → 309:0,
 *   `extendedRegex` 308:3 → 309:0, `function KMs` (applySedSubstitution,
 *   @BIN308 right after the parser) → no definition in BIN309. The `J1e` name
 *   in BIN309 is minifier reuse for an unrelated fn (`return qT(e)`).
 * - schema field `_simulatedSedEdit` `.describe("Internal: pre-computed sed
 *   edit result from preview")` @BIN308:253029252 → 0 hits in BIN309 (field
 *   definition removed).
 * - preview block `old_string:D,new_string:h,replace_all:!1` @BIN308:271962725
 *   → 0 hits in BIN309 (SedEditPermissionRequest edits array removed).
 * - call() short-circuit `if(n._simulatedSedEdit&&!s.remoteCall)return{...await
 *   Uws(...)}` @BIN308:253043770 → gone in BIN309.
 * - `userFacingName` sed branch removed: BIN309 @253978500 reads
 *   `userFacingName(e){if(!e)return"Bash";return i.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR&&Y_(e)?"SandboxedBash":"Bash"}`
 *   (BIN308 had `if(e.command){let n=J1e(e.command);if(n)return BDe(...)}`).
 * - telemetry `getFileExtensionsFromBashCommand` equivalent: BIN308
 *   `DQs(Fi.command,e.name===je?Fi._simulatedSedEdit?.filePath:void 0)`
 *   @252175104 → BIN309 `Qei(Yi.command)` single-arg @253116000-region; the
 *   BIN309 `Qei` definition @243403911 is 1-parameter
 *   (`function Qei(e){if(!e.includes("."))return;...`).
 * - RETAINED in BIN309 (defensive name-based strips only, 6 total
 *   `_simulatedSedEdit` hits): omit-list constant
 *   `HTr=[...z$e,"run_in_background","_simulatedSedEdit"]` @249206182 (the
 *   omit helper `DTr` filters `s in e.shape`, so the name is inert), the
 *   remote-execution allow-branch strip @250768466, const
 *   `dmr="_simulatedSedEdit"` @267151548, string-table @121726132, and an
 *   engine error-message string @126441241.
 * - KEPT unchanged in both binaries (NOT part of this removal): the sed
 *   read-only/permission infra (`sedValidation.ts` — `checkSedConstraints` /
 *   `sedCommandIsAllowedByAllowlist` strings verified present in both) and the
 *   bashEditDiff infra (5/5 + 25/25 marker hits unchanged 308→309).
 */

const SED_CMD = "sed -i 's/alpha/beta/' notes.txt"

describe('2.1.309 #52 — sed -i gets the standard Bash treatment', () => {
  test('userFacingName returns "Bash" for a sed -i command (no file-edit rename)', () => {
    // Arrange
    const input = { command: SED_CMD }

    // Act
    const name = BashTool.userFacingName?.(input)

    // Assert — BIN309 userFacingName has no sed branch: always
    // "Bash" (or "SandboxedBash" behind the indicator env, off here).
    expect(name).toBe('Bash')
  })

  test('userFacingName still returns "Bash" without input and for plain commands', () => {
    expect(BashTool.userFacingName?.(undefined)).toBe('Bash')
    expect(BashTool.userFacingName?.({ command: 'ls -la' })).toBe('Bash')
  })

  test('renderToolUseMessage shows the command text, not the target file path', () => {
    // Act
    const rendered = renderToolUseMessage(
      { command: SED_CMD },
      { verbose: false, theme: 'dark' },
    )

    // Assert — the sed branch (getDisplayPath(filePath)) is gone; a short
    // non-verbose command renders verbatim.
    expect(rendered).toBe(SED_CMD)
  })

  test('model-facing inputSchema still parses a plain command', () => {
    const parsed = BashTool.inputSchema.parse({ command: 'echo hi' })
    expect(parsed.command).toBe('echo hi')
  })

  test('sedEditParser module is retired (official removed the parser)', async () => {
    await expect(import('../sedEditParser.js')).rejects.toThrow()
  })

  test('SedEditPermissionRequest module is retired (official removed the preview)', async () => {
    await expect(
      import(
        '../../../components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.js'
      ),
    ).rejects.toThrow()
  })

  test('telemetry extension extractor is single-arg (official Qei(e) @243403911)', () => {
    // BIN308 DQs(e,n) took the simulated-sed filePath as a 2nd arg; BIN309
    // Qei(e) is 1-parameter.
    expect(getFileExtensionsFromBashCommand.length).toBe(1)
    expect(getFileExtensionsFromBashCommand('cat report.md')).toBe('md')
    expect(getFileExtensionsFromBashCommand('echo hi')).toBeUndefined()
  })
})
