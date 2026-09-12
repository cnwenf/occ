# Upstream Version Gap — OCC-83 (official 2.1.267 → 2.1.268)

- **Round:** OCC-83 (autopilot 版本追齐, 2026-09-12)
- **OCC aligned-at (round start):** official Claude Code `2.1.267` — OCC release `2.1.329`
- **Official latest (round start):** `2.1.268` (npm dist-tags: `latest` = `next` = `2.1.268`)
- **Method:** `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.267,2.1.268}` → `strings -n 8 | sort -u` → `comm` diff → fixed-substring window extraction on the string dumps (`grep -boF` + `dd`; the v268 ELF stores its JS bundle compressed, so the sorted strings dumps are the extraction surface) → byte-verify → LAND / NO-OP / STAGED verdicts. Per `aligning-with-official-binary`: nothing invented — every landed string is byte-verified against the official binary; anything ambiguous is STAGED with forensics.
- **Binary sha256:**
  - v267: `0399c793ff571d5946ef923d80b4f330d05ac4b6842a6b0775468f5d389403c0`
  - v268: `9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653`
- **Strings diff:** 14,343 added / 12,324 removed.
- **Official 2.1.268 changelog:** 96 bullet entries (numbered E01–E96 below in changelog order).

**Verdict summary:** LAND 12 (E05, E13, E16, E23, E26, E32, E35, E37, E50, E52, E59, E63 — all landed this round) · STAGED 13 (E06, E11, E12, E14, E22, E38, E40, E45, E47, E55, E56, E57, E58 — forensics captured below) · NO-OP 71 (everything else — subsystem absent from OCC, already-fixed, or not client-attributable).

---

## 1. Landed this round

### Gap-83a — E13: deny/ask rules on symlinked directories (`/etc`, `/tmp`, `/var`; `/bin` on Linux)

Official changelog: *"Fixed deny and ask permission rules on symlinked directories (`/etc`, `/tmp`, `/var` on macOS; `/bin` on Linux) not applying when a path was given by its real location, and Bash commands ignoring deny rules written on a symlinked path spelling."*

**Security-positive.** OCC had both official-267 holes: (1) `matchingRuleForInput` matched only the literal rule spelling — a deny rule written `/etc/**` missed input given as the real location, and (2) `isPathAllowed`'s deny step ran `matchingRuleForInput` on the SINGLE canonical resolved path, so Bash path validation ignored deny rules written on a symlinked spelling.

