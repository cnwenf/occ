import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * Official v288 (@207469709, gap-report cluster-b Item 22): plugin LSP
 * `initializationOptions` and `settings` go through the SAME deep placeholder
 * substitution as command/args/env — `${CLAUDE_PLUGIN_ROOT}`, `${user_config.*}`
 * (with manifest defaults applied for unset keys) and `${VAR}` env expansion.
 * Keys that stay unexpanded are left literal and reported with the official
 * warning (verbatim, byte-faithful):
 *
 *   `Left unexpanded in plugin LSP initializationOptions/settings (not set): ${names.join(", ")}`
 *
 * Before this fix OCC passed both fields through raw, so a plugin LSP server
 * received literal `${user_config.*}` / `${CLAUDE_PLUGIN_ROOT}` strings.
 */

// Capture the debug log without touching the real debug-log file. Spread
// the real module and override only the entry points (repo convention —
// Bun's mock.module leaks across files in the same worker; CI runs each
// test file in its own process).
const actualDebug = { ...(await import('../../debug.js')) }
const actualLog = { ...(await import('../../log.js')) }
const actualPluginDirs = { ...(await import('../pluginDirectories.js')) }
let mocksActive = true
const debugLogs: string[] = []
const loggedErrors: Error[] = []

mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (...args: unknown[]) => {
    if (!mocksActive)
      return (actualDebug.logForDebugging as (...a: unknown[]) => void)(...args)
    debugLogs.push(String(args[0]))
  },
}))
mock.module('../../log.js', () => ({
  ...actualLog,
  logError: (err: unknown) => {
    if (!mocksActive)
      return (actualLog.logError as (e: unknown) => void)(err)
    loggedErrors.push(err as Error)
  },
}))
// Hermetic plugin data dir — the real getPluginDataDir mkdirSyncs under ~/.claude.
mock.module('../pluginDirectories.js', () => ({
  ...actualPluginDirs,
  getPluginDataDir: (pluginId: string) => `/tmp/occ-test-plugin-data/${pluginId}`,
}))

afterAll(() => {
  // Passthrough-flag heal (see mcpAppUiResources281.test.ts for the rationale).
  mocksActive = false
  mock.module('../../debug.js', () => ({ ...actualDebug }))
  mock.module('../../log.js', () => ({ ...actualLog }))
  mock.module('../pluginDirectories.js', () => ({ ...actualPluginDirs }))
})

const { resolvePluginLspEnvironment } = await import(
  '../lspPluginIntegration.js'
)

const TEST_PLUGIN = {
  name: 'lsp-test',
  path: '/plugins/lsp-test',
  source: 'lsp-test@market',
  manifest: {
    userConfig: {
      foo: {
        type: 'string',
        title: 'Foo',
        description: 'foo option',
        default: 'foo-default',
      },
      bar: {
        type: 'string',
        title: 'Bar',
        description: 'bar option (no default)',
      },
    },
  },
}

function clearLogs(): void {
  debugLogs.length = 0
  loggedErrors.length = 0
}

