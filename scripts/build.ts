/**
 * OCC build script. Wraps `bun build` with a plugin that redirects
 * `bun:bundle`'s `feature()` to a runtime allowlist — otherwise the bundler
 * inlines `feature('FLAG')` to `false` (its default) and dead-code-eliminates
 * every flagged branch (e.g. the entire auto-mode classifier). With the plugin,
 * `feature(name)` is a runtime call against the allowlist, so the flagged code
 * is kept in the bundle and executes when the flag is in the allowlist.
 *
 * The allowlist enables the auto-mode features (TRANSCRIPT_CLASSIFIER +
 * BASH_CLASSIFIER) to match the official external build, which includes the
 * auto-mode code and gates it at runtime via Statsig (OCC has no Statsig, so
 * the AUTO_MODE_ENABLED_DEFAULT + modelSupportsAutoMode handle runtime gating).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const binaryNames = Object.keys(pkg.bin ?? {})
if (binaryNames.length !== 1) {
  throw new Error(
    `Expected package.json to expose exactly one CLI binary, found ${binaryNames.length}`,
  )
}
const binaryName = binaryNames[0]

const FEATURE_ALLOWLIST = new Set([
  'TRANSCRIPT_CLASSIFIER', // auto permission mode (AI classifier)
  'BASH_CLASSIFIER', // bash-command classification used by auto mode
])

// Force production NODE_ENV at build time. Bun's bundler statically replaces
// `process.env.NODE_ENV` (it captures the OS env at process spawn, so setting
// process.env inside this script is too late). Without this define, Bun
// defaults to "development", which bakes `=== 'development'` to `true`
// everywhere — e.g. doctorDiagnostic.ts → getCurrentInstallationType returns
// "development", blocking `occ update` with "Cannot update development build".
// It also keeps React's dev checks + warnings in the bundle.
const NODE_ENV_DEFINE = { 'process.env.NODE_ENV': '"production"' }

const occBundlePlugin = {
  name: 'occ-bundle',
  setup(build: any) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'occ:bundle',
      namespace: 'occ-bundle',
    }))
    build.onLoad({ filter: /.*/, namespace: 'occ-bundle' }, () => ({
      contents:
        `const A = new Set(${JSON.stringify([...FEATURE_ALLOWLIST])});` +
        `export const feature = (n) => A.has(n);`,
      loader: 'js' as const,
    }))
  },
}

const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  target: 'bun',
  plugins: [occBundlePlugin],
  define: NODE_ENV_DEFINE,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const o of result.outputs) {
  console.log(`  ${o.path.split('/').pop()}  ${(o.size / 1024 / 1024).toFixed(2)} MB`)
}

// Inject real MACRO values into the bundle. cli.tsx ships a dev-time polyfill
// that hardcodes a version (e.g. "2.1.261"); without this step every release
// reports the polyfill version instead of the package version. Prepending
// globalThis.MACRO here makes cli.tsx's `if (typeof globalThis.MACRO === "undefined")`
// check skip the hardcoded fallback.
const macros = {
  VERSION: pkg.version,
  BINARY_NAME: binaryName,
  BUILD_TIME: new Date().toISOString(),
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
}
const distPath = join(import.meta.dir, '..', 'dist', 'cli.js')
let dist = readFileSync(distPath, 'utf-8')
const prelude = `globalThis.MACRO=${JSON.stringify(macros)};`
// Insert right after the shebang line so the binary stays executable.
dist = dist.replace(/^(#![^\n]*\n)/, `$1${prelude}\n`)
writeFileSync(distPath, dist)
console.log(`  injected MACRO.VERSION=${macros.VERSION}`)
console.log(`  injected MACRO.BINARY_NAME=${macros.BINARY_NAME}`)
