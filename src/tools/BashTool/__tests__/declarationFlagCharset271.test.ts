import { describe, expect, test } from 'bun:test'
import { parseForSecurityFromAst } from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.271 fix C — "Fixed Bash permission checks so that shell
 * variable declaration flags cannot misrepresent the command being run."
 *
 * Byte-verified against the official 2.1.272 linux-x64 ELF (forensics in
 * /tmp/cc-diff-126): the declaration_command handler's flag charsets were
 * widened from 2.1.270's `[niaAEF]` (declare/typeset/local) and `[iEF]`
 * (export/readonly) to:
 *   - declare/typeset/local: /^[+-].*[nialuAEFLRZ]/  — reason:
 *     `declare flag ${D} changes assignment semantics
 *      (nameref/integer/float/array/width-truncation/case-conversion)`
 *   - export/readonly: /^[+-].*[iluEFLRZ]/  — reason:
 *     `${x[0]} flag ${D} — zsh bin_typeset mathevals (-i/-E/-F),
 *      width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`
 * The added letters (l, u, L, R, Z) are exactly the flags that MUTATE the
 * assigned value (case conversion, width truncation/zero padding), so a
 * tracked `NAME=value` literal misrepresents what a later `$var` expansion
 * yields — the misrepresentation this fix closes.
 *
 * OCC's live permission path never parses declarations (the shell-quote
 * legacy path treats them as opaque subcommands → ask; command
 * substitution → ask), so the live surface was already fail-closed — the
 * pins below lock that in. The dormant AST path (parseForSecurityFromAst,
 * exercised directly here and enabled when TREE_SITTER_BASH lands in the
 * feature allowlist) had the narrower `/^-[a-zA-Z]*[niaA]/` charset and no
 * export/readonly branch — a real parity gap with official 2.1.270 AND
 * 2.1.272, now closed with byte-exact reason strings.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

function makeContext(allowRules: string[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { cliArg: allowRules },
    },
  } as never
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

const DECLARE_REASON = (flag: string) =>
  `declare flag ${flag} changes assignment semantics (nameref/integer/float/array/width-truncation/case-conversion)`
const EXPORT_REASON = (cmd: string, flag: string) =>
  `${cmd} flag ${flag} — zsh bin_typeset mathevals (-i/-E/-F), width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`

describe('2.1.271 fix C — AST declaration flags: widened value-mutating charset (was simple, must be too-complex)', () => {
  test.each([
    ['declare -l x=FOO', 'declare', '-l'],
    ['typeset -u y=bar', 'typeset', '-u'],
    ['declare -L5 x=y', 'declare', '-L5'],
    ['declare -R3 z=v', 'declare', '-R3'],
    ['declare -Z2 w=v', 'declare', '-Z2'],
    ['local -l y=2', 'declare', '-l'],
  ])('%s → too-complex (declare-family reason)', (cmd, _family, flag) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: DECLARE_REASON(flag),
      nodeType: 'declaration_command',
    })
  })

  test.each([
    ['export -i X=1', 'export', '-i'],
    ['export -l Y=z', 'export', '-l'],
    ['readonly -u R=v', 'readonly', '-u'],
    ['readonly -L4 S=t', 'readonly', '-L4'],
  ])('%s → too-complex (export/readonly bin_typeset reason)', (cmd, declCmd, flag) => {
    const r = parseSecurity(cmd)
    expect(r.kind).toBe('too-complex')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: EXPORT_REASON(declCmd, flag),
      nodeType: 'declaration_command',
    })
  })

  test('plus-form flags are matched too: declare +l x=y → too-complex', () => {
    const r = parseSecurity('declare +l x=y')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: DECLARE_REASON('+l'),
      nodeType: 'declaration_command',
    })
  })
})

describe('2.1.271 fix C — AST declaration flags: no regressions on pre-existing behavior', () => {
  test('declare -n X=Y still too-complex, now with the widened reason', () => {
    const r = parseSecurity('declare -n X=Y')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: DECLARE_REASON('-n'),
      nodeType: 'declaration_command',
    })
  })

  test('declare -i N=5 still too-complex (integer attr predates this fix)', () => {
    const r = parseSecurity('declare -i N=5')
    expect(r.kind).toBe('too-complex')
    expect(r).toMatchObject({ nodeType: 'declaration_command' })
  })

  test('declare -x FOO=1 stays simple (export attr does not mutate the value)', () => {
    expect(parseSecurity('declare -x FOO=1').kind).toBe('simple')
  })

  test('export FOO=bar stays simple (plain assignment tracking)', () => {
    expect(parseSecurity('export FOO=bar').kind).toBe('simple')
  })

  test('local -r y=2 stays simple (readonly attr does not mutate the value)', () => {
    expect(parseSecurity('local -r y=2').kind).toBe('simple')
  })
})

describe('2.1.271 fix C — LIVE path pins (task probes): fail-closed by default, official parity under rules', () => {
  // Default mode: no allow rules → the live shell-quote path never parses
  // declarations, so the whole probe yields no bash-specific allow and falls
  // through ('passthrough') to the outer permission flow, which asks by
  // default. Fail-closed = never auto-allowed by the Bash tool itself.
  test('declare -x FOO=1 cat /etc/passwd is not auto-allowed in default mode', async () => {
    const r = await bashToolHasPermission(
      { command: 'declare -x FOO=1 cat /etc/passwd' } as never,
      makeContext([]),
    )
    expect(r.behavior).not.toBe('allow')
  })

  test('export X=$(cat /etc/passwd) asks (command substitution, fail-closed)', async () => {
    const r = await bashToolHasPermission(
      { command: 'export X=$(cat /etc/passwd)' } as never,
      makeContext(['Bash(export *)']),
    )
    expect(r.behavior).not.toBe('allow')
  })

  test('local -x y=2 head /etc/shadow is not auto-allowed in default mode', async () => {
    const r = await bashToolHasPermission(
      { command: 'local -x y=2 head /etc/shadow' } as never,
      makeContext([]),
    )
    expect(r.behavior).not.toBe('allow')
  })

  // Official parity (byte-verified 2.1.272 declaration_command handler):
  // non-assignment operands (`cat`, `/etc/passwd`) are merely pushed onto
  // argv — no path check, no too-complex — and `declare` is not a
  // path-restricted command (K4o passthrough), so official ALSO allows this
  // under a declare prefix rule. Bash never executes `cat` here (it is an
  // invalid variable name → declare errors), so no read occurs. OCC matches.
  test('declare -x FOO=1 cat /etc/passwd under Bash(declare *) allows — matches official (no file is read)', async () => {
    const r = await bashToolHasPermission(
      { command: 'declare -x FOO=1 cat /etc/passwd' } as never,
      makeContext(['Bash(declare *)']),
    )
    expect(r.behavior).toBe('allow')
  })
})
