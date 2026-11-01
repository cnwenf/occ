# Upstream Version Gap — OCC-140 (2026-11-02)

**Round type:** no-gap strict self-acceptance + carried-over security STAGE verdict.
**Official latest at round start/end:** `2.1.316` (npm `@anthropic-ai/claude-code` + `-linux-x64` both re-confirmed 2026-11-02 — unchanged since the OCC-139 alignment round; no new release to catch up).
**OCC version:** `2.1.410` (HEAD `0fbe8562`, tree unchanged this round except this doc).
**Discipline:** official binary READ-ONLY (never executed); all forensics via `strings`/`grep`/python-mmap byte offsets.
**Revision (acceptance review, 2026-11-02):** docs-only accuracy corrections per 验收 review (P2-1/P2-2/P2-3 + P3-1/P3-2/P3-3) — verbatim bullet-#16 quote (§1), evidence-level note live-forensic vs repo-pin (§2a.1), §2c rewritten to cite the registered OCC reduction (1) at `effort.ts:600-618` + v312↔v316 symbol correspondence instead of "identical structure", new-test-file count 5→4 + hygienic-phrasing correction (§3c.2), and the 1,099-file counting basis (§3c). Second round: P2-1 support sentence narrowed from a universal claim to per-call-site facts (`Spinner.tsx:209` threads `getSentEffort()`; banner callers thread neither). No verdict changes.

---

## §1 Carried security STAGE — official 2.1.316 bullet #16: verdict **NO-OP (N-A ×2, grep-proven)**

Bullet #16 (2.1.316 changelog, security), quoted verbatim: *"Fixed `--restricted` sessions uploading files from outside the working directories when a Read allow rule covered them"*

### 1a. Byte-level fix mechanism (what official changed)

The fix lives in the MCP-drive-file-reference / hosted-upload gate `ye(e,n,i,r,h,d)` — the `readsBlocked` computation gained the `restricted` arm:

| Binary | Offset | `readsBlocked` expression |
|---|---|---|
| v2.1.314 | @270051351 | `readsBlocked:!r.hostFills&&n.blockReadsOutsideWorkingDirectories===!0` |
| v2.1.315 | @300034811 | `readsBlocked:!r.hostFills&&(n.blockReadsOutsideWorkingDirectories===!0\|\|n.restricted===!0)` |
| v2.1.316 | @300036049 (`n.restricted===!0` @300036121) | identical to v315 |

Effect: in a `--restricted` session, a Read allow rule can no longer override the working-directory fence for uploaded/drive-referenced files.

### 1b. Why NO-OP for OCC

Both required surfaces are absent from OCC (grep-proven this round, 0 hits each):

1. **Trigger surface absent** — OCC ships no `--restricted` mode: no flag in `src/entrypoints/cli.tsx`, no `CLAUDE_CODE_RESTRICTED` env wiring, no `restricted: true` assignment anywhere, no `ToolPermissionContext.restricted` field. The mode has been **STAGED since OCC-107/108** (see `docs/upstream-version-gap-occ108.md` line 117: 大跨切面新安全模式，专项一轮落地更安全).
2. **Carrier surface absent** — the whole hosted-upload/drive-reference subsystem the fix lives in does not exist in OCC: `mcp_drive_file_reference`, `hostFills`, `entry_not_held`, `stillHeld`, `wrongArguments`, `ref_malformed`, `changed_after_check` — all 0 grep hits (also documented at `src/utils/attachments.ts` ~L2425 and `src/utils/permissions/readDeny.ts` ~L33).

The only `restricted`-named code in OCC is the dormant byte-verbatim analytics classifier (`src/hooks/toolPermission/safetyEvent.ts` `REASON_RESTRICTED_MODE` + `restrictedMode` circuit-breaker key) — an event-reason enum port, **not enforcement**.

### 1c. Correction to the OCC-139 ledger

OCC-139 ledger §5 STAGE-table row 16 asserted *"OCC's `--restricted` mode surface exists"* — **FALSE** (grep-proven this round; see 1b.1). The row is corrected by this section; the NO-OP verdict itself is unchanged from OCC-139's staging, but now with the v314→v315/v316 byte evidence attached.

### 1d. Port constraint registered for the future `--restricted` special round

