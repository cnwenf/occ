import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import {
  findCatastrophicSubstitutionBlock,
  findSubstitutionTargetBlock,
  normalizeCommandSubstitutions,
} from '../destructiveCommandWarning.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.281 dangerous-rm substitution-target guard (`gFt` pipeline).
 *
 * Byte-verified against the official v2.1.281 linux-x64 ELF (md5
 * d00df59384be94d0b5cac74849540075). v2.1.281 hardened the guard against
 * the attack shape where the rm TARGET ITSELF is command-substitution
 * output — `rm -rf "$(pwd)"` deletes the working directory and no static
 * target check can see it before the substitution runs.
 *
 * Pipeline (official order): substitutions normalize to `__CMDSUB__`
 * (backticks → `$(…)` fixpoint ≤16 → `${VAR:-…}` collapse), argv[0] is
 * basenamed (NEW in 281), safe wrappers (`Rp`) then privilege wrappers
 * (`aFt`) are stripped, the verb resolves via `Zw`, and the rm/rmdir args
 * are checked: literalTarget → emptyExpansion (tail strip + residual
 * dangerous-path check) → wholeSubstitution (recursive rm whose target is
 * purely substitution output), the last gated by env
 * CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT (bare truthiness) and
 * GrowthBook `tengu_iridescent_boot` (default true; see the gateoff test
 * file for the false case).
 *
 * OCC divergences (documented in docs/upstream-version-gap-occ136.md):
 * string-level tokenizer instead of tree-sitter, deny-in-all-modes instead
 * of ask+circuitBreaker, no GrowthBook `source` discrimination.
 */

const OFFICIAL_WHOLE_SUB_MESSAGE =
  'Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints.'
const OFFICIAL_WHOLE_SUB_REASON =
  'Dangerous rm operation on statically-unresolvable target: command substitution output'

function makeContext(mode: string): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      alwaysAllowRules: { cliArg: [] },
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

describe('2.1.281 normalizeCommandSubstitutions (byte-exact gFt loops)', () => {
  test('replaces backtick substitutions in one pass', () => {
    expect(normalizeCommandSubstitutions('rm -rf `pwd`')).toBe(
      'rm -rf __CMDSUB__',
    )
  })

  test('collapses nested $(…) to a fixpoint (≤16 iterations)', () => {
    expect(normalizeCommandSubstitutions('rm -rf $(echo $(pwd))')).toBe(
      'rm -rf __CMDSUB__',
    )
  })

  test('collapses ${VAR:-$(cmd)} defaults that are pure substitution output', () => {
    expect(normalizeCommandSubstitutions('rm -r ${X:-$(cmd)}')).toBe(
      'rm -r __CMDSUB__',
    )
    expect(normalizeCommandSubstitutions('rm -r ${X:-"$(cmd)"}')).toBe(
      'rm -r __CMDSUB__',
    )
  })

  test('leaves text without substitutions unchanged', () => {
    expect(normalizeCommandSubstitutions('rm -rf /tmp/x')).toBe('rm -rf /tmp/x')
  })

  test('keeps glued path characters around the placeholder', () => {
    expect(normalizeCommandSubstitutions('rm -rf /$(pwd)/*')).toBe(
      'rm -rf /__CMDSUB__/*',
    )
  })
})

