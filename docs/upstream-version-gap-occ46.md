# Upstream version gap — OCC-46 (2026-08-06)

> Carryover from `docs/upstream-version-gap-occ44.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry, the official GitHub releases, AND a fresh download of the official
> native ELF (`@anthropic-ai/claude-code-linux-x64@2.1.223`, 290,728,968
> bytes). Behavioral truth cross-checked by driving the built OCC artifact
> (`dist/cli.js`) and probing OCC's LIVE permission path side by side with the
> decompiled 2.1.221/2.1.223 binaries.

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.293` (OCC-44) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219`/`2.1.221` **partial** | OCC-44 §7 |
| Official latest Claude Code | **`2.1.223`** — published `2026-08-05T22:51:13Z` (npm) / GitHub release `v2.1.223` `2026-08-06T00:52:37Z` | `npm view`, `gh api` |
| Version gap | **REAL GAP: two releases since OCC-44 — `2.1.222` + `2.1.223`** | this doc §2 |
| Binary markers (fresh download) | 235 × `2.1.223`, zero `2.1.224+`; 2.1.223 ELF 290,728,968 bytes (2.1.221 was 288,705,544) | `strings` + `package.json` |
| Landed this round | **2 binary-verified security ports + 1 live-path compensation guard**: ① 2.1.223 `test_command` integrity chain (P0 "crafted command could hide part of itself"), ② 2.1.223 subagent `bypassPermissions` org-policy gate, ③ live-path quoted-`]]` closer guard (AST path is dormant) | this doc §3 |

**Conclusion: official advanced twice since OCC-44 (`2.1.222`, `2.1.223`).
`2.1.223` is security-heavy — its P0 is "Fixed a Bash permission bypass where a
crafted command could hide part of itself from permission checks." This round
researched both changelogs (triage in §2), binary-diffed 2.1.221↔2.1.223, and
LANDED the portable, binary-verified security subset (§3). The critical
discovery: OCC's AST-path guards sit behind `TREE_SITTER_BASH*`, whose WASM is
unavailable at runtime (`parseCommandRaw` → null) — i.e. DORMANT in the shipped
build — and the LIVE legacy path auto-allowed the quoted-`]]` smuggled forms.
This round closes that live hole with a compensation guard (§3.3), matching the
official's observable fail-closed behavior.**

## 1. Version truth (三方 — npm + GitHub + binary)

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.223` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.223`, `next=2.1.223`, `stable=2.1.220` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.221 → 2026-08-03T22:16:25Z`, `2.1.222 → 2026-08-04T20:37:17Z`, **`2.1.223 → 2026-08-05T22:51:13Z`** | `npm view … time --json` |
| Official GitHub releases | **`v2.1.223`** (`2026-08-06T00:52:37Z`), `v2.1.222` (`2026-08-04T22:39:55Z`) | `gh api repos/anthropics/claude-code/releases` |
| Binary markers (fresh 2.1.223 ELF) | 235 × `2.1.223`; `2.1.224+` → **0 hits** (the `2.2.x` hits are GLIBC/radix-ui/Az.Accounts noise) | `npm pack …linux-x64@2.1.223` + `strings`/`grep` |
| OCC aligned (start of round) | `2.1.218` full + `2.1.219`/`2.1.221` partial | OCC-44 §7 |

## 2. Changelog triage (`2.1.222` + `2.1.223`)

Both releases landed after OCC-44 froze at 2.1.221. Bucket assignments below;
"portable" = no Anthropic-backend dependency, verifiable in the linux-x64 ELF,
and OCC has the surface.

### LANDED this round (§3)

| # | Release | Item | Why portable |
|---|---------|------|--------------|
| A | 2.1.223 | **P0 — "Fixed a Bash permission bypass where a crafted command could hide part of itself from permission checks."** | Full `test_command` integrity chain is byte-verifiable in the ELF (gap walker, early-close, zero-width token, `test_rhs_missing`, `]]`-desync / standalone-closer checks, `&&`/`]]` pattern-leaf checks). OCC had a PARTIAL 2.1.221 port (OCC-44 landed only the regex/extglob RHS case); this round brings the whole chain to 2.1.223 parity. |
| B | 2.1.223 | **"Fixed a permission gap where an agent definition's `bypassPermissions` mode ignored the org bypass-permissions disable policy."** | The official subagent-spawn path (`IDu`/`Ne`) now consults the bypass-disabled predicate before honoring an agent's `bypassPermissions`. OCC already exports the equivalent predicate `isBypassPermissionsModeDisabled()`; the port wires it into `runAgent.ts`. |
| C | 2.1.223 | **Live-path compensation guard** for the quoted-`]]` closer smuggling class (OCC-specific, mirrors M4/M5 guard pattern). | The AST guards (A) are dormant in the shipped build (tree-sitter WASM unavailable → legacy path authoritative). Probing showed the LIVE path auto-allowed `[[ x == "a]]&&id" ]]` under a permissive `Bash([[ *)` rule — a real P0-class hole the official's AST fix closes. New `hasQuotedBracketCloserInConditional` makes the live path fail closed (ask). |