When `--restricted` is finally ported (staged since OCC-108), it **must carry v2.1.315+ semantics**: the upload-gate `readsBlocked` must include the `||n.restricted===!0` arm from day one (porting the v314 shape would re-introduce the exact vulnerability bullet #16 fixed). Registered in §5 item 1.

### 1e. Changelog-lag finding (forensic hygiene)

Official CHANGELOG has **no `## 2.1.315` section**; the 2.1.316 section covers 314→316, and the changelog items actually landed in the **2.1.315 binary**. The 315→316 string delta is build-stamp noise only: 31 real changed pairs after chunk-hash normalization (all single-char/build-timestamp/`// Version: 2.1.31[5→6]` artifacts) + macOS-native additions (`__info_plist`, `bunNativePtrp`, `webStreamControllerErrorH`, TCC/`realpathNativeCb` chunk) — nothing portable to OCC (linux CLI). Bullet #16's code therefore sits in v315 already; v316 carries it forward byte-identically.

---

## §2 Strict self-acceptance (live REPL, real tasks — no source-reading inference)

Environment: host tmux 200×50, `bun dist/cli.js` (OCC 2.1.410), third-party model backend via `ANTHROPIC_BASE_URL` (qwen3.8-max / glm-5.2; `[claude-code:unrecognized_model]` stderr note is expected and matches official unrecognized-model handling).

### 2a. Priority ① — the three OCC-139 ports, live-verified

| # | Feature | Verification | Result |
|---|---|---|---|
| 1 | **ULTRATHINK rainbow rendering** | `capture-pane -p -e` raw SGR on live input | PASS — per-char SGR cycle `210→216→222→151→146→182` (7-color modulo cycle); palette **byte-identical to official v316 binary** (`src/utils/theme.ts` rgb values ≡ extracted official `rainbow_*` theme keys, incl. shimmer variants). **Evidence level: live-forensic, not repo-pin** — the exact rgb cycle order/palette byte-identity rests on the `capture-pane -e` raw-SGR capture + official-binary strings comparison; no repo test asserts the specific values. The existing repo-level pin (`src/components/messages/__tests__/thinkingPointerInactive287.test.tsx`, OCC-139 review P2-3) locks the per-char `38;2;r;g;b` interleaving **structure** (10 per-char opens over `[u,l,t,r,a,t,h,i,n,k]`, ≥12 truecolor opens total) with `\d+` placeholders instead of palette values. Submitted a real `ultrathink` prompt → genuine deep-verification turn (model ran `wc -c`/`hexdump` on its own output; 29,820 tokens). |
| 2 | **`CLAUDE_CODE_DISABLE_ULTRATHINK=1` kill switch** | same input, env set | PASS — renders plain `[39m`, zero rainbow SGR codes. Raw-truthiness semantics (ANY non-empty value incl. `'0'`/`'false'`/`' '` disables; official `ePt` @276986161) pinned by `src/utils/__tests__/ultrathinkDisableEnv316.test.ts`. |
| 3 | **`CLAUDE_CODE_SUBAGENT_EFFORT`** (workflow `agent()` effort default) | binary parity re-extraction + unit suite | PASS — official resolver/apply-site extracted verbatim from v316 this round: `IH` @278279939 (trim+lowercase+`med` alias+strict level; numerics invalid), `XCt` @278280647, `Pxo` @291219410 (`if(e.effort!==void 0\|\|uE(e)\|\|w_(t)!==void 0)return; … g("subagent_effort_default"); else if(n!=="inherit") f(…,"unknown_level")`). OCC `getSubagentEffortEnvDefault` + `resolveSubagentEffortEnvDefault` (`src/utils/effort.ts` L248, `src/tools/WorkflowTool/primitives.ts` L186) are line-by-line ≡ (named-effort `rK` loose-parse precedence, case-strict `inherit`, both telemetry arms; `uE`/`w_` guard arms verified vacuous in OCC). No terminal-visible surface exists for this feature (workflow API param) — binary+unit parity is the correct verification level. |

### 2b. Priority ② — core trunk, live REPL

- Boot banner: `OCC v2.1.410`, tips box, model line — renders clean. PASS.
- Real agentic task: prompt → `Write` → `Read` → exact correct answer ("exactly BANANA42, no trailing newline"). PASS.
- Pipe mode: `echo "say PONG" | occ -p` → `PONG`, exit 0 — on host AND inside the docker image. PASS.
- `/effort` (no args): `Current effort level: xhigh (Deeper reasoning than high, just below maximum …)`. PASS.
- Root-guard parity (incidental, from e2e triage): fresh-HOME root + `--dangerously-skip-permissions` → official byte-identical refusal (`--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`, exit 1); persisted-acknowledgment host → allowed; `IS_SANDBOX=1` → allowed. Matches official root-guard semantics exactly. PASS.

### 2c. Effort banner-vs-pill divergence — investigated, **NOT a gap** (official architecture)

Observed: banner `glm-5.2 with xhigh effort` + `/effort` says `xhigh`, while the input pill shows `● high · /effort`.

Root cause is the official **two-resolver architecture**, byte-verified against v316:

- **Banner** = welcome suffix — v316 extraction `eRt` @278286521: `function eRt(e,n,r,s){if(n===void 0&&r===void 0)return"";let f=s??aS(e,n,{turnEffort:r});if(f===void 0)return"";return\` with ${h3(WN(f))} effort\`}`. Symbol note: `src/utils/effort.ts:598-615` cites the same surface from the earlier v312 extraction as `Sbn`/`kS`/`e6`/`U0` @243469955 — minified names rotate between binary versions (`eRt`≡`Sbn`, `aS`≡`kS`, `h3`≡`e6`, `WN`≡`U0`); the two extractions are structurally identical, and this doc uses the v316 naming throughout. `s` (sentEffort) short-circuits; the official **fallback** `aS`/`kS` is the **applied** (capability-clamped) resolver (`resolveAppliedEffort`). OCC `getEffortSuffix` (`src/utils/effort.ts` L617) matches the `s ??` precedence + guard exactly, but its fallback deliberately keeps the **configured** resolver (`resolveConfiguredEffort`, Gap-97c verbatim display) — this is the **registered OCC reduction (1)** documented in the byte-restoration comment at `effort.ts:600-618` ("the fallback path is left unchanged so existing Logo/cap behavior is preserved, and only the `s ??` precedence is added"), NOT an identical structure. What holds is the **same observable contract for current callers**, per call site: the **banner callers** (`src/components/LogoV2/LogoV2.tsx:168`, `src/components/LogoV2/CondensedLogo.tsx:41`) pass only `(model, effortValue)` — no current caller threads `turnEffort` (comment at `effort.ts:629-631`: "none threads turnEffort yet") — so the banner renders the configured level verbatim and capability clamping surfaces only on the pill face; the **Spinner caller** (`src/components/Spinner.tsx:209`) DOES thread `getSentEffort()` as the 4th arg (`turnEffort` still `undefined`), exercising the v312 in-force port — the spinner shows the level IN FORCE, exactly the `s`=sentEffort carrier the byte-restoration comment at `effort.ts:600-618` describes.
- **Pill** = `getEffortNotificationText` → `getSentEffortLevel` → the **capability-clamped SENT** value (CC 2.1.304 #35: official switched the chip from the display-guesser to the sent-resolver; normalizers `WN` @276737720 / `h3` @278279907 extracted).

The third-party backend model is unrecognized → does not support `xhigh` → the SENT value clamps to `high` while the configured display stays `xhigh`. On an official xhigh-capable model (Opus 4.7+, Sonnet 5, Fable 5) both surfaces render `xhigh`. Divergence direction, gating, and texts all match official — recorded as an observation, no fix.

### 2d. No behavioral gaps found

Every probed surface matched the official contract. Zero code changes this round (docs-only commit).

---

## §3 E2E results

### 3a. Docker suite (`bash test/e2e/run.sh`, image `occ-e2e:latest`)

**679 pass / 70 fail / 1 skip / 11 errors** (750 tests, 162 files, 1134 s). All 70+11 non-passes triaged to **container-environmental artifacts, zero product regressions**:

| Cluster | Count | Root cause (proven) |
|---|---|---|
| real-model `-p` tests (`real coding tasks`, `slash command behavior`, `/verify`) | 58 | Container runs as **root with fresh HOME and no `IS_SANDBOX`** → OCC's official-faithful root guard refuses `--dangerously-skip-permissions` (exit 1 in ~776 ms). Reproduced manually; same command with `IS_SANDBOX=1` → `PONG`, exit 0. |
| tmux/PTY REPL tests (welcome page, keybindings, interactive, trust gate, auto-default nudge, OCC-82 effort cap, image paste, screen-reader, resume, /goal panel, hljs injection) | ~42 test cases | Same root guard: the tmux spawn target exits immediately → session dies → `no server running on /tmp/tmux-0/default` + 5 s timeouts. |
| `Cannot find module '../../src/…'` / `'react'` / `'../../package.json'` | 11 errors | `/test/e2e` is mounted read-only at a path where `../../src` resolves to `/src` (nonexistent) — these direct-import tests are host-layout-only. |

**Infra observation (not landed):** `test/e2e/run.sh` does not forward `-e IS_SANDBOX=1`, so the docker path can never pass the root guard for real-model/tmux tests as currently wired. One-line fix candidate for a future round; this round keeps zero code changes (host runs remain the baseline methodology — see 3b).

### 3b. Host suite (`bun test test/e2e`) — baseline methodology of prior rounds

**776 pass / 11 skip / 1 fail** (788 tests, 162 files, 947 s, 2843 expect() calls) on the unchanged OCC-139 review-fix tree (HEAD `0fbe8562`).

- The single fail is the **known `/feedback` live-model wording flake** (`commands-behavior.e2e.test.ts:169` — model reply phrasing vs the `/Issue (created|filed)/i` assertion), the same flake recorded in the OCC-139 ledger and the 2.1.408 round. **Isolated re-run of `commands-behavior.e2e.test.ts`: 16/16 green** (same confirmation method as OCC-139). Net real failures: **0**.
- Result is byte-identical to the OCC-139 review-fix replay (776/11/1) → **zero regressions this round** (expected — no product-code changes).

### 3c. Unit suite (`bun test src`) — full triage

First full run on host: **13,517 pass / 272 fail / 1 skip** (13,790 tests, 1,099 files, 264 s — counting basis: `bun test src` discovers from the repo root per `bunfig.toml` `root = "."` and treats the positional `src` as a path-substring filter, so the runner's 1,099 = 1,098 test files under `src/**` + 1 `packages/color-diff-napi/src/__tests__/color-diff.test.ts` whose path also contains `src`; a plain `find src -type f -name '*.test.*'` yields 1,098) — executed immediately after the 947 s e2e on a shared host (load-inflated). Rigorous triage (product tree git-clean, byte-identical to OCC-139 HEAD `0fbe8562` — zero regression potential this round):

1. **Batch re-run of the 79 failing files** (dirty env): 73 fail. **Clean env + fresh HOME** (`env -i`): 76 fail → NOT shell-env or settings contamination.
2. **Every one of the 79 files re-run ALONE in its own bun process: 78/79 fully green.** → the batch failures are **cross-file state pollution in the single-process `bun test` runner** (order-dependent; spans unrelated subsystems — settings-cache seeding, BashTool shell exec, sandbox spawn, auth headers — the classic pollution signature, not a code defect). Pre-existing suite characteristic on this host; OCC-139's **4** new test files (`git diff f004aba4..0fbe8562 --diff-filter=A`: `src/utils/__tests__/ultrathinkDisableEnv316.test.ts`, `src/utils/__tests__/subagentEffortEnv316.test.ts`, `src/tools/WorkflowTool/__tests__/subagentEffortEnv316.test.ts`, `src/tools/WorkflowTool/__tests__/subagentEffortWiring316.test.ts` — the 5th added file in that range is the OCC-139 ledger doc itself, not a test) were audited and are hygienic: they do write `process.env[ENV_VAR] = …` directly in test bodies, but every file pairs the writes with a module-level `SAVED` capture + `beforeEach` delete + `afterEach` restore — not the polluter.
3. **The 1 file that fails alone** — `src/utils/__tests__/argumentSubstitutionCaps301.test.ts` ("budget covers named-arg values too", 1 fail): the **known pre-existing bun-1.3.14 local artifact** already documented and clean-HEAD-A/B-verified in the OCC-138 ledger (CI pins bun 1.4.2; host is 1.3.14 — confirmed same test name + same non-throwing behavior).

**Net real unit failures: 1 (known pre-existing local-runtime artifact).** Same disposition as OCC-138.

---

## §4 Gaps found / fixed this round

- **Behavioral gaps vs official 2.1.316: 0.**
- Documentation correction: OCC-139 §5 row-16 "surface exists" claim → corrected by §1c.
- Infra observation: run.sh `IS_SANDBOX` forwarding (§3a) — recorded, deliberately not landed (would trigger the release machinery on a no-gap round for a test-only convenience).

## §5 STAGE registry (carried forward)

1. **`--restricted` special round** (staged since OCC-108; re-confirmed absent this round). When landed it MUST carry v2.1.315+ semantics — the `readsBlocked` restricted arm (§1d) and the official `sy` OR-gate already documented in `src/utils/permissions/readDeny.ts`.
2. All OCC-139 §7 staged items unchanged (none advanced this round — no new upstream surface).
3. run.sh `IS_SANDBOX=1` forwarding (§3a) — optional test-infra improvement.

## §6 Release decision

**No product-code changes → no release, no tag, no npm publish** (per round workflow: merge+release only when code changes). Single docs-only commit with this ledger. Known standing debt unchanged: npm publish E404-blocked since 2.1.367 (`globalVersion 2.1.410 > latestVersion 2.1.367` boot note is expected).
