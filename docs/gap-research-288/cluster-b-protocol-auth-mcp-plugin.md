# OCC-106 Cluster B — Protocol / Auth / MCP / Plugin-install / Updater (2.1.287 → 2.1.288)

Research-only byte forensics. Binaries: `/tmp/cc-diff-288/v287/package/claude` and
`/tmp/cc-diff-288/v288/package/claude`, linux-x64 Bun ELF. **Never executed** — `grep -aob`/`-aoc`
for offsets+counts, `dd bs=1` for windows, python3 line-scan over `new288.txt`/`del288.txt`.
JS code region = offset > 150,000,000; string tables below.

**HONESTY NOTE.** Novelty is proven by *message/reason strings* and call-site neighbourhoods,
never by minified identifiers. Minified names are reused across chunks and renamed between
builds: e.g. the credential-source resolver is `$k` in v287 and `Qk` in v288 with a byte-identical
body — a naive "new context" hit on the rename is a false positive (this trap fired on #60 below
and was rejected). Where no novel string exists, the entry is STAGED, not invented.

| # | Changelog item (abridged) | Verdict | OCC |
|---|---------------------------|---------|-----|
| 4  | MCP step-up re-auth prompt when server asks more OAuth scope mid-tool-call | NO-OP{ALREADY-ALIGNED} | ALIGNED |
| 35 | `/login` said "Login successful" when credential save failed | **PORT-CANDIDATE** | **AFFECTED** |
| 60 | `/login` in `--bare` ran a sign-in the session never reads | STAGED | AFFECTED (delta unrecovered) |
| 24 | `git-subdir` install fails / caches incomplete plugin on git < 2.39 | **PORT-CANDIDATE** | **AFFECTED** |
| 44 | `plugin install` GitHub clone falls back to HTTPS with no SSH key | **PORT-CANDIDATE** | **AFFECTED** (detection hardening) |
| 52 | `owner/repo` marketplace showed only 2nd error when SSH+HTTPS both fail | **PORT-CANDIDATE** | **AFFECTED** |
| 41 | MCP tool ran twice when result > 16 MB or unparseable | NO-OP{ALREADY-ALIGNED} | IMMUNE |
| 80 | MCP URL prompt waits for "I'm done, continue" | **PORT-CANDIDATE** | **AFFECTED** |
| 69 | Cloud first turn no longer waits for stdio MCP `alwaysLoad:false` | **PORT-CANDIDATE** | **AFFECTED** |
| 50 | npm auto-updater reported success when only placeholder stub installed | **PORT-CANDIDATE** | **AFFECTED** (scoped) |
| 22 | Plugin LSP got literal `${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` in initializationOptions/settings | **PORT-CANDIDATE** | **AFFECTED** |
| 25 | `--plugin-dir` plugins missing "Configure options" in `/plugin` | NO-OP{ALREADY-ALIGNED} | ALIGNED |
| 26 | Background session ended when plugin reloaded/disabled mid timer/read | STAGED | AFFECTED (delta unrecovered) |
| 38 | Agent teams: plugin agent spawned by name ran with defaults | **PORT-CANDIDATE** | **AFFECTED** |
| 89 | `claude plugin test` reported mods off from stale saved setting | NO-OP{NO-SURFACE} | NOT-AFFECTED |

PORT-CANDIDATEs: **#35, #24, #44, #52, #80, #69, #50, #22, #38** (9). Security-ranked list at the end.

---

## Item 4 — MCP step-up re-auth prompt (more OAuth scope during a tool call)

**Verdict: NO-OP{ALREADY-ALIGNED}.**

The step-up re-auth surface is struct-equal v287↔v288. Marker counts:
`re-authenticate` 41→41, `step-up` 16→16, `stepUp` 31→31, `reauthenticate` 10→10,
`insufficient_scope` 23→25 (+2, no new user-facing prompt string), `more OAuth scope` 0→0,
`additional scope` 0→0. No novel message string ⇒ the feature was dark-shipped in v287 and only
*documented* in the v288 changelog.

OCC already implements it: `src/services/mcp/auth.ts:1664-1684` marks step-up pending on a 403
`insufficient_scope`; `:2191-2227` persists the widened scope; `src/services/mcp/client.ts:3945-3959`
maps a 401 during `callMCPTool` to `McpAuthError` (which drives the re-auth prompt). Nothing to port.

---

## Item 35 — `/login` reported "Login successful" when credentials could not be saved

