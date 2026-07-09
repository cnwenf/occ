# Installation

OCC runs on [Bun](https://bun.sh/) (not Node.js) and is published to npm as [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ). You can install the prebuilt binary or build from source.

## Requirements

- **Bun >= 1.3.11** — OCC uses Bun APIs for all imports, builds, and execution. Older Bun versions cause spurious errors; run `bun upgrade` if unsure.
- A valid LLM provider credential:
  - Anthropic direct: `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`)
  - AWS Bedrock: `CLAUDE_CODE_USE_BEDROCK` + AWS credentials
  - Google Vertex: `CLAUDE_CODE_USE_VERTEX` + GCP credentials
  - Azure Foundry: `CLAUDE_CODE_USE_FOUNDRY`

## Install from npm

```bash
npm i -g @cnwenf/occ
occ
```

The published package ships only the built bundle (`files: ["dist"]`). The `occ` binary points to `dist/cli.js`, a single-file ~26 MB bundle.

Verify it works:

```bash
occ --version
# 2.1.204 (Claude Code)
```

## Build from source

Clone the repo and install dependencies with Bun:

```bash
git clone <repo-url> occ
cd occ
bun install
```

### Run from source (dev mode)

```bash
bun run dev
# equivalent to: bun run src/entrypoints/cli.tsx
```

When working, the version prints as `2.1.204 (Claude Code)`. The dev-time entrypoint (`src/entrypoints/cli.tsx`) injects the runtime polyfills (`feature()`, `globalThis.MACRO`) that the built bundle gets from `bun:bundle`.

### Build the bundle

```bash
bun run build
```

Output: `dist/cli.js` (~26 MB, 5300+ modules, single-file bundle targeting `bun`). The build script (`scripts/build.ts`) uses `Bun.build` with an `occBundlePlugin` that redirects `bun:bundle`'s `feature()` to a runtime allowlist so feature-gated code is not dead-code-eliminated.

### Run tests

```bash
bun test                       # full suite
bun test test/e2e              # a directory
bun test path/to/file.test.ts  # a single file
```

Bun test runner config (`bunfig.toml`): root `.`, 10s timeout per test.

## npm scripts

| Script | Command | Purpose |
|---|---|---|
| `build` | `bun run scripts/build.ts` | Bundle to `dist/cli.js` |
| `dev` | `bun run src/entrypoints/cli.tsx` | Run from source |
| `prepublishOnly` | `bun run build` | Build before npm publish |
| `lint` | `biome lint src/` | Lint source |
| `lint:fix` | `biome lint --fix src/` | Lint + autofix |
| `format` | `biome format --write src/` | Format (disabled in practice to avoid large diffs) |
| `prepare` | `git config core.hooksPath .githooks` | Wire git hooks |
| `test` | `bun test` | Run Bun test runner |
| `check:unused` | `knip-bun` | Detect unused exports/deps |
| `health` | `bun run scripts/health-check.ts` | Code health check |

## Linting and formatting

OCC uses [Biome](https://biomejs.dev/) for linting. The formatter is intentionally disabled to avoid massive diffs — lint is the gate, not `tsc`.

```bash
bun run lint        # lint only
bun run lint:fix    # lint + autofix
```

A `pre-commit` hook (`.githooks/pre-commit`, wired via `bun run prepare`) runs `biome lint` on staged `src/*.{ts,tsx,js,jsx}` files. Bypass with `--no-verify` when lint errors are from pre-existing noise.

## TypeScript

`tsconfig.json` uses `strict: false` and `skipLibCheck: true`. The codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types) that do **not** affect Bun runtime execution. `tsc` is not part of CI.

Key `tsconfig.json` settings:

- `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`
- `jsx: react-jsx`, `strict: false`, `skipLibCheck: true`, `noEmit: true`
- `types: ["bun"]`
- Path alias: `src/*` → `./src/*` (so `import { ... } from 'src/utils/...'` is valid)

## Monorepo layout

OCC is a Bun workspaces monorepo. Internal stub packages live in `packages/` and `packages/@ant/`, resolved via `workspace:*`. Most `*-napi` packages (audio, image, url, modifiers) are stubs — except `color-diff-napi`, which is fully implemented. `@ant/*` packages (Computer Use) are stubs.

## Environment variables (quick reference)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic direct API key |
| `ANTHROPIC_AUTH_TOKEN` | Alternate auth token |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (subscription auth) |
| `CLAUDE_CODE_USE_BEDROCK` | Select AWS Bedrock provider |
| `CLAUDE_CODE_USE_VERTEX` | Select Google Vertex provider |
| `CLAUDE_CODE_USE_FOUNDRY` | Select Azure Foundry provider |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Claude Platform on AWS |
| `CLAUDE_CODE_USE_MANTLE` | Bedrock Mantle |
| `ANTHROPIC_BASE_URL` | Override the API base URL |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Skip Bedrock credential checks (proxy) |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | Skip Vertex credential checks |
| `CLAUDE_CODE_SIMPLE` | Set to `1` by `--bare` (minimal mode) |
| `CLAUDE_CODE_SAFE_MODE` | Set to `1` by `--safe-mode` |
| `DISABLE_COMPACT` | Disable `/compact` |
| `DISABLE_DOCTOR_COMMAND` | Disable `/doctor` |

See [Settings](./settings.md) for the full environment variable reference.

## Next steps

- [Quickstart](./quickstart.md) — run your first session
- [CLI Reference](./cli-reference.md) — every flag and subcommand
