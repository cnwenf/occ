import { describe, expect, test } from 'bun:test'
import { bashToolHasPermission } from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'

/**
 * Follow-up B (OCC-16) — real end-to-end through the PRODUCTION permission
 * gate, not the guard unit. The worktree git-redirect guard is wired at
 * `bashPermissions.ts` inside `bashToolHasPermission` (the actual BashTool
 * permission entry point), gated on `context.agentWorktree` (set only for
 * isolation: "worktree" subagents) and bypass-immune (`behavior: 'deny'`,
 * runs in every mode). These tests drive that real production function with
 * a worktree context and assert the deny — proving the Follow-up B vectors
 * are blocked at the actual shell-exec-time gate a worktree subagent hits,
 * not just in isolation by the guard helper.
 */

const WORKTREE = '/tmp/wt'
const SHARED = '/tmp/main'

function makeWorktreeContext(worktreePath?: string): ToolUseContext {
  const abortController = new AbortController()
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
  } as never
  const ctx: ToolUseContext = {
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
  // Simulate the runAgent.ts threading pattern: a "worktree" subagent gets
  // agentWorktree set; a non-worktree subagent leaves it undefined.
  ;(ctx as unknown as { agentWorktree?: string }).agentWorktree = worktreePath
  return ctx
}

async function denyFor(command: string, worktree = WORKTREE) {
  return bashToolHasPermission(
    { command } as never,
    makeWorktreeContext(worktree),
  )
}

describe('Follow-up B — production gate (bashToolHasPermission) e2e', () => {
  describe('denies the Follow-up B escape vectors at the real wired gate', () => {
    test("bash <<< 'git …' (here-string) -> deny", async () => {
      const r = await denyFor(`bash <<< 'git -C ${SHARED} status'`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('stdin')
      expect(r.message).toContain('here-string')
    })

    test("echo 'git …' | bash (pipe) -> deny", async () => {
      const r = await denyFor(`echo 'git -C ${SHARED} status' | bash`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('stdin')
      expect(r.message).toContain('pipe')
    })

    test('bash < script.sh (redirect) -> deny', async () => {
      const r = await denyFor(`bash < ${SHARED}/evil.sh`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('stdin')
      expect(r.message).toContain('redirect')
    })

    test("bash <(echo 'git …') (process substitution) -> deny", async () => {
      const r = await denyFor(`bash <(echo 'git -C ${SHARED} status')`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('process substitution')
    })

    test('exec 3< file; bash <&3 (fd-dup) -> deny', async () => {
      const r = await denyFor(`exec 3< ${SHARED}/evil.sh; bash <&3`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('fd-dup')
    })

    test("su -c 'git …' -> deny", async () => {
      const r = await denyFor(`su -c 'git -C ${SHARED} status'`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('su -c')
    })

    test("runuser -u root -c 'git …' -> deny", async () => {
      const r = await denyFor(`runuser -u root -c 'git -C ${SHARED} status'`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('runuser -c')
    })

    test('bash -c "git …" (#194) still -> deny', async () => {
      const r = await denyFor(`bash -c "git -C ${SHARED} status"`)
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('bash -c')
    })
  })

  describe('REPL shells are NOT denied by the worktree guard', () => {
    test('bare bash -> not deny', async () => {
      const r = await denyFor(`bash`)
      expect(r.behavior).not.toBe('deny')
    })

    test('bash -l -> not deny', async () => {
      const r = await denyFor(`bash -l`)
      expect(r.behavior).not.toBe('deny')
    })

    test('bash -i -> not deny', async () => {
      const r = await denyFor(`bash -i`)
      expect(r.behavior).not.toBe('deny')
    })
  })

  describe('guard is isolation-gated (only fires for worktree subagents)', () => {
    test('no agentWorktree -> the here-string escape is NOT denied by this guard', async () => {
      // Without agentWorktree, the worktree guard is a no-op — a non-worktree
      // subagent is not isolation-bound, so the guard correctly doesn't fire.
      // (The command may still hit other permission paths, but not this one.)
      const r = await bashToolHasPermission(
        { command: `bash <<< 'git -C ${SHARED} status'` } as never,
        makeWorktreeContext(undefined),
      )
      expect(r.behavior).not.toBe('deny')
    })
  })
})
