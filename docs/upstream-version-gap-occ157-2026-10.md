# Upstream Gap Ledger — OCC-157 Round (2026-10-14)

**Baseline:** official Claude Code latest = **2.1.296** (`latest` dist-tag; `next` also 2.1.296; official stable channel top = 2.1.287 — occ156-03 re-review NOT triggered). OCC = **2.1.381** (v2.1.381 tag @ `967403a`), tracks 2.1.296, no version gap. Round start: main @ `780b1b8`.

**Round directive (OCC Leader):** strict evidence-first self-acceptance of the OCC REPL vs official 2.1.296 behavior — ① newest ported surface (auto-default nudge `7b17869` + corrections `035311d`/`780b1b8af`), ② occ156 §7.4 LOW-1/LOW-2 verify-first, ③ core trunk spot-checks. Official-binary discipline: **forensics only** (npm pack `@anthropic-ai/claude-code-linux-x64@2.1.296` → `/tmp/cc296/package/claude`, `strings`/`grep -aboF`/bounded `dd`; the official binary is never executed — occ115 precedent).

**Never invent.** Every GAP below carries byte-exact official evidence (offset + extraction) or a reproducible local run. Unevidenced items are marked CAND.

---

## 1. Step-1 post-tag commit review — PASS (test-only)

`git diff 967403a..780b1b8 --name-only` (1 commit, `780b1b8af`):

- `docs/upstream-version-gap-occ115-2026-10.md` (ledger §9 FIX round addendum)
- `scripts/ci-test.sh` (LEAK_PAIRS registration only)
- `src/utils/permissions/__tests__/autoDefaultNudge296.test.ts`
- `src/utils/permissions/__tests__/autoDefaultNudge296Merge.test.ts`

No `src/` production change → no stop-work trigger; round proceeds.

## 2. Verify-first dispositions (occ156 §7.4 carryovers)

### LOW-1 — `main.tsx:2677` accept-path has no try/catch → **FALSIFIED (no realistic crash surface); CLOSED, no fix**

Claim: the nudge accept path (persist → re-check → live transition, `main.tsx:2677` = `transitionPermissionMode(...)` inside the `switched` branch) could throw unguarded and crash startup.

Full throw-safety chain audit (current main @ `780b1b8`):

| Call in the nudge path | Guard | Evidence |
|---|---|---|
| `shouldShowAutoDefaultNudge()` → `getGlobalConfig()` | slow path wrapped in `try {…} catch { fallback }` (`config.ts:1149-1173`); fallback = uncached `getConfig(file, createDefaultGlobalConfig)` | `getConfig` (`config.ts:1503+`): ENOENT → backup probe + `createDefault()`; corrupt JSON → `ConfigParseError` re-thrown ONLY when `throwOnInvalid` (not passed here) — otherwise logs `tengu_config_parse_error` + resets to defaults. Cannot throw on this path. |
| `shouldShowAutoDefaultNudge()` → `getSettingsForSource(...)` | cached→uncached; uncached reads go through the sanitized settings loaders (OCC-132 P3-6 guards documented in-file) | returns `SettingsJson \| null`, no throw path for the 5 layers |
| `resolveAutoDefaultNudge()` → `trySwitchToAutoDefault()` → `updateSettingsForSource(...)` | entire mkdir/read/merge/write body in try/catch → returns `{error}` | `settings.ts:716-824`; corrupt JSON → validation Error value, never throws |
| `markNudgeSeen()` | own `try/catch` + `logForDebugging` | `autoDefaultNudge.ts:94-106` |
| `transitionPermissionMode(permissionMode,'auto',ctx)` | pure context transform (map/spread over ctx) | `permissionSetup.ts` |
| `launchAutoDefaultNudgeDialog(...)` | Ink render/await of the setup-dialog host (same machinery as every other startup dialog, none of which is individually try/caught) | `dialogLaunchers.tsx` |

Structural note (not a gap): official wraps the async gate evaluation in `.catch((at)=>(c(at),null))` inside the `#n` scheduler — defense-in-depth around a dynamic-import promise chain. OCC's block is synchronous inside the already-guarded startup sequence; every callee is individually throw-safe, so the outer wrapper has no reachable divergence. Per coding-style KISS/YAGNI: no speculative try/catch added.

**Disposition: CLOSED-FALSIFIED.** occ156 §7.4 LOW-1 was "verify-first"; verification found no real gap.

### LOW-2 — explicit CLI mode nudge suppression "vs official aMr" → suppression claim **FALSIFIED**; verification surfaced a **REAL adjacent gap** (currentMode source), FIXED this round

- Suppression claim: neither side suppresses the nudge on explicit `--permission-mode`. Official `aMr` reads ONLY settings layers (`fe("userSettings")?.permissions?.defaultMode` + other-layer check) — `--permission-mode` is a session launch option, not a settings layer, on both sides. Official suppression is via the caller: `#n` early-returns on `Nt()` and the gate is forced to `Promise.resolve(null)` under `fm()` (`sd()||Nt()||eb()!==void 0` — bg/non-interactive surfaces). OCC's block sits inside `if (!isNonInteractiveSession)` → equivalent suppression semantics. **No gap as originally framed.**
- **Real gap found while verifying** (byte evidence below, GAP occ157-01): official feeds the dialog + telemetry with the GATE's return value (the pinned userSettings `defaultMode`), not the session mode. OCC `main.tsx` passed the session `permissionMode`. Diverges whenever `--permission-mode X` differs from the settings pin: decline label `No, keep ${indicator}` and `tengu_auto_default_nudge_resolved.current_mode` would both report the session mode instead of the pinned mode. **FIXED** (one-line: pass `nudgeCurrentMode`).

