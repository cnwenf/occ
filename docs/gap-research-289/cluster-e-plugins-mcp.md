# Cluster E — Plugin CLI + Org-Managed MCP Security (official 2.1.289 → OCC gap research)

Research only — no `src/` changes made. Official binaries at `/tmp/cc-diff-289/v288/package/claude` and
`/tmp/cc-diff-289/v289/package/claude` were examined with `grep -aobF` / `dd` / python-seek ONLY (never executed).
Offsets below are byte offsets into those ELF files; code regions live at ~200M–237M (the ~92M–104M region is the
binary string table — second occurrences of literals are the code ones). Minified names differ per build
(kTt→JTt, iJ→kJ, WBt→IUt, mUt→sHt, Ku→Fp, …); all comparisons below are semantic.

## Verdict summary

| # | Changelog item | Verdict | One-line reason |
|---|----------------|---------|-----------------|
| 6a | Stale copy of local-folder-marketplace plugin in `plugin list`/`eval`/`update` | **STAGED** | OCC has the same stale-copy exposure (copies to versioned cache, list/update read recorded version) but lacks the official v288-era prerequisite (in-place serving of local-folder plugins); port prerequisite first, then the v289 delta |
| 6b | Hot reload for symlinked `--plugin-dir` | **NO-OP** | OCC has no `--plugin-dir` file watcher at all (surface absent) — but the official realpath+remap pattern must be baked in when hot reload is ever added |
| 7 | Installed mods not loading in first session after upgrade | **NO-OP** | OCC has no mods/hooks-modules system and no remote rollout gate on plugin hook loading — structurally immune |
| 10 | SECURITY: user plugin rewriting org-managed MCP sign-in tool descriptions | **NO-OP** | OCC has no `tool.describe` hook system (mods absent); McpAuthTool description is static — attack surface does not exist |
| 16 | `plugin validate` skipping co-located plugin when marketplace manifest present | **PORT** | OCC has the identical early-return bug in `validateManifest`'s directory branch |
| 22 | `plugin validate` failing an Anthropic marketplace's own plugin; clean `plugin.json` in `--json` | **PORT (fold into #16) / NO-OP for `--json` half** | (a) anthropic-kind relaxation must ride along with the #16 port; (b) OCC validate has no `--json` output, and its contents collector already filters clean files |

---

## Item #6 — stale local-folder plugin copy + symlinked `--plugin-dir` hot reload

Changelog: *"Fixed `plugin list`, `plugin eval` and `plugin update` showing a stale copy of a plugin installed
from a local folder marketplace, and hot reload for a symlinked `--plugin-dir`."*

Two independent fixes; both located byte-level.

### #6a — stale copy in list / eval / update (official fix)

The v289 marker identifier is **`readFromFolderAt`** — 0 occurrences in v288, 6 in v289
(v289 @99683008 string-table echo, @211348795 loader, @220530103+220530611+220530654 freshness module,
@236614987 CLI). Related new identifiers: `folderVersion` (v288=0, v289=2), `nCe`, `Tdr`.

**Piece 1 — shared predicate** `nCe` @v289:207894889 (chunk-wgfrtm7w), newly extracted+exported so the CLI can
reuse the loader's local-folder test:

```js
var nCe=(e,n)=>typeof e==="string"&&n!==void 0&&Fp(n);
// entry.source is a string path AND the marketplace record satisfies Fp (= "source is a local folder")
// v288 had the inline equivalent `r&&Ku(r)` inside the loader only (v288 @211041917, @211045637)
```

**Piece 2 — loader stamps the folder read** @v289:211348795 (plugin loader, after a plugin `Wo` is loaded):

```js
if(Wo&&nCe(nn.entry.source,In?.source)){
  Wo.readFromFolderAt=g;                       // when the live folder was read
  let{folderReadAt:hr}=dt();                   // global state map (new @v289:203695251)
  if(!n&&!hr.has(Wo.source))hr.set(Wo.source,g)
}
```

**Piece 3 — new resolver module `Tdr`** @v289:236598035 (own chunk, `export{Tdr}`): resolves a plugin id to its
LIVE source folder when its marketplace is a local folder:

