import { describe, expect, test } from 'bun:test'

/**
 * CC 2.1.281 #150 — the leftover "(removed)" /agents stub is hidden from the
 * command menu and /help, but exact-name `/agents` still resolves.
 *
 * Binary evidence:
 *   v2.1.281 @203481583: `{type:"local",name:"agents",description:"(removed)
 *     Ask Claude to create/manage subagents, or edit .claude/agents/",
 *     isHidden:!0,supportsNonInteractive:!0,…}`
 *   v2.1.280 @200602845: identical object WITHOUT `isHidden:!0`.
 *
 * OCC plumbing honored here (verified file:line):
 *   - Command type supports isHidden (src/types/command.ts:208)
 *   - /help filters !cmd.isHidden (HelpV2.tsx:64,73)
 *   - `/` menu + Fuse index filter isHidden (commandSuggestions.ts:36,319)
 *   - exact-name fallback still prepends hidden commands
 *     (commandSuggestions.ts:401)
 */

import agents from '../../src/commands/agents/index.js'
import type { Command } from '../../src/commands.js'
import {
  generateCommandSuggestions,
  getBestCommandMatch,
} from '../../src/utils/suggestions/commandSuggestions.js'

const visibleCommand = {
  type: 'local',
  name: 'agentsmith',
  description: 'A visible command that shares a prefix with /agents',
  supportsNonInteractive: true,
  load: async () => ({ call: async () => ({ type: 'text' as const, value: '' }) }),
} as unknown as Command

const commands: Command[] = [agents as unknown as Command, visibleCommand]

describe('2.1.281 #150 — agents stub command object', () => {
  test('carries isHidden: true with the 2.1.198 stub fields intact', () => {
    expect(agents.isHidden).toBe(true)
    expect(agents.name).toBe('agents')
    expect(agents.type).toBe('local')
    expect(agents.description).toBe(
      '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/',
    )
    expect(agents.supportsNonInteractive).toBe(true)
    expect(typeof agents.load).toBe('function')
  })
})

describe('2.1.281 #150 — command menu surfaces', () => {
  test('the `/` menu omits the hidden agents stub', () => {
    const items = generateCommandSuggestions('/', commands)

    const names = items.map(item => item.displayText)
    expect(names).not.toContain('/agents')
  })

  test('fuzzy `/age` does not surface the hidden stub, but visible prefixes remain', () => {
    const items = generateCommandSuggestions('/age', commands)

    const names = items.map(item => item.displayText)
    expect(names).not.toContain('/agents')
    // the visible prefix sibling still shows (prepend-not-early-return contract)
    expect(names).toContain('/agentsmith')
  })

  test('exact `/agents` still resolves via the hidden exact-name fallback', () => {
    const items = generateCommandSuggestions('/agents', commands)

    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.displayText).toBe('/agents')
    expect(items[0]?.description).toContain('(removed)')
  })

  test('exact name wins over a visible command sharing the name', () => {
    // When a visible command shares the exact name, the visible one wins and
    // the hidden stub is NOT prepended (user's explicit override).
    const shadowing = {
      ...visibleCommand,
      name: 'agents',
    } as unknown as Command
    const items = generateCommandSuggestions('/agents', [
      agents as unknown as Command,
      shadowing,
    ])

    const agentsItems = items.filter(item => item.displayText === '/agents')
    expect(agentsItems.length).toBeGreaterThan(0)
    expect(agentsItems[0]?.metadata).toBe(shadowing)
  })

  test('tab completion of "agent" still completes to the visible sibling only', () => {
    const match = getBestCommandMatch('agent', commands)

    expect(match?.fullCommand).toBe('agentsmith')
  })
})
