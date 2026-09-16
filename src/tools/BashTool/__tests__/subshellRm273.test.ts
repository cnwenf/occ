import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import { findCatastrophicSubstitutionBlock } from '../destructiveCommandWarning.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.273 fix — "a subshell hiding a dangerous `rm` in bypass mode"
 * (changelog: "Fixed Bash commands the permission checker cannot fully
 * analyze skipping the prompt under `permissions.
 * blockReadsOutsideWorkingDirectories`, and a subshell hiding a dangerous
 * `rm` in bypass mode").
 *
 * Byte-verified root cause (forensics in /tmp/cc-diff-273, official
 * linux-x64 ELFs 2.1.272 vs 2.1.273):
 *  - 2.1.272: for `echo hi && (rm -rf /)` the classifier returns kind
 *    "simple" → compound check (BAn) → hasSubshell → a plain shell-operators
 *    ask whose decisionReason is NOT in the bypassImmune classification map
 *    (`dangerousRemoval:{bypassImmune:!0,...}` only). The top-level bypass
 *    gate (`pe&&F?.behavior==="ask"?G_(F.decisionReason,nNe):...`) therefore
 *    auto-allowed it in bypassPermissions mode. The dangerous-rm walker
 *    (_5o) ran ONLY on the too-complex branch.
 *  - 2.1.273: Mzo's shell-operators branch now also runs the walker
 *    (`if(d&&d!==kz){let Pn=await rxn(d,te(),s);if(Pn!==null)return Pn}`);
 *    the walker splits every body on shell operators via tree-sitter
 *    (Hg/Fp), strips one `{…;}`/`(…)` wrapper per segment, and the inner
 *    `rm -rf /` yields a `dangerousRemoval` circuitBreaker ask — which IS
 *    bypassImmune, so bypass mode now prompts.
 *
 * OCC port: findCatastrophicSubstitutionBlock (the always-on deny guard in
 * bashToolHasPermission, which runs in ALL modes incl. bypassPermissions)
 * now analyzes each splitCommandForRm segment of every body in addition to
 * the whole body. The quote-aware splitter surfaces `(rm -rf /)` as a bare
 * `rm -rf /` segment; `echo "a && rm -rf /"` stays ONE segment (no false
 * positive). OCC's deny is inherently bypass-immune — the OCC equivalent of
 * the official bypassImmune ask (G3/#41 design: the substitution form must
 * match the plain form).
 */

function makeContext(mode: string, allowRules: string[] = []): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
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

describe('2.1.273 subshell rm — per-segment detection (the bypass-mode bug)', () => {
  test('blocks rm -rf / hidden in a subshell after && (the changelog case)', () => {
    const block = findCatastrophicSubstitutionBlock('echo hi && (rm -rf /)')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })

  test('blocks rm -rf ~ hidden in a subshell after a newline', () => {
    const block = findCatastrophicSubstitutionBlock('echo hi\n(rm -rf ~)')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })

  test('blocks rm -rf ~ hidden in a subshell after a pipe', () => {
    const block = findCatastrophicSubstitutionBlock('foo | (rm -rf ~)')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })

  test('blocks rm -rf $HOME in a subshell after a semicolon', () => {
    const block = findCatastrophicSubstitutionBlock('true; (rm -rf $HOME)')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })

  test('blocks a var-path catastrophic rm in a subshell segment', () => {
    const block = findCatastrophicSubstitutionBlock(
      'cd /tmp; (rm -rf $UNSET/*)',
    )
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_var_path')
  })

  test('blocks a brace group segment `{ rm -rf ~` (wrapper-strip per segment)', () => {
    const block = findCatastrophicSubstitutionBlock('{ rm -rf ~; }')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })
})

describe('2.1.273 subshell rm — no false positives (quote-aware splitter)', () => {
  test('does NOT block a quoted string containing rm text', () => {
    expect(
      findCatastrophicSubstitutionBlock('echo "a && rm -rf /"'),
    ).toBeNull()
  })

  test('does NOT block a safe subshell', () => {
    expect(findCatastrophicSubstitutionBlock('ls && (echo hi)')).toBeNull()
  })

  test('does NOT block a relative-path rm in a subshell (not catastrophic)', () => {
    expect(
      findCatastrophicSubstitutionBlock('(rm -rf ./build)'),
    ).toBeNull()
  })

  test('does NOT block a plain safe compound', () => {
    expect(
      findCatastrophicSubstitutionBlock('cd /tmp && ls -la | head -5'),
    ).toBeNull()
  })
})

describe('2.1.273 subshell rm — pre-existing whole-body detection preserved', () => {
  test('still blocks ( rm -rf ~ ) as a whole body', () => {
    const block = findCatastrophicSubstitutionBlock('( rm -rf ~ )')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })

  test('still blocks rm inside $(…)', () => {
    const block = findCatastrophicSubstitutionBlock('echo $(rm -rf ~)')
    expect(block).not.toBeNull()
    expect(block!.category).toBe('rm_substitution_root_home')
  })
})

describe('2.1.273 subshell rm — bypass-mode integration (bypass-immune deny)', () => {
  test('bypassPermissions mode DENIES echo hi && (rm -rf /) (2.1.272 allowed it)', async () => {
    const r = await bashToolHasPermission(
      { command: 'echo hi && (rm -rf /)' } as never,
      makeContext('bypassPermissions'),
    )
    expect(r.behavior).toBe('deny')
    expect(r.decisionReason?.reason).toContain('Destructive command blocked')
  })

  test('bypassPermissions mode does NOT deny a safe subshell compound', async () => {
    // bashToolHasPermission may surface an 'ask' for the shell-operators
    // form (pre-existing); the generic permission flow (permissions.ts
    // step 2a) converts non-immune asks to allow under bypass. The guard
    // added by the 2.1.273 port must not turn safe commands into denies.
    const r = await bashToolHasPermission(
      { command: 'ls && (echo hi)' } as never,
      makeContext('bypassPermissions'),
    )
    expect(r.behavior).not.toBe('deny')
  })

  test('default mode denies the same subshell rm (guard runs in all modes)', async () => {
    const r = await bashToolHasPermission(
      { command: 'echo hi && (rm -rf /)' } as never,
      makeContext('default'),
    )
    expect(r.behavior).toBe('deny')
  })
})
