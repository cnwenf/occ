# Upstream version gap — OCC-139 round (official claude-code 2.1.314 → 2.1.316)

Date: 2026-11-01 · Trigger: OCC Leader six-point work order (comment `15d0b069`) · Issue: OCC-139
Method: `upstream-tracking` + `aligning-with-official-binary`. Official ELF 全程只做
`strings`/`grep -aboF`/`dd` 字节取证，**never executed as a model backend**（occ136 §11.5 纪律 /
本轮 Leader 令"官方二进制只读取证，不执行"）。

## §1 Version facts (three-way verified, 2026-11-01)

| Source | Value |
|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.316** (published 2026-10-31T00:42:05Z); `stable` = 2.1.309 |
| npm publish times | 2.1.314 → 2026-10-30T00:12:56Z; **2.1.315** → 2026-10-30T21:05:24Z; **2.1.316** → 2026-10-31T00:42:05Z |
| Official GitHub tags `anthropics/claude-code` | `v2.1.314` ✓ (`b3f291d1…`), `v2.1.316` ✓ (`80c6959d…`), **`v2.1.315` tag ABSENT** |
| OCC pre-round | package.json **2.1.409**, tracks **2.1.314 (partial)** (OCC-138 round) |
| v314 linux-x64 ELF | 298,229,464 B, md5 `5ea08c5120a3a4204a9e2dc9a7c2c886` (== occ138 ledger ✓) |
| v315 linux-x64 ELF | 328,262,000 B, md5 `3d131866bc49cff05599d77e440ba11e` |
| v316 linux-x64 ELF | 328,262,000 B, md5 `7214c8fa957d6dadd1c080d0f9be51fa`, sha256 `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824` |
| strings uniq (`strings -n 8 … | sort -u`) | s314 = 350,703 / s315 = 365,191 / s316 = 365,190 |
| strings diff | 314→316: **43,982 added / 29,495 removed**; 315→316: **8,167 added / 8,168 removed** |

**Verdict: REAL version gap 2.1.314 → 2.1.316**, two published steps:

- **2.1.315** — NO changelog section at all (the official CHANGELOG jumps 2.1.316 → 2.1.314),
  NO GitHub tag, binary grew **+30,032,536 B** vs v314 (asset/runtime payload growth; strings
  uniq +14,488). Treated as an unannounced interim release; its user-visible surface is
  subsumed by 2.1.316 (315→316 diff is a near-wash: identical ELF byte size, uniq count −1,
  ~8.1k strings churned both ways).
- **2.1.316** — 55-bullet changelog release, published ~3.5 h after 315; effectively the
  announced face of the 315+316 pair.

Forensics scratch: `/tmp/cc-diff-316/` (v314/v315/v316 unpacked + s314/s315/s316 + added/removed
diffs + env/cmd catalogs), **用完即删** at closeout.

## §2 New named surface sweep (v314 → v316)

**New env vars (12 changelog/registry-relevant + 2 bg-socket):** all verified **0 hits** in OCC
`src/` pre-round (grep sweep):

| Env var | Disposition |
|---|---|
| `CLAUDE_CODE_DISABLE_ULTRATHINK` | **PORT ✓ this round** (§3 bullet 1) |
| `CLAUDE_CODE_SUBAGENT_EFFORT` | **PORT ✓ this round** (§3 bullet 4) |
| `CLAUDE_CODE_DISABLE_LOOPED_CROSS_CERT_DROP` | STAGE — TLS cert-chain filter kill switch (§3 bullet 3) |
| `CLAUDE_CODE_DISABLE_SELF_NAMED_CERT_DROP` | STAGE — same cert-chain cluster |
| `CLAUDE_CODE_DISABLE_HTTPS_AGENT_KEEPING` | STAGE — HTTP keep-alive agent cluster (§3 bullet 12) |
| `CLAUDE_CODE_DISABLE_HELD_MESSAGE_RECOGNITION` | N-A — held-message recognition (gateway/cloud turn machinery absent in OCC) |
| `CLAUDE_CODE_AUTO_MODE_FULL_CONTEXT` | N-A — auto-mode server context (host-app surface) |
| `CCR_ONE_PLUGIN_LOAD_PER_RELOAD` | STAGE — plugin reload internals (plugin surface trimmed) |
| `MCP_NO_REDIAL_AFTER_POLICY_REFUSAL` | STAGE — MCP transport policy (needs per-site forensics) |
| `MCP_SKIP_UNCHANGED_RELIST` | STAGE — same cluster |
| `SESSION_BEGAN_AS_COPY` | N-A — bg/copy-session subsystem absent |
| `SORTED_OTTER` | N-A — internal experiment gate (no consumer surface) |
| `CLAUDE_BG_SILENT_PEER_TIMEOUT_MS`, `CLAUDE_BG_SOCK_ADMIT_SILENT_PEERS` | N-A — bg-session UDS socket layer absent (UDS_INBOX off) |

