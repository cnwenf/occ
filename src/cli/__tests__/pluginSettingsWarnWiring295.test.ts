/**
 * CC-295 plugin settings-load warning — CLI WIRING test (review gap 3).
 *
 * The three new `warnIfSettingsFileDoesNotLoad` call sites
 * (marketplaceAddHandler in src/cli/handlers/plugins.ts, installPlugin /
 * enablePlugin in src/services/plugins/pluginCliCommands.ts) had zero test
 * coverage: deleting the calls kept every existing suite green. This drives
 * the REAL marketplace-add path in a child `bun` process against a REAL
 * broken settings file and asserts the official warning prints while the
 * command still exits 0 — removing the warn call from marketplaceAddHandler
 * turns this test red.
 *
 * Scenario: `<CLAUDE_CONFIG_DIR>/settings.json` contains malformed JSON.
 * `saveMarketplaceToSettings` → `updateSettingsForSource` refuses to
 * overwrite an unparseable file (returns an ignored `{error}`), so the file
 * stays broken and the post-write check must warn
 * `... does not load (it is not a JSON object), ...`.
 *
 * Child-process pattern follows antFastExitCostSave277.test.ts: the driver
 * imports the real handler directly (no main.tsx startup — growthbook hangs
 * without a live gateway). No network: the marketplace source is a local
 * directory fixture.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DRIVER = join(import.meta.dir, 'pluginSettingsWarnWiring295Driver.ts')
const SPAWN_TIMEOUT_MS = 60_000
const BROKEN_SETTINGS = 'this is { not json'

describe('CC-295 wiring: marketplace add warns when the written settings file does not load', () => {
  test('real handler + broken settings.json → official warning printed, exit 0', () => {
    const home = mkdtempSync(join(tmpdir(), 'occ-warn-home-'))
    const cfgDir = mkdtempSync(join(tmpdir(), 'occ-warn-cfg-'))
    const workDir = mkdtempSync(join(tmpdir(), 'occ-warn-work-'))
    const marketDir = join(workDir, 'warn-wiring-market')
    try {
      // Local-directory marketplace fixture (PluginMarketplaceSchema-minimal).
      mkdirSync(join(marketDir, '.claude-plugin'), { recursive: true })
      writeFileSync(
        join(marketDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'warn-wiring-market',
          owner: { name: 'OCC Test' },
          plugins: [],
        }),
      )

      // Pre-break the user settings file the command will try to declare the
      // marketplace in. updateSettingsForSource must NOT overwrite it.
      const settingsPath = join(cfgDir, 'settings.json')
      writeFileSync(settingsPath, BROKEN_SETTINGS)

      const child = spawnSync(process.execPath, [DRIVER, marketDir], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          CLAUDE_CONFIG_DIR: cfgDir,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      })

      expect(child.error).toBeUndefined()
      // cliOk → process.exit(0): the warning is non-fatal.
      expect(child.status).toBe(0)
      // The command itself succeeded…
      expect(child.stdout).toContain('Successfully added marketplace')
      // …and the 2.1.295 warning fired with the malformed-JSON reason.
      expect(child.stdout).toContain(
        `${settingsPath} does not load (it is not a JSON object),`,
      )
      expect(child.stdout).toContain(
        'so Claude Code ignores the whole file, including anything this command wrote there.',
      )

      // The broken file was NOT silently repaired/overwritten — exactly the
      // data-loss-free behavior the warning exists to disclose.
      expect(readFileSync(settingsPath, 'utf8')).toBe(BROKEN_SETTINGS)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cfgDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