describe('2.1.288 #22 — plugin LSP initializationOptions/settings placeholder substitution', () => {
  test('substitutes ${CLAUDE_PLUGIN_ROOT} and ${user_config.*} in initializationOptions and settings', () => {
    // Arrange
    clearLogs()
    const config = {
      command: 'lang-server',
      initializationOptions: {
        rootPath: '${CLAUDE_PLUGIN_ROOT}/workspace',
        token: 'tk-${user_config.foo}',
      },
      settings: {
        section: { value: '${user_config.foo}' },
      },
    }

    // Act
    const resolved = resolvePluginLspEnvironment(config, TEST_PLUGIN, {
      foo: 'FOO',
    })

    // Assert
    expect(resolved.initializationOptions).toEqual({
      rootPath: '/plugins/lsp-test/workspace',
      token: 'tk-FOO',
    })
    expect(resolved.settings).toEqual({ section: { value: 'FOO' } })
    expect(debugLogs).not.toContainEqual(expect.stringContaining('Left unexpanded'))
  })

  test('applies the manifest default for an unset user_config key', () => {
    // Arrange
    clearLogs()
    const config = {
      command: 'lang-server',
      initializationOptions: { token: '${user_config.foo}' },
    }

    // Act — saved userConfig has no `foo`; manifest declares default 'foo-default'
    const resolved = resolvePluginLspEnvironment(config, TEST_PLUGIN, {})

    // Assert
    expect(resolved.initializationOptions).toEqual({ token: 'foo-default' })
    expect(debugLogs).not.toContainEqual(expect.stringContaining('Left unexpanded'))
  })

  test('leaves an unexpandable ${user_config.*} literal and logs the official warning verbatim', () => {
    // Arrange
    clearLogs()
    const config = {
      command: 'lang-server',
      initializationOptions: { keep: '${user_config.bar}' },
      settings: { also: 'pre-${user_config.bar}-post' },
    }

    // Act — `bar` has no saved value and no manifest default
    const resolved = resolvePluginLspEnvironment(config, TEST_PLUGIN, {})

    // Assert — value left as-is, official warning logged verbatim (deduped)
    expect(resolved.initializationOptions).toEqual({ keep: '${user_config.bar}' })
    expect(resolved.settings).toEqual({ also: 'pre-${user_config.bar}-post' })
    expect(debugLogs).toContain(
      'Left unexpanded in plugin LSP initializationOptions/settings (not set): bar',
    )
    // The leftover placeholder must NOT be double-reported as a missing env var
    expect(
      loggedErrors.some(e => e.message.includes('user_config.bar')),
    ).toBe(false)
  })

  test('joins multiple unexpanded keys with ", " in first-seen order', () => {
    // Arrange
    clearLogs()
    const config = {
      command: 'lang-server',
      initializationOptions: { a: '${user_config.baz}', b: '${user_config.bar}' },
      settings: { c: '${user_config.baz}' },
    }

    // Act
    resolvePluginLspEnvironment(config, TEST_PLUGIN, {})

    // Assert
    expect(debugLogs).toContain(
      'Left unexpanded in plugin LSP initializationOptions/settings (not set): baz, bar',
    )
  })

  test('deep-substitutes nested objects and arrays without mutating the input config', () => {
    // Arrange
    clearLogs()
    const initializationOptions = {
      level1: {
        level2: [
          '${user_config.foo}',
          { level3: '${CLAUDE_PLUGIN_ROOT}/deep' },
          42,
          true,
          null,
        ],
      },
    }
    const config = {
      command: 'lang-server',
      initializationOptions,
      settings: { list: ['${user_config.foo}', ['${user_config.foo}']] },
    }

    // Act
    const resolved = resolvePluginLspEnvironment(config, TEST_PLUGIN, {
      foo: 'FOO',
    })

    // Assert — nested strings substituted, non-strings untouched
    expect(resolved.initializationOptions).toEqual({
      level1: {
        level2: ['FOO', { level3: '/plugins/lsp-test/deep' }, 42, true, null],
      },
    })
    expect(resolved.settings).toEqual({ list: ['FOO', ['FOO']] })
    // Immutable walk — original config object untouched
    expect(initializationOptions.level1.level2[0]).toBe('${user_config.foo}')
    expect(
      (initializationOptions.level1.level2[1] as { level3: string }).level3,
    ).toBe('${CLAUDE_PLUGIN_ROOT}/deep')
  })

  test('command/args/env substitution path is unchanged', () => {
    // Arrange
    clearLogs()
    const config = {
      command: '${CLAUDE_PLUGIN_ROOT}/bin/lang-server',
      args: ['--token=${user_config.foo}'],
      env: { MY_TOKEN: '${user_config.foo}' },
      workspaceFolder: '${CLAUDE_PLUGIN_ROOT}/ws',
      initializationOptions: { x: '${user_config.foo}' },
    }

    // Act
    const resolved = resolvePluginLspEnvironment(config, TEST_PLUGIN, {
      foo: 'FOO',
    })

    // Assert — existing strict path behaves exactly as before
    expect(resolved.command).toBe('/plugins/lsp-test/bin/lang-server')
    expect(resolved.args).toEqual(['--token=FOO'])
    expect(resolved.env.MY_TOKEN).toBe('FOO')
    expect(resolved.env.CLAUDE_PLUGIN_ROOT).toBe('/plugins/lsp-test')
    expect(resolved.env.CLAUDE_PLUGIN_DATA).toBe(
      '/tmp/occ-test-plugin-data/lsp-test@market',
    )
    expect(resolved.workspaceFolder).toBe('/plugins/lsp-test/ws')
    expect(resolved.initializationOptions).toEqual({ x: 'FOO' })
  })

  test('a missing user_config key in command still throws (strict path preserved)', () => {
    // Arrange
    clearLogs()
    const config = { command: 'run-${user_config.bar}' }

    // Act & Assert — the lenient warn-and-leave behavior applies ONLY to
    // initializationOptions/settings; command/args/env keep the strict throw.
    expect(() =>
      resolvePluginLspEnvironment(config, TEST_PLUGIN, {}),
    ).toThrow(/Missing required user configuration value: bar/)
  })
})
