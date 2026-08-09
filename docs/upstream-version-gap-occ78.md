# Upstream Version Gap — OCC-78 (2.1.226 re-confirm + staged item #3 resolution)

**Round:** OCC-78, 2026-08-10
**OCC entering state:** `2.1.298` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.224** per OCC-65/OCC-69; one staged item from the OCC-69 triage: **#3**, the 2.1.225 "transient 401 replaces a long-lived `CLAUDE_CODE_OAUTH_TOKEN`" fix, deferred for a dedicated decompilation round).
**Official target this round:** re-confirm latest. Result: **`2.1.226`** unchanged — no new official release since OCC-69.

## 1. Official latest — re-verified three ways (no new release)

| Source | Result |
|---|---|
| npm registry | `@anthropic-ai/claude-code` `latest` = `next` = `2.1.226` |
| GitHub | latest tag/release `v2.1.226` (published 2026-08-08); release count matches tags |
| Fresh ELF | `npm pack @anthropic-ai/claude-code-linux-x64@2.1.226` → 242 `2.1.226` string markers, **zero** `2.1.227+` markers |

So this round = (a) close the staged OCC-69 item #3, (b) strict self-acceptance per the issue's "版本追齐后的自验收" (consistency with official `claude-code` as the done-gate).

## 2. Staged item #3 — RESOLVED: N/A via structural immunity (regression test landed)

Dedicated decompilation round on the 2.1.224 vs 2.1.225 linux-x64 ELFs (byte-recovered from `/tmp` pack + `strings` of the embedded JS chunk), per `aligning-with-official-binary`.

**Official fix anatomy** (2.1.224 `AaS` → 2.1.225 `rES`, the no-`refreshToken` branch of `handleOAuth401Error`):

- 2.1.224 unconditionally **adopted** a differing stored credential on 401 — `process.env.CLAUDE_CODE_OAUTH_TOKEN = stored.accessToken` — so a stale stored login token replaced a user-supplied long-lived env token and headless sessions 401'd until restart.
- 2.1.225 added: (a) a guard skipping adoption when the user supplied the env token (not a remote-session child: `!CLAUDE_CODE_REMOTE_SESSION_ID`, no `ANTHROPIC_UNIX_SOCKET`) — telemetry reason `oauth_401_skipped_user_env_token` + the "keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential…" error log; (b) an expiry gate on adoption (`!isOAuthTokenExpired(stored.expiresAt)`, 300 s skew). The surrounding machinery (SDK `getOAuthToken` callback refresh, rotated-env wait `tES`, zombie-exit accounting `PMr`, FD token reader `Yce`/`Kle`) is the trimmed CCR/desktop/SDK recovery stack.

**Verdict for OCC: N/A via structural immunity** (same precedent as the OCC-46 SDK-MCP `constructor` verify-only finding):

- OCC's `handleOAuth401ErrorImpl` (`src/utils/auth.ts`) has **no stored-credential adoption path**: with an env token set, `getClaudeAIOAuthTokensAsync` returns the inference-only env token (`refreshToken: null`) and the handler returns `false` **without reading secure storage**.
- `process.env.CLAUDE_CODE_OAUTH_TOKEN` is **never assigned anywhere in `src/`** (grep-verified) — the 2.1.224 mutation the 2.1.225 guard protects against cannot occur.
- All 401 recovery paths (`src/services/api/withRetry.ts` → `handleOAuth401Error`) funnel through this handler.

**Deliverable:** `src/utils/__tests__/oauthEnvToken401Precedence.test.ts` — 4 tests / 14 `expect()` pinning the immunity (env wins over expired **and** valid stored credentials; `handleOAuth401Error` never mutates the env token; clean no-op without a credentials file), so any future port of a recovery path cannot silently regress it. The 2.1.225 log message was intentionally **not** ported — it would describe a mechanism OCC does not have (skill: never pretend).

## 3. Strict self-acceptance (current `main` + this round's test, run like a human user)

- **Build green:** `bun run build` → `dist/cli.js` 28.87 MB, `OCC 2.1.298`.
- **Unit suite:** `bun test src test` → **2096 pass / 0 fail / 4985 expect() across 229 files** (51 s) — includes the 4 new regression tests.
- **Headless `-p` (live model):** `occ -p "…PONG"` → `PONG`, exit 0.
- **REPL (tmux, real endpoint):** boots with Signal Chevron + welcome box; model round-trip (`REPLPONG`); real Read-tool task (returned `VERSION=2.1.298` from `package.json`); `/status` renders (auth token source `ANTHROPIC_AUTH_TOKEN`, aliyun base URL, model `glm-5.2`, `MCP servers: 3 connected`); clean `/exit` with correct `occ --resume` hint.

### Consistency spot-checks vs official 2.1.226 binary (same machine, same env/gateway)

- **Headless path parity:** official `claude -p "…PONG"` → `PONG`, exit 0 through the **same** gateway env (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`) — OCC's `-p` output/exit behavior matches.
- **Color-depth parity:** in the tmux env both official and OCC emit 256-color SGR (`38;5;…`), not truecolor — same detection outcome.
- **REPL boot comparison (same pane/env):** official renders a compact header (block-glyph chevron + `Claude Code v2.1.226` / model / cwd lines); OCC renders its **branded** welcome box (`OCC v2.1.298 · Open Claude Code`, `Ready when you are.`). The box strings (`Ready when you are`, `Type @ to reference`) are absent from all of v224/v225/v226 (`grep -cF` = 0) — OCC-specific branding surface (`src/components/LogoV2/OccWelcome.tsx`), not a porting gap.
- **Harness artifact (not a product divergence):** the official REPL renders nothing when wrapped in GNU `timeout` (silent until kill); OCC renders fine under the same wrapper. Both render normally without it. Test-harness note only.

**Staged cosmetic observations (P3, non-blocking — recorded per "记录任何不一致作为 gap"):**

| # | Observation | Status |
|---|---|---|
| C1 | 256-color mode: official chevron foreground renders `38;5;174`, OCC chevron renders `38;5;104` (truecolor tones themselves are pinned by OCC's `OccMark.tsx`/`OccWelcome.test.ts` contrast tests). The official binary carries no hex/RGB-triple strings for either tone — its 256-mode mapping needs per-site decompilation before any change (not guessed). | Staged (cosmetic) |
| C2 | Official status line shows the dimmed `← for agents` hint; OCC's does not (the string exists in OCC only in code comments). Pre-window: 5 hits in **all** of v224/v225/v226, so not new in this catch-up window; likely gated on an agents-sidebar state. | Staged (cosmetic) |

## 4. Consequence — tracked-upstream pointer & release discipline

OCC remains **fully aligned through official 2.1.224**; **2.1.225/2.1.226 introduce no portable surface** (2.1.225 all-N/A except #3, now resolved N/A-immunity; 2.1.226 verified no-op in OCC-69). This round lands **tests + docs only** (zero `src/` behavior change) → **no new OCC release** (consistent with the OCC-40/41/42/69 no-op discipline of not polluting `/releases` without a landed behavior change). Security review: diff is one test file + this ledger — no secrets, no new runtime surface, no backdoor vector.

**Summary: 0 landed code changes, 1 staged item RESOLVED (N/A via structural immunity, regression test pinned), 2 staged cosmetic observations (C1/C2), self-acceptance green.**