**Verdict: PORT-CANDIDATE (auth-correctness).**

Novelty: `credentials could not` 0→8 (NEW). v288 @223558737 (official):

```js
…transient ? "Claude Code login needs attention: credentials may not have been saved"
            : "Claude Code login needs attention: credentials could not be saved",
   notificationType:"auth_storage_failure" }, F, {storageV5:O, credentials:oe})
} else W({state:"success"}), o?.(),
   DM({message:"Claude Code login successful", notificationType:"auth_success"}, F, …)
```

The success toast is now the *else* branch: when the credential write fails, an
`auth_storage_failure` notification is raised (transient vs permanent wording) and success is NOT
claimed. The changelog also adds a retry when the new login didn't take effect.

OCC state: `src/components/ConsoleOAuthFlow.tsx:589` renders "Login successful" **unconditionally**
after `installOAuthTokens` (`:236`); `src/cli/handlers/auth.ts:294` also emits `"Login successful.\n"`,
and `:124-141` throws on a transient save failure but the success path is not gated on the write
actually landing. So OCC can print success while the credential was not persisted.

**Port:** gate the success message/notification on the save result; on failure surface
`auth_storage_failure` (transient ⇒ "may not have been saved"; permanent ⇒ "could not be saved")
and offer a retry. Touch points: `ConsoleOAuthFlow.tsx:589` + `installOAuthTokens:236`,
`cli/handlers/auth.ts:294` (and the `saveOAuthTokensIfNeeded` result in `utils/auth.ts:1443-1532`).

---

## Item 60 — `/login` in a `--bare` session ran a sign-in the session never reads

**Verdict: STAGED (real surface, delta NOT recoverable byte-level).**

The bare credential-source resolver is **identical** v287↔v288 (only the minified name changed):
`return"bare"` 6→6, `CLAUDE_CODE_OAUTH_TOKEN)return"bare"` 1→1, `"backend":"store"` 1→1.

```js
// v287 $k @201658612  ==  v288 Qk @202473225  (byte-identical body)
function $k(e,n){ if(!(F()&&e!==void 0)||s8()||a.CLAUDE_CODE_OAUTH_TOKEN) return "bare";
  if(eM()&&(!OV()||Xl())) return "bare"; return n!==void 0 ? "backend" : "store" }
```

The 3 net-new `bare` hits in v288 are unrelated (`bareElicitationCapability` MCP schema,
`H3r({bare})` plugin host, `bareAssignmentNames` bash parser). No `/login`-specific novel string
(`which credentials work` 0→0, `session never reads` 0→0, `saved login` 1→1). The fix is a pure
logic gate inside the `/login` handler with no new message ⇒ unrecoverable by string novelty.

OCC surface exists and matches the bug shape: `utils/envUtils.ts:60-65` `isBareMode()`; the
`isBareMode` gates in `utils/auth.ts` (`:110,165,243,366,1300,1536,1816`) are **read-side only** —
they gate which credentials the session reads, not whether `/login` runs an interactive sign-in
whose result a bare session would never read (and which could overwrite the saved login). Porting
requires the official `/login`-handler gate, which was not recovered. Left STAGED.

---

## Item 24 — `git-subdir` install fails / caches incomplete plugin on git < 2.39

**Verdict: PORT-CANDIDATE.**

Novelty: `plugin git-subdir read-tree` 0→2 (NEW), `read-tree after sparse-checkout` 2→3.
v288 @210993448 / @210994570 (official) — after the cone sparse-checkout it now materialises the
working tree with an explicit `read-tree -u --reset`:

```js
…subdir clone failed (stderr redacted)");
try{ let Ce=wRn(V), xe=[...ye,"read-tree","-u","--reset"],
     Ae=await e8e(B,[...ye,"sparse-checkout","set","--cone","--",r],Ce);
     if(Ae.code!==0) throw at(Error(`git s…
…
if(Ye.code!==0) throw at(Error(`git read-tree after sparse-checkout failed: ${S6(Ye.stderr,w)}`),
   "plugin git-subdir read-tree (post sparse-checkout) failed (stderr redacted)");
