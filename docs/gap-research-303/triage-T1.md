# Gap research — Claude Code 2.1.303 (OCC-163 round)

Scope: full changelog + binary surface diff, official `2.1.303` vs `2.1.302`,
triaged against OCC @ `main` HEAD `d0ad9ccb` (v2.1.391, aligned through 2.1.302).

Method: static byte forensics ONLY on the two Bun-compiled linux-x64 ELFs
(`/tmp/cc-diff-303/vprev/package/claude` = 2.1.302 md5 `39885c1377a0f0d922b73bf8653a6c3f`,
`/tmp/cc-diff-303/vver/package/claude` = 2.1.303 md5 `c3d55e74e4008ec9cd21ff1991502cda`).
Tarball md5s: 2.1.302 `5f8327265d118bfc65f402c068fdeddf` (matches occ162 §2A.2 record),
2.1.303 `599287c2a96c4d6df4006a622ce0b63e`. No official binary was ever executed.
Every offset is a `grep -aboF` byte offset; every excerpt is a bounded `dd`.

Disposition vocabulary: **PORT** / **STAGED** / **N-A** / **ALREADY-ALIGNED** / **CAND**.

## 0. Version reality

- npm dist-tags this run: `latest = next = 2.1.303`, `stable = 2.1.292`.
- 2.1.303 published `2026-10-18T21:15:23Z`; 2.1.302 published `2026-10-16T16:48:28Z`.
- ELF grew 285,793,528 → 285,809,912 B (+16,384 B). `2.1.303` marker: 2588 hits; `2.1.304`: 0.
- Changelog entry (`changelog-entry-303.txt`): **"Bug fixes and reliability improvements"** (vague — real content recovered from the binary).
- STAGED re-review trigger (`stable ≥ 2.1.296`): **NOT fired** — `stable = 2.1.292`.

## 1. Surface-level diffs (all IDENTICAL — no new named surface)

| Surface | Method | Result |
|---|---|---|
| Slash commands | `grep -oE 'type:"(local-jsx\|local\|prompt)",name:"[a-z-]+"'` sorted-diff | **identical** |
| Feature flags | `grep -oE 'feature\("[A-Z0-9_]+"\)'` sorted-diff | **identical** |
| Beta headers | `grep -oE '"[a-z-]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}"'` sorted-diff | **identical** |
| Hook type names | 18-name alternation sorted-diff | **identical** |
| Env vars (`CLAUDE_CODE_*`) | `grep -oE` + `comm` | **no net add/remove** (`CLAUDE_CODE_HOLD_REPORT_PARK_AT_INIT` appears in BOTH — string-boundary artifact, not new) |
| Settings `.describe()` texts | `grep -oE '\.describe\("…"'` sorted-diff | **net add: none, net remove: none** |

The `strings -n 8 | sort -u | comm` diff showed 8555 added / 8526 removed lines, but
essentially all are **re-chunking artifacts** of the same code (Bun's compiler re-splits
string boundaries between builds). Cross-checked via raw-binary `grep -caboF`:
`enableWorkerPermissionModeRecord`, `serverClassifierRole`, `unexaminableRefStore`,
`workerPermissionModeRecordEnabled` all show **prev=1 ver=1** (present in BOTH). They are
NOT new features.

## 2. THE substantive 2.1.303 change — CA-certificate deny-list (PORT)

The single genuinely-new surface (raw-binary `grep` confirms **prev=0, ver≥1**) is a
**root-certificate deny-list** in the CA-loading module (offset ~235,849,000; extract in
`official-303-ca-module-extract.txt`, with the 2.1.302 baseline in
`official-302-ca-module-extract.txt` for the before/after).

New-in-2.1.303 strings (all prev=0):
- `No root certificates are left to trust: every root built into this runtime is on the CLI's deny list. Update Claude Code.`
- `CA certs: A bundled root does not parse: `
- `Dropped blocked certificate ` / `Dropped an unreadable block from `
- `CA certs: Ignored an entry from …: blocked certificates are nested in it more than … deep` / `…: it still contains blocked certificate …`
- 3 user-facing `console.error` messages (block / file / nested — see `Ze` below)
- `CA certs: Nothing from NODE_EXTRA_CA_CERTS (…) is left to append`
- field `warnedExtraCerts` (on the CA-store class)

### 2.1 The deny-list (verbatim, `tt` @ ~235850600)

4 `(certificate SHA-256 DER, key SHA-256 SPKI)` pairs. `Ce` = set of cert hashes,
`jn` = set of key hashes:

| # | certificate (SHA-256 of DER) | key (SHA-256 of SPKI) |
|---|---|---|
| 1 | `86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b` | `8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782` |
| 2 | `bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3` | `eabc185c4e82d942b1a5978ba3c0181487d6b3b9974e5c49f72f6d0bd9637150` |
| 3 | `40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367` | `376a1a7082a593dccc20d561d119e9ab8d30f11cc321d0a37fa41f0df284e01c` |
| 4 | `125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f` | `b7408b4d2be0238ba37004dd34e276c6019bd2f24c9db7d4980f5f6c359a4bcc` |

