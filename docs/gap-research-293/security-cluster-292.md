# Security cluster forensics — official Claude Code 2.1.292 (4 security fixes)

**Round:** OCC-293 gap research · **OCC base:** main `5a3299f` (package version 2.1.374)
**Official target:** Claude Code 2.1.292 (where all 4 fixes landed)
**Method:** static binary forensics only — the official ELF was **never executed**. Fix sites
located with `/bin/grep -aboF "<phrase>"` → byte offset → `dd if=<binary> bs=1 skip=<off> count=<n>`
verbatim dumps. Cross-checked against OCC `src/` (read-only) with per-item source audits.

**Binaries**
- 2.1.292 (fixes present): `/tmp/cc-diff-293/vprev/package/claude`
- 2.1.293 (control): `/tmp/cc-diff-293/vver/package/claude`

> These fixes landed **in** 2.1.292, so the revealing diff is 2.1.291→2.1.292 (not extracted
> here). Each fix site was hunted **directly** in the 2.1.292 binary by distinctive phrase; all
> four were recovered verbatim. No 2.1.291 re-download was needed.

**Official 2.1.292 changelog lines (verbatim, the 4 in scope):**
- `Security: Fixed PreToolUse hook approvals and auto mode bypassing the permission prompt for file reads from network (UNC) paths`
- `Fixed sandboxed commands being able to read the staged file copies of /ultrareview uploads under ~/.claude/seed-admin`
- `Fixed a managed sandbox read-deny path (and user ones beside it) that appears or re-points mid-session not dropping project grants inside it or ending credential injection from files it covers`
- `Fixed a tampered on-disk cache of server-managed settings being able to switch off or unseat the built-in policy plugin while the settings fetch failed`

## Verdict summary

| # | Item | OCC status | Disposition |
|---|------|-----------|-------------|
| 1 | UNC read via PreToolUse-hook-allow / auto mode | **VULNERABLE** | **PORT this round** |
| 2 | `/ultrareview` seed-admin staged copies readable by sandbox | **IMMUNE-N-A** (asset absent) | N-A |
| 3 | Managed sandbox read-deny appear/re-point mid-session | **IMMUNE-N-A** (subsystem absent) | N-A |
| 4 | Tampered managed-settings cache unseats policy plugin | **IMMUNE-N-A** (no seat-able policy plugin; verified-gate fail-closed) | N-A |

Only **item 1** is portable. Items 2–4 are immune because the protected asset / whole subsystem /
attack target does not exist in OCC — proven by absence below, not assumed.

---

## Item 1 — UNC network-path file read bypasses the permission prompt (PreToolUse-hook-allow + auto mode)

### 1.1 Official fix (verbatim, 2.1.292 binary)

Two cooperating layers make a UNC read bypass-immune.

**(A) Path-validation hard deny** — code region @ `226081300` (reason string @ `226081893`):

```js
if(g=je(g),Dn(g)||/DavWWWRoot/i.test(g)||/@SSL@/i.test(g))
  return{allowed:!1,resolvedPath:g,decisionReason:{type:"other",
    reason:"UNC paths are blocked because they can trigger network requests and credential leakage"}};
```

`Dn(g)` = isUNC; plus WebDAV (`DavWWWRoot`) and `@SSL@` (NTLM-over-WebDAV) triggers matched
**anywhere** in the normalized path (not prefix-only). Returns a hard `allowed:!1`.

**(B) Read-tool pre-filesystem-access gate** — `async function rtn(e,s)` @ `220077900`
(reason-map string @ `220078507`):

```js
async function rtn(e,s){let r=[];try{r=await hr()}catch{}
  for(let u of UE(s)){
    if(s.additionalWorkingDirectories.has(u)&&!Sr(u,s.trustedNetworkDirectories)&&await y_e(u,C4()))continue;
    let n;try{n=await Rs(u)}catch{continue}
    if(Zat(u,n,C4()))continue;
    if(Pd(e,n,{caseFold:!1,skipPrivateAlias:!0,uncShapeParity:!0}))return!0}
  for(let u of r)if(Pd(e,u,{caseFold:!1,skipPrivateAlias:!0,uncShapeParity:!0}))return!0;
  return Sae(e,{},[e],{remoteSurface:!0}).behavior==="allow"}
var kr={nt_namespace:"read_file: NT-namespace path rejected before filesystem access",
  untrusted_unc:"read_file: untrusted UNC path rejected before filesystem access",
  untrusted_automount:"read_file: automount path rejected before filesystem access", ...}
```