describe('2.1.281 wholeSubstitution verdict — rm target IS substitution output', () => {
  const positives: Array<[string, string]> = [
    ['rm -rf "$(pwd)"', 'the taskbook attack case (quoted)'],
    ['rm -rf $(pwd)', 'unquoted'],
    ['rm -rf `pwd`', 'backticks'],
    ["rm -rf '$(pwd)'", 'single quotes (official normalizes RAW text)'],
    ['rm -rf "$(pwd)"/*', 'quoted with glued glob tail'],
    ['rm -rf $(pwd)/', 'trailing slash'],
    ['rm -rf $(pwd)/.', 'trailing dot'],
    ['rm --recursive --force $(pwd)', 'long flags'],
    ['rm -fr $(pwd)', 'combined short flags reversed'],
    ['rm -r -f $(pwd)', 'separate short flags'],
    ['sudo rm -rf $(pwd)', 'sudo privilege wrapper'],
    ['sudo -u root rm -rf $(pwd)', 'sudo with value flag'],
    ['env FOO=1 rm -rf $(pwd)', 'env wrapper with assignment'],
    ['env -i rm -rf $(pwd)', 'env -i wrapper'],
    ['FOO=1 rm -rf $(pwd)', 'leading env assignment'],
    ['timeout 5 rm -rf $(pwd)', 'timeout wrapper'],
    ['timeout --kill-after 1s 5 rm -rf $(pwd)', 'timeout with flag'],
    ['nohup rm -rf $(pwd)', 'nohup wrapper'],
    ['time rm -rf $(pwd)', 'time wrapper'],
    ['nice -n 5 rm -rf $(pwd)', 'nice -n wrapper'],
    ['stdbuf -o0 rm -rf $(pwd)', 'stdbuf wrapper'],
    ['command rm -rf $(pwd)', 'command builtin wrapper'],
    ['/usr/bin/rm -rf $(pwd)', 'path-prefixed binary (281 basename step)'],
    ['./rm -rf $(pwd)', 'relative path binary'],
    ['rm -rf /safe/dir $(pwd)', 'sibling literal target, one whole-sub'],
    ['echo hi; rm -rf $(pwd)', 'after a semicolon'],
    ['find . -delete && rm -rf $(pwd)', 'after &&'],
    ['if true; then rm -rf $(pwd); fi', 'inside if/then (keyword skip)'],
    ['for f in x; do rm -rf $(pwd); done', 'inside for/do'],
    ['rm -r ${X:-$(cmd)}', '${VAR:-…} collapse then whole-sub'],
    ['sudo -n -- rm -rf $(pwd)', 'sudo -- separator'],
    ['exec rm -rf $(pwd)', 'exec wrapper'],
    ['flock /tmp/l rm -rf $(pwd)', 'flock positional wrapper'],
  ]
  for (const [cmd, label] of positives) {
    test(`blocks: ${label}`, () => {
      const block = findCatastrophicSubstitutionBlock(cmd)
      expect(block).not.toBeNull()
      expect(block!.kind).toBe('wholeSubstitution')
      expect(block!.category).toBe('rm_substitution_whole_target')
      // Byte-exact official jy message + reason.
      expect(block!.message).toBe(OFFICIAL_WHOLE_SUB_MESSAGE)
      expect(block!.reason).toBe(OFFICIAL_WHOLE_SUB_REASON)
    })
  }

  const negatives: Array<[string, string]> = [
    ['rm -f $(pwd)', 'no recursive flag'],
    ['rm --force $(pwd)', 'force only'],
    ['rm $(pwd)', 'bare rm'],
    ['rm -- $(pwd)', 'recursive flag absent; -- first'],
    ['rm -- -rf $(pwd)', 'recursive flag only AFTER -- (official st slice)'],
    ['rmdir $(pwd)', 'rmdir never fires wholeSubstitution (official ze==="rm")'],
    ['cp -r $(pwd) /tmp/x', 'non-rm verb'],
    ['tee $(pwd)', 'tee is in Zvo but not an rm verb'],
    ['echo rm -rf $(pwd)', 'rm inside echo args, not a command'],
    ['rm -rf $(pwd)/file.txt', 'substitution glued to a literal tail'],
    ['rm -rf dir/$(pwd)', 'substitution is only a path suffix'],
    ['rm -rf build/$(cat dir.txt)', 'scoped relative deletion'],
    ['rm -rf node_modules/$(cat ver.txt)', 'scoped relative deletion 2'],
  ]
  for (const [cmd, label] of negatives) {
    test(`allows: ${label}`, () => {
      expect(findSubstitutionTargetBlock(cmd)).toBeNull()
    })
  }
})

describe('2.1.281 emptyExpansion verdict — substitution tail may vanish', () => {
  test('blocks rm -rf /$(pwd) (residual /)', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf /$(pwd)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyExpansion')
    expect(block!.category).toBe('rm_substitution_empty_expansion')
    expect(block!.reason).toContain("'/'")
  })

  test('blocks rm -rf ~$(id -u) (residual home dir)', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf ~$(id -u)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyExpansion')
  })

  test('blocks rm -rf *$(x) (residual bare glob)', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf *$(x)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyExpansion')
  })

  test('blocks rmdir /$(pwd) (emptyExpansion applies to rmdir too)', () => {
    const block = findCatastrophicSubstitutionBlock('rmdir /$(pwd)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyExpansion')
  })

  test('allows relative residual (rm -rf dir/$(x) → dir/)', () => {
    expect(findSubstitutionTargetBlock('rm -rf dir/$(x)')).toBeNull()
  })

  test('keeps /.. traversal out of the strip (official (?!\\.\\.) guard)', () => {
    // `$(pwd)/..` is a whole-substitution shape ([/*.]* includes dots), not
    // an emptyExpansion tail — the run may not swallow `/..` segments.
    const block = findCatastrophicSubstitutionBlock('rm -rf $(pwd)/..')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('wholeSubstitution')
  })
})

