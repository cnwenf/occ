import { describe, expect, test } from "bun:test";
import {
  findGoalToRestore,
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

describe("findGoalToRestore", () => {
  const set = (condition: string) => ({
    type: "attachment" as const,
    attachment: { type: "goal_status", met: false, condition, sentinel: true as const },
  });
  const cleared = (condition: string) => ({
    type: "attachment" as const,
    attachment: { type: "goal_status", met: true, condition, sentinel: true as const },
  });
  const userText = (text: string) => ({ message: { content: text } });

  test("restores the condition from the last met:false goal_status marker", () => {
    const messages = [set("make tests pass"), userText("working...")];
    expect(findGoalToRestore(messages)).toBe("make tests pass");
  });

  test("returns null when a met:true marker follows the set", () => {
    const messages = [set("make tests pass"), cleared("make tests pass")];
    expect(findGoalToRestore(messages)).toBe(null);
  });

  test("robust to a condition that literally contains 'Goal cleared:'", () => {
    // The text-scan fallback would be fooled by this; the attachment marker is not.
    const messages = [set("Goal cleared: tricky condition")];
    expect(findGoalToRestore(messages)).toBe("Goal cleared: tricky condition");
  });

  test("falls back to text scan for legacy transcripts without markers", () => {
    const messages = [userText("Goal set: legacy goal")];
    expect(findGoalToRestore(messages)).toBe("legacy goal");
  });

  test("legacy: 'Goal cleared:' text after a set returns null", () => {
    const messages = [userText("Goal set: legacy goal"), userText("Goal cleared: legacy goal")];
    expect(findGoalToRestore(messages)).toBe(null);
  });

  test("returns null when no goal markers are present", () => {
    const messages = [userText("hello world")];
    expect(findGoalToRestore(messages)).toBe(null);
  });

  test("returns null for a failed goal_status attachment (met:false, failed:true)", () => {
    // Mirrors official S1c: met || failed → null. A failed goal must NOT be
    // restored as active on resume.
    const failed = {
      type: "attachment" as const,
      attachment: { type: "goal_status", met: false, failed: true, condition: "impossible goal", sentinel: true as const },
    };
    expect(findGoalToRestore([failed])).toBe(null);
  });

  test("a failed marker after a set marker returns null (not the set condition)", () => {
    const messages = [
      set("make tests pass"),
      { type: "attachment" as const, attachment: { type: "goal_status", met: false, failed: true, condition: "make tests pass", sentinel: true as const } },
    ];
    expect(findGoalToRestore(messages)).toBe(null);
  });
});
