import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type SubagentContext,
  runWithAgentContext,
} from '../../agentContext.js'
import { isProviderManagedEnvVar, SAFE_ENV_VARS } from '../../managedEnvConstants.js'
import { getAgentModel } from '../agent.js'

/**
 * CC 2.1.296 (#003): CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL.
 *
 * Official 296 evidence (ev-workflowmodel296.txt):
 *   - env schema registration right after the SUBAGENT_MODEL family:
 *     `CLAUDE_CODE_SUBAGENT_MODEL:()=>OU, CLAUDE_CODE_SUBAGENT_MODEL_FORCE:()=>TU,
 *      CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL:()=>LU` with `LU=H.str()`;
 *   - member of the managed-env list (@208771578) and the 3P-probe list
 *     (@208765415).
 * The CONSUMPTION site is not in the evidence. Per the changelog ("Added
 * CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL to specify the model for subagents
 * spawned by workflows"), OCC applies it in getAgentModel: agents spawned
 * inside a workflow run prefer it over the generic CLAUDE_CODE_SUBAGENT_MODEL;
 * non-workflow subagents are unchanged.
 *
 * OCC workflow discriminator (documented adaptation): WorkflowTool
 * primitives wrap the workflow-agent drain in
 * runWithAgentContext(SubagentContext{workflowRunId, ...}) — the official
 * 2.1.273 gateway-hint wrap — so the ambient ALS context carries
 * workflowRunId exactly for workflow-spawned agents.
 */

const WORKFLOW_ENV = 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL'
const SUBAGENT_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'
const ENV_KEYS = [WORKFLOW_ENV, SUBAGENT_ENV, FORCE_ENV]

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

const WORKFLOW_CONTEXT: SubagentContext = {
  agentId: 'test-agent-id',
  agentType: 'subagent',
  workflowRunId: 'wf-run-1',
  workflowName: 'test-workflow',
}

const PLAIN_SUBAGENT_CONTEXT: SubagentContext = {
  agentId: 'test-agent-id-2',
  agentType: 'subagent',
}

const PARENT_MODEL = 'claude-sonnet-5'

describe('2.1.296 #003 — getAgentModel outside any agent context (main thread)', () => {
  test('WORKFLOW_SUBAGENT_MODEL is ignored when no workflow context is active', () => {
    // Arrange
    process.env[WORKFLOW_ENV] = 'claude-opus-5'

    // Act — no agentModel → default 'inherit' → parent model resolution.
    const result = getAgentModel(undefined, PARENT_MODEL)

    // Assert
    expect(result).toBe(PARENT_MODEL)
  })

  test('generic SUBAGENT_MODEL still applies unchanged (pre-296 behavior)', () => {
    // Arrange
    process.env[SUBAGENT_ENV] = 'claude-opus-5'

    // Act
    const result = getAgentModel(undefined, PARENT_MODEL)

    // Assert
    expect(result).toBe('claude-opus-5')
  })
})

describe('2.1.296 #003 — getAgentModel inside a WORKFLOW agent context', () => {
  test('WORKFLOW_SUBAGENT_MODEL beats the generic SUBAGENT_MODEL', () => {
    // Arrange
    process.env[WORKFLOW_ENV] = 'claude-opus-5'
    process.env[SUBAGENT_ENV] = 'claude-sonnet-5-5'

    // Act
    const result = runWithAgentContext(WORKFLOW_CONTEXT, () =>
      getAgentModel(undefined, PARENT_MODEL),
    )

    // Assert
    expect(result).toBe('claude-opus-5')
  })

  test('falls back to SUBAGENT_MODEL when WORKFLOW_SUBAGENT_MODEL is unset', () => {
    // Arrange
    process.env[SUBAGENT_ENV] = 'claude-sonnet-5-5'

    // Act
    const result = runWithAgentContext(WORKFLOW_CONTEXT, () =>
      getAgentModel(undefined, PARENT_MODEL),
    )

    // Assert
    expect(result).toBe('claude-sonnet-5-5')
  })

  test('WORKFLOW_SUBAGENT_MODEL wins over the agent-definition model too', () => {
    // Arrange — the env check sits above the agentModel resolution.
    process.env[WORKFLOW_ENV] = 'claude-opus-5'

    // Act
    const result = runWithAgentContext(WORKFLOW_CONTEXT, () =>
      getAgentModel('claude-sonnet-5-5', PARENT_MODEL),
    )

    // Assert
    expect(result).toBe('claude-opus-5')
  })

  test('with neither env set, inherit resolution is untouched', () => {
    // Arrange / Act
    const result = runWithAgentContext(WORKFLOW_CONTEXT, () =>
      getAgentModel(undefined, PARENT_MODEL),
    )

    // Assert
    expect(result).toBe(PARENT_MODEL)
  })
})

describe('2.1.296 #003 — non-workflow subagent contexts are unchanged', () => {
  test('WORKFLOW_SUBAGENT_MODEL is ignored for a plain subagent (no workflowRunId)', () => {
    // Arrange
    process.env[WORKFLOW_ENV] = 'claude-opus-5'

    // Act
    const result = runWithAgentContext(PLAIN_SUBAGENT_CONTEXT, () =>
      getAgentModel(undefined, PARENT_MODEL),
    )

    // Assert — WORKFLOW env not honored → inherit → parent model.
    expect(result).toBe(PARENT_MODEL)
  })

  test('generic SUBAGENT_MODEL still applies inside a plain subagent context', () => {
    // Arrange
    process.env[WORKFLOW_ENV] = 'claude-opus-5'
    process.env[SUBAGENT_ENV] = 'claude-sonnet-5-5'

    // Act
    const result = runWithAgentContext(PLAIN_SUBAGENT_CONTEXT, () =>
      getAgentModel(undefined, PARENT_MODEL),
    )

    // Assert
    expect(result).toBe('claude-sonnet-5-5')
  })
})

describe('2.1.296 #003 — env registration (managed-env + safe-env lists)', () => {
  test('isProviderManagedEnvVar recognizes WORKFLOW_SUBAGENT_MODEL (official @208771578)', () => {
    expect(isProviderManagedEnvVar(WORKFLOW_ENV)).toBe(true)
  })

  test('SAFE_ENV_VARS includes WORKFLOW_SUBAGENT_MODEL (same class as SUBAGENT_MODEL)', () => {
    expect(SAFE_ENV_VARS.has(WORKFLOW_ENV)).toBe(true)
    expect(SAFE_ENV_VARS.has(SUBAGENT_ENV)).toBe(true)
  })
})
