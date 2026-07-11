import { describe, expect, test } from 'bun:test'
import { EnterWorktreeTool } from '../EnterWorktreeTool.js'

/**
 * claude-code 2.1.206 #5: EnterWorktree asks confirmation before entering a
 * worktree outside `.claude/worktrees/`. The binary's `checkPermissions` gate
 * (`d3i(e.path)?.managed` → allow; else ask with `safetyCheck` reason,
 * `classifierApprovable: false`) prevents auto-approval of a permission-root
 * relocation to a model-supplied out-of-tree path.
 *
 * These tests run against the real OCC repo filesystem (cwd = /root/code/occ
 * at test start). The "managed → allow" happy path requires a real worktree
 * dir under `.claude/worktrees/` and is omitted (trivial; the security gate
 * is the ask branch). Cases tested: no-path → allow; outside-path → ask;
 * unresolvable-path → ask.
 */
describe('2.1.206 #5 EnterWorktree out-of-tree confirmation', () => {
  test('no path (create flow) → allow without prompting', async () => {
    const result = await EnterWorktreeTool.checkPermissions({} as never, {} as never)
    expect(result.behavior).toBe('allow')
  })

  test('path outside .claude/worktrees/ → ask with safetyCheck (not classifier-approvable)', async () => {
    const result = await EnterWorktreeTool.checkPermissions(
      { path: '/tmp' } as never,
      {} as never,
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') return
    expect(result.message).toContain("Enter the worktree at")
    expect(result.message).toContain(
      "This moves the session's working directory and write access there",
    )
    expect(result.decisionReason).toBeDefined()
    if (result.decisionReason?.type === 'safetyCheck') {
      expect(result.decisionReason.classifierApprovable).toBe(false)
      expect(result.decisionReason.reason).toContain(
        'outside .claude/worktrees/',
      )
    } else {
      throw new Error('expected safetyCheck decisionReason')
    }
  })

  test('unresolvable path → ask (realpath fails, cannot prove managed)', async () => {
    const result = await EnterWorktreeTool.checkPermissions(
      { path: '/tmp/occ-ut-nonexistent-xyz-12345-no-such-dir' } as never,
      {} as never,
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') return
    expect(result.decisionReason?.type).toBe('safetyCheck')
    if (result.decisionReason?.type === 'safetyCheck') {
      expect(result.decisionReason.classifierApprovable).toBe(false)
    }
  })

  test('no path carries updatedInput through (create flow)', async () => {
    const result = await EnterWorktreeTool.checkPermissions(
      { name: 'foo' } as never,
      {} as never,
    )
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toMatchObject({ name: 'foo' })
    }
  })
})
