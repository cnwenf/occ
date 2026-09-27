# Risk Registry

Accepted and residual risks, tracked per audit/acceptance recommendation so future rounds inherit the trade-offs in writing instead of rediscovering them. Add a row when a fix deliberately leaves a gap open, or when an audit classifies a finding as accepted risk.

| ID | Risk | Severity | Status | Origin |
|---|---|---|---|---|
| RR-001 | Model governance default-path fail-open (`deniedModels` never consulted when resolving the default model) | HIGH → closed; residuals MEDIUM/LOW | Closed 2026-09-27 (OCC-98 #10); residuals accepted | OCC-98 audit + 验收员 manual confirmation |
| RR-002 | Startup-gate block exits without the official `managed_settings_invalid` exit-reason telemetry | LOW | Accepted (PORT-NEXT) | OCC-98 #10 ruling |

## RR-001 — Model governance default-path fail-open

**Original defect (confirmed HIGH, OCC-98 acceptance finding #10).** With a deny-only policy (`deniedModels` set, no `availableModels`/`enforceAvailableModels`) and zero user model config, `enforceDefaultModelAllowlist` (src/utils/model/model.ts) returned early on `!getEnforceAvailableModels()`, `getMainLoopModel()` fell through to the tier default with no deny check, and the API boundary never consulted the deny oracle. The official 2.1.283 binary closes this with a startup gate: `Bn=TH(je); if(Bn!==null) return hx(Bn), await Az({…reason:"managed_settings_invalid"}), $i();` (call site @212235442) — red message on stderr, exit(1).

**Closure (this round).** `enforceManagedModelGovernanceStartupGate` (src/utils/model/modelGovernanceMessages.ts) wired in src/main.tsx immediately after `resolvedInitialModel` — the OCC analogue of the official placement (right after the startup resolver, before the effort-cap/advisor blocks). Covers REPL and `-p`. Reproducers: unit (src/utils/model/__tests__/modelGovernance283.test.ts, "OCC-98 #10 reproducer" describe) + behavioral e2e (test/e2e/version-2.1.283-model-governance-startup-gate.e2e.test.ts, mutation-verified: fails with the gate call removed).

**Residuals (accepted, official-parity unless noted).**

1. **Single enforcement point (MEDIUM).** The deny oracle is consulted at startup (the new gate), inside `isModelAllowed` (deny-beats-allow, modelAllowlist.ts), and in the enforced-default rewrite for a user-specified model (model.ts). It is NOT consulted at the API boundary (query.ts / QueryEngine.ts / claude.ts) — official 2.1.283 has the same structure (no second defense at the wire layer), so a mid-session policy reload that newly denies the running model only takes effect on next start. The `/model`-switch flow's `TH('switch')` message is ported contract-only; its picker wiring remains a staged follow-up (docs/upstream-version-gap-model-governance-283.md §5).
2. **Runtime default resolution is ungated by design (LOW).** `getDefaultMainLoopModel()`/`enforceDefaultModelAllowlist` themselves still do not consult the deny oracle — they are also called from runtime paths (e.g. QueryEngine) where a `process.exit` would deviate from the official shape and kill non-startup callers. The official gates the RESOLVED model once at startup, not the resolver; OCC mirrors that. See the modelGovernance.ts header for the full trade-off note.
3. **`getSmallFastModel()` has no deny check (LOW, official-parity).** The official binary applies the same structure at that site — the haiku-class background model is not governance-checked there either. Documented for parity, not invented divergence.
4. **Exit-reason telemetry missing → see RR-002.**

## RR-002 — `managed_settings_invalid` exit-reason telemetry (PORT-NEXT)

The official gate reports `Az({sessionId, message, reason:"managed_settings_invalid"})` before flushing analytics sinks and exiting. OCC's analytics surface is an empty implementation (stubbed per CLAUDE.md), so the exit-reason leg has nowhere to land; the observable contract (red stderr message + exit 1) is fully wired. Port `Az` when the telemetry surface exists. Ruled PORT-NEXT by the OCC-98 acceptance (not a release blocker).