if(Ze.code===0) Pe=Ze.stdout.trim()
```

On git < 2.39 `sparse-checkout set --cone` alone does not reliably check out the cone (the
`checkout`/`read-tree` semantics changed at 2.39), so the subdir stayed empty → install failed or
an incomplete plugin was cached. The added `read-tree -u --reset` forces the tree to materialise.

OCC state: `src/utils/plugins/pluginLoader.ts:735-873` `installFromGitSubdir` does
`clone --filter=tree:0 --no-checkout` then `sparse-checkout set --cone` (`:778-787`) but **no
`read-tree`/`checkout`** afterwards — same bug on git < 2.39 (e.g. Ubuntu 22.04's 2.34).

**Port:** after `sparse-checkout set --cone`, run `git read-tree -u --reset` (guard/fallback for
old git) and verify the subdir is populated before caching. Touch point:
`pluginLoader.ts:778-873`.

---

## Item 44 — `plugin install` GitHub clone falls back to HTTPS with no SSH key

**Verdict: PORT-CANDIDATE (detection hardening; base fallback already in OCC).**

The base SSH→HTTPS fallback + notice pre-exist in v287 (`SSH not configured, cloning via HTTPS`
2→2, `HTTPS clone failed, retrying with SSH` 2→2). The **v288 delta hardens the "is GitHub SSH
configured" probe**. Novelty: `staying on SSH` 0→3, `GitHub SSH URL is rewritten` 0→2.
v288 @~207590400 (official `drt`):

```js
function CQ(e){return `SSH not configured, cloning via HTTPS: ${e}`}
function lrt(e){return `HTTPS clone failed, retrying with SSH: ${e}`}
async function drt(e,n,r){
  if(O()==="windows") return !1;
  … if(GIT_SSH_COMMAND||GIT_SSH set) return !1;
  let S=await Xe(Tt(),["ls-remote","--get-url","--",n],{…timeout:5000});
  if(S.code!==0||S.stdout.trim()!==n)
    return t(`GitHub SSH URL is rewritten by git config, or git could not say (code=${S.code}): staying on SSH`),!1;
  if(await e.probeSsh()!=="not-configured") return !1;          // ssh -T probe
  if(await Hl("ssh")===null) return !0;                          // no ssh binary → HTTPS
  let w=await Xe("ssh",["-G","git@github.com"],{…timeout:5000}), B=w.stdout.split(" ")…;
  if(w.code===0&&B.includes("hostname github.com")&&!B.some((H)=>/^proxy(command|jump)(?! none$)/.test(H)))
    return !0;
  return t(`ssh -G does not show git@github.com going straight to github.com (code=${w.code}): staying on SSH`),!1;
}
```

So v288 adds (a) a `ls-remote --get-url` check that git isn't *rewriting* the SSH URL, and
(b) an `ssh -G git@github.com` parse rejecting a `proxycommand`/`proxyjump` — avoiding a wrong
HTTPS fallback (or wrong SSH stay) when SSH is present but indirect.

OCC state: `src/utils/plugins/marketplaceManager.ts:827-857` `isGitHubSshLikelyConfigured` uses
only `ssh -T` (no `ls-remote --get-url`, no `ssh -G` proxy check); the SSH→HTTPS fallback itself
exists at `:1782-1901`. `src/utils/plugins/gitTransport.ts:89-91` allowlists https/ssh.

**Port:** extend `isGitHubSshLikelyConfigured` with the `ls-remote --get-url` rewrite check and the
`ssh -G` hostname/proxycommand/proxyjump parse before deciding to fall back. Touch point:
`marketplaceManager.ts:827-857`.

---

## Item 52 — `owner/repo` marketplace showed only the second attempt's error

**Verdict: PORT-CANDIDATE.**

Novelty: `both attempts` 0→1 (NEW). v288 @210734308 (official) combines both transport errors,
first-tried transport on top:

```js
…if(…message!==n.error.message)
  n.error.message = `Fetching the marketplace from GitHub failed on both attempts. `+
    `${e.transport} (${e.url}): ${e.error.message}\n\n`+
    `${n.transport} (${n.url}): ${n.error.message}`;
