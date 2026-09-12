# Upstream Version Gap — OCC-122 (official 2.1.267 → 2.1.268)

- **Round:** OCC-122 (autopilot 版本追齐, 2026-09-12)
- **OCC aligned-at (round start):** official Claude Code `2.1.267` — OCC release `2.1.329` (E1 effort-cap completed in OCC-82 round)
- **Official latest (round start):** `2.1.268` (npm dist-tags: `latest` = `next` = `2.1.268`, modified 2026-09-10T20:35Z; `stable` = `2.1.236`)
- **Method:** `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.267,2.1.268}` → `strings -n 8 | sort -u` → `comm` diff → fixed-substring/regex window extraction on the minified JS (`ctx.py` + python byte probes) → byte-verify → LAND / NO-OP / STAGED verdicts.
- **Binary sha256:**
  - v267: `0399c793ff571d5946ef923d80b4f330d05ac4b6842a6b0775468f5d389403c0` (matches OCC-121 ledger)
  - v268: `9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653`
- **Strings diff:** 14,343 added / 12,324 removed.
- **Official 2.1.268 changelog:** 96 bullet entries (E1–E96 in changelog order, `entries.txt`).

**Verdict summary:** 8 LAND (E5, E9, E22, E23, E37, E42, E50, E59 — all byte-verified against the v268 ELF), 22 STAGED (surface exists in OCC but mechanism is opaque in the strings diff or subsystem-sized), 66 NO-OP (surface absent from OCC by design or mechanism not string-visible).

---

## 1. Landed this round (byte-verified official implementations)

### E5 — `configDirectory` in `occ auth status --json`

Official v268 (`configDirectory` count: v267=0, v268=2):

```js
s={loggedIn:C,authMethod:p,apiProvider:E,analyticsDisabled:jg(),projectsDirectory:x(),configDirectory:we()}
```