## 3. Gaps found this round

### occ157-01 (P3, contract surface) — dialog/telemetry `currentMode` source diverges under explicit `--permission-mode` → **FIXED**

Official byte evidence (`/tmp/cc296/package/claude`):

- `ZIe` @238435100 region: `async function ZIe(h,C,L){await HKt(L.activity,L.signal);let ee=await h(XZ,{currentMode:C},{place:"under",signal:L.signal});if(ee==="cancelled"||fm())return;Ckt(ee,C,H)}` — the dialog payload `{currentMode:C}` and resolver arg `C` are the SAME `C` the scheduler passes in.
- Caller `#n`: `…import("…chunk-2a73tp29.js").then((at)=>at.shouldShowAutoDefaultNudge(L.getState().toolPermissionContext)).catch((at)=>(c(at),null))` — `C` = gate return value = `aMr`'s `e` = **userSettings pinned `permissions.defaultMode`** (`let e=fe("userSettings")?.permissions?.defaultMode … return e`).
- `XZ=Zo({kind:…,payload:p(()=>u({currentMode:U(Fv)})),result:p(()=>u(["accept","decline","cancelled"])),default:"cancelled",hideWhile:["panel","draft"]})` @238435270 region.

OCC before fix: `main.tsx:2665-2667` passed session `permissionMode` to `launchAutoDefaultNudgeDialog` and `resolveAutoDefaultNudge`, discarding the gate's `nudgeCurrentMode` return. Fix: pass `nudgeCurrentMode` at both sites (matches official `ZIe(h, C=gateResult, …)` exactly).

### occ157-02 (P3, contract surface) — `tengu_auto_default_nudge_resolved` suppressed on gate_off; official logs unconditionally → **FIXED (reverts 035311d's guard move)**

Official byte-exact `Ckt` @238435541 region (re-extracted this round, verbatim):

```js
function Ckt(h,C,L){
  let H=h==="accept"?Tkt(L):"declined";
  if(H!=="gate_off")Ae((ee)=>ee.hasSeenAutoDefaultNudge?ee:{...ee,hasSeenAutoDefaultNudge:!0},L.storageV5).catch(c);
  i("tengu_auto_default_nudge_resolved",{choice:d(h),outcome:d(H),current_mode:d(C)})
}
```

The braceless `if(H!=="gate_off")` guards ONLY the `Ae(...).catch(c)` flag write. The `i(...)` telemetry call is OUTSIDE it — official logs `resolved` for EVERY non-cancelled choice, including `outcome:"gate_off"` (cancelled never reaches `Ckt`: `ZIe` early-returns). occ115 §8 P3-1 moved OCC's `logEvent` INSIDE the guard based on a misread of this brace structure ("mirroring official Ckt's if(H!=="gate_off") block" — the block is one statement, not the telemetry). Fix: `markNudgeSeen()` stays guarded; `logEvent` moved out; docblock + unit assertions corrected. Analytics are stubbed in OCC, so this is contract-surface parity, not behavior-visible — but the event contract is what future telemetry work will pin against.

### occ157-03 (P3, edge path) — accept-with-persist-error maps to `gate_off`; official maps to `switched` → **RECORDED, NOT FIXED (scope discipline; Leader decision)**

Official byte-exact `Tkt` @238435880 region:

```js
function Tkt({getToolPermissionContext:h,setToolPermissionContext:C,addNotification:L,storageV5:H}){
  let ee=h();
  if(kj(ee)){
    if(cT("auto",ee,C,"auto_default_nudge").ok)
      return Tn("userSettings",{permissions:{defaultMode:"auto"}},void 0,H).catch(c),zV(`[${BF("auto")} on]`),"switched"
  }
  let he=R_t();
  return L({key:"auto-default-nudge-unavailable",kind:"warning",text:he,color:"warning",priority:"high"}),zV(`[${he}]`),"gate_off"
}
```

Official semantics: `gate_off` ⟺ `kj(ctx)` false OR live-switch `cT(...).ok` false. The persist (`Tn(...)`) is fire-and-forget with `.catch(c)` — a persist failure STILL returns `"switched"` (flag set, nudge never reappears, default silently unpersisted). OCC's `trySwitchToAutoDefault()` maps `updateSettingsForSource` `{error}` → `gate_off` (flag NOT set → nudge reappears next launch). Both behaviors are defensible; OCC's is friendlier (retry on next launch) but diverges from official. Not fixed this round: it is neither a P1/P2 regression nor LOW-1/LOW-2, the divergence predates this round (pinned by unit tests since occ115: "write-error→gate_off"), and changing outcome-mapping semantics mid-acceptance-round exceeds the Leader-granted fix scope. **Escalated to Leader via §6 handover.**

## 4. Self-acceptance runs (OCC side, real tmux REPL + `-p` stream-json)

(Filled in as runs complete — see §4.1 nudge surface, §4.2 core trunk.)

### 4.1 Auto-default nudge surface

 TBD

### 4.2 Core trunk spot-checks

 TBD

## 5. occ156 ledger carryover disposition (§3/§5/§7 — no silent drops)

 TBD

## 6. Delivery

 TBD
