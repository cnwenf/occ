/**
 * CC 2.1.288 PORT #38 tests: a plugin-defined agent spawned by name runs with
 * its own prompt, tools, disallowedTools and effort instead of the defaults.
 *
 * Official 2.1.288 `handleSpawnInProcess` filters the carried agentDefinition
 * with `Ma` — recovered byte-for-byte from the 2.1.288 ELF (@208728957):
 *   `function Ma(e){return e.source==="built-in"}`
 * i.e. ONLY built-in definitions count as placeholders/defaults; plugin
 * definitions are real definitions and must flow through to the runner.
 *
 * OCC divergence (structural): the official receives `e.agentDefinition` on
 * the spawn input; OCC resolves by `agent_type` from
 * `context.options.agentDefinitions.activeAgents` inside handleSpawnInProcess
 * (AgentTool.tsx passes only agent_type). The resolution seam is exported as
 * `resolveTeammateAgentDefinition`. The synthetic teammate definition builder
 * is exported as `buildTeammateResolvedDefinition` — it must propagate
 * disallowedTools + effort onto the definition handed to runAgent(), which
 * already enforces both (resolveAgentTools + effortValue override), matching
 * the subagent_type path instead of duplicating its logic.
 */
import { describe, expect, test } from 'bun:test'
import type { Tool, Tools } from '../../../Tool.js'
import { resolveAgentTools } from '../../../tools/AgentTool/agentToolUtils.js'
import type {
  BuiltInAgentDefinition,
  CustomAgentDefinition,
  PluginAgentDefinition,
} from '../../../tools/AgentTool/loadAgentsDir.js'
import { resolveTeammateAgentDefinition } from '../../../tools/shared/spawnMultiAgent.js'
import { buildTeammateResolvedDefinition } from '../inProcessRunner.js'

// --- Fixtures ---------------------------------------------------------------

const pluginDef: PluginAgentDefinition = {
  agentType: 'myplugin:reviewer',
  whenToUse: 'Reviews code carefully',
  tools: ['Read', 'Grep'],
  disallowedTools: ['Bash'],
  effort: 'high',
  model: 'claude-opus-5',
  getSystemPrompt: () => 'PLUGIN REVIEWER PROMPT',
  source: 'plugin',
  plugin: 'myplugin',
  filename: 'reviewer',
}

const customDef: CustomAgentDefinition = {
  agentType: 'my-custom',
  whenToUse: 'Custom project agent',
  tools: ['Read'],
  getSystemPrompt: () => 'CUSTOM PROMPT',
  source: 'projectSettings',
}

const builtInDef: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse: 'General purpose built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => 'BUILTIN PROMPT',
  source: 'built-in',
}

const activeAgents = [builtInDef, customDef, pluginDef]

function makeTool(name: string): Tool {
  return {
    name,
    description: async () => name,
    inputSchema: {} as never,
    call: async () => ({ data: {} }),
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    isReadOnly: () => true,
    maxResultSizeChars: 1000,
  } as unknown as Tool
}

// --- resolveTeammateAgentDefinition (spawnMultiAgent seam) ------------------

describe('CC 2.1.288 #38: resolveTeammateAgentDefinition by-name resolution', () => {
  test('resolves a plugin agent definition by name (was dropped by isCustomAgent filter)', () => {
    // Arrange/Act
    const resolved = resolveTeammateAgentDefinition(
      activeAgents,
      'myplugin:reviewer',
    )

    // Assert — the runner must receive the plugin's own definition, incl. prompt
    expect(resolved).toBe(pluginDef)
    expect(resolved?.getSystemPrompt()).toBe('PLUGIN REVIEWER PROMPT')
  })

  test('resolves a non-plugin custom agent by name (path unchanged)', () => {
    // Arrange/Act
    const resolved = resolveTeammateAgentDefinition(activeAgents, 'my-custom')

    // Assert
    expect(resolved).toBe(customDef)
  })

  test('rejects built-in definitions — official Ma placeholder semantics', () => {
    // Arrange/Act
    const resolved = resolveTeammateAgentDefinition(
      activeAgents,
      'general-purpose',
    )

    // Assert — built-in = placeholder → undefined → default teammate behavior
    expect(resolved).toBeUndefined()
  })

  test('returns undefined for a missing agent_type or no agent_type', () => {
    // Arrange/Act/Assert — missing name → default behavior unchanged
    expect(
      resolveTeammateAgentDefinition(activeAgents, 'does-not-exist'),
    ).toBeUndefined()
    expect(resolveTeammateAgentDefinition(activeAgents, undefined)).toBeUndefined()
  })
})

