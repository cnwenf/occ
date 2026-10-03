// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the official A4o message contains a literal bash `${NAME:?}` guard idiom, not a JS template placeholder.
import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import {
  extractInlineShellScripts,
  findDangerousInlineShellRm,
  INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR,
  INLINE_SHELL_RULE_DENIED_MESSAGE,
  INLINE_SHELL_RULE_DENIED_REASON,
  INLINE_SHELL_RUNTIME_TARGET_MESSAGE,
  INLINE_SHELL_RUNTIME_TARGET_REASON,
  INLINE_SHELL_UNCHECKED_MESSAGE,
  INLINE_SHELL_UNCHECKED_REASON,
} from '../inlineShellRm.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.288 changelog #54 (anthropics/claude-code#96300):
 * "Fixed a dangerous rm (such as one on / or the home directory) inside a
 * bash -c or sh -c script running without a prompt in bypassPermissions mode
 * or under a shell allow rule."
 *
 * Official subsystem (byte-verified against the 2.1.288 linux-x64 ELF
 * dumps): `pue` kill-switch gate → `C4o` extractor (argv0 /^(?:r?ba)?sh$/
 * after safe/privilege wrapper stripping + `-c` or combined short flag
 * cluster containing c) → `ZYt`/`DYt` walker re-judging the extracted
 * script (depth cap `P4o`=8) → forced non-bypassable ask `uue` /
 * runtime-target rewrite `A4o`, all carrying decisionReason
 * {type:'safetyCheck', classifierApprovable:!1,
 * circuitBreaker:'dangerousRemoval'} + telemetry uL('inline_shell_script')
 * / uL('inline_shell_unchecked').
 *
 * OCC approximation (documented divergences in inlineShellRm.ts):
 * string-level extractor, existing detectors + runtime-value target scan
 * for the re-judgment, and deny-in-all-modes through the established
 * dangerousRmAutoDeny resolver ($0t envelope) instead of ask.
 */

// ── Official verbatim strings (byte-exact from the 2.1.288 ELF dumps) ──
const OFFICIAL_A4O_MESSAGE =
  'Dangerous rm operation in a shell -c script: its target is built from a variable or command output known only when it runs, and if that is empty the rm can reach a directory like / or your home directory. This requires explicit approval and cannot be auto-allowed by permission rules. Pass a literal path, or guard the value with ${NAME:?}.'
const OFFICIAL_A4O_REASON =
  'Dangerous rm operation in a shell -c script, on a target built from a value known only when it runs'
const OFFICIAL_UNCHECKED_MESSAGE =
  'This command passes a shell -c script that runs rm, and Claude Code could not check the script for dangerous removals. Approve only if you have read the script.'
const OFFICIAL_UNCHECKED_REASON =
  'This shell -c script runs rm and could not be checked'
const OFFICIAL_RULE_DENIED_MESSAGE =
  'A permission rule denies a command inside this shell -c script, so Claude Code could not check it for dangerous removals. Approving runs the whole script, including that command.'
const OFFICIAL_RULE_DENIED_REASON =
  'A permission rule denies a command in this shell -c script'

// The 7 demonstrated-gap shapes from the #54 task: before this port ALL of
// them returned null from findCatastrophicSubstitutionBlock AND
// findDestructiveCommandBlock on the full command text, so they ran without
// a prompt under bypassPermissions / shell allow rules.
const GAP_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['bash -c "rm -rf /"', 'shape 1: literal root rm inside bash -c'],
  ["sh -c 'rm -rf ~'", 'shape 2: literal home rm inside sh -c'],
  ['bash -c "rm -rf $UNSET/*"', 'shape 3: unset-var glob inside bash -c'],
  ['bash -c \'D="$HOME"; rm -rf "$D"\'', 'shape 4: home via assignment'],
  [
    'bash -c \'target=$(cat /tmp/x); rm -rf "$target"\'',
    'shape 5: target from command output',
  ],
  ['bash -lc "rm -rf /tmp/../../etc"', 'shape 6: traversal via -lc cluster'],
  ['env bash -c "rm -rf $HOME"', 'shape 7: env wrapper + $HOME'],
]

const OFFICIAL_FAMILY_TEXTS: readonly string[] = [
  OFFICIAL_A4O_MESSAGE,
  OFFICIAL_UNCHECKED_MESSAGE,
  OFFICIAL_RULE_DENIED_MESSAGE,
]

