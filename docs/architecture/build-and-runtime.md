# Build & Runtime

OCC runs on **Bun** (not Node.js) and builds to a single-file bundle. This
document covers the runtime, the build pipeline, the entrypoint bootstrap, and
the polyfills that make a build-time-macro codebase work at dev time.

## Runtime: Bun

- **Runtime**: Bun >= 1.3.11 (older Bun causes spurious errors; `bun upgrade`).
- **Module system**: ESM (`"type": "module"` in `package.json`), TSX with the
  `react-jsx` transform (no manual `import React`).
- **Monorepo**: Bun workspaces — internal packages in `packages/` resolve via
  `"workspace:*"`.
- **Test runner**: Bun's built-in `bun test` (config in `bunfig.toml`,
  `root="."`, `timeout=10000`).
- **Package manager**: Bun (`bun.lock`).

Bun is chosen for speed and because the upstream codebase uses `bun:bundle` —
a build-time API that Bun's bundler understands natively.

## Build pipeline

The build is driven by `scripts/build.ts`, which wraps `bun build` with a
plugin that rewrites the `bun:bundle` import:

```ts
// scripts/build.ts (pattern)
const occBundlePlugin = {
  name: 'occ-bundle',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'occ:bundle', namespace: 'occ-bundle',
    }))
    build.onLoad({ filter: /.*/, namespace: 'occ-bundle' }, () => ({
      contents:
        `const A = new Set(${JSON.stringify([...FEATURE_ALLOWLIST])});` +
        `export const feature = (n) => A.has(n);`,
      loader: 'js',
    }))
  },
}
await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  target: 'bun',
  plugins: [occBundlePlugin],
})
```

The output is a single `dist/cli.js` (~25 MB). `package.json` exposes it as the
`occ` bin. The build allowlist (`TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`)
keeps the auto-mode classifier code in the bundle; runtime gating is handled by
`AUTO_MODE_ENABLED_DEFAULT` + `modelSupportsAutoMode` since OCC has no Statsig.

