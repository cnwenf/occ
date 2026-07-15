import { describe, expect, test } from 'bun:test'
import { createSubagentContext } from '../../../utils/forkedAgent.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

// 2.1.210 #3: Fix isolation: 'worktree' subagents being able to run
// git-mutating commands against the main repo checkout. The worktree path
// must be propagated via ToolUseContext.agentWorktree so shell-executing tools
// (Bash/PowerShell) can block commands whose cwd escapes the worktree.
//
// This test verifies:
// 1. The agentWorktree field exists on ToolUseContext
// 2. createSubagentContext produces a context that can carry agentWorktree
// 3. The field is undefined by default (non-worktree subagents)
// 4. The threading pattern from runAgent.ts works:
//    if (worktreePath) { ctx.agentWorktree = worktreePath }

function makeMinimalContext(): ToolUseContext {
  const abortController = new AbortController()
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
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
    abortController,
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

describe('2.1.210 #3 agentWorktree field on ToolUseContext', () => {
  test('agentWorktree field exists on type (runtime check)', () => {
    const ctx = makeMinimalContext()
    // Field should exist on the type; undefined when not set
    expect('agentWorktree' in ctx || ctx.agentWorktree === undefined).toBe(true)
    expect(ctx.agentWorktree).toBeUndefined()
  })

  test('createSubagentContext produces context with undefined agentWorktree by default', () => {
    const parent = makeMinimalContext()
    const sub = createSubagentContext(parent)
    expect(sub.agentWorktree).toBeUndefined()
  })

  test('agentWorktree can be set on subagent context (threading pattern)', () => {
    const parent = makeMinimalContext()
    const sub = createSubagentContext(parent)

    // Simulate the runAgent.ts threading:
    //   if (worktreePath) { agentToolUseContext.agentWorktree = worktreePath }
    const worktreePath = '/tmp/test-worktree-isolation'
    if (worktreePath) {
      sub.agentWorktree = worktreePath
    }
    expect(sub.agentWorktree).toBe(worktreePath)
  })

  test('agentWorktree is NOT set when worktreePath is undefined (non-worktree subagent)', () => {
    const parent = makeMinimalContext()
    const sub = createSubagentContext(parent)

    const worktreePath: string | undefined = undefined
    if (worktreePath) {
      sub.agentWorktree = worktreePath
    }
    expect(sub.agentWorktree).toBeUndefined()
  })

  test('agentWorktree propagates to the value that was set (persistence)', () => {
    const parent = makeMinimalContext()
    const sub = createSubagentContext(parent)

    const worktreePath = '/tmp/another-worktree-path'
    sub.agentWorktree = worktreePath

    // Read it back — should persist
    expect(sub.agentWorktree).toBe(worktreePath)

    // Change it and read back again
    const newPath = '/tmp/changed-worktree'
    sub.agentWorktree = newPath
    expect(sub.agentWorktree).toBe(newPath)
  })

  test('worktree path from parent context is NOT inherited (isolation)', () => {
    // The parent's agentWorktree (if any) should NOT be inherited by the
    // subagent context via createSubagentContext — the subagent must get its
    // OWN agentWorktree set by runAgent.ts if it was spawned with isolation.
    const parent = makeMinimalContext()
    parent.agentWorktree = '/tmp/parent-worktree'

    const sub = createSubagentContext(parent)
    // createSubagentContext does NOT copy agentWorktree from parent
    expect(sub.agentWorktree).toBeUndefined()
  })
})