return n.error
```

OCC state: `marketplaceManager.ts:1831-1837` and `:1893-1905` throw the **last error only** when
both SSH and HTTPS attempts fail; the dual-transport refresh path is `:2898-2934`. So a user sees
only the second transport's message, hiding the first (e.g. the SSH auth failure).

**Port:** when both transports fail, build a combined message
`Fetching the marketplace from GitHub failed on both attempts. <t1> (<url1>): <err1>\n\n<t2> (<url2>): <err2>`
with the first-tried transport first. Touch points: `marketplaceManager.ts:1831-1837`,
`:1893-1905` (and the refresh path `:2898-2934`).

---

## Item 41 — MCP tool ran twice when result > 16 MB or unparseable

**Verdict: NO-OP{ALREADY-ALIGNED} (OCC structurally immune).**

No novel marker recovered (`ran twice` 0→0, `over 16`/`16 MB` 0→0, `could not be parsed` 39→43 is
generic, `MAX_MCP` 10→10). The official fix stops a retry that re-invoked the tool after an
oversize/unparseable result.

OCC cannot double-run: `src/services/mcp/client.ts:782` `MAX_MCP_RESPONSE_BYTES = 16*1024*1024`;
`capMcpResponseBody` **throws** at `:786-808` when the body exceeds the cap; `transformMCPResult`
**throws** at `:3364-3369` on an unparseable result. Both propagate as a terminal error — there is
no retry-after-oversize path, and session retry (`MAX_SESSION_RETRIES=1`, `:2480-2488`) is not
triggered by these throws. Nothing to port.

---

## Item 80 — MCP URL prompt waits for "I'm done, continue"

**Verdict: PORT-CANDIDATE (UX/correctness of elicitation flow).**

Novelty: `I'm done, continue` 0→2 (NEW). v288 @229244616 (official) — the elicitation accept
button label becomes an explicit continue affordance when the server can't report completion (`Pe`):

```js
…ta = bo && r(K,{children:[ e(n,{color:"success",children:Fo==="accept"?Z.pointer:" "}),
  e(n,{bold:Fo==="accept", …, children: Pe ? " I'm done, continue  " : " Accept  "}) ]}), …
```

For servers that cannot emit an `ElicitationCompleteNotification`, the prompt now blocks on the
user pressing "I'm done, continue" so they can finish the browser step first, instead of
auto-continuing the tool call.

OCC state: `src/services/mcp/elicitationHandler.ts` + `src/components/mcp/ElicitationDialog.tsx`
auto-continue on `ElicitationCompleteNotification` (`:1045-1112`) and otherwise wait on the modal
button. OCC has no "server can't report completion ⇒ explicit *I'm done, continue*" affordance.

**Port:** when the server lacks a completion-notification capability, render the accept button as
"I'm done, continue" and require the explicit press before resuming the tool call. Touch points:
`ElicitationDialog.tsx` (button label/gate), `elicitationHandler.ts` (capability branch).

---

## Item 69 — Cloud first turn no longer waits for stdio MCP `alwaysLoad:false`

**Verdict: PORT-CANDIDATE.**

Novelty: `MCP prewait` 0→2, `skipServerNames` 0→5, `requiredServerNames` 4→6. v288 @226009370
introduces a prewait skip-set function `$h` and threads `skipServerNames`/`firstTurnHold` through
the wait orchestrator `ga`:

```js
function $h({policyAllows:e, clients:r, requiredServerNames:n, messages:s}){
  let g = r.filter((M)=> M.type==="pending" && M.config.alwaysLoad===!1
                    && (M.config.type===void 0 || M.config.type==="stdio"));
  if(g.length===0 || !e() || VPe()!=="tst" || !Qh()) return qh;         // qh = empty set
  let S = uR(s, DJe()? r.map((M)=>fF(M.name)) : void 0);                // servers referenced in 1st-turn msgs
  if(S===void 0) return qh;
  let h = n();                                                          // required server segments
  return new Set(g.map((M)=>({name:M.name, segment:fF(M.name)}))
    .filter((M)=> !h.has(M.segment) && !S.has(M.segment))                // not required, not referenced
    .map((M)=>M.name));
}
```

On the first turn (`VPe()==="tst"`), pending **stdio** servers with `alwaysLoad:false` that are
neither required nor referenced by the opening messages are put in `skipServerNames`, so `ga`'s
`be`/`Ne` predicates (`be=(It)=>K(It)&&(!ge||It.config.alwaysLoad===!0||ye(It))`) do not block on
them. `MCP prewait: reading the conversation failed` is the guarded read.

OCC state: `src/services/mcp/client.ts:3043-3067` `waitForMcpConnectionBatch`
(`MCP_CONNECTION_TIMEOUT_MS=5000`) waits on the batch unconditionally; the `alwaysLoad` tool
deferral exists at `:2197-2268` but there is no first-turn skip-set for `alwaysLoad:false` stdio
servers, so a new cloud conversation's first turn still waits for them.

