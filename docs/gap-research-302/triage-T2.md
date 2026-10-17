# Gap research — official Claude Code 2.1.302 triage, batch T2

Scope: changelog entries **#06, #09, #10, #11, #18, #21, #23, #25, #26, #27, #30, #31, #32, #35** (full 63-entry list: `docs/gap-research-302/entries-63.txt`).
Binaries: `v302/package/claude` (md5 `39885c1377a0f0d922b73bf8653a6c3f`; Version 2.1.302, BUILD_TIME 2026-10-16T15:52:41Z, GIT_SHA 2ef144e6f98c1c99d082b735e4b38f50e3391e55) vs `v301/package/claude` (md5 `7f52c3d8eda2796a6002cb7380aabfb9`). Forensics only — `strings`/`grep -aboF` byte offsets + bounded python window extractions. The official binary was never executed. Offsets are byte offsets into the ELF; matches below ~100 M are bytecode/binary false positives and were filtered (the literal string-table region ~117 M–130 M holds real strings but was treated separately from the JS blob ≥ ~210 M). Novelty was established with a probe test (`v302[o-60:o+80] not in v301`); minified symbol renames between versions are noise and were filtered in token diffs.

Disposition legend: **PORT** = OCC has the surface at pre-302 behavior, fix is portable · **ALREADY-ALIGNED** · **STAGED** = mechanism unrecoverable or too large · **N-A** = surface absent in OCC · **CAND** = candidate, evidence insufficient to port faithfully.

---

## #06 — Read tool: image of any size / pipe-or-device read entirely into memory; 128 MB refusal

> Fixed the Read tool loading an image file of any size, or a pipe or device named like an image, entirely into memory; image sources over 128 MB are now refused

**Disposition: PORT (M) — security/DoS hardening**

### Binary evidence (v302, NEW)

New image-read limiter @246685000–246688600 (absent from v301, which read unbounded: `DW(e.handle,1/0,"stream")`):

```js
var cB = S_o;                 // = 134217728 (128 MiB)
var zXr = 65536;              // 64 KiB chunk
// qXr = readImageBytes, oOn = chunked reader
```

Chunked reads handle non-regular files (pipes/devices). Two refusal messages (verbatim):

```
File is too large to read as an image (the limit is ${Zt(cB)}): ${n}. If it is an image, resize it or export a smaller copy, then read that.
```
(reason `"File over the image read limit"`)

```
Cannot read this as an image: ${n} is a pipe or a device, not a regular file, and it sent more than ${Zt(cB)} without ending.
```
(reason `"Image stream over the read limit"`)

### OCC side

- `src/tools/FileReadTool/FileReadTool.ts:1326-1329` — image branch calls `readImageWithTokenBudget(resolvedFilePath, maxTokens)` with **no byte cap**.
- `src/utils/fsOperations.ts:918-921` — `readFileBytes(fsPath, maxBytes?)` falls through to an uncapped `readFilePromise` when `maxBytes` is undefined.
- `src/utils/attachments.ts:2676` — same uncapped path.
- Only guard today is a hardcoded `/dev` blocklist (`FileReadTool.ts:127-157`) — a named pipe like `./evil.png` (FIFO) or a large regular image still reads fully into memory.

### Implementation note

1. Add `MAX_IMAGE_READ_BYTES = 134217728` (128 MiB) constant.
2. In `readFileBytes`, enforce `maxBytes` on the image path; stat-first refusal for regular files over the cap (message 1, reason "File over the image read limit").
3. For non-regular files (FIFO/char device) read in 64 KiB chunks with a running total; refuse past the cap (message 2, reason "Image stream over the read limit").
4. Wire the cap through `FileReadTool.ts` image branch and `attachments.ts:2676`.
5. Tests: oversized image refusal; FIFO named `*.png` refusal; under-cap image still reads.

---

## #09 — `claude plugin` subcommands exiting before a queued settings/config write finished

> Fixed `claude plugin` and other subcommands sometimes exiting before a queued settings or config write finished, which could lose the change or leave a `.tmp` file behind

**Disposition: ALREADY-ALIGNED (no async write queue exists in OCC)**

### Binary evidence (v302)

Official has a process-wide write-drain registry (present in BOTH versions @234906543):

```js
class xp{drains=new Set;register(e){this.drains.add(e)}
  async drainAll(){await Promise.all([...this.drains].map((e)=>e().catch(()=>{})))}}
var Ip=new xp;function OHe(e){Ip.register(e)}function nO(){return Ip.drainAll()}
```

Registrations: settings write queue `OHe(aze)` @235352723; global config `OHe(Bht)` @236889660; claude.ai marketplace registry @243358028; `known_marketplaces.json` @246911348. The v302 fix adds `nO()` awaits on the exit paths — 13 call sites, e.g. plugin-CLI helper @247732834:

```js
var t=2000;
async function VU({waitForOAuthRefresh:r=!0}={}){if(r)await S6n();await je(nO(),t);...}
async function To(r){await VU(),process.exit(r)}
```

plus exec path @249935901 (`Lt(nO(),2000,"write queue drain timeout (exec)")`), bridge exit @259974162, error exit @260395124, auth-login exits @262778970/262781206/262782261, session shutdown @242979281.

### OCC side

