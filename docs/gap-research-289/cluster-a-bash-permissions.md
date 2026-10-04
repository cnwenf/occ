# Cluster A — Bash Permission / Sandbox Auto-Allow SECURITY fixes (2.1.288 → 2.1.289)

Research round: official Claude Code 2.1.288→2.1.289 catch-up (OCC aligned at 2.1.288).
Method: byte-level forensics on the OFFICIAL linux-x64 binaries at
`/tmp/cc-diff-289/{v288,v289}/package/claude` (NEVER executed — `LC_ALL=C grep -aobF`
offsets + `dd bs=1` / python `seek/read` byte windows only; note `ugrep` silently
returns nothing on binary without `-a`). A/B against OCC `src/` + live `bun run`
probes (temp probe files deleted after each run — this doc is the only file created).
Offsets are byte offsets into the ELF; minified names shift between versions
(renames noted per entry). Saved evidence windows in `/tmp/cc-diff-289/`:
`r288_PC.txt`/`r289_ER.txt` (matcher), `r288_sa.txt`/`r289_sa.txt` (sandbox auto-allow),
`r288_kVt.txt` (certified matcher), `r288_OP*.txt`/`r289_DP*.txt` (hook-override path),
`r288_perm.txt`/`r289_perm.txt` (mod dispatch), `new_strings.txt`/`removed_strings.txt`.

Entries (numbers = `changelog-entries-289.txt` line numbers): **#1, #14, #15**.

## Verdict summary

| # | Verdict | One-line evidence |
|---|---------|-------------------|
| 14 | **PORT-CANDIDATE** (rank 1 — the only port in this cluster) | v289 matcher variant-builder adds `\|\|(h?.envVars.length??0)>0` (@210022797); OCC live path shares the v288 root cause (assignment-stripper regex refuses `$`-containing values, no AST compensation — AST dormant) and probes confirm `TZ="$HOME" rm -rf build` misses deny AND ask rules |
| 15 | **NO-OP{STRUCTURALLY-IMMUNE}** | Official bug needs the AST collapsing a bare assignment into a 1-element command list (`if(r.length>1)` gate skip); OCC's auto-allow recheck gate is text-based `splitCommand().length>1` and probes show `FOO=1; rm -rf build` splits to 2 parts → per-subcommand deny recheck fires (subDeny:true) |
| 1 | **NO-OP{NO-SURFACE}** + STAGED adjacent note | Fix site is the mod `tool.check` dispatch (`Krt`→`kTe` recursion @207642127→@207945079, `Zrt`→`Ost` hookAskFloor attribution) — OCC has no `tool.check` mod surface (all greps empty); official's PreToolUse hook path (DP/OP) is byte-identical 288↔289. Adjacent STAGED: OCC `checkRuleBasedPermissions` 1f ask-extraction is non-recursive where official `mu()` recurses into `subcommandResults` |

---

## #14 — deny/ask rules miss a command behind an env-var prefix with an EXPANDED value 🔒

> 14 - Fixed Bash deny and ask rules missing a command behind an environment
> variable prefix with an expanded value (e.g. `TZ="$HOME" rm -rf build`) when
> the sandbox auto-allows commands

### Official forensics — fix site FULLY RECOVERED

The fix is in the rule-matcher variant builder (`PC` in v288 / `ER` in v289 →
inner builder `E4`/`j4`), specifically the `stripAllEnvVars` branch (`s` =
`stripAllEnvVars:!0`, which is what BOTH deny and ask matching pass).

v288 @209715163 (matcher `PC`, variant builder):

```js
if(s){let ye=h?.argv??fu(H),be=Sdt(ye);
  if(be.length>0&&be[0]!==ye[0])V.push(be.join(" "));
  ...let Fe=Aue(Pe)...
```

v289 @210022797 (matcher `ER`, same site; marker `envVars.length??0)>0` @210022816):

```js
if(s){let ye=h?.argv??fu(H),be=Wdt(ye);
  if(be.length>0&&(be[0]!==ye[0]||(h?.envVars.length??0)>0))V.push(be.join(" "));
  ...let Fe=Pue(Pe)...
```