**Port:** add a prewait pass computing the skip-set (pending stdio + `alwaysLoad:false` + not
required + not referenced in the first-turn messages) and feed it to `waitForMcpConnectionBatch`
as `skipServerNames`. Touch point: `client.ts:3043-3067` (+ deferral logic `:2197-2268`).

---

## Item 50 — npm auto-updater reported success when only the placeholder stub installed

**Verdict: PORT-CANDIDATE (scoped: the post-install verification; the native-binary specifics are PLATFORM).**

Novelty: `platform-native` 0→4, `placeholder stub` 1→5, `native_package_missing` 0→3,
`still the placeholder stub` 0→2. v288 @~211722400 (official) re-probes the installed `claude`
after npm/bun exits 0 and refuses to claim success when only the stub landed:

```js
let se = await _e(e);                        // re-probe installed claude --version
switch(se.outcome){
  case "placeholder_stub": {
    let w = s==="npm" ? await Je("npm",["config","get","ignore-scripts"],{…timeout:1e4}) : null;
    if(w?.code===0 && w.stdout.trim()==="true"){
      t(`${s} exited 0 and the installed claude is the placeholder stub, but npm install scripts `+
        `are disabled on purpose; trusting the exit code`); break;         // deliberate → OK
    }
    return m("update_apply","update_apply_native_binary_missing"),
      t(`${s} exited 0 but the installed claude is still the placeholder stub: `+
        `the platform-native package was not installed`,{level:"error"}),
      {status:"install_failed", failureHint:"native_binary_missing"};
  }
  case "inconclusive": t(`${s} exited 0; the install-prefix --version probe was inconclusive, trusting the exit code`); break;
  case "landed": break;
}
return await Te((w)=>({...w, installMethod:"global"}), r), … {status:"success", probeDurationMs:se.durationMs}
```

Also the failure-classifier branch: `if(x==="native_package_missing") … failureHint:"native_binary_missing"`.

The **portable core** is: after the updater's install command exits 0, re-probe the installed
binary and only report success when the probe confirms the new version landed; treat
"still the stub" as `install_failed`. The `platform-native`/`native_package_missing` wording is
specific to the official platform-native binary and is PLATFORM (OCC ships no such binary —
`scripts/build.ts:83-84` `NATIVE_PACKAGE_URL=''`).

OCC state: `src/utils/localInstaller.ts:113-133` reports npm install success purely on exit code;
`:73-83` `writeIfMissing` writes a placeholder stub; `:144-151` `localInstallationExists` is
existence-only (a stub counts as installed). `src/utils/autoUpdater.ts:677-696` runs the global
npm update with **no post-install verification**; success is reported at
`src/components/AutoUpdater.tsx:145-166,202-204`. Contrast the native path
`src/utils/nativeInstaller/installer.ts:341-365,493-507` which *does* verify — but it is
inoperable in OCC (`NATIVE_PACKAGE_URL=''`).

**Port (scoped):** add a post-install `--version` re-probe to the npm/global update path and fail
(instead of reporting success) when the version did not advance; do not treat a bare placeholder
stub as a successful install. Touch points: `autoUpdater.ts:677-696`, `localInstaller.ts:113-151`.

---

## Item 22 — Plugin LSP received literal `${user_config.*}` / `${CLAUDE_PLUGIN_ROOT}` in initializationOptions/settings

**Verdict: PORT-CANDIDATE.**

Novelty: `initializationOptions` 4→9 (+5). v288 @207469709 (official) now substitutes placeholders
in `initializationOptions` and `settings` (via `NX`), not just command/args/env/workspaceFolder,
and warns on any left unexpanded:

```js
… H.env=K, H.workspaceFolder) H.workspaceFolder=w(H.workspaceFolder);
if(H.initializationOptions!==void 0) H.initializationOptions=NX(H.initializationOptions,B);
if(H.settings!==void 0)              H.settings            =NX(H.settings,B);
if(g.length>0){ let he=`Missing environment variables i…` … t(he,{level:"error"}) }
if(h.length>0) t(`Left unexpanded in plugin LSP initializationOptions/settings (not set): ${L(h).join(", ")}`);
return H
```

