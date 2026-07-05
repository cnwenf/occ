import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * /goal command e2e (Docker): command exists, state management works,
 * and a real -p run with /goal set works end-to-end.
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

// 真实模型 e2e：跑 dist/cli.js -p 调用真实模型，需要本地凭证。
// GitHub Actions 上无凭证且 CI=true，自动跳过；本地 CI 未设，正常运行。
describe.skipIf(!!process.env.CI)("/goal real -p run (e2e, real model)", () => {
  test("/goal set + clear works in -p mode", async () => {
    const script = `
const { spawn } = require('child_process');
const child = spawn('bun', [process.env.OCC_ENTRYPOINT || '${REPO_ROOT}/dist/cli.js', '-p', '/goal all tests pass'], {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
child.stdout.on('data', d => stdout += d);
child.on('close', () => {
  console.log(JSON.stringify({ hasGoalSet: stdout.includes('Goal set') }));
});
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasGoalSet).toBe(true);
  }, 30000);
});