OCC has **no async write queue to drain** — every settings/config/plugin write is synchronous and completes before the calling code returns:

- `src/utils/file.ts:362` `writeFileSyncAndFlush_DEPRECATED` (temp `.tmp.${pid}.${Date.now()}` :386 + `renameSync` :437).
- `src/utils/slowOperations.ts:246` `writeFileSync_DEPRECATED`.
- Settings: `src/utils/settings/settings.ts:874` inside `updateSettingsForSource` (:790).
- Config: `src/utils/config.ts:1218` `saveConfig` / :1394 `saveConfigWithLock` (lockfile :1253).
- `installed_plugins.json`: `src/utils/plugins/installedPluginsManager.ts:378`.
- Plugin CLI exits happen AFTER the sync writes: `src/services/plugins/pluginCliCommands.ts:164,206,249,292,315` `process.exit(0)`; :366 `gracefulShutdown(0)`; `src/main.tsx:4858-4912`.

The official bug (queued async write races `process.exit`) is structurally impossible in OCC. No `.tmp` leftover risk beyond a crash mid-`writeFileSync`.

### Implementation note

None. If OCC ever moves settings/config writes to an async queue, port the drain-registry + exit-path pattern above verbatim (2 s drain timeout on every exit path).

---

## #10 — marketplaces re-cloning every refresh + git-plugin version "unknown" under reftable

> Fixed plugin marketplaces re-cloning on every refresh, and newly installed git plugins showing version "unknown", when git defaults to the reftable ref format

**Disposition: PORT (S) for the version-detection half; marketplace half = STAGED (official delta unrecoverable — v301 already reftable-aware there)**

### Binary evidence (v302)

- **Reftable-aware ref resolver** `M4` @235158155 — resolves refs through a `git show-ref` subprocess when the gitdir is reftable, else fs reads (loose ref → `packed-refs` → commondir):