Semantics: `h` is the parsed AST command (`{argv, envVars, redirects, text, ...}`);
assignments land in `envVars`, NOT in `argv`. The stripper regex `Aue`(v288)/
`Pue`(v289) is **byte-identical between versions** and intentionally refuses
values containing `$` or backtick (ReDoS/ambiguity guard) — so for
`TZ="$HOME" rm -rf build` the regex-stripped text is unchanged and v288's
variant list only gained the argv-joined text when `be[0]!==ye[0]` (first token
changed), which fails when the whole input already starts with the command after
env-var normalization in some shapes. v289 forces the argv-joined variant
(`rm -rf build`) into the match-candidate list **whenever the AST saw any
`envVars`**, regardless of whether the regex stripper succeeded. Deny/ask rules
then match against that variant. The fix is AST-side compensation, NOT a regex
change (regex identical both versions).

### OCC-side analysis — VULNERABLE on the live path (probe-proven)

OCC's live decision path is text-based: tree-sitter AST is DORMANT
(`TREE_SITTER_BASH` WASM unavailable at runtime; `TREE_SITTER_BASH_SHADOW`
forces legacy → `astResult={kind:'parse-unavailable'}`,
`bashPermissions.ts:2801`), so everything routes through:

- `stripAllLeadingEnvVars` (`src/tools/BashTool/bashPermissions.ts:1159-1202`):
  `ENV_VAR_PATTERN` excludes `$` and backtick in quoted AND unquoted values
  (comment: "FOO=$VAR is not stripped — adding $VAR matching creates ReDoS
  risk (CodeQL #671)"). **Same root cause as official v288.**
- `filterRulesByContentsMatchingInput` (`bashPermissions.ts:1204-1361`):
  fixed-point strip loop @1252-1279 alternates `stripAllLeadingEnvVars` +
  `stripSafeWrappers`; NO `astCommand` parameter (unlike official), so no
  argv-variant compensation exists.
- `matchingRulesForInput` (`bashPermissions.ts:1445-1510`): deny AND ask both
  call with `{stripAllEnvVars:true, skipCompoundCheck:true}`.
- `checkSandboxAutoAllow` (`bashPermissions.ts:1814-1903`): full-command deny →
  `splitCommand(command)`; recheck only `if (subcommands.length > 1)`; single
  part → falls through to `{behavior:'allow', reason:'Auto-allowed with sandbox
  (autoAllowBashIfSandboxed enabled)'}` @1900.

Live probe transcript (temp `probe289b.tmp.ts` in repo root, `bun run`, deleted
after; deny rule `Bash(rm *)` via `_matchingRulesForInputForTesting` with the
ctx shape from `dockerRedirectFlags.test.ts`):

```
TZ="$HOME" rm -rf build   → deny:false  ask:false   (stripper returns text UNCHANGED)
TZ=$HOME rm -rf build     → deny:false  ask:false
FOO=$(pwd) rm -rf build   → deny:false  ask:false
A=1 rm -rf build          → deny:true   (literal value — regex strips fine)
splitCommand_DEPRECATED('TZ="$HOME" rm -rf build') → 1 part (no subcommand recheck)
findDestructiveCommandBlock / findCatastrophicSubstitutionBlock → null (no other guard fires)
```

So under sandbox + `autoAllowBashIfSandboxed`, `TZ="$HOME" rm -rf build` sails
through `checkSandboxAutoAllow` as allow — exactly the changelog scenario. The
normal (non-sandbox) deny/ask path misses it identically (both route through
`matchingRulesForInput`). **Verdict: VULNERABLE → PORT.**

### Implementation sketch (text-level equivalent of the official AST fix)

Fix placement: the `if (stripAllEnvVars)` fixed-point block inside
`filterRulesByContentsMatchingInput` (`bashPermissions.ts:1252-1279`) — this
covers BOTH the normal deny/ask path and `checkSandboxAutoAllow` (which calls
the same matcher), mirroring how the official AST variant feeds `ER`/`PC`
callers. Allow-rule matching does not pass `stripAllEnvVars:true`, so no new
ALLOW surface is created (deny/ask-only, matching official).

Add a ReDoS-safe, quote-aware **iterative character scanner** (NOT a regex —
the CodeQL #671 constraint stands) as a sibling of `stripAllLeadingEnvVars`:

1. From position 0, repeatedly: skip whitespace; match `NAME=` where NAME is
   `[A-Za-z_][A-Za-z0-9_]*` (optionally `+=`); consume the value with a small
   state machine — single-quoted (`'…'`), double-quoted (`"…"` honoring `\`
   escapes; `$`/backtick ALLOWED inside), `$(…)`/backtick substitution with
   depth counting, or bare token up to whitespace. Then require whitespace and
   continue with the next `NAME=` token.
2. Stop at the first token that is not an assignment; the remainder is the
   command. Push the remainder into the candidate list (`V`) whenever at least
   one assignment was consumed — the text-level analogue of
   `||(h?.envVars.length??0)>0`.
3. **Fail-closed**: unterminated quote/substitution, or assignments consumed
   with no trailing command → push nothing extra AND (for robustness parity
   with the destructive-warning chain) let existing guards
   (`hasQuotedBracketCloserInConditional`, M4/M5, catastrophic-substitution)
   handle pathological shapes as today.
4. Keep `BINARY_HIJACK_VARS` semantics: never let a hijack-var assignment
   (`PATH=`, `LD_PRELOAD=` …) create a variant that could feed an ALLOW match —
   the variant is only added inside the `stripAllEnvVars` (deny/ask) branch, so
   this is already structurally satisfied.

### Attack-style test cases (must fail-closed after fix)

| Command | Rule | Sandbox auto-allow | Expected |
|---|---|---|---|
| `TZ="$HOME" rm -rf build` | deny `Bash(rm *)` | on | **deny** (auto-allow must not fire) |
| `TZ=$HOME rm -rf build` | deny `Bash(rm *)` | on | deny |
| `FOO=$(pwd) rm -rf build` | deny `Bash(rm *)` | on | deny |
| `TZ="$HOME" npm publish x` | ask `Bash(npm publish:*)` | on | **ask** |
| `A=1 rm -rf build` | deny `Bash(rm *)` | on | deny (regression guard — already works) |
| `FOO="$BAR` (unterminated) | deny `Bash(rm *)` | on | no crash; scanner fail-closed |
| `echo "$HOME"` | deny `Bash(rm *)` | on | allow (no false positive — no assignment prefix) |

Files implicated: `src/tools/BashTool/bashPermissions.ts` only
(`filterRulesByContentsMatchingInput` stripAllEnvVars block + new scanner
helper; tests via `_matchingRulesForInputForTesting` +
`checkSandboxAutoAllow`).

### Adjacent divergence noted (not part of the 289 delta)

Official `qBe` (sandbox auto-allow AST path) bails out of auto-allow entirely
when any assignment var name is off the safe list
(`K.envVars.some((ye)=>!bP(ye.name))`); OCC `checkSandboxAutoAllow` has no
equivalent name-based bail. Pre-existing divergence, orthogonal to #14's fix —
worth a separate staged item, not required for this port.

---

## #15 — deny/ask rule skipped under sandbox auto-allow when a bare variable assignment precedes the command 🔒

> 15 - Fixed a Bash deny or ask rule being skipped under sandbox auto-allow
> when a bare variable assignment came before the command

### Official forensics — fix site FULLY RECOVERED

Inside the sandbox auto-allow function (`qBe` v289 / `b5o`… AST path; gate
over the parsed command list `r`):

v288 @209729859:

```js
if(r.length>1){let S;for(let w of r){
  let B=PC({command:w.text},n,"prefix",{astCommand:w});
  if(B.matchingDenyRules[0]!==void 0)return{behavior:"deny",...
```

v289 @210037822:

```js
if(r.length>1||r[0]?.text!==s){let S;for(let w of r){
  let B=ER({command:w.text},n,"prefix",{astCommand:w});
```

Root cause: `FOO=1; rm -rf build` parses to an AST whose command list has
`r.length===1` while `r[0].text !== s` (the bare assignment statement swallows
the list shape — the single element's text does not equal the whole input), so
v288's `if(r.length>1)` per-command deny/ask recheck was skipped and
auto-allow fired on a command whose nested `rm -rf build` was never re-matched.
v289 rechecks whenever the AST command list does not textually round-trip.

### OCC-side analysis — STRUCTURALLY IMMUNE (probe-proven)

OCC's recheck gate is **text-based**, not AST-command-count-based
(`checkSandboxAutoAllow`, `bashPermissions.ts:1814-1903`):
`splitCommand(command)` (shell-quote tokenizer via `splitCommandWithOperators`,
`src/utils/bash/commands.ts:85+`) then `if (subcommands.length > 1)` runs the
per-subcommand deny recheck (immediate deny return) + first-ask stash.

A bare assignment separated by `;`/`&&`/newline is its own text part in OCC —
there is no AST to collapse it. Probe transcript:

```
FOO=1; rm -rf build        → splitCommand → 2 parts; subDeny:true (deny rule Bash(rm *) fires on part 2)
FOO=1 && rm -rf build      → 2 parts; subDeny:true
export FOO=1; rm -rf build → 2 parts; subDeny:true
FOO=1 rm -rf build         → 1 part; fullDeny:true (existing stripAllLeadingEnvVars handles the literal-value space form)
```

The space form's expanded-value sibling (`FOO="$HOME" rm -rf build`, 1 part,
stripper refuses) is precisely #14's hole and is covered by that port.
**Verdict: NO-OP — structurally immune; no OCC change for #15 itself.**

---

## #1 — deny/ask rule on a nested compound part not holding over a user-installed mod's approval (managed machines) 🔒

> 1 - Fixed a deny or ask rule on a nested part of a compound shell command not
> holding over a user-installed mod's approval on managed machines

### Official forensics — fix site recovered

The fix lives in the **mod `tool.check` permission dispatch** (`FDn` v288 /
`$Ln` v289), the surface where a user-installed mod/plugin can return an
approval that must not override admin deny/ask rules on managed machines:

1. **Single-level → RECURSIVE rule extraction** from compound results.
   v288 @207642127 `Krt`:

   ```js
   function Krt(e,n){if(e?.type!=="subcommandResults")return;
     for(let r of e.reasons.values()){
       let g=r.behavior===n?r.decisionReason:void 0;
       if(g?.type==="rule")return g.rule}return}
   ```

   v289 @207945079 `kTe`:

   ```js
   function kTe(e,n){if(e?.type!=="subcommandResults")return;   // (same guard)
     ... let g=r.behavior===n?r.decisionReason:void 0,
         S=g?.type==="rule"?g.rule:kTe(g,n);   // ← RECURSION into nested subcommandResults
     if(S!==void 0)return S}return}
   ```

   So in v288 a deny/ask rule matched two compound-levels deep (a compound
   inside a compound, wrapped twice in `subcommandResults`) was invisible to
   the "does an admin rule override the mod's approval?" check; v289 recurses.

2. **Hook-approval attribution**: dispatch entry v288 `let h=Zrt(g);` → v289
   `let h=Ost(g,r.hookAskFloor===!0?"PreToolUse":void 0);` (@207946861-region),
   plus NEW v289-only `Rst`/`Ast` helpers @207944816 using
   `hookName.split(":").at(0)` (0 hits of `hookName.split(":")` in v288), and
   the v289-only `MLn/NLn/FLn` `resolveToolCheck`/`setToolCheckResolver`
   infra — the mod-approval resolver plumbing that consumes `kTe`.
3. The managed-machine gate text `plugins can only tighten ${e.name}'s
   permission in a Projects session` exists in BOTH versions (not the fix).

Ruled out as the fix site (byte-verified identical 288↔289):
- certified-command matcher `kVt`@209594871 (v288) vs `eYt`@209902431 (v289):
  anchor-aligned difflib with identifier-rename filter → **0 real diff ops**.
- managed-hooks gating markers: `managedHooksOnly` 36/36, `allowManagedHooksOnly`
  38/38, `managedHooksExcluded` 16/16, `newPluginsOnly` 9/9 (v288/v289 counts).
- the **PreToolUse hook-override path** (`OP` v288 / `DP` v289,
  `r288_OP*.txt`/`r289_DP*.txt`): byte-identical between versions — including
  its recursive `mu()` reason-walker (@1224 in both dumps:
  `if(e.type==="subcommandResults")for(let r of e.reasons.values()){let
  s=mu(r.decisionReason,n);if(s)return s}`). The official 289 fix did NOT
  touch the hook path; it fixed the mod `tool.check` resolver.

### OCC-side analysis — SURFACE ABSENT

- OCC has **no mod/plugin `tool.check` permission callback surface**: greps for
  `tool.check`, `resolveToolCheck`, `setToolCheckResolver`, `plugins can only
  tighten` across `src/` are all empty. `src/utils/plugins/loadPluginHooks.ts`
  registers hook EVENTS only (PreToolUse, PermissionRequest, …).
- OCC's analogue approval-override path is the PreToolUse hook allow →
  `resolveHookPermissionDecision` (`src/services/tools/toolHooks.ts:395-530`) →
  `checkRuleBasedPermissions` (`src/utils/permissions/permissions.ts:1284-1374`).
  Official's corresponding path is byte-identical 288↔289, i.e. there is **no
  288→289 delta to port on OCC's existing surface**.
- Nested DENY is structurally safe in OCC: 1d returns on ANY
  `behavior==='deny'` without inspecting `decisionReason.type`
  (`permissions.ts:1341-1345`), and the bash compound aggregation hoists any
  sub-deny to a top-level `{behavior:'deny', decisionReason:{type:
  'subcommandResults',…}}` (`bashPermissions.ts:3325-3342`).

**Verdict: NO-OP{NO-SURFACE}** for the 289 delta itself.

### STAGED adjacent finding — non-recursive ask extraction in `checkRuleBasedPermissions` 1f (same bug CLASS as official `Krt`→`kTe`, pre-existing, not a 289 regression)

OCC's 1f (`permissions.ts:1347-1355`) returns a tool ask ONLY when the
TOP-LEVEL `decisionReason.type==='rule' && ruleBehavior==='ask'`. But a
compound with ≥2 non-allow parts returns
`{behavior:'ask', decisionReason:{type:'subcommandResults', reasons:…}}`
(`bashPermissions.ts:3637-3650`). 1f cannot see through that wrapper →
returns null → `resolveHookPermissionDecision` lets a hook/plugin **allow**
stand ("bypassing permission prompt", `toolHooks.ts` null-ruleCheck branch).
Sketch: ask rule `Bash(npm publish:*)`, command `npm publish x && curl
evil.com`, plugin PreToolUse hook returns allow → nested ask bypassed.

Official comparison is only partially resolved: official's hook-override gate
uses `mu(decisionReason)` which DOES recurse into `subcommandResults` (catching
nested safetyCheck asks) but its nested RULE-ask handling runs through
additional gates (`cY(B)`/`eY(B)` — definitions not recovered from the byte
windows) before the hook allow is consulted. Since official's `mu()` recursion
exists identically in BOTH 288 and 289, OCC's non-recursive 1f is a divergence
from the official **baseline**, not a missed 289 fix. Status: **STAGED** —
optional hardening (port a `mu()`-style recursive walk into 1f, mirroring the
1d deny pattern), pending per-site decompilation of `cY`/`eY` to confirm
official parity for nested rule asks. Files implicated if pursued:
`src/utils/permissions/permissions.ts` (1f block).

Also carried as adjacent observations (out of scope for the 3 assigned items):
- OCC `checkSandboxAutoAllow` lacks official `qBe`'s envVars safe-list bail
  (`K.envVars.some((ye)=>!bP(ye.name))`) — see #14 adjacent note.
- Official v289's token-fallback auto-allow path (`_5o`, renamed from
  `f4o`/`_5o`… token path) adds redirect/trailing-backslash hardening beyond
  the 3 changelog items; not ported here (no OCC token-fallback parity claim).
