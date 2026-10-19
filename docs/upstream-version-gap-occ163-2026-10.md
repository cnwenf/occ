# Upstream version gap ledger — OCC-163 round (2026-10)

Round: OCC-163. Prior round: OCC-162 (`upstream-version-gap-occ162-2026-10.md`,
aligned through official 2.1.302, shipped as OCC 2.1.391).

## §1 Baseline

| Item | Value |
|---|---|
| OCC main HEAD at round start | `d0ad9ccb` — "chore(release): 2.1.391" |
| OCC version at round start | 2.1.391 (aligned to official 2.1.302) |
| Official latest/next | **2.1.303** (published 2026-10-18T21:15:23Z) |
| Official stable | 2.1.292 |
| Official 2.1.302 ELF md5 | `39885c1377a0f0d922b73bf8653a6c3f` (285,793,528 B) |
| Official 2.1.303 ELF md5 | `c3d55e74e4008ec9cd21ff1991502cda` (285,809,912 B, +16,384 B) |
| Official 2.1.303 tarball md5 | `599287c2a96c4d6df4006a622ce0b63e` |
| Work branch | `agent/occ-leader/9d1f7043` |
| Research record | `docs/gap-research-303/triage-T1.md` |

## §2 Delta disposition

Single substantive change in 2.1.303: **CA root-certificate deny-list** (4 eMudhra/emSign
roots blocked from bundled/system/NODE_EXTRA_CA_CERTS stores, with PEM block excision,
unreadable-block detection, dedup user warnings, throw-on-empty). Full forensics + verbatim
code: `docs/gap-research-303/triage-T1.md` §2, extracts in
`docs/gap-research-303/official-30{2,3}-ca-module-extract.txt`.

| ID | Item | Disposition | Note |
|---|---|---|---|
| occ163-01 | CA deny-list (`tt`/`Ce`/`jn` + `Qe`/`me`/`Je`/`Ze`/`nt`/`Ee`/`qn`) + loader restructure (`Xn` vs `Hn`) | **PORT** | P0 security; `src/utils/caCerts.ts` |
| occ163-02 | System-store expired-cert filter (`Mn`) | **PORT** | Pre-existing gap (present in BOTH 302+303 binaries, byte-verified); small, same module, ported with occ163-01 |
| occ163-03 | All other surfaces (commands/flags/betas/hooks/env/settings texts) | ALREADY-ALIGNED | Identical 302↔303 |
| occ163-04 | CA-store class fields `fromHost`/`runtimeStoreBundles`/`storeCertificates`/`trustOverrideSeen`, telemetry `ca_certs_load` | N-A | OCC has no multi-host store class / telemetry is stubbed; record only |
| occ163-05 | `D` dedup of final cert array | N-A | Identical in both official versions; OCC keeps flat concat (pre-existing, out of delta) |
| occ162 STAGED items | unchanged | STAGED | Trigger (`stable ≥ 2.1.296`) not fired — stable still 2.1.292 |

## §3 Implementation record

- **New `src/utils/caDenyList.ts`** (~400 lines) — faithful port of the official 2.1.303 CA
  module: `tt`→`BLOCKED_ROOT_CERTIFICATES` (4 verbatim hash pairs), `Ce`/`jn` hash sets,
  `Qe`→`findPemBlocks`, `me`→`MAX_STRIP_PASSES=8`, `Je`→`extraCertsSuffix`,
  `Ze`→`warnIgnoredExtraCerts` (3 verbatim console messages, dedup on `kind:hash`),
  `nt`→`collectBlockedBundledRoots`, `Ee`→`dropBlockedCertificates` (multi-pass strip;
  parseable blocks via cert-hash + SPKI key-hash JWK round-trip; unparseable via base64
  substring + manual DER framing walk), `qn`→`resolveTrustedCertificates` (bundled-only
  retry → verbatim throw). `Ue("crypto")` mirrored as deferred `require('node:crypto')`.
  Verified against `official-303-ca-module-extract.txt` line-by-line; official `Ze` uses the
  file sha256 only as dedup key (no fingerprint log line) — port matches exactly.
