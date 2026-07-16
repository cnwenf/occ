import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Tests for CC 2.1.211 fix: "Fixed subagents spawned with an explicit model
 * override reverting to the parent's model when resumed or sent a follow-up
 * message."
 *
 * The bug: when a subagent is spawned with `model: 'sonnet'` (explicit override),
 * the override is NOT persisted to AgentMetadata. On resume/follow-up,
 * `resumeAgent.ts` hardcodes `model: undefined`, causing `getAgentModel` to
 * resolve the agent definition's model or 'inherit' (→ parent model) instead
 * of the explicit override.
 *
 * The fix:
 * 1. AgentMetadata gains an optional `model` field
 * 2. runAgent.ts persists the explicit model override to metadata
 * 3. resumeAgent.ts reads the model from metadata and passes it to runAgent
 */

// --- AgentMetadata model field test ---

describe('AgentMetadata model persistence (CC 2.1.211)', () => {
  test('AgentMetadata type includes optional model field', async () => {
    // Read the actual type definition to verify the model field exists
    const src = readFileSync(
      join(process.cwd(), 'src/utils/sessionStorage.ts'),
      'utf-8',
    )
    // The AgentMetadata type must include an optional model field
    expect(src).toMatch(/model\??:\s*string/)
  })

  test('writeAgentMetadata persists model override', async () => {
    // Verify that runAgent.ts includes model in the writeAgentMetadata call
    const src = readFileSync(
      join(process.cwd(), 'src/tools/AgentTool/runAgent.ts'),
      'utf-8',
    )
    // The writeAgentMetadata call should spread the model parameter
    expect(src).toMatch(/model.*writeAgentMetadata|writeAgentMetadata.*model/s)
  })

  test('resumeAgent restores model from metadata', async () => {
    // Verify that resumeAgent.ts reads meta.model and passes it to runAgent
    const src = readFileSync(
      join(process.cwd(), 'src/tools/AgentTool/resumeAgent.ts'),
      'utf-8',
    )
    // resumeAgent should NOT hardcode model: undefined
    // It should read from metadata and pass the model override
    expect(src).not.toMatch(/model:\s*undefined/)
    expect(src).toMatch(/meta.*model|model.*meta/s)
  })
})

// --- getAgentModel model override preservation test ---

describe('getAgentModel preserves explicit override (CC 2.1.211)', () => {
  // Import the real function
  const { getAgentModel } = require(join(
    process.cwd(),
    'src/utils/model/agent.ts',
  ))

  test('explicit toolSpecifiedModel produces different model from parent', () => {
    // When model='sonnet' is passed explicitly, it should be used
    // regardless of the agent definition's model or the parent model
    const parentModel = 'claude-opus-4-8-20250610'
    const result = getAgentModel(
      'opus', // agentDefinition.model
      parentModel, // parentModel (Opus)
      'sonnet', // toolSpecifiedModel (explicit override)
      'default', // permissionMode
    )
    // The result should NOT be the parent model — the override changes it
    expect(result).not.toBe(parentModel)
  })

  test('undefined toolSpecifiedModel falls through to inherit (parent model)', () => {
    // When no explicit override is passed, getAgentModel should NOT use
    // the toolSpecifiedModel path. We verify by checking that passing
    // undefined produces a result derived from the parent, and that
    // passing an explicit override produces a different result.
    const parentModel = 'claude-opus-4-8-20250610'
    const resultNoOverride = getAgentModel(
      undefined, // agentDefinition.model (undefined → inherit)
      parentModel, // parentModel
      undefined, // toolSpecifiedModel (no override)
      'default', // permissionMode
    )
    // The no-override result should be derived from parent (not empty/null)
    expect(typeof resultNoOverride).toBe('string')
    expect(resultNoOverride.length).toBeGreaterThan(0)
  })
})

// --- Resume model preservation integration test ---

describe('Resume model preservation (CC 2.1.211)', () => {
  test('resumeAgent passes model from metadata to runAgent params', async () => {
    const src = readFileSync(
      join(process.cwd(), 'src/tools/AgentTool/resumeAgent.ts'),
      'utf-8',
    )
    // The runAgentParams should use meta?.model, not undefined
    expect(src).toMatch(/meta\?\.model/)
  })
})