Byte-verified official v268 evidence — new `physicalTwinsByPattern` memo (0→3 hits) plus resolver `zp` and the rule-compiler registration (`Yr`; absent from v267's `Gr`):

```js
function zp(e,n){if(M()==="windows"||!n.startsWith("/"))return null;let r=n.slice(1).split("/"),o=0;
while(o<r.length&&r[o]!==""&&!jp.test(r[o]))o++;if(o===0)return null;
let d=Oe(e,...r.slice(0,o).map(qat)),p;try{p=wC(le(),d)}catch(v){return t(`Could not resolve the physical twin of rule prefix ${d}: ${v}`),null}
if(p===void 0||p===d||p===Ie)return null;let _=r.slice(o),
L=fn(Rte(p,{escapeGlobs:!0})+(_.length>0?"/"+_.join("/"):"")),x=qn(L,!1);
if(zo(x)!==null||x!==L&&x+"/**"!==L)return null;return L}

// Yr rule compiler, per rule:
let ie=zp(q,J);if(ie!==null)ee.add(ie);for(let ue of ee){let oe=R(Ie).patternMap;if(!oe.has(ue))oe.set(ue,D)}
```

Supporting pieces: equivalences table `Yp()` (unchanged 267↔268 — pairs `["/private/tmp","/tmp"],["/private/var","/var"],["/private/etc","/etc"],["/usr/bin","/bin"],["/usr/lib","/lib"],["/usr/sbin","/sbin"]`, each registered only when `realpathSync(physical)===symlinked`); `jp=/(?:^|[^\\])(?:\\\\)*[*?[]/` glob-metachar prefix scan; `qat` segment unescaper (escapable class `[\]!#()|+^$*?\s` + backslash); `Rte({escapeGlobs:true})` escaper; `fn` slash-collapse (BOM-aware); `qn` trailing-globstar normalizer; `zo` unusable-pattern probe (blank / comment / trailing-backslash). Officials' rule for who gets twins: `if(L||q===null)continue` — allow rules and null-root rules get NO twins; twins register under root `/` additively (`if(!oe.has(ue))oe.set(ue,D)` — never overwrites an existing literal rule).

**OCC change (three parts):**

1. NEW `src/utils/permissions/symlinkEquivalences.ts` — faithful ports: `getTrustedSymlinkEquivalences()` (`Yp`, realpath-guarded, cached), `toTrustedSymlinkSpelling()` (`jxt` real→symlink mapper), `unescapePatternSegment` (`qat`), `escapePatternPath` (`Rte` escapeGlobs), `collapsePatternSlashes` (`fn`), `normalizeTrailingGlobstar` (`qn`), `unusablePatternReason` (`zo`), `makePhysicalTwinsKey`/`getOrInitPhysicalTwins` (memo keyed `${root}\x00${pattern}`), and `resolvePhysicalTwinPattern` (`zp` — Windows guard, literal-prefix scan, component-wise `resolveDeepestExistingAncestorSync` with catch→debug log `"Could not resolve the physical twin of rule prefix ${prefixPath}: ${error}"`, null when already-physical/nonexistent/root, round-trip usability guards).
2. `src/utils/permissions/filesystem.ts` `getPatternsByRoot` — after compiling each literal pattern, deny/ask rules only (`behavior === 'allow' || root === null → continue`, the official `if(L||q===null)continue`), resolve the twin and register every memoized twin under root `/` additively (`if (!rootSlashPatterns.has(twinPattern))`).
3. `src/utils/permissions/pathValidation.ts` `isPathAllowed` — step-1 deny check now iterates EVERY spelling from `getPathsForPermissionCheck(resolvedPath)` (falling back to computing it when `precomputedPathsToCheck` is absent), mirroring the official multi-spelling deny iteration; a canonical single-spelling input degenerates safely.

Tests: `src/utils/permissions/__tests__/symlinkTwins268.test.ts` (29 — helper ports, `zp` resolver incl. glob-escaping through `link3 -> star*dir`, Windows guard, twin registration semantics incl. allow-rules-get-no-twin, and end-to-end `isPathAllowed`/`validatePath` deny matching in both directions on a live symlink farm).

**Documented divergences:**

1. Rule-content spelling note: the official absolute-path rule form is `Tool(/` + abs path + `)` — e.g. `Read(//tmp/x/**)` (`//` = root marker + the path's leading slash). OCC's `patternWithRoot` handles the same form; a triple-slash spelling (`Read(///tmp/...)`) yields a `//tmp/...` relativePattern that the ignore library never matches — the twin path survives it only because `zp` runs `fn` slash-collapse first.
2. OCC applies twins at pattern-compile time inside `getPatternsByRoot` (its WeakMap-cached matcher compile), not in a separate rule-compiler object; observable matching contract is equivalent (literal spelling keeps working; twin is additive; first registration wins).
3. `resolveDeepestExistingAncestorSync` resolves the longest existing ancestor and readlinks component-wise (official `wC(le(),d)`); a fully-nonexistent prefix returns null (fail-closed to literal-only), matching official.

### Gap-83b — E16: `${VAR}` secrets leaked in `/mcp`, `mcp list`/`get`, and MCP login errors

Official changelog: *"Fixed `/mcp` and `/plugin` server details, `claude mcp list`/`get`, and MCP login errors showing secrets resolved from `${VAR}` placeholders in MCP configs."*

**Security-positive.** OCC printed fully-expanded url/headers/env in cleartext (`mcpListHandler`/`mcpGetHandler` in `src/cli/handlers/mcp.tsx`).

Byte-verified official v268 evidence — NEW splitter `Tat` and secret-recovery chain (`mcp-endpoint` 0→2, `redaction failed` 0→2, `wordBoundary` 0→7; the whole recovery engine is absent from v267):

```js
function Tat(e){let n=[],o=0;for(let r of e.matchAll(new RegExp(Yce,"g")))n.push(e.slice(o,r.index)),o=r.index+r[0].length;return n.push(e.slice(o)),n}
function JGo(e,n){if(!e||!n||!e.includes("${"))return[];let r=Tat(e);if(r.length<2)return[];if(n.length>2000||r.length>9)return[];…}
```

`JGo(template, expanded)` recovers exactly the substrings that came from `${VAR}` expansion (prefix/suffix matching for 1–2 placeholders; anchored regex captures for more; guards ≤2000 chars, ≤9 segments). `ezo(authored, resolved)` walks the server-config pair (url, command, pairwise args, headers, env).

**OCC change:** NEW `src/services/mcp/redaction.ts` (1027 lines) — byte-faithful ports of `ENV_VAR_PATTERN` (`Yce`), `hasEnvVarRefs` (`aX`), `splitEnvVarSegments` (`Tat`), `redactEnvVarPlaceholders` (`Cat`, `"x".repeat(n.length)` masking), `normalizeEnvVarRefs` (`vte`), `recoverExpandedSecrets` (`JGo` incl. guards), `collectConfigSecrets` (`ezo`), plus the display/error redaction engine (recovered secrets ≥4 chars → `[redacted]`; url origin/host/user/pass/path/query params; credential-name regexes `KGo`/`YGo` = bearer|basic|token|key|secret|password|authorization|credential; error-detail fallback `"[mcp error detail unavailable: redaction failed]"` with `[mcp-endpoint]` placeholder). `src/services/mcp/config.ts` now keeps an authored (unexpanded) copy of each server config alongside the expanded one; `mcp.tsx` list/get print authored values with placeholder masking; `utils.ts`, `MCPRemoteServerMenu`/`MCPStdioServerMenu`, and `mcpPluginIntegration` route display/error strings through the redactor. Tests: `src/services/mcp/__tests__/mcpSecretRedaction268.test.ts` (55) + `mcpSlice218.test.ts` updates.

**Documented divergences:**

1. The official engine's full NFKC/percent-decode/surrogate normalizer and `wordBoundary` refinement are ported in reduced form (literal-substring + word-boundary replacement) — OCC's display surface is simpler; the recovered-secret contract (which values are redacted) is byte-equivalent.
2. `/plugin` server-details surface: OCC's plugin MCP display routes through the same redactor where configs are printed; plugin surfaces OCC trimmed stay trimmed.

### Gap-83c — E23: `/compact` summary mangling `$` sequences

Official changelog: *"Fixed the conversation summary produced by `/compact` and auto-compact mangling text that contained `$` sequences."*

Byte-verified official v268 evidence (`wws` vs v267 `Jms`): the `<summary>` replacement switched from a replacement STRING to a replacer FUNCTION —

```js
// v267: n.replace(/<summary>[\s\S]*?<\/summary>/,`Summary:\n…${o}…`)   ← $&, $', $`, $1…$99, $$ interpreted
// v268: n=n.replace(/<summary>([\s\S]*?)<\/summary>/,(r,o)=>`Summary:\n…`)  ← $ literal
```

**OCC change:** `src/services/compact/prompt.ts` `formatCompactSummary` — the identical v267 bug at the `<summary>` splice collapsed into a single `replace(/<summary>([\s\S]*?)<\/summary>/, (_m, g) => …)` replacer function (OCC's local `.trim()` kept). Tests: `src/services/compact/__tests__/compactSummaryDollar268.test.ts` (`$&`, `$'`, `` $` ``, `$1`, `$$` literal passthrough + `<analysis>`-strip regression).

### Gap-83d — E59: task-tracking tools restricted to a model allowlist

Official changelog: *"Changed the task-tracking tools (TaskCreate/Get/Update/List, TodoWrite) to be offered only on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5; set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` elsewhere."*

Byte-verified official v268 evidence — new `JAo` allowlist (0 hits in v267; `tengu_rosy_wren` GrowthBook consult 2→0):

```js
var JAo=new Set(["claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-3-5-sonnet",
"claude-3-5-haiku","claude-3-7-sonnet","claude-opus-4-0","claude-opus-4-1","claude-opus-4-5",
"claude-opus-4-6","claude-opus-4-7","claude-sonnet-4-0","claude-sonnet-4-5","claude-sonnet-4-6",
"claude-haiku-4-5"])
function dD(){if(pl()||Ozn())return!0;let e=Kze();
 if(e===void 0||tRo(e)||eRo(e))return!0;
 return a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}
```

Semantic flip vs the v267/2.1.233 denylist OCC carried: unrecognized model ids now gate OFF unless the env opt-in is set.

**OCC change:** `src/utils/todoToolsAvailability.ts` rewritten — stale 2.1.233 denylist (`TODO_TOOL_RESTRICTED_MODELS` + version-compare) replaced with the exact 15-id `TODO_TOOL_ALLOWED_MODELS` set; `areTodoToolsAvailable()` = undefined model → true; `application-inference-profile` (Bedrock `tRo`) → true; allowlisted → true; else `isEnvTruthy(CLAUDE_CODE_ENABLE_TODO_TOOLS)`. The tool-side `isTodoV2Enabled()` split already mirrored official `kK()=j_()&&dD()`. Tests: `src/utils/__tests__/todoToolsAvailability268.test.ts` (allowlisted, opus-4-8/sonnet-5/unknown → false, unknown+env=1 → true, inference-profile → true, undefined → true); stale `todoToolsAvailability233.test.ts` deleted.

**Documented divergences:** the two official overrides not ported (already documented N/A in the 2.1.233 port): `pl()` bg-session/job kind (OCC ships no bg session kind) and `Ozn()` SDK launchOptions opt-in (no SDK surface).

### Gap-83e — E50: auto-mode denial message names the safer-method guidance

Official changelog: *"Improved auto mode denials: the message Claude receives now names the rule that blocked the action and asks Claude to try a safer method and finish unrelated work before stopping to ask you."*

Byte-verified official v268 evidence — NEW suffix `Tjs` (0→2) appended to the unchanged base `ANt`, used ONLY by the auto-mode assembler `H5t` (`o=n?.autoModeConsentFlow?Ejs:Tjs`); the old suffix survives as `LOr` for plain denial `LDn`/don't-ask `MQ`:

```
If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.
```

**OCC change:** `src/utils/messages.ts` — the fused `DENIAL_WORKAROUND_GUIDANCE` constant split: base + `LEGACY_STOP_SUFFIX` (old text) kept for `AUTO_REJECT_MESSAGE`/`DONT_ASK_REJECT_MESSAGE` (matches official `LOr` usage), new `AUTO_MODE_STOP_SUFFIX` (byte-exact `Tjs` text) used only in `buildYoloRejectionMessage`. Tests: `src/utils/__tests__/denialSuffixSplit268.test.ts`.

**Documented divergences:** the changelog's "names the rule" half is official `denyRulePhrase` (`Hbt`), whose only real call sites are Artifact read/publish denials (subsystem absent from OCC) — the auto-mode `Reason:` string comes from the server-side classifier, which OCC's frame already embeds. Nothing client-side to port for that half.

### Gap-83f — E37: WebFetch dotless-hostname error explains why and suggests curl

Official changelog: *"Fixed WebFetch's error for localhost and other dotless hostnames to explain why the URL is refused and suggest curl."*

Byte-verified official v268 evidence (`jvn` vs v267 `Tbn`; "dotless" 0 hits in v267):

```js
if(Te&&!Te.includes("."))throw new C("WebFetch cannot fetch localhost or other hostnames without a dot. To reach a local server, use Bash with curl instead.","web-fetch-dotless-host");
```

**OCC change:** `src/tools/WebFetchTool/utils.ts` `getURLMarkdownContent` — on `validateURL` failure, re-parse (tolerating parse failure) and throw the byte-exact message for dotless hostnames; everything else keeps `Invalid URL`. Tests: `src/tools/WebFetchTool/__tests__/dotlessHostname268.test.ts`.

### Gap-83g — E05: `configDirectory` in `auth status --json`

Official changelog: *"Added `configDirectory` to the output of `claude auth status --json`."*

**OCC change:** `src/cli/handlers/auth.ts` — the `--json` envelope gains `configDirectory` (the 268 add). Tests: `src/cli/__tests__/authStatusConfigDirectory268.test.ts`.

**Documented divergences:** official's envelope also carries `analyticsDisabled`/`projectsDirectory`/`forcedLoginMethod` — fields OCC already lacked pre-268 (analytics stubbed; no forced-login-method surface). Only the 268 delta (`configDirectory`) is this round's scope; the rest stay documented divergences.

### Gap-83h — E35: `plugin validate` rejecting directory names beginning with two dots

Official changelog: *"Fixed `claude plugin validate` rejecting plugin paths whose directory name begins with two dots, which the plugin loader accepts."*

**OCC change:** `src/utils/plugins/validatePlugin.ts` — the `p.includes('..')` substring check (which reproduced the exact official pre-fix bug: `..myplugin/` rejected by validate but accepted by the loader) replaced with a segment-wise traversal check. Tests: `src/utils/plugins/__tests__/validatePluginDotDot268.test.ts`.

### Gap-83i — E52: MEMORY.md truncation warning says how many lines were cut and where

Official changelog: *"Improved the MEMORY.md truncation warning to say how many lines were cut and where the cut starts."*

Byte-verified official v268 evidence (`ynt` cut-detail block, ELF @183373772; constants `iL=200` lines / `F1=25000` bytes unchanged; new word-boundary truncator `Kte` @180363539):

```js
let x=r[L.length]==="\n"?rn(L,"\n")+1:0, v=L.length+1, R=r.indexOf("\n",v),
    A=r.slice(v,R<0?void 0:R).trim(),
    D=x===0?`everything after the first ${L.length} characters of line 1 was cut off`
          :`${o-x} of ${o} lines were cut off, starting at line ${x+1}${A?` ("${Kte(A,80)}")`:""}`
```

**OCC change:** `src/memdir/memdir.ts` `truncateEntrypointContent` — the v267-era plain warning replaced with the byte-exact cut-detail computation (both message variants: single-huge-line and N-of-M-lines with an 80-char preview); `src/utils/truncateMiddle.ts` gains the `Kte`-semantics word-boundary truncator (surrogate-safe slice + high-surrogate drop — deliberately NOT reusing OCC's grapheme tools, whose semantics differ). Tests: `src/memdir/__tests__/entrypointTruncation.test.ts`.

### Gap-83j — E63: "N MCP servers need authentication" announced once per server

Official changelog: *"Changed the 'N MCP servers need authentication' startup notice to announce each server once instead of at every launch."*

Byte-verified official v268 evidence (`mcpNeedsAuthNoticed` 0 hits in v267) — five-piece mechanism: eligibility filter `TEt`, notice predicate `net` (needs-auth ∧ eligible ∧ not noticed this session ∧ not in persistent list), recorder `zye` (session Set + persistent config list, capped `Z5t=128`), counter `Qye`, pruner `Yye` (connected servers removed from the persistent list, run from a REPL effect).

**OCC change:** NEW `src/utils/mcpNeedsAuthNotice.ts` (persistent `mcpNeedsAuthNoticed: string[]` in global config capped at 128 + session Set + the five ported functions), wired through `src/utils/config.ts`, `src/hooks/notifs/useMcpConnectivityStatus.tsx` (notice/record/count) and `src/commands/clear/caches.ts` (prune on connect). Tests: `src/utils/__tests__/mcpNeedsAuthNotice.test.ts` (19 — first launch announces, second is silent, post-auth prune re-arms, 128-cap tail-trim).

### Gap-83k — E32: spinner long-task label stays within one terminal row

Official changelog: *"Fixed the spinner wrapping onto several lines when the current task's label is long; the label and the 'Next:' task line now stay within one terminal row."*

Byte-verified official v268 evidence (267 @200268900 vs 268 @201743600): label pipeline gains whitespace-normalize (`replace(/\s+/g," ").trim()`) + width truncation `xA(ft,Math.max(40,ot-8))` (grapheme-segment + display-width, no ellipsis — caller appends `…`); the `Next:` line gains the same normalize and renders with `wrap:"truncate-end"`.

**OCC change:** `src/components/Spinner.tsx` + `Spinner/utils.ts` — task label built as `[activeForm, subject].map(normalize).find(Boolean)`, truncated via OCC's existing `truncateToWidthNoEllipsis` (verified semantically identical to official `xA`) at `Math.max(40, columns - 8)`; `Next:` line whitespace-normalized and rendered `wrap="truncate-end"` when present. Tests: `src/components/Spinner/__tests__/todoLabelE32.test.ts` (12).

### Gap-83l — E26: `@`/`/` suggestions reappear after editing a recalled prompt

Official changelog: *"Fixed `@` file and `/` command suggestions not appearing after recalling a previous prompt with the up arrow and editing it."*

Byte-verified official v268 evidence — the history hook body is byte-identical 267↔268 (both return `historyEdited: idx>0 && value!==recalledRef.current`); the ONLY change is the call site: v267 `suppressSuggestions: isSearchingHistory || historyIndex>0` → v268 `isSearchingHistory || (historyIndex>0 && !historyEdited)`.

**OCC change:** NEW `src/hooks/historyEdited.ts` — `useArrowKeyHistory` gains a `recalledValueRef` (set at every navigation/draft-restore exit, cleared on reset — mirroring official `no.current`) and returns `historyEdited`; `PromptInput.tsx:1186` adopt the v268 suppressSuggestions shape. Tests: `src/hooks/__tests__/historyEditedE26.test.ts` (9 — recalled-unedited suppressed, edited restored, reset clears, draft-down unaffected).

---

## 2. Staged (evidence captured, not ported this round)

Ordered by next-round priority. All official snippets byte-extracted from `/tmp/cc-diff-268/{s1s,s2s}.txt` during this round's forensics (retained in the round transcript).

- **E14 `denyRulesUnjudged` fail-closed ask** (security-positive; top priority). Official v268 adds (`denyRulesUnjudged` 0→3) three byte-exact ask templates — `XFo`: `` `'${Eut(e)}' has more arguments than can be checked one by one against the configured Read/Edit deny rules` ``; `QFo`: `` `'${Eut(e)}' names '${n}', which an Edit deny rule covers, and whether the command writes it cannot be determined` ``; `ZFo`: `` `the directory changes before '${Eut(e)}' could not all be followed, so the files its relative paths name cannot be checked against the configured Read/Edit deny rules` `` — each wrapped `behavior:"ask"` + `classifierApprovable:!1` + `circuitBreaker:"denyRulesUnjudged"`; `Eut` truncates >120 chars to `${first117}… (${len} characters, ${sha256_12})`. Gate `JFo` fires only when Read/Edit deny rules exist (excluding `hostCredential` sources); env-wrapper danger detector `zFo` (`--chdir=`/`-C X≠.`, `-S`, `--unset`, `--argv0`, unknown long opts, short clusters outside `[i0v]`); redirect ops set write-uncertain; arg cap `YFo=64`; cd-tracker marks unresolvable-cd / capped-tracked-dirs (`qFo=8`). OCC counterpart: `bashPermissions.ts:2703` too-complex → ask WITH `pendingClassifierCheck` (live BASH_CLASSIFIER can auto-approve) and no deny-rule conditioning — the exact pre-fix shape. Staged because it touches the permission-critical bash path and needs dedicated verification (per-site decompilation of `JFo`'s call topology + classifier-interaction tests), and this round absorbed two server cancellations — completing the release pipeline took priority. Wire points captured: `bashPermissions.ts` too-complex/checkSemantics-fail/compound-cd ask sites; `pathValidation.ts:1284 skipEnvFlags`.
- **E38 PermissionRequest hooks in `--print` mode.** Official hook generator byte-identical 267↔268 (`bfe`→`Ame`); the fix is caller-level rewiring (`be`→`ein` gaining `forRemoteExecution` guard + 2 params; `UOo`→`PBo`) — the specific print-path call site could NOT be byte-isolated (spread across the minified permission pipeline). OCC has the identical gap: print mode's no-prompt-tool branch (`print.ts:4379-4396`) returns `ask` verbatim → auto-deny without running PermissionRequest hooks (`executePermissionRequestHooks` fires only from interactive UI, SDK stdio, and headless agents via `runPermissionRequestHooksForHeadlessAgent`, `permissions.ts:415/1029`). Plan captured: run the headless hook loop in print's ask branch (hook allow/deny wins; else unchanged). Staged: functional-parity port of a call-site topology that is not byte-verified — needs a dedicated round per "Never invent".
- **E45 Bash sandbox instruction over-statement (LAND-partial plan).** Strict-branch rewrite is two byte-exact strings (v268 `uMr()`): `"The \`dangerouslyDisableSandbox\` parameter is disabled in this session's configuration; setting it does not take a command out of the sandbox."` + `"If a command the task needs fails on a sandbox restriction, tell the user which restriction it hit; changing the sandbox settings is their decision, not yours."` replacing OCC's `prompt.ts:266-268` v267 claims ("Commands cannot run outside the sandbox under any circumstances."). Relaxed branch needs a posture predicate `L0()` — OCC has no `sandbox.filesystemPolicy` concept (grep = 0), so the plan ships a `getFsPosture()` stub returning `'strict'` matching the official shape. The `tengu_elegant_ocean`-gated paragraph/bullets stay skipped (gate default-off — porting ungated would diverge from official default). Staged for the relaxed-branch stub design decision; strict-text swap is a 2-line follow-up.
- **E06 plugin CLI `--json` + `errorDetails`/`noteDetails`.** Mechanical CLI-surface work: OCC's `plugin install/uninstall/update/enable/disable` lack `--json` (`main.tsx:4615-4722`); `list --json` rows (`plugins.ts:300-343`) lack `errorDetails`/`noteDetails`. Official envelope shape in added.txt. Staged: broad CLI-surface change, low risk, next-round quick win.
- **E56 `/plugin` menu applies on close.** OCC exhibits exact pre-fix behavior ("Run /reload-plugins to apply" at `ManagePlugins.tsx:471,493,1127,1526,1648,1651`); the reload machinery exists (`AppStateStore.ts:179` plugin-reload counter). Plan: fire the counter from the menu's onDone/close path, delete the strings. Staged: menu-lifecycle change needs interactive verification.
- **E12 "your message came through empty" after MCP tool call.** NOT client-attributable: exhaustive probes all identical 267/268 (`came through empty` 0/0, `mcpMeta` 16/16, `toolEndsTurn` 5/5, `claude/endTurn` 2/2, 8192 `_meta` gate identical, ended-turn handler diffs to pure renames). OCC's endTurn/mcpMeta machinery is already fully ported. Action: monitor 2.1.269 for follow-up strings; if OCC reproduces the symptom, capture transcript before coding.
- **E47 `--continue`/`--resume` immediate render.** Byte-verified startup-mount delta only: v268 resume loader returns SessionStart hooks as a PROMISE (`pendingHookMessages:ze.sessionStartHooks`), REPL mounts immediately, awaits before first API call. OCC has the full deferred-hook mechanism but only on the startup path (`REPL.tsx:548/1369-1372/3247-3251`); `main.tsx:2726` forces `hooksPromise=null` for continue/resume and `conversationRecovery.ts:696-699` awaits+pushes before mount — the exact pre-fix behavior. Staged: (1) in-session `/resume` dialog path (`REPL.tsx:1839-1904`) not verified against official; (2) the changelog's second half ("first message no longer re-reads the whole transcript") is not locatable in the binary diff; (3) `processResumedConversation` has multiple callers — return-contract change ripples. Identified subset shape captured in the round transcript.
- **E57 3P system-prompt env/model/settings as attachments.** OCC inlines env details in the system prompt for ALL providers (matches official pre-fix 3P; diverges from official first-party attachments model). Aligning is a cross-provider prompt-assembly change affecting cache-key stability — not a 3P-only patch. Needs a deliberate decision round.
- **E58 tool-list byte-stability across late MCP connect.** OCC mitigated agent-list-description cache busting via attachments (`AgentTool/prompt.ts:52-56`) but no `deferredTools`/stable-tool-list mechanism for the tools array itself. Deep-dive question captured: trace whether a late MCP connect rewrites the tools array per provider; if yes, official's deferred-load approach is portable.
- **E11 focus-report flood re-render.** OCC's idle busy-loop half is N/A (push/subscribe focus state, no polling); the cheap half: `setTerminalFocused()` notifies all `useSyncExternalStore` subscribers unconditionally even when unchanged — dedupe candidate. Official's exact fix shape not byte-isolated (no new strings).
- **E40 `/resume` fork-session naming.** OCC has `FORK_GLYPH='⑂'` + fork handling in `ResumeConversation.tsx`; whether the resume list shows a forked bg session under its parent's name needs a naming-logic check. Quick verify-next-round item.
- **E55 1M-context "restart to take effect" clause.** One-string reword (`errors.ts:552`); terminology differs ("Extra usage" vs official "Usage credits") and the caveat concerns first-party billing propagation — marginal value, optional.
- **E22 OAuth port exhaustion.** Already hardened: OCC's `findAvailablePort` does 100 randomized bind attempts + a 3118 fallback before the error string is reachable; official's string still exists in v268 too. Diff `oauthPort` context next round if official added an ephemeral-port fallback; not a functional gap today.

---

## 3. No-op (71 entries — subsystem absent from OCC, already-fixed, or not portable)

| # | Entry | Verdict reason |
|---|-------|----------------|
| E01–E03 | Claude apps gateway pricing / allow_cidrs warning / `gatewayInternalNetworks` | Gateway server product absent (zero hits `gateway.yaml`/`allow_cidrs`/`gatewayInternalNetworks`); OCC's "gateway" hits are the model-provider base-URL concept only. |
| E04 | `self-hosted-runner --remove-session-state` | `src/self-hosted-runner/main.ts` is a 3-line stub; no `_sessions/` logic. |
| E07 | Artifact browser-tab icons | No Artifact tool (`ReviewArtifactTool` = empty stub). |
| E08 | 3P endpoints 400 from Artifact schema regex | OCC ships no Artifact tool; audited ALL wire-schema `.regex()` uses — only `RemoteTriggerTool /^[\w-]+$/` + `WorkflowTool /^wf_[a-z0-9-]{6,}$/`, both RE2/Python-safe. No same-class mine. |
| E09 | WebFetch 300 s deadline | OCC's axios `timeout: 60_000` per hop already bounds every fetch (stricter than official 300 s) — immune to the hang. `CLAUDE_CODE_WEBFETCH_DEADLINE_MS` support = optional compat item only. |
| E10 | Respawned teammate trusting untrusted agent files | OCC teammate respawn has no `customAgentType` definition-restore path (grep = 0); OCC already carries the v267-level trust gate for agent-file frontmatter hooks. |
| E15 | Plugin/marketplace errors leaking git-URL tokens | Already mitigated: `marketplaceManager.ts:836-853` runs `redactUrlCredentials()` over error+stderr. |
| E17 | `excludeDynamicSections` prompt-cache busting | OCC immune by design: dynamic half computed ONCE at startup (`print.ts:757-786`) and injected via one-shot `prependUserMessage` — no per-request re-render loop exists. |
| E18/E19 | Stale model-access denial cache | No model-access cache/denial layer in OCC (zero hits `modelAccess`/`isModelRestricted`). |
| E20 | Long-context 429 showing consent prompt | No usage-credits consent-prompt surface (zero "consent" hits); OCC's 429 path directly emits the 1M-context message. |
| E21 | Workload-identity-federation `jti reused` | No WIF profile token caching (zero hits `web_identity`/`jti`) — AWS-SDK/first-party credential-chain territory. |
| E24 | Resume restored-file-notes ordering | The official BFS→DFS traversal fix lives in a subsystem OCC replaced: OCC's transcript chain is linear (`isChainParticipant` excludes only progress; attachments are on-chain in write order) — notes cannot reorder across resumes. |
| E25 | `/rename` + prompt suggestions sending pre-compaction conversation | Already post-fix: `/rename` uses `getMessagesAfterCompactBoundary`; OCC compacts the working message array in place. |
| E27–E29 | `claude agents` panel fixes (3) | OCC's `agents` subcommand is a non-interactive console table/`--json` dump — no ← navigation, no session-delete-with-worktree flow, no expandable rows. |
| E30 | Claude in Slack MCP-allowlist tool loss | No Slack session runtime (only `install-slack-app` shell). |
| E31 | Chrome "allow host https" prompt | Prompt lives in the Claude-in-Chrome extension/backend (not shipped); OCC's URL-host parse is display-only. |
| E33 | `/bug` `/feedback` description cursor | OCC's `/feedback` is a `type:'prompt'` AI-triage command — no interactive description dialog, no cursor surface. |
| E34 | Remote Control session names in `ListAgents` | OCC's `ListAgents` lists local PID-file sessions; cloud/remote-bridge categories are explicit unwired stubs. |
| E36 | Plugins skipping default monitors / root SKILL.md | No default-monitors file concept in OCC plugins; root-SKILL.md half is bundled-skills territory OCC ships separately. |
| E39 | Policy-helper warnings on `-p` | No `policyHelper` mechanism (grep = 0); OCC's `policyLimits`/`isPolicyAllowed` is a different mechanism. |
| E41 | claude.ai-gated commands suggesting `/login` | No Enterprise-migration message exists in OCC; `remote-setup.tsx:98` already says "Not signed in to Claude. Run /login first." |
| E42 | `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` not extending hooks | OCC never had the bug: `getSessionEndHookTimeoutMs()` (env>0 ? env : 1500) is passed as per-hook default at ALL three SessionEnd call sites. Footnotes (pre-existing deltas, not 268 regressions): OCC keeps the `>0` guard; OCC caps the outer signal at env/1500 rather than extending to max per-hook timeout (60 s cap) — full `Wge` parity is a separate self-contained follow-up. |
| E43 | `/autofix-pr` GitHub-App wording | OCC's `/autofix-pr` is a pure local prompt template — no cloud-session error path. |
| E44 | `/teleport` `/remote-env` org-policy wording | Both surfaces gated/stubbed in OCC (`teleport` disabled stub; `remote-env` hidden when not subscriber/policy-allowed) — rewording a hidden command's error is cosmetic. |
| E46 | Fullscreen Shift+Enter repaint perf | Official optimizes THEIR static/dynamic transcript-split renderer; OCC's ink fork uses a clear+repaint model with no identified shared slow path. Revisit on real complaints. |
| E48 | Hidden per-tool-batch reminder redraw | No such reminder rendering in OCC (PostToolBatch exists as a hook event only). |
| E49 | `.claude/workflows` startup listing perf | OCC's listing NEVER parses script contents (`listScripts` = readdir+stat only); official's acorn→hand-scanner optimization addresses a cost OCC doesn't pay. |
| E51 | Chrome long-page reads inline | Inside the Claude-in-Chrome extension (not shipped). |
| E53 | Artifact terminal permission prompt | No Artifact tool. |
| E54 | Prompt footer editor/`/diff` selection + RC status | UI polish on absent features (no in-prompt selection display; RC bridge unwired). |
| E60–E62 | Artifact data-edit card / Cowork symlink refusal / Artifact-vs-WebFetch rules (3) | Artifact tool + Cowork sessions absent. |
| E64–E76 | VSCode extension fixes (13) | OCC ships no VSCode extension (only LSP-protocol type deps). |
| E77–E79 | Claude Code on the web fixes (3) | Cloud/remote transports are unwired stubs. |
| E80–E92 | Claude Tag (Slack) fixes (13) | No Slack session runtime. |
| E93–E96 | Code Review workflow fixes (4) | OCC ships zero bundled workflows; `src/commands/review.ts`/`security-review.ts` are OCC's own separate implementations, not the official bundled Code Review orchestration. |

---

## 4. Verification

- New/updated test files this round (13): `symlinkTwins268` (29), `mcpSecretRedaction268` (55), `compactSummaryDollar268`, `todoToolsAvailability268`, `denialSuffixSplit268`, `dotlessHostname268`, `authStatusConfigDirectory268`, `validatePluginDotDot268`, `entrypointTruncation`, `mcpNeedsAuthNotice` (19), `todoLabelE32` (12), `historyEditedE26` (9), `mcpSlice218` (updated); stale `todoToolsAvailability233.test.ts` deleted.
- Gates recorded in the release commit: full `bun test src` suite, targeted e2e (`occ-versioning`, `commands-alignment`), `bun run lint` (biome) on touched files, `bun run build` (dist/cli.js), live `-p` smoke (`echo "say PONG" | occ -p`) + tmux REPL smoke (`occ --version`, boot, `/status`).
- Security review: dedicated backdoor/secret-leak pass over the round diff before merge — **PASS, no backdoor / no secret leak** (twins only tighten deny/ask — allow rules never get twins, registration is additive, multi-spelling loop applies only to the deny check; redaction fails closed; no new network calls / eval / dynamic imports in the diff). Result recorded in the PR.
- Full per-file CI gate (`bash scripts/ci-test.sh`, 446 files): **3839 pass / 12 fail / 12 skip**. All 12 fails are in 10 tmux/pty/real-model e2e files (`commands-behavior`, `feedback-ai`, `goal-gate`, `goal-panel`, `repl-interactive`, `resume-command-name`, `version-2.1.208-screen-reader`, `version-2.1.210-plan-approval`, `version-2.1.221-autocompact`, `workflow-save-dialog-config-dir`).
- Regression proof (git-stash A/B): rebuilt `dist/cli.js` from the clean main baseline (2.1.329) and ran the same 10 e2e files in isolation on both sides. Baseline: **10/10 files fail (12 tests)**. This round's tree: **8/10 files fail (10 tests)** — a strict SUBSET of the baseline failures, identical test names and timing signatures (e.g. plan-approval 145s/147s, goal-gate 20s, screen-reader 22s on both sides); `commands-behavior` and `autocompact` even PASS on this round's tree in isolation (flaky real-model/timing tests that failed the full-gate run under contention). **Zero new failures introduced by this round — all remaining e2e fails are environmental/pre-existing.**