// --- buildTeammateResolvedDefinition (inProcessRunner seam) -----------------

describe('CC 2.1.288 #38: buildTeammateResolvedDefinition field propagation', () => {
  test('plugin agent → own tools + disallowedTools + effort + model reach runAgent definition', () => {
    // Arrange
    const teammatePrompt = 'BASE PROMPT\n# Custom Agent Instructions\nPLUGIN REVIEWER PROMPT'

    // Act
    const resolved = buildTeammateResolvedDefinition(
      pluginDef,
      'reviewer-1',
      teammatePrompt,
    )

    // Assert — prompt carried through the composed teammate system prompt
    expect(resolved.getSystemPrompt()).toBe(teammatePrompt)
    // tools: definition list + team-essential tools (not the '*' default)
    expect(resolved.tools).toContain('Read')
    expect(resolved.tools).toContain('Grep')
    expect(resolved.tools).toContain('SendMessage')
    expect(resolved.tools).not.toContain('*')
    // #38 core: disallowedTools and effort were previously dropped
    expect(resolved.disallowedTools).toEqual(['Bash'])
    expect(resolved.effort).toBe('high')
    expect(resolved.model).toBe('claude-opus-5')
  })

  test('disallowedTools are enforced — Bash NOT granted despite former "*" default', () => {
    // Arrange — the wildcard default previously granted every available tool
    const availableTools: Tools = [
      makeTool('Read'),
      makeTool('Grep'),
      makeTool('Bash'),
      makeTool('SendMessage'),
    ]
    const resolved = buildTeammateResolvedDefinition(
      pluginDef,
      'reviewer-1',
      'PROMPT',
    )

    // Act — real enforcement path used by runAgent (no duplication)
    const result = resolveAgentTools(resolved, availableTools)
    const granted = result.resolvedTools.map(t => t.name)

    // Assert
    expect(granted).toContain('Read')
    expect(granted).toContain('Grep')
    expect(granted).not.toContain('Bash')
  })

  test('wildcard definition with disallowedTools → all tools minus disallowed', () => {
    // Arrange — plugin def with no explicit tools list but a disallow entry
    const wildcardPlugin: PluginAgentDefinition = {
      agentType: 'myplugin:wide',
      whenToUse: 'Wide plugin agent',
      disallowedTools: ['WebFetch'],
      getSystemPrompt: () => 'WIDE PROMPT',
      source: 'plugin',
      plugin: 'myplugin',
    }
    const availableTools: Tools = [
      makeTool('Read'),
      makeTool('WebFetch'),
      makeTool('SendMessage'),
    ]

    // Act
    const resolved = buildTeammateResolvedDefinition(
      wildcardPlugin,
      'wide-1',
      'PROMPT',
    )
    const result = resolveAgentTools(resolved, availableTools)
    const granted = result.resolvedTools.map(t => t.name)

    // Assert — tools stay '*' (plus team tools), disallow still subtracts
    expect(resolved.tools).toContain('*')
    expect(resolved.disallowedTools).toEqual(['WebFetch'])
    expect(granted).toContain('Read')
    expect(granted).not.toContain('WebFetch')
  })

  test('no definition → default behavior unchanged (tools "*", no disallow/effort)', () => {
    // Arrange/Act
    const resolved = buildTeammateResolvedDefinition(
      undefined,
      'plain-teammate',
      'BASE PROMPT',
    )

    // Assert — placeholder/missing definition keeps the former defaults
    expect(resolved.getSystemPrompt()).toBe('BASE PROMPT')
    expect(resolved.tools).toEqual(['*'])
    expect(resolved.disallowedTools).toBeUndefined()
    expect(resolved.effort).toBeUndefined()
    expect(resolved.model).toBeUndefined()
    expect(resolved.source).toBe('projectSettings')
    expect(resolved.permissionMode).toBe('default')
  })

  test('effort 0 is propagated (not dropped by falsy check)', () => {
    // Arrange — effort can be an integer; 0 must survive
    const zeroEffort: CustomAgentDefinition = {
      agentType: 'zero-effort',
      whenToUse: 'Minimal effort agent',
      effort: 0,
      getSystemPrompt: () => 'PROMPT',
      source: 'userSettings',
    }

    // Act
    const resolved = buildTeammateResolvedDefinition(
      zeroEffort,
      'zero-1',
      'PROMPT',
    )

    // Assert
    expect(resolved.effort).toBe(0)
  })
})
