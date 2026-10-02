# OCC-105 Cluster B — Protocol / Sandbox / Auth Security (2.1.286 → 2.1.287)

Research-only byte forensics. Binaries: `/tmp/cc-diff-287/v286/package/claude` (241 MB) and
`/tmp/cc-diff-287/v287/package/claude` (244 MB), linux-x64 Bun ELF. Never executed.
Method: `rg -aob -F` / python `re.finditer` for needle offsets; python slices for extraction;
JS code region = offset > 150,000,000; novelty = same-needle hit count in the other binary.
Minified identifiers are REUSED across chunks — every identification below was confirmed via
message strings and call-site neighborhoods, never by identifier alone.

| # | Changelog item | Verdict | OCC |
|---|----------------|---------|-----|
| 1 | Org per-tool ceilings dropped for MCP tool `__proto__` | NO-OP{NO-SURFACE} | NOT-AFFECTED |
| 2 | Sandboxed Bash inherits open handle on CC executable (Linux) | NO-OP{NO-SURFACE} | NOT-AFFECTED |
| 3 | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` keeps structured-output format | **PORT-CANDIDATE** | **AFFECTED** (session-title half; prompt-hook half NO-SURFACE) |
| 4 | Revoked claude.ai login shows generic `API Error: 401` | **PORT-CANDIDATE** | **AFFECTED** |
| 5 | Skip-auth probes send different `Authorization` than real requests | NO-OP{NO-SURFACE} | NOT-AFFECTED |
| 6 | /feedback + /bug GitHub issue no longer embeds errors; consent lists them | **PORT-CANDIDATE** | **AFFECTED** |
| 7 | `--sparse` / `git-subdir` fail with "transport 'http' not allowed" | **PORT-CANDIDATE** | **AFFECTED** (conditional trigger) |

---

## Item 1 — Org per-tool permission ceilings silently dropped for MCP tool named `__proto__`

**Verdict: NO-OP{NO-SURFACE}. OCC NOT-AFFECTED.**

### Official fix (recovered verbatim)

v286 `LTn` @201927440 builds the org tool-permission-ceiling map with a plain object:

```js
function LTn(e){let n={};for(let r of e??[]){if(r.effective_max_permission===void 0)continue;
let s=zbn().safeParse(r.effective_max_permission);n[r.name]=s.success?s.data:"blocked"}
return Object.keys(n).length>0?n:void 0}
```

v287 `ZAn` @203991750 is byte-identical except the accumulator: `let n=Object.create(null)` —
THE FIX. With `{}`, a tool named `__proto__` makes `n[r.name]=…` write the prototype slot
instead of an own key: the ceiling for that tool is silently dropped (and `Object.keys` never
sees it), so an org "blocked"/restricted ceiling on `mcp__server____proto__` evaporates.

Evidence: needle `let n=Object.create(null)` in the ceiling-map function — v286 absent, v287
present @203991750; `org_ceiling` string v286=0 / v287=2 (new enforcement telemetry);
call site v287 @203995719 `toolPermissions:ZAn(xe.tools)`; consumer @230386803
`effectiveMaxPermission:v?.[H.name]`.

### OCC side

- `occ/src/services/mcp/claudeai.ts` (267 lines) is a simplified port of the claude.ai
  connector fetch: it does NOT parse `tools`, has no `toolPermissions` field.
- `rg "effective_max_permission|effectiveMaxPermission|toolPermissions" occ/src` → **0 hits**.

OCC has no org per-tool permission-ceiling surface at all → nothing to fix. If the ceiling
feature is ever ported, use `Object.create(null)` from day one.

---

## Item 2 — Sandboxed Bash on Linux inheriting an open handle on the Claude Code executable

**Verdict: NO-OP{NO-SURFACE}. OCC NOT-AFFECTED.**

### Official fix (recovered verbatim)

Official Linux sandbox keeps the ELF open on fd 3 for the seccomp applier:
`openSync("/proc/self/exe", 2097152)` (flag `O_RDONLY|O_CLOEXEC`-family constant 2097152),
applyPath `/proc/self/fd/3`, argv0 `apply-seccomp` — identical in both versions
(v286 `wce`/`iee`/`wHo`/`Sqn`; v287 `$Uo`/`Umn`/`fY`). Sandboxed children therefore inherit
an open handle to the executable. v287 adds two fd-closing wrappers:

Fix #1 — Bash-tool command wrapper, v287 @201088417 (NEW, v286=0):

```js
function FUo(e){return Umn()===void 0?e:`exec ${fY}<&- || exit 126; ${e}`}
```

applied before `je.wrapWithSandbox(FUo(Fn),...)` — i.e. when the sandbox fd exists, every
sandboxed Bash command starts with `exec 3<&- || exit 126; `.

Fix #2 — sandbox-exec shell lane, v287 @204147977 (NEW):

```js
NFn=`command exec ${Array.from({length:Vst-fY+1},(e,n)=>`${fY+n}<&-`).join(" ")} || exit 126; `
```

with `Vst=9`, `fY=3` → closes fds 3..9; used @204149172 `S=[LR,"-c",`${NFn}${e}`]`.

Novelty: `'<&-'` occurrences v286=5 / v287=8 (3 new = the two wrappers + shell idiom).

### OCC side

- `package.json:45`: `"@anthropic-ai/sandbox-runtime": "^0.0.44"` (patched) — OCC delegates to
  the external npm sandbox runtime; there is NO embedded seccomp applier.
- `rg "/proc/self/exe|apply-seccomp|applyPath" occ/src` → 0 hits.
- `sandbox-adapter.ts` `wrapWithSandbox` (@1501) and `Shell.ts` (@264) use the runtime's
  file-based `seccompFilterPath` — no persistent fd to the executable is ever opened, so
  nothing leaks to children.

NO-SURFACE: the bug requires the official's embedded `/proc/self/fd/3` mechanism.

---

## Item 3 — `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` not removing structured-output format (session-title + prompt-hook requests; Bedrock gateways reject)

**Verdict: PORT-CANDIDATE. OCC AFFECTED (session-title/side-query half). Prompt-hook half: NO-SURFACE.**

### Official fix (recovered verbatim)

The wire writer is identical in both versions (v286 `rIo` @203498206 / v287 `lNo` @205580585):

```js
function lNo(e,n,r,s){if(!e||"format"in n||!FSn(s)||!t_e(s,"structured_outputs"))return;
if(n.format=e,!r.includes(Uoe))r.push(Uoe)}
```

`Uoe` = beta `structured-outputs-2025-12-15`. The fix is inside the capability gate it calls.

v286 `yhn` @196798104 (BUGGY — never consults the env var):

```js
function yhn(e){let n=Ue(e),r=Fl(e);if(!zN(r))return!1;return!ar(n,"claude-opus-4-1")}
```

v287 `FSn` @198808640 (FIXED — adds the env/HIPAA arm):

```js
function FSn(e){let n=Be(e),r=lc(e);if(!H$(r))return!1;if(K4())return!1;return!lr(n,"claude-opus-4-1")}
```

with v287 `K4` @197699539 (the env gate; v286 had the same function as `sY` @195697287 but
`yhn` never called it):

```js
function K4(){return a.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS||UD()}   // UD(){return Il("hipaa")}
```

The gate flows to three places (all v287): beta-table entry
`{beta:Uoe,when:(e)=>{...FSn(e.model)&&n}}` @198811699; the `lNo` `output_config.format` body
write; sideQuery beta push @205187168
`let Ft=Boolean(S)&&ht(()=>FSn(We))&&t_e(We,"structured_outputs")`.
Session-title builders are structurally identical across versions
(v286 `b{...}` @209262289 → `sP({outputFormat:{type:"json_schema",schema:{...title...}},options:{querySource:"generate_session_title",...}})`; v287 @211455118 via `nO`) — the title request
carries the format through the same gate, which is why the flag now strips it.

Novelty proof: identifiers reused, but the `if(K4())return!1;` arm inside the
structured-outputs gate exists only in v287 (v286 `yhn` body verified byte-wise above).

### OCC side — AFFECTED

- `src/utils/betas.ts:160` `modelSupportsStructuredOutputs` — provider + model check ONLY, no
  env check → equals buggy v286 `yhn`. OCC has no hipaa arm (betas.ts:255-258 comment), so
  only the env var applies.
- `src/services/api/claude.ts:2162` writes `outputConfig.format = options.outputFormat`
  UNGATED (only the beta-header push at :2166 is gated) — second divergence: official gates
  BOTH via `FSn` inside `lNo`.
- `src/utils/sideQuery.ts:208` `...(output_format && { output_config: { format: output_format } })`
  — unconditional (beta push at :146-152 IS gated on `modelSupportsStructuredOutputs`).
- `src/utils/sessionTitle.ts:95` sends `outputFormat` via `queryHaiku` → hits the ungated
  write. This is exactly the Bedrock-gateway rejection path from the changelog.
- Prompt-hook half: OCC `hooks.ts` has no model-querying prompt-hook verification (only type
  decls @630-660) → NO-SURFACE for that half.

### Port instructions

1. `src/utils/betas.ts:160` — in `modelSupportsStructuredOutputs`, add an early
   `if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false`
   mirroring `FSn`'s `if(K4())return!1` (skip the hipaa arm — OCC doesn't have it; keep the
   existing comment style referencing 2.1.287 `FSn`/`K4`).
2. `src/services/api/claude.ts:2162` — gate the format WRITE on
   `modelSupportsStructuredOutputs(model)` (match `lNo` semantics: no format without the gate).
3. `src/utils/sideQuery.ts:208` — gate `output_config` on the same predicate (keep the beta
   push logic at :146-152 as-is; it already calls the predicate, which now also honors the env).
4. Tests: with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, session-title and sideQuery request
   bodies must contain neither `output_config` nor the `structured-outputs-2025-12-15` beta.

---

## Item 4 — Revoked claude.ai login shows generic `API Error: 401`; `-p` error now starts with "Failed to authenticate"

**Verdict: PORT-CANDIDATE. OCC AFFECTED.**

### Official fix (recovered verbatim)

v286 predicate `X7` @196280313 — 403 ONLY:

```js
function X7(e){return e instanceof It&&e.status===403&&(e.message?.includes("OAuth token has been revoked")??!1)}
```

v286 non-interactive message `aYn()`: "Your account does not have access to Claude. Please
login again or contact your administrator." (v286=2 / v287=0 — removed).

v287 predicate `PZ` @198284746 — adds the 401 arm:

```js
function PZ(e){if(!(e instanceof xt))return!1;let r=e.message??"";
return e.status===403&&r.includes("OAuth token has been revoked")
||e.status===401&&r.includes("OAuth access token has been revoked")}
```

v287 message function `Q3n` (print-mode arm is NEW):

```js
function Q3n(){return ke()?"Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.":Elt}
// Elt = "OAuth token revoked · Please run /login"   (interactive)
```

Call site v287 ~@207184860: `if(PZ(e))return ns({error:"authentication_failed",content:Q3n()})`.
Novelty: `"OAuth access token has been revoked"` v286=0 / v287=2;
`"Failed to authenticate: OAuth token revoked"` v286=0 / v287=1 (string-table hit confirmed in
this session's dump).

### OCC side — AFFECTED

`src/services/api/errors.ts`:
- :170 `TOKEN_REVOKED_ERROR_MESSAGE` — interactive message exists.
- :212-218 `getTokenRevokedErrorMessage()` — no `-p`/print-mode arm returning
  "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator."
- :867-878 and :1168-1175 — revocation checks are 403-ONLY (v286 shape); a revoked token
  surfacing as HTTP 401 falls through to generic `API Error: 401`.
- Unchanged upstream (verify-only, no edits): `withRetry.ts:1463`, `http.ts:129`,
  `fastMode.ts:535`.

### Port instructions

1. `errors.ts:867-878` and `:1168-1175` — extend each revocation predicate with
   `|| (error.status === 401 && error.message.includes('OAuth access token has been revoked'))`
   (keep the existing 403 + `"OAuth token has been revoked"` arm — official keeps both).
2. `errors.ts:212-218` — make `getTokenRevokedErrorMessage()` return the print-mode string
   when non-interactive (`ke()` equivalent = OCC's print/headless flag):
   `'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.'`
   Interactive arm stays `'OAuth token revoked · Please run /login'` (byte-check OCC's current
   constant against v287 `Elt` while there).
3. Tests: 401-with-revoked-message and 403-with-revoked-message both map to
   `authentication_failed`; `-p` output starts with "Failed to authenticate".

---

## Item 5 — Bedrock/Vertex/Mantle availability probes under `CLAUDE_CODE_SKIP_*_AUTH` send a different `Authorization` header than real requests when `ANTHROPIC_CUSTOM_HEADERS` repeats it

**Verdict: NO-OP{NO-SURFACE}. OCC NOT-AFFECTED.**

### Official fix (recovered verbatim)

v286 `bbe()` @195699002 — first `Authorization` entry wins (early return):

```js
function bbe(){let e=a.ANTHROPIC_AUTH_TOKEN;if(e)return`Bearer ${e}`;
let s=a.ANTHROPIC_CUSTOM_HEADERS;if(!s)return;
for(let r of s.split(/\n|\r\n/)){let n=r.indexOf(":");
if(n!==-1&&r.slice(0,n).trim().toLowerCase()==="authorization"){let i=r.slice(n+1).trim();if(i)return i}}return}
```

v287 `JSe()` @197701149 — shared ordered parser + `Object.fromEntries` → LAST wins, matching
the main request path (which builds a header object keyed by name, v286 `rlt()` @200472745 —
last-wins in both versions):

```js
function JSe(){let e=a.ANTHROPIC_AUTH_TOKEN;if(e)return`Bearer ${e}`;
let s,r=Object.fromEntries(Rje());
for(let[n,i]of Object.entries(r))if(n.toLowerCase()==="authorization")s=i;return s||void 0}
```

with `Rje(e=a.ANTHROPIC_CUSTOM_HEADERS??"")` @197699539 returning ordered `[name,value]`
pairs. Probe clients (bedrock/vertex, `max_tokens:1` messages.create, `wireAuthorization`
plumbing — v287 vertex `h` ~@215206k `r_e(o?{wireAuthorization:n}:!1)`, `n=JSe()`) are
structurally identical across versions; only the header-resolution semantics changed.
Call-site counts: `bbe(` v286=5; `JSe(` v287=10.

### OCC side

- `rg "probeBedrockModel|probeVertexModel|checkBedrockDefaultAvailability|checkVertexDefaultAvailability|model-access.json|provider-probe-verdicts|wireAuthorization" occ/src`
  → **0 files**. OCC has no 3p-model-memory probe subsystem.
- `getCustomHeaders()` `src/services/api/client.ts:503-527` builds a plain object keyed by
  header name → already last-wins (matches v287 semantics).
- Bedrock skip-auth `client.ts:237+` reuses `existingHeaders.Authorization`; Vertex skip-auth
  `client.ts:358-430` mocks GoogleAuth — single resolution path, no probe/request divergence
  possible.

NO-SURFACE (no probes) + ALREADY-ALIGNED (last-wins header semantics).

---

## Item 6 — /feedback and /bug: pre-filled GitHub issue no longer includes recent error messages; confirmation screen lists them

**Verdict: PORT-CANDIDATE. OCC AFFECTED.**

Changelog line 49 verbatim: "Fixed /feedback and /bug: the pre-filled GitHub issue no longer
includes your recent error messages, and the confirmation screen now lists them as part of
the report".

### Official fix (recovered verbatim)

v286 `lt(c,i,o,m)` @231760418 — 4 params (feedbackId, title, description, errors); body:

```
**Bug Description**\n${C}\n\n**Environment Info**\n- Platform/Terminal/Version/Feedback ID\n\n**Errors**\n```json\n${JSON.stringify(b(m))}\n```\n
```

plus overflow note `**Note:** Content was truncated.` (v286=3 / v287=0 — removed).

v287 `st(c,i,o)` @~234334584 — errors param DROPPED; description is a LINE ARRAY; new note:

```js
function st(c,i,o){let m=re(Cs(i),Et),v=Cs(o),F=Qme(),
f=`${Le}/new?title=${encodeURIComponent(m)}&labels=user-reported,bug&body=`,
_=encodeURIComponent(`**Bug Description**\n`),
R=encodeURIComponent(`\n\n**Environment Info**\n- Platform: ${a.platform}\n- Terminal: ${a.terminal}\n- Version: ${a.VERSION||"unknown"}\n- Feedback ID: ${c}\n`),
b=encodeURIComponent(v),X=Pt-f.length-_.length-R.length;
if(b.length>X){let H=encodeURIComponent(`…\n\n**Note:** The description was shortened to fit GitHub's link length limit. The full description was sent to Anthropic with the feedback report; its Feedback ID is below.`),
h=50,I=X-H.length-50;b="";
for(let le of v){let oe=encodeURIComponent(le);if(b.length+oe.length>I)break;b+=oe}b+=H}
return f+_+b+R}
```

v287 consent screen NEW row (after the Session transcript row):

```js
f!=="share"&&r(n,{children:["- Recent error messages:"," ",e(n,{dimColor:!0,
children:"up to the last 100 since you launched Claude Code (may include file paths)"})]})
```

Novelty: `"Recent error"` v286=0 / v287=2; `"up to the last 100"` v286=0 / v287=1
(@234332735); `"The description was shortened to fit"` v286=0 / v287=1;
`"Content was truncated"` v286=3 / v287=0.

### OCC side — AFFECTED

`src/components/Feedback.tsx`:
- :367-421 `createGitHubIssueUrl(feedbackId, title, description, errors)` = v286 shape:
  `bodyPrefix` embeds `\n**Errors**\n```json\n` (:373), old truncation note (:377),
  error-truncation budget math (:384-419).
- :257 call site `createGitHubIssueUrl(feedbackId ?? '', title, description, getSanitizedErrorLogs())`.
- :308-330 consent screen — lacks the "Recent error messages" row.
- :169-190 report POST still sends `errors: sanitizedErrors` to Anthropic — KEEP (official
  keeps it; only the GitHub link drops the errors).

### Port instructions

1. Rewrite `createGitHubIssueUrl` to the 3-param v287 form above (drop the `**Errors**`
   section + old note; description becomes a string[] of lines; per-line budget loop with the
   new note string, 50-byte slack constant).
2. Update call site :257 — drop `getSanitizedErrorLogs()` arg (errors still flow to the POST
   at :169-190 unchanged).
3. Add the consent-screen row after the Session transcript row:
   `- Recent error messages: up to the last 100 since you launched Claude Code (may include file paths)`
   (dimColor on the second segment; skip when share mode `f==="share"` equivalent).
4. Tests: URL never contains `**Errors**`; over-budget description ends with the new note;
   consent render snapshot includes the new row.

---

## Item 7 — `claude plugin marketplace add --sparse` / `git-subdir` fail with "transport 'http' not allowed" over plain http

**Verdict: PORT-CANDIDATE. OCC AFFECTED (conditional trigger — see reachability).**

### Root cause + official fix (recovered verbatim)

"transport 'http' not allowed" is git's own message (`fatal: transport 'http' not allowed`),
emitted when a lazy/partial-clone fetch is restricted to https:ssh. Official CC pins
`GIT_ALLOW_PROTOCOL` (base pins `zo`/`ze`, https:ssh seed) around its vetted git operations,
so a partial clone (`--filter=…`) over a plain-http remote dies at the follow-up
`sparse-checkout`/checkout step, which lazy-fetches blobs/trees from the promisor remote over
the blocked http transport. v287 fix: **only partial-clone when the URL transport is https or
ssh**; over http do a full (still `--depth 1`) clone with no lazy fetches.

NEW v287 transport parser `Se` @201495046 + predicate `F4n` @201495013
(allowlist `he=["https","ssh"]` @201494988):

```js
var mt=new Set(["diff","format-patch","log","show"]),he=["https","ssh"];
function F4n(e){return he.includes(Se(e))}
function Se(e){let n=/^[A-Za-z0-9][A-Za-z0-9+.-]*(?=::)/.exec(e)?.[0];if(n!==void 0)return n;
let r=/^([a-z][a-z0-9+.-]*):\/\//i.exec(e)?.[1];if(r!==void 0)return r==="git+ssh"||r==="ssh+git"?"ssh":r;
let s=e.indexOf(":"),o=e.indexOf("/");
return s===-1||o!==-1&&o<s||O()==="windows"&&/^[A-Za-z]:[\\/]/.test(e)?"file":"ssh"}
```

(handles git's `transport::command` helper form, normalizes `git+ssh`/`ssh+git`→`ssh`,
scp-like `user@host:path`→`ssh`, local paths/Windows drives→`file`.)

Marketplace clone — v286 `knr` @204886201: `if(h)H.push("--filter=blob:none","--no-checkout")`
vs v287 `slr` @206995523:

```js
if(h){if(F4n(e))j.push("--filter=blob:none");j.push("--no-checkout")}
else j.push("--recurse-submodules","--shallow-submodules");
```

git-subdir clone — v286 @205100094: `Se=[...,"clone","--depth","1","--filter=tree:0","--no-checkout"]`
vs v287 @207252449:

```js
Se=[...tMe,...G,...he,"clone","--depth","1",...F4n(w)?["--filter=tree:0"]:[],"--no-checkout"];
```

(`--no-checkout` stays unconditional in both paths; only the filter is gated.)

Schema describe text updated — v286: "Cloned sparsely using partial clone (--filter=tree:0) to
minimize bandwidth for monorepos." → v287 @196400580: "Checked out sparsely — over https or
ssh as a partial clone (--filter=tree:0) — to minimize bandwidth for monorepos."

Secondary half (diagnostics): v287 adds
`var gt=/^fatal: transport '([A-Za-z][A-Za-z0-9+.-]{0,31})' not allowed$/m` and, in the
partial-clone lazy-fetch retry handler, a stderr annotation
`Nothing was fetched: a partial clone's lazy fetch runs over ${R} only, and the promisor remote … is reached over ${k}…`
using a new `transports:h` field returned by the retry-env builder `Tt` (@201499864;
v286 `ht` @199425823 returns no `transports`). The retry builder's transport seed is
`["https","ssh"]` in BOTH versions (v287 just hoists it to `he`) — that region is a refactor +
better error text, not the fix.

Novelty counts (JS region): scheme regex `^([a-z][a-z0-9+.-]*)` v286=0 / v287=1;
`(?=::)` v286=0 / v287=1; `fatal: transport` v286=0 / v287=1; `transports:` v286=0 / v287=1;
"Cloned sparsely using partial clone" v286=1 / v287=0; "Checked out sparsely" v286=0 / v287=1.
(`F4n` as a bare identifier appears 23× in v286 — unrelated reused symbol; newness proven via
the novel parser, predicate body, and call sites.) `--sparse` 10→11 and `git-subdir` 23→27
extra sites are UI/catalogue code (plugin-directory walk @217732801, list labels
@232514138/@232514370, detail "Repository:" row @233146286) — not the fix.
`protocol.http.allow`/`http.allow`/`allow=always`/`-c protocol` = 0 in both; the
`protocol.allow` denylist regex is identical (1=1).

### OCC side — AFFECTED (conditional)

- `src/utils/plugins/marketplaceManager.ts:941` — `args.push('--filter=blob:none', '--no-checkout')`
  UNCONDITIONAL when `sparsePaths` non-empty (v286 shape). `--sparse` is live:
  `src/main.tsx:4725` registers `marketplace add --sparse`, `src/cli/handlers/plugins.ts:466`
  passes `sparsePaths`.
- `src/utils/plugins/pluginLoader.ts:752` — git-subdir `cloneArgs` contains unconditional
  `'--filter=tree:0'`.
- `src/utils/plugins/schemas.ts:1365` — still the v286 describe text.
- `src/utils/plugins/gitUrlValidation.ts:46` — OCC explicitly ALLOWS plain `http` git URLs
  ("https, http, ssh …"), so http marketplace sources are reachable.
- No transport parser exists (`rg "extractScheme|getScheme" src/utils` → 0; `redactGitUrl.ts`
  `isNonSshScheme` is redaction-specific, not reusable here).

**Reachability nuance (honest):** the literal failure needs the follow-up sparse-checkout /
lazy fetch to run under an http-blocking protocol policy. Official CC creates that policy
itself (base pins `zo`/`ze` incl. `GIT_ALLOW_PROTOCOL`, per OCC's own STAGED note in
`src/utils/plugins/gitSshCommand.ts:29-33`). OCC has NOT ported those pins, so with stock git
defaults a user-initiated lazy fetch over http succeeds and OCC won't hit the exact error
out-of-the-box. OCC DOES break identically when (a) the user's environment sets
`GIT_ALLOW_PROTOCOL`/`protocol.*.allow` (corporate hardening — the changelog's real-world
population), or (b) OCC later lands the STAGED base pins. The port is small, fidelity-keeping,
and pre-empts (b). The diagnostics half (lazy-fetch retry + `gt` regex + `transports` note) is
NO-SURFACE for OCC — the whole partial-clone retry subsystem is part of the STAGED git-env
hardening effort and has no OCC counterpart (`rg "GIT_NO_LAZY_FETCH" src` → comment-only).

### Port instructions

1. New util `src/utils/plugins/gitTransport.ts` — port `Se` verbatim as
   `gitUrlTransport(url: string): string` (replace `O()==="windows"` with
   `getPlatform() === 'windows'`) and `F4n` as
   `isPartialCloneTransport(url: string): boolean` = `['https','ssh'].includes(gitUrlTransport(url))`.
2. `marketplaceManager.ts` :941 — inside `if (useSparse)`:
   `if (isPartialCloneTransport(gitUrl)) args.push('--filter=blob:none'); args.push('--no-checkout')`
   (keep the existing comment; note the http full-clone fallback).
3. `pluginLoader.ts` :748-754 — build `cloneArgs` with
   `...(isPartialCloneTransport(gitUrl) ? ['--filter=tree:0'] : [])` between `'1'` and
   `'--no-checkout'`; update the docstring sequence (step 1) accordingly.
4. `schemas.ts:1365` — replace describe text with the v287 string:
   `'Checked out sparsely — over https or ssh as a partial clone (--filter=tree:0) — to minimize bandwidth for monorepos.'`
5. Tests: `gitUrlTransport` table (`https://x`→https, `http://x`→http,
   `git+ssh://x`→ssh, `ssh+git://x`→ssh, `git@host:p`→ssh, `/local/path`→file,
   `C:\repo`→file on windows, `ext::cmd`→ext); gitClone arg-builder asserts no `--filter=` for
   `http://` URLs and `--filter=blob:none` for `https://`; git-subdir likewise for `tree:0`.

---

## Recommended port order (all binary-verbatim, disjoint files → parallelizable)

1. **Item 4** (errors.ts only — security-visible auth UX; smallest diff).
2. **Item 3** (betas.ts + claude.ts + sideQuery.ts — Bedrock gateway breakage).
3. **Item 6** (Feedback.tsx only).
4. **Item 7** (new gitTransport.ts + marketplaceManager.ts + pluginLoader.ts + schemas.ts).

Items 1/2/5: record NO-OP{NO-SURFACE} in the gap doc; no code. Item 7 diagnostics half and
the lazy-fetch retry subsystem stay STAGED with the git-env hardening effort.

*Report generated by Cluster-B research subagent, OCC-105. All offsets are absolute byte
offsets into the respective `package/claude` ELF; all code blocks are verbatim recoveries
from those bytes (minified identifiers as-is). Nothing herein was invented; unrecoverable
portions are explicitly marked.*
