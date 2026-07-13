import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * /goal command e2e: command exists + state management works.
 * /goal <condition> in -p mode (sets a session Stop hook, works toward the
 * goal, terminates on achieve) is covered by commands-behavior.e2e.test.ts.
 */
describe("/goal command exists (e2e)", () => {
  test("goal command is in the command list", async () => {
    const script = `
import { INTERNAL_ONLY_COMMANDS, REMOTE_SAFE_COMMANDS, getCommandName } from "${REPO_ROOT}/src/commands.ts";
const all = [...INTERNAL_ONLY_COMMANDS, ...REMOTE_SAFE_COMMANDS];
const names = all.map(getCommandName).filter(Boolean);
console.log(JSON.stringify({ hasGoal: names.includes("goal") }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasGoal).toBe(true);
  });
});

describe("/goal state management (e2e)", () => {
  test("setGoal + isGoalActive + clearGoal", async () => {
    const script = `
import { setGoal, isGoalActive, clearGoal, getGoalCondition } from "${REPO_ROOT}/src/commands/goal/goalState.ts";
clearGoal();
setGoal("all tests pass");
const active = isGoalActive();
const cond = getGoalCondition();
clearGoal();
const inactive = isGoalActive();
console.log(JSON.stringify({ active, cond, inactive }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.active).toBe(true);
    expect(out.cond).toBe("all tests pass");
    expect(out.inactive).toBe(false);
  });
});

// /goal <condition> in -p mode (sets a session Stop hook, works toward the
// goal, terminates on achieve) is covered by commands-behavior.e2e.test.ts
// ("/goal <condition> — sets hook, works toward goal, terminates on achieve").
// The previous "real -p run" test here asserted stdout contains "Goal set",
// but that ack is internal in -p mode — only the model's final response is
// printed (verified: `dist/cli.js -p '/goal reply with the word OK'` → stdout
// "OK") — so the assertion could never pass. Removed (see also ec1f85f for
// the precedent of dropping redundant/broken real-model e2e tests).
