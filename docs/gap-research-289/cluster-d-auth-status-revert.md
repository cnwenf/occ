# Cluster D — `claude auth status` revert (official 2.1.289 changelog #4)

> Official item: "[VSCode] Reverted a 2.1.288 change to `claude auth status` that may have made sign-outs more frequent."
>
> Research mode: binary forensics ONLY (`grep -aboF` → byte offset → `dd` on the official ELFs; never executed).
> Binaries: `/tmp/cc-diff-289/v288/package/claude` (2.1.288), `/tmp/cc-diff-289/v289/package/claude` (2.1.289).

## Verdict: **NO-OP** for OCC

OCC never ported the 2.1.288 auth-status teardown change, so there is nothing for
the 2.1.289 revert to roll back. OCC's `authStatus` handler exits with a direct
`process.exit(loggedIn ? 0 : 1)` and zero analytics calls — structurally identical
to v289's reverted (== pre-288) shape. No `src/` change required.

---

## 1. What 2.1.288 changed and 2.1.289 reverted (byte-level evidence)

### 1.1 Handler location

| Anchor | v288 offset | v289 offset |
|---|---|---|
| `authStatus` handler (minified `_e`) | 223919651 | 224255965 |
| chunk export `_e as authStatus` | 223921770 | 224258080 |
| `command("auth")` registration | 216935447 | 217252867 |

Both versions: the lazy auth chunk exports `{me as authLogin, he as authLogout, _e as authStatus}`,
and registration is identical — `.command("status").description("Show authentication status").option("--json","Output as JSON (default)").option("--text","Output as human-readable text")`.

### 1.2 The single structural delta — exit-path teardown

Token-level diff of the full `_e` body (694 tokens each side; Python tokenizer +
`difflib` opcodes): **exactly one structural change**; every other diff is a
minifier identifier rename.

v288 tail (the 2.1.288 change):

```js
...o=e(n,{children:b(s,null,2)})}
return d.render(e(PR,{children:o})),
       await d.waitUntilExit(),
       await Mr("cli_auth_status"),   // logFeatureOkAsync — AWAITS sink.logEventAsync (network delivery)
       mo(y?0:1)                      // exitAfterAnalyticsFlush — AWAITS flushAnalyticsSinks(), then process.exit
}
```

v289 tail (the revert):

```js
...o=e(n,{children:b(s,null,2)})}
y("cli_auth_status"),                 // logFeatureOk — SYNC queue-to-sink, moved BEFORE render
d.render(e(MR,{children:o})),
await d.waitUntilExit(),
process.exit(O?0:1)                   // direct exit, nothing awaited after render
}
```

Import edges corroborate:

