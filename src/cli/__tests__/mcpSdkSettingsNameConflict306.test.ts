/**
 * CC 2.1.306 (#P6): cloud/SDK `setMcpServers` servers must not be replaced by
 * a same-named server from user settings mid-session.
 *
 * Official forensics: the fix is string-less (updateSdkMcp handler region
 * v304@273218199 ↔ v306@274796556 byte-identical; candidate string counts all
 * flat), so this is a semantics-level port per the 2.1.306 changelog.
 *
 * OCC bug: `applyPluginMcpDiff` merged SDK-registered servers into the
 * desired-state map with a `!(name in supportedConfigs)` guard — on a name
 * conflict the freshly-reloaded SETTINGS entry won, and handleMcpSetServers
 * then removed the SDK server (its name left the sdk desired-state set) and
 * connected the settings one. Fix: SDK entries are assigned unconditionally
 * after the settings loop, so they win conflicts (mergeSupportedMcpConfigs).
 */
import { describe, expect, test } from 'bun:test'
import type {
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import { mergeSupportedMcpConfigs } from '../print.js'

function makeSettingsStdio(
  _name: string,
  command: string,
): ScopedMcpServerConfig {
  return {
    type: 'stdio',
    command,
    args: [],
    scope: 'user',
  } as unknown as ScopedMcpServerConfig
}

function makeSdkConfig(name: string): McpSdkServerConfig {
  return { type: 'sdk', name } as unknown as McpSdkServerConfig
}

describe('CC 2.1.306 mergeSupportedMcpConfigs SDK precedence', () => {
  test('sdk config "x" + settings config "x" resolves to the sdk one', () => {
    // Arrange
    const settings = { x: makeSettingsStdio('x', 'npx') }
    const sdk = { x: makeSdkConfig('x') }

    // Act
    const merged = mergeSupportedMcpConfigs(settings, sdk)

    // Assert — the SDK/cloud-provided server survives the settings reload
    expect(Object.keys(merged)).toEqual(['x'])
    expect(merged.x.type).toBe('sdk')
    expect(merged.x).not.toHaveProperty('command')
  })

  test('non-conflicting settings and sdk servers are both carried', () => {
    // Arrange
    const settings = { a: makeSettingsStdio('a', 'node') }
    const sdk = { b: makeSdkConfig('b') }

    // Act
    const merged = mergeSupportedMcpConfigs(settings, sdk)

    // Assert
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
    expect(merged.a.type).toBe('stdio')
    expect(merged.b.type).toBe('sdk')
  })

  test('legacy settings entries without a type pass through', () => {
    // Arrange
    const settings = {
      legacy: { command: 'npx', args: [], scope: 'user' } as unknown as ScopedMcpServerConfig,
    }

    // Act
    const merged = mergeSupportedMcpConfigs(settings, {})

    // Assert
    expect(merged.legacy).toBeDefined()
    expect(merged.legacy.command).toBe('npx')
  })

  test('settings entries of unsupported transport types are filtered out', () => {
    // Arrange
    const settings = {
      ide: { type: 'ws-ide', scope: 'local' } as unknown as ScopedMcpServerConfig,
    }

    // Act
    const merged = mergeSupportedMcpConfigs(settings, {})

    // Assert
    expect(merged).toEqual({})
  })

  test('non-sdk entries inside sdkMcpConfigs never overwrite settings', () => {
    // Arrange — defensive: the sdk-state bag should only hold type:'sdk',
    // but the merge must not promote anything else over a settings entry.
    const settings = { x: makeSettingsStdio('x', 'npx') }
    const sdk = {
      x: { type: 'stdio', command: 'evil', args: [] } as unknown as McpSdkServerConfig,
    }

    // Act
    const merged = mergeSupportedMcpConfigs(settings, sdk)

    // Assert
    expect(merged.x.type).toBe('stdio')
    expect(merged.x.command).toBe('npx')
  })
})