```js
function d(e){return e!==void 0&&Fp(e)
  ?{kind:"unresolved",reason:"Its marketplace is a folder whose catalog could not be read, or lists it no more."}
  :{kind:"copy"}}
async function Tdr(e,o){
  let[r,l]=await Promise.all([Lv(e,o),Za(o)]),           // entry lookup + marketplace registry
      n=l[kn(e).marketplace??""]?.source;
  if(r===null)return d(n);
  let{source:t}=r.entry,c=nCe(t,n);
  if(typeof t!=="string"||!c)return{kind:"copy"};
  let i=Sh(r.marketplaceInstallLocation)===void 0?"workspace":"system",
      a=await SW(e,r.marketplaceInstallLocation,t,l,lS(),o,i);
  return a.kind==="ok"?{kind:"folder",path:a.entryPath}
                      :{kind:"unresolved",reason:fje(a,r.marketplaceInstallLocation,t).message}
}
```

**Piece 4 — CLI helpers** @v289:236614987 (plugin CLI chunk; absent from v288):

```js
var qe=(o,s)=>o===void 0?void 0:s?.manifest.version;               // folderVersion for --json
async function Xe(o,s,a){                                          // live folder path for one plugin
  if(s!==void 0)return s.readFromFolderAt===void 0?void 0:s.path;  // loaded in session: trust stamp
  let u=await Tdr(o,a);                                            // CLI context: resolve from registry
  return u.kind==="folder"?u.path:void 0
}
async function Ze(o,s,a){let u=await Promise.all(o.map(f=>Xe(f,s.get(f),a)));
                         return new Map(o.map((f,g)=>[f,u[g]]))}
function Qe(o,s,a){return(a===void 0?o:s?.manifest.version??o)||"unknown"}   // live version wins
```

**Piece 5 — `plugin list` consumes it** @v289:236623592 (`--json`) and @v289:236626473 (human):

```js
// --json: NEW fields (v288 has neither):
U.push({id:J,version:re.version||"unknown",...,readFromFolder:M.get(J),
        folderVersion:qe(M.get(J),te),...})
// human output:
z=M.get(U), X=Qe(ne.version,y.get(U),z)
O.push(`    Version: ${X}`)
if(z!==void 0)O.push(`    Read from: ${Sa(z)}`)   // NEW "Read from:" line
```

**Piece 6 — `plugin eval` prefers the live folder** — resolver `Oc`, v289 @236953707 vs v288 @236595700.
v288 walked straight to the recorded `installPath` (`w.filter(np) → iA(S.installPath,…)`); v289 inserts before it:

```js
let _=await Tdr(e,n);
if(_.kind==="folder")return{kind:"plugin",root:_.path,pluginId:e,vouchedRoots:Bpe(e,await Za(n),lS())};
if(_.kind==="unresolved")return{kind:"folder-unresolved",pluginId:e,reason:_.reason};
// + new user-facing error: `... cannot be evaluated where sessions load it: no session could load it now. ...`
```

**Piece 7 — freshness detection for `/reload-plugins`** — new module @v289:220530103 (v288: absent):

```js
var se=1e4, ae=2000, O=64;                                   // cap 10k entries, 2s deadline, batch 64
async function he(e,o,r){ /* depth-limited BFS stat scan: any file mtime/ctime > readAt-ε ? */ }
async function xe(e,o,r=N(Date.now())){ ... ??!0 }            // "folder changed since readAt" (fails open)
var ye=(e,o,r)=>o.reduce(async(n,i)=>{let m=await n,a=e.get(i.source);
  return i.readFromFolderAt!==void 0&&a!==void 0&&await xe(i.path,a,r)?m.concat(i):m},Promise.resolve([]));
// messages: "`src` re-read from its folder: `path`" / "Also re-read from N their folders: ..."
function Se(e){let{folderReadAt:o}=dt();for(let r of e)if(r.readFromFolderAt!==void 0)o.set(r.source,r.readFromFolderAt)}
```

Note: official v288 ALREADY served local-folder-marketplace plugins in place inside the session loader
(v288 @211041917: `let Fe=r&&Ku(r)` branch → `xJn(...)` → `Ce=ze.entryPath`; v288 @211045637:
`if(r&&Ku(r))Pe=bt,Fe=Qe;` skipping `copyPluginToVersionedCache`). The v289 delta is that the **CLI commands**
(list/eval/update) and `/reload-plugins` now also consult the live folder instead of the recorded copy.
Verified name-churn-only regions (no semantic change): plugin CLI update module (pu288/pu289 @236272637/236630558),
MCPB copy/extract cache (`copyPlugin`+`sourceMtimeMs` logic @205026810/205319044 — identical), marketplace
registry/clone region, plugin-directory catalog module, dev-mods watcher module (`Han/can` folder-identity fn identical).