function makeContext(
  mode: string,
  cliArgAllowRules: readonly string[] = [],
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      alwaysAllowRules: { cliArg: [...cliArgAllowRules] },
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

describe('2.1.288 #54 message constants are byte-exact official text', () => {
  test('A4o runtime-target message matches the official binary', () => {
    expect(INLINE_SHELL_RUNTIME_TARGET_MESSAGE).toBe(OFFICIAL_A4O_MESSAGE)
  })

  test('A4o runtime-target reason matches the official binary', () => {
    expect(INLINE_SHELL_RUNTIME_TARGET_REASON).toBe(OFFICIAL_A4O_REASON)
  })

  test('uue unchecked message matches the official binary', () => {
    expect(INLINE_SHELL_UNCHECKED_MESSAGE).toBe(OFFICIAL_UNCHECKED_MESSAGE)
  })

  test('uue unchecked reason matches the official binary', () => {
    expect(INLINE_SHELL_UNCHECKED_REASON).toBe(OFFICIAL_UNCHECKED_REASON)
  })

  test('uue rule-denied message matches the official binary (staged constant)', () => {
    expect(INLINE_SHELL_RULE_DENIED_MESSAGE).toBe(OFFICIAL_RULE_DENIED_MESSAGE)
  })

  test('uue rule-denied reason matches the official binary (staged constant)', () => {
    expect(INLINE_SHELL_RULE_DENIED_REASON).toBe(OFFICIAL_RULE_DENIED_REASON)
  })

  test('kill-switch env var name matches the official pue gate', () => {
    expect(INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR).toBe(
      'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT',
    )
  })
})

describe('2.1.288 #54 extractInlineShellScripts (official C4o extractor)', () => {
  test('extracts the script argument from bash -c', () => {
    // Arrange
    const command = 'bash -c "rm -rf /"'

    // Act
    const extracted = extractInlineShellScripts(command)

    // Assert
    expect(extracted.map((entry) => entry.script)).toEqual(['rm -rf /'])
  })

  test('extracts from sh -c with single quotes', () => {
    const extracted = extractInlineShellScripts("sh -c 'rm -rf ~'")
    expect(extracted.map((entry) => entry.script)).toEqual(['rm -rf ~'])
  })

  test('extracts through a combined short flag cluster containing c (-lc)', () => {
    const extracted = extractInlineShellScripts('bash -lc "echo hi"')
    expect(extracted.map((entry) => entry.script)).toEqual(['echo hi'])
  })

  test('extracts through safe wrappers (env / time) and privilege wrappers (sudo)', () => {
    expect(
      extractInlineShellScripts('env bash -c "echo x"').map((e) => e.script),
    ).toEqual(['echo x'])
    expect(
      extractInlineShellScripts('time sh -c "echo y"').map((e) => e.script),
    ).toEqual(['echo y'])
    expect(
      extractInlineShellScripts('sudo bash -c "echo z"').map((e) => e.script),
    ).toEqual(['echo z'])
  })

  test('extracts through the busybox/toybox applet prefix', () => {
    const extracted = extractInlineShellScripts('busybox sh -c "echo b"')
    expect(extracted.map((entry) => entry.script)).toEqual(['echo b'])
  })

  test('extracts from every shell segment of a compound command', () => {
    const extracted = extractInlineShellScripts(
      'ls && bash -c "echo a" ; sh -c "echo b"',
    )
    expect(extracted.map((entry) => entry.script)).toEqual(['echo a', 'echo b'])
  })

  test('returns nothing for non-shell commands', () => {
    expect(extractInlineShellScripts('echo hi')).toEqual([])
  })

  test('returns nothing for a shell script file invocation without -c', () => {
    expect(extractInlineShellScripts('bash script.sh')).toEqual([])
  })

  test('returns nothing when a positional argument precedes -c (bash runs the file, -c is data)', () => {
    expect(extractInlineShellScripts('bash script.sh -c "rm -rf /"')).toEqual(
      [],
    )
  })

  test('returns nothing for shells outside the official /^(?:r?ba)?sh$/ set (zsh)', () => {
    // Official C4o matches sh/bash/rsh/rbash only.
    expect(extractInlineShellScripts('zsh -c "rm -rf /"')).toEqual([])
  })

  test('marks ANSI-C quoted segments for the official escape bail', () => {
    const extracted = extractInlineShellScripts(
      String.raw`bash -c $'\x72m -rf /'`,
    )
    expect(extracted.length).toBe(1)
    expect(extracted[0]!.ansiCQuoted).toBe(true)
    expect(extracted[0]!.ansiCHexEscaped).toBe(true)
  })
})

describe('2.1.288 #54 demonstrated gap shapes (all must block)', () => {
  for (const [command, label] of GAP_SHAPES) {
    test(`blocks ${label}: ${command}`, () => {
      // Act
      const block = findDangerousInlineShellRm(command)

      // Assert
      expect(block).not.toBeNull()
      expect(block!.kind === 'inline_shell_script' || block!.kind === 'inline_shell_unchecked').toBe(true)
      const isOfficialText =
        OFFICIAL_FAMILY_TEXTS.includes(block!.message) ||
        block!.message.startsWith('Destructive command blocked: ') ||
        block!.message.startsWith('Dangerous rm operation')
      expect(isOfficialText).toBe(true)
    })
  }

  test('shape 6 (traversal to /etc) surfaces the verbatim uue unchecked text', () => {
    const block = findDangerousInlineShellRm('bash -lc "rm -rf /tmp/../../etc"')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('inlineShellUnchecked')
    expect(block!.message).toBe(OFFICIAL_UNCHECKED_MESSAGE)
    expect(block!.reason).toBe(OFFICIAL_UNCHECKED_REASON)
  })

  test('shape 5 (target from command output) surfaces the verbatim A4o runtime-target text', () => {
    const block = findDangerousInlineShellRm(
      'bash -c \'target=$(cat /tmp/x); rm -rf "$target"\'',
    )
    expect(block).not.toBeNull()
    expect(block!.category).toBe('inlineShellRuntimeTarget')
    expect(block!.message).toBe(OFFICIAL_A4O_MESSAGE)
    expect(block!.reason).toBe(OFFICIAL_A4O_REASON)
    expect(block!.kind).toBe('inline_shell_script')
  })
})

describe('2.1.288 #54 safe negatives (must NOT block)', () => {
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['bash -c "echo hi"', 'non-rm script'],
    ['bash -c "rm file.txt"', 'relative literal file rm'],
    ['bash -c "rm -rf build/dist"', 'relative literal directory rm'],
    ['bash -c \'D=build; rm -rf "$D"\'', 'safe-literal assignment resolution'],
    ['bash -c "ls -la /tmp"', 'non-rm verb on absolute path'],
    ['rm -rf /', 'bare rm without a shell wrapper (legacy gates own it)'],
    ['echo rm', 'rm as an echo argument, no shell -c'],
    ['bash -c "echo rm"', 'rm as an echo argument inside the script'],
    ['bash script.sh', 'shell script file, no -c'],
    ['bash -c "rm -rf ./node_modules"', 'project-relative recursive rm'],
  ]
  for (const [command, label] of negatives) {
    test(`allows: ${label}`, () => {
      expect(findDangerousInlineShellRm(command)).toBeNull()
    })
  }
})

