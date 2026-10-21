# DELIVERABLE — gap-round 2.1.304→2.1.306, items 1–2 (2.1.305 changelog)

Analysis scratch files written: `/tmp/cc-diff-306/v304-mcp-region.txt`, `/tmp/cc-diff-306/v306-mcp-region.txt` (outside occ repo; occ untouched).

---

## ITEM 1 — `sandbox.allowNestedUserNamespaces`

**Verdict: PORT** (CC-side settings surface is the 305 delta; enforcement layer is a sandbox-runtime version gap — details below)

### Byte evidence (all offsets in `/tmp/cc-diff-306/v306/package/claude` unless noted)

**Key subtlety: the string exists in v304 too — but only inside the *vendored sandbox-runtime* code, not the CC settings schema.** v304 offsets: 126744488 (strtab), 242716175 (runtime Linux arg-builder `A1`), 242778069/242778100/242779301 (runtime `wrapWithSandbox`), 261481462 (runtime's own zod `SandboxConfig`). v304's CC settings schema (region @237076346, `"Run Bash commands inside the sandbox"`) goes `enableWeakerNestedSandbox` → `enableWeakerNetworkIsolation` with **no key between**. v305 inserts it (@238321884 in v305; @238321756 in v306). The 305 changelog item = exposing the CC settings key + all CC-side gating.

**1. CC settings schema, v306 @238321756 (verbatim):**
```js
allowNestedUserNamespaces:M().optional().describe("Linux/WSL only: Let sandboxed commands create user namespaces of their own, which the sandbox refuses by default. Needed by tools that sandbox themselves that way, such as Chromium's and Electron's sandbox, rootless podman or buildah, a nested bubblewrap, and `unshare`. "
+"**Removes code-execution isolation** \u2014 in any folder a hostile command may write, it can then bypass filesystem.denyWrite, filesystem.denyRead, credentials.files entries and the paths the sandbox always write-protects (such as .claude/settings.json, git hooks and git config), "
+"and so plant code that later runs outside the sandbox; while autoAllowBashIfSandboxed is on, the command that plants it needs no approval. Default: false. "
+"Only honored from user, managed/policy, or CLI (--settings) settings \u2014 "
+`true from ${je} is ignored (false there still applies).`)
```
(`${je}` = "project settings (.claude/settings.json and .claude/settings.local.json)"; `M()` = z.boolean). Default: absent/false. Position: between `enableWeakerNestedSandbox` and `enableWeakerNetworkIsolation`. This exact describe text is NEW in v305 (s306 line 184565; absent from s304).

**2. Restrictive-merge table entry @238346103:** `{path:["sandbox","allowNestedUserNamespaces"],restrictive:!1}` — inserted after `{path:["sandbox","allowAppleEvents"],restrictive:!1}`, before `{path:["sandbox","network","allowManagedDomainsOnly"],restrictive:!0}`. (`restrictive:!1` = the restrictive value is `false`; project-tier `true` is dropped at merge.)

**3. Trusted-key list `Xi` @238365501:** `Xi=["allowAppleEvents","allowNestedUserNamespaces","credentials","enableWeakerNestedSandbox","enableWeakerNetworkIsolation","filesystem.disabled","network.allowAllUnixSockets","network.allowMachLookup","network.allowUnixSockets","network.httpProxyPort","network.socksProxyPort","network.tlsTerminate"]`

**4. builtConfig passthrough (CC glue → runtime session config) @244386980:**
```js
allowNestedUserNamespaces:Pu()&&c8()?!1:Mp(e.sandbox?.allowNestedUserNamespaces,(Z)=>Z.allowNestedUserNamespaces)
```
with `function Mp(e,n){return e===!1?!1:my(n)}` @244325168 and `function my(e){for(let n of gy()){let r=n?.sandbox?e(n.sandbox):void 0;if(r!==void 0)return r}return}` @244270329 (`gy()=[Dc(),...PNt()]` = trusted settings sources). Semantics: merged-value `false` wins; otherwise first defined value from trusted tiers only. `Pu()&&c8()` = subprocess-env-scrub mode with scrub sandbox available → force `false` (`c8` = `scrubSandboxAvailableLatched` @240438385). Same gate as existing `enableWeakerNestedSandbox` line.

**5. Linux gating + runtime plumbing (already present in v304's vendored runtime):**
- wrapWithSandbox @244257659: `Ce=h?.allowNestedUserNamespaces??Le?.allowNestedUserNamespaces` (per-exec config ?? session config); passed **only** in the `case"linux":return K1({...allowNestedUserNamespaces:Ce,...})` branch (macOS branch doesn't get it).
- K1 @244168107/244170739: seccomp-helper path gets env prefix `Ft=b8(Y===!0)+Ft`; @244152829: `var G1="SRT_ALLOW_NESTED_USERNS";function b8(e){return\`${G1}=${e?"1":"0"} \`}`; later `pt.push("--unsetenv",G1)`.
- Default-block path (when no seccomp helper and flag not true): `if(Ft===void 0&&Y!==!0){let Pt=q?null:we??fa("bwrap");if(Pt!==null&&S8(Pt))pt.push("--disable-userns");else if(!M1)M1=!0,St("[Sandbox Linux] no seccomp helper in use, and bubblewrap cannot disable user namespaces (needs 0.8.0 or later, not setuid, and no enableWeakerNestedSandbox) - a sandboxed command that creates one can undo the write denies",{level:"warn"})}` — `S8` @244152829-region runs `bwrap --help` and checks output `includes("--disable-userns")`, memoized.

**6. Force-false consumers (new in v305/v306 CC code):**
- Bash strict-mode per-command-deny wrap @249967907: `Ro={...Ro,filesystem:...,allowNestedUserNamespaces:!1}`
- git credential-helper/askpass wrap @251596668: `H={filesystem:{allowWrite:[r],...},allowNestedUserNamespaces:!1}`

**7. Device-tools (remote tools) weakened-sandbox gate:**
- Predicate `hxr` @245571000: `e.allowAppleEvents===!0||e.enableWeakerNestedSandbox===!0||n!=="macos"&&n!=="windows"&&e.allowNestedUserNamespaces===!0||...` → reason `sandbox_weakened`. Linux-only gating: platform not macos and not windows.
- Refusal message @265039529 now lists `sandbox.allowNestedUserNamespaces` (v304's message @242142142 does not).
- Eval-shell grant harness @279093951: refusal row `"sandbox.allowNestedUserNamespaces lets sandboxed commands get around file deny rules"` (new; not in s304).

**8. Telemetry: NONE new** — no tengu_ event references the key; `sandbox_weakened` reason enum pre-exists in v304.

### OCC current state
- `grep -rn allowNestedUserNamespaces src/ patches/` → **0 hits**. No nested-namespace-like key exists.
- `src/entrypoints/sandboxTypes.ts:145-232` `SandboxSettingsSchema`: has `enableWeakerNestedSandbox: z.boolean().optional()` (line 178, no describe), no allowNestedUserNamespaces; schema is `.passthrough()` so a user's value survives parse but is consumed nowhere.
- `src/utils/sandbox/sandbox-adapter.ts:817-840` `convertToSandboxRuntimeConfig` returns `{network, filesystem, ignoreViolations, enableWeakerNestedSandbox, enableWeakerNetworkIsolation, ripgrep}` — no passthrough. Trusted-tier pattern precedent exists in same function (ripgrep @798-807 reads policySettings→flagSettings→userSettings).
- `src/utils/settings/policyLocks.ts:170-183`: restrictive table has the sandbox group, missing the new entry (comment there documents intentionally-omitted official entries).
- `src/utils/settings/settings.ts:955-967`: `validNestedKeys.sandbox` (logging-only via `getManagedSettingsKeysForLogging`) — missing key.
- **Runtime**: `package.json:45` pins `@anthropic-ai/sandbox-runtime ^0.0.44` (bun.lock:198) + `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` (which already backports a "sandbox-runtime 0.0.80 glob fix" — precedent for runtime backports). Verified via jsdelivr: published 0.0.44 has **zero** nested-userns support — `sandbox-config.d.ts`/`sandbox-schemas.d.ts` lack the key; `linux-sandbox-utils.js` lacks `--unshare-user`, `--disable-userns`, `SRT_ALLOW_NESTED_USERNS`; `wrapCommandWithSandboxLinux` destructures `enableWeakerNestedSandbox, allowAllUnixSockets, ...` but no `allowNestedUserNamespaces`; its `generate-seccomp-filter.js` blocks only `socket(AF_UNIX,...)`. `SandboxRuntimeConfigSchema` in 0.0.44 is a plain `z.object` → unknown keys stripped.
- **Consequence**: on OCC today, nested user namespaces inside the sandbox are effectively *always allowed* (nothing blocks them; OCC behaves like official-with-flag=true), while official ≥2.1.304 defaults to blocking. The CC-side port alone makes the setting plumb into a runtime that ignores it.

### Implementation plan (PORT)

**Layer A — CC side (the actual 305 changelog item):**
1. `src/entrypoints/sandboxTypes.ts`: insert between `enableWeakerNestedSandbox` and `enableWeakerNetworkIsolation`:
   `allowNestedUserNamespaces: z.boolean().optional().describe(<verbatim text from evidence #1, with "project settings (.claude/settings.json and .claude/settings.local.json)" substituted for ${je}>)`
2. `src/utils/settings/policyLocks.ts`: add `{ path: ['sandbox', 'allowNestedUserNamespaces'], restrictive: false },` after the `allowAppleEvents` entry.
3. `src/utils/settings/settings.ts` `validNestedKeys.sandbox`: add `'allowNestedUserNamespaces'` next to `'enableWeakerNestedSandbox'`.
4. `src/utils/sandbox/sandbox-adapter.ts` `convertToSandboxRuntimeConfig` return object: add `allowNestedUserNamespaces: settings.sandbox?.allowNestedUserNamespaces,` — mirroring how OCC passes `enableWeakerNestedSandbox` (merged-settings read is acceptable because policyLocks `restrictive:false` drops project-tier `true` at merge; official's extra `Pu()&&c8()` scrub-mode force-false has no OCC equivalent — OCC has no scrub-sandbox latch; skip or TODO). Type: widen locally (the 0.0.44 `SandboxRuntimeConfig` type lacks the key — add an intersection type or patch the `.d.ts` in Layer B).
5. No OCC surface for: device-tools `hxr`/`sandbox_weakened` (grep 0 hits), eval-shell harness (0 hits), Bash per-command-deny strict path (0 hits), git-credential-helper sandbox wrap (0 hits) — SKIP these consumers (no OCC surface), record as backend/feature-gated.

**Layer B — runtime enforcement (runtime-version gap; required for the setting to do anything; pre-dates 305):**
Extend `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch`:
- `dist/sandbox/sandbox-config.js` + `.d.ts`: add `allowNestedUserNamespaces: z.boolean().optional()` to `SandboxRuntimeConfigSchema` (describe: runtime text from v306 @263352133, verbatim available).
- `dist/sandbox/linux-sandbox-utils.js` `wrapCommandWithSandboxLinux`: destructure `allowNestedUserNamespaces`; port from evidence #5: `SRT_ALLOW_NESTED_USERNS=${flag?'1':'0'} ` env prefix on the apply-seccomp invocation (forward-compat only — 0.0.44's native applier ignores it), `--unsetenv SRT_ALLOW_NESTED_USERNS`, and the no-seccomp-helper branch: probe `bwrap --help` for `--disable-userns` (memoized), push flag when supported and `allowNestedUserNamespaces !== true`, else warn-once with the verbatim `[Sandbox Linux] no seccomp helper in use, ...` string.
- Note in port docs: full parity of the *default block* under the seccomp-helper path needs the newer native apply-seccomp binary (blocks `clone/unshare(CLONE_NEWUSER)` unless env=1) which 0.0.44 doesn't ship — JS-only backport gives parity via the `--disable-userns` (bwrap ≥0.8) path only.

**Test plan:** unit — schema accepts key & describe snapshot; policyLocks: project-tier `true` dropped, `false` honored, user/managed `true` honored; `convertToSandboxRuntimeConfig` passthrough. Integration (Linux, sandbox enabled, spy on spawn argv) — default: `--disable-userns` present (bwrap ≥0.8) and `unshare -Ur true` fails inside sandbox; `allowNestedUserNamespaces:true` in user settings: flag absent and `unshare -Ur true` succeeds; old bwrap: warn-once text emitted. e2e REPL: flip setting via settings.json, run Bash tool `unshare -Ur echo ok` both ways.

---

## ITEM 2 — `allowedMcpServers` stops filtering managed-mcp.json stdio servers using `${VAR}` only in `env`

**Verdict: PORT** — and OCC's gap is *larger* than the 305 delta: OCC is missing the v304-era trusted-scope exemption entirely, so it must land the v306 semantics directly.

### Byte evidence

**Marking predicate change (the actual 305 code diff).** v304 `iVr` @249195356 (v304 binary):
```js
function iVr(e){switch(e.type){case void 0:case"stdio":{let n=e;
  return eye(n.command)||n.args.some(eye)||Object.values(n.env??{}).some(eye)}
 case"sse":case"http":case"ws":{let n=e;
  return eye(n.url)||Object.values(n.headers??{}).some(eye)}
 case"sse-ide":case"ws-ide":case"sdk":case"claudeai-proxy":return!1}}
```
v306 replacement — walker `hMn` @250660359 + `VVr` @250660759:
```js
function hMn(e,n){switch(e.type){case void 0:case"stdio":{let r=e;
  return{...r,command:n(r.command,"command",!1),args:r.args.map((s)=>n(s,"args",!1)),
    env:r.env?ro(r.env,(s)=>n(s,"env",!1)):void 0}}
 case"sse":case"http":case"ws":{let r=e;
  return{...r,url:n(r.url,"url",!0),headers:r.headers?ro(r.headers,(s)=>n(s,"headers",!0)):void 0}}
 case"sse-ide":case"ws-ide":case"sdk":case"claudeai-proxy":return e}}
function VVr(e){let n=!1;return hMn(e,(r,s)=>(n||=s!=="env"&&Wet(r),r)),n}
```
`function Wet(e){return new RegExp(q2e).test(e)}` @237824408; `q2e=String.raw\`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}\`` @237824349.
Novelty proof: `s!=="env"&&` → 0 hits in v304 binary, 1 hit in v305, 1 hit in v306.

**Marking site** (config parse `vHt`, v306 @~250666xxx region): `if(s==="enterprise"&&VVr(Pe))Ye={...Ye,expandedFromEnv:!0}` — `Pe` is the schema-parsed **pre-expansion** config (raw `${VAR}` text), `s` is scope. v304 identical shape with `iVr` (@249201473 region).

**Allowlist gate** `aB` (v306, region @250681xxx): after deny check `SX(e,n)`:
```js
if(n?.scope!==void 0&&Bj(n.scope)&&!n.expandedFromEnv&&!n.pluginSource)return!0;
```
`function Bj(e){return FMn.includes(e)}` @250690063; `FMn=["enterprise","managed"]` @250689996. **This bypass line is byte-identical in v304** (`GU` @249214861) — so the only 304→306 code delta is the predicate + describe. `expandedFromEnv` is also stripped from the server-config hash `dq` (@250646xxx: `let{...,expandedFromEnv:H,...}=e` before hashing).

**Describe text diff** (settings schema, v304 @237186875-region vs v306 @238441596-region):
- v304: `...servers the organization itself delivers (managedMcpServers, and managed-mcp.json entries that use no ${VAR} expansion) are allowed without being listed; a managed-mcp.json entry that uses ${VAR} expansion is still checked against this list....`
- v306: `...servers the organization itself delivers (managedMcpServers, and managed-mcp.json entries with no ${VAR} in their command, args, url or header values) are allowed without being listed; a managed-mcp.json entry with ${VAR} in any of those must match this list....` (rest unchanged: `If undefined, all servers are allowed. If empty array, users can use no servers of their own. Denylist takes precedence - if a server is on both lists, it is denied.`)

### OCC current state
- **OCC HAS a managed-mcp.json surface**: `src/services/mcp/config.ts:74` (`getEnterpriseMcpFilePath` → `join(getManagedFilePath(),'managed-mcp.json')`), enterprise scope in `getMcpConfigsByScope` (:1092-1110, with `expandVars` support), exclusive-control filter in `getClaudeCodeMcpConfigs` (:1188-1200).
- **No `expandedFromEnv` anywhere in src/** (grep 0 hits). **No trusted-scope allowlist exemption**: the enterprise loop (:1192-1197) runs `isMcpServerAllowedByPolicy(name, serverConfig)` on *every* managed entry, and `isMcpServerAllowedByPolicy` (:434-527) has no scope-based early return. Settings describe `src/utils/settings/types.ts:538-542` still says `'Applies to all scopes including enterprise servers from managed-mcp.json.'`.
- Net behavior today: OCC is **stricter than both v304 and v306** — with any `allowedMcpServers` set, org-delivered managed-mcp entries (even with no `${VAR}` at all) are blocked unless listed; env-only-`${VAR}` entries likewise. The 305 change ("one your allowlist left out now loads on upgrade") plus the v304 exemption both need landing.
- Building blocks present: `ENV_VAR_PATTERN` = official regex verbatim at `src/services/mcp/redaction.ts:95`; `expandEnvVars` (config.ts:581-640) already walks command/args/env/url/headers; `ScopedMcpServerConfig` (src/services/mcp/types.ts:207) carries `scope`; `parseMcpConfig` (config.ts:1401-1500) is the marking site; `pluginSource` concept exists (src/services/mcp/channelAllowlist.ts).

### Implementation plan (PORT)
1. **Type**: add `expandedFromEnv?: boolean` to the server-config type used by `ScopedMcpServerConfig` (src/services/mcp/types.ts); ensure it's excluded from any config-hash/compare path (OCC has no `dq` hash in config.ts — verify redaction.ts/dedup paths ignore it).
2. **Marking** — `src/services/mcp/config.ts` `parseMcpConfig`, inside the per-server loop (~:1450-1470), operating on the RAW parsed `config` (pre-expansion), mirroring `VVr`:
   - new helper `usesVarOutsideEnv(config): boolean`: stdio/undefined type → `test(config.command) || config.args.some(test)`; sse/http/ws → `test(config.url) || Object.values(config.headers??{}).some(test)`; sse-ide/ws-ide/sdk/claudeai-proxy → false; `test = s => new RegExp(ENV_VAR_PATTERN).test(s)` (import from `./redaction.js`). **env values are NOT tested** (the 305 change).
   - `if (scope === 'enterprise' && usesVarOutsideEnv(config)) configToCheck = { ...configToCheck, expandedFromEnv: true }`.
3. **Gate** — `isMcpServerAllowedByPolicy` (config.ts:434): immediately after the `isMcpServerDenied` early-return, insert official bypass: `if (config?.scope !== undefined && (config.scope === 'enterprise' || config.scope === 'managed') && !config.expandedFromEnv && !(config as ...).pluginSource) return true`. Widen the param type to accept `scope`/`pluginSource` (callers in the enterprise loop already pass `ScopedMcpServerConfig`; `filterMcpServersByPolicy` callers pass user/dynamic configs — untrusted scopes fall through unchanged).
4. **Describe** — replace `src/utils/settings/types.ts:538-542` text with the verbatim v306 sentence (evidence above).
5. **Tests** (unit, `src/services/mcp/__tests__/`):
   - enterprise stdio entry with `${VAR}` **only in env** + `allowedMcpServers: ['other']` → loads (regression target of this item).
   - enterprise stdio entry with `${VAR}` in command or args + same allowlist → blocked; with matching `serverCommand` entry → allowed.
   - enterprise entry with no `${VAR}` + non-empty allowlist not naming it → loads (v304 exemption, new for OCC).
   - `deniedMcpServers` naming a bypassed entry → still denied (deny precedence).
   - user/project/local servers unaffected by the bypass (scope gate).
   - http/sse enterprise entry with `${VAR}` in headers → still checked; in url → still checked.
   - e2e: write managed-mcp.json with env-only-`${VAR}` stdio server + user settings `allowedMcpServers: []` → `/mcp` shows the server (pre-change: absent).