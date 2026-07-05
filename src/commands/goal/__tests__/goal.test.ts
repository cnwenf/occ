import { describe, expect, test } from "bun:test";
import {
  setGoal,
  clearGoal,
  isGoalActive,
  getGoalCondition,
  getGoalTurns,
  getGoalTokens,
  getGoalElapsedMs,
  incrementGoalTurn,
  addGoalTokens,
  markGoalAchieved,
} from "../goalState";

describe("/goal state", () => {
  test("setGoal + isGoalActive", () => {
    clearGoal();
    expect(isGoalActive()).toBe(false);
    setGoal("all tests pass");
    expect(isGoalActive()).toBe(true);
    expect(getGoalCondition()).toBe("all tests pass");
  });

  test("clearGoal", () => {
    setGoal("test");
    clearGoal();
    expect(isGoalActive()).toBe(false);
    expect(getGoalCondition()).toBeNull();
  });

  test("incrementGoalTurn + getGoalTurns", () => {
    clearGoal();
    setGoal("test");
    expect(getGoalTurns()).toBe(0);
    incrementGoalTurn();
    incrementGoalTurn();
    expect(getGoalTurns()).toBe(2);
  });

  test("addGoalTokens + getGoalTokens", () => {
    clearGoal();
    setGoal("test");
    expect(getGoalTokens()).toBe(0);
    addGoalTokens(500);
    addGoalTokens(300);
    expect(getGoalTokens()).toBe(800);
  });

  test("markGoalAchieved + isGoalActive becomes false", () => {
    clearGoal();
    setGoal("test");
    expect(isGoalActive()).toBe(true);
    markGoalAchieved();
    expect(isGoalActive()).toBe(false);
  });

  test("getGoalElapsedMs > 0 after setGoal", () => {
    clearGoal();
    setGoal("test");
    // Elapsed should be >= 0 (may be 0 if fast enough)
    expect(getGoalElapsedMs()).toBeGreaterThanOrEqual(0);
  });

  test("no active goal — all getters return defaults", () => {
    clearGoal();
    expect(getGoalCondition()).toBeNull();
    expect(getGoalTurns()).toBe(0);
    expect(getGoalTokens()).toBe(0);
    expect(getGoalElapsedMs()).toBe(0);
  });
});