describe('2.1.281 env gate CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT', () => {
  const ENV_KEY = 'CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT'

  test('any non-empty value disables the guard (bare truthiness, even "0")', () => {
    const saved = process.env[ENV_KEY]
    try {
      process.env[ENV_KEY] = '0'
      expect(findSubstitutionTargetBlock('rm -rf $(pwd)')).toBeNull()
      process.env[ENV_KEY] = '1'
      expect(findSubstitutionTargetBlock('rm -rf $(pwd)')).toBeNull()
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  })

  test('empty value keeps the guard on (official !a.X semantics)', () => {
    const saved = process.env[ENV_KEY]
    try {
      process.env[ENV_KEY] = ''
      const block = findSubstitutionTargetBlock('rm -rf $(pwd)')
      expect(block).not.toBeNull()
      expect(block!.kind).toBe('wholeSubstitution')
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  })

  test('the env gate does not disable the other substitution verdicts', () => {
    const saved = process.env[ENV_KEY]
    try {
      process.env[ENV_KEY] = '1'
      expect(findCatastrophicSubstitutionBlock('echo $(rm -rf /)')).not.toBeNull()
      expect(findCatastrophicSubstitutionBlock('rm -rf $UNSET/*')).not.toBeNull()
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  })
})

describe('2.1.281 wrapper-strip + tokenizer branch coverage', () => {
  const wrapperPositives: Array<[string, string]> = [
    ['timeout -- 5 rm -rf $(pwd)', 'timeout "--" then duration (FMe r==="--")'],
    ['nice -5 rm -rf $(pwd)', 'nice -N numeric form'],
    ['nice -n 5 -- rm -rf $(pwd)', 'nice -n N -- separator'],
    ['builtin rm -rf $(pwd)', 'builtin wrapper'],
    ['builtin -- rm -rf $(pwd)', 'builtin -- wrapper'],
    ['noglob rm -rf $(pwd)', 'noglob wrapper (zsh)'],
    ['doas rm -rf $(pwd)', 'doas wrapper'],
    ['pkexec rm -rf $(pwd)', 'pkexec wrapper'],
    ['setsid rm -rf $(pwd)', 'setsid wrapper'],
    ['taskset -c 0 rm -rf $(pwd)', 'taskset value flag + positional mask'],
    ['chrt -f 10 rm -rf $(pwd)', 'chrt flag + numeric positional'],
    ['ionice -c3 rm -rf $(pwd)', 'ionice glued value flag'],
    ['strace -o /tmp/log rm -rf $(pwd)', 'strace value flag'],
    ['ltrace -o /tmp/log rm -rf $(pwd)', 'ltrace value flag'],
    ['watch -n 1 rm -rf $(pwd)', 'watch interval flag'],
    ['unshare rm -rf $(pwd)', 'unshare wrapper'],
    ['nsenter -t 1 rm -rf $(pwd)', 'nsenter value flag'],
    ['exec -a name rm -rf $(pwd)', 'exec -a value flag'],
    ['command -p rm -rf $(pwd)', 'command -p POSIX flag (Rp)'],
    ['flock -- /tmp/l rm -rf $(pwd)', 'flock positional AFTER -- (aFt)'],
    ['sudo nice -n 5 rm -rf $(pwd)', 'nested time-family inside aFt (uEo)'],
    ['sudo nohup -- rm -rf $(pwd)', 'nohup -- inside aFt time-family strip'],
    ['env -S "" rm -rf $(pwd)', 'env -S with empty command string'],
    ['env --split-string= rm -rf $(pwd)', 'env --split-string= empty value'],
    ['env -S" " rm -rf $(pwd)', 'env glued -S with blank value'],
    ['env -S "sudo rm -rf $(pwd)"', 'env -S command-string recursion'],
    ['sudo -u root -- rm -rf $(pwd)', 'sudo value flag then -- separator'],
  ]
  for (const [cmd, label] of wrapperPositives) {
    test(`blocks: ${label}`, () => {
      const block = findSubstitutionTargetBlock(cmd)
      expect(block).not.toBeNull()
      expect(block!.kind).toBe('wholeSubstitution')
    })
  }

  const wrapperNegatives: Array<[string, string]> = [
    ['timeout -- rm -rf $(pwd)', 'timeout -- without duration fails closed'],
    ['timeout -x 5 rm -rf $(pwd)', 'unknown timeout flag fails closed'],
    ['command -v rm -rf $(pwd)', 'command -v bails (official aFt check)'],
    ['env -S "rm -rf x"', '-S command string has no substitution target'],
    ['env --split-string=rm -rf $(pwd)', '--split-string=rm recurses to bare rm'],
    ['env -Srm $(pwd)', 'glued -Srm recurses to bare rm verb, orphaned target'],
    ['nocorrect echo $(pwd)', 'nocorrect on a non-rm verb'],
  ]
  for (const [cmd, label] of wrapperNegatives) {
    test(`allows: ${label}`, () => {
      expect(findSubstitutionTargetBlock(cmd)).toBeNull()
    })
  }

  test('backslash-escaped \\$(pwd) still blocks (fail-closed tokenizer escape)', () => {
    // bash treats \$(pwd) as a literal string, but normalization runs before
    // tokenization: `\__CMDSUB__` → the escape consumes one placeholder
    // underscore and the run STILL matches `^(?:__CMDSUB__[/*.]*)+$`.
    // Deliberate fail-closed false positive (matches OCC deny-in-all-modes).
    const block = findSubstitutionTargetBlock('rm -rf \\$(pwd)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('wholeSubstitution')
  })

  test('unbalanced quote consumes the remainder (fail-closed)', () => {
    const block = findSubstitutionTargetBlock('rm -rf "$(pwd)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('wholeSubstitution')
  })

  test('>64 substitutions WITHOUT rm → null (no tooMany verdict)', () => {
    const cmd = `echo ${Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')}`
    expect(findCatastrophicSubstitutionBlock(cmd)).toBeNull()
  })

  test('empty segment and keyword-only segment are skipped', () => {
    expect(findSubstitutionTargetBlock('rm -rf $(pwd); ;')).not.toBeNull()
    expect(findSubstitutionTargetBlock('then $(pwd)')).toBeNull()
  })
})

describe('2.1.281 kind taxonomy on the pre-existing verdicts', () => {
  test('>64 substitutions → tooManySubstitutions kind', () => {
    const cmd = `rm -rf ${Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')}`
    const block = findCatastrophicSubstitutionBlock(cmd)
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('tooManySubstitutions')
    expect(block!.category).toBe('rm_substitution_too_many')
  })

  test('var-path inside substitution → emptyVariable kind + var_root_child shape', () => {
    const block = findCatastrophicSubstitutionBlock('$(rm -rf $UNSET/*)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('emptyVariable')
    expect(block!.shape).toBe('var_root_child')
  })

  test('literal root rm inside substitution → literalTarget kind', () => {
    const block = findCatastrophicSubstitutionBlock('echo hi && (rm -rf /)')
    expect(block).not.toBeNull()
    expect(block!.kind).toBe('literalTarget')
    expect(block!.category).toBe('rm_substitution_root_home')
  })
})

describe('2.1.281 bashToolHasPermission integration (deny in ALL modes)', () => {
  test('rm -rf "$(pwd)" is denied with the byte-exact official message (default mode)', async () => {
    const result = await bashToolHasPermission(
      { command: 'rm -rf "$(pwd)"', description: '' } as never,
      makeContext('default'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toBe(OFFICIAL_WHOLE_SUB_MESSAGE)
  })

  test('rm -rf $(pwd) is denied even under bypassPermissions (bypass-immune)', async () => {
    const result = await bashToolHasPermission(
      { command: 'rm -rf $(pwd)', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toBe(OFFICIAL_WHOLE_SUB_MESSAGE)
  })

  test('rm -rf /$(pwd) (emptyExpansion) is denied in bypass mode too', async () => {
    const result = await bashToolHasPermission(
      { command: 'rm -rf /$(pwd)', description: '' } as never,
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('expand to nothing')
  })

  test('pre-existing verdicts keep the Destructive-command-blocked envelope', async () => {
    const result = await bashToolHasPermission(
      { command: 'echo hi && (rm -rf /)', description: '' } as never,
      makeContext('default'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toMatch(/^Destructive command blocked: /)
  })

  test('a permissive Bash allow-rule cannot auto-allow rm -rf "$(pwd)"', async () => {
    const appState = {
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode: 'default',
        alwaysAllowRules: { cliArg: ['Bash(rm:*)'] },
      },
    } as never
    const ctx = {
      ...makeContext('default'),
      getAppState: () => appState,
    } as unknown as ToolUseContext
    const result = await bashToolHasPermission(
      { command: 'rm -rf "$(pwd)"', description: '' } as never,
      ctx,
    )
    expect(result.behavior).toBe('deny')
  })
})