describe('2.1.288 #54 unchecked constructs (official uue forced-ask family)', () => {
  test('eval inside the script with an rm verb → uue unchecked', () => {
    const block = findDangerousInlineShellRm(`bash -c 'eval "rm -rf /"'`)
    expect(block).not.toBeNull()
    expect(block!.category).toBe('inlineShellUnchecked')
    expect(block!.kind).toBe('inline_shell_unchecked')
    expect(block!.message).toBe(OFFICIAL_UNCHECKED_MESSAGE)
  })

  test('ANSI-C hex-escaped script ($\'\\x72m …\') → uue unchecked even though rm is invisible', () => {
    const block = findDangerousInlineShellRm(
      String.raw`bash -c $'\x72m -rf /'`,
    )
    expect(block).not.toBeNull()
    expect(block!.category).toBe('inlineShellUnchecked')
    expect(block!.message).toBe(OFFICIAL_UNCHECKED_MESSAGE)
  })

  test('plain ANSI-C quoted rm ($\'rm …\') → uue unchecked', () => {
    const block = findDangerousInlineShellRm(`bash -c $'rm -rf /'`)
    expect(block).not.toBeNull()
    expect(block!.category).toBe('inlineShellUnchecked')
    expect(block!.message).toBe(OFFICIAL_UNCHECKED_MESSAGE)
  })

  test('read-tainted variable feeding rm blocks (official OBe taint / unresolved value)', () => {
    const block = findDangerousInlineShellRm(
      'bash -c \'read -r D < /tmp/x; rm -rf "$D"\'',
    )
    expect(block).not.toBeNull()
    expect(OFFICIAL_FAMILY_TEXTS).toContain(block!.message)
  })
})

describe('2.1.288 #54 nested shell -c recursion', () => {
  test('nested bash -c with a literal root rm blocks', () => {
    const block = findDangerousInlineShellRm(
      `bash -c "bash -c 'rm -rf /'"`,
    )
    expect(block).not.toBeNull()
  })

  test('nested bash -c with a runtime-target rm blocks with A4o text', () => {
    const block = findDangerousInlineShellRm(
      `bash -c 'cd /tmp; bash -c "rm -rf \\$D"'`,
    )
    expect(block).not.toBeNull()
    expect(block!.message).toBe(OFFICIAL_A4O_MESSAGE)
  })
})

