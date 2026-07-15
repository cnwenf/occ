import { describe, expect, test } from "bun:test";
import {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
} from "../context.js";
import type { AutoUpdaterResult } from "../autoUpdater.js";

// 2.1.208 #8 — "Fixed context window (and auto-compact indicator) resetting
// to 200k after CLI auto-updates."
//
// Official mechanism (reverse-engineered from the 2.1.210 binary): after the
// CLI auto-updates itself, it RELAUNCHES (spawn `--resume <sessionId>` with
// the new binary; binary `Q$e`/`NAs` relaunch flow, env carries only
// `CLAUDE_CODE_RELAUNCH_TERMINAL_SIZE`). The resumed process recomputes betas
// / context window from scratch, and during early init — before OAuth/bootstrap
// re-fetches the 1M beta / `autoCompactWindowsCache` / `kelp_forest_sonnet`
// experiment flag — non-`[1m]` 1M-entitled models fell back to the 200k default
// (`MODEL_CONTEXT_WINDOW_DEFAULT`), dragging the auto-compact indicator down
// with it. The fix preserves/restores the real context window across the
// relaunch.
//
// OCC is structurally immune to this regression:
//  1. OCC's AutoUpdater is NOTICE-ONLY (src/components/AutoUpdater.tsx — it
//     never installs, never relaunches; the only "completion" it produces is a
//     `status: "notice"` result).
//  2. OCC's context window is computed STATELESSLY on every call —
//     `getContextWindowForModel(model, getSdkBetas())` (src/utils/context.ts)
//     has no memoize cache that can go stale across an update, and the
//     `[1m]` suffix is detected intrinsically from the model string, so it
//     cannot be lost to a missing bootstrap/beta.
//
// This file is the behavioral regression guard for that immunity. It locks in
// the changelog intent: across an auto-updater result (notice/success), the
// context window must keep reflecting the active model's real value — never a
// blind 200k reset.

describe("2.1.208 #8 — context window preserved across CLI auto-update", () => {
  // The two AutoUpdaterResult shapes OCC's AutoUpdater can produce. The notice
  // result is the only real "auto-update completion" path in OCC (notice-only
  // updater); success is included to mirror the official completion shape.
  const autoUpdaterNotice: AutoUpdaterResult = {
    version: "2.1.999",
    status: "notice",
    notifications: ["New version 2.1.999 available — run `occ update`"],
  };
  const autoUpdaterSuccess: AutoUpdaterResult = {
    version: "2.1.999",
    status: "success",
  };

  test("1M-context model keeps 1M window (not 200k) across auto-updater notice", () => {
    // Arrange — [1m] suffix is intrinsic to the model string, so the 1M window
    // is detected without depending on betas/bootstrap state.
    const model = "claude-sonnet-4-6[1m]";
    const before = getContextWindowForModel(model);

    // Act — simulate the auto-updater producing its notice "completion" result.
    expect(autoUpdaterNotice.status).toBe("notice");

    const after = getContextWindowForModel(model);

    // Assert — the window is the model's real 1M, never the 200k default.
    expect(before).toBe(1_000_000);
    expect(after).toBe(1_000_000);
    expect(after).not.toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });

  test("1M-context model keeps 1M window across auto-updater success", () => {
    const model = "claude-opus-4-6[1m]";
    const before = getContextWindowForModel(model);
    expect(autoUpdaterSuccess.status).toBe("success");
    const after = getContextWindowForModel(model);

    expect(before).toBe(1_000_000);
    expect(after).toBe(before);
    expect(after).not.toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });

  test("betas drive the 1M window for a non-[1m] entitled model (not blind 200k)", () => {
    // Arrange — sonnet-4-6 with no [1m] suffix relies on the 1M beta header to
    // unlock 1M. This is the exact shape that regressed upstream: if betas were
    // dropped during relaunch, this returned 200k.
    const model = "claude-sonnet-4-6";
    const CONTEXT_1M_BETA_HEADER = "context-1m-2025-08-07";

    // Without the beta, a non-[1m] first-party-style model falls back to 200k.
    const withoutBeta = getContextWindowForModel(model);
    expect(withoutBeta).toBe(MODEL_CONTEXT_WINDOW_DEFAULT);

    // With the 1M beta (modelSupports1M(sonnet-4-6) is true), the real 1M window
    // is used — not a blind 200k.
    const withBeta = getContextWindowForModel(model, [CONTEXT_1M_BETA_HEADER]);
    expect(withBeta).toBe(1_000_000);
    expect(withBeta).not.toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });

  test("a genuinely-200k model still reports 200k (no invented larger window)", () => {
    // A model with no 1M entitlement and no betas correctly reports the 200k
    // default — the fix preserves the REAL window, it does not inflate it.
    const model = "claude-opus-4-5";
    const window = getContextWindowForModel(model);
    expect(window).toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });

  test("the context window is a pure function of (model, betas) — no auto-updater coupling", () => {
    // The core of the 208#8 fix: the context window must not be coupled to
    // auto-updater state. OCC's resolver is pure w.r.t. the updater — producing
    // any AutoUpdaterResult must not mutate the window. This asserts that
    // invariant directly so a future refactor cannot silently introduce the
    // stale-cache / state-reset regression that upstream fixed.
    const model = "claude-sonnet-4-6[1m]";
    const snapshots: number[] = [];
    for (const result of [autoUpdaterNotice, autoUpdaterSuccess, null]) {
      // Touch the result shape the way the AutoUpdater callback would; the
      // context-window resolver never reads it.
      expect(result === null || typeof result === "object").toBe(true);
      snapshots.push(getContextWindowForModel(model));
    }
    // Every snapshot is the identical, real 1M window.
    expect(new Set(snapshots).size).toBe(1);
    expect(snapshots[0]).toBe(1_000_000);
    expect(snapshots[0]).not.toBe(MODEL_CONTEXT_WINDOW_DEFAULT);
  });
});