- **`src/utils/caCerts.ts` restructured** to the official `Xn` loader: `{pem,source}` entries,
  `Mn`→`filterExpiredCertificates` (new export; fail-open per cert, debug log on drops),
  system-API-unavailable branch now falls through to bundled roots instead of returning,
  store entries resolved through `resolveTrustedCertificates`, NODE_EXTRA_CA_CERTS filtered
  through `dropBlockedCertificates` with verbatim Appended/Nothing-left logs. Module-scoped
  `warnedExtraCerts` dedup set mirrors the official class field. All pre-existing exports
  (`DEFAULT_CERT_STORES`, `resolveCertStores`, `getCACertificates`, `clearCACertsCache`) and
  the non-Bun fast path preserved; consumers (mtls/proxy/managedEnv) untouched.
- N-A per §2: store-class fields (`fromHost`/`runtimeStoreBundles`/`storeCertificates`/
  `trustOverrideSeen`) and `ca_certs_load` telemetry not ported (OCC has no multi-host store
  class; telemetry stubbed). Final-array `D` dedup not adopted (identical in both official
  versions — pre-existing OCC flat concat, out of delta).

## §4 Test record

- **New `src/utils/__tests__/caDenyList303.test.ts`** — 19 tests: deny-list discovery in the
  live bundled store (4 emSign roots; base64 substring pin), `findPemBlocks` edge semantics
  (dangling END, newline-in-label), strip behaviors (neighbor preservation, blocked-only drop,
  unparseable base64 detector, junk-block keep, 3-layer split-marker chain + benign trailer),
  verbatim warning pins + dedup, `resolveTrustedCertificates` fallback + verbatim throw,
  `filterExpiredCertificates`, and loader e2e under `CLAUDE_CODE_CERT_STORE=bundled`
  (117 = 121−4 roots; mixed/blocked-only/unreadable NODE_EXTRA_CA_CERTS files).
  **26/26 pass** (19 new + 7 pre-existing `caCerts.test.ts`).
- **Full src suite A/B** (`bun test src/`, 250s): pristine main = 11087 pass / **237 fail**;
  branch = 11108 pass / **235 fail** (+19 tests = exactly the new file; failing-set diff shows
  **zero new failures** — the 2-test delta is the known-flaky `killTask [killed] trailer`
  timing tests failing on main and passing here). All 235 residual fails are pre-existing
  environment flakes (daemon signal tests, editor-CLI spawns, mcp-serve spawns).
- **Build**: `bun run build` green (`dist/cli.js` 30.30 MB). Lint: biome clean on all 3 files.
  tsc: 967 errors = pre-existing baseline (git-stash A/B: 968 without changes), 0 in touched files.
- **Live behavioral e2e on the built binary** (real API, `--debug`, verbose debug-log dir):
  1. Baseline `-p` PONG: exit 0 — TLS intact with deny-list active.
  2. `NODE_EXTRA_CA_CERTS=/tmp/ca-mixed.pem` (benign + emSign Root CA - C1): debug log shows
     all 4 blocked roots dropped from **bundled AND system** stores (121 bundled → 117 kept;
     122 system certs filtered), `Dropped blocked certificate 40f6af03… from
     NODE_EXTRA_CA_CERTS`, `Appended extra certificates from NODE_EXTRA_CA_CERTS
     (/tmp/ca-mixed.pem)`; PONG still returned.
  3. Blocked-only file (emSign ECC G3): `Dropped blocked certificate 86a1ecba… from
     NODE_EXTRA_CA_CERTS` + verbatim `Nothing from NODE_EXTRA_CA_CERTS (…) is left to
     append`; no console.error (parseable block — official fires `Ze` only on
     residual/unreadable); PONG still returned.
  4. Unreadable blocked block (`QUJD` prefix breaks DER): verbatim 'file' warning on stderr
     exactly once + `Dropped an unreadable block … contains blocked certificate 86a1ecba…`
     in the debug log; PONG still returned.
- **REPL e2e** (tmux, `bun dist/cli.js --dangerously-skip-permissions`): banner boots
  (OCC v2.1.391), prompt round-trip `REPLPONG` returned by the model, `/status` renders
  (Version/Auth/Base URL/Model/MCP rows), `/exit` closes the session cleanly.
- **Interaction-consistency note**: the `uvx claude-code` (PyPI) check is deliberately NOT
  run — that package is squatted (security constraint); the official npm binary is never
  executed (static-forensics-only discipline). Consistency with official 2.1.303 is instead
  evidenced by byte-identical user-facing strings (warnings/throw/logs pinned verbatim in
  tests + observed verbatim in live probes 2–4) and identical filter behavior across all
  three trust sources.

## §5 Release record

( filled during release )
