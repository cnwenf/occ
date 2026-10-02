import { describe, expect, test } from 'bun:test'
import {
  NODE_TYPE_EXPLANATIONS,
  parseForSecurityFromAst,
  tooComplex,
} from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'
import type { Node } from '../../../utils/bash/parser.js'

/**
 * CC 2.1.287 — behavioral evidence for the official changelog entry
 * "Fixed Bash permission prompts showing internal parser names such as
 * 'Contains simple_expansion' instead of a plain explanation".
 *
 * Byte-exact port of the official 2.1.287 `_()` too-complex builder and its
 * `Rt` node-type → plain-English explanation map (26 entries), recovered
 * verbatim from the v287 ELF — see docs/gap-research-287/cluster-d2-misc.md
 * #6 (rank-1 PORT-CANDIDATE). The v286 shape OCC previously matched
 * (`Contains ${type}` for DANGEROUS_TYPES, `Unhandled node type: ${type}`
 * otherwise) leaked raw tree-sitter names through
 * `bashPermissions.ts` → `createPermissionRequestMessage` into the prompt.
 *
 * The unmapped-type branch of the official builder is a defensive fallback:
 * every node type the OCC walker currently routes to tooComplex() is covered
 * by the 26-entry map (verified by exhaustive probing), so that branch is
 * unit-tested directly via a synthetic node instead of a real command.
 *
 * Harness mirrors specialVarLoops274.test.ts.
 */

function parseSecurity(cmd: string) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(cmd, root!)
}

// tooComplex() reads only node.type — a synthetic node is sufficient.
const nodeOfType = (type: string): Node => ({ type }) as unknown as Node

describe('2.1.287 #6: NODE_TYPE_EXPLANATIONS — official `Rt` map, 26 byte-exact entries', () => {
  test('has exactly 26 entries in official insertion order', () => {
    expect(NODE_TYPE_EXPLANATIONS.size).toBe(26)
    expect([...NODE_TYPE_EXPLANATIONS.keys()]).toEqual([
      'simple_expansion',
      'expansion',
      'command_substitution',
      'process_substitution',
      'brace_expression',
      'ansi_c_string',
      'translated_string',
      'test_command',
      'herestring_redirect',
      'heredoc_redirect',
      'subshell',
      'compound_statement',
      'for_statement',
      'c_style_for_statement',
      'while_statement',
      'until_statement',
      'if_statement',
      'case_statement',
      'function_definition',
      'array',
      'string',
      'file_redirect',
      'pipeline',
      'concatenation',
      'variable_assignment',
      'variable_assignments',
    ])
  })

  test('every explanation is byte-exact from the official v287 `Rt` map', () => {
    expect([...NODE_TYPE_EXPLANATIONS.entries()]).toEqual([
      ['simple_expansion', 'a variable'],
      ['expansion', 'a variable in braces'],
      ['command_substitution', 'the output of another command'],
      ['process_substitution', 'another command used as a file'],
      ['brace_expression', 'a brace pattern'],
      ['ansi_c_string', 'text with escape codes'],
      ['translated_string', 'text the shell may translate'],
      ['test_command', 'a test in brackets'],
      ['herestring_redirect', 'a here-string'],
      ['heredoc_redirect', 'a here-document'],
      ['subshell', 'a group of commands in parentheses'],
      ['compound_statement', 'a group of commands in braces or double parentheses'],
      ['for_statement', 'a for or select loop'],
      ['c_style_for_statement', 'a for loop with a counter'],
      ['while_statement', 'a while or until loop'],
      ['until_statement', 'an until loop'],
      ['if_statement', 'an if statement'],
      ['case_statement', 'a case statement'],
      ['function_definition', 'a function definition'],
      ['array', 'a list of values'],
      ['string', 'quoted text'],
      ['file_redirect', 'a redirect to or from a file'],
      ['pipeline', 'a pipeline'],
      ['concatenation', 'text joined from several pieces'],
      ['variable_assignment', 'a variable assignment'],
      ['variable_assignments', 'several variable assignments'],
    ])
  })
})

describe('2.1.287 #6: tooComplex() — official v287 `_()` builder shape', () => {
  test('simple_expansion → "(a variable)" plain-language reason', () => {
    expect(tooComplex(nodeOfType('simple_expansion'))).toEqual({
      kind: 'too-complex',
      reason: 'Part of this command (a variable) cannot be checked in advance',
      nodeType: 'simple_expansion',
    })
  })

  test('ERROR → "Parse error" (v286 behavior preserved)', () => {
    expect(tooComplex(nodeOfType('ERROR'))).toEqual({
      kind: 'too-complex',
      reason: 'Parse error',
      nodeType: 'ERROR',
    })
  })

  test('unmapped node type → generic message (defensive fallback)', () => {
    expect(tooComplex(nodeOfType('some_future_unmapped_node'))).toEqual({
      kind: 'too-complex',
      reason: 'Part of this command cannot be checked in advance',
      nodeType: 'some_future_unmapped_node',
    })
  })

  test('no mapped type leaks the raw parser name (v286 "Contains X" is gone)', () => {
    for (const type of NODE_TYPE_EXPLANATIONS.keys()) {
      const r = tooComplex(nodeOfType(type))
      expect(r.kind).toBe('too-complex')
      if (r.kind === 'too-complex') {
        expect(r.reason).not.toContain('Contains ')
        expect(r.reason).not.toContain('Unhandled node type')
        expect(r.nodeType).toBe(type)
      }
    }
  })
})

describe('2.1.287 #6: end-to-end through parseForSecurityFromAst', () => {
  test('for f in "$@" → too-complex with the plain-language reason', () => {
    const r = parseSecurity('for f in "$@"; do echo x; done')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe(
        'Part of this command (a variable) cannot be checked in advance',
      )
      expect(r.nodeType).toBe('simple_expansion')
    }
  })

  test('malformed command (ERROR node) → "Parse error"', () => {
    const r = parseSecurity('echo )')
    expect(r.kind).toBe('too-complex')
    if (r.kind === 'too-complex') {
      expect(r.reason).toBe('Parse error')
      expect(r.nodeType).toBe('ERROR')
    }
  })

  test('previously-unhandled types (array / c_style_for) now get mapped reasons', () => {
    const arr = parseSecurity('x=(1 2 3)')
    expect(arr.kind).toBe('too-complex')
    if (arr.kind === 'too-complex') {
      expect(arr.reason).toBe(
        'Part of this command (a list of values) cannot be checked in advance',
      )
      expect(arr.nodeType).toBe('array')
    }
    const cfor = parseSecurity('for ((i=0;i<3;i++)); do echo $i; done')
    expect(cfor.kind).toBe('too-complex')
    if (cfor.kind === 'too-complex') {
      expect(cfor.reason).toBe(
        'Part of this command (a for loop with a counter) cannot be checked in advance',
      )
      expect(cfor.nodeType).toBe('c_style_for_statement')
    }
  })
})
