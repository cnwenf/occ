/**
 * Live-path child driver for the CC-295 plugin settings-load warning wiring
 * test (pluginSettingsWarnWiring295.test.ts).
 *
 * Spawned as a REAL `bun` subprocess. It drives the actual
 * `marketplaceAddHandler` (src/cli/handlers/plugins.ts) end-to-end:
 *   parseMarketplaceInput → addMarketplaceSource (local directory fixture)
 *   → saveMarketplaceToSettings → warnIfSettingsFileDoesNotLoad(settingSource)
 *   → cliOk (process.exit(0)).
 *
 * The parent test pre-breaks `<CLAUDE_CONFIG_DIR>/settings.json`; because
 * updateSettingsForSource refuses to overwrite an unparseable file, it stays
 * broken, so the 2.1.295 warning (`... does not load (it is not a JSON
 * object), ...`) must print while the command still exits 0.
 *
 * Like antFastExitDriver.ts this deliberately does NOT run main.tsx's full
 * startup (growthbook/analytics fetches hang without a live gateway); the
 * handler is the unit under test. The MACRO/BUILD_* polyfills mirror
 * src/entrypoints/cli.tsx so transitive imports work outside the bundler.
 */

// Set globals BEFORE the dynamic import — static imports would hoist above.
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.295',
  BINARY_NAME: 'occ',
  BUILD_TIME: new Date().toISOString(),
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '@cnwenf/occ',
  VERSION_CHANGELOG: '',
}
;(globalThis as Record<string, unknown>).BUILD_TARGET = 'external'
;(globalThis as Record<string, unknown>).BUILD_ENV = 'production'
;(globalThis as Record<string, unknown>).INTERFACE_TYPE = 'stdio'

const { marketplaceAddHandler } = await import('../handlers/plugins.js')

// argv: [bun, driver, <marketplace-dir>]
const source = process.argv[2]
if (typeof source !== 'string' || source === '') {
  console.error('driver: missing marketplace source argument')
  process.exit(2)
}

await marketplaceAddHandler(source, { scope: 'user' })