### #6b — symlinked `--plugin-dir` hot reload (official fix)

Plugin-dir watch module @v288:208979000+32KB / @v289:209286000+32KB. v289 adds two helpers:

```js
import{realpath as bCo}from"fs/promises";
var dNe=(e)=>bCo(e).catch(()=>e);                                   // resolve symlinked root, fall back to as-given
import{join as TRo,relative as ERo,resolve as RRo}from"path";
var aNe=(e,n)=>(r)=>TRo(e,ERo(n,RRo(r)));                           // remap real paths back under the original root
```

Main watcher `WBt`(v288) → `IUt`(v289):

```js
// v288: function H(K){ ... ye=yS.watch(e,{... ignoreInitial:K===void 0, ignored:n});
//        ye.on("add",(be,Ee)=>{...r(be,Ee?.ctimeMs)}) ...        // watches root AS GIVEN, raw event paths
// v289: async function H(K){ let V=await dNe(e), he=aNe(e,V), ye=typeof n==="function", ...
//        Ee=bS.watch(V,{... ignored:ye?(xe,Ae)=>n(he(xe),Ae):n});
//        Ce.on("add",(xe,Ae)=>{...r(he(xe),Ae?.ctimeMs)}), Ce.on("change",(xe,Ae)=>r(he(xe),Ae?.ctimeMs)),
//        Ce.on("unlink",(xe)=>r(he(xe))) ...                      // watches realpath'd root, remaps ALL event paths
```

Second (dev) watcher `mUt`(v288) → `sHt`(v289): same pattern — `dNe(e).then(s=>{let g=aNe(e,s);
h=bS.watch(s,{...,ignored:(w)=>!rJt(g(w),e),usePolling:!0,...})})`; `close()` became promise-based
(`{close:async()=>(await r).close()}`). Chokidar options unchanged (`persistent:!0,ignoreInitial:!0,
followSymlinks:!1,usePolling:!0`) — with `followSymlinks:!1`, watching the symlink root directly never sees
changes under it; hence realpath-first + coordinate remap.

### OCC surface

- `--plugin-dir` exists (`src/main.tsx:1137`, inline session-only plugins via `setInlinePlugins`) but **nothing
  watches it** — no chokidar/`fs.watch`/FSWatcher anywhere under `src/utils/plugins/` or `src/services/plugins/`
  (repo watchers exist only for tasks/settings/skills/keybindings). `pluginDirectories.ts` is just path config.
- No `plugin eval` command (`src/main.tsx` plugin CLI @4727–4834: validate/list/marketplace/install/uninstall/
  enable/disable/update only).
- Local-folder marketplaces ARE supported (`parseMarketplaceInput.ts:135` → `{source:'directory',path}`), and
  install/update COPIES into the versioned cache: `src/services/plugins/pluginOperations.ts` `updateSinglePlugin`
  local branch (~943–1010) resolves `sourcePath = join(marketplaceDir, entry.source)`, computes `newVersion`
  via `calculatePluginVersion`, then **short-circuits**: `isUpToDate = installation.version === newVersion ||
  installation.installPath === versionedPath …` → returns "already at the latest version" WITHOUT re-copying
  when folder contents changed but the version didn't. The session loader reads `installPath` (the cache copy).
  No `readInPlace`/`linkFarm`/`readFromFolder`/in-place serving anywhere in OCC (grep: 0 hits).
- `plugin list` shows the recorded version: `src/cli/handlers/plugins.ts:240` `version: installation.version ||
  'unknown'`, `:380-384` `Version: ${installation.version}`.

### Verdicts

- **#6b: NO-OP** — surface absent (no watcher to fix). STAGED note: when OCC ever adds `--plugin-dir` hot
  reload, the watcher MUST `realpath` the root and remap event paths back into the as-given root (official
  `dNe`/`aNe` pattern above), otherwise symlinked dirs silently never reload.
