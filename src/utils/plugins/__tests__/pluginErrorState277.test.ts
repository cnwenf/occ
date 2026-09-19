import { describe, expect, test } from 'bun:test'
import type { PluginError } from '../../../types/plugin.js'
import { withoutUninstalledPluginErrors } from '../pluginErrorState.js'

/**
 * CC 2.1.277 (report_C C13): "Fixed uninstalled plugins reappearing as
 * 'failed to load' rows in /plugin Installed, and Remove not clearing such a
 * row."
 *
 * Root cause: uninstallPluginOp never cleared appState.plugins.errors; stale
 * entries survived and ManagePlugins' orphanErrorsBySource rebuilt them into
 * `failed-plugin` rows (grouped by error.source). The uninstall handlers now
 * filter through withoutUninstalledPluginErrors, which must drop exactly the
 * uninstalled plugin's entries — both the `name@marketplace` source form
 * (pluginLoader) and the `plugin:<name>` form (mcpPluginIntegration) — while
 * leaving every other plugin's errors intact.
 */

function genericError(source: string, plugin?: string): PluginError {
  return {
    type: 'generic-error',
    source,
    ...(plugin === undefined ? {} : { plugin }),
    error: `load failure from ${source}`,
  }
}

function lspError(source: string, plugin: string): PluginError {
  return {
    type: 'lsp-server-crashed',
    source,
    plugin,
    serverName: 'lsp',
    exitCode: 1,
  }
}

describe('2.1.277: withoutUninstalledPluginErrors (C13)', () => {
  test('uninstall clears matching errors and leaves other plugins intact', () => {
    // Arrange — plugin A failed to load (both source forms) plus an LSP error;
    // plugin B has its own unrelated errors.
    const errors: PluginError[] = [
      genericError('alpha@acme', 'alpha'),
      genericError('plugin:alpha', 'alpha'),
      lspError('alpha@acme', 'alpha'),
      genericError('beta@acme', 'beta'),
      lspError('plugin:beta', 'beta'),
    ]

    // Act
    const kept = withoutUninstalledPluginErrors(errors, 'alpha@acme')

    // Assert — only beta's entries survive; input array is not mutated.
    expect(kept).toEqual([
      genericError('beta@acme', 'beta'),
      lspError('plugin:beta', 'beta'),
    ])
    expect(errors).toHaveLength(5)
    expect(kept).not.toBe(errors)
  })

  test('no failed-plugin row can resurrect: no surviving error carries the uninstalled source', () => {
    // Arrange — orphanErrorsBySource groups by error.source; a row appears
    // for any source not matching an installed plugin.
    const errors: PluginError[] = [
      genericError('alpha@acme', 'alpha'),
      genericError('plugin:alpha', 'alpha'),
    ]

    // Act
    const kept = withoutUninstalledPluginErrors(errors, 'alpha@acme')

    // Assert — the grouping key and the MCP form are both gone.
    expect(kept.some(e => e.source === 'alpha@acme')).toBe(false)
    expect(kept.some(e => e.source === 'plugin:alpha')).toBe(false)
    expect(kept).toEqual([])
  })

  test('uninstall of a plugin with no errors changes nothing', () => {
    // Arrange
    const errors: PluginError[] = [
      genericError('beta@acme', 'beta'),
      lspError('plugin:gamma', 'gamma'),
    ]

    // Act
    const kept = withoutUninstalledPluginErrors(errors, 'alpha@acme')

    // Assert — every unrelated error (including other plugins' MCP-form
    // sources) survives untouched.
    expect(kept).toEqual(errors)
  })

  test('bare plugin id without marketplace matches its plain and plugin: forms', () => {
    // Arrange — flag-installed plugins can carry a bare name as source.
    const errors: PluginError[] = [
      genericError('alpha', 'alpha'),
      genericError('plugin:alpha', 'alpha'),
      genericError('alphabet@acme', 'alphabet'),
    ]

    // Act
    const kept = withoutUninstalledPluginErrors(errors, 'alpha')

    // Assert — the similar-looking "alphabet" plugin is NOT cleared.
    expect(kept).toEqual([genericError('alphabet@acme', 'alphabet')])
  })

  test('empty error list returns an empty list', () => {
    expect(withoutUninstalledPluginErrors([], 'alpha@acme')).toEqual([])
  })
})