Env registry site: `CLAUDE_CODE_SUBAGENT_EFFORT:()=>ki` @273666370; model-config env list
@274389256; the big scrub list @307079258 (contains DISABLE_ULTRATHINK + DISABLE_WEB_FETCH —
same official kill-switch family).

**New slash commands: NONE** (cmd314/cmd316 catalog diff empty for command names).

**v316 model catalog** @273821232: claude-sonnet-5 `default_effort:"high"`, capabilities
`["effort","max_effort","xhigh_effort","adaptive_thinking",…]`; catalog reader `JSi`:
`D3(e,n)?.runtime?.default_effort?.trim().toLowerCase()` → valid level. No new model IDs vs v314.

## §3 Full changelog triage (2.1.316, 55 entries)

Triage key: **PORT** (landed this round) / **STAGE** (surface exists but needs dedicated
per-site forensics or is a broad behavioral change — deferred with evidence) / **NO-OP** (OCC
already consistent or structurally immune) / **N-A** (gateway/cloud/VSCode/Slack/runner/
Desktop/3P-backend surface OCC does not ship).

| # | Entry (abridged) | Verdict | Rationale |
|---|---|---|---|
| 1 | `CLAUDE_CODE_DISABLE_ULTRATHINK` turns the ultrathink keyword off | **PORT ✓** | §4 WP-A. Official gate `ePt` @276986161 byte-verified; v314 `hxt` @247108806 had NO env arm — new in 2.1.316 |
| 2 | Gateway pooled group budgets (`pooled_budget` admin API) | N-A | Claude apps gateway admin API |
| 3 | `DISABLE_LOOPED_CROSS_CERT_DROP` keeps mutually-certifying cross-certs | STAGE | Cert-chain filter lives in the official native TLS layer; JS-side consumer not yet located — needs dedicated forensics before any port |
| 4 | `CLAUDE_CODE_SUBAGENT_EFFORT` sets subagent effort when nothing else names one | **PORT ✓** | §4 WP-B. Official `XCt` @278280656 + `Pxo` @291219542 + single call site @297031178 byte-verified |
| 5 | Gateway `managed.policy_mode: layered` | N-A | Gateway policy engine |
| 6 | Gateway `guardrail.input_tagging` (Bedrock guardrail prompt tags) | N-A | Gateway/Bedrock guardrail backend |
| 7 | Opus 4.8 fast mode deprecated 2026-10-30, removed 2026-11-30 | STAGE | OCC's fast-mode set (`opus-4-7‖opus-4-8‖opus-5`, 2.1.220 port) still lists opus-4-8. Deprecation is server-enforced; revisit at the 11-30 removal (check whether v316+ binaries already dropped opus-4-8 from the client-side set before mirroring) |
| 8 | Shell commands left running when Claude Code exits by itself (cred refused / cloud archive) | STAGE | Exit-path child-process-group reaping; needs per-site forensics of the official exit handler vs OCC's shutdown path |
| 9 | Bash aliases with line breaks / dash-prefixed function names garbled or lost | STAGE | Shell-snapshot re-emitter cluster; official scrub sets `eo`/`rs` @274845383/@274878630 already located — port next round |
| 10 | Bash scripts stop after first command when `SHELLOPTS` exported | STAGE | Same shell-snapshot cluster as #9 (official fix unsets/filters `SHELLOPTS` in the snapshot env) |
| 11 | PowerShell hooks not blocking on exit code 2 after type cast / `param` / `using` / attribute | STAGE | Windows PowerShell surface; OCC ships PowerShellTool but the hook-wrapper parser site needs forensics |
| 12 | Network requests hang on cut-off/corrupted compressed response | STAGE | HTTP keep-alive/compression layer (`DISABLE_HTTPS_AGENT_KEEPING` is the paired kill switch); locate JS-side agent config before porting |
| 13 | `sonnet`/`opus`/`haiku` on Vertex/Bedrock error mid-session instead of falling back | STAGE | 3P alias-fallback logic exists in OCC providers; per-site diff needed |
| 14 | Gateway not checking every named model against `availableModels`/`deniedModels`/`models` | N-A | Gateway |
| 15 | `claude auth login` refusing under managed gateway settings | N-A | Gateway sign-in |
| 16 | `--restricted` sessions uploading files outside working dirs when a Read allow rule covered them | **STAGE — security, next-round top priority** | OCC's `--restricted` mode surface exists (OCC-108 ledger); the upload/attachment × Read-allow-rule interaction needs byte-level forensics before porting. Flagged for the security reviewer |
| 17 | Invisible characters in prompts needing a second Enter | STAGE | PromptInput keypress/submit path; candidate located pre-compaction, needs per-site work |
| 18 | Sub-agents inheriting parent sub-agent's model move to main model on bg wake | N-A | Background-job/message wake machinery (bg-session subsystem absent in OCC) |
| 19 | Managed `autoMode.allow` without `"$defaults"` regaining built-in exceptions via host `--settings` / `/permissions` / `/auto-mode-setup` | STAGE | Auto-mode allowlist merge; OCC has autoMode settings but not the host-app `--settings` injection arm |
| 20 | Cloud sessions/scheduled tasks not failed when auto mode got no safety verdict | N-A | Cloud |
| 21 | `claude -p` text output not saying why auto mode stopped (bg agent still running) | N-A | Bg-agent auto-mode interplay absent |
| 22 | `CLAUDE_CODE_AUTO_MODE_SERVER=1` ignored in host-started sessions behind proxy w/ betas off | N-A | Host-app (Claude Desktop) session start |
| 23 | Plugin MCP `headersHelper` corrupted `CLAUDE_PLUGIN_ROOT` + server URL when a credential-named env var held a switch value | STAGE | Plugin MCP surface partly trimmed; verify OCC's headersHelper support before porting |
| 24 | SDK `register_repo_root` not loading CLAUDE.md of outside dir (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`) | STAGE | SDK control-request surface; OCC ships sdk types but the control handler set is trimmed |
| 25 | Artifact tool `?` for `self`-level DB access rules + unquoted refuse-back | N-A | Artifact DB tooling absent |
| 26 | `/model <id>` not warning when model unrecognized + auto-compact assumes 200K | STAGE | `/model` exists; warning-text + context-window-assumption site needs forensics |
| 27 | "Hold space to speak" hint burning its 3 showings / empty key when unbound | N-A | Voice mode removed |
| 28 | Grep/Glob never returning when search process killed at timeout but doesn't exit (Windows) | STAGE | Process-kill hardening may be portable cross-platform; Windows-first symptom |
| 29 | Resume not restoring plan when `/clear`/`/resume` ran while conversation still saving | STAGE | Plan-persistence race; needs transcript-save-path forensics |
| 30 | First-run setup dropping words in narrow terminals | STAGE-low | Onboarding copy wrap; cosmetic |
| 31 | Enterprise survey card taking typed 1/0 after pause; now needs Enter | N-A | Enterprise survey card absent |
| 32 | Runner: message sent while working answered after Stop / process replaced | N-A | Self-hosted runner |
| 33 | Runner: MCP on/off switch lost when session moved machines | N-A | Self-hosted runner |
| 34 | Windows Git Bash: aliases/functions lost when rc sets errexit+pipefail with winpty aliases | N-A | Windows/Git Bash |
| 35 | `/code-review` from Code tab (Desktop/web) shows findings card | N-A | Desktop/web surface |
| 36 | `/diff` on large repos: one fewer full-repo git command per refresh + spacing when git slow | STAGE | Perf improvement; OCC `/diff` refresh path needs per-site diff |
| 37 | `/ultrareview` + cloud no-GitHub-remote messages | N-A | ultrareview/cloud surfaces absent (ultraplan removed precedent) |
| 38 | SSL certificate errors naming likely causes + fixes | STAGE | Error-message table; locate official message strings before porting |
| 39 | Auto mode: `autoMode.allow` without `"$defaults"` no longer removes built-in scheduled-task rule | N-A | Scheduled tasks absent |
| 40 | Team/Enterprise server-managed settings apply without approval prompt; unverifiable stored copy refused | N-A | Server-managed settings fetch is Anthropic backend |
| 41–44 | [VSCode] gateway sign-in panel; ultrathink xhigh+rainbow in chat; Effort slider/`[1m]` tag; `/btw` history deletion; auto-mode plan reload | N-A | VSCode extension |
| 45–49 | [Cloud sessions] form card; "Catching up…"; network secrets self-service; Changes-pane badge; Files-pane ../.. paths | N-A | Cloud |
| 50–53 | [Claude Tag] canvas edit refusal; Slack Connect untagged replies; scheduled-task checklist; participation choice | N-A | Slack/Claude Tag |
| 54 | [Code Review] analytics findings-by-severity card | N-A | Web analytics page |

(Bullets 41–54 count: VSCode 4 + Cloud 5 + Claude Tag 4 + Code Review analytics 1 = 14 entries;
55 total verified against the changelog section.)

## §4 PORT work packages (this round)

### WP-A — bullet 1: `CLAUDE_CODE_DISABLE_ULTRATHINK` + ULTRATHINK enablement

Official gate, byte-verified in the v316 ELF:

```js
// ePt @276986161 (v316)
function ePt(){return!i.CLAUDE_CODE_DISABLE_ULTRATHINK&&v("tengu_turtle_carbon",!0)}
// hxt @247108806 (v314) — the env arm is NEW in 2.1.316
function hxt(){return v("tengu_turtle_carbon",!0)}
```

Raw truthiness `!env.X` — ANY non-empty value disables (including `'0'`/`'false'`). Same official
family as `CLAUDE_CODE_DISABLE_WEB_FETCH` (WebFetchTool precedent) → NO `isEnvTruthy` bool-parse.

`ePt` consumers in v316 (exhaustive — 3):

| Official | Offset | OCC equivalent | Status |
|---|---|---|---|
| `gme` boost gate | @278285563 | `canBoost`/`shouldBoostTurnEffortForUltrathink` (utils/effort/ultrathinkBoost.ts, 2.1.311 port) | already ported — now live |
| `iPr` attachment trigger (`tengu_ultrathink` event + `[{type:"ultrathink_effort"}]`) | @286516968 | attachments.ts:1671 | already ported — now live |
| `QAr` ≤4000-char UI truncation guard (`fe`=4000) | @307686155 | — | NOT ported (pre-existing trim; input-length UI guard only — recorded as divergence) |

**No default-effort-resolver consumer exists in v314 OR v316.** OCC's
`getDefaultEffortForModel` carried a stale `isUltrathinkEnabled() && modelSupportsEffort(model)
→ 'medium'` branch (dormant while ULTRATHINK was off the allowlist). Enabling the flag without
removing it would have diverged from official (sonnet-5 catalog `default_effort:"high"` ≡
undefined→high API fallback) and broken `sonnet55Launch284`/`opus55Launch280` pins → **removed
with byte-evidence comment**.

**ULTRATHINK allowlist enablement**: official external builds ship the ultrathink machinery ON
(ePt's only runtime condition is GrowthBook `tengu_turtle_carbon` default-true; OCC's GB stub
returns the default → enabled). Official v316 ePt consumers are exactly three (byte-verified,
review P3-5): `gme` @278285563 (boost machinery — 2.1.311 port in ultrathinkBoost.ts),
`iPr` @286516968 (attachment trigger), `QAr` @307686155 (≤4000-char UI truncation guard,
NOT ported — STAGE #22 below); the rainbow render is an OCC UI consequence of the boost, not
a separate official consumer. Ported consumers are self-contained — no KAIROS/UDS_INBOX-style
blocking init. Conditional on e2e REPL verification (§6); fallback = revert the allowlist
entry and keep the env-check port as dormant-but-faithful.

Render-side consequence: `HighlightedThinkingText` now rainbow-highlights the `ultrathink`
keyword per-char (official default-ON behavior) — `thinkingPointerInactive287.test.tsx` third
assertion strips ANSI before containment (intent = pointer color, not highlight absence) AND,
per review P2-3, pins the RAW SGR shape on top: a per-char `38;2;r;g;b` interleaving regex
over `[ultrahink]` + a ≥12 truecolor-open count floor (measured truth: 13 SGR total, 12
truecolor opens, single trailing reset — a collapsed single-color render fails both pins).

### WP-B — bullet 4: `CLAUDE_CODE_SUBAGENT_EFFORT`

Official mechanism graph (all byte-verified in the v316 ELF):

```js
// XCt @278280656 — env parser (STRICT CLI-style IH, not the loose oL/rK)
function XCt(){let e=i.CLAUDE_CODE_SUBAGENT_EFFORT;return e===void 0?void 0:IH(e)}
// IH @278279939 ≡ OCC parseEffortCliLevel (Gap-139a port of official fhe)
function IH(e){let n=e.trim().toLowerCase(),r=ce[n]??n;return yE(r)?r:void 0}

// Pxo @291219542 — apply-site resolver + analytics
function Pxo(e,t){if(e.effort!==void 0||uE(e)||w_(t)!==void 0)return;
  let n=i.CLAUDE_CODE_SUBAGENT_EFFORT;if(n===void 0)return;
  let o=XCt();if(o!==void 0)g("subagent_effort_default");
  else if(n!=="inherit")f("subagent_effort_default","unknown_level");return o}

// SINGLE call site @297031178 — the Workflow tool agent() harness:
at=rK(Te?.effort)??Pxo(ct,Y.permissionLayers),
et=at!==void 0?{...ct,effort:at}:ct
```

Key findings:

- **The official Task/Agent tool does NOT consult SUBAGENT_EFFORT** — `Pxo` has exactly one
  caller (the Workflow `agent()` harness). The pre-compaction plan to wire it into
  `runAgent.ts`'s effort chain (tool param > definition.effort > state.effortValue) would have
  over-applied vs official → corrected: wired into `WorkflowTool/primitives.ts` agent() only.
  The env default reaches runAgent via `agentDef.effort`, which the existing chain already
  honors.
- Parser choice: official uses **`IH` (strict: string levels only, trim, `med` alias)** — NOT
  the loose `oL`/`rK` used by `CLAUDE_CODE_EFFORT_LEVEL` (`dv` @278280946). So `'5'` invalid,
  `' XHIGH '` valid.
- Guard arms `uE(e)` (@282513324 — built-in `web-fetch` agent; OCC ships none) and `w_(t)`
  (@278930169 — permissionLayers `kind==="effort"` layer; OCC has no permissionLayers store)
  verified **vacuous in OCC** → omitted.
- `'inherit'` = keep session inheritance; suppresses the `unknown_level` analytics branch
  (case-strict `n!=="inherit"` per official).
- Analytics arms map to OCC's stubbed `logEvent` (no-op parity convention).
- `$et` @284609558: `snappy_pelican` disabled when `XCt()!==void 0||dv()!==void 0` — **NO-OP**
  for OCC (no snappy_pelican experiment).
- `knt` @282911980: bg-session env forwarding allowlist — **N-A** (bg-session subsystem absent).
- **Prompt-text divergence (pre-existing, recorded)**: the official Workflow tool description
  @304987651 says `omit to ${XCt()===void 0?"inherit the session effort":"use the configured
  subagent default"}` for the agent() `effort` option. OCC's WorkflowTool description documents
  no `effort` option at all — a pre-existing gap that predates this round; aligning the whole
  description text is beyond the minimal diff → STAGE.

OCC port surface:

| Official | OCC | File |
|---|---|---|
| `XCt` env parser | `getSubagentEffortEnvDefault()` | src/utils/effort.ts |
| `Pxo` resolver (+ call-site `rK(Te?.effort)??` precedence) | `resolveSubagentEffortEnvDefault(namedEffort)` | src/tools/WorkflowTool/primitives.ts |
| `et=at!==void 0?{...ct,effort:at}:ct` stamp | agentDef env-default spread (named `opts.effort` still wins) | src/tools/WorkflowTool/primitives.ts agent() |
| prefix-stagger key effort field | `effort: agentDef.effort` (EFFECTIVE effort — siblings sharing a prompt prefix must share it when effort arrives via env; OCC-coherent choice, official `Ze` predates the env) | src/tools/WorkflowTool/primitives.ts |

## §5 Test + implementation results (TDD RED→GREEN)

New tests (all RED-first, byte-evidence headers):

| File | Coverage |
|---|---|
| `src/utils/__tests__/subagentEffortEnv316.test.ts` | XCt semantics: unset→undefined; 5 levels; `med` alias; trim+lowercase (`' XHIGH '`→xhigh); `'5'` rejected (IH not oL); garbage rejected; `'inherit'`→undefined; `''`→undefined — 12 tests |
| `src/tools/WorkflowTool/__tests__/subagentEffortEnv316.test.ts` | Pxo semantics: named effort blocks env; `''` counts unnamed (rK arm); unset env→undefined; parse arm; trim/alias; garbage; numeric; inherit (+case-strict `INHERIT`); empty env — 10 tests **+ review round: P2-2 rK-loose-parse precedence 3 ('turbo'/'HIGH!'/' XHIGH ' fall to env; 'med'/'5'/'XHIGH' block) + P3-4 analytics-arm sink assertions 6 (parsed→success event, garbage→unknown_level, 'inherit'/' inherit ' strictness, unset→none, named-block→none) = 19 total** |
| `src/utils/__tests__/ultrathinkDisableEnv316.test.ts` | feature('ULTRATHINK')===true; ePt raw truthiness ('1'/'true'/'yes' AND '0'/'false'/'no' all disable; `''`/unset enable; **+ review P3-6: `' '`/`' FALSE '` whitespace-only → disabled, no trim**); resolver pins: sonnet-5→undefined (±DISABLE env), opus-5-5/haiku-5-5/sonnet-5-5→medium, opus-4-7→xhigh — 17 tests |
| `src/tools/WorkflowTool/__tests__/subagentEffortWiring316.test.ts` | **review P2-1 (NEW)**: integration coverage of the `createPrimitives().agent()` wiring seam — runAgent + prefixStagger spies capture the real agentDefinition/key: env stamp→def.effort+key slot; named 'low' wins; 'med'→'medium'; 'turbo'+env 'high'→'high'; 'med'≡'medium' key parity; all-empty→undefined def + `''` key slot — 6 tests |

GREEN edits: `effort.ts` (XCt port + stale-branch removal + import drop),
`thinking.ts` (ePt env arm), `featureFlags.ts` ('ULTRATHINK' + review P3-5 consumer
enumeration fix), `primitives.ts` (Pxo helper + agentDef wiring + prefixKey effective
effort; **review P2-2: named-effort guard = `parseEffortEnvValue` rK loose parse per
official `at=rK(Te?.effort)??Pxo(...)`, single-spread `effectiveEffort`**),
`prefixStagger.ts` (**review P2-2: key effort param widened to
`string | number | undefined` — rK integer pass-through**),
`thinkingPointerInactive287.test.tsx` (ANSI-strip assertion + **review P2-3 raw-SGR
per-char rainbow pins**, §4 WP-A).

Suite results: 37/37 new tests pass; affected suites (sonnet55Launch284, haiku55Launch293,
opus55Launch280, ultrathinkTurnEffort311, thinkingTriggerFilter311, effortIndicator304,
agentEffortParam292, effortGap97) **217 pass / 0 fail**; full `bun test src` **13,501 pass**
with **ZERO regressions vs stashed baseline** (fail-set diff empty; the 271 remaining fails are
pre-existing on main in this sandbox — baseline fail set identical, mostly env-dependent:
network/native-installer/advisor-wiring tests); `bun run build` green (`dist/cli.js` 30.62 MB).
Version-surface note (review P3-1): these suite/build measurements ran against the PRE-BUMP
dist reporting `OCC 2.1.409`; the release bump to **2.1.410** landed after them, and the
shipped build was rebuilt from the bumped tree — `bun dist/cli.js --version` → `OCC 2.1.410`,
with the occ-versioning + commands-alignment e2e re-run green against it (§6.2).

### §5.1 Review-fix round (acceptance NEEDS_CHANGES: 3 P2 + 7 P3)

All three P2 gates fixed RED→GREEN in-round; the seven P3s (doc surfaces, edge pins,
operator docs) landed the same round:

- **P2-1** — wiring-seam integration suite `subagentEffortWiring316.test.ts` (6 tests,
  runAgent + prefixStagger spies on the real `createPrimitives().agent()` path; table above).
- **P2-2** — `resolveSubagentEffortEnvDefault` named-effort guard switched from truthiness to
  the official `rK(Te?.effort) ?? Pxo(...)` loose parse (`parseEffortEnvValue`): unparseable
  named values ('turbo', ' XHIGH ' — rK does NOT trim) fall through to the env default;
  'med' canonicalizes to 'medium' and blocks; `agent()` wiring collapsed to a single-spread
  `effectiveEffort`; prefixStagger key effort param widened for rK integer pass-through.
- **P2-3** — `thinkingPointerInactive287.test.tsx` third assertion re-pins the RAW SGR
  rainbow shape on top of the ANSI-strip containment (per-char interleaving regex + ≥12
  truecolor-open floor; measured truth 13 SGR / 12 truecolor opens / single trailing reset —
  the review's ≥20 open+close floor was inapplicable because chalk.level=3 per-char rendering
  emits opens without per-char closes; a collapsed single-color render fails both pins).
- **P3-1** — §5/§6 version-surface reconciliation (pre-bump 2.1.409 measurements vs shipped
  post-bump 2.1.410 build; notes above + §6 item 2).
- **P3-2** — `featureFlags.ts` citation fixed to `utils/effort/ultrathinkBoost.ts` (the
  cited `utils/effort/ultrathink.ts` never existed); same fix in
  `ultrathinkDisableEnv316.test.ts` header.
- **P3-3** — `ultrathinkDisableEnv316.test.ts` header changelog index fixed (bullet 3 →
  bullet 1, matching the official 2.1.316 changelog ordering).
- **P3-4** — Pxo analytics arms now ASSERTED (6 tests): harness = the analytics module's own
  sink API (`attachAnalyticsSink`/`_resetForTesting`, the agentTelemetry.test.ts convention),
  deliberately NOT `mock.module` (bun module-mock registrations leak across files in a
  shared-process run — scripts/ci-test.sh root-cause note; an earlier mock.module draft broke
  agentTelemetry 2/12, proven by isolation runs, then replaced by the leak-free sink harness).
- **P3-5** — ePt consumer enumeration corrected everywhere (featureFlags.ts, §4 WP-A above):
  exactly three official consumers `gme`/`iPr`/`QAr`; rainbow UI is an OCC render
  consequence; `QAr` un-ported → STAGE #22.
- **P3-6** — kill-switch whitespace edge pins: `' '` and `' FALSE '` → disabled (raw
  truthiness does not trim).
- **P3-7** — CLAUDE.md operator notes: ULTRATHINK default-ON fail-open cost (CWE-770
  informational), `CLAUDE_CODE_DISABLE_ULTRATHINK` raw-truthiness semantics (CWE-1188
  informational — ANY non-empty value disables, incl. '0'/'false'/' '),
  `CLAUDE_CODE_SUBAGENT_EFFORT` scope + precedence.

Review-fix round gates: focused suites 57/57; WorkflowTool + effort sweep 198/198; messages +
prior-round suites 49/49; model/indicator/agentEffort suites 551/551 — 0 fail. New/updated
test total this round: 54 (12 utils env316 + 19 WorkflowTool env316 + 17 ultrathinkDisable
+ 6 wiring). Full e2e replay on the review-fix tree: **776 pass / 11 skip / 1 fail** (925 s) —
the single fail is the known `/feedback` real-API wording flake (model reply phrasing vs the
`/Issue (created|filed)/i` assertion; same flake class as the 2.1.408 round), isolated re-run
of `commands-behavior.e2e.test.ts` **16/16 green**. biome: 0 errors on all changed files
(2 pre-existing `noConfusingVoidType` warnings in untouched primitives.ts signatures).
Post-fix build green (30.62 MB) + `bun dist/cli.js --version` → `OCC 2.1.410`.

## §6 e2e / acceptance evidence

All runs against the freshly built `dist/cli.js` (30.62 MB; the research/e2e runs below were
measured on the PRE-BUMP dist reporting `OCC 2.1.409` — the shipped post-bump build reports
`OCC 2.1.410`, rebuilt + version-surface re-verified per item 2, review P3-1),
scrubbed env (`env -u` every inherited `CLAUDE*`/`AI_AGENT` var), real tmux REPL + real model
round-trips per Leader order "不接受纯源码阅读推断":

1. **`bun test test/e2e` (full internal e2e suite): 777 pass / 11 skip / 0 fail**, 2844
   expect() calls, 788 tests across 162 files (965.32 s) — green WITH this round's changes.
2. **Version surface**: `bun dist/cli.js --version` → `OCC 2.1.410` on the shipped post-bump
   build (review-fix round re-verified; the pre-bump research dist reported `OCC 2.1.409`).
3. **REPL boot with ULTRATHINK enabled (default)**: tmux session boots to the prompt with no
   hang — the allowlist enablement has no blocking-init side effect (the KAIROS/UDS_INBOX
   failure mode explicitly ruled out live).
4. **Ultrathink rainbow live**: typing `ultrathink hello` into the REPL renders the keyword
   per-chunk with 256-color SGR codes
   (`❯ \e[38;5;210mu\e[38;5;223mlt\e[38;5;194mr\e[38;5;146mat\e[38;5;182mh\e[38;5;210mi\e[38;5;216mn\e[38;5;222mk\e[39m hello`)
   — the `iPr`/HighlightedThinkingText consumer is live, matching the official default-ON build.
5. **Kill switch live**: same session booted with `CLAUDE_CODE_DISABLE_ULTRATHINK=1` → the
   input line renders contiguous plain `ultrathink hello` with ZERO rainbow SGR codes
   (byte-level tmux `capture-pane -e` comparison). ePt env arm verified in the real REPL.
6. **Real REPL turn**: `say PONG` → `● PONG` (45,563 tokens consumed — genuine model
   round-trip through the live ULTRATHINK-enabled build).
7. **Headless `-p` with `CLAUDE_CODE_SUBAGENT_EFFORT=high`**: `echo 'say PONG' | … -p` →
   `PONG`, exit 0 (env parse path doesn't crash the print-mode boot).
8. **Workflow tool live e2e**: headless `-p` instructed the model to call `Workflow` with a
   verbatim script `phase("P"); const r = await agent("Reply with exactly the word PONG…",
   {label:"probe"}); return {result:r}` under `CLAUDE_CODE_SUBAGENT_EFFORT=high` → workflow
   executed, subagent spawned through the ported `resolveSubagentEffortEnvDefault` path
   (named effort absent → env default `high` stamped on agentDef), returned
   `{"result":"PONG"}`, exit 0.
9. **Unit/affected/full-suite gates** (§5): 37/37 new, 217/217 affected, full `bun test src`
   zero regressions vs stashed baseline (`comm -13` of sorted fail-sets empty; the 271
   sandbox-env fails are identical on clean main).

Ultrathink effort-boost turn (`gme` consumer) verified at unit level (ultrathinkTurnEffort311
et al., 217-pass affected suite); its runtime effect is an API request parameter with no
terminal-visible surface, so live-turn evidence = boot + render + real PONG turn above.

## §7 STAGE registry (carried forward)

Per convention, STAGED items with forensics anchors:

1. **#16 `--restricted` upload × Read-allow-rule (SECURITY — next-round top priority)**
2. #9/#10 shell-snapshot cluster — official scrub sets `eo`/`rs` @274845383/@274878630 located
3. #17 invisible-chars double-Enter (PromptInput submit path)
4. #26 `/model <id>` unrecognized warning + 200K auto-compact assumption
5. #8 exit-path shell-child reaping
6. #38 SSL cert error message table
7. #3 cert-chain drop kill switches (`DISABLE_LOOPED_CROSS_CERT_DROP`/`_SELF_NAMED_`)
8. #12 keep-alive/compression hang (`DISABLE_HTTPS_AGENT_KEEPING`)
9. #13 Vertex/Bedrock alias fallback
10. #28 Grep/Glob timeout-kill hardening
11. #29 resume plan-restore race
12. #36 `/diff` large-repo refresh perf
13. #11 PowerShell hook exit-2 wrapper
14. #19 autoMode.allow `$defaults` merge
15. #23 plugin MCP headersHelper env corruption
16. #24 SDK `register_repo_root` CLAUDE.md
17. #7 Opus 4.8 fast-mode removal (date-gated 2026-11-30)
18. #30 first-run copy wrap (low)
19. MCP transport switches (`MCP_NO_REDIAL_AFTER_POLICY_REFUSAL`, `MCP_SKIP_UNCHANGED_RELIST`)
20. `CCR_ONE_PLUGIN_LOAD_PER_RELOAD`
21. Workflow tool description `effort` option text (§4 WP-B divergence note)
22. `QAr` ultrathink ≤4000-char UI truncation guard (§4 WP-A)

## §8 Discipline reminders

- 官方二进制只读取证，不执行 (strings/grep -aboF/dd only — never as a model backend)
- Minified names are chunk-scoped and COLLIDE across chunks (this round: `XCt(` hits at
  310559242/310560113 were an unrelated "Goodbye!" picker; `ePt` raw hits mostly bytecode
  noise <200M offset — every consumer verified by dd context extraction)
- Bytecode-region grep hits (offset < ~200,000,000) are random byte noise → filter with
  `awk -F: '$1 > 200000000'`
- Never invent: ambiguous sites → STOP + STAGE with evidence
- `rm -rf /tmp/cc-diff-316` at closeout
