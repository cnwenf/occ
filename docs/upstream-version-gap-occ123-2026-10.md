# Upstream Version Gap — OCC-123 Round (2026-10): claude-code 2.1.302 → 2.1.303

> Status: **COMPLETE** — §1 baseline · §2 forensics · §3 triage · §4 disposition · §5 implementation · §6 e2e · §7 merge/release.
> Prior-round ledger: [upstream-version-gap-occ120-2026-10.md](./upstream-version-gap-occ120-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.

## 1. Baseline (verified 2026-10-20, this run)

| Item | Value |
|---|---|
| OCC internal version (pre-round) | 2.1.391 (tracks official 2.1.302) |
| Official npm `latest` | **2.1.303** (published 2026-10-18T21:15:23Z) |
| Official changelog for 2.1.303 | **opaque** — single entry "Bug fixes and reliability improvements" → pure binary-diff round |
| v302 tarball | `anthropic-ai-claude-code-linux-x64-2.1.302.tgz` — 129,008,778 bytes |
| v302 ELF | `package/claude` — 285,793,528 bytes — md5 `39885c1377a0f0d922b73bf8653a6c3f` (**matches occ120 ledger**) |
| v303 tarball | `anthropic-ai-claude-code-linux-x64-2.1.303.tgz` — 129,023,077 bytes |
| v303 ELF | `package/claude` — 285,809,912 bytes (+16,384) — md5 `c3d55e74e4008ec9cd21ff1991502cda` |
| `strings -n 8 \| sort -u` | v302: **335,837** · v303: **335,866** (net +29) |
| `comm -13` (new in v303) | **8,555** — of which **7,429** are `/$bunfs/root/chunk-*` re-chunk churn |
| `comm -23` (removed from v302) | **8,526** — of which **7,429** same chunk churn (symmetric) |
| npm `@cnwenf/occ` published | 2.1.367 (E404 debt 2.1.368–2.1.391, owner-side, report-only) |
| GitHub tags/releases | consistent through v2.1.391 (verified: `gh release list` latest = v2.1.391) |

## 2. Binary forensics (this run)

Surface sweeps — **all identical v302↔v303** (marker-set diffs, zero entries each way):

- Env vars `CLAUDE_CODE_*`: identical sets (sole `comm` hit `…PARK_AT_INITC` = string-table concatenation artifact; both ELFs contain the same 2× `CLAUDE_CODE_HOLD_REPORT_PARK_AT_INIT`).
- Slash commands (`type:"(local-jsx|local|prompt)",name:"…"`): identical.
- Hook event names: identical counts.
- Telemetry `tengu_*` event names: identical sets.
- GrowthBook flags spotted in sweep (`tengu_iterative_haven`/`lazy_dove`/`violin_rib`/`violin_corner`/`violin_wood`/`propose_goal`), `CLAUDE_CODE_JIT_POLICY_AFTER_STARTUP`, `EXTERNAL_PERMISSION_MODES`, `setJITPolicy`: **all present in v302 with identical counts** — re-chunk churn, not new.

Systematic message sweep (python: every new string ≥25 chars containing ≥2 spaces or `${`, with tail-truncation matching against v302 to defeat suffix recombination): **232 candidates, exactly one coherent true-new cluster** — the CA-cert deny-list messages (below). All other candidates verified present in v302 (spot-checked: `Put an ordinary local file…`, `a session with an originator account`, `cc-plugin-di`, `wait=null}var`, `press n to add notes`, the `D4n=2000` truncator — identical counts both versions).

### The one true cluster: CA-certificate deny list (security)

New-with-count evidence (v302 → v303, `grep -cF` on sorted strings):

| Marker | v302 | v303 |
|---|---|---|
| `CA certs: A bundled root does not parse:` | 0 | 2 |
| `CA certs: Ignored an entry from ` | 0 | 2 |
| `…ignored all of the NODE_EXTRA_CA_CERTS…` (console warns) | 0 | 3 |
| `No root certificates are left to trust` | 0 | 2 |
| `Dropped blocked certificate` | 0 | 2 |
| `Dropped an unreadable block from` | 0 | 2 |
| `blocked certificates are nested` | 0 | 2 |
| `Nothing from NODE_EXTRA_CA_CERTS (` | 0 | 2 |
| deny-list hash `86a1ecba…` | 0 | 2 |
| `ca_certs_load` | 4 | 5 (new `ok` emit site) |

CA module byte regions (JS region; `grep -aboF` + `dd`, never executed): v302 @235,836,800–235,841,000 (~4.3 KB) vs v303 @235,845,700–235,858,000 (~8.7 KB) — module grew ~4.4 KB ≈ the deny-list subsystem. Full code recovered verbatim from v303 (offsets 235,849,000+12,000 and 235,845,700+12,600 dumps):

- **Deny-list table `tt`** — 4 `{certificate, key}` SHA-256 pairs (recovered verbatim, §5).
- **`Ce`/`jn`** — Sets of the certificate hashes / public-key (SPKI DER) hashes.
- **`Qe(e)`** — PEM block range scanner (balanced `-----BEGIN `/`-----END ` with same-line label check via 80-char tail window).
- **`me = 8`** — max nesting depth for the iterative excision loop.
- **`Je(e)`** — `" (the whole file)"` suffix for source `NODE_EXTRA_CA_CERTS`.
- **`Ze(kind, sha256, warned)`** — warn-once (`${kind}:${sha}` key Set) `console.error` with the verbatim `block`/`file`/`nested` message map.
- **`nt(e)`** — blocked-bundled-root scan: X509 parse → sha256(raw DER) ∈ `Ce` → `{base64: raw.subarray(0, len − len%3), hash}` (unpadded-base64 prefix for substring matching); parse failure → `CA certs: A bundled root does not parse: ${e}` error log, skip.
- **`Ee(entries, blocked, warned)`** — the excision engine: per `{pem, source}` entry, up to `me+1` passes; per PEM block: parseable → `f()` (cert-raw hash ∈ `Ce`, else SPKI-key hash ∈ `jn` via JWK round-trip normalization); unparseable → `l()` base64-substring match against `nt` prefixes ?? `h()` manual DER SEQUENCE length-prefix parse (long-form ≤4 bytes, bounds-checked) then `f()`; excised spans stitched out; drop messages `Dropped blocked certificate ${hash} from ${source}` / `Dropped an unreadable block from ${source}: the block contains blocked certificate ${hash}`; loop exhaustion → `Ignored an entry from ${source}${Je(source)}: blocked certificates are nested in it more than ${me} deep` + `Ze("nested",…)` for NODE_EXTRA_CA_CERTS + discard entry; residual `l()` hit → `it still contains blocked certificate ${hash}`; survival `w = !residual && (passes===0 || some remaining block parses)`; `Ze(w?"block":"file",…)` when NODE_EXTRA_CA_CERTS and (residual || unreadable-dropped); survivors = the **post-excision** PEM text.
- **`qn(e, n, r=nt(n), o)`** — trusted-store resolver: filter collected entries; if empty → retry with bundled roots only; if still empty → **throw** `No root certificates are left to trust: every root built into this runtime is on the CLI's deny list. Update Claude Code.`
- **Loader `Xn` changes vs v302 `Hn`**: (a) entries become `{pem, source}` objects; (b) `!bundled && system && !getCACertificates` branch: message `deferring to runtime` → **`using bundled roots`**, early-return **removed** (falls through; bundled roots load via the system-store fallback); (c) system store PEMs pass the expiry filter `Mn` (unchanged from v302 — see §4 pre-existing gap); (d) `blocked = nt(tls.rootCertificates)` computed unconditionally; store = `qn(entries, roots, blocked, warnedExtraCerts)`; (e) NODE_EXTRA_CA_CERTS content is **filtered through `Ee`** before append; new `Nothing from NODE_EXTRA_CA_CERTS (${path}) is left to append` when nothing survives (also fires on read failure, since `f` stays `[]`); `Appended…` only when something survives; (f) result `y = D([...store, ...extra])` — `D(e)=[...new Set(e)]` dedup (dd-verified @233,826,026); always non-empty (throw replaces `undefined`); (g) `storeCertificates = hasExtra ? D(storeOnly) : y`; freeze into `runtimeStoreBundles` only when `!hasExtra`; (h) telemetry `ca_certs_load ok {cert_count: y.length, store_bundled, store_system, extra_configured}`; (i) store class gains `warnedExtraCerts = new Set` (warn-once persists across cache clears, per store object).

### Blocked certificates identified (this run, local runtime stores only)

Computed sha256(raw DER) + sha256(SPKI DER) over `tls.rootCertificates` of the **local Node (144 roots) and Bun (145 roots)** runtimes — all 4 deny-list entries matched **both** cert-hash and key-hash in both runtimes:

| CN | cert hash (trunc) |
|---|---|
| emSign Root CA - G1 (eMudhra Technologies Limited) | `40f6af03…` |
| emSign ECC Root CA - G3 (eMudhra Technologies Limited) | `86a1ecba…` |
| emSign Root CA - C1 (eMudhra Inc) | `125609aa…` |
| emSign ECC Root CA - C3 (eMudhra Inc) | `bc4d809b…` |

= the **emSign/eMudhra root distrust** (industry-wide distrusted CA). Real blocked PEMs extracted from the local store to `/tmp/blocked-certs.pem` for genuine e2e (never from the official binary). Security intent: the CLI refuses these roots **even though they are still in the runtime's bundled store**, and refuses user re-introduction via NODE_EXTRA_CA_CERTS / system store.

## 3. Sweep residue (non-CA candidates) — all adjudicated churn

`class e{wait=null}` wait-latch, `D4n=2000` truncator, `cc-plugin-di…`, `RENAME_NOTICE`/`BRIEF_*`/`WORKFLOW_*` re-export stubs, axios/jose/mermaid chunk stubs: identical counts in v302 → module re-chunking (every `/$bunfs/root/chunk-<hash>.js` filename changed) — **N-A**.

## 4. Disposition

| # | Item | Disposition | Cplx | Landing point |
|---|---|---|---|---|
| 01 | CA-cert deny-list subsystem + loader v303 shape (security) | **PORT** | M | `src/utils/caCerts.ts` — full module rewrite to the v303 loader shape |
| 02 | System-store expiry filter `Mn` (**pre-existing v302-era gap**, found during module diff — OCC never landed `Ln`/`Dropped ${o} expired certificate(s)`) | **PORT (gap fix)** | S | same file |
| 03 | Dedup `D` on the final cert list (v302-era `D(u)`, also absent in OCC) | **PORT (coupled #01)** | S | same file |
| 04 | Host-store class machinery (`fromHost`, `trustOverrideSeen`, `runtimeStoreBundles`, `storeCertificates`, `ne()` env-trust detection, async watcher `ZJ`, accessors `Jx/QBo/ZBo`) | N-A (OCC adaptation, unchanged this round) | — | OCC's memoized-function adaptation predates this round; v302→v303 changed nothing here except `warnedExtraCerts` (ported as module-level Set) |
| 05 | `ca_certs_load` telemetry emits (`p`/`m`/`g`) | N-A | — | OCC analytics stubbed; consistent with all prior rounds (log messages kept, telemetry dropped) |
| 06 | Everything else in the 8,555-string delta | N-A ×~8,550 | — | chunk re-hash churn + identifier shuffle (§2 sweeps) |

## 5. Implementation record

> **Superseded** (see §8): the rewrite below was completed, reviewed, and e2e-verified on branch `agent/occ-leader/e169d3d4` (commit `8e3f6206`), but the parallel OCC-163 round landed the same alignment on main first. Retained as the independent-verification record; the merged supplement is §7/§8.

**Landing point:** `src/utils/caCerts.ts` — full rewrite of the loader to the official v303 `Xn` shape + the deny-list subsystem, function-by-function transliteration of the recovered minified code (never executed):

| Official | OCC export | Notes |
|---|---|---|
| `tt` / `Ce` / `jn` | `BLOCKED_ROOT_CERTIFICATES` / `BLOCKED_CERT_HASHES` / `BLOCKED_KEY_HASHES` | 4 cert+key SHA-256 pairs, verbatim (security reviewer script-verified byte-for-byte) |
| `me` | `MAX_BLOCKED_NESTING_DEPTH = 8` | |
| `Qe` | `findPemBlockRanges` | 80-char tail window + same-line label check |
| `Je` | `sourceSuffix` | `" (the whole file)"` for NODE_EXTRA_CA_CERTS |
| `Ze` | `warnBlockedExtraCerts` | warn-once `${kind}:${sha}` Set; all 3 messages verbatim; `console.error` per official |
| `nt` | `scanBlockedBundledRoots` | unpadded-base64 DER prefix `subarray(0, len − len%3)`; parse-fail → `A bundled root does not parse` error log + skip |
| `Ee` | `filterBlockedCertEntries` | closures `f`/`l`/`h` kept inside (official structure): cert-hash → JWK-roundtrip SPKI-key-hash; base64 substring; manual DER SEQUENCE parse (long-form ≤4, bounds-checked) |
| `qn` | `resolveTrustedStore` | filter → bundled-only retry (fresh warned Set) → verbatim fail-closed throw |
| `Mn`/`Ln` | `dropExpiredSystemCerts` | pre-existing v302-era gap #02 landed |
| `D` | `dedupeCerts` | `[...new Set(certs)]` (dd-verified @233,826,026) |
| `Xn` loader | `getCACertificates` | entries `{pem, source}`; `deferring to runtime` early-return → `using bundled roots` log **without** early return; system store through expiry filter; blocked scan unconditional; extra file through `Ee`; `Appended…` / `Nothing from NODE_EXTRA_CA_CERTS (…) is left to append`; result deduped, always non-empty (throw replaces empty) |
| `et.warnedExtraCerts` | module-level `warnedExtraCerts` Set | survives `clearCACertsCache()` per process (official: per store object; OCC has no store class — N-A #04) |

**Sanctioned OCC deltas** (unchanged from prior rounds): Node.js early-return `undefined` retained (`typeof Bun === 'undefined' && !extraCertsPath && !CLAUDE_CODE_CERT_STORE`); telemetry `p/m/g("ca_certs_load",…)` + `q()` warn-once telemetry gates dropped (analytics stubbed); host-store machinery `fromHost`/`trustOverrideSeen`/`runtimeStoreBundles`/`storeCertificates`/`ne()`/`ZJ` watcher not ported (N-A #04 — grep confirms every `ca` construction funnels through `getCACertificates()`, no alternate route around the deny list); official's `extraCACerts` content cache replaced by direct read per cache-miss.

**By-construction limit (security review LOW-1, documented per reviewer):** under plain Node.js (never Bun) with `--use-system-ca`/`--use-openssl-ca` in NODE_OPTIONS and no env vars set, the pre-existing early return yields `undefined` → Node native store handling **without** deny-list filtering. Predates this round, unreachable on the shipping Bun runtime (`typeof Bun !== 'undefined'` → deny list always enforced).

**Review verdicts:** security-reviewer **PASS-WITH-NOTES** (0 CRITICAL / 0 HIGH / 0 MEDIUM / 2 LOW — table parity byte-exact, no trust path for blocked certs, fail-closed preserved, no exfiltration/side effects, DER parse not weakened, Node early-return cannot bypass when env set, test file clean). code-reviewer **APPROVE-WITH-NITS** (0 CRITICAL / 0 HIGH / 1 MEDIUM [`filterBlockedCertEntries` ~151 lines — deliberate single-`Ee` transliteration] / 5 LOW [function size, Node+`CERT_STORE=system` behavior change = intended official v303 shape, throw propagation = official fail-closed intent, runtime-store fixture canary = intentional, empty-extra-file edge = pre-existing behavior]). Consumer surface verified: `mtls.ts`/`proxy.ts`/`instrumentation.ts` `string[] | undefined` intact; `managedEnv.ts` `clearCACertsCache` intact; all call sites use the `caCerts && { ca: caCerts }` guard.

**Tests:** `src/utils/__tests__/caCertsDenylist303.test.ts` — 28 tests / 632 expect() green (deny-list table verbatim pin, 4-blocked-roots-in-runtime-store canary, `Qe` range classes incl. malformed-label skip, `nt` scan incl. unparseable-skip, `Ee` excision: clean pass-through / blocked-only drop / mixed-file excise-and-survive (subject re-parse) / multi-blocked single pass / corrupted-armor unreadable drop + `file`-kind warn / raw-base64 residual drop / non-extra sources never warn, `Ze` warn-once + 3 verbatim messages, `qn` filter/bundled-retry/fail-closed-throw, `Mn` expiry drop (real expired fixture, `openssl x509 -req -days -1`) + parse-fail keep, `D` dedupe, loader integration ×3 via real temp files: blocked+valid → store−4+1 with anti-bypass base64 sweep, blocked-only → store−4, unreadable path → store−4). Existing `caCerts.test.ts` 7/7 no regression.

## 6. e2e record

Environment: live gateway (`ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`, model `qwen3.8-max`/`glm-5.2` defaults), Bun runtime, `dist/cli.js` rebuilt at **2.1.392** (MACRO.VERSION verified). Debug observation via `--debug` → `~/.claude/debug/<session>.txt` (`logForDebugging` routes to the debug log, not stderr).

| # | Test | Result |
|---|---|---|
| E1 | `occ --version` | `OCC 2.1.392` ✅ |
| E2 | Headless bare: `-p "reply with exactly PONG"` | stdout `PONG`, exit 0 ✅ |
| E3 | **Blocked-only extra file**: `NODE_EXTRA_CA_CERTS=/tmp/occ123-blocked-all.pem` (8 PEM blocks = the 4 real emSign blocked roots dup'd, extracted from the local runtime store) + `--debug -p` | Debug log: `Loaded 145 bundled` → `Dropped blocked certificate <hash> from bundled` ×4 (all 4 deny-list hashes) → same 4 dropped from `system` store (multiple system copies each dropped) → same 4 dropped `from NODE_EXTRA_CA_CERTS` (×2 per hash — dup'd blocks) → **`Nothing from NODE_EXTRA_CA_CERTS (/tmp/occ123-blocked-all.pem) is left to append`** ✅. No `console.error` warn — correct official semantics (clean parseable excision is silent; `Ze` fires only on residual/unreadable forms). stdout `PONG`, exit 0 ✅ (store fail-open when non-empty) |
| E4 | **Mixed extra file**: `NODE_EXTRA_CA_CERTS=/tmp/occ123-mixed-certs.pem` (1 valid self-signed + 1 blocked emSign root) + `--debug -p` | Debug log: `Dropped blocked certificate 40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367 from NODE_EXTRA_CA_CERTS` + **`Appended extra certificates from NODE_EXTRA_CA_CERTS (/tmp/occ123-mixed-certs.pem)`** ✅ — blocked excised, valid survived and appended. stdout `PONG`, exit 0 ✅ |
| E5 | **tmux REPL round-trip**: `bun dist/cli.js` interactive | Boot banner `OCC v2.1.392` ✅; prompt `reply with exactly PONG` → `● PONG` model round-trip ✅; `/exit` → clean session exit ✅ |

Loader fired 3× per headless run (multiple agent constructions) — dedupe/warn-once semantics held (no duplicate console warns; debug lines repeat per call as official does).

**Replay on the merged supplement (2.1.393 = main's OCC-163 implementation + `D` dedupe):** E1 `OCC 2.1.393` ✅ · E2 PONG ✅ · E3 blocked-only → 60 `Dropped blocked certificate` lines (bundled+system+extra copies) + `Nothing from NODE_EXTRA_CA_CERTS (/tmp/occ123-blocked-all.pem) is left to append` ×3 + PONG ✅ · E4 mixed → `Dropped blocked certificate 40f6af03… from NODE_EXTRA_CA_CERTS` + `Appended extra certificates …` + PONG ✅ · E5 tmux REPL banner `OCC v2.1.393` + `● PONG` round-trip + clean `/exit` ✅.

CI gate (pre-e2e): `bash scripts/ci-test.sh` → **12,826 pass / 2 fail / 12 skip (1,146 files)**; both fails A/B-proven pre-existing on clean HEAD `d0ad9ccb` via `git stash -u` (`/feedback` external dep + `argumentSubstitutionCaps301` budget case) — **zero net-new regressions**. New `caCertsDenylist303.test.ts` 28/28 green; existing `caCerts.test.ts` 7/7 green.

## 7. Merge / release

**Superseded-and-supplement flow** (see §8): the overlapping implementation (§5 rewrite + §6 e2e build) was NOT merged — main's OCC-163 port wins per the OCC-119 precedent. This round lands only the exclusive complement:

- Complement: official final-list dedupe `D` (`D(e)=[...new Set(e)]`, dd-verified @233,826,026) missing from the OCC-163 loader tail — `dedupeCerts` export + `return dedupeCerts([...storeCerts, ...extraCerts])` in `src/utils/caCerts.ts`; pinned by `src/utils/__tests__/caDedupe303.test.ts` (5 tests, mutation-verified: reverting the one-liner → 2 loader pins RED).
- Version bump: `package.json` 2.1.392 → **2.1.393**; rebuild verified `OCC 2.1.393`.
- CHANGELOG: tracking line re-headed with the OCC-123 supplement clause (OCC-163 demoted into the "merges on top of" chain); new `## 2.1.393 - 2026-10-20` section.
- Commit: conventional (`fix(2.1.303): …`, `Co-Authored-By: Claude`) on `agent/occ-leader/e169d3d4-supp`; merge `--no-ff` → `main`; push.
- Release: tag `v2.1.393` → push tag → `publish.yml` (build → npm publish → GitHub Release). Known debt: npm `@cnwenf/occ` E404 since 2.1.368 (owner-side, report-only — GitHub Release is the delivery channel).
- Verification: `gh api repos/cnwenf/occ/releases` count == tags count; `comm -23 <(tags) <(releases)` empty; residual remote branches cleaned.
- Results: (recorded in the issue result comment — tag/release URLs live there)

## 8. Reconciliation addendum (2026-10-20, parallel-round collision)

While this round was in its e2e phase, the parallel **OCC-163** round (`agent/occ-leader/9d1f7043`) reached main first with the same 2.1.302→2.1.303 scope (merge `110fd2cd`, release/tag `v2.1.392` already pushed). Per the **OCC-119 supplement precedent** (CHANGELOG: "main wins every overlapping implementation … the supplement adds only the entries [the parallel round] did not touch"):

1. **Cross-review of main's port** — this round's independently recovered verbatim official module (`/tmp/cc-diff-303/js-ca-303b.txt`, §2) was used as the source of truth to re-verify OCC-163's `src/utils/caDenyList.ts` + `caCerts.ts` loader function-by-function: `Qe`/`findPemBlocks` ✅ (80-char window, newline label check), `Je`/`extraCertsSuffix` ✅, `Ze`/`warnIgnoredExtraCerts` ✅ (3 verbatim messages, `${kind}:${sha}` dedupe), `nt`/`collectBlockedBundledRoots` ✅ (truncated-base64 `len − len%3`, parse-fail error-log+skip), `f`+JWK round-trip ✅, `l`/`findBlockedByBase64` ✅, `h`/`detectBlockedDerFraming` ✅ (long-form ≤4, bounds checks), `Ee`/`dropBlockedCertificates` ✅ (incl. the subtle `keepEnd = Math.max(blockStart, prevBlockEnd)` **before** `prevBlockEnd = blockEnd` evaluation order, the `passes===0 ||some-parses` survival predicate, nested/residual message shapes), `qn`/`resolveTrustedCertificates` ✅ (bundled-only retry with fresh warned Set, verbatim throw), `Mn`/`filterExpiredCertificates` ✅, `Xn` loader ✅ (`using bundled roots` fall-through, unconditional blocked scan, extra-file `Appended`/`Nothing` split inside the success branch only, read-failure error-log only) — deny table byte-identical (same 4 cert+key pairs).
2. **The one gap found**: loader tail `return [...storeCerts, ...extraCerts]` — official is `y = D([...A, ...f])` with `D(e)=[...new Set(e)]` (dd-verified @233,826,026 during this round's forensics). Duplicates are real on this host: the §6 e2e debug log showed the 4 blocked roots present in BOTH the bundled store (145) and the system store (244, multiple copies each) — the same overlap applies to non-blocked roots, so the un-deduped tail diverges from the official `cert_count` and hands duplicate PEMs to every `ca:` consumer (mtls/proxy/instrumentation). Their loader tests run under `CLAUDE_CODE_CERT_STORE=bundled` with a benign extra cert, so the gap was unobservable in their suite.
3. **Disposition of this round's artifacts**: §5 full-loader rewrite (`caCerts.ts` 587-line version) + `caCertsDenylist303.test.ts` (28/632) + the §6 e2e build stay on branch `agent/occ-leader/e169d3d4` (commit `8e3f6206`) as the independent-verification record — **not merged** (would revert main's module split into `caDenyList.ts`, a pure-churn conflict with zero fidelity gain; both implementations are faithful transliterations of the same recovered code). This ledger merges as the round's forensics/reconciliation record.
4. **Supplement landed**: `dedupeCerts` + loader-tail fix + `caDedupe303.test.ts` (§7); e2e re-run on the rebuilt 2.1.393 binary (§6 fixtures E3/E4/E5 replayed — same verbatim debug-log behavior + PONG + REPL round-trip).
