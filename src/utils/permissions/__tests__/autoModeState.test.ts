import { describe, expect, test, beforeEach } from "bun:test";
import {
  _resetForTesting,
  getAutoModeFlagCli,
  isAutoModeActive,
  isAutoModeCircuitBroken,
  setAutoModeActive,
  setAutoModeCircuitBroken,
  setAutoModeFlagCli,
} from "../autoModeState.js";

/**
 * Circuit-breaker + auto-mode state (autoModeState.ts). The prior audit flagged
 * the deny + circuit-breaker paths as "source-inspection only" (tests just
 * asserted the source contained the strings). These unit tests exercise the
 * actual state API so the breaker isn't dead code: setting it changes
 * isAutoModeCircuitBroken(), and _resetForTesting clears it.
 *
 * The full behavioral effect (canCycleToAuto → false when broken) requires a
 * ToolPermissionContext with isAutoModeAvailable wired to the breaker; that path
 * is covered by the e2e auto-mode suite where feasible. Here we verify the
 * state transitions themselves.
 */
describe("autoModeState (circuit breaker + flags)", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  test("circuit breaker defaults to not broken", () => {
    expect(isAutoModeCircuitBroken()).toBe(false);
  });

  test("setAutoModeCircuitBroken(true) trips the breaker", () => {
    setAutoModeCircuitBroken(true);
    expect(isAutoModeCircuitBroken()).toBe(true);
  });

  test("breaker can be reset (recovered)", () => {
    setAutoModeCircuitBroken(true);
    expect(isAutoModeCircuitBroken()).toBe(true);
    setAutoModeCircuitBroken(false);
    expect(isAutoModeCircuitBroken()).toBe(false);
  });

  test("_resetForTesting clears the breaker", () => {
    setAutoModeCircuitBroken(true);
    _resetForTesting();
    expect(isAutoModeCircuitBroken()).toBe(false);
  });

  test("autoModeActive flag round-trips", () => {
    setAutoModeActive(true);
    expect(isAutoModeActive()).toBe(true);
    setAutoModeActive(false);
    expect(isAutoModeActive()).toBe(false);
  });

  test("autoModeFlagCli round-trips + reset clears it", () => {
    setAutoModeFlagCli(true);
    expect(getAutoModeFlagCli()).toBe(true);
    _resetForTesting();
    expect(getAutoModeFlagCli()).toBe(false);
    expect(isAutoModeActive()).toBe(false);
  });
});
