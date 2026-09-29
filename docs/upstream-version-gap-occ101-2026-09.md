# Upstream Version Gap — OCC-101 round (official 2.1.284)

Date: 2026-09-30 · Agent: OCC 程序员 · Issue: OCC-101

## 1. Version facts

| | OCC (before round) | Official |
|---|---|---|
| Version tracked | 2.1.283 | **2.1.284** (npm `latest`+`next`, published 2026-09-28T17:11:59Z; `stable` tag lags at 2.1.277) |
| OCC release | 2.1.359 (main `6246dc1`) | — |
| linux-x64 ELF | v283 md5 `b5afa8208e39db13e13e89449b1825f2` (241,556,664 B — identical to the OCC-100 forensic baseline ✓) | v284 md5 `16a758ebef6694e279a10ff618ace012` (243,059,896 B, +1.5 MB) |
| String delta | 301,049 unique (`strings -n 8`) | 303,459 unique; +18,922 new / −16,512 removed |

Gap = exactly one official version (2.1.283 → 2.1.284). 2.1.284 is substantive: ~100 changelog
entries headlined by the **Sonnet 5.5 launch** (`claude-sonnet-5-5`, new default Sonnet on the
Anthropic API) and 5 security fixes.

## 2. Method

Per `upstream-tracking` + `aligning-with-official-binary` skills:

1. Official changelog 2.1.284 section pulled to `/tmp/cc-CHANGELOG.md` (GitHub raw), all ~100
   entries triaged item-by-item (§3).
2. `npm pack @anthropic-ai/claude-code-linux-x64@2.1.283 / @2.1.284` → `/tmp/cc-diff-284/`
   (strings-only forensics; official binaries never executed). Byte-context extraction via
   `LC_ALL=C grep -aobF` → offset → `dd bs=1 skip=… count=…`.
3. Every PORT below cites the v284 ELF byte offset it was recovered from. Non-portable items are
   STAGED/SKIPPED with per-item rationale — nothing invented.
4. Cleanup: `/tmp/cc-diff-284` removed at round end (skill discipline).

## 3. Item ledger (2.1.284 changelog triage)

16 binary-diff items (Agent C forensics, all byte-verified against the two ELFs; offsets below are
v284 unless noted). Verdict key: **PORTED** (landed + tested this round) · **STAGED** (honest
deferral with rationale) · **NO-OP** (no v283→v284 delta / already parity).