The gate returns allow **only** for a UNC path inside `s.trustedNetworkDirectories`
(`Sr(u,s.trustedNetworkDirectories)` + shape-parity match `Pd(...,{uncShapeParity:!0})`); every
other UNC read is rejected `untrusted_unc` **before filesystem access**. Critically this is a
pre-I/O *reject*, not a prompt — so it cannot be short-circuited by a PreToolUse hook returning
`allow`, nor by auto mode. That is the essence of the fix: the UNC decision is moved out of the
"prompt that hooks/auto-mode can answer" lane into a hard pre-access gate.

### 1.2 OCC status — **VULNERABLE** (verified file:line)

OCC's UNC read check is a plain `ask` with `decisionReason.type:'other'`, which slips past both
bypass-immunity floors, and Read is in the auto-mode YOLO allowlist. Verified quotes:

- **The only UNC gate on the Read lane is an `ask`, type `'other'`** —
  `src/utils/permissions/filesystem.ts:1915-1929` (`checkReadPermissionForTool`, step 1):
  ```ts
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return { behavior: 'ask',
        message: `Claude requested permissions to read from ${...}, which appears to be a UNC path ...`,
        decisionReason: { type: 'other', reason: 'UNC path detected (defense-in-depth check)' } }
    }
  }
  ```
  Prefix-only (`startsWith`); no `DavWWWRoot` / `@SSL@` anywhere-match on the Read lane.

- **Bypass floor 1f is rule-only** — `src/utils/permissions/permissions.ts:1446-1451`:
  ```ts
  if (toolPermissionResult?.behavior === 'ask' &&
      isRuleAskDecisionReason(toolPermissionResult.decisionReason)) { return toolPermissionResult }
  ```
  `isRuleAskDecisionReason` (`permissions.ts:1348-1353`) is true only for `decisionReason.type==='rule'`.
  UNC is `type:'other'` → floor does **not** hold.

- **Bypass floor 1g is safetyCheck-only** — `src/utils/permissions/permissions.ts:1458-1466`:
  ```ts
  if (toolPermissionResult?.behavior === 'ask' &&
      toolPermissionResult.decisionReason?.type === 'safetyCheck') { ... return toolPermissionResult }
  ```
  UNC is `type:'other'` → floor does **not** hold. Then `permissions.ts:1468` `return null`
  ("No rule-based objection").

- **(a) PreToolUse-hook-allow bypass** — `src/services/tools/toolHooks.ts:504-512`:
  ```ts
  // Rule check passed (null) — hook decision stands
  if (hookBehavior === 'allow') {
    logForDebugging(... `Hook approved tool use for ${tool.name}, bypassing permission prompt`)
    return { decision: hookPermissionResult, input: hookInput }
  }
  ```
  `checkRuleBasedPermissions` returned null (UNC is not a rule/safetyCheck ask) → the hook's `allow`
  stands → `canUseTool`/`hasPermissionsToUseTool` never runs → **UNC read executes**.

