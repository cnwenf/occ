/**
 * CC 2.1.309 (triage-T1-A item 3, security 🔒): `--mcp-config` files must be
 * write-denied inside the sandbox — a sandboxed command could otherwise
 * rewrite the MCP server definitions that the UNSANDBOXED client later
 * spawns (command injection through config).
 *
 * Byte evidence (official 2.1.309 linux-x64 ELF @246583300, read-only dd;
 * 308 baseline @245721400 lacks the two pushes):
 *   308: `if(mt.push(...pbe()),De.push(...mt.map(qs)),…`
 *   309: `if(ct.push(...rSe()),ct.push(...oSe()),De.push(...ct.map(Qs)),…`
 * — `ct` is the settings-path deny accumulator (SETTING_SOURCES paths +
 * managed drop-in dir), `rSe()`=flagAgentsFilePaths (no OCC counterpart —
 * sub-gap), `oSe()`=flagMcpConfigFilePaths, `De`=denyWrite, `Qs`=path
 * spelling normalizer (OCC pushes raw strings, consistent with its existing
 * settingsPaths handling).
 *
 * OCC port: sandbox-adapter.ts denyWrite builder — push the store contents
 * right after the managed-settings drop-in dir push.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetFlagMcpConfigFilePathsForTest,
  setFlagMcpConfigFilePaths,
} from '../../../services/mcp/flagMcpConfigFilePaths.js'
import { setCachedSettingsForSource, resetSettingsCache } from '../../settings/settingsCache.js'
import type { SettingSource } from '../../settings/constants.js'
import type { SettingsJson } from '../../settings/types.js'
import { convertToSandboxRuntimeConfig } from '../sandbox-adapter.js'

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-309-denywrite-'))
  fixtureRoots.push(root)
  return root
}

/** Seed every source through the settings cache (null = no settings). */
function seed(): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, null)
  }
}

beforeEach(() => {
  resetSettingsCache()
  seed()
})

afterEach(() => {
  resetFlagMcpConfigFilePathsForTest()
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('CC 2.1.309 item 3 — --mcp-config paths in sandbox denyWrite', () => {
  test('recorded --mcp-config paths land in denyWrite', () => {
    // Arrange
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{}}')
    setFlagMcpConfigFilePaths([configFile])

    // Act
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    // Assert — official 309: `ct.push(...oSe())` → denyWrite
    expect(config.filesystem.denyWrite).toContain(configFile)
  })

  test('both the resolved path and its realpath spelling are denied', () => {
    // Arrange — main.tsx records both spellings (official je.push(ge,Qo))
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{}}')
    const realConfigFile = require('fs').realpathSync(configFile) as string
    setFlagMcpConfigFilePaths([configFile, realConfigFile])

    // Act
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    // Assert
    expect(config.filesystem.denyWrite).toContain(configFile)
    expect(config.filesystem.denyWrite).toContain(realConfigFile)
  })

  test('empty store adds nothing to denyWrite', () => {
    // Arrange
    const root = makeFixtureRoot()

    // Act
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    // Assert — no stray entries under the fixture root
    expect(
      config.filesystem.denyWrite.filter(entry => entry.startsWith(root)),
    ).toEqual([])
  })
})