**Identity of the blocked roots** (computed locally against Node/Bun `tls.rootCertificates`,
144 bundled Mozilla roots): all 4 are **emSign / eMudhra** roots —
`emSign Root CA - G1`, `emSign ECC Root CA - G3`, `emSign Root CA - C1`,
`emSign ECC Root CA - C3`. All 4 ARE present in the standard bundled store, so this is a
deliberate CA-distrust action (Anthropic no longer trusts these eMudhra/emSign roots even
though Mozilla still ships them). Security-positive.

### 2.2 Official logic (recovered from binary, to be ported faithfully)

- `nt(rootCertificates)` → `blockedBundled[]`: for each bundled root, `sha256(DER)`; if in
  `Ce`, record `{base64: DER[0..len-len%3].toString('base64'), hash}`. On parse failure log
  `CA certs: A bundled root does not parse: <err>` (level error) and skip.
- `Qe(pem)` → `[start,end][]`: locate `-----BEGIN …-----` / `-----END …-----` block ranges
  (END-label must be within 80 chars and not contain a newline before the closing `-----`).
- `Ee(entries, blocked, warned)` → `string[]`: for each `{pem, source}` entry, iteratively
  strip blocked blocks up to `me = 8` passes (handles nesting). A block is blocked if:
  (a) it parses as X509 and its DER hash ∈ `Ce`, OR its SPKI key hash ∈ `jn` (`f()` —
  re-exports the public key via JWK round-trip then SPKI/DER, mirroring the official), OR
  (b) it does NOT parse but its whitespace-stripped base64 contains a blocked root's base64
  (`l()`), OR manual DER framing (`h()`) yields a cert whose hash ∈ `Ce` or key ∈ `jn`.
  Dropped blocks log `Dropped blocked certificate <hash> from <source>` /
  `Dropped an unreadable block from <source>: the block contains blocked certificate <hash>`.
  If >8 passes still dropping → nested warning. Post-strip residual blocked content →
  "still contains" warning. Only entries with no residual block AND (untouched OR ≥1 parseable
  block left) are kept.
- `Ze(kind, hash, warned)`: dedup on `"<kind>:<hash>"`, `console.error` one of
  **block** / **file** / **nested** messages (verbatim, see extract).
- `Je(source)`: `" (the whole file)"` when source === `NODE_EXTRA_CA_CERTS`, else `""`.
- `qn(entries, rootCertificates, blocked = nt(rootCertificates), warned = new Set)`:
  `s = Ee(entries, blocked, warned)`; if `s.length>0` return `s`; else retry bundled-only
  `Ee(rootCertificates.map(pem=>({pem,source:"bundled"})), blocked)`; if `>0` return; else
  **throw** `No root certificates are left to trust: …`.
- `Xn` loader: builds `{pem,source}` entries from bundled (if `useBundled`) + system
  (if `useSystem`, via existing expired-filter `Mn`), resolves through `qn`, then appends
  NODE_EXTRA_CA_CERTS through `Ee([{pem:content,source:"NODE_EXTRA_CA_CERTS"}], blocked, warned)`.
  Logs `Appended extra certificates from NODE_EXTRA_CA_CERTS (<path>)` when something survived,
  else `Nothing from NODE_EXTRA_CA_CERTS (<path>) is left to append`. Result = `D([...storeCerts, ...extra])`.

### 2.3 OCC current state (`src/utils/caCerts.ts`, 165 lines)

`getCACertificates` (memoized) collects bundled + system + extra into a **flat `string[]`**
with **no deny-list filtering** and **no per-entry source tracking**. Returns `undefined` on
the plain-Node/no-extra/no-CERT_STORE fast path (documented perf optimization — production
build is Bun, so this path is dev-only). `resolveCertStores()` (mirrors official `Bn`) is
already aligned. `caCertsConfig.ts` (settings→env population) unchanged by this release.

### 2.4 PORT plan

Restructure `getCACertificates` to build `{pem, source}[]` entries, compute blocked bundled
roots, resolve the store set through a faithful port of `qn`/`Ee`/`nt`/`Qe`/`Ze`/`Je`, filter
NODE_EXTRA_CA_CERTS through `Ee`, concat. Preserve OCC's existing exports
(`DEFAULT_CERT_STORES`, `resolveCertStores`, `getCACertificates`, `clearCACertsCache`) and the
`undefined` fast-path. Deny-list constants verbatim. `me = 8` verbatim. Crypto via
`node:crypto` (`X509Certificate`, `createHash`, `createPublicKey`) — same as the official
`Ue("crypto")`. UT: blocked emSign root dropped from bundled; blocked root in
NODE_EXTRA_CA_CERTS → filtered + block/file/nested warnings; nested >8 → nested warning;
all-blocked → throw; key-hash-only match (SPKI) dropped; unparseable-block base64 detection;
benign cert untouched.

**Priority: P0 security** (CA distrust). This is the round's single port.

## 3. No-op confirmations

- No new commands, flags, betas, hooks, env vars, or settings keys (§1).
- The 4 non-CA "new" identifiers are re-chunk artifacts (present in both binaries).
- Disposition: **2.1.303 = one PORT item (CA deny-list), everything else ALREADY-ALIGNED.**