- **#6a: STAGED** — OCC has the same user-visible staleness (edit local-folder plugin without version bump →
  list shows recorded version; update says "already at the latest version"; loader keeps serving the stale
  cache copy), but the official v289 fix rides on in-place serving which OCC never had (a v288-era gap).
  Two-stage plan:
  1. **Prerequisite (v288-era)**: serve local-directory-marketplace plugins in place — loader prefers
     `join(marketplaceDir, entry.source)` over the versioned cache copy when the marketplace record's source
     is a directory (mirror official `nCe`/`Ku` branch: skip cache invalidation + copy, set `path=sourcePath`).
  2. **v289 delta**: stamp `readFromFolderAt` on load; `plugin list` prints live-folder version + `Read from:`
     line (and `readFromFolder`/`folderVersion` if/when OCC adds `--json`); `plugin update` for directory
     sources re-resolves the folder instead of trusting the recorded version.
  Files implicated: `src/services/plugins/pluginOperations.ts`, `src/utils/plugins/pluginLoader.ts`,
  `src/utils/plugins/installedPluginsManager.ts`, `src/cli/handlers/plugins.ts`, `src/utils/plugins/marketplaceManager.ts`.
  E2E test sketch (stage 1): marketplace add a local dir → install plugin → edit the plugin's SKILL/command in
  the source dir (no version bump) → new session must show the edited content (and `plugin list` the source
  folder), not the cache copy.

---

## Item #7 — installed mods not loading in first session after upgrade

Changelog: *"Fixed installed mods not loading in the first session after an upgrade."*

### Official fix (byte-level)

Hooks-modules rollout-flag module @v288:207005163 / @v289:207317461 (`hooksModules` literal sites: v288=22,
v289=31). v288 exports `awaitsHooksModulesFlag`, `hooksModulesFlagSettled`, `isHooksModulesFlagSaved`, …;
v289 adds **`awaitsHooksModulesRefresh`, `awaitsHooksModulesRejoin`, `hooksModulesFetchRejoined`,
`hooksModulesFlagHeld`, `hooksModulesLoadedLate`**:

```js
// v288 (only cold-cache "fallback" case held the load; a disk-saved OFF was final for the session):
var SKr=()=>ke()&&K2t()&&!gd()&&co(JQ,pIe).source==="fallback";           // awaitsHooksModulesFlag
var TKr=()=>eh()&&co(JQ,pIe).source==="disk";                              // isHooksModulesFlagSaved
async function EKr(){let o=SKr()?await l7e({initialize:ec,budgetMs:wKr()}):void 0; ...}

// v289 (disk-saved OFF now also waits for a refresh, and a late ON still loads the mods):
var b4r=()=>ke()&&aZe()&&!Yc()&&io(d3,EIe).source==="fallback";
var b_t=()=>th()&&io(d3,EIe).source==="disk";
var wwn=()=>aZe()&&b_t()&&!zD();                       // awaitsHooksModulesRefresh: gated && saved-on-disk && currently OFF
var S4r=()=>wwn()&&UWe();                              // awaitsHooksModulesRejoin: && fetch in flight
async function w4r(){return await al().catch(()=>{return}),S4r()?al().catch(()=>{return}):void 0}
async function T4r(){let o=wwn();return o||b4r()?k4r(o?w4r:al):void 0}     // hooksModulesFlagSettled
function C4r(o){                                       // hooksModulesLoadedLate — NEW late-load listener
  if(!(b_t()&&!zD()))return;
  let e=Ou(()=>{if(!Yc())return;
    if(e(),zD())t(`installed plugins' hooks modules load late: the rollout flag (${d3}) answered on after the load went on over a saved off`),o()})
}
```

Consumer @v289:209320539 (hook registration / mods load path):

```js
async function SFo(e,n){if(_Fo(e,$Ht()))await T4r(),C4r(n)}
// if some loaded plugin HAS a hooks module that got skipped under the current off-state:
//   wait for the flag to settle (rejoining the in-flight fetch), then subscribe for a late ON → reload (n)
```

New literal `installed plugins' hooks modules load late: the rollout flag (` — v288=0, v289=2.
Bug mechanism: after an upgrade the GrowthBook disk cache can hold the hooks-modules gate as OFF (stale);
v288 treated the saved OFF as final for the whole first session even when the fresh fetch answered ON moments
later. v289 holds/rejoins the fetch and, failing that, loads the mods late via a gate-change listener.

### OCC surface / verdict — **NO-OP** (structurally immune)

- OCC has **no mods / hooks-modules system**: `grep -rn 'hooksModules|HOOKS_MODULES|tool.describe|devMods' src/`
  → only unrelated `devMods` 0 hits; no `tool.describe`/`command.describe` hooks; no `mods` runtime.
