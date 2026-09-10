# Upstream Version Gap — OCC-121 (official 2.1.266 → 2.1.267)

- **Round:** OCC-121 (autopilot 版本追齐, 2026-09-11)
- **OCC aligned-at (round start):** official Claude Code `2.1.266` — OCC release `2.1.327`
- **Official latest (round start):** `2.1.267` (npm dist-tags: `latest` = `next` = `2.1.267`)
- **Method:** `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.266,2.1.267}` → `strings -n 8 | sort -u` → `comm` diff → fixed-substring/regex window extraction on the minified JS (`ctx.py`) → byte-verify → LAND / NO-OP / STAGED verdicts.
- **Binary sha256:**
  - v266: `19842705e989393fce936804df6d2ab034860e24b8f8880357981d87ffd83fac`
  - v267: `0399c793ff571d5946ef923d80b4f330d05ac4b6842a6b0775468f5d389403c0`
- **Strings diff:** 13,190 added / 11,852 removed.
- **Official 2.1.267 changelog:** 53 bullet entries (numbered E1–E53 below in changelog order).

**Verdict summary:** LAND 6 (E8, E9, E10, E12, E32, E33 — all landed this round) · STAGED 7 (E1, E8-runtime-realpath subsystem, E11, E19, E20, E34, prompt-cache snapshot subsystem covering E2/E21–E30/E36) · NO-OP 40 (everything else — subsystem absent from OCC or not portable).

---

## 1. Landed this round

### Gap-121a — E12: managed security allowlists fail CLOSED on invalid input

Official changelog: *"Fixed managed `allowedHttpHookUrls`, `httpHookAllowedEnvVars` and `allowedChannelPlugins` to admit nothing, not everything, when unreadable."*

**Security-positive.** In v266 an invalid entry in one of these managed-policy keys failed whole-file schema validation → the policy file was dropped → the allowlist became `undefined` → unrestricted (fail-OPEN). v267 sanitizes per-entry; a present-but-invalid key becomes an empty (deny-all) allowlist with a warning.

Byte-verified official v267 evidence (`claude` linux-x64 ELF, L1985405@90119; v266 has the plain schema `T(c({marketplace:s(),plugin:s()}))` with no sanitizer):

```js
r.allowedHttpHookUrls=xn("allowedHttpHookUrls",s(),e,"no HTTP hooks may run"),
r.httpHookAllowedEnvVars=xn("httpHookAllowedEnvVars",s(),e,"no environment variables may be interpolated into HTTP hook headers"),
r.allowedChannelPlugins=xn("allowedChannelPlugins",Ac(),e,"no channel plugins admitted",(y,k)=>typeof y==="string"?`"allowedChannelPlugins" entry "${y}" was accepted; prefer the documented object form {"plugin": "${k.plugin}", "marketplace": "${k.marketplace}"}.`:void 0)
```

Warning message shapes (byte-verified): per-entry `Invalid entry was ignored: ${detail}`; all-invalid `Every entry of "${key}" was invalid; enforcing an empty allowlist (${reason}) until it is fixed.`; present-invalid `"${key}" was present but invalid; enforcing an empty allowlist (${reason}) until it is fixed.`

**OCC change:** new `src/utils/settings/sanitizeAllowlists.ts` (`sanitizeSecurityAllowlists` — per-entry zod validation, empty-allowlist fail-closed, official message shapes; `allowedChannelPlugins` legacy `"plugin@marketplace"` string form accepted per official `Ac` with the statusOnly notice), wired into `parseSettingsFileUncached` in `settings.ts` as a pre-schema filter (same channel as the existing `filterInvalidPermissionRules`), so these keys can never reject — or be rejected with — the whole file. Tests: `src/utils/settings/__tests__/managedAllowlistsFailClosed267.test.ts` (13).

**Documented divergences:**

1. Official sanitizes inside the managed-settings merge via zod `.catch()`; OCC sanitizes the raw parsed JSON before whole-file schema validation. Observable contract (deny-all on invalid + warning text) is byte-equivalent.
2. Official's string pre-validator `VT` is an unresolvable minified alias; per triage decision a string containing `@` with non-empty halves converts, any other string is dropped as an invalid entry.
3. Absent keys stay absent (undefined semantics unchanged) — only *present* keys fail closed.