Native-installer downloads (`src/utils/nativeInstaller/download.ts`) retry
transient failures (mid-stream drops / stalls) with backoff before failing
(2.1.204, #15), so a flaky connection no longer aborts an install mid-stream.

## The `bun:bundle` / `feature()` mechanism

Upstream Claude Code calls `feature('FLAG_NAME')` imported from `bun:bundle`.
At build time the bundler inlines each call to `true` or `false` and
dead-code-eliminates the `false` branches. OCC cannot use that mechanism for
runtime experimentation, so it replaces `bun:bundle` with a module whose
`feature(n)` is a runtime `Set.has(n)` against the `FEATURE_ALLOWLIST`.

Two allowlists exist and must stay in sync:

| Location | When it applies | Allowlist |
|---|---|---|
| `src/utils/featureFlags.ts` | `bun run dev` (direct execution) | The full live set (workflow, monitor, skills, classifiers) |
| `scripts/build.ts` `FEATURE_ALLOWLIST` | `bun run build` (bundle) | Only the two classifier flags |

The dev allowlist is larger because dev mode runs source directly; the build
allowlist is intentionally minimal to mirror the official external build, which
includes the auto-mode code and gates it at runtime.

## Entrypoint bootstrap

### `src/entrypoints/cli.tsx` — the true entrypoint

This file runs **first** and injects polyfills before any other module loads:

1. **`feature()`** — defined as `_FEATURE_ALLOWLIST.has(name)`. In dev it
   includes the live flags; note the file-level allowlist here is a *subset*
   (`TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`) used for the fast-path gating.
   The canonical runtime allowlist is `src/utils/featureFlags.ts`.
2. **`globalThis.MACRO`** — simulates build-time macro injection:
   `VERSION` (`"2.1.204"`), `BUILD_TIME`, `FEEDBACK_CHANNEL`, `ISSUES_EXPLAINER`,
   `NATIVE_PACKAGE_URL`, `PACKAGE_URL`, `VERSION_CHANGELOG`.
3. **`BUILD_TARGET = "external"`**, **`BUILD_ENV = "production"`**,
   **`INTERFACE_TYPE = "stdio"`** — globals read throughout the codebase.
4. **Corepack pinning fix** — sets `COREPACK_ENABLE_AUTO_PIN=0`.
5. **CCR heap sizing** — when `CLAUDE_CODE_REMOTE=true`, raises
   `--max-old-space-size=8192` for child processes.
6. **Ablation baseline** — behind `feature("ABLATION_BASELINE")` (off in OCC).

The `main()` function then implements **fast paths** that avoid loading the
full CLI:

- `--version` / `-v` — prints `${MACRO.VERSION} (Claude Code)` and exits with
  zero further imports.
- `--dump-system-prompt` — (feature-gated, off) renders the system prompt.
- `--claude-in-chrome-mcp`, `--chrome-native-host` — Chrome integrations.
- `--computer-use-mcp` — (feature-gated `CHICAGO_MCP`, off).

For all other paths it dynamically imports `src/main.tsx` and hands off.

### `src/main.tsx` — Commander CLI

~4900 lines. Parses arguments with `@commander-js/extra-typings`, initializes
services (auth, analytics, policy, config), then either:

- launches the interactive REPL (`src/screens/REPL.tsx` via the Ink render
  wrapper in `src/ink.ts`), or
- runs in **pipe mode** (`-p`): reads stdin, runs one query, prints, exits.

### `src/entrypoints/init.ts` — one-time init

Telemetry setup, config loading, trust dialog, and other first-run concerns.

### Other entrypoints

- **`src/entrypoints/mcp.ts`** — runs OCC itself as an MCP server, exposing
  slash commands (e.g. `/review`) as MCP tools.
- **`src/entrypoints/sdk/`** — the `@anthropic-ai/claude-agent-sdk` public
  surface: `coreTypes`, `controlTypes`, `runtimeTypes`, `settingsTypes`,
  `toolTypes`. Generated files are marked `.generated.ts`.

## TypeScript configuration

`tsconfig.json`:

- `target`/`module`: `ESNext`; `moduleResolution: bundler`.
- `jsx: react-jsx` (automatic runtime).
- **`strict: false`**, **`skipLibCheck: true`**, `noEmit: true`.
- Path alias: `"src/*": ["./src/*"]` — imports like
  `import { feature } from 'src/utils/featureFlags.js'` are valid.
- `types: ["bun"]`.

`tsc` is **not** part of CI. The codebase carries ~1341 type errors (mostly
`unknown`/`never`/`{}`), which do not affect Bun execution. Biome lint is the
quality gate.

## Lint and hooks

- **Biome** (`biome.json`) — lint is the gate; the formatter is **disabled** to
  avoid massive diffs (`bun run format` exists but `format` is not enforced).
  Many `suspicious` rules are deliberately off to tolerate the loose output.
- **`.githooks/`** — a `pre-commit` hook (wired via `bun run prepare` →
  `git config core.hooksPath .githooks`) runs `biome lint` on staged
  `src/*.{ts,tsx,js,jsx}`. Bypass with `--no-verify` when lint errors are
  pre-existing noise.
- **knip** (`knip.json`, `bun run check:unused`) — detects unused
  exports/dependencies.
- **health check** (`scripts/health-check.ts`, `bun run health`).

## Key commands

```bash
bun install                 # dependencies
bun run dev                 # dev mode (direct execution); version prints 888 when working
bun run build               # → dist/cli.js (~25 MB)
bun run lint                # biome lint src/
bun test                    # Bun test runner
bun test test/e2e           # a directory
bun test path/to/file.test.ts  # a single file
bun run check:unused        # knip
bun run health              # health check
```

Pipe mode: `echo "say hello" | bun run src/entrypoints/cli.tsx -p`.

## React Compiler output

Components throughout `src/components/` and `src/screens/` contain
memoization boilerplate produced by the React Compiler:

```tsx
// pattern — normal in this codebase
const $ = _c(20)
if ($[0] !== activeContexts || …) {
  // …
  $[4] = activeContexts
}
```

This is expected. Do not "clean it up" — it is generated output.
