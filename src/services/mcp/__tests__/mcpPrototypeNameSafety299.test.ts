import { describe, expect, test } from 'bun:test'

import { hasMcpServerEntry } from '../config.js'

/**
 * claude-code 2.1.299 changelog (line 44):
 *   "Fixed MCP servers named `constructor` or `prototype` in an MCP config
 *    never being connected"
 *
 * Root cause (OCC): the add/remove existence guards in src/services/mcp/config.ts
 * used plain-object bracket truthiness — `servers[name]`,
 * `globalConfig.mcpServers?.[name]`, `!existingServers[name]`, … — to decide
 * whether a server already exists. A plain `{}` inherits `constructor`,
 * `toString`, `valueOf`, `hasOwnProperty`, … from `Object.prototype`, so for a
 * server literally named `constructor` (or `toString`) the bracket read returns
 * the inherited function, which is TRUTHY. `addMcpConfig` therefore threw
 * "MCP server constructor already exists" even when no such server was
 * configured, so the server could never be added (and thus never connected);
 * `removeMcpConfig` symmetrically believed a non-existent `constructor` server
 * was present.
 *
 * Fix: every guard now routes through `hasMcpServerEntry`, an own-property
 * predicate (`Object.hasOwn`) that ignores the prototype chain. This mirrors the
 * official behavior — a config keyed by name must test OWN membership, not
 * inherited members. `Object.hasOwn` is already the codebase idiom for exactly
 * this __proto__/prototype-key hazard (see config.ts mcpServers __proto__ guard).
 *
 * These tests pin the own-property semantics for the hazardous names plus the
 * ordinary-name and missing-container cases the guards rely on.
 */
describe('hasMcpServerEntry — 2.1.299 #42 prototype-name safety', () => {
  test('an empty config has NO constructor/prototype/toString/__proto__ entry', () => {
    // Arrange — a plain object literal inherits all of these from Object.prototype.
    const empty = {}

    // Act / Assert — own-property semantics must report false for every
    // inherited hazard name; bracket truthiness (`empty[name]`) would wrongly
    // report true for constructor/toString/valueOf/hasOwnProperty.
    expect(hasMcpServerEntry(empty, 'constructor')).toBe(false)
    expect(hasMcpServerEntry(empty, 'prototype')).toBe(false)
    expect(hasMcpServerEntry(empty, 'toString')).toBe(false)
    expect(hasMcpServerEntry(empty, '__proto__')).toBe(false)
    expect(hasMcpServerEntry(empty, 'hasOwnProperty')).toBe(false)
    expect(hasMcpServerEntry(empty, 'valueOf')).toBe(false)
  })

  test('an own entry named constructor/toString IS found', () => {
    // A user who genuinely configures a server named "constructor" must be able
    // to add/remove it: once stored as an OWN property it is detected.
    const withConstructor = { constructor: { type: 'stdio', command: 'x' } }
    expect(hasMcpServerEntry(withConstructor, 'constructor')).toBe(true)

    const withToString = Object.create(null) as Record<string, unknown>
    withToString.toString = { type: 'stdio', command: 'y' }
    expect(hasMcpServerEntry(withToString, 'toString')).toBe(true)
  })

  test('ordinary server names behave as before', () => {
    const servers = { github: { type: 'stdio', command: 'g' } }
    expect(hasMcpServerEntry(servers, 'github')).toBe(true)
    expect(hasMcpServerEntry(servers, 'gitlab')).toBe(false)
  })

  test('a falsy own value is still an own entry (no truthiness shortcut)', () => {
    // The old guards used truthiness, so a legitimately-falsy stored value would
    // read as "absent". Own-property membership must not depend on the value.
    const servers = { empty: undefined as unknown }
    expect(hasMcpServerEntry(servers, 'empty')).toBe(true)
  })

  test('a missing/undefined container reports false (guards use ?. chaining)', () => {
    expect(hasMcpServerEntry(undefined, 'constructor')).toBe(false)
    expect(hasMcpServerEntry(undefined, 'github')).toBe(false)
  })
})
