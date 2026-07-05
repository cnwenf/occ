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
const FEATURE_ALLOWLIST = new Set([
  'TRANSCRIPT_CLASSIFIER', // auto permission mode (AI classifier)
  'BASH_CLASSIFIER', // bash-command classification used by auto mode
])

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
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const o of result.outputs) {
  console.log(`  ${o.path.split('/').pop()}  ${(o.size / 1024 / 1024).toFixed(2)} MB`)
}