- OCC plugin hook loading (`src/utils/plugins/loadPluginHooks.ts`, hook registration in the REPL bootstrap) is
  **not gated by any remote rollout flag** — there is no GrowthBook gate whose stale disk-saved OFF could skip
  hook-module loading, and no first-session-after-upgrade code path keyed on a fetched switch.
- The failure mode (saved-OFF beats fetched-ON for one session) cannot occur because the decision input
  (remote gate) does not exist in OCC. If OCC ever adds rollout-gated plugin subsystems, the official lesson:
  a disk-cached OFF must be re-validated against the in-flight fetch, plus a late-ON listener that loads
  retroactively.

---

## Item #10 (SECURITY) — user plugin rewriting org-managed MCP sign-in tool descriptions

Changelog: *"Fixed a user-installed plugin being able to rewrite the descriptions of an organization-managed
MCP server's sign-in tools."*

### Official fix (byte-level)

Provider-tier resolution for tool-description providers, v289 region @~208018271:

```js
// v288:
return iJ({name:r,scope:e.mcpInfo?.scope,pluginSource:s.pluginSource})
// v289:
return kJ({name:r,scope:e.mcpInfo?.scope??e.mcpInfo?.source,pluginSource:s.pluginSource})
```

Tier function `iJ`@v288:207645733 / `kJ`@v289:207948776, with the protected-scope list
`Fst=Object.freeze(["enterprise","managed"])` @v289:207948561: a provider whose `scope` is enterprise/managed
gets `tier:"prepend"` (org-protected — user-tier providers may not replace it); anything else gets `tier:"user"`
(rewritable by user plugins' `tool.describe` hooks).

The hole: MCP auth-stub ("sign-in") tools are synthetic tools built by factory `K(e,r,n)` with
`mcpInfo:{serverName:e,toolName:UFt,serverType:h,source:mj(e,r),isAuthStub:!0,serverId:Jye(r)}` — they carry
**`source` but no `scope`** (`mj(e,n){if(n.type==="sdk"&&iMr(n))return"sdk";if(PL(n)||plt(e,n.scope))return
"plugin";return n.scope}` @v288:207755612 / v289:208058674). In v288, `scope:e.mcpInfo?.scope` was therefore
`undefined` for an org-managed server's sign-in tool → tier resolved to `"user"` → a user-installed plugin's
`tool.describe` hook could rewrite the sign-in tool's description (phishing surface: the sign-in tool is exactly
what a user clicks to authenticate an org-managed MCP server). v289 falls back to `source`, which retains the
managed/enterprise origin, so the sign-in tools of org-managed servers get the protected `prepend` tier.

### OCC surface / verdict — **NO-OP** (structurally immune; surface absent)

- OCC has **no mods / `tool.describe` / `command.describe` hook system** (grep: 0 hits) — no user-plugin
  mechanism exists that could rewrite ANY tool description, so the org-managed sign-in-tool override vector is
  absent.
- `src/tools/McpAuthTool/McpAuthTool.ts` @246 builds `mcpInfo:{serverName,toolName}` only (no scope/source, and
  @184–185 documents the divergence); its description is static — nothing consumes a per-provider description
  tier.
- No provider-tier/prepend system exists in OCC tool assembly.
- STAGED note: when OCC implements mods `tool.describe`, it MUST port the v289 form (`scope ?? source`) and the
  enterprise/managed protected tier from day one, and McpAuthTool's `mcpInfo` must then carry `source` (per
  official `mj`) so auth stubs of managed servers are protected.

---

## Item #16 — `plugin validate` skipping the plugin when the folder also holds a marketplace manifest

Changelog: *"Fixed `claude plugin validate` skipping the plugin when the folder also holds a marketplace manifest."*

### Official fix (byte-level)

Validate reader `kTt`@v288:236232779 → `JTt`@v289:236588478 (same chunk that owns the validate CLI handler `Ea`).