| # | Item | v283→v284 delta (byte evidence) | Verdict | Rationale |
|---|------|--------------------------------|---------|-----------|
| 1 | SECURITY: `ANTHROPIC_FOUNDRY_RESOURCE` validation | 0→2 hits; validator `Ixr` @203883609, factory guard @203891512; v283 `jh()` @202054583 interpolated raw env into `https://${R}.services.ai.azure.com` | **PORTED** | Pure client-side. Guard + byte-identical regex/error message in `src/services/api/client.ts`; 8 wire tests (§8) incl. the v283 attack shape `evil.services.ai.azure.com` |
| 2 | SECURITY: rules-file symlink escape → external-imports approval | `linkedFrom` 4→10 hits; walker `O0e` @205758070, gate block @205758405, per-entry `en/kn` @205759353, dir-level `De/Ne` arms, `KRt` collector @205771688; `i9` User-scope reject @205757657 (v283 `k8` @203895369 byte-identical — pre-dates delta) | **PORTED** | Pure client-side. 8 edits to `src/utils/claudemd.ts` (linkedFrom provenance, per-entry + dir-level escape drops, `i9` backfill); 13 fixture tests (§8). Path-resolver `xo` @197701423 verified: realpath success → `isCanonical:true` = OCC `safeResolvePath` semantics; the `Vp` warm-cache branch (`isCanonical:false`) has no OCC counterpart — OCC always behaves as official cold-cache, noted not invented |
| 3 | SECURITY: plugin allowed-tools trust under `allowManagedPermissionRulesOnly` | v283 `Eu(e){return e?.id!==void 0&&LS(e.id)!==Vd}` @199855518-region → v284 `Lu(e)` 5-tier trust switch @201722334 (`XS(n)??rd(n)`: undefined/Ud→false, Fd→`Zo(n)!==bfn`, Ra→true, yd→`officiallyAttested===true`, K_→npm pinning `WDr` @201452219 requiring `strictKnownMarketplaces`); `officiallyAttested` = 0 hits in v283 | **STAGED** | Gate only fires under enterprise `allowManagedPermissionRulesOnly` (OCC keeps the v283-parity `isPluginAllowedToolsTrusted` = exactly v283 `Eu`). OCC has zero `officiallyAttested`/`npmResolution`/trust-tier registry infrastructure — porting `Lu` needs the plugin trust-tier subsystem first. A blanket-deny substitute would OVER-restrict vs official (Ra tier returns true) = invention, forbidden by the skill. Next-round candidate paired with the trust-tier registry |
| 4 | SECURITY: elicitation hook `{"decision":"block"}` honored | parser `mEr` @207400684: `if(e.blocked)` (v283 `Vbr` @205549934: `if(e.blocked&&!e.succeeded)` + `decision==="block"||e.blocked` disjunct) — v283 stranded JSON-block with exit 0 | **PORTED** | Pure client-side. `parseElicitationHookOutput` in `src/utils/hooks.ts` at v284 parity; 7 wire tests (§8) incl. the exact blocked&&succeeded delta case pinning raw-output behavior |
| 5 | SECURITY: sandbox Bash write-denied covering cwd startup failure | bwrap mount-assembly rewrite: `xe()` usable-prediction + `KV()` ancestor pinning @202680317 + mount-point reuse @202687229 region (all v283 = 0 hits) | **STAGED** | The fix lives entirely inside the official's INTERNAL bwrap layer. OCC sandboxes via the `sandbox-runtime@0.0.44` package, which owns its own mount assembly — there is no OCC code path corresponding to the rewritten layer. Porting would mean replacing the sandbox backend = out of scope, dishonest to fake |
| 6 | Auto mode: `allow_once` answer + default-auto | (a) 4th answer `allow_once` @225659876 (`Ne=["allow","block","ask_again","allow_once"]`, v283 3-value @223276047); (b) default-auto machinery `NLr` @201200195 ≡ v283 `LHr` @199535045 byte-for-byte — **no v284 delta** in (b) | **STAGED** | (a) is a real delta but lives in the auto-mode outside-reads dialog surface (`auto_mode_outside_reads` kind + bridge mapping) — needs dedicated per-site decompilation of the dialog/bridge consumers, not a one-liner. (b) honest no-op: flag-driven (`tengu_auto_mode_config`/`tengu_harbor_willow`), structure identical in both versions |
| 7 | Keybindings: `effortSlider:decreaseEffort/increaseEffort/toggleUltracode` | default bindings @204859402 (v283 @203024614 had only `s:thisSessionOnly`); action registry @204866427; EffortSlider renderer @236683489 | **STAGED** | Real delta, but the EffortSlider TUI component + chord-cache + persistAsDefault commit path don't exist in OCC yet — the keybindings would bind to nothing. Needs the EffortSlider UI surface first (pairs with #14) |
| 8 | Statusline `spend_limit.used_usd/limit_usd/period` | 0→5/4 hits; schema docs @206602837; payload @206357119 gated `Ie()==="gateway"` + `mt.currency==="USD"` | **STAGED** | Data-plane: values come from the Claude gateway usage meter (`QZt()`). Without a gateway the fields are naturally absent — porting the schema alone is unobservable. Stage until OCC has a gateway meter surface |
| 9 | `/rate-limit-options` unhidden | v283 `eYo` @206349845 `isHidden:!0`, desc "Show options when rate limit is reached" → v284 `B6o` @208225433 no isHidden, desc "Manage usage limits and upgrade options" | **STAGED** | Command exists in both; the delta is visibility + panel content driven by the billing backend (usage-credits/extra-usage panels). OCC has no billing backend — unhiding would expose an empty panel |
| 10 | `/mcp reconnect all` interactive flow | new UI component @236140764–236141211 (`Reconnecting…`, "No MCP servers need reconnecting" v283=0, "still not connected" v283=0); inline slash-text path already byte-identical between versions | **STAGED** | Interactive Ink component + `Jvt` batch-reconnect orchestrator + outOfBandNote bridge support = a self-contained UI feature needing dedicated porting, not a delta patch. Next-round candidate |
| 11 | CARRY-OVER: `--client-data-url` | 9 hits in BOTH; all 9 ±250B windows text-identical (passthrough set, deep-link allowlist, error text, yargs registration, cloud-session table, string-table mirrors) | **NO-OP / STAGED maintained** | Zero v283→v284 delta = no new evidence; OCC-100's STAGED verdict (issuance-side: signed doc from downloads.claude.ai) stands unchanged |
| 12 | CARRY-OVER: `/help` gated rows | gates byte-identical across versions: keybindings row `KV()` @204876508 ≡ v283 `yV()` @203041522 = `x("tengu_keybinding_customization_release",!0)`; fast-mode row `bo()&&Qk()` @226646250-region with `Qk` @200404663 (account availability). v284-only "Enable fast mode" ×10 = model-catalog `fast_mode` toggle block, not the help gate | **PORTED (carry-over fix)** | See §7: keybinding gate default aligned to official `true` (single call site, 47/47 tests); fast-mode row = environment difference (OCC's `isFastModeEnabled()&&isFastModeAvailable()` structure already matches official `bo()&&Qk()`) |
| 13 | **Sonnet 5.5 launch** (`claude-sonnet-5-5`) | 0→24 hits + `SONNET_ID` constant flip @230214684; full catalog evidence in §4 | **PORTED** | Top priority per dispatch. ~18 files (§5), reference path = OCC-134's Opus 5.5 launch; `sonnet55Launch284.test.ts` + e2e version file (§8) |
| 14 | `/effort ultracode [on\|off]` independent toggle | "toggleUltracode" 0→5; command impl @216594416 region; SDK doc @199897495; v283 had Ultracode concept (37 hits) but no independent switch | **STAGED** | Real delta; depends on the EffortSlider/ultracode session-state surface shared with #7 (`YC()` dynamic-workflows availability + `effortUpdate:{ultracode}` commit path). Port together with #7 next round |
| 15 | Gateway startup warnings (vouching/host-check subsystem) | entirely new: `/gateway-api/gateway-hosts/check` @200717942, `Ov()` 3-state basis (listed/network/vouched) @200726975 region, 8192B cap + zod `{host,listed,served,canonical}`; old startup branch byte-identical across versions | **STAGED** | Backend-coupled: the check requires the peer gateway to serve the endpoint. Protocol/client validation is pure client-side and portable, but with no gateway deployment to vouch, the entire surface is unobservable in OCC. Stage with the gateway data-plane (#8) |
| 16 | Explore inherit-cap for unrecognized models | v283 static `oYe=["haiku","sonnet","opus"]` slice @203440700 → v284 dynamic rank `nyn(family)` over `D_e().models` catalog @205306379 | **STAGED (pre-existing gap)** | The v284 delta is real, BUT OCC has ZERO `inheritCap` hits — the entire Explore inherit-cap subsystem was never ported (absent since the v283 era, i.e. a pre-existing gap, not this round's delta). Porting the v284 rewrite without the surrounding subsystem = invention. Next-round candidate: port the subsystem directly at v284 semantics |

Changelog-level triage beyond the 16 binary items: the remaining ~85 entries in the official 2.1.284
changelog are VSCode-extension-only, Desktop-only, Windows-only, backend-flag rollouts, or
one-line bugfixes with no recoverable binary surface (no new strings). Marker-file verdicts:
`// Version: 2.1.284` present in v284 (0 in v283) ✓; embedded changelog in each binary only goes up
to the PREVIOUS version (`## 2.1.283` @214206775 in v284; `## 2.1.284` = 0 hits) — forensic
side-finding, consistent across both binaries.

9 additional @[MODEL LAUNCH] NO-CHANGE verdicts (sites byte-compared v283≡v284, no Sonnet-5.5
touch needed) were recorded during the §4 port — see the commit diff annotations.

## 4. Sonnet 5.5 launch — binary evidence (byte-verified)

Official v284 baked model catalog (`S8n` @198712738, "Hand-maintained baked-in model catalog"):

- **Catalog entry** `claude-sonnet-5-5` (@198712500+60000 dump `catalog_full284.txt`):
  - `family:"sonnet"`, `display_name:"Sonnet 5.5"`, `knowledge_cutoff:"June 2026"`
  - `provider_ids`: first_party/vertex/foundry/anthropic_aws/anthropic_google_cloud/gateway
    `claude-sonnet-5-5`; bedrock `us.anthropic.claude-sonnet-5-5`; mantle
    `anthropic.claude-sonnet-5-5` — same launch shape as sonnet-5/opus-5-5
  - `eager_input_streaming:{bedrock:!0,vertex:!0}`; `vertex_region_env_var:"VERTEX_REGION_CLAUDE_5_5_SONNET"`
  - `fallback_3p:"claude-sonnet-5"`
  - `context:{window:1e6,native_1m:!0,native_1m_3p:{bedrock:!0,vertex:!0,foundry:!0},supports_1m_beta:!0}`
  - `max_output_tokens:{default:128000,upper:128000}` — **differs from claude-sonnet-5**
    (`{default:64000,upper:128000}`)
  - `pricing:"tier_2_10"` = `$2/$10 per Mtok, cache_write_5m 2.5, cache_write_1h 4,
    cache_read 0.2, web_search 0.01` — same tier as claude-sonnet-5
  - `capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking","mid_conv_system",
    "context_management","rejects_disabled_thinking","per_turn_effort","lean_prompt",
    "refusal_fallback","silent_turn_reminder","org_locked_thinking"]`; `default_effort:"medium"`
    (claude-sonnet-5: `"high"`); **no** `effort_cost_index` (claude-sonnet-5 has
    `{low:0.47,medium:0.74,high:1,xhigh:2.41,max:5.59}`)
  - `image_limits:{maxWidth:2000,maxHeight:2000}`; `advisor_rank:3`
- **claude-sonnet-5 entry UNCHANGED** v283≡v284 (byte-compared).
- **Aliases** (@ catalog): `sonnet:{default:"claude-sonnet-5-5",per_provider:{bedrock:
  "claude-sonnet-4-5",vertex:"claude-sonnet-4-5",foundry:"claude-sonnet-4-5",mantle:
  "claude-sonnet-4-5",anthropic_aws:"claude-sonnet-4-6",gateway:"claude-sonnet-4-6"}}`
  — v283 had `default:"claude-sonnet-5"`, per_provider identical. opus/fable/haiku unchanged.
  `latest_per_family` sonnet: `claude-sonnet-5` → `claude-sonnet-5-5`.
- **`CATALOG_ID_TO_KEY`** (`S` map @198735403): added `"claude-sonnet-5-5":"sonnet55"`.
- **First-party id list `ere`** (@…): 21 ids, now ends `…"claude-sonnet-4-6","claude-sonnet-5",
  "claude-sonnet-5-5"]`; alias list `aj=["sonnet","opus","haiku","fable","best","sonnet[1m]",
  "opus[1m]","fable[1m]","opusplan"]`; families `B6=["sonnet","opus","haiku","fable"]` (unchanged).
- **Canonicalization** (@200499955): `if(e.includes("claude-sonnet-5-5"))return"claude-sonnet-5-5";`
  inserted BEFORE `if(e.includes("claude-sonnet-5"))return"claude-sonnet-5";`.
- **Vertex region map `d`** (@197641470): added `["claude-sonnet-5-5","VERTEX_REGION_CLAUDE_5_5_SONNET"]`.
- **`[1m]` variant**: `claude-sonnet-5-5[1m]` string hits 0→2 (v283→v284); all other `[1m]` ids
  unchanged → Sonnet 5.5 supports the `[1m]` suffix like sonnet-5.
- Canonical name-map region @99755900: `sonnet-5-5`/`claude-sonnet-5-5` short-key pairs between
  the opus cluster and sonnet-5.
- Module marker `// Version: 2.1.284` present in v284 strings.

## 5. Implementation report

25 files modified + 4 new test files, +640/−107 lines. All ports byte-verified against the v284
ELF; every touched site carries a comment citing its offset.

**(A) Sonnet 5.5 launch (item 13 — top priority, reference path OCC-134 Opus 5.5):**
- `src/utils/model/configs.ts` — `CLAUDE_SONNET_5_5_CONFIG` across all 7 providers (catalog §4:
  bedrock `us.anthropic.claude-sonnet-5-5`, mantle `anthropic.claude-sonnet-5-5`,
  `VERTEX_REGION_CLAUDE_5_5_SONNET`, eager streaming bedrock+vertex)
- `src/utils/model/model.ts` (×4 sites) — canonicalization `-5-5` branch BEFORE `-5`
  (substring hazard, official order @200499955), alias resolution (`sonnet` default flip per
  catalog aliases + per_provider table), family/latest-per-family, default-Sonnet constant
  (`SONNET_ID:"claude-sonnet-5-5"`, `PREV_SONNET_ID:"claude-sonnet-5"` @230214684)
- `src/utils/model/modelDescriptors.ts` + `unrecognizedModelSignal.ts` — first-party id list `ere`
  parity (21 ids ending `…"claude-sonnet-5","claude-sonnet-5-5"]` @197940561)
- `src/utils/model/validateModel.ts` + `src/services/api/errors.ts` — `[1m]` variant acceptance
- `src/utils/modelCost.ts` — `COST_TIER_2_10` pricing ($2/$10, cache 2.5/4/0.2, web 0.01)
- `src/utils/context.ts` — max output tokens `{default:128000,upper:128000}` (**differs** from
  sonnet-5's `{default:64000,…}` — catalog-verified)
- `src/utils/effort.ts` — `default_effort:"medium"` (sonnet-5 is `"high"`) + capability set
- `src/utils/betas.ts` / `advisor.ts` / `commitAttribution.ts` — allowlists (`advisor_rank:3`;
  commitAttribution @200499405)
- `src/utils/envUtils.ts` — `VERTEX_REGION_OVERRIDES` +19-entry table incl.
  `claude-sonnet-5-5` (@197641470)
- `src/constants/prompts.ts` — knowledge cutoff "June 2026"
- `src/skills/bundled/claudeApiContent.ts` — `SKILL_MODEL_VARS` byte-identical to v284 `oc`
  block @230214723
- `src/commands/model/model.tsx` + `src/utils/model/modelOptions.ts` — picker:
  `getSonnet55Option`/`getSonnet5PreviousOption` rows
- `src/main.tsx` — `--model` help text (byte-matched @214419817)

**(B) Security item 1 (Foundry guard):** `src/services/api/client.ts` — `FOUNDRY_RESOURCE_NAME_RE`
byte-identical to `Ixr` @203883609 + guard in `getAnthropicClient` mirroring the factory condition
@203891512 (RESOURCE set ∧ BASE_URL unset ∧ regex fail → throw official message verbatim).

**(C) Security item 2 (rules symlink escape):** `src/utils/claudemd.ts` — 8 edits:
`MemoryFileInfo.linkedFrom?`; `isRulesPathSymlink` (`tet` @205760479, fs fallback @205761080);
`isUnderCwdOrAdditionalDirs` (`bRn` @205760223); `processMdRules` gate block @205758405 parity
(`externalAllowed`/`dirIsEscapingSymlink` De/`parentDirIsEscapingSymlink` Ne → drop; `effectiveLinkedFrom`
We=`F??(De?e:Ne?parent:undefined)`; per-entry `en&&!Ce` drop @205759353 + `kn` tag @205759863;
recursion threads `discoveredDir`); `processMemoryFile` `i9` User-scope reject @205757657
(local-agent entrypoint ∧ depth-0 symlink ∨ nlink>1 regular → `[]`; `wet()`=entrypoint!=="local-agent"
@205762370) + include-loop external gate; `getExternalClaudeMdIncludes` `KRt` second branch @205771688
(`type!=='User' && linkedFrom!==undefined && !pathInOriginalCwd` → `{path,parent:linkedFrom}`).

**(D) Security item 4 (elicitation):** `src/utils/hooks.ts` — `parseElicitationHookOutput` at `mEr`
@207400684 parity: `if (result.blocked)` first branch surfacing raw `output||fallback` (drops
v283's `&&!e.succeeded` conjunct), JSON branch honors `decision==="block"` unconditionally.

**(E) OCC-100 carry-over (item 12):** `src/keybindings/loadUserBindings.ts` —
`isKeybindingCustomizationEnabled()` fallback `false`→`true` (official gate default, §7).

**(F) Test pins:** `opus55Launch280.test.ts` + `modelOptionsTierWiring280.test.ts` updated for the
Sonnet-default flip; `test/e2e/version-2.1.219-opus5.e2e.test.ts` extended with Sonnet 5.5
assertions; 4 new test files (§8).

## 6. Security items

Five security fixes in official 2.1.284. Disposition: **3 PORTED, 2 STAGED** (per-item rationale in
§3 rows 1–5). Byte-evidence summary:

1. **Foundry resource validation — PORTED.** v283 `jh()` @202054583 built the Foundry base URL by
   raw interpolation of `ANTHROPIC_FOUNDRY_RESOURCE` → any host/URL smuggled through the env var
   redirected inference traffic. v284 adds `Ixr=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/i`
   @203883609 + factory throw @203891512. Note: the regex's second group is NOT optional — minimum
   length is exactly the 2 the official error message claims (single-char rejected; test-pinned).
2. **Rules symlink escape → approval — PORTED.** v284 walker `O0e` @205758070 drops project rules
   entries whose symlink escapes cwd (per-entry `en&&!Ce`), drops the whole walk when the rules dir
   (De) or — new in v284 — the `.claude` PARENT (Ne, Project scope, grandparent under cwd) is an
   escaping symlink, tags survivors with `linkedFrom` provenance feeding the `KRt` collector →
   "Allow external CLAUDE.md file imports?" dialog (@233934490, both versions). `i9` User-scope
   reject is byte-identical in v283 (@203895369) — OCC's 2.1.282-era port omitted it; backfilled.
   Path resolver `xo` @197701423: realpath success → `isCanonical:true` (matches OCC
   `safeResolvePath`); its `Vp` warm-cache branch has no OCC counterpart — OCC = official
   cold-cache semantics always.
3. **Plugin allowed-tools trust tiers — STAGED.** v284 `Lu` @201722334 replaces v283 `Eu`
   (which OCC already ships as `isPluginAllowedToolsTrusted`) with a 5-tier switch keyed on the
   plugin trust-tier registry (`XS`/`rd`), `officiallyAttested` (0 hits in v283), and npm
   registry pinning (`WDr` @201452219 requiring `strictKnownMarketplaces`). OCC lacks the
   trust-tier registry entirely; the gate is only reachable under enterprise
   `allowManagedPermissionRulesOnly`. Substituting a blanket deny would over-restrict vs official
   (Ra tier → true) = invention. Staged with the subsystem as prerequisite.
4. **Elicitation hook block honored — PORTED.** `mEr` @207400684 vs `Vbr` @205549934: two exact
   deltas (`if(e.blocked)` vs `if(e.blocked&&!e.succeeded)`; `decision==="block"` vs
   `decision==="block"||e.blocked`). v283 stranded the JSON-block-with-exit-0 case
   (blocked=true ∧ succeeded=true). OCC now matches v284: raw output surfaced on blocked,
   JSON `decision:"block"` always honored. Runner/consumer surfaces verified byte-identical
   across versions (@207296006/@231281182 vs @205447821/@229171378).
5. **Sandbox bwrap rewrite — STAGED.** Official-internal bwrap mount-assembly layer; OCC uses
   `sandbox-runtime@0.0.44` which owns its own mount assembly. No corresponding OCC code path.

## 7. OCC-100 carry-overs

**`--client-data-url` — STAGED verdict MAINTAINED (zero new evidence).** All 9 string hits and
their ±250B contexts are text-identical between the v283 and v284 ELFs (passthrough set
@204982474/@203105332, deep-link allowlist @199172691/@198180218, error text @212766856/@210889376,
yargs registration @214420895/@212490768, cloud-session table @214071651/@212144904, 4 string-table
mirrors). No v283→v284 delta → the ledger is not updated with new binary evidence; the OCC-100
STAGED verdict (mechanism portable, but the signed configuration document is issued by Anthropic at
downloads.claude.ai = issuance-side stage) stands unchanged.

**`/help` gated row: `/keybindings to customize` — FIXED (gate default aligned to official).**
Official gate `KV()` @204876508 (v284) ≡ `yV()` @203041522 (v283), both
`return x("tengu_keybinding_customization_release",!0)` — Statsig flag with default **TRUE** in
both versions. OCC's GrowthBook is stubbed (`getFeatureValue_CACHED_MAY_BE_STALE` resolves env
overrides → config overrides → `!isGrowthBookEnabled()` → defaultValue), so the fallback IS the
shipped value. OCC's previous `false` fallback hid the help row and gated off the keybindings
loader/watcher/`/keybindings` command for everyone — an environment-visible divergence. Fixed at
the single call site `isKeybindingCustomizationEnabled()`; all 8 consumers (loader ×3, bundled
skill, warnings banner, help menu, command registration ×2) now consistently default-on. Keybindings
suite 47/47 green; `commands-alignment.e2e` asserts only the missing-set (no set-equality) so the
newly-enabled `/keybindings` registration cannot break it.

**`/help` gated row: `alt + o to toggle fast mode` — ENVIRONMENT DIFFERENCE (documented, no code
change).** Official gate is `bo()&&Qk()` (@226646250+407): `Qk(e){if(!bo())return!1;return
p6(e)===null}` @200404663 — the second predicate is ACCOUNT availability (usage-credits /
subscription state), and the chord (`alt+o`) is read at runtime from keybinding config. OCC's
`PromptInputHelpMenu.tsx:294` already implements the structurally identical
`isFastModeEnabled() && isFastModeAvailable()` (fastMode.ts:39-48; reason messages byte-match the
official `rm()`/`nm()` adjacent to `Qk`). The row is hidden in OCC solely because the account
backend state resolves unavailable — correct behavior for the environment, not a code divergence.
The only v284 delta in this area is the model-catalog `fast_mode:{type:"toggle",…,"Enable fast
mode"}` block (×10 new hits) — catalog data, gated behind the same account predicate.

## 8. Tests

New this round (all green, run under `scripts/ci-test.sh` per-file isolation):

| File | Tests | Covers |
|------|-------|--------|
| `src/utils/model/__tests__/sonnet55Launch284.test.ts` (NEW, ~330 lines) | catalog/alias/canonicalization/[1m]/cost/effort/context/vertex pins | item 13 |
| `src/utils/__tests__/memoryRulesEscape284.test.ts` (NEW) | 13 | item 2: per-entry drops, De/Ne dir drops, linkedFrom provenance + KRt, i9 backfill (symlink/hardlink/depth arms) |
| `src/services/api/__tests__/foundryResourceGuard284.test.ts` (NEW) | 8 | item 1: attack shape, URL smuggle, regex boundaries (2/64/65, single-char), BASE_URL skip, unset no-throw |
| `src/utils/__tests__/elicitationHookBlocked284.test.ts` (NEW) | 7 | item 4: real hook scripts through `executeElicitationHooks`/`executeElicitationResultHooks` — exit-2 stderr, JSON-block raw-output delta case, accept/decline, non-JSON ignore |

Updated pins: `opus55Launch280.test.ts` (Sonnet-default flip), `modelOptionsTierWiring280.test.ts`,
`test/e2e/version-2.1.219-opus5.e2e.test.ts` (25 pass / 0 fail / 97 expect()).

Regression proof: `memorySymlinkRefusal282` 46/46 (item-2 neighborhood unchanged behavior);
keybindings suite 47/47 (carry-over gate flip); full `scripts/ci-test.sh` src suite + build +
REPL tmux e2e results: see §8a below.

### 8a. Full-suite / e2e results

**Full `scripts/ci-test.sh`** (679 files, per-file bun isolation), run against this round's tree:

- First pass: **6977 pass / 121 fail / 15 skip** — all 121 failures were the 32 `test/e2e/*`
  files failing with `occ: dist/cli.js not found` (e2e spawns the built artifact; `dist/` was
  not built yet this round). Not a code regression.
- After `bun run build` (**green — `dist/cli.js` 29.53 MB**, `MACRO.VERSION=2.1.359`; the
  2.1.360 bump waits on acceptance per §9), re-running those 32 files: **212 pass / 10 fail
  in 6 files**. Every remaining failure was triaged individually:

| File | Result | Verdict |
|------|--------|---------|
| `version-2.1.329-effort-cap.e2e` | 6 pass / 1 fail (test-f3 picker nav) | **PRE-EXISTING** — git-stash A/B: fails identically on the baseline tree (same 4002 ms timeout) |
| `version-2.1.208-screen-reader.e2e` | 0 pass / 1 fail | **PRE-EXISTING** — A/B: fails on baseline too |
| `repl-interactive.e2e` | 2 pass / 1 fail | Only "Shift+Tab shows the auto-mode opt-in dialog" fails — **known pre-existing** (documented since OCC-44 self-acceptance). Shift+Tab cycling + /goal panel now pass |
| `feedback-ai.e2e` | 5 pass / 1 fail | **ENVIRONMENTAL** — the live proxy served `glm-5.2` (non-catalog) → `[claude-code:unrecognized_model]` marker + 180 s timeout |
| `commands-behavior.e2e` | /context 60 s, /goal 120 s, /feedback ×2 timeouts | **FLAKY (live-model latency)** — failing subset changed between identical runs; env pins `ANTHROPIC_MODEL=qwen3.8-max`, so the Sonnet-5.5 default flip cannot reach these paths |
| `real-coding.e2e` | FileWrite/FileEdit 120 s timeouts (4 fail → 2 fail across runs) | **FLAKY (live-model latency)** — same rationale |

All `src/**` (unit/wire) files are **green**. Deterministic re-runs of this round's surface:
4 new test files green (§8 table); `gap113` **38/38** after fixing 2 stale pins (`'sonnet'`
alias now resolves to `claude-sonnet-5-5` — pin comments cite the catalog byte offset);
`forwardSubagentText` 25/25; `launcher` 9/9; `occ-versioning` 1/1;
`version-2.1.219-opus5.e2e` **25 pass / 97 expect()**; `commands-alignment` 5/5 (no
set-equality breakage from the newly-enabled `/keybindings`); `memorySymlinkRefusal282`
46/46; keybindings suite 47/47.

**REPL tmux live e2e** (`repl-tmux-e2e-testing` skill, Architecture A — detached 200×50 tmux
session spawning the built `dist/cli.js`, isolated seeded HOME with onboarding/trust/custom-API-key
approval pre-seeded, poll-until-text, `finally` teardown):

- `BOOT_OK` — REPL boots to the `Ready when you are.` screen with the built artifact.
- `/help` renders **`/keybindings to customize`** (`HELP_ROW_OK`) — the carry-over gate fix
  (§7) is live-verified in the real REPL, not just unit tests.
- `/help` also renders **`alt + o to toggle fast mode`** (`FAST_ROW_PRESENT`) — with a real
  API key the account-availability predicate is satisfied here; consistent with the
  §7 environment-difference verdict (OCC gate structure `isFastModeEnabled()&&isFastModeAvailable()`
  ≡ official `bo()&&Qk()`).
- `/keybindings` command opens and renders the default bindings JSON document
  (`"$schema": "https://www.schemastore.org/claude-code-keybindings.json"`, Global/Chat
  contexts with ctrl+t / ctrl+o / shift+tab / meta+o etc.).
- `/model` picker opens and renders without crashing after the modelOptions edits
  (Default → Custom Opus `qwen3.8-max ✔` → Fable 5.1 → …). Note: behind the custom
  `ANTHROPIC_BASE_URL` the picker takes the firstParty **custom-row** path (Custom Opus/
  Sonnet/Haiku), so the payg3p Sonnet-5.5 rows are not visible in *this* environment —
  they are covered programmatically by `modelOptionsTierWiring280` + the 97-expect
  picker-navigation e2e (`version-2.1.219-opus5.e2e`), both green.

## 9. Release

Release **2.1.360** is gated on the dispatch's acceptance chain: handoff comment → 安全审核员
(backdoor review) → 验收员 acceptance. On acceptance: bump `package.json` to 2.1.360, add the
`## 2.1.360 - <date>` CHANGELOG.md section (feeds the REPL "What's new"), tag `v2.1.360`, push
tags (CI publishes `@cnwenf/occ` + GitHub Release). This round does NOT cut the release itself —
per dispatch, the Leader closes the loop after acceptance.
