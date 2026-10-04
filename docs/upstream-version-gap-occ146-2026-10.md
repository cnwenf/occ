# Upstream Version Gap — OCC-146 (2026-10 round)

**Round:** OCC-146 · **Date:** 2026-10-05
**Tracked official before round:** Claude Code `2.1.288`
**Official latest this round:** Claude Code `2.1.289`
**OCC release target:** `2.1.369`

Verification method: `npm view @anthropic-ai/claude-code` (`latest`/`next`) + GitHub
releases + a fresh linux-x64 ELF download of `2.1.289`, byte-diffed against the
`2.1.288` ELF (`/root/cc-diff-289/v28{8,9}/package/claude`, extracted JS regions
`v28{8,9}.region.txt`, `.strings`, `added.strings`/`removed.strings`). No official
binary was ever executed. Changelog source: the package's own `CHANGELOG.md`.

`2.1.289` is a **plugin/mod-surface–heavy** release: 28 changelog entries, of which
the large majority concern the official plugin pane / mod SDK / VSCode extension /
published-artifact web reader — none of which OCC ships (Plugins/Marketplace are
removed; see `CLAUDE.md` "Stubbed/Deleted Modules"). The portable, OCC-relevant
subset is **4 security/robustness fixes** (#1, #2, #3, #14/#15) plus one
render-path item (#19) that OCC is structurally immune to.

---

## §1 — LANDED fixes (portable, byte-verified)

### #1 — nested compound deny/ask rule not holding over a mod's approval  ✅ FIXED (this session)

> "Fixed a deny or ask rule on a **nested part of a compound shell command** not
> holding over a **user-installed mod's approval** on managed machines."

**Official mechanism (byte-verified v288→v289 ELF diff).** The one-level rule
extractor `Krt(e,n)` (`if(g?.type==="rule")return g.rule`) became **recursive**
`kTe(e,n)`:

```js
S = g?.type==="rule" ? g.rule : kTe(g,n);
if (S!==void 0) return S;
```

`kTe` is consumed by `xst(e)` — the matched-rule extractor
(`direct rule ?? kTe(n,e.behavior) ?? matchedAskRule`). Separately, the recursive
**ask predicate** `G5e` (IDENTICAL in v288 and v289 — pre-existing) walks
`subcommandResults`:

```js
function G5e(e){
  if(e?.type==="rule" && e.rule.ruleBehavior==="ask") return true;
  if(e?.type==="subcommandResults")
    for(let n of e.reasons.values())
      if(n.behavior==="ask" && G5e(n.decisionReason)) return true;
  return false;
}
```

wrapped by `cY(e)=G5e(e.decisionReason)||e.matchedAskRule?.ruleBehavior==="ask"`.
Official gates its hook / classifier / bypassPermissions override paths on
`!cY(ye)` (call sites `b4t`, the auto-mode `hookAskFloor!==true && !cY(ye)`
block, `Ce==="bypassPermissions" && !cY(ye)`, `V7o`, and
`if(B?.behavior==="ask" && cY(B)) return B`).

**OCC gap.** OCC has no `kTe`/`xst`/`matchedAskRule` — different architecture.
`checkRuleBasedPermissions` step **1f** inspected only the top-level
`decisionReason?.type === 'rule'`. A compound command with ≥2 non-allow parts
where one part carries an ask rule produces (via `bashPermissions.ts` merge flow,
return ~line 3662) `{behavior:'ask', decisionReason:{type:'subcommandResults',
reasons:Map}}`. 1f missed the wrapped rule-ask → returned `null` →
`resolveHookPermissionDecision` (toolHooks.ts:504-511) let the **PreToolUse-hook
allow** (the OCC analog of a "user-installed mod's approval") stand, bypassing the
nested ask. The **deny** half was already safe at three layers (any-subcommand-deny
short-circuit in bashPermissions.ts:3349-3366; step 1d returns any deny incl.
wrapped; toolHooks.ts:474-478 deny overrides the hook).

**OCC fix (faithful `G5e` port).** Added `isRuleAskDecisionReason(decisionReason)`
— a recursive mirror of official `G5e` — in `src/utils/permissions/permissions.ts`
(~line 1299), and rewired **both** 1f sites to consult it:

- `checkRuleBasedPermissions` 1f (~1400) — the hook/mod-allow path consulted by
  `resolveHookPermissionDecision`.
- `hasPermissionsToUseToolInner` 1f (~1512) — the bypassPermissions path, matching
  official `Ce==="bypassPermissions" && !cY(ye)`.

The fix is a **strict superset** of prior behavior (fail-closed: it can only turn a
would-be `null` into an `ask`, never the reverse), so it cannot regress existing
allows. Deny half untouched (already covered).

**Tests:** `src/utils/permissions/__tests__/compoundNestedAsk289.test.ts` (7):
one-level nested rule-ask → ask; deeply nested (two-level recursion) → ask;
all-allow/passthrough compound → null (no false positive); top-level rule-ask →
ask (1f regression guard); passthrough → null; and two end-to-end
`resolveHookPermissionDecision` cases proving hook-allow + nested rule-ask routes
to `canUseTool` (prompt) while hook-allow + all-allow compound still stands.
`test/utils/hookAskFloor.test.ts` (10) re-run green — the safetyCheck-ask path is
unchanged.

### #2 — terminal freeze on many unclosed `<script>` tags / nested `${`  ✅ FIXED (prior session)

> "Fixed the terminal freezing on short code blocks with many unclosed `<script>`
> tags or deeply nested `${` substitutions."  (Same root cause as web-side #26.)

The cli-highlight html/xml grammar backtracks exponentially on repeated unclosed
`<script>` tags (measured: n=10 ≈ 103 ms, n=15 ≈ 600 ms, n=20 > 6 s), freezing the
render path. **OCC-side mitigation** (an approximation, not a byte-port — the
official grammar fix lives in the closed highlight engine): `cliHighlight.ts`
exports `isPathologicalHtmlForHighlight(code, language)` — `MAX_SCRIPT_TAGS_TO_HIGHLIGHT
= 8`, `SCRIPT_OPEN_TAG_RE = /<script\b/gi`, `HTML_FAMILY_LANGUAGES = {html,xml,xhtml}`.
Above the threshold the wrapped highlighter passes the block through as **plain
text** (verbatim, fast) instead of highlighting. **Divergence noted:** official
still highlights these blocks (with a fixed grammar); OCC trades highlighting for
responsiveness on pathological input only. Tests: `cliHighlight289.test.ts` (7) —
threshold detection, non-html never guarded, pathological passthrough fast +
verbatim, benign html still highlighted.

### #3 — `Read` deny rules not applying through a symlink  ✅ FIXED (prior session)

> "Fixed `Read` deny rules not applying to files @-mentioned, changed, or selected
> in the IDE through a symlink."

The attachment path (`isFileReadDenied` in `src/utils/attachments.ts`) matched only
the requested spelling, so a `Read(<realpath>)` deny was bypassed by @-mentioning a
symlink to it. Fix: check **every** spelling from `getPathsForPermissionCheck`
(requested + all symlink targets) — the same set `checkReadPermissionForTool` uses —
denying if ANY matches (fail-closed). Official rule form for an absolute path uses
the gitignore-style `//` root anchor, so a real `/tmp/...` is written
`Read(///tmp/...)`. Tests: `readDenySymlink289.test.ts` (4) — symlink + real both
caught by an exact deny; unrelated deny → false; `Read(//dir/**)` glob catches the
symlink spelling.

### #14 / #15 — Bash deny/ask missing a command behind an env-var prefix under sandbox auto-allow  ✅ FIXED (prior session)

> #14 "…missing a command behind an environment variable prefix with an **expanded
> value** (e.g. `TZ="$HOME" rm -rf build`) when the sandbox auto-allows commands."
> #15 "…being skipped under sandbox auto-allow when a **bare variable assignment**
> came before the command."

Official `b5o` token-scanner strips env-var prefixes before the deny/ask match.
OCC fix in `bashPermissions.ts`: widened `ENV_VAR_PATTERN` so **simple** expansions
(`TZ=$HOME`, `FOO=bar`) are stripped and matched against the trailing command, while
**command-substitution** residues (`$(...)`, backtick, `$((`) are **refused**
(fail-closed — not stripped, so they cannot smuggle). Disjoint atoms keep matching
linear-time. Tests: `envPrefixExpansion289.test.ts` (22) across three describes —
strip units, deny/ask rule matching via `_matchingRulesForInputForTesting`
(`skipCompoundCheck:true`), and full-path `bashToolHasPermission`.

**Residual (staged, honest):** a command-substitution *inside* the env value
(`FOO="$(rm -rf /)" echo hi`) against a deny rule `Bash(rm:*)` yields **0 matches**
— the `$(...)` residue is refused for stripping, so the inner `rm` is not surfaced
as a matchable atom. This is fail-*open* for that specific nesting and is documented
here rather than papered over; it mirrors the limit of the OCC token-scanner
approximation vs. the official AST scanner.

---

## §2 — NOT AFFECTED (verified immune)

### #19 — tab / stray escape / C1 control / CRLF drawing over the rows below  🛡 NOT AFFECTED

> "Fixed text with a tab, a stray escape and a C1 control, or a short text with a
> tab and CRLF line endings, drawing over the rows below it."

OCC's renderer is a **cell-grid with explicit cursor positioning**
(`log-update.ts:676`), not a row-append model. Tabs are expanded at **measure**
(`ink/dom.ts:370-372` `expandTabs`, 8-col `tabstops.ts:31`) **and** at **paint**
(`ink/output.ts:663-676`, clipped at `screenWidth`); C0/CR are skipped at paint
(`output.ts:751-756`); a stray-ESC state machine consumes malformed sequences
(`output.ts:682-750`); C1 controls are zero-width (`ink/stringWidth.ts:135` treats
0x7f–0x9f as zero-width; `Bun.stringWidth(C1)=0`). The official failure mode
(under-counted rows overwritten by the next paint) is **structurally impossible** in
a positioned cell grid. End-to-end probe confirmed all three trigger classes leave
the marker row intact.

**Staged observations (not defects, recorded for parity):**
- **Screen-reader mode keeps TAB** verbatim (`screen-reader-render.ts:59-60`,
  binary-verbatim `R0c`) — can desync SR line math. This mirrors official behavior
  and is likely NOT what #19 fixed.
- Bare C1 bytes used as CSI parameters can render literally in some positions.
- No dedicated control-character test coverage exists in OCC's render suite.

---

## §3 — N/A (surface absent in OCC — by design, not alignment debt)

OCC removed Plugins/Marketplace and does not ship the mod SDK, plugin code pane,
VSCode extension, or the published-artifact web reader. The following 2.1.289
entries touch only those surfaces and have no OCC code path:

- **#4** [VSCode] revert of `claude auth status` sign-out frequency — VSCode ext only.
- **#5** plugin code-pane large-file single-layout — plugin pane UI (absent).
- **#6** `plugin list`/`eval`/`update` stale copy + symlinked `--plugin-dir` hot reload — plugin CLI (removed).
- **#7** installed mods not loading in first session after upgrade — mod loader (absent).
- **#8** plugin rows above prompt stale during fullscreen Background-tasks dialog — plugin UI.
- **#9** plugin panes drawing nothing for localhost/`@`/uppercase-host/`file:` links — plugin pane UI.
- **#10** user-installed plugin rewriting an org-managed MCP server's sign-in tool descriptions — **verified N/A on three independent breaks**: (a) OCC's auth-tool descriptions are local template constants (`McpAuthTool.ts:189-210` `buildMcpAuthToolDescription`, sanitized interpolations only); (b) the plugin manifest schema has **no `tools` key** — no write surface for tool descriptions; (c) plugin MCP servers are namespaced `plugin:<pluginName>:<serverName>` at the **lowest** precedence (`mcp/config.ts:1274-1281`), and the enterprise scope (`managed-mcp.json`, root-owned) is **exclusive** — it drops all other scopes (`config.ts:1126-1142`).
- **#11** freeze/forced-quit at launch on an unknown Box border style from a plugin — plugin UI.
- **#12** supervised/background sessions ending when a plugin on-screen handler threw async — plugin handlers.
- **#13** sessions ending when a zero-height plugin region kept growing — plugin regions.
- **#16** `claude plugin validate` skipping a plugin when the folder holds a marketplace manifest — plugin validate (removed).
- **#17** `agent.spawn` for teammates / one agent id across plugin hook events / idle+waiting in `$.agent.list()` — mod SDK (`$` global) surface (absent).
- **#18** sessions ending when a mod `ui.render` value made a row throw — mod `ui.render`.
- **#20** right-aligned mod pane/band content under the close mark — mod pane UI.
- **#21** a mod's `Client` failing while drawn taking down surrounding draws — mod `Client`.
- **#22** `claude plugin validate` failing an Anthropic marketplace's own plugin + `--json` clean list — plugin validate.
- **#23** a failed mod band telling cards below to step aside — mod band UI.
- **#24** failed plugin component showing `Error`/nothing as its reason — plugin component UI.
- **#25** improved mod-author line when a band/pane fails to draw — mod author UI.
- **#26** published-artifact web pages freezing on many unclosed `<script>` tags — web artifact reader (not CLI); **same root cause as #2**, which OCC mitigated on the CLI side.
- **#27** a mod's `Client` region staying failed for the whole session — mod `Client`.

---

## §4 — Staged observations / next-round candidates

1. **Auto-mode classifier lacks an official `!cY(result)` rule-ask guard.** The
   auto-mode block in `permissions.ts` (~599-880) guards safetyCheck (~614),
   requiresUserInteraction (~631), and hookAskFloor (~639) before the classifier
   (`classifyYoloAction`, ~833), but has **no** rule-ask (`cY`-equivalent) guard.
   Consequence: in **auto** permission mode a rule-ask (top-level *or* the nested
   ones this round's #1 fix now catches) can be overridden to `allow` by the
   auto-mode classifier. This is **PRE-EXISTING** — official's `cY`/`G5e` predicate
   was already recursive in v288, so it is **not** part of the 2.1.289 #1 diff, and
   auto-mode is **not** the #1 "managed machines" scenario (which is default mode +
   policySettings, fully closed by this round's fix). Recorded as an observation;
   adding an auto-mode `!cY` guard is a broader behavioral change deferred to its
   own round (would need to reconcile with the existing `hookAskFloor` fast-path and
   the `hookAskFloor.test.ts:381` assertion that a safetyCheck-ask in auto mode is
   classifier-overridable).
2. **`_5o` official AST token-scanner** for env-prefix stripping — OCC uses the
   widened-regex approximation (see #14/#15). The command-substitution-inside-env
   residue (§1 #14 residual) is the visible limit; a faithful AST port would close
   it but needs dedicated decompilation.
3. **`b5o` / control-char render test coverage** — OCC has no dedicated
   control-character (tab/C1/CRLF) render test; §2's immunity was verified by probe,
   not by a committed regression test.

---

## §5 — Round verification summary

- **New tests this round:** `compoundNestedAsk289.test.ts` (7) ·
  `envPrefixExpansion289.test.ts` (22) · `cliHighlight289.test.ts` (7) ·
  `readDenySymlink289.test.ts` (4) = **40 new tests**.
- **Affected-suite run:** `bun test src/utils/permissions/ src/tools/BashTool/__tests__/
  src/utils/__tests__/readDenySymlink289.test.ts src/utils/__tests__/cliHighlight289.test.ts`
  → **1137 pass / 1 skip / 0 fail** (2787 expect, 66 files).
- **Sibling run:** `compoundNestedAsk289 + hookAskFloor` → **17 pass / 0 fail**.
- **Source edits:** `permissions.ts` (#1), `bashPermissions.ts` (#14/#15),
  `attachments.ts` (#3), `cliHighlight.ts` (#2), plus one stale e2e assertion
  updated (`version-2.1.154-196-code-review-simplify.e2e.test.ts`) to un-red main CI.
- Build + live REPL/`-p` self-acceptance: see §6 (this round) / issue comment.

---

## §6 — Self-acceptance (REPL真机 e2e) — DONE

Run against the freshly built bundle (`bun dist/cli.js`, live gateway API key):

- **Build green** — `dist/cli.js` 29.82 MB, `MACRO.VERSION=2.1.368` (bumped to
  2.1.369 at release). Biome lint clean on all 5 edited source files.
- **`occ --version`** → `OCC 2.1.368`.
- **Headless `-p` smoke** — `echo "say PONG" | bun dist/cli.js -p` → `PONG`, exit 0
  (a non-fatal `[claude-code:unrecognized_model] glm-5.2` gateway notice precedes it;
  the turn completed end-to-end).
- **tmux REPL boot** — banner `OCC v2.1.368 · Open C Code`, MODEL `glm-5.2 · xhigh
  effort`, PROJ `git:work`, auto-mode indicator, prompt ready.
- **Interactive round-trip** — `reply with exactly: REPL_OK` → `● REPL_OK`; token
  accounting advanced to 65986.
- **`/status`** — renders Version 2.1.368, Session ID, cwd, Auth token
  (`ANTHROPIC_AUTH_TOKEN`), base URL, Model `glm-5.2`, `MCP servers: 3 connected,
  1 failed`, setting sources, auto-mode-server state.
- **Permission-mode cycle** — `shift+tab` cycles auto → accept-edits → plan → auto
  live (the permission-mode UI that gates the #1 decision path renders and switches).
- **Clean exit** — `/exit` ends the session, tmux server shuts down.

The #1 nested-compound-ask decision itself is verified by the committed
`compoundNestedAsk289.test.ts` (unit + end-to-end `resolveHookPermissionDecision`
against the real production functions) rather than a live hook+rule rig, which is
not reproducible in a smoke REPL. No `uvx claude-code` cross-run was performed this
round (official binary is never executed per forensics discipline; behavioral parity
is argued from the byte-verified ELF diff in §1).