- v288 auth chunk: `import{Mr,$t}from"chunk-1bdxqw9w.js"` **plus** `import{mo}from"chunk-g8de0x7e.js"` (the exitAfterAnalyticsFlush chunk).
- v289 auth chunk: `import{y,Lr,$t}from"chunk-a2frqct0.js"` and **zero** imports of the exitAfterAnalyticsFlush chunk (v289's internal name `vo`: 0 hits in the auth-chunk window).

### 1.3 Minified-name resolution chain

v288 analytics-feature export map @**233304150**:
`export{f6 as cmdFeature, Eee as hookFeature, m as logFeatureBad, $t as logFeatureBadAsync, y as logFeatureOk, Mr as logFeatureOkAsync, p as logFeatureSad, al as logFeatureSadAsync, Pvt as toolFeature, zr as withFeatureTelemetry}`

v288 CLI-helpers export map @**227148834**:
`export{an as cliError, ss as cliErrorAfterAnalyticsFlush, bKr as cliExit, YH as cliOk, tv as cliOkAfterAnalyticsFlush, Zv as cliWarn, mo as exitAfterAnalyticsFlush, TW as flushAnalyticsBeforeExit, eg as printCliError, Ip as writeStdoutAndDrain}`

v289 maps are structurally identical @**233651001** / @**227487456** with renames
(`y as logFeatureOk`, `Lr as logFeatureOkAsync`; `vo as exitAfterAnalyticsFlush`, `OW as flushAnalyticsBeforeExit`).

Helper bodies (v288):

```js
// chunk-1bdxqw9w.js (export map @200392259)
function y(e,r){i("tengu_feature_ok",{feature_name:d(e),...r})}            // sync: i → sink.logEvent
async function Mr(e,r){try{await Fs("tengu_feature_ok",{feature_name:d(e),...r})}catch{}}  // async: Fs → await sink.logEventAsync

// analytics core chunk-3xfv07ns.js (export map @200386136)
function i(t,e){let n=a().state; if(n.sink===null){s(n,{eventName:t,metadata:e,async:!1});return} n.sink.logEvent(t,e)}
async function Fs(t,e){let n=a().state; if(n.sink===null){s(n,{eventName:t,metadata:e,async:!0});return} await n.sink.logEventAsync(t,e)}

// chunk-g8de0x7e.js (bare export @212279525)
async function TW(){try{let{flushAnalyticsSinks:r}=await import("/$bunfs/root/chunk-mc71e39g.js");await r()}catch{}}
async function mo(r){await TW(),process.exit(r);return}
```

So the 288 change placed **two awaited network operations** on the `auth status`
exit path: `await logFeatureOkAsync("cli_auth_status")` (awaits
`sink.logEventAsync`) and `exitAfterAnalyticsFlush(code)` (awaits
`flushAnalyticsSinks()` before `process.exit`). The 289 revert restores
fire-and-forget sync queueing (before render) plus an immediate `process.exit`.

### 1.4 Why it caused "sign-outs more frequent" in VSCode

The VSCode extension probes login state by shelling out `claude auth status`
with a timeout. When the analytics endpoint is slow, blocked, or proxied (common
in enterprise/remote setups), the awaited `logEventAsync` + `flushAnalyticsSinks`
hang the exit path past that timeout; the extension reads the timed-out probe as
"not logged in" → the user appears signed out. Removing all awaited network I/O
from the exit path (the revert) makes the probe deterministic again.

### 1.5 What did NOT change (revert is teardown-only)

Byte-identical v288↔v289 apart from identifier renames:

- Env-override source checker `nmr` @223894784 ≡ `egr` @224231065:
  `function nmr(t){return t==="claude.ai"||t==="CLAUDE_CODE_OAUTH_TOKEN"||t==="CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"||t==="CCR_OAUTH_TOKEN_FILE"}`
- `buildAccountProperties` (`O9t` ≡ `rXt`): 883 tokens, 4 diffs, all renames inside template literals.
- Handler head logic: `S=nmr(g)&&u!=="none"&&!ft(), I=g==="profile"&&!n0(), w=S||I?"none":g`.
- Managed-key branch (the 2.1.286 #1 port): `u==="ANTHROPIC_API_KEY"||_||u==="/login managed key"` → `p="api_key"`.
- JSON output fields: `loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, forcedLoginMethod, allowedProviders, apiKeySource, email/orgId/orgName/subscriptionType`.
- **`authLogout` keeps awaited async telemetry in BOTH versions** (v288 `await Mr("cli_auth_logout")` / v289 `await Lr("cli_auth_logout")`) — the revert touched only the status probe's exit path, not logout.

---

## 2. Did OCC port the 288 change? No.

### 2.1 Attribution correction

The task brief assumed OCC-106 landed "auth unusable-token recheck + managed-key
`api_key` status". Those are actually **2.1.286** items ported in the **OCC-104**
round — README.md lines 16/65/160 point at ledger
`docs/upstream-version-gap-occ104-2026-10.md`. The OCC-106 ledger
(`docs/upstream-version-gap-occ106-2026-10.md`, lines 70/138/176/220) lists only
two auth items: 288 #35 `/login` false-success fix (PORTED, commit `ebc61c1`,
touched `ConsoleOAuthFlow.tsx:589` + `cli/handlers/auth.ts:294`) and #60 `--bare`
`/login` (STAGED). Neither touches the `auth status` teardown.

### 2.2 The 288 research round never triaged the teardown change

`docs/gap-research-288/cluster-b-protocol-auth-mcp-plugin.md`: **zero hits** for
`authStatus` / `exitAfterAnalyticsFlush` / `cli_auth`. The awaited-analytics
teardown was invisible to the 288 round — and moot for OCC, whose
analytics/GrowthBook/Sentry layers are empty stubs by design (CLAUDE.md).

### 2.3 Current OCC handler state

- `src/cli/handlers/auth.ts` — `authStatus` @385–488: computes state, writes
  JSON/text **directly to stdout** (no ink render), then line 487:
  `process.exit(loggedIn ? 0 : 1)`. Zero analytics calls, zero awaited exit-path I/O.
- `authLogout` @490–499: direct `process.exit(0)`.
- Repo-wide grep of `src/`: **zero hits** for
  `cli_auth_status | logFeatureOk | exitAfterAnalyticsFlush | flushAnalytics`.
- `src/main.tsx:4609–4617`: plain `await authStatus(opts)` wiring — no flush wrapper.
- `git log` on auth.ts: `ebc61c1` (288 #35 login fix), `9e9f8f0` (2.1.286
  OCC-104), `827eba3` (2.1.281), `2bcb0f7` (2.1.268) — no commit ever touched
  the status teardown.

OCC's shape already matches v289's reverted teardown (no awaited telemetry →
direct exit); it is in fact strictly safer for the VSCode-timeout scenario since
there is no analytics network surface at all.

### 2.4 The OCC-104 (2.1.286) items are untouched by the revert

- Managed-key `api_key` branch (`auth.ts:409–424`, comment "CC 2.1.286
  (changelog #1)"): official bytes for this branch are identical in v288 and
  v289 (§1.5) → revert does not touch it → OCC's port stays correct.
- `recheckOAuthTokenIfUnusable` / `isOAuthTokenUnusable` / 30s throttle
  (`lastUnusableTokenRecheckAt`, PVo=30000) in `src/utils/auth.ts` ~1593–1663,
  tested by `src/utils/__tests__/oauthUnusableTokenRecheck286.test.ts`:
  credentials-cache layer (called from `invalidateOAuthCacheIfDiskChanged`,
  official `qk`), **not** the auth-status CLI path; unchanged between v288 and v289.

---

## 3. Action items

**None.** Verdict NO-OP:

- No `src/` change needed for changelog #4.
- Ledger hygiene for the 289 implementation round (not this research): record
  changelog #4 as NO-OP referencing this doc.

---

## Appendix — Forensic method

`grep -aboF` on both ELFs for anchors → exact-offset `dd if=... bs=1 skip=N count=M`
extractions → Python tokenizer (`"(?:[^"\\]|\\.)*"|`…`|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]`)
+ `difflib.SequenceMatcher` opcodes to separate structural deltas from
identifier renames. Line-based extraction was avoided (function bodies contain
literal newlines, e.g. `` f.join(`\n`) ``). Binaries were never executed.