```js
// v288 — marketplace manifest wins; co-located plugin.json NEVER validated:
async function kTt(n){
  let r=await _pr(n),s=r.filePath;
  if(r.errors.some(c=>c.code===tn)){let c=await os(s);
    return c?{manifest:null,contents:c,resolvedPath:s}:{manifest:r,contents:[],resolvedPath:s}}
  let i=T.dirname(s),
      a=r.fileType==="plugin"&&T.basename(i)===".claude-plugin"?await nt(T.dirname(i)):[];
  return{manifest:r,contents:a,resolvedPath:s}
}

// v289 — NEW co-location branch (also carries the #22 fixes):
async function JTt(n){
  let r=await hfr(n),s=r.filePath;
  if(r.errors.some(m=>m.code===ln)){ ...same ENOENT handling... }
  let i=T.dirname(s),a=T.dirname(i);
  if(T.basename(i)!==".claude-plugin")return{manifest:r,contents:[],resolvedPath:s};
  if(r.fileType==="plugin"){let m=await je(a);return{manifest:r,contents:m,resolvedPath:s}}
  if(T.resolve(n)!==a)return{manifest:r,contents:[],resolvedPath:s};
  let c=await Me(s),                                        // read the marketplace manifest
      p=c!==void 0&&qCn(c.name)&&c.plugins.some(m=>Ae(m,a,a)),   // Anthropic marketplace listing THIS folder
      d=await de(T.join(i,"plugin.json"),{kind:p?"anthropic":"alone"});
  if(d.errors[0]?.code==="ENOENT")return{manifest:r,contents:[],resolvedPath:s};
  let f=d.errors.length>0||d.warnings.length>0||(d.notes?.length??0)>0;
  return{manifest:r,contents:[...f?[d]:[],...await je(a)],resolvedPath:s}
}
```

The contents collector itself (`nt`@v288:236230860 → `je`@v289:236586559) is pure name churn (verified).

### OCC surface — bug present, identical

`src/utils/plugins/validatePlugin.ts` `validateManifest` @876–965, directory branch @891–923:

```ts
// Prefer marketplace.json over plugin.json
const marketplaceResult = await validateMarketplaceManifest(marketplacePath)
if (marketplaceResult.errors[0]?.code !== 'ENOENT') {
  return marketplaceResult            // ← EARLY RETURN: co-located plugin.json never validated (= v288 bug)
}
```

CLI handler `src/cli/handlers/plugins.ts:103` (`pluginValidateHandler`) then only collects contents when
`result.fileType === 'plugin'` — so for a folder holding both manifests, the plugin and all its contents are
skipped. Slash-command path `src/commands/plugin/ValidatePlugin.tsx` renders the single result and even
advertises "(prefers marketplace if both exist)".

### Verdict — **PORT**

Official fix shape to port (adapted to OCC's `validateManifest → ValidationResult` signature; OCC lacks the
official `{manifest, contents[], resolvedPath}` envelope — either introduce it or have the CLI handler do the
composition like it already does for the plugin-file case):

1. In `validateManifest`'s directory branch: when marketplace.json exists AND
    `path.resolve(inputDir) === dirname(marketplacePath-parent)` (i.e. the user pointed at the folder holding
    `.claude-plugin/`), also validate `join(dir,'.claude-plugin','plugin.json')` if present (skip ENOENT).