### STAGED with rationale (§4)

Everything else from both changelogs. The dominant reasons: (a) the fix is in a
surface OCC trims or gates off (plugins/marketplace, sandbox-proxy egress,
worktree-pin subsystem, bg-session/daemon machinery, Remote Control, teleport,
ultraplan — already dormant); (b) Anthropic-backend/billing-bound (`/usage`
attribution, `/usage-credits` dismissed-state, model-discovery, managed-settings
server delivery); (c) needs dedicated per-site decompilation with ambiguous
behavior (stream idle timeout, connectivity-check proxy transport, git-push parse
hang, `/cd` resume-empty, `/diff` raw-blob, `/review`→`/code-review` workflow
rework); (d) dormant-flag-gated in OCC (`SendMessage` classifier + truncation —
`KAIROS` off). Each is recorded in §4 with its specific blocker.

**Explicit no-op check (2.1.223):** "Fixed workflow scripts being able to use
dynamic `import()` to run code outside the workflow sandbox." The official fix
adds an AST `ImportExpression` scan at compile time. OCC's workflow engine never
sets `importModuleDynamically` on its `vm.Script`, so runtime `import()` throws
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` — **verified fail-closed on both Node
and Bun** (`vmprobe`). OCC additionally blocks `import(` at load time. No OCC
change needed; recorded as no-op with evidence.

## 3. Landed this round (binary-verified, unit-verified)

### 3.1 (A) 2.1.223 P0 — `test_command` integrity chain (`src/utils/bash/ast.ts`)

The official 2.1.223 `test_command` security path, brought to byte-parity. OCC's
OCC-44 port was partial (regex/extglob RHS case only); this round lands the rest
of the chain, all reason strings byte-identical to the ELF:

1. **Unparsed-bytes gap walker** (`checkTestCommandUnparsedBytes` +
   `isWhitespaceOrCommentGap`): every gap between/after `test_command` children
   must be whitespace-only (inside `[[ ]]` also newlines/`#` comments); a child
   extending past the parent span → "gap byte accounting is untrustworthy".
   Catches parser-dropped bytes the shell would still see (e.g. `[ abc == ]`,
   where tree-sitter swallows the `==`).
2. **Early-close empty-operator check**: an empty `[`/`[[`/`]`/`]]` token (quote
   in operator position) → "test_command early-close".
3. **`containsStandaloneBracketCloser` (cys) helper**: masks POSIX bracket
   expressions (`[[:alpha:]]`, `[=x=]`, `[.x.]`, `[]]`, `[^x]`) with NUL, then
   flags any remaining `]]` lacking word chars on both sides (a potential
   conditional closer).
4. **`walkTestExpr` hardening** (new `inBracketBracket` param, official ordering):
   - zsh `$name[expr]` / `$name:mod` recursive-eval precheck on expansions.
   - synthesized zero-width operator token check.
   - **NEW 2.1.223 pattern-leaf checks** on `regex`/`extglob_pattern`: ``&&``
     ("shell cond-lexer divergence — zsh splits the word there") and standalone
     `]]` closer ("zsh may close the conditional early").
   - `test_rhs_missing` case ("parser dropped consumed bytes").
   - **default-case `]]` desync check**: a quoted operand whose resolved text has
     `]]`+separator (`/]].*[;\n&|<>]/s`), or (in `[[ ]]`) a standalone `]]`
     closer → fail closed, reason branching on bracket context.

OCC-44's existing test `[[ abc =~ (a(b ]]` now reports the gap-walker reason
(the official runs the gap walker before the expression walk — same ordering);
the test was updated to the official-faithful reason with an explanatory comment.
The paren-balance scan remains as a defensive layer (identical to the official).

### 3.2 (B) 2.1.223 — subagent `bypassPermissions` org-policy gate (`runAgent.ts`)

When an agent definition declares `permissionMode: bypassPermissions`, the
official 2.1.223 spawn path consults the bypass-disabled predicate and, if
disabled (GrowthBook gate `tengu_disable_bypass_permissions_mode` OR settings
`permissions.disableBypassPermissionsMode: "disable"`), keeps the parent mode and
warns. OCC already exports the equivalent predicate
(`isBypassPermissionsModeDisabled`, `src/utils/permissions/permissionSetup.ts`);
this wires it into the `agentGetAppState` mode override. Warning message
byte-identical to the binary. Fail-closed: the gate only ever restricts (keeps
parent mode), never loosens.

### 3.3 (C) Live-path compensation guard (`bashPermissions.ts`)

`hasQuotedBracketCloserInConditional` + a `mode !== 'bypassPermissions'` gate in
`bashToolHasPermission` (same shape as M4/M5). A STANDALONE `]]` inside a quoted
span of a `[[ ]]` conditional → `ask`. A legitimate closer is never quoted; a
`]]` embedded in a word (word chars both sides, e.g. `"a]]b"`) is allowed.
Over-matching only costs an extra prompt, never an auto-allow.

**Why this matters:** OCC's AST guards (§3.1) sit behind `TREE_SITTER_BASH*`,
whose WASM is unavailable at runtime — `parseCommandRaw` returns null, so the
LIVE legacy path decides. Probing (permissive `Bash([[ *)` rule) showed the live
path auto-`allow`ed `[[ abc == "a]]&&id" ]]` / `[[ abc == "a]];id" ]]` /
`[[ abc == "x]]" ]]` before this guard. This guard makes the live path fail
closed (ask), matching the official's observable behavior for the same class.

**Exploitability note (honest framing):** the official 2.1.223 changelog targets
"crafted command could hide part of itself from permission checks." To verify the
underlying mechanism, the security review installed **zsh 5.9** and **bash 5.2**
and tested the quoted-`]]` forms plus ~25 variants (quoted, backslash-escaped,
quote-desync, `emulate ksh/sh`, `SH_WORD_SPLIT`, newline, glue forms) with an
execution marker. **None executed the hidden tail** in either shell — `zsh -x`
shows zsh treats `"a]]&&id"` as a single word and leaves the conditional unclosed
(parse error). So the live threat is **not currently demonstrable** in these
shells; this guard is **defense-in-depth that fails closed** and aligns OCC's
observable behavior with the official fix (over-matching costs an extra prompt,
never an auto-allow). The detector's escape handling was hardened in the security
review (backslash is literal for `]` inside double quotes, so `\]` no longer
slips past — see §5). If a deployed shell is found where the mechanism is
exploitable, this guard already closes the live path.

## 4. Staged backlog (end of round)

### `2.1.223`
- **Tabs/invisible-Unicode approval-dialog fix** — new `sanitizeForTerminal`
  (`stripVTControlCharacters` + strip `\p{Cc}\p{Cf}  ` except `\t\n`)
  located at cliWarn/permission-context/import call sites; the dialog-rendering
  change itself not yet pinpointed (Ink component diff). Needs a dedicated
  decompilation round of the permission-dialog render.
- **`/review` → `/code-review` alias + level reuse** — official `/code-review`
  is now a bundled-workflow command (effort levels, `codeReviewLastEffort` reuse,
  `ultra` cloud subcommand). OCC's `/code-review` is a bundled *skill* (different
  architecture); bundled workflows are trimmed by design (same category as
  deep-research — "never invent"). Large rework; staged.