OCC state: `src/utils/plugins/lspPluginIntegration.ts:229-292`
`resolvePluginLspEnvironment` substitutes **only** `command`/`args`/`env`/`workspaceFolder` —
`initializationOptions` and `settings` are passed through raw. `src/services/lsp/LSPServerInstance.ts:174`
sends `initializationOptions` unmodified. So a plugin LSP server receives literal
`${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` strings in those two fields.

**Port:** run the same `${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` substitution (deep) over
`initializationOptions` and `settings`, apply manifest defaults for unset user_config keys, and
log the "Left unexpanded…" warning. Touch points: `lspPluginIntegration.ts:229-292`,
`LSPServerInstance.ts:174`.

---

## Item 25 — `--plugin-dir` plugins missing "Configure options" in `/plugin`

**Verdict: NO-OP{ALREADY-ALIGNED}.**

The official fix is a **code motion**. v287 gated the whole per-plugin action block (mark-for-update,
configure, configure-options, update, uninstall) behind `!re && !de` where `re = marketplace==="builtin"`
and `de = Ap(marketplace)` (true for `--plugin-dir`/inline marketplaces) — so inline plugins never
reached configure-options. v288 @~237323129 moved the configure-options push **out** of that block,
gating it only on `fe.plugin.manifest.userConfig && Object.keys(…).length>0`.

OCC state: `src/commands/plugin/ManagePlugins.tsx:1395-1405` renders configure-options nested in
`if(!isBuiltin_1)` (`:1330`), where `isBuiltin_1 = marketplace==='builtin'` (`:1319`) and
`marketplace = source.split('@')[1] || 'local'` (`:891`). A `--plugin-dir` plugin gets
`marketplace==='inline'`/`'local'` (≠ `'builtin'`), so it **already passes** `!isBuiltin_1` and
reaches configure-options. OCC's gate has no `Ap()`-equivalent exclusion, so the v287 bug never
existed here. (Minor separate divergence: OCC's block also nests update/uninstall under the same
`!isBuiltin_1` gate, whereas official keeps those inside `!re && !de` — out of scope for #25.)
Nothing to port.

---

## Item 26 — Background session ended when a plugin was reloaded/disabled mid timer/read

**Verdict: STAGED (real surface, delta NOT recoverable byte-level).**

No novel message string (`was reloaded or disabled` 0→0, `reloaded` 43→43, `still running` 139→135,
`backgroundSession` 8→8). The reload-hold / plugin-forwarding machinery that *looks* related is
**identical** in v287 and v288 and therefore is NOT the fix: `hold_on_cache_impact` 5→5,
`holdOnCacheImpact` 2→2, `tengu_reload_plugins_cache_impact` 2→2, `the install pass the reload
stopped waiting for` 2→2, `noteLateForwardedInstall` 3→3, `pluginForwardingAdmission` 4→4,
`flagWaitCapMs` 9→9, `onLateEnd` 3→3, `installTimeoutMs` 3→3. The `held`/cache-impact deferral
(the reload "is not applied if applying it would change the session's tool list while the prompt
cache depends on that list") already shipped in v287.

The actual v288 change is a lifecycle guard that keeps a background session alive across a
reload/disable while one of its timers/reads is in flight — a pure logic change with no new string
⇒ unrecoverable by novelty.

OCC surface exists: `src/services/plugins/pluginOperations.ts:722-737` `disablePluginOp` only
writes settings + `clearAllCaches()` with no coordination against in-flight background work.
Porting requires the official guard, which was not recovered. Left STAGED.

---

## Item 38 — Agent teams: plugin-defined agent spawned by name ran with defaults

**Verdict: PORT-CANDIDATE.**

Novelty: `agentDefinition&&!Ma` 0→1 (NEW), `customAgentType` 10→12, `agentDefinition` 161→167.
v288 @232028744 (official) — the in-process teammate spawn now resolves and forwards the agent's
real definition instead of running with defaults:

```js
… let u = e.agentDefinition && !Ma(e.agentDefinition) ? e.agentDefinition : void 0;   // Ma = is-placeholder/default
if(r) t(`[handleSpawnInProcess] agent_type=${r}, found=${!!u}`);
return K(w,f,{agentType:r, model:T, prompt:i, planModeRequired:A, cwd:oe()}, n.teammateColors,
  async({sanitizedName:C, teammateId:E, teammateColor:c}, S)=>{ … let R=await wyr(L,n); … })
```

and the spawn object carries it: `…taskId:R.taskId, prompt:i, description:…, model:T,
agentDefinition:u, teammateContext:R.teammateContext, …`. The custom-agent resolution path
(`customAgentType` +2) looks the definition up in `activeAgents` and computes its tools:

```js
if(i.customAgentType){
  let z=_.options.agentDefinitions.activeAgents.find((ce)=>ce.agentType===i.customAgentType && !Ma(ce)),
      se = z!==void 0 && (await qne([z], _.options.agentDefinitions.allowedAgentTypes, de(_), _)).length===0, Z;
  try{ Z = z && !se ? await gdt(z) : void 0 }catch(ce){…}
}
```

So a plugin-defined teammate spawned by name now runs with its own prompt/tools/disallowedTools/effort.

OCC state (documented gap): `src/tools/shared/spawnMultiAgent.ts:890-901` sets
`agentDefinition: undefined` for a plugin agent; `src/utils/swarm/inProcessRunner.ts:976-1002`
then defaults `tools:['*']` with the generic prompt (`:942-946`). The `subagent_type` path is fine —
`src/tools/AgentTool/runAgent.ts:664-976` honours effort/tools/disallowedTools/prompt — but
`src/tools/AgentTool/loadAgentsDir.ts:195-199` `isCustomAgent` **excludes** `source==='plugin'`,
so plugin agents fall through to the in-process default path.

**Port:** in the team/in-process spawn, resolve the plugin agent's definition by name from
`activeAgents` (rejecting a placeholder via an `Ma`-equivalent) and pass it through as
`agentDefinition` so `inProcessRunner` uses its prompt/tools/disallowedTools/effort instead of
`['*']`+default. Touch points: `spawnMultiAgent.ts:890-901`, `inProcessRunner.ts:942-1002`,
`loadAgentsDir.ts:195-199`.

---

## Item 89 — `claude plugin test` reported mods as turned off remotely from a stale saved setting

**Verdict: NO-OP{NO-SURFACE}.**

The fix is in the `claude plugin test` harness's reading of a saved mod-enablement setting (it
reported "turned off remotely" from an out-of-date cached value). OCC ships no `claude plugin test`
mod-testing surface, so there is nothing to port. NOT-AFFECTED.

---

## PORT-CANDIDATEs ranked by security importance

1. **#35 — `/login` false "Login successful" on credential-save failure** (auth integrity: user
   believes credentials are persisted when they are not; can silently leave a session unauth'd or
   on stale creds). Highest.