2. Gate inclusion (official `f`): add the co-located plugin result to the reported contents ONLY when it has
    errors/warnings (OCC has no `notes` field — see #22).
3. Fold in the #22(a) anthropic-kind relaxation (below) in the same change.
4. Update the `ValidatePlugin.tsx` usage text ("prefers marketplace if both exist" → validates both).

Change sites: `src/utils/plugins/validatePlugin.ts` (validateManifest @876–965; possibly a new `kind` param on
`validatePluginManifest` @171), `src/cli/handlers/plugins.ts` (@103–150), `src/commands/plugin/ValidatePlugin.tsx`
(usage text @26).

Test case (RED first):
```
tmpdir/.claude-plugin/marketplace.json  (valid marketplace listing {name:"m", plugins:[{name:"p", source:"./"}]})
tmpdir/.claude-plugin/plugin.json       (plugin "p" with an invalid field, e.g. mcpServers entry pointing at a
                                         missing bin file, or any error-producing content)
expect: validate(tmpdir) reports BOTH the marketplace result AND the plugin.json errors (exit code 1);
        with a clean plugin.json: only the marketplace result is reported, plugin.json not listed.
```

---

## Item #22 — validate failing an Anthropic marketplace's own plugin; clean `plugin.json` in `--json`

Changelog: *"Fixed `claude plugin validate` failing an Anthropic marketplace's own plugin and listing a clean
`plugin.json` in `--json`."*

Both halves map to the same `kTt→JTt` rewrite above:

**(a) anthropic-kind relaxation.** The validator `de(path,{kind})` (both versions) gates the strict standalone
name rule on kind — @v289:236553486:

```js
let k=s.kind==="alone"||s.kind==="entry"&&s.entryName!==m.name?eAt(m.name):void 0;
if(k)(k.severity==="error"?i:a).push({path:"name",message:s.kind==="alone"?`${k.message} ${Puo}`:k.message});
// eAt = the claude.ai-sync kebab-case / name rule ("Claude.ai marketplace sync requires kebab-case ..." @236553350)
```

v288's validate path had no co-location awareness, so an Anthropic marketplace repo whose `.claude-plugin/`
holds both marketplace.json and its own plugin.json was validated under standalone (`alone`) rules and could
fail on name rules that Anthropic's own plugins are exempt from. v289's `JTt` detects the case —
`p = c!==void 0 && qCn(c.name) && c.plugins.some(m=>Ae(m,a,a))` (marketplace name is Anthropic's AND its
`plugins[]` lists this very folder) — and validates with `{kind:"anthropic"}`, skipping the alone-only rule.
The tag-prepare path `QTt` (both versions) already used the same kind detection:
`de(c, qCn(d.marketplaceName)?{kind:"anthropic"}:{kind:"alone"})`.

**(b) clean `plugin.json` no longer listed.** v289 gates the co-located result on
`f = d.errors.length>0 || d.warnings.length>0 || (d.notes?.length??0)>0` before pushing it into `contents`
(which is what `--json` serializes: `dn(o,s)={success,strict,target,manifest,contents}` with per-file
`je(o)={file,type,errors,warnings,notes:o.notes??[]}` — present in BOTH versions, name-churn only).

### OCC surface / verdict

- **(b) NO-OP**: OCC's `plugin validate` has **no `--json` output** (`src/main.tsx` plugin CLI @4727–4834;
  `pluginValidateHandler` prints human text only), and OCC's `validatePluginContents` (validatePlugin.ts @825)
  already documents "Returns one ValidationResult per file that has errors or warnings. A clean plugin returns
  an empty array." — clean files are never listed. OCC's `ValidationResult` @63 also lacks the official `notes`
  and `strict` fields (divergence to note if/when `--json` is added: official json =
  `{success,strict,target,manifest,contents:[{file,type,errors,warnings,notes}]}`).
- **(a) PORT — folded into the #16 change**: when OCC ports the co-location branch it MUST include the
  anthropic-kind gate, otherwise the port itself would introduce #22(a) (failing Anthropic-marketplace repos
  that hold their own plugin.json). Mitigating detail: OCC's kebab-case name rule is only a WARNING
  (validatePlugin.ts @319–327: "Claude Code accepts it, but the Claude.ai marketplace sync requires
  kebab-case"), not an error — so the concrete v288 failure mode is softer in OCC today; still port the kind
  distinction (`kind:"anthropic"|"alone"` param on `validatePluginManifest`) to stay behavior-aligned.
  Detection needs an OCC analogue of `qCn` (is-Anthropic-marketplace-name) + "marketplace plugins[] lists this
  folder" — mirror official exactly; do not invent a looser heuristic.

---

## Adjacent finding (not cluster E, flagged for the MCP-schema cluster)

New v289 prototype-pollution guard in the MCP server-config schema region @v289:200175069 (v288 has 8 sites of
the regex, v289 has 9):

```js
function mo(e){return/^[A-Za-z0-9_-]+$/.test(e)&&e!=="__proto__"&&e!=="constructor"&&e!=="prototype"}
// neighbors: ou=["command","args","env","headersHelper"], su=new Set(["http","streamable-http","sse"])
```

## Method notes

- Offset-delta curve technique: pair version-stable literals across builds, plot `off289 - off288`; jumps mark
  insertions. This is what located the #6a growth (+2896B in the plugin CLI chunk, +5958B in the
  loader/flag region) and the #7 growth (`hooksModules` sites 22→31).
- Regions verified as pure minified-name churn (no semantic change) via signature-normalized difflib:
  plugin update CLI module, MCPB copy/extract cache, marketplace registry/clone, plugin-directory catalog,
  dev-mods hot-reload module, contents collector `nt`/`je`.
- Red herrings eliminated: `Han/can` folder-identity fn (identical), `type==="local"` sites (slash-command
  types), `stale` count +1 (unrelated cluster-F/cloud-session churn), `Tdr(` @210713134 (git-bundle name
  collision, different chunk).