describe('2.1.288 #54 kill switch (official pue raw-truthiness gate)', () => {
  const ENV_KEY = INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR

  test("any non-empty value disables the guard — even '0' (raw truthiness)", () => {
    const saved = process.env[ENV_KEY]
    try {
      process.env[ENV_KEY] = '0'
      expect(findDangerousInlineShellRm('bash -c "rm -rf /"')).toBeNull()
      process.env[ENV_KEY] = '1'
      expect(findDangerousInlineShellRm('bash -c "rm -rf /"')).toBeNull()
      process.env[ENV_KEY] = 'false'
      expect(findDangerousInlineShellRm('bash -c "rm -rf /"')).toBeNull()
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  })

  test('empty value keeps the guard enabled', () => {
    const saved = process.env[ENV_KEY]
    try {
      process.env[ENV_KEY] = ''
      expect(findDangerousInlineShellRm('bash -c "rm -rf /"')).not.toBeNull()
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  })
})

describe('2.1.288 #54 bashToolHasPermission integration (deny in ALL modes)', () => {
  // The #54 gate rides the established dangerousRmAutoDeny resolver, so the
  // user-visible message is the official $0t auto-deny envelope with the
  // #54 verdict text embedded as the "What was flagged:" tail.
  const AUTO_DENY_ENVELOPE_PREFIX =
    /^Permission for this command was denied by a built-in Claude Code safety check/

  test('bash -c "rm -rf /" is denied in default mode with the safetyCheck circuit-breaker reason', async () => {
    // Act
    const result = await bashToolHasPermission(
      { command: 'bash -c "rm -rf /"', description: '' } as never,
      makeContext('default'),
    )

    // Assert
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(AUTO_DENY_ENVELOPE_PREFIX)
    const reason = (
      result as {
        decisionReason?: {
          type?: string
          classifierApprovable?: boolean
          circuitBreaker?: string
        }
      }
    ).decisionReason
    expect(reason?.type).toBe('safetyCheck')
    expect(reason?.classifierApprovable).toBe(false)
    expect(reason?.circuitBreaker).toBe('dangerousRemoval')
  })

  test('shape 3 ($UNSET/*) is denied even under bypassPermissions with the A4o text in the envelope', async () => {
    const result = await bashToolHasPermission(
      { command: 'bash -c "rm -rf $UNSET/*"', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(AUTO_DENY_ENVELOPE_PREFIX)
    expect(result.message).toContain(OFFICIAL_A4O_MESSAGE)
  })

  test('shape 5 (command-output target) is denied under bypassPermissions with the A4o text', async () => {
    const result = await bashToolHasPermission(
      {
        command: 'bash -c \'target=$(cat /tmp/x); rm -rf "$target"\'',
        description: '',
      } as never,
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(AUTO_DENY_ENVELOPE_PREFIX)
    expect(result.message).toContain(OFFICIAL_A4O_MESSAGE)
  })

  test('shape 6 (traversal via -lc) is denied under bypassPermissions with the uue text', async () => {
    const result = await bashToolHasPermission(
      { command: 'bash -lc "rm -rf /tmp/../../etc"', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(AUTO_DENY_ENVELOPE_PREFIX)
    expect(result.message).toContain(OFFICIAL_UNCHECKED_MESSAGE)
  })

  test('a permissive Bash(bash:*) allow rule cannot auto-allow shape 1', async () => {
    const result = await bashToolHasPermission(
      { command: 'bash -c "rm -rf /"', description: '' } as never,
      makeContext('default', ['Bash(bash:*)']),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(AUTO_DENY_ENVELOPE_PREFIX)
  })

  test('a permissive Bash(sh:*) allow rule cannot auto-allow shape 2', async () => {
    const result = await bashToolHasPermission(
      { command: "sh -c 'rm -rf ~'", description: '' } as never,
      makeContext('default', ['Bash(sh:*)']),
    )
    expect(result.behavior).toBe('deny')
  })

  test('safe script bash -c "echo hi" is not denied under bypassPermissions (no over-block)', async () => {
    const result = await bashToolHasPermission(
      { command: 'bash -c "echo hi"', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    // passthrough = the bash-specific gates declined; the generic bypass
    // flow auto-allows. The #54 contract is that the gate must NOT deny.
    expect(['allow', 'passthrough']).toContain(result.behavior)
  })

  test('safe script bash -c "rm file.txt" is not denied by the #54 gate under bypassPermissions', async () => {
    const result = await bashToolHasPermission(
      { command: 'bash -c "rm file.txt"', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    expect(['allow', 'passthrough']).toContain(result.behavior)
  })
})