```js
async function M4(e,n,r=5){if(r<=0)return null;
  if(await ubt(e)){                                   // ubt: .git/HEAD == "ref: refs/heads/.invalid" (reftable sentinel)
    if(n!=="HEAD"&&(!n.startsWith("refs/")||!fE(n)))return null;
    let s=await Ae(e,["show-ref","--verify","--hash","--end-of-options",n]),
        c=s?.code===0?s.stdout.trim():null;
    return c!==null&&$2(c)?c:null}
  let i=await Qn(e,n,r);if(i)return i;
  let o=await IW(e);if(o&&o!==e)return Qn(o,n,r);return null}
```

  Reftable detection `ubt` @235159663: reads `<gitDir>/HEAD`, true iff it equals the sentinel `ref: refs/heads/.invalid` (constant `ar="refs/heads/.invalid"` — same sentinel in v301's `dr`).
- HEAD parser `C3` @235157527 handles the sentinel via `symbolic-ref -q --no-recurse HEAD` then `M4(e,"HEAD")`.
- Marketplace checkout probe `cFn` @246853480 uses `C3` + `M4` to compare local HEAD sha vs `ls-remote` (returns `"current"|"stale"|"unreachable"`; only non-current triggers re-clone in `jN` @246918181).
- **However**: v301's counterparts (`h4` @217723072, `d3` @217722438, `h_t` @217724574, probe `YIn`, wrapper) are **byte-identical modulo renames** (token-diff: 0 real diffs). The show-ref runner guards (`Ce`/`Ae`) also diff clean. So the marketplace re-clone fix leaves no recoverable v301→v302 string delta in this path — it is likely inside the reorganized git-dir integrity/attestation module (NEW reftable hits @241553331–241570481: `extensions.refstorage` config scan, `ref_storage` fault kinds, `A$` refs-layout check accepting `refs/heads` as a plain FILE, which reftable placeholder files are) — CAND at best, not portable faithfully.
- New-in-v302 branch-watcher reftable support: watches `<gitDir>/reftable/tables.list` (+commonDir) @235161779, `reftableNewest` field @235168640; cherry-pick/revert head checks via `show-ref --exists` (exit 2 = missing) @240974097; reflog fallback via `symbolic-ref -q HEAD` @235170285.

### OCC side

- `src/utils/plugins/pluginVersioning.ts:36` `calculatePluginVersion`: manifest.version(:45) → providedVersion(:53) → short git sha(:61) → `getGitCommitSha(installPath)`(:94) → `'unknown'`(:105).
- `getGitCommitSha`(:114) → `getHeadForDir` (`src/utils/git/gitFilesystem.ts:600`) is **pure fs reads**: `resolveRefInDir`(:221) handles loose refs + `packed-refs` only(:247) — **no reftable support**. Under a reftable-default git (≥2.56 `init.refStorage=reftable`), `.git/refs/heads/<branch>` is a placeholder FILE and `packed-refs` is absent → OCC returns `'unknown'` — exactly the official pre-302 symptom.
- OCC's worktree code already special-cases reftable (`src/utils/worktree.ts:975/:990/:1005`), so the sentinel-detection pattern exists in-repo.
- Marketplace manager (`src/utils/plugins/marketplaceManager.ts`) is pull-first (`reconcileSparseCheckout` :1451, `gitPull` :1454) with re-clone only as a fallback (:1566) and uses the git CLI for fetch/pull — reftable does not break `git pull`, so the re-clone-every-refresh symptom likely does not reproduce in OCC. `isInTransientGitState` (`src/utils/gitDiff.ts:308-327`) is fs-only (reads `CHERRY_PICK_HEAD` etc. as files — under reftable these live in the reftable store; minor, informational).

### Implementation note

1. In `gitFilesystem.ts` `getHeadForDir`/`resolveRefInDir`: add a reftable fallback — when the loose-ref read fails AND (`<gitDir>/HEAD` contains `ref: refs/heads/.invalid` OR `<gitDir>/reftable/` exists), resolve via `git show-ref --verify --hash --end-of-options <ref>` subprocess (official `M4` shape), or `git rev-parse --verify HEAD` for the HEAD case.
2. Keep the fs path first (official order: reftable check → subprocess; else loose → packed-refs → commondir).
3. Tests: create a reftable repo (`git init --ref-format=reftable` if the local git supports it, else fixture gitdir with sentinel HEAD + `reftable/` dir), assert `calculatePluginVersion` returns the short sha, not `'unknown'`.

---

## #11 — PowerShell tool: plugin `bin/` not on PATH; empty search piped into Select-Object errors

> Fixed the PowerShell tool not finding commands in a plugin's `bin/` folder, and reporting an error when a search that finds nothing (rg, grep, findstr, git grep) is piped into `Select-Object` or another formatting cmdlet

**Disposition: STAGED (prerequisite feature absent in OCC — no plugin-bin-PATH mechanism at all; Select-Object half leaves no string trace)**

### Binary evidence (v302)

PATH half — plugin bin dirs are appended to PATH when building the pwsh environment:

- New shell-state field: `class h{shellConfig=null;powerShellProvider=null;powerShellPluginBinPaths=null;...}` (new_strings line15564).
- Env assembly (new_strings line7681): `$r=r==="powershell"&&!K?await(zt.powerShellPluginBinPaths??=oMn(ft)):[]`.
- Provider init @246577825: `async function n8r(e){let n=await u9s(),r=await oMn(e);return{provider:await zPn(n,{pluginBinPaths:r}),pluginBinPaths:r}}`; failure logs `Shell: leaving plugin bin/ dirs off PATH: ...`.
- Plugin-bin lister `_po` @247275883: enabled non-builtin plugins → `join(path,"bin")`; drops entries containing shell metacharacters (`Dropping plugin bin path with shell metacharacters:`) or the PATH delimiter (NEW v302: `Dropping plugin bin path that holds the PATH delimiter:`, 0→2); stat with 2 s timeout (`YGn=2000`); ENOENT/ENOTDIR → drop; other stat failures → keep (`Keeping plugin bin path on PATH despite a failed stat`).
- On plugin refresh, `ldo(e)` resets `powerShellPluginBinPaths=null` and keeps/drops the shell snapshot based on whether the bin list changed (`plugin bin/ PATH entries unchanged/changed`).
- Generic PATH-append helpers NEW in v302 next to the bash wrapper: `dot(existing,pluginPaths,delim)` (dedupes, drops delimiter-containing entries) and `RPn(env,paths,delim)` @ ~246555900.

Select-Object half — **no recoverable delta**: `Select-Object` 34/34, `NativeCommandError` 3/3, `LASTEXITCODE` 8/8, `PSNativeCommand*` 0/0, classification regex `["native_command_error",/NativeCommandError|RemoteException/]` identical; token-diff of the classification region: 0 real diffs. The fix is presumably pure logic inside the pwsh result handling with no string changes — CAND, not portable faithfully.

### OCC side

- OCC has a PowerShellTool (`src/tools/PowerShellTool/`) but **no plugin-bin-PATH mechanism in any shell** — no `pluginBinPaths`, no shell snapshot PATH append, no plugin `bin/` discovery anywhere in `src/` (grep-verified). The prerequisite feature (plugin `bin/` on PATH, which official bash has had since before 301) was never ported to OCC.
- Therefore the pwsh half of #11 fixes a bug OCC cannot have; porting it means first porting the whole plugin-bin-PATH feature (both bash and pwsh envs), which is a pre-302 backlog item, not a 302 gap.

### Implementation note

1. Track "plugin `bin/` directories on tool PATH" as a feature-gap backlog item (pre-dates 302). If ported: mirror `_po` (metachar/delimiter dropping, 2 s stat timeout, ENOENT/ENOTDIR → drop, other stat errors → keep) and `dot`/`RPn` append semantics for both BashTool and PowerShellTool envs; invalidate the pwsh provider cache on plugin refresh when the list changes.
2. Select-Object half: no action (nothing to port from strings). If OCC users report pwsh NativeCommandError noise on empty rg/grep output, revisit with a local repro.

---

## #18 — MCP servers negotiating 2026-07-28 but omitting `resultType`/`ttlMs`/`cacheScope`

> Fixed MCP servers showing no tools, or every tool call failing, when the server negotiates protocol version 2026-07-28 but omits `resultType`, `ttlMs` or `cacheScope`

**Disposition: N-A (advisory — SDK-gated; port when OCC's MCP SDK negotiates 2026-07-28)**

### Binary evidence (v302, NEW @273038449–273040200)

Client-transport shim `vo(e,n)` wrapping the SDK transport:

- Stamps outgoing `params._meta` with `Dr="io.modelcontextprotocol/protocolVersion"` and checks it on responses.
- `Hi=new Set(["tools/list","prompts/list","resources/list","resources/templates/list","resources/read","server/discover"])` — the list/read methods whose results must carry the new fields.
- `ji=256` — request-id→method LRU cap.
- `Vi` backfills missing fields: `resultType="complete"`, `ttlMs=0`, `cacheScope="private"`, with warn log `...result omits required fields although the server negotiated 2026-07-28...`.

### OCC side

- OCC pins `@modelcontextprotocol/sdk` 1.29.0; `LATEST_PROTOCOL_VERSION` is `'2025-11-25'` — OCC never negotiates 2026-07-28 and never stamps `params._meta`. The failure mode (strict client-side validation rejecting results without the new fields) cannot occur.

### Implementation note

None now. When OCC upgrades the MCP SDK past the 2026-07-28 protocol: port the shim verbatim (backfill defaults + warn), otherwise every non-conformant server breaks. Recorded here as the upgrade checklist item.

---

## #21 — `claude plugin details <name>@builtin` suggesting `claude plugin list`

> Fixed `claude plugin details <name>@builtin` suggesting `claude plugin list`, which never shows built-in plugins, when the plugin isn't found; it now points to `/plugin`

**Disposition: N-A (OCC has no `plugin details` subcommand)**

### Binary evidence (v302 @275847609; v301 had only the second branch @101296245)

```js
`Plugin "${Ge(o)}" not found. ${y.marketplace===oi
  ? "Built-in plugins don't appear in `claude plugin list`. To see the ones available in a session, run /plugin in Claude Code and open the Installed tab."
  : "Run `claude plugin list` to see installed plugins, or pass --plugin-dir <path> to load one from disk."}`
```

(`oi` = builtin marketplace name constant.)

### OCC side

- No `plugin details` subcommand: `src/main.tsx:4797` `pluginCmd` registers only validate/list/marketplace add|list|remove|update/install/uninstall/enable/disable/update.
- Builtin concept exists (`src/plugins/builtinPlugins.ts:23` `BUILTIN_MARKETPLACE_NAME='builtin'`, :37 `isBuiltinPluginId`), and `src/utils/plugins/pluginConfigure.ts:87-91` carries the old `claude plugin list` suggestion — but plugin configure is **not wired into main.tsx** (unreachable code).

### Implementation note

None. If `plugin details`/`plugin configure` are ever wired up, use the v302 two-branch message (builtin → point to `/plugin` Installed tab).

---

## #23 — worktree isolation refusing under git ≥2.56 with a stray `.git` file pointing at a nonexistent dir

> Fixed worktree isolation refusing to create or resume worktrees under git 2.56 or later when a stray `.git` file points at a directory that doesn't exist

**Disposition: PORT (S)**

### Binary evidence

v302 @243939195 vs v301 @226603811 (gitfile-marker string count 2→4):

```js
// v302:
function pGt(e){return/not a git repository/i.test(e)||/gitfile does not point to a valid repository/i.test(e)}
// used in the rev-parse failure classifier:
if(pGt(n.stderr))return"no-repo";
...
if(typeof n.exitCode==="number"&&n.timedOut!==!0&&o$o(e))return"no-repo";
return"error"
// v301:
function GWt(e){return/not a git repository/i.test(e)}
```

Git ≥2.56 emits `fatal: gitfile does not point to a valid repository` for a stray `.git` FILE whose target directory doesn't exist; v301 classified that stderr as `"error"` → worktree create/resume refused. v302 classifies it as `"no-repo"` → proceeds (worktree features simply treat the dir as not-a-repo).

### OCC side

- `src/utils/git.ts:27-47` `findGitRootImpl` accepts a `.git` FILE with **no target validation**; `resolveCanonicalRoot` (:170-230) catch → falls back to gitRoot.
- `src/utils/git/gitFilesystem.ts:41-78` `resolveGitDir` — no existence check on the gitfile target.
- `src/utils/worktreeBaseResolve.ts:136-161` `classifyRevParseCause` maps exit 128 → `'git_refused'`; :167-213 `buildWorktreeBaseResolveFailureMessage` — the REPO_UNCONFIRMED branch (:184-186) is unreachable for a stray-but-parseable gitfile, so OCC's failure surfaces as a generic base-resolve error (`worktree.ts:429-439` `Failed to resolve base branch "${baseBranch}": ${detail}`) — same user-visible refusal class as official pre-302.
- No git-version checks anywhere in OCC (correct — official doesn't version-gate either; the stderr text is the signal).

### Implementation note

1. In OCC's rev-parse/git-failure classification (`worktreeBaseResolve.ts` `classifyRevParseCause` and any worktree-entry `isGitRepo` checks fed by stderr), add the official regex: treat `/gitfile does not point to a valid repository/i` the same as `/not a git repository/i` → "not a repo" (proceed without worktree isolation / classify as no-repo, not error).
2. Tests: temp dir containing `.git` file with `gitdir: /nonexistent/path`; assert worktree create/resume paths classify as no-repo instead of failing.

---

## #25 — self-hosted runner: "bad object refs/heads" in reused reftable checkouts

> Self-hosted runner: Fixed git fetches failing with "bad object refs/heads" in sessions that reuse a checkout stored in git's reftable format

**Disposition: N-A (OCC's self-hosted runner is a dead stub)**

### Binary evidence (v302, NEW @248274374)

Runner session sanitize, before reusing a checkout:

```js
for(let e of["objects","refs",...])
await Je(ae(s,"refs","heads")),
n("[runner:session] sanitize: .git/refs/heads was not a directory — removed (a reftable repository leaves a placeholder file there)")
// ENOENT / ERR_FS_EISDIR tolerated, then:
await Uo(ae(s,"refs"),!0)
```

I.e. remove the reftable placeholder FILE at `.git/refs/heads` so subsequent `git fetch` (files-backend) doesn't choke with "bad object refs/heads".

### OCC side

- `src/self-hosted-runner/main.ts` is a 3-line no-op stub (167 bytes); its caller `src/entrypoints/cli.tsx:299-305` is gated behind `feature("SELF_HOSTED_RUNNER")`, which is **not** in `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts:13-64`) → dead code in live builds. No session-checkout reuse exists.

### Implementation note

None. If SELF_HOSTED_RUNNER is ever enabled, port the sanitize step (placeholder-file removal with ENOENT/EISDIR tolerance + the log line) into the checkout-reuse path.

---

## #26 — Windows: every write refused/asked on exFAT/FAT32 drives

> Windows: Fixed every file write being refused or asked about for projects on exFAT or FAT32 drives, including in sessions started with `--plugin-dir`

**Disposition: N-A**

### Binary evidence

`exFAT`/`FAT32` string counts: 0/0 in BOTH ELFs — the fix is inside the Windows sandbox/filesystem-type detection with no string delta (unrecoverable).

### OCC side

No filesystem-type permission surface in OCC (Windows sandbox write-refusal machinery absent); the only related code is WSL mount detection (`src/utils/sandbox/wslMounts.ts:55-71`). Nothing to port.

---

## #27 — startup time with many plugins: far fewer fs calls to load command/agent files

> Improved startup time with many plugins enabled: plugin command and agent files now take far fewer file system calls to load, most of all on Windows

**Disposition: STAGED (pure fs-call refactor — no recoverable string delta; OCC already Dirent+memoized)**

### Binary evidence

- Candidate `Io`/`$o` enumeration (sync `readdir` withFileTypes + per-entry stat filter, new_strings line3384) turned out to belong to the **NEW v302 plugin dev-mods hot-reload watcher** (`plugin_dev_mods` chunk @260869605), not startup loading — misattribution.
- `throwIfNoEntry:!1})?.isFile()` count 1/1 in both versions; no plugin-loader marker strings changed. The optimization is a pure call-count refactor (batched stats / cached dirents) invisible to string forensics.

### OCC side

Already close to the official target shape:

- Loaders memoized (`src/utils/plugins/pluginLoader.ts:3334/:3375`).
- Walker uses readdir Dirents (`walkPluginMarkdown.ts:21`).
- Per-file cost = 1 realpath (`fsOperations.ts:190/:166` `isDuplicatePath`/`safeResolvePath`) + 1 readFile (`loadPluginCommands.ts:140-143`, `loadPluginAgents.ts:55/:84/:88`); extra stat only for custom manifest paths (`loadPluginCommands.ts:535`, `loadPluginAgents.ts:319`).

No evidence of an OCC-specific gap; porting "fewer fs calls" without the official mechanism would be invention.

### Implementation note

None (STOP per aligning-with-official-binary — mechanism unrecoverable). If OCC startup profiling ever shows plugin loading as a hotspot, the natural local wins are: skip the per-file `isDuplicatePath` realpath when the walk root is already canonical, and batch the manifest stat — as OCC-original optimizations, labeled as such.

---

## #30 — `claude -p`/SDK with no permission mode → `default` on 3P providers / telemetry off / fresh install

> Changed `claude -p` and Agent SDK sessions with no permission mode to start in `default` mode on third-party providers, with telemetry off or on a fresh install; `--permission-mode auto` keeps auto

**Disposition: ALREADY-ALIGNED (OCC's -p/SDK already always starts in `default`; `--permission-mode auto` honored)**

### Binary evidence (partially recovered)

- Permission constants v302 @234246733: `var eL=["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`; `Bh(e)` maps `"manual"→"default"`; error text `Cannot set permission mode: must be one of ...`.
- `defaultMode` count 120→121 (+1) but probe-diff of all JS-region hits is rename-noise — the single new occurrence is not isolable; `disableTelemetry` 3/3, `autoModeDefault` 4/4 (all four = the unrelated `claude auto-mode` CLI subcommands), `firstParty` 373/373, `permissionMode:"auto"` 0/0. The exact v302 gate function was **not recovered byte-wise** — per skill discipline, nothing is invented here.
- Adjacent recovered context (both versions): auto-mode availability `Mfe()` — firstParty → `fy()`; third-party providers → classifier-availability checks; interactive auto-default nudge writes `permissions:{defaultMode:"auto"}` on accept (`tengu_auto_default_nudge_resolved`, NEW-context window @5922458 in new_strings but the nudge exists in OCC already).

### OCC side

- Resolution order: `src/main.tsx:1082-1093` (`--permission-mode` flag) → :1707-1713 `initialPermissionModeFromCLI` → `src/utils/permissions/permissionSetup.ts:803-925`; **no explicit mode ⇒ `{mode:'default'}` (:911-913)** on every surface including `-p` (:3050-3051, :3091, ~:3100, :3318).
- SDK: `initialize` carries no permissionMode (`controlSchemas.ts:58-75`); `PermissionModeSchema` (`coreSchemas.ts:341-352`) doesn't even include `'auto'` for the SDK-set path; `EXTERNAL_PERMISSION_MODES` (`src/types/permissions.ts:15-25`) includes `'auto'` for the CLI flag → `--permission-mode auto` keeps auto ✓.
- 3P gate exists (`src/utils/betas.ts:212-243` `modelSupportsAutoMode`, :221-226 provider gate); `AUTO_MODE_ENABLED_DEFAULT='opt-in'` (`permissionSetup.ts:1562-1576`); auto-default nudge interactive-only (`autoDefaultNudge.ts:70-93`).
- Net: OCC never auto-starts a no-mode `-p`/SDK session in `auto` on ANY provider — a strict subset of official v302 behavior (official presumably still defaults to auto for first-party + telemetry-on + non-fresh installs; OCC doesn't). The three changelog conditions (3P / telemetry off / fresh install) all land on `default` in OCC already.

### Implementation note

None. If OCC later adopts an auto-by-default rollout for interactive sessions, replicate the v302 restriction set (first-party provider AND telemetry on AND not a fresh install) before letting `-p`/SDK start in auto — and note the official byte-level gate was not recovered, so a future round should re-attempt extraction around the +1 `defaultMode` occurrence.

---

## #31 — fork subagents on by default in `-p`/SDK/desktop/VSCode; `CLAUDE_CODE_FORK_SUBAGENT=0` off; `mcp serve` never

> Changed fork subagents (`subagent_type: "fork"`) to be on by default in `claude -p`, the Agent SDK, the desktop app and VS Code, as they already are in the terminal; `CLAUDE_CODE_FORK_SUBAGENT=0` turns them off, and `claude mcp serve` never offers them

**Disposition: PORT (M)**

### Binary evidence (COMPLETE — v302 @245269184 vs v301 @227913157)

```js
// v301:
var Edr="tengu_fork_subagent_enabled";
function Rdr(){if(a.CLAUDE_CODE_FORK_SUBAGENT===!0)return"env";if(we())return"disabled";return"default"}
function Cdr(){let e=Ao();if(_Ue())return"disabled";if(a.CLAUDE_CODE_FORK_SUBAGENT===!1)return"disabled";
  if(e.forkSubagentEnabledSource!==void 0)return e.forkSubagentEnabledSource;let n=Rdr();...}
function zoe(){return Cdr()!=="disabled"}

// v302:
var Xcr="tengu_fork_subagent_enabled",Qcr="tengu_federated_ullman";
function qcn(){let e=Ro();
  if(Q3e())return"disabled";                                        // coordinator / mcp-serve
  if(Hf().forkSubagentDisabled)return"disabled";                    // NEW: config kill flag
  if(a.CLAUDE_CODE_FORK_SUBAGENT===!1)return"disabled";             // env=0 → off
  if(e.forkSubagentEnabledSource!==void 0)return e.forkSubagentEnabledSource;
  if(a.CLAUDE_CODE_FORK_SUBAGENT!==!0&&we()&&ir(Qcr,!1))return"disabled";  // NEW: remote kill-switch (default OFF ⇒ enabled)
  let n=a.CLAUDE_CODE_FORK_SUBAGENT===!0?"env":"default";           // non-interactive now DEFAULTS ON
  return e.forkSubagentEnabledSource=n,i(Xcr,{source:c(n)}),n}
function mse(){return qcn()!=="disabled"}
function vat(){if(!mse())return!1;return qcn()==="env"||!uL()}
```

Helpers: `we()` @233897829 = `!host.launchOptions.isInteractive()`; `uL(e=we())` @234237689 = non-interactive surface excluding vscode-child (`vy()` = `entrypoint==="claude-vscode"&&!childSession&&!claudecode`). Fork agent definition identical in both versions (`subagent_type:"fork"`, `tools:["*"]`, `maxTurns:200`, `model:"inherit"`, `permissionMode:"bubble"`, never the default agent).

Net semantics: the v301 `if(we())return"disabled"` (non-interactive ⇒ off) is replaced by a remote-kill-switch-gated ON; `CLAUDE_CODE_FORK_SUBAGENT=0` and new config `forkSubagentDisabled` turn it off; coordinator/`mcp serve` (`Q3e`) never offer it.

### OCC side

- `src/tools/AgentTool/forkSubagent.ts:40-47` `isForkSubagentEnabled` = (env `CLAUDE_CODE_FORK_SUBAGENT` truthy OR `feature('FORK_SUBAGENT')`) AND not coordinator AND **not `getIsNonInteractiveSession()`** (:43) — the exact v301 shape (`we()` ⇒ disabled).
- `FORK_SUBAGENT` is NOT in `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts:13-64`) → in live builds fork is reachable only via the env var, and the non-interactive exclusion blocks `-p`/SDK entirely.
- Routing: `AgentTool.tsx:360-378` (fork-in-fork guard :371-374; explicit-fork-off error :398-405); `prompt.ts:100-115,236-240`; commands: `src/commands.ts:129-134` forkCmd; `branch/index.ts:8`; `fork/index.ts:10-21`; `src/entrypoints/mcp.ts:50` MCP_COMMANDS=[review] (mcp serve never offers fork ✓ already).

### Implementation note

1. In `forkSubagent.ts`: remove the blanket `getIsNonInteractiveSession()` exclusion; mirror the official precedence — coordinator/mcp-serve disabled → config `forkSubagentDisabled` (add to OCC config schema) → env `CLAUDE_CODE_FORK_SUBAGENT=0` disabled → env `=1` "env" → else "default" (enabled). OCC has no GrowthBook, so the `tengu_federated_ullman` kill-switch maps to nothing — document that divergence (default = kill-switch OFF = enabled).
2. Gate the flip behind the existing env/feature surface: since `FORK_SUBAGENT` is off in the allowlist, decide whether default-on for non-interactive should also require the feature flag (recommend: keep parity with terminal behavior — env var remains the live switch; add the flag check unchanged).
3. mcp serve: no change (already never offers).
4. Tests: `-p` with `CLAUDE_CODE_FORK_SUBAGENT=1` offers fork; `=0` refuses with the existing off-error; unset in `-p` → offered (post-port default); `occ mcp serve` never lists fork.

---

## #32 — desktop/VSCode always background main-convo subagents; nested Agent calls foreground by default in -p/SDK/desktop/VSCode

> Changed the desktop app and VS Code to always run the main conversation's subagents in the background, as the terminal does, rather than let Claude choose; a subagent's own Agent calls in `claude -p`, the Agent SDK, the desktop app and VS Code now run in the foreground by default

**Disposition: PORT (coupled with #31 — same gate swap; S once #31 lands)**

### Binary evidence

- Telemetry describe v301 @218679433: `"(background tasks disabled, or the fork gate on)"` → v302 @236155475: `"(background tasks disabled, or subagents forced into the background: in a terminal, the desktop app or the VS Code extension, or with CLAUDE_CODE_FORK_SUBAGENT=1)"` ("forced into the background" 0→2 NEW).
- AgentTool schema builder v301 @233498224: `e=lmt()||zoe(), h=e?n.omit({run_in_background:!0}):...` → v302 @251052579: `e=lgt()||vat(), h=e?n.omit({run_in_background:!0}):...`.
- `lgt` @240718896 (v302) ≡ `lmt` @223452954 (v301) — background-tasks-disabled check (`backgroundTasksDisabled&&backgroundLaunchRule===void 0||backgroundAgentLaunchDisabled||CLAUDE_CODE_DISABLE_BACKGROUND_TASKS||wr()`), unchanged.
- So the whole #32 behavior = replacing the fork-enabled predicate `zoe()` with the surface-aware `vat()` = `forkGateOn && (env==="…1" || !(non-interactive && !vscode-child))`: terminal/desktop/VSCode (and env=1 anywhere) ⇒ `run_in_background` omitted ⇒ main-convo subagents always background; plain `-p`/SDK with default-on fork ⇒ param offered, model may still choose, nested calls default foreground.
- Async decision `In/Sn` (`run_in_background===!0||forced&&run_in_background!==!1`) byte-identical between versions.

### OCC side

- `src/tools/AgentTool/AgentTool.tsx:606-620` `shouldRunAsync=(run_in_background===true||selectedAgent.background===true||isCoordinator||forceAsync||assistantForceAsync||proactive)&&!isBackgroundTasksDisabled` with `forceAsync=isForkSubagentEnabled()` (:610) — v301 shape (gate = fork-enabled, no surface awareness).
- Schema omit `AgentTool.tsx:135-137` when background disabled or fork on — v301 shape.
- No desktop/VSCode surfaces in OCC; `-p`/SDK covered. Nested calls: foreground + 120 s auto-background (`getAutoBackgroundMs()=120_000`, :76-84).

### Implementation note

1. Land with #31: introduce OCC's `vat()` analogue — `isForkSubagentEnabled() && (envSource==="env" || !isNonInteractiveSurface())` where `isNonInteractiveSurface()` = `getIsNonInteractiveSession()` minus VSCode-child (OCC has no vscode entrypoint, so in practice: `-p`/SDK with default-on fork ⇒ param stays offered; env=1 ⇒ forced background).
2. Swap the schema-omit predicate (`AgentTool.tsx:135-137`) and `forceAsync` (:610) to the new function.
3. Update any telemetry/describe text mirroring the official wording above.
4. Tests: `-p` default (post-#31): Agent schema includes `run_in_background`, subagent runs foreground; `CLAUDE_CODE_FORK_SUBAGENT=1 -p`: param omitted, forced background.

---

## #35 — at most 12 prompt/agent hooks of one event run at a time

> Changed prompt and agent hooks so that at most 12 of one event run at a time; the rest wait their turn

**Disposition: PORT (S)**

### Binary evidence (COMPLETE, NEW in v302 @246248866; zero numeric-12 hits in v301 hook regions)

```js
var ant=12;
function Iee(e){return e.type==="prompt"||e.type==="agent"}
function ZRn(e,n){let r=e.filter((h,y)=>n(y));
  if(r.length<=1)return oJt(e);                       // oJt = generator-merge(gens, cap)
  let s=Promise.resolve();
  return oJt([...e.filter((h,y)=>!n(y)),              // non-prompt/agent hooks: uncapped merge
    oJt(r.map(async function*(h){s=s.then(Yg),await s,yield*h}),ant)])}  // capped at 12, staggered starts
var eCn="hook-dispatch-hold",s4r=60000,tCn=1200000,ON=()=>{},
i4r=new Set(["MessageDisplay","SessionEnd","PermissionRequest","Notification"]);
function lnt(e,n,r){ /* keepalive hold */ ...
  let H=0;for(let{hook:V}of n){...if(Iee(V))H++}
  let K=Math.max(1,Math.ceil(H/ant));                 // waves
  s=Math.min(w*K+s4r,tCn)}                            // wave timeout + 60s, capped 20 min
```

Call site @246372863: `let Lr=ZRn(Mo,(Eo)=>Iee(Kn[Eo].hook)),Fr=lnt(tt,Kn,S);for await(let Eo of Fr===ON?Lr:nCn(Lr,Fr)){...}`.

Semantics: within one hook-event dispatch, hooks of type `prompt`/`agent` merge through a concurrency-capped merge (cap **12**) with a shared promise chain staggering starts; all other hook types merge uncapped as before. The keepalive "hook-dispatch-hold" budget scales with wave count: `ceil(count/12)` × per-hook timeout + 60 s, hard cap 1 200 000 ms.

### OCC side

- Hooks engine is async-generator based; merge helper already supports a cap: `all(generators, concurrencyCap=Infinity)` in `src/utils/generators.ts:31-57`.
- Dispatch site: `src/utils/hooks.ts:4560` merges all matched hook generators with **no cap** and no type-based split.
- Hook types `prompt`/`agent` exist in OCC's hook config surface.

### Implementation note

1. At the dispatch merge (`hooks.ts:4560`), partition matched hooks by `type==="prompt"||type==="agent"`; if ≤1 such hook keep current behavior; else merge non-prompt/agent uncapped and prompt/agent through `all(..., 12)` with the staggered-start chain (port `ZRn` shape), then merge the two streams (official nests the capped merge inside the outer merge).
2. If OCC has a keepalive/hold analogue for long hook dispatches, scale its budget by `ceil(promptAgentCount/12)*hookTimeout + 60_000`, capped at `1_200_000` (constants `60000`/`1200000` verbatim).
3. Tests: 13 prompt hooks on one event — assert at most 12 concurrent executions (timestamped fake hooks), 13th starts after one finishes; mixed types — non-prompt/agent hooks not throttled.

---

## Summary table

| # | Entry | Disposition | Complexity | Landing point |
|---|-------|-------------|-----------|---------------|
| 06 | Read image any-size / pipe-device → 128 MB refusal | **PORT** (security) | M | `FileReadTool.ts:1326` image branch + `fsOperations.ts:918` `readFileBytes` cap |
| 09 | plugin subcommand exits before queued write drains | ALREADY-ALIGNED | — | OCC writes are synchronous; no queue to drain |
| 10 | marketplace re-clone + version "unknown" under reftable | **PORT** (version half) / STAGED (marketplace half) | S | `gitFilesystem.ts:600/:221` reftable fallback via `show-ref` |
| 11 | pwsh plugin bin/ PATH; Select-Object empty-search error | STAGED | — | prerequisite plugin-bin-PATH feature absent in OCC |
| 18 | MCP 2026-07-28 resultType/ttlMs/cacheScope backfill | N-A (advisory) | — | SDK 1.29.0 never negotiates 2026-07-28; port on SDK upgrade |
| 21 | plugin details @builtin message → /plugin | N-A | — | no `plugin details` subcommand in OCC |
| 23 | worktree refusal, stray gitfile under git ≥2.56 | **PORT** | S | `worktreeBaseResolve.ts:136` add gitfile regex to no-repo class |
| 25 | runner "bad object refs/heads" reftable sanitize | N-A | — | self-hosted runner is a dead stub |
| 26 | Windows exFAT/FAT32 writes refused | N-A | — | no fs-type permission surface; 0/0 string hits |
| 27 | startup fs-call reduction for plugin cmd/agent files | STAGED | — | mechanism unrecoverable; OCC already Dirent+memoized |
| 30 | -p/SDK no-mode → default on 3P/telemetry-off/fresh | ALREADY-ALIGNED | — | OCC always defaults `default` in -p/SDK; auto honored via flag |
| 31 | fork subagents default-on in -p/SDK/desktop/VSCode | **PORT** | M | `forkSubagent.ts:40-47` gate flip + `forkSubagentDisabled` config |
| 32 | forced-background subagents per surface | **PORT** (coupled #31) | S | `AgentTool.tsx:135-137/:610` predicate swap to `vat()` analogue |
| 35 | ≤12 concurrent prompt/agent hooks per event | **PORT** | S | `hooks.ts:4560` capped merge via `generators.ts:31` `all(...,12)` |

PORT set for the implementation round: **#06 (security, first), #23, #35, #31+#32 (as one change), #10-version-half**.