OCC surface: `src/cli/handlers/auth.ts` `authStatus()` JSON branch (OCC base object is `{loggedIn, authMethod, apiProvider}` — `analyticsDisabled`/`projectsDirectory` are pre-existing trims from earlier rounds; OCC analytics is an empty implementation). **Delta port:** add `configDirectory: getClaudeConfigHomeDir()` (`src/utils/envUtils.ts` — OCC's canonical config-dir getter, CLAUDE_CONFIG_DIR-aware).

### E9 — WebFetch overall 300 s deadline (+ `CLAUDE_CODE_WEBFETCH_DEADLINE_MS`, EDEADLINE, EDEADLINE_PREFLIGHT, 303 alignment)

Official v268 (all absent from v267: `tengu_webfetch_deadline_ms`=0, `CLAUDE_CODE_WEBFETCH_DEADLINE_MS`=0, `EDEADLINE`=0):

```js
var Lis=2000,Fis=10485760,$is=60000,MYn=300000;
function $Yn(){let e=a.CLAUDE_CODE_WEBFETCH_DEADLINE_MS;if(e!==void 0)return Math.min(e,xh);
  let n=I("tengu_webfetch_deadline_ms",MYn);
  return typeof n==="number"&&Number.isFinite(n)&&n>=0?Math.min(n,xh):MYn}
// xh=2147483647 (INT32_MAX timer cap, same module scope)
async function Gis(e,n,r,o=0,d){if(d!==void 0)return bWe(e,n,r,o,d);
  let p=$Yn();
  if(p===0)return bWe(e,n,r,o,new AbortController().signal);
  let _=Zi(void 0,{timeoutMs:p,refTimer:!0});
  try{return await bWe(e,n,r,o,_.signal)}finally{_.cleanup()}}
// bWe: st.get(e,{signal:AbortSignal.any([n,d]),timeout:$is,maxRedirects:0,...}).catch(P=>{
//   if(st.isCancel(P)&&d.aborted&&!n.aborted)
//     throw new Ivt(`Fetch did not complete within the ${$Yn()/1000}s deadline`,"EDEADLINE"); ...})
class Ivt extends Error{code;constructor(e,n){super(e);this.name="WebFetchTransportError",this.code=n}}
// preflight: case"check_failed":throw new e_t(Te,st.isCancel(Pe.error)?"EDEADLINE_PREFLIGHT":void 0)
// e_t = DomainCheckFailedError, v268 adds the `code` ctor param (v267 Ygt has none)
var Wis=new Set([301,302,303,307,308]);
```

OCC surface: `src/tools/WebFetchTool/utils.ts` — `FETCH_TIMEOUT_MS=60_000` per hop, `getWithPermittedRedirects` recursion, **no overall deadline**. Port:
1. `getWebFetchDeadlineMs()`: env `CLAUDE_CODE_WEBFETCH_DEADLINE_MS` → `Math.min(Number(env), 2_147_483_647)`; else default `300_000` (official statsig gate `tengu_webfetch_deadline_ms` defaults to 300000; OCC has no statsig — same trim as prior rounds).
2. `getURLMarkdownContent` wraps the whole `getWithPermittedRedirects` redirect chain in a deadline controller (`0` disables — never-aborting controller, matching `Gis`).
3. `getWithPermittedRedirects` gains an optional `deadlineSignal`: axios call uses `AbortSignal.any([signal, deadlineSignal])`; on cancel caused by the deadline (not the caller) throw `WebFetchTransportError(\`Fetch did not complete within the ${deadlineMs/1000}s deadline\`, 'EDEADLINE')`.
4. `DomainCheckFailedError` gains the optional `code` param; preflight `check_failed` passes `'EDEADLINE_PREFLIGHT'` when the underlying error is an axios cancel.
5. Redirect set aligned to `[301, 302, 303, 307, 308]` — note: official had 303 already in v267 (`bZo=new Set([301,302,303,307,308])`), so this closes a pre-existing OCC divergence, not a v268 delta.
Not ported (out of E9 scope): v268's `tengu_web_fetch_transport` telemetry re-wrap of every axios error (`if(st.isAxiosError(P)&&!st.isCancel(P))throw new Ivt(P.message,P.code)`) — telemetry subsystem, and `WebFetchTransportError` already existed in v267 (4 hits both versions), so OCC's absence is a pre-existing divergence documented here; OCC adds the class only as the EDEADLINE carrier.

### E22 — MCP OAuth callback port: OS-assigned ephemeral fallback before giving up

Official v268:

```js
async function IJ(t,e=w){let i=y();if(i)return i;if(t&&await l(t))return t;
  let{min:n,max:r}=e.range,o=r-n+1,d=Math.min(o,100);
  for(let u=0;u<d;u++){let p=n+Math.floor(Math.random()*o);if(await l(p))return p}
  if(await l(e.fallback))return e.fallback;
  let s=await g(0);              // NEW: listen(0) on 127.0.0.1 → OS-assigned port
  if(s!==void 0)return s;
  throw Error("No available ports for OAuth redirect")}
```

OCC surface: `src/services/mcp/oauthPort.ts` (79 lines) — has env override, preferred port, 100 random attempts, `REDIRECT_PORT_FALLBACK=3118`, then throws. **Missing only the `g(0)` step.** Port: `tryAssignEphemeralPort()` (http server `listen(0, '127.0.0.1')` → read `address().port` → close) attempted after the 3118 fallback and before the throw.

### E23 — `/compact` summary `$`-sequence mangling fix

Official v267 (buggy — identical to OCC's current `formatCompactSummary`):

```js
function Jms(e){let n=e;n=n.replace(/<analysis>[\s\S]*?<\/analysis>/,"");
  let r=n.match(/<summary>([\s\S]*?)<\/summary>/);
  if(r){let o=r[1]||"";n=n.replace(/<summary>[\s\S]*?<\/summary>/,`Summary:\n${o.trim()}`)}
  return n=n.replace(/\n\n+/g,`\n\n`),n.trim()}
```

Official v268 (fixed — replacement **callback**, so `$` patterns in the captured content are inserted literally instead of being interpreted as `$&`/`$'`/`` $` ``/`$1` replacement patterns):

```js
function wws(e){let n=e;return n=n.replace(/<analysis>[\s\S]*?<\/analysis>/,""),
  n=n.replace(/<summary>([\s\S]*?)<\/summary>/,(r,o)=>`Summary:\n${o.trim()}`),
  n=n.replace(/\n\n+/g,`\n\n`),n.trim()}
```

OCC surface: `src/services/compact/prompt.ts` `formatCompactSummary` — has the exact v267 bug (match + template-string replace). Port: replace with the callback form.

### E37 — WebFetch dotless-hostname error + description note

Official v268 (`without a dot`: v267=0, v268=6):

```js
async function jvn(e,n,r,o,d,p){if(!His(n)){
  let Te=URL.parse(n)?.hostname;
  if(Te&&!Te.includes("."))throw new C("WebFetch cannot fetch localhost or other hostnames without a dot. To reach a local server, use Bash with curl instead.","web-fetch-dotless-host");
  throw new C("Invalid URL","web-fetch-invalid-url")} ...}
```

Description (`Me()` long variant, usage-notes bullet between the HTTPS-upgrade line and the prompt line):

```
  - localhost and other hostnames without a dot are not supported; for a local server, use curl via Bash
```

OCC surface: `src/tools/WebFetchTool/utils.ts` `getURLMarkdownContent` (`if (!validateURL(url)) throw new Error('Invalid URL')` — `validateURL` is OCC's `His` equivalent incl. the ≥2 hostname-parts check) and `prompt.ts` `DESCRIPTION`. Port: dotless branch with the byte-exact message before the generic Invalid URL throw; add the description bullet at the official position.

### E42 — SessionEnd hook timeout: per-hook env default + overall budget clamp

Official v268:

```js
var zir=1500,xHs=60000;
function Wir(){return a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS??zir}   // per-hook default
function Wge(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;if(e!==void 0)return e;
  let n=0,r=wh()?[]:que()?.SessionEnd??[],o=[...oee()?.SessionEnd??[],...r];
  for(let d of o)for(let p of d.hooks)if(p.timeout&&p.timeout*1000>n)n=p.timeout*1000;
  return Math.max(zir,Math.min(n,xHs))}                                  // overall budget
```

(v267 baseline `Nme()` had the `if(e!==void 0&&e>0)return e;` guard — v268 dropped `>0` and split per-hook `Wir()` from overall `Wge()`.)

OCC surface: `src/utils/hooks.ts` — single `getSessionEndHookTimeoutMs()` (`parseEnvInt`, `Number.isFinite&&>0` guard, default 1500) used as BOTH per-hook default and overall cap. Port: two-function design — per-hook `getSessionEndHookTimeoutMs()` = env ?? 1500 (v268 drops the `>0` guard; NaN/invalid env still falls back), overall `getSessionEndHooksBudgetMs()` = env ?? clamp(max per-hook `timeout*1000` across configured SessionEnd hooks, [1500, 60000]); wire the budget into `gracefulShutdown.ts` failsafe resolution.

### E50 — auto-mode denial message: "first try a safer method" tail

Official v268 (byte-verified; v267's auto-mode path used the old `LOr` tail):

```js
var ANt="IMPORTANT: You *may* attempt to accomplish this action using other tools ... behind this denial. ",
LOr=ANt+"If you believe this capability is essential to complete the user's request, STOP and explain ...",   // still used by LDn/MQ (AUTO_REJECT / DONT_ASK)
Tjs=ANt+"If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.";
function H5t(e,n){let r=QKe,o=n?.autoModeConsentFlow?Ejs:Tjs,
  d=`${r}${e}. If you have other tasks that don't depend on this action, continue working on those. `+o;
  if(!Zvr()||EM())return d;return`${d} ${"To allow this type of action in the future, the user can add a Bash permission rule to their settings."}`
```

OCC surface: `src/utils/messages.ts` `buildYoloRejectionMessage` — currently uses `DENIAL_WORKAROUND_GUIDANCE` (ANt + old LOr tail) for the classifier denial. Port: new `AUTO_MODE_DENIAL_GUIDANCE` constant = OCC's ANt text + the v268 Tjs tail, used ONLY in `buildYoloRejectionMessage`; `DENIAL_WORKAROUND_GUIDANCE` unchanged for `AUTO_REJECT_MESSAGE`/`DONT_ASK_REJECT_MESSAGE` (official `LDn`/`MQ` still use `LOr` — verified). Not ported: the `Ejs` consent-flow variant (autoModeConsentFlow is part of the absent consent/batch-ask subsystem) and the changelog's "names the rule that blocked the action" half (no rule-naming string is visible in the v268 binary — the reason text comes from classifier output; opaque, noted in §2).

### E59 — todo tools: denylist → model allowlist + Bedrock inference-profile bypass

Official v267 (denylist — what OCC currently implements, aligned at 2.1.233):

```js
var XTo=[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]],QTo="tengu_rosy_wren";
function JTo(e){return!Tje(e,XTo)}
function $O(){if(ol()||_1n())return!0;let e=_2e();if(e===void 0||JTo(e))return!0;
  if(a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0)return!0;return I(QTo,!1)===!0}
```

Official v268 (allowlist):

```js
var JAo=new Set(["claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-3-5-sonnet","claude-3-5-haiku",
  "claude-3-7-sonnet","claude-opus-4-0","claude-opus-4-1","claude-opus-4-5","claude-opus-4-6","claude-opus-4-7",
  "claude-sonnet-4-0","claude-sonnet-4-5","claude-sonnet-4-6","claude-haiku-4-5"]);
function eRo(e){return JAo.has(e)}
function tRo(e){return e.includes("application-inference-profile")}
function dD(){if(pl()||Ozn())return!0;let e=Kze();
  if(e===void 0||tRo(e)||eRo(e))return!0;
  return a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}
function kK(){return j_()&&dD()}
```

OCC surface: `src/utils/todoToolsAvailability.ts` (v267-shaped denylist + documented `tengu_rosy_wren` trim). Port: replace the denylist regex/threshold logic with the v268 allowlist Set (exact 15 model ids) + `application-inference-profile` substring bypass (Bedrock inference profiles); keep the documented trims (`pl()/Ozn()` early-true gates = bg-session/SDK surfaces absent from OCC; rosy_wren gate removed in v268 anyway); keep `CLAUDE_CODE_ENABLE_TODO_TOOLS` env override (`isEnvTruthy`, OCC's byte-equivalent bool parse). Update `todoToolsAvailability233.test.ts` → 268 expectations.

## 2. Staged (surface exists in OCC; mechanism opaque in strings diff or subsystem-sized)

| Entry | Subject | Rationale |
|---|---|---|
| E10 | respawned in-process teammate trust gating | OCC teammate spawn is daemon-based (different architecture); needs dedicated decompilation of the trust-check site |
| E11 | idle-session busy-loop CPU fix | runtime timer/poll internals — no string-visible delta |
| E13 | deny/ask rules on symlinked dirs (`/etc`,`/tmp`,`/var`; `/bin`) by real path | permission-checker path-resolution subsystem; security-relevant → next-round priority with per-site decompilation |
| E14 | deny rule bypass via `env -C`/`eval` on same command line | same subsystem as E13; OCC's bash AST/legacy splitters need behavior verification first |
| E15/E16 | secrets redaction in plugin/marketplace/`/mcp`/`mcp list`/`get`/login errors | official central redactor (`[redacted]`, `wordBoundary`) is NEW/extended in v268 (v267: `wordBoundary===!0`×0 → v268 ×1; `[redacted]` ×5 → ×10) and **absent from OCC entirely** (0 files); porting the redactor subsystem is multi-surface; security-positive → top next-round priority |
| E17 | SDK `excludeDynamicSections` mid-session cache/thinking break | OCC has the flag; fix is first-message re-render behavior — needs SDK session harness + decompilation |
| E24 | `/compact`-ended conversation resume: restored-file notes order | ordering fix not string-visible |
| E25 | SDK prompt suggestions/side questions/`/rename` sending pre-compaction conversation | SDK subsystem; opaque |
| E26 | `@`/`/` suggestions after up-arrow recall + edit | PromptInput suggestion-trigger internals; opaque |
| E27 | `claude agents` ← debounce ignoring presses | TUI input timing; opaque |
| E28 | agents session-delete stuck on unremovable worktree | OCC `occ agents` surface differs (daemon); needs per-site work |
| E29 | agents panel row expansion on line breaks | TUI rendering; opaque |
| E32 | spinner multi-line wrap with long task label | TUI rendering; opaque |
| E33 | `/bug`/`/feedback` description cursor | TUI cursor rendering; opaque |
| E38 | PermissionRequest hooks not firing in `--print` | OCC has PermissionRequest hook type; firing-path fix opaque in strings |
| E40 | `/resume` listing `/fork` bg session under parent name | OCC has fork naming (`src/commands/fork/name.ts`); resume-list wiring opaque |
| E45 | Bash sandbox instruction over-statement | prompt-text deltas need per-string byte extraction; sandbox prompt subsystem |
| E46 | fullscreen Shift+Enter repaint perf | Ink render internals |
| E47 | `--continue`/`--resume` before SessionStart hooks | startup ordering rework; behavioral risk needs its own round |
| E48 | hidden per-tool-batch reminder transcript redraw | render-path; opaque |
| E49 | `.claude/workflows/` listing no longer parses each script | OCC workflow discovery may parse at list time; perf fix, mechanism opaque |
| E50 (partial) | "names the rule that blocked the action" | no rule-naming string visible in v268 binary; classifier reason-side change — opaque |
| E54 | prompt-footer editor/`/diff` selection display | footer UI rework; Remote Control half absent |
| E57 | Bedrock/Vertex/Foundry system prompt as attachments | provider prompt subsystem rework; large |
| E58 | 3P tool-list byte-stability (deferred late-connecting tools) | coupled to E57; large |
| E12 | "your message came through empty" after MCP tool call | string absent from added.txt; mechanism not visible |

## 3. No-op (subsystem absent from OCC or not portable)

| Entries | Reason |
|---|---|
| E1, E2, E3 | Claude apps gateway — absent from OCC (prior ledgers) |
| E4 | `self-hosted-runner` — OCC has a 3-line stub |
| E6 | `claude plugin install/uninstall/update/enable/disable --json`, `plugin list` details — OCC plugin CLI is trimmed (no such subcommand surface; validated: no `validate`/`--json` in `pluginCliCommands.ts`) |
| E7 | browser-tab icons for published artifacts — artifact-publish subsystem absent |
| E8 | 3P-endpoint HTTP 400 regression from the Artifact tool's internal regex (introduced 2.1.265) — OCC has no Artifact tool, never received the bug |
| E18, E19 | model-access cache staleness (claude.ai entitlement) — model-access cache subsystem absent |
| E20 | Fable long-context 429 → usage-credits consent prompt — usage-credits subsystem absent |
| E21 | workload-identity-federation `jti` replay — `jti` 0 hits in OCC; WIF profile sharing absent |
| E30 | Claude in Slack — absent |
| E31 | Claude in Chrome extension host "https" allow — Chrome-extension surface absent |
| E34 | Remote Control `ListAgents` naming — Remote Control client absent |
| E35 | `claude plugin validate` dot-dot directory rejection — OCC has no `plugin validate` subcommand (trimmed plugin CLI) |
| E36 | plugin default monitors / root SKILL.md skip — trimmed plugin loader surface |
| E39 | policy-helper warnings on `-p` runs — policy-helper absent (0 hits) |
| E41 | `/remote-control` claude.ai-gated command hints — Remote Control absent |
| E43, E44 | cloud-session commands (`/autofix-pr`, `/teleport`, `/remote-env`) — cloud sessions absent |
| E51 | Claude in Chrome inline page reads — absent |
| E52 | MEMORY.md truncation warning detail — OCC's agent MEMORY.md surface has no index-truncation warning (the official memory-index limit subsystem is absent) |
| E53, E60 | artifact permission prompt card — artifacts absent |
| E55 | usage-credits 1M-context message — absent |
| E56 | `/plugin` menu immediate activation — plugin UI trimmed |
| E61, E62 | Cowork local sessions / Artifact tool permission rules — Cowork + Artifact absent |
| E63 | "N MCP servers need authentication" once-per-server notice — OCC has no such startup notice (grep: only an IDE comment in client.ts) |
| E64–E76 | [VSCode] extension — absent |
| E77–E79 | [Claude Code on the web] — absent |
| E80–E92 | [Claude Tag / Slack] — absent |
| E93–E96 | [Code Review] GitHub app — absent |

## 4. Verification

(to be filled after implementation: unit tests, build, lint, REPL e2e, `-p` roundtrip, `--version`)
