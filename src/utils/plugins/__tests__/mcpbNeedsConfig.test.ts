/**
 * Tests for mcpbNeedsConfig.ts — the official 2.1.285 bundled-`.mcpb`
 * "needs configuration" messaging (changelog item 13). Every user-facing
 * string is asserted byte-identical to the decompiled v285 binary.
 */

import { describe, expect, test } from 'bun:test'
import {
  NEEDS_CONFIG_UI_SUFFIX_PLUGIN,
  NEEDS_CONFIG_UI_SUFFIX_SERVER,
  buildNeedsConfigCliMessage,
  buildNeedsConfigLogMessage,
  mcpbNeedsConfigWarning,
  needsConfigGuidanceText,
  needsConfigWarningText,
} from '../mcpbNeedsConfig.js'

describe('mcpbNeedsConfigWarning (official zJe)', () => {
  test('builds the warning from the plugin repository, name, and server name', () => {
    // Arrange
    const plugin = { name: 'acme', repository: 'acme@shop' }

    // Act
    const warning = mcpbNeedsConfigWarning(plugin, 'acme-server')

    // Assert
    expect(warning).toEqual({
      type: 'mcpb-needs-config',
      source: 'acme@shop',
      plugin: 'acme',
      serverName: 'acme-server',
    })
  })
})

describe('needsConfigWarningText (official @199242977)', () => {
  test('is byte-identical to the official warning text', () => {
    // Act
    const text = needsConfigWarningText({ serverName: 'srv' })

    // Assert
    expect(text).toBe(
      'Bundled MCP server "srv" was not started: it needs configuration',
    )
  })

  test('sanitizes the server name with vt (curly apostrophe)', () => {
    // Act
    const text = needsConfigWarningText({ serverName: "srv's" })

    // Assert — ASCII apostrophe folded to U+2019 by sanitizePluginMessageText
    expect(text).toBe(
      'Bundled MCP server "srv’s" was not started: it needs configuration',
    )
  })
})

describe('needsConfigGuidanceText (official @199245847)', () => {
  test('is byte-identical to the official guidance text', () => {
    // Act
    const text = needsConfigGuidanceText({ plugin: 'acme' })

    // Assert
    expect(text).toBe(
      'Open "acme" in the Installed tab and choose Configure',
    )
  })
})

describe('UI suffix constants (official wo / Rc)', () => {
  test('wo — plugin-row suffix is byte-identical', () => {
    // Assert — leading space, em-dash (U+2014), ASCII apostrophe in /plugin's
    expect(NEEDS_CONFIG_UI_SUFFIX_PLUGIN).toBe(
      " Its bundled MCP server needs configuration before it can start — select the plugin in /plugin's Installed tab and choose Configure.",
    )
  })

  test('Rc — server-row suffix is byte-identical', () => {
    // Assert
    expect(NEEDS_CONFIG_UI_SUFFIX_SERVER).toBe(
      " A bundled MCP server needs configuration before it can start — select its plugin in /plugin's Installed tab and choose Configure.",
    )
  })
})

describe('buildNeedsConfigCliMessage (official V @222233220)', () => {
  test('lists missing required fields with --config KEY=VALUE', () => {
    // Arrange — "key" is required and absent; "opt" is optional
    const params = {
      serverName: 'srv',
      pluginName: 'plug',
      schema: { key: { required: true }, opt: { required: false } },
      existingConfig: {},
      validationErrors: [],
    }

    // Act
    const message = buildNeedsConfigCliMessage(params)

    // Assert
    expect(message).toBe(
      'MCP server "srv" needs configuration before it can start: set srv.key ' +
        'with --config KEY=VALUE, or in Claude Code run /plugin, select ' +
        '"plug" in the Installed tab, and choose Configure.',
    )
  })

  test('treats an empty-string required value as missing', () => {
    // Arrange
    const params = {
      serverName: 'srv',
      pluginName: 'plug',
      schema: { key: { required: true } },
      existingConfig: { key: '' },
      validationErrors: [],
    }

    // Act & Assert
    expect(buildNeedsConfigCliMessage(params)).toContain(
      'set srv.key with --config KEY=VALUE',
    )
  })

  test('falls back to validation errors joined by semicolons', () => {
    // Arrange — required field present, so the validation-error branch runs
    const params = {
      serverName: 'srv',
      pluginName: 'plug',
      schema: { key: { required: true } },
      existingConfig: { key: 'val' },
      validationErrors: ['bad one', 'bad two'],
    }

    // Act
    const message = buildNeedsConfigCliMessage(params)

    // Assert — em-dash (U+2014) before "fix it"
    expect(message).toBe(
      'MCP server "srv" needs configuration before it can start: bad one; ' +
        'bad two — fix it with --config srv.KEY=VALUE, or in Claude Code run ' +
        '/plugin, select "plug" in the Installed tab, and choose Configure.',
    )
  })

  test('joins multiple missing required fields with commas', () => {
    // Arrange
    const params = {
      serverName: 'srv',
      pluginName: 'plug',
      schema: { a: { required: true }, b: { required: true } },
      existingConfig: {},
      validationErrors: [],
    }

    // Act & Assert
    expect(buildNeedsConfigCliMessage(params)).toContain(
      'set srv.a, srv.b with --config KEY=VALUE',
    )
  })
})

describe('buildNeedsConfigLogMessage (official WJe @203321935)', () => {
  test('is byte-identical to the official log line', () => {
    // Act
    const line = buildNeedsConfigLogMessage('/x/y.mcpb', 'srv', 'plug')

    // Assert — arrows are U+2192, exactly as in the binary
    expect(line).toBe(
      'MCPB /x/y.mcpb requires user configuration; MCP server "srv" not ' +
        'started. Configure via: /plugin → Installed → plug → Configure',
    )
  })

  test('sanitizes the server name with vt in the log line', () => {
    // Act
    const line = buildNeedsConfigLogMessage('/x.mcpb', "srv's", 'plug')

    // Assert
    expect(line).toContain('MCP server "srv’s" not started')
  })
})