- **(b) Auto-mode bypass** — `src/utils/permissions/classifierDecision.ts:60-64` puts Read in the
  auto/YOLO allowlist:
  ```ts
  function getSafeYoloAllowlistedTools(): Set<string> {
    return (SAFE_YOLO_ALLOWLISTED_TOOLS ??= new Set([
      FILE_READ_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME, ...
  ```
  In auto mode `permissions.ts:817-845` returns `{behavior:'allow', decisionReason:{type:'mode',mode:'auto'}}`
  for allowlisted tools without classification, and the UNC `ask` (type `'other'`) never triggered
  the auto-immunity branch (`permissions.ts:618-634`, safetyCheck-only). `bypassPermissions`
  (`permissions.ts:1598-1611`) likewise returns allow. (`acceptEdits` alone does **not** bypass —
  Read's acceptEdits simulation re-yields `ask`.)

- **The official hard-deny exists in OCC but is not wired to Read** —
  `src/utils/permissions/pathValidation.ts:398-408` returns `{allowed:false, reason:'UNC network
  paths require manual approval'}` via `containsVulnerableUncPath`, but its only callers are Bash
  (`src/tools/BashTool/pathValidation.ts:834,1159`) and PowerShell
  (`src/tools/PowerShellTool/pathValidation.ts:1739,1854,1946,1999`). The Read tool instead
  *defers* rather than blocks — `src/tools/FileReadTool/FileReadTool.ts:599-605`:
  ```ts
  // SECURITY: UNC path check (no I/O) — defer filesystem operations
  const isUncPath = fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')
  if (isUncPath) { return { result: true } }
  ```
  and `call()` (`:654+`) has no UNC gate ahead of `readFileInRange`/`stat`/`readFileBytes`.

- **Windows/WSL surface is real in OCC** (so not platform-N-A): `src/utils/platform.ts:11-29`
  (`win32`→`'windows'` + WSL detect), `PowerShellTool.tsx:367-369 isEnabled():true`, NT-namespace
  reject already ported at `FileReadTool.ts:611-617`. OCC even owns the official-faithful predicate
  `isUncPath`/`isDeniedUncPath` (`src/utils/macosKernelPaths.ts:370-383`, `UNC_PREFIX_REGEX=/^[\\/]{2}/`
  `:197`) but wires it only into the startup memory aggregate, never the Read permission lane.
  Repo-wide grep: **0** hits for `uncShapeParity`, `remoteSurface`, `untrusted_unc`, `skipPrivateAlias`;
  `trustedNetworkDirectories` appears only in two comments (`src/utils/permissions/guardedRead.ts:56,269`).

**Impact:** on Windows/WSL a UNC read (`\\host\share`, `...\DavWWWRoot\...`, `...\@SSL@...`) leaks
NTLM/SMB credentials; the same defect silently drops the prompt for `//host/share` reads on POSIX.

### 1.3 Porting plan (TDD-ready)

Goal: make the UNC read decision **bypass-immune** (official parity) instead of a plain `ask`, and
extend detection to anywhere-in-path WebDAV/`@SSL@` spellings, plus a pre-I/O gate.

**RED tests first** (`src/utils/permissions/__tests__/filesystem.unc.test.ts` and a
`toolHooks`/`permissions` integration test):
1. `checkReadPermissionForTool('\\\\host\\share\\x')` → decision is bypass-immune (see step A), not a bare `ask`.
2. PreToolUse hook returns `allow` for a UNC Read → final decision is **deny/ask**, never allow
   (assert `toolHooks` does not let hook-allow stand).
3. Auto mode + UNC Read → **not** auto-allowed (assert the allowlist fast-path is not taken).
4. `bypassPermissions` + UNC Read → still prompts/denies.
5. Read of `C:\share\DavWWWRoot\x` and `...\@SSL@8443\...` (trigger not at position 0) → gated.
6. A UNC path inside `trustedNetworkDirectories` → allowed (no regression on trusted shares).

**Step A — reclassify the UNC read decision (smallest correct change).** In
`src/utils/permissions/filesystem.ts:1915-1929`, change the returned `decisionReason.type` from
`'other'` to `'safetyCheck'` (and keep `behavior:'ask'`, or return `behavior:'deny'` for strict
official parity). Rationale: the `safetyCheck` type is what floors **1g** (`permissions.ts:1458-1466`),
**auto-mode immunity** (`permissions.ts:618-634`) and **bypassPermissions immunity**
(`permissions.ts:1574-1590`) already key off — so one type change makes the UNC read bypass-immune
across hook-allow, auto, and bypass lanes simultaneously. Strings to match/keep: the ask `message`
and `reason: 'UNC path detected (defense-in-depth check)'`.

> Confirm during GREEN that `permissions.ts:618-634` (auto) and `:1574-1590` (bypass) treat
> `type:'safetyCheck'` asks as immune; the source audit indicates they do (that is why `.git/`,
> `.claude/`, shell-config safety asks already survive hooks). If `deny` is chosen instead, verify
> no acceptEdits re-simulation path re-promotes it.

**Step B — extend the Read-lane detector to anywhere-match.** Replace the prefix-only
`startsWith('\\\\')||startsWith('//')` at `filesystem.ts:1918` (and mirror at
`FileReadTool.ts:601-602`) with the existing `containsVulnerableUncPath(cleanPath)` helper already
used by Bash/PowerShell (`src/utils/permissions/pathValidation.ts:399`,
`src/utils/shell/readOnlyCommandValidation.ts:1600,1606`), so `DavWWWRoot` / `@SSL@` / mixed
separators anywhere in the normalized path are caught. Reuse — do not re-implement.

**Step C — add the pre-filesystem-access gate (official `rtn` parity).** In
`src/tools/FileReadTool/FileReadTool.ts:599-605`, change the "defer" (`return { result: true }`)
into a hard reject for **untrusted** UNC paths, and only defer/allow when the path is inside the
session's trusted network directories. Emit the official reason string
`read_file: untrusted UNC path rejected before filesystem access` (matches `kr.untrusted_unc`) so
it is byte-comparable to official transcripts. This ensures the gate runs ahead of
`readFileInRange`/`stat`/`readFileBytes` regardless of the permission-lane outcome.

**Files touched:** `src/utils/permissions/filesystem.ts` (A, B),
`src/tools/FileReadTool/FileReadTool.ts` (B, C), tests as above. No change to
`pathValidation.ts`/`containsVulnerableUncPath` (reused as-is).

**Scope note:** OCC has no `trustedNetworkDirectories` field on `ToolPermissionContext`
(`src/Tool.ts` / `src/types/*`) — only comments reference it. Step C's "trusted" arm therefore
needs either (i) that field added to the context, or (ii) the conservative choice of rejecting all
UNC reads at the gate (no trusted-network allowance) — which is strictly safer and matches OCC's
existing "manual approval" posture. Decide (i) vs (ii) at plan time; (ii) is the KISS default.

---

## Item 2 — Sandboxed reads of `/ultrareview` seed-admin staged copies

### 2.1 Official fix (verbatim, 2.1.292 binary)

Sandbox read-deny root list builder `Lg()` @ `208997400` (`seed-admin` leg string @ `208997787`):

```js
function Lg(){let e=[$wt(),ze(we(),"seed-admin"),jMe(),...eCn(),...[]];
  return D(e.flatMap((r)=>[r,$S(r)]).flatMap((r)=>ga(r)??[]))}
```

`ze(we(),"seed-admin")` = `join(claudeConfigDir, "seed-admin")` — added to the read-deny roots a
sandboxed command cannot read. Companion placement guard @ `210423387`:
`inside_tree:"~/.claude/seed-admin lies inside this working tree or its repository"`.

### 2.2 OCC status — **IMMUNE-N-A** (protected asset absent)

The asset the fix guards — `~/.claude/seed-admin` staged copies of `/ultrareview` uploads — does
not exist in OCC.

- `grep -rn "seed-admin" src/ packages/ bin/ scripts/` → **0 code hits** (only the occ148/149 gap
  notes that flagged this item for a surface check — this is that check).
- OCC's `/ultrareview` stages to the **cloud**, not to `~/.claude`:
  `src/commands/review/reviewRemote.ts:276-281` (`teleportToRemote({useBundle:true,...})`) →
  `src/utils/teleport/gitBundle.ts:230` (`generateTempFilePath('ccr-seed','.bundle')`) →
  `src/utils/tempfile.ts:30` (`join(tmpdir(), ...)`, i.e. `/tmp`, **not** `~/.claude`) →
  `gitBundle.ts:260` (`uploadFile(bundlePath,'_source_seed.bundle',...)`) → `gitBundle.ts:292`
  (`unlink(bundlePath)`). The `seed` token in OCC is git refs (`refs/seed/stash`) + cloud
  `seed_bundle_file_id`, never a `seed-admin` dir.
- OCC **does** have a managed sandbox read scope, so the N-A is by missing asset, not missing
  sandbox: `src/utils/sandbox/trustedTierGrants.ts:409-411`
  (`const raw = [configDir, getGlobalClaudeFile(), join(configDir,'ide')]` — no `seed-admin` leg),
  enforced at `src/utils/sandbox/sandbox-adapter.ts:620-625,665,676,698,794`.
- Belt-and-suspenders: even hypothetically, `~/.claude/seed-admin` lies **inside** `configDir`
  (`~/.claude`), already the first read-deny baseline entry (`trustedTierGrants.ts:411`), so the
  official's explicit subpath leg is redundant with OCC's existing config-dir root.

**No change warranted.** Porting `ze(we(),"seed-admin")` into `getClaudeOwnReadDenyBaseline` would
add a deny root for a directory OCC never creates — dead config. Resolves the occ148/149
"needs surface check" flag as IMMUNE-N-A.

---

## Item 3 — Managed sandbox read-deny path appearing / re-pointing mid-session

### 3.1 Official fix (verbatim, 2.1.292 binary)

A large mid-session **re-look** subsystem on the sandbox class. Persistent state @ `208971500`:

```js
installedReadDenyRootResolution=void 0;readDenyRootFirstLookDue=!1;readDenyRootLookCursor=0;
readDenyRootLookFinishedAt=void 0;readDenyRootLookFailureReported=!1;readDenyRootReachSeenAtLook=0;
readDenyRootWithinSandboxReach=new Map;pendingReadDenyFallback=void 0; ...
builtConfigReadDenyRootResolution=new WeakMap;trustedReadDenyRootResolution=void 0;
```

Driver `Vre()` @ `208989900` (`readDenyRootLookFinishedAt=performance.now()` @ `208990751`):

```js
function Vre(){let e=St();iP();let r=e.readDenyRootFirstLookDue;e.readDenyRootFirstLookDue=!1;
  let n=e.installedReadDenyRootResolution;if(n===void 0)return;
  let s=performance.now(),
    h=e.readDenyRootLookFinishedAt!==void 0&&s-e.readDenyRootLookFinishedAt<Ure,
    g=n.forwardedUntrustedGrants.length===0&&e.lateSymlinkGrantCandidates.length===0
      &&!(qt.getConfig()?.credentials?.files??[]).some((b)=>b.mode==="mask"&&!nx(b));
  if(!r&&(h||g))return;
  try{$re(n,r)}finally{e.readDenyRootLookFinishedAt=performance.now()}}
```

`$re()` re-resolves the read-deny roots, dropping `forwardedUntrustedGrants` / project grants inside
a re-pointed root and re-masking `credentials.files` entries with `mode==="mask"`
(`maskSweepEntries`). Reach cache `Fre()` + symlink re-point detector `Ef()`/`kge()`
(`{settled, stoppedAt, throughLink}`) + cursor/budget select `Mre()` @ `208987100`.

### 3.2 OCC status — **IMMUNE-N-A** (entire subsystem absent)

Both remediation arms operate on structures OCC does not have.

- **Re-look state 0/7 present:** repo-wide grep = **0** for `readDenyRootFirstLookDue`,
  `readDenyRootLookCursor`, `readDenyRootLookFinishedAt`, `readDenyRootWithinSandboxReach`,
  `readDenyRootReachSeenAtLook`, `installedReadDenyRootResolution`, `builtConfigReadDenyRootResolution`.
- **No mid-session re-look lifecycle:** grep = 0 for `firstLook`/`LookCursor`/`withinSandboxReach`.
  OCC instead **rebuilds the whole sandbox config** on settings change:
  `src/utils/sandbox/sandbox-adapter.ts:1584` (`settingsChangeDetector.subscribe(...)` →
  `convertToSandboxRuntimeConfig` → `BaseSandboxManager.updateConfig`) and `refreshConfig()`
  (`:1606`, called from `REPL.tsx:4963/5034`, `add-dir.tsx:96`). Read-deny baseline is resolved
  through symlinks **at build time** (`trustedTierGrants.ts:430,458,246`), not re-looked.
- **Arm (a) — forwarded/project grants: ABSENT.** grep = 0 for `forwardedUntrustedGrants`,
  `lateSymlinkGrantCandidates`, `projectGrant`, `untrustedGrant`, `lateSymlink`. OCC does the
  *opposite* — it **drops** untrusted grants at build time (`sandbox-adapter.ts:664-668,675-679,697-701`,
  `candidateUnderDeniedRead`), keeping no persisted grant list that could go stale mid-session.
- **Arm (b) — credential injection with `mode==="mask"`: ABSENT (no surface).**
  `src/utils/sandbox/sandboxTypes.ts:193-200` (`credentials: z.object({ enabled: z.boolean()... })`
  — only `enabled`, no `files[]`, no `mode`/`mask`); `trustedTierGrants.ts:45-46,441` ("OCC has no
  `credentials.files` setting"). grep = 0 for `maskSweep`/`credentialInjection`. Corroborated by
  `docs/gap-research-288/cluster-a-permission-sandbox.md:335`.
- **Symlink re-point trio `{settled, stoppedAt, throughLink}`: ABSENT.** `throughLink` = 0 matches.
  OCC has `stoppedAt`+`leafIsSymlink` (`fsOperations.ts:423`, from the 2.1.289 spelling work) but
  not the re-point detector.

The bug requires *persisted* forwarded-grants + credential-mask-injection that survive a symlink
re-point. OCC has neither and re-derives/re-screens grants from disk on every rebuild. Not STAGED
(there is no surface to port onto). Resolves the occ149 §7 "NEXT ROUND TOP PRIORITY" flag as
IMMUNE-N-A.

---

## Item 4 — Tampered on-disk cache of server-managed settings unseats the built-in policy plugin

### 4.1 Official fix (verbatim, 2.1.292 binary)

`remote_managed_settings_pull` store class — the verified/unverified split is the fix.
`replaceSessionCache` @ `204418622`, `seedFromDisk` @ `204418751`:

```js
replaceSessionCache(e,n){if(this.sessionCache=e, n?.verified){
  if(this.verifiedPayload=e, n.consentDeferred)this.deferredPayload=e}}
seedFromDisk(e){this.sessionCache=e; ...}   // disk cache → sessionCache ONLY, never verifiedPayload
```

Gate helpers — policy-plugin authority reads `verifiedPayload` (@ `204430317`):

```js
function El(e,n){return n===e.verifiedPayload||Boolean(ek())}
function uy(){let{sessionCache:e,verifiedPayload:n}=de();return e!==null&&e===n}
function RRt(){let{sessionCache:e,verifiedPayload:n,consentedPayload:s,deferredPayload:r}=de();
  return e!==null&&e===n&&(e===s||e===r)}
```

Apply path @ `220240500`–`220242700`: live fetch success calls `Eit(E,{verified:!0,...})`
(`Eit`≡`replaceSessionCache`); **fetch-failure fallback** ("Using stale cache after error" @
`220242270`) calls `Eit(r)` with **no** `verified` flag:

```js
catch{ ... if(r)return t("Remote settings: Using stale cache after error"),Eit(r),
  {settings:r,fetchSucceeded:!1,failure:w,resolution:"failed"}; ...}
```

Signature is persisted/checked via `storageV5`/`h.signature`. **Net effect:** a tampered on-disk
cache can only ever populate `sessionCache`; `verifiedPayload` is set *only* by a
signature-verified live fetch, and the built-in policy plugin's seat reads `verifiedPayload`
(`El`/`uy`/`RRt`). So when the fetch fails and the app falls back to disk cache, the policy plugin
cannot be switched off or unseated.

### 4.2 OCC status — **IMMUNE-N-A** (attack target absent; verified-gate fail-closed)

**Correction to the working premise:** OCC *does* have prong (a) — a remote managed-settings fetch
with an on-disk cache and stale-on-failure fallback:
- Fetch: `src/services/remoteManagedSettings/index.ts:110`
  (`` `${getOauthConfig().BASE_API_URL}/api/claude_code/settings` ``).
- Disk cache: `src/services/remoteManagedSettings/syncCacheState.ts:32`
  (`SETTINGS_FILENAME='remote-settings.json'`, mode `0o600` at `index.ts:382`, under user-writable
  `getClaudeConfigHomeDir()`); disk→sessionCache seed `syncCacheState.ts:70-95`.
- Stale fallback (analog of official `Eit(r)` no-verified): `index.ts:447-451`
  (`'Remote settings: Using stale cache after fetch failure'` → `setSessionCache(cachedSettings)`)
  and `index.ts:507-509` (`'... after error'`).
- Top-priority `policySettings` source: `src/utils/settings.ts:587-589,673,976-978`.

OCC is immune for **two** reasons:

1. **No seat-able built-in policy plugin exists (decisive).** The built-in plugin registry is empty:
   `src/plugins/bundled/index.ts:22-28` ("No built-in plugins registered yet");
   `registerBuiltinPlugin()` (`builtinPlugins.ts:28`) is never called with a real plugin;
   `main.tsx:2283` calls the empty `initBuiltinPlugins()`. grep for
   `policy plugin|policyPlugin|unseat|isSeated|pluginSeat|reseated` → **0 code hits**. Policy
   enforcement in OCC is **direct always-on code**, not a toggleable seat:
   `pluginOnlyPolicy.ts:19-27`, `allowedProvidersEnforcement.ts`, `policyLocks.ts`. Nothing to unseat.

2. **The verified-gate analog is hard-fail-closed.** OCC has the old single-`sessionCache` model —
   no `verifiedPayload`, no `signature`, no `seedFromDisk`/`replaceSessionCache` split (grep hits
   only comments). `syncCacheState.ts:34` (`let sessionCache: SettingsJson|null = null` is the only
   store). The official `Pb()` gate maps to constant FALSE:
   `src/services/remoteManagedSettings/allowedProvidersEnforcement.ts:583-585`
   (`function isRemotePolicyVerified(): boolean { return false }`), and `remotePolicyState()`
   returns `servedSnapshot:false` (`:571-579`). Documented at `:39-48` (divergence #1) as
   *"strictly MORE restrictive than official (safe)"* — a tampered disk cache cannot elevate itself
   to "verified." For the one enforcement path ported (`allowedProviders`), remote can only
   **narrow** the machine list (`effectiveAllowedProviders = machine ∩ slot`, `:609-616`), never
   widen/weaken it.

**No change warranted for this item.** grep of OCC CHANGELOG for
`policy plugin|verifiedPayload|unseat|tampered|seedFromDisk|replaceSessionCache` → 0 (the official
fix was never ported, and no policy-plugin-seat was ever claimed).

**Honest caveat to hand the security reviewer (out of scope for this fix, shared with upstream):**
OCC's `remote-settings.json` is user-writable, unsigned, and the top-priority `policySettings`
source (`settings.ts:587-589`); general policy keys (`enabledPlugins` via `pluginPolicy.ts:18`,
`disableAllHooks`, `strictPluginOnlyCustomization`) are read straight from that layer. A local user
tampering the cache while the fetch fails could influence those *general* keys — but
`allowedProviders` is protected by the narrow-only + fail-closed design, and this "disk cache
trusted for policySettings" property is a pre-existing design OCC shares with upstream, **not** the
policy-plugin-seat bug 2.1.292 fixed. Track separately if the reviewer wants a signed cache.

---

## Disposition recap

- **Item 1 (UNC read bypass): PORT this round** — VULNERABLE, verified end-to-end; TDD-ready plan in §1.3
  (reclassify UNC read decision to `safetyCheck`/`deny`; reuse `containsVulnerableUncPath`;
  add pre-I/O `untrusted_unc` gate in `FileReadTool`).
- **Item 2 (seed-admin staged copies): N-A** — protected asset absent (OCC `/ultrareview` stages a
  throwaway `/tmp` bundle to the cloud and unlinks it).
- **Item 3 (read-deny mid-session re-point): N-A** — entire re-look subsystem + forwarded-grants +
  credentials.files-mask surface absent.
- **Item 4 (managed-settings cache unseats policy plugin): N-A** — no seat-able built-in policy
  plugin, and the verified-gate analog is hard-fail-closed. (Caveat §4.2 handed to reviewer.)

Nothing was STAGED this round: items 2–4 are immunity-by-absence (proven), and item 1 is fully
extracted and portable. No `src/` file was modified and no git command was run in producing this
document.