### Gap-121b — E8: marketplace entry path with backslash could bypass containment

Official changelog: *"Fixed a case where a marketplace entry path containing a backslash could bypass the containment check for fetched marketplaces on macOS and Linux."*

**Security-positive.** POSIX `resolve()` treats `\` as a literal filename character, while downstream consumers (e.g. `git sparse-checkout set --cone` in the subdir install path) normalize backslashes cross-platform — enabling containment bypass / cache poisoning.

Byte-verified official v267 evidence: the whole containment-refusal message family is v267-only (v266: zero hits for `outside the marketplace directory`). v267 L1992322@7825 (realpath + inode-identity verification, see §2 staged item) and the refusal reason text naming the rejected shapes:

```js
function KPe(e){return e==="location-refused"?`its marketplace's recorded location ${rxe}`:"its marketplace entry path does not stay inside the marketplace directory (an absolute, climbing, network-shaped, backslash-containing or link-traversing entry, an entry of a fetched marketplace that resolves or opens outside its tree — or a relative entry in a url-catalog marketplace, which has no local directory)"}
```

The suspicious-path predicate gains `M()!=="windows"&&n.includes("\\")` (v267 `tue`; v266 `FCe` lacked the clause).

**OCC change:** `validatePathWithinBase` in `src/utils/plugins/pluginInstallationHelpers.ts` — the single lexical containment choke point — now rejects any relative path containing `\` on non-Windows platforms before `resolve()`. Tests: `src/utils/plugins/__tests__/pluginPathBackslash267.test.ts` (6).

**Documented divergences:**

1. Official v267 also adds a runtime realpath + `dev`/`ino` identity verification subsystem for fetched-marketplace entries (resolve the declared spelling, stat both, require same device/inode and containment of the *resolved* path). That subsystem is STAGED (§2); this round lands the lexical backslash guard, which is the exact bug class the changelog entry names.
2. Guard placement differs: OCC validates at path-validation time (`validatePathWithinBase`) rather than inside marketplace-entry admission.

### Gap-121c — E10: spurious "Continue from where you left off." on `-p --resume` after a local command

Official changelog: *"Fixed resuming a session after `/compact` or another slash command ran via `-p --resume`: a spurious 'Continue from where you left off.' turn is no longer inserted."*

A transcript ending on a completed local-command breadcrumb tail — caveat + `<command-name>` record + `<local-command-stdout>` output, the exact shape of official `mnr` (model-switch breadcrumbs) and OCC's `createModelSwitchBreadcrumbs` — was misread as an unfinished user prompt, so `-p --resume` auto-continued it and spliced the `NO_RESPONSE_REQUESTED` sentinel.

Byte-verified official v267 evidence (L1993609@9949 and L1988069@277):

```js
var IK=[[`<${ap}>`,"record"],[`<${eu}>`,"output"],[`<${Gd}>`,"output"],[`<${GM}>`,"caveat"]];
function l0n(e){let n=e.message?.content,r=Array.isArray(n)?n.findLast((o)=>o?.type==="text")?.text:typeof n==="string"?n:void 0;if(typeof r!=="string")return;return IK.find(([o])=>r.startsWith(o))?.[1]}
function bWn(e){if(e.type!=="user"||e.promptSource!==void 0)return;let n=l0n(e);return n==="caveat"&&e.isMeta!==!0?void 0:n}
function eBe(e,n){if(bWn(e[n])===void 0)return!1;let r=!1,o=!0;for(let d=n;d>=0;d--){let p=e[d];if(p.type==="system"||p.type==="progress"||p.type==="attachment")continue;let y=bWn(p);if(y==="caveat")return!0;if(y===void 0||r)break;r=y==="record",o&&=p.type==="user"&&p.isMeta===!0}return o}
```

Detector + splice sites in v267 `PWn` (vs v266 `x$n`, which lacks all three):

```js
if(o.type==="user"&&!d){if(eBe(e,r))return e2(n); /* … */}          // first check in the user branch
if(k.type==="user"&&eBe(e,y))return e2(n)                            // mid-scan addition
if(!r&&Je!==-1&&Ae[Je].type==="user"&&!eBe(Ae,Je)&&!(Xe.kind==="none"&&RVo(Ae,Je)))Ae.splice(Je+1,0,vc({content:mR}))
```

Tag constants byte-verified (v267 L1985145): `ap="command-name"`, `eu="local-command-stdout"`, `Gd="local-command-stderr"`, `GM="local-command-caveat"`. Caveat builder `b8` sets `isMeta:!0`; official `mnr` record/output messages are NON-meta.

**OCC change:** `src/utils/conversationRecovery.ts` — faithful port: `classifyLocalCommandKind` (`l0n` + `IK` tag table, official order), `localCommandBreadcrumbKind` (`bWn`), `isCompleteLocalCommandTail` (`eBe` backward scan). `detectTurnInterruption`'s user branch calls `isCompleteLocalCommandTail` FIRST (official order — before the `isMeta` check), and `deserializeMessagesWithInterruptDetection`'s sentinel splice gains the `!isCompleteLocalCommandTail(...)` guard. Tests: `src/utils/__tests__/localCommandTail267.test.ts` (8 — breadcrumb tail, stderr tail, all-isMeta chain, system-noise skip, non-meta chain stays interrupted, non-meta caveat is a real prompt, promptSource exclusion, plain-prompt regression).

**Documented divergences:**

1. Official's second new splice clause `!(Xe.kind==="none" && RVo(Ae,Je))` guards system-reminder context-append tails under `CLAUDE_CODE_RESUME_TOLERATES_CONTEXT_APPENDS`. That env/subsystem does not exist in OCC (grep `RESUME_TOLERATES` = 0 hits), so the clause is not portable and was skipped.
2. Bash `!` tags (`bash-input`/`bash-stdout`) are intentionally absent from official `IK` — the official fix is scoped to slash-command breadcrumbs; the faithful port preserves this scope (`hM`'s wider tag set is a separate predicate not used by the resume detector).
3. `promptSource` does not exist in OCC's message types; the guard is kept for fidelity against on-disk transcripts written by other builds.

### Gap-121d — E9: expired AWS/GCP credentials retried ten times before the re-authenticate error

Official changelog: *"Fixed expired AWS or Google Cloud credentials under a host app such as Claude Desktop retrying ten times with a generic 'request failed' before the re-authenticate error appeared."*

Byte-verified official v267 evidence — new retry-cap constants (L1993214@4959; v266 has no `ZDn`/`eNn`):

```js
var …,TBo=2,ZDn=2,eNn=2,aNn=1,…
```

Retry-loop shape (v266 L1988951@11450 shows the pre-fix loop; v267 caps each cloud-auth class at 2 then throws `CannotRetryError` with `api_request_aws_auth_exhausted` / `api_request_gcp_auth_exhausted` telemetry):

```js
if(sX(Xe)){if(P>=eAo)throw f("api_request","api_request_ccr_auth_exhausted"),new z_(Xe,d);P++}
if(!oX()&&(wat(Xe,d.model)||fYt(Xe))){if(O>=oAo)throw f("api_request","api_request_aws_auth_exhausted"),new z_(Xe,d);O++}
if(!oX()&&B0e(Xe)){if(L>=sAo)throw f("api_request","api_request_gcp_auth_exhausted"),new z_(Xe,d);L++}
```

**OCC change:** `src/services/api/withRetry.ts` — `awsAuthRetries`/`gcpAuthRetries` counters capped at `CLOUD_AUTH_RETRY_CAP = 2` (official `ZDn`/`eNn`); on exhaustion throws `CannotRetryError` with the official telemetry reason strings. New classifier `classifyCloudCredentialError` (official `eJ`) with `findInErrorCauseChain` (official `lq` — walks `.cause` up to depth 5) and the Google credential message set incl. `invalid_client`/`unauthorized_client`. Tests: `src/services/api/__tests__/cloudAuthRetryCap267.test.ts` (7).

**Documented divergences:**

1. Official also clamps the backoff exponent alongside the cap (`Ln = cap − retries`); OCC's delay computation is unchanged — the cap itself is the observable behavior.
2. Official's friendly host-app "re-authenticate" error copy (Claude Desktop credential-refresh flow) is not ported — that surface does not exist in OCC; the capped throw reuses OCC's existing `CannotRetryError` rendering.

### Gap-121e — E32: Bash tool description guidance (plain words, not echoing the command)

Official changelog: *"Improved the Bash tool's description guidance so Claude describes what a command does in plain words instead of echoing the command."*

Byte-verified official v267 evidence (L1995654@0; v266: zero hits):

```
Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.
```

**OCC change:** `src/tools/BashTool/BashTool.tsx` — the paragraph is inserted byte-exactly into the `description` input-schema `describe()` text, at the same position as the official (after the "Never use words like…" line, before the "For simple commands…" examples block). Prompt-text-only change; covered by the existing BashTool schema/prompt suites (no behavioral code).

### Gap-121f — E33: sandbox guidance suggests `/copy` when clipboard utilities fail

Official changelog: *"Improved sandbox guidance so Claude suggests `/copy` when clipboard commands such as `pbcopy` fail inside the sandbox."*

Byte-verified official v267 evidence (L1996854@8006 and string table L502950@2760; v266: zero hits):

```js
…Re()?[]:["If a clipboard utility such as `pbcopy`, `xclip`, or `wl-copy` fails inside the sandbox and the user wants the text on their clipboard, put the text in a fenced code block in your response and tell them to run `/copy` (it copies from outside the sandbox; when the picker appears they can select just that block), rather than writing a file for them to copy manually."]
```

**OCC change:** `src/tools/BashTool/prompt.ts` — `getSimpleSandboxSection` appends the item byte-exactly after the `$TMPDIR` item (same position as official).

**Documented divergences:**

1. Official gates the item behind `Re()` (minified alias unresolvable from strings alone). OCC always ships `/copy`, so the item is unconditional — a superset of the official's gated behavior in the only configuration OCC supports.

---

## 2. Staged (evidence captured, not ported this round)

- **E1 `maxEffortLevel` setting** — new top-level / per-model `modelSettings` key capping effort on every provider (Bedrock/Vertex/Foundry included). Absent from OCC (`maxEffortLevel` grep = 0 files). Needs settings-schema + per-provider cap-table + effort-picker interaction work. Evidence: `forensics/scratch-a2/e1_strings.py`, `e1d.py`, `e1e.py`.
- **E8 runtime realpath verification subsystem** — v267 adds, for fetched marketplaces, full realpath resolution + `dev`/`ino` identity + resolved-path containment (byte evidence L1992322@7825, quoted in Gap-121b). Only the lexical backslash guard landed this round; the verification subsystem needs a dedicated round (new async stat/realpath plumbing in the plugin loader). Evidence: `forensics/scratch-a1/e8a–e8f.py`.
- **E11 >5 MB resume drops parallel tool calls** — v267 reworks the large-transcript loader (official `ZIr` rescue block; v266/v267 diff captured in `forensics/scratch-a3/e11_zir_only267.txt` + `e11_load_diff.txt`). OCC's transcript-loading path differs structurally; porting needs per-site decompilation against OCC's loader.
- **E19 `claude remote-control` credential re-registration** — host re-registers instead of exiting when its server credential expires (~30 days). OCC's bridge (`src/bridge/initReplBridge.ts`) has no equivalent long-lived server credential lifecycle. Evidence: `forensics/scratch-a1` (remote-control cluster).
- **E20 usage-limit warning flicker** — v267 normalizes limit windows when different models/modes report different windows (official evidence: `forensics/scratch-a2/e20*.py`, `e20k.out`, `e20o.out`, `e20q.out`). OCC's corresponding limit-warning surface needs identification first (`usageLimit` grep = 0 files).
- **E34 `--resume` first-render time for Bash-heavy sessions** — official performance rework of the resume render path; needs profiling, not a strings-level port.
- **Prompt-cache snapshot subsystem (E2, E21–E30, E36)** — official records the system prompt + tool definitions once and replays them (flags `--system-prompt-snapshot off`, deferred tool definitions, recorded-description replay). OCC re-renders the system prompt and tools per request (`systemPromptSnapshot` grep = 0 files) — i.e. OCC's *default* behavior is the official's new `off` mode. The whole E21–E30 fix family lives inside the recorded-replay machinery; the subsystem itself is the staged alignment candidate. Evidence: `forensics/scratch-a2/e2_strings.py`, added-strings cluster.

---

## 3. No-op (40 entries — subsystem absent from OCC or not portable)

| # | Entry | Verdict reason |
|---|-------|----------------|
| E2 | `--system-prompt-snapshot off` flag | OCC has no recorded-snapshot subsystem (grep = 0); OCC always renders fresh — the flag's `off` behavior is OCC's default. Flag itself deferred with the subsystem (§2). |
| E3 | Cowork scheduled cloud tasks under sandboxing policy | No Cowork cloud-tasks surface in OCC (cloud scheduling is server-side official infra). |
| E4 | `/context` blank on mobile clients | No mobile client. |
| E5 | shift+enter / option+backspace after tmux-ssh reconnect in agent view | No agent-view reconnect keybinding surface. |
| E6 | dim last-prompt header in fullscreen scroll | Cosmetic fullscreen-scroll header; no portable binary diff for OCC's renderer. |
| E7 | Workflow `agent()` large-output schemas refused in auto mode | Official fix is inside its auto-mode safety-classifier gating for Workflow schema size; OCC's Workflow tool has no schema-size refusal classifier path (nothing to un-refuse). |
| E13 | `/login` Esc under gateway sign-in | No Claude-apps gateway sign-in flow in OCC. |
| E14 | Artifact publish retry on dropped connection | No artifact-publish subsystem (trimmed). |
| E15 | `effort:` frontmatter ignored on pinned-default models | Official gates frontmatter effort behind launch-pin flags (`unpinOpus47LaunchEffort`/`unpinOpus48LaunchEffort`/`unpinFable5LaunchEffort`, v267 `kE(…,honorLaunchPin)` vs v266 `dE`). OCC has no launch-pin subsystem (grep `unpin\|LaunchEffort` in src = 0 functional hits); OCC applies `frontmatter.effort` directly (`loadPluginAgents.ts:153`) — the swallow bug cannot occur. |
| E16 | Artifact publish UTF-8 error | No artifact-publish subsystem. |
| E17 | `claude agents` `@` directory menu misses new repos | OCC's `occ agents` daemon supervisor has no `@` directory menu. |
| E18 | Remote Control stale permission mode | No Remote Control client-join surface. |
| E31 | `/diff` panel flash + centered empty state | Cosmetic official-panel timing; OCC's `/diff` render path differs, no flash sequence identified. |
| E35 | Keystroke responsiveness vs spinner repaints | Official Ink-internal scheduling; no portable diff. |
| E37 | Artifact publish refusal message | No artifact-publish subsystem. |
| E38 | Self-hosted runner `--use-anthropic-git-proxy` registration | No self-hosted runner registration surface (grep = 0). |
| E39 | Gateway `forward_user_identity` 429 pass-through | No gateway upstream surface (grep = 0). |
| E40–E47 | VSCode extension fixes (8 entries) | OCC ships no VSCode extension. |
| E48–E49 | Claude Code on the web fixes (2 entries) | No web product surface. |
| E50–E53 | Claude Tag fixes (4 entries) | No Claude Tag surface. |

---

## 4. Verification

- New/updated tests: 34 across 4 new files (13 allowlists, 6 plugin-path, 8 local-command-tail, 7 cloud-auth-retry). Targeted suites: plugins 33/33, settings 82/82, api 69/69, utils clean-vs-baseline, conversationRecovery 8/8.
- Regression proof: `git stash` A/B on `bun test src/utils` — 11 failures with changes, 19 without (the 8 baseline-only failures are the new tests going RED without implementations). Timing-suffix-stripped `comm` diff: the same 11 pre-existing batch-mode failures in both runs, zero new. All 11 pass under per-file isolation (CI style) — pre-existing `mock.module` cross-contamination in batch mode, not real breakage.
- PTY e2e (`resume-command-name`, `resume-interrupted-turn-221`) fail identically with and without this round's changes (PTY spawn fails in ~40 ms in the sandbox) — environmental, pre-existing.
- Gates: `bun run lint` (biome), `bun run build`, full per-file test isolation run — results recorded in the release commit.