2. **#50 — npm updater false success on placeholder stub** (integrity of the self-update path:
   reports an update landed when the binary is a non-functional stub; scoped port — the
   native-binary wording is PLATFORM).
3. **#44 — GitHub SSH-configured detection hardening** (`ssh -G` proxycommand/proxyjump +
   `ls-remote --get-url` rewrite check; prevents a wrong transport choice that could send plugin
   clones down an unintended path).
4. **#52 — dual-transport marketplace error** (both SSH+HTTPS errors shown; the hidden first error
   is usually the auth failure — matters for diagnosing a credential/transport problem).
5. **#24 — git-subdir `read-tree` on git < 2.39** (prevents caching an incomplete/truncated plugin,
   i.e. running a plugin whose files silently didn't materialise).
6. **#38 — plugin agent spawned by name runs with its own tools/disallowedTools** (a plugin agent
   defaulting to `tools:['*']` is a privilege-scope regression — it can gain tools its definition
   disallowed). Security-relevant.
7. **#22 — plugin LSP placeholder substitution in initializationOptions/settings** (literal
   `${user_config.*}`/`${CLAUDE_PLUGIN_ROOT}` leaking to an LSP server can misconfigure it /
   leak unresolved config keys).
8. **#80 — MCP URL elicitation "I'm done, continue"** (correctness: prevents the tool call
   resuming before the user finished the browser auth/consent step).
9. **#69 — first-turn skip of stdio MCP `alwaysLoad:false`** (latency/UX; lowest security weight —
   it only *skips waiting*, and only for servers neither required nor referenced).

**STAGED (surface real, official delta unrecoverable by string novelty):** #60 (`/login` bare gate),
#26 (background-session reload/disable guard). Both need the upstream source or a functional repro
to port faithfully — do not guess.

**NO-OP:** #4 (dark-shipped in v287, OCC aligned), #41 (OCC structurally immune — throws, no
retry), #25 (OCC gate already admits `--plugin-dir` plugins to Configure options), #89 (no
`claude plugin test` mods surface in OCC).