- **`strictKnownMarketplaces`/`blockedMarketplaces` `owner/*` wildcard** — plugin
  marketplace surface is trimmed in OCC (staged since OCC-44).
- **Gateway model discovery provider-prefixed IDs / `modelOverrides` unknown keys
  ignored / managed-settings server-delivered env merge / sandbox `denyWrite`
  covers cwd** — backend/managed-settings/sandbox-proxy surfaces; need per-site
  decompilation and OCC-surface confirmation.
- **Resume-after-`/cd`-empty / malformed-diagnostics-attachment resume / forked-bg
  "already resuming" / git-push parse hang** — resume/bg-session machinery; each
  needs its binary site pinpointed.
- **`CLAUDE_CODE_DISABLE_1M_CONTEXT` auto-compaction change / unknown-model window
  enforcement** — context-management behavior change; needs the new model-list +
  compaction-hold logic decompiled.
- **Subagent-model-restricted warning / `/teleport` hint** — OCC has no teleport
  surface (staged since OCC-37); model-restricted warning needs the binary site.

### `2.1.222`
- **Worktree-isolation destructive-git fix** — couples to the official's new
  worktree pin/pointer subsystem (`bridge:pointer` fanout, session re-entry
  guards — `pin-is-protected-checkout`, `worktree-gone`, etc. reason strings).
  Porting just the bash-side guard without the pin subsystem would be invented.
  Staged pending a dedicated worktree-pin decompilation round.
