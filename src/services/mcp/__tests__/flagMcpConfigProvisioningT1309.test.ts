/**
 * 309 review T-1 (P2 MUST-FIX, `static-findings-tests:T-1`): the
 * `--mcp-config` security chain's PROVISIONING ENTRY was untested.
 * `collectFlagMcpConfigFilePath` (main.tsx file-path branch) +
 * `setFlagMcpConfigFilePaths` (after the loop, BEFORE the fatal-error early
 * return — official `Ses(L(je))`) run only inside the real CLI parse path, so
 * a mutation probe confirmed that deleting the setter call kept all three
 * downstream suites green (store / denyWrite / auto-edit guard each have unit
 * tests, but nothing pinned the ENTRY wiring): a refactor dropping the
 * recording would let the sandbox rewrite `--mcp-config` files (command
 * injection through config) with zero CI signal.
 *
 * Driving `main()` is INFEASIBLE locally (the entry is inline in the ~1100-line
 * boot function; the review verdict was BLOCKED, not falsified). Per the
 * review's accepted option B this file provides BOTH halves:
 *
 *  1. A focused BEHAVIORAL probe that runs collect+set exactly the way
 *     main.tsx does for a file-path entry (resolve → parseDynamicMcpConfigFromFile
 *     → collectFlagMcpConfigFilePath → setFlagMcpConfigFilePaths) and asserts
 *     `convertToSandboxRuntimeConfig({}).filesystem.denyWrite` contains the
 *     recorded paths — including the "record REGARDLESS of parse outcome"
 *     semantics for a parse-failing config file.
 *  2. A source-level WIRING PIN on src/main.tsx (readFile + indexOf ordering,
 *     the same technique as privacySettingsFetch309's source pin) that kills
 *     the exact mutation: deleting the collect push, deleting the setter call,
 *     or moving the setter after the fatal-error early return each turn this
 *     suite RED.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { resetSettingsCache, setCachedSettingsForSource } from '../../../utils/settings/settingsCache.js'
import type { SettingSource } from '../../../utils/settings/constants.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import { convertToSandboxRuntimeConfig } from '../../../utils/sandbox/sandbox-adapter.js'
import { parseDynamicMcpConfigFromFile } from '../config.js'
import {
  collectFlagMcpConfigFilePath,
  getFlagMcpConfigFilePaths,
  resetFlagMcpConfigFilePathsForTest,
  setFlagMcpConfigFilePaths,
} from '../flagMcpConfigFilePaths.js'

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-309-t1-provisioning-'))
  fixtureRoots.push(root)
  return root
}

/** Seed every source through the settings cache (null = no settings). */
function seed(): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, null)
  }
}

/**
 * main.tsx's file-path `--mcp-config` entry sequence, verbatim ordering
 * (main.tsx ~1802-1849): resolve → parse (outcome ignored for recording) →
 * collect → set BEFORE the fatalErrors early return.
 */
async function provisionLikeMain(configItems: string[]): Promise<void> {
  const flagMcpConfigPaths: string[] = []
  for (const configItem of configItems) {
    const configPath = resolve(configItem)
    parseDynamicMcpConfigFromFile({
      filePath: configPath,
      expandVars: true,
      scope: 'dynamic',
    })
    flagMcpConfigPaths.push(
      ...(await collectFlagMcpConfigFilePath(configPath)),
    )
  }
  setFlagMcpConfigFilePaths(flagMcpConfigPaths)
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

describe('309 review T-1 — --mcp-config provisioning entry (behavioral probe)', () => {
  test('a file-path entry provisioned like main.tsx lands in the store AND sandbox denyWrite', async () => {
    // Arrange
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{"probe":{"type":"stdio","command":"true"}}}')

    // Act — exactly the main.tsx sequence
    await provisionLikeMain([configFile])

    // Assert — store holds both spellings (official je.push(ge,Qo))
    const recorded = getFlagMcpConfigFilePaths()
    expect(recorded).toContain(configFile)
    expect(recorded).toContain(realpathSync(configFile))
    // Assert — the sandbox config consumes the store (official ct.push(...oSe()))
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(config.filesystem.denyWrite).toContain(configFile)
    expect(config.filesystem.denyWrite).toContain(realpathSync(configFile))
  })

  test('a PARSE-FAILING config file is still recorded (record-regardless semantics)', async () => {
    // Arrange — invalid JSON: main.tsx records the path regardless of parse
    // outcome (stat/realpath gate only), because a config that fails to parse
    // is still a file the sandbox must not be able to rewrite.
    const root = makeFixtureRoot()
    const brokenFile = join(root, 'broken.json')
    writeFileSync(brokenFile, '{not valid json')

    // Act
    await provisionLikeMain([brokenFile])

    // Assert
    expect(getFlagMcpConfigFilePaths()).toContain(brokenFile)
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(config.filesystem.denyWrite).toContain(brokenFile)
  })

  test('a nonexistent path is still recorded (stat-error fail-open — only a successful non-file stat excludes)', async () => {
    // Arrange — collectFlagMcpConfigFilePath's gate: stat error → record
    // anyway (a config that cannot be stat'd must still be deny-listed);
    // realpath falls back to the input spelling, and the setter dedups.
    const root = makeFixtureRoot()
    const missing = join(root, 'absent.json')

    // Act
    await provisionLikeMain([missing])

    // Assert
    expect(getFlagMcpConfigFilePaths()).toEqual([missing])
  })

  test('a DIRECTORY path records nothing (successful stat, not a file)', async () => {
    // Arrange
    const root = makeFixtureRoot()

    // Act
    await provisionLikeMain([root])

    // Assert
    expect(getFlagMcpConfigFilePaths()).toEqual([])
  })
})

describe('309 review T-1 — main.tsx wiring pin (mutation killer)', () => {
  // Read the real entrypoint source; pin the three wiring facts whose removal
  // the review's mutation probe showed CI could not see.
  const mainSource = readFileSync(
    join(import.meta.dir, '../../../main.tsx'),
    'utf8',
  )

  const COLLECT_CALL =
    'flagMcpConfigPaths.push(...await collectFlagMcpConfigFilePath(configPath));'
  const SET_CALL = 'setFlagMcpConfigFilePaths(flagMcpConfigPaths);'
  const FATAL_GATE = 'if (fatalErrors.length > 0) {'
  const FILE_BRANCH_START = 'const configPath = resolve(configItem);'

  test('the collect call exists in the file-path branch', () => {
    const branchIdx = mainSource.indexOf(FILE_BRANCH_START)
    const collectIdx = mainSource.indexOf(COLLECT_CALL)
    expect(branchIdx).toBeGreaterThan(-1)
    expect(collectIdx).toBeGreaterThan(-1)
    // The collect runs AFTER the file-path branch opens (inside the else).
    expect(collectIdx).toBeGreaterThan(branchIdx)
  })

  test('the setter call exists after the loop', () => {
    expect(mainSource.indexOf(SET_CALL)).toBeGreaterThan(-1)
  })

  test('ordering: collect < setter < fatal-error early return (official `Ses(L(je))` before exit)', () => {
    const collectIdx = mainSource.indexOf(COLLECT_CALL)
    const setIdx = mainSource.indexOf(SET_CALL)
    const fatalIdx = mainSource.indexOf(FATAL_GATE, setIdx)
    expect(collectIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(collectIdx)
    // The fatal-error gate must come AFTER the setter — deleting/moving the
    // setter past the early return is the exact mutation this pin kills.
    expect(fatalIdx).toBeGreaterThan(setIdx)
  })
})