- **PreToolUse auto-allow hooks bypass in bg-agent tasks** — OCC's bg/daemon
  surface is self-built (daemon supervisor), not 1:1 with official bg sessions;
  needs the official site + OCC mapping.
- **`/usage-credits` dismissed-state / `/usage` MCP over-attribution** — billing/
  accounting, Anthropic-backend-bound.
- **Startup connectivity-check proxy transport / "Connection closed mid-response"
  / stream idle timeout on custom base URL** — streaming/transport internals; each
  needs its binary site.
- **Session↔PR linking / claude.ai connector false-auth / removed-MCP tool errors
  / spinner effort label / file-watcher crash / screen-reader backspace echo /
  host model-selection keys vs stale managed-settings / disable-model-invocation
  refusal / `/diff` raw-git-blob / Remote-Control auto-start scope** — each needs
  a dedicated site + OCC-surface check; several are surfaces OCC trims.
- **`SendMessage` summary truncation + auto-mode classifier** — `SendMessage` is
  dormant in OCC (`KAIROS` flag off). No user-visible impact; staged/no-op.
- **ultraplan removed** — OCC's ultraplan is flag-gated (`feature('ULTRAPLAN')`,
  not in the allowlist → dormant in shipped builds). Behaviorally already
  equivalent (no ultraplan in production). Effectively a no-op.

## 5. Verification gates this round

- **Unit:** new 2.1.223 AST tests (19), live-path pin + detector tests (13, incl.
  backslash-escape variants added in security review), updated OCC-44 zsh test.
  Full src suite **1783 pass / 0 fail / 3921 expect()**. BashTool + permissions
  367+ pass / 0 fail. AgentTool 51 pass.
- **Live-path probe:** permissive `Bash([[ *)` rule — benign conditionals `allow`,
  all quoted-`]]` smuggled forms (incl. backslash-escaped `\]]`) now `ask` (fail
  closed); benign forms (`[[ abc == "hello world" ]]`, `[[ abc == "a]b" ]]`,
  `[[ abc == "a]]b" ]]`) stay `allow`.
- **Security review (independent reviewer, empirical):** verdict SAFE TO RELEASE —
  no backdoor, no new `'allow'` path, all new code fail-closed; walkTestExpr /
  gap-walker byte accounting verified correct; runAgent bypass gate verified
  fail-closed. One MEDIUM detector false-negative (backslash-escape inside double
  quotes) **found and fixed** this round (escape-skip now honors that `\]` is
  literal for `]` in dquotes); residual LOW items are fail-closed over-flagging /
  pre-existing cached-policy behavior, not weakenings. Reviewer additionally
  installed zsh 5.9 + bash 5.2 and confirmed the quoted-`]]` forms do NOT execute
  a hidden tail in current shells (defense-in-depth framing, §3.3).
- **Workflow `import()` no-op probe:** `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`
  on both Node and Bun.
- **e2e (built `dist/cli.js`):** `occ-versioning` + `commands-alignment` 6 pass;
  `version-2.1.219-*` + `resume-interrupted-turn-221` 50 pass / 182 expect().
- **REPL (tmux, real creds):** boot green (OCC v2.1.294, logo, model, branch),
  real model round-trip (`READY`), `/status` shows `Version: 2.1.294`, clean exit.
  `-p` smoke: `echo "say PONG" | occ -p` → `PONG` exit 0.

## 6. Release decision

Cut **`2.1.294`** (gate: acceptance). Security-positive release — lands the
2.1.223 P0 bash integrity chain + subagent bypass org-policy gate + live-path
quoted-`]]` compensation guard. Per the 发版流程: tag `v2.1.294` → `publish.yml`
(build → npm publish → Create GitHub Release), then verify `/releases` ↔ `/tags`
consistency.

## 7. Tracked-upstream pointer (end of round)

`2.1.218` fully + `2.1.219`/`2.1.221` **partial** + `2.1.222` staged +
`2.1.223` **partial (P0 bash integrity chain + subagent bypass gate landed;
remaining items staged per §4)**. Official latest `2.1.223`.
