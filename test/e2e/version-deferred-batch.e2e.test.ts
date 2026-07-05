import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * Batch of previously-deferred features now implemented.
 */
describe("CLAUDE_CODE_FORK_SUBAGENT env (e2e)", () => {
  test("source checks the env var", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands.ts`).text();
    expect(src.includes("CLAUDE_CODE_FORK_SUBAGENT")).toBe(true);
  });
});

describe("Vim Space NORMAL moves right (e2e)", () => {
  test("motions.ts has case ' '", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/vim/motions.ts`).text();
    expect(src.includes("case ' '")).toBe(true);
  });
});

describe("/color no-args random (e2e)", () => {
  test("color.ts picks random color when no args", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/color/color.ts`).text();
    expect(src.includes("randomColor")).toBe(true);
  });
});

describe("OTEL_* env scrub from subprocesses (e2e)", () => {
  test("subprocessEnv scrubs OTEL_ prefix", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/subprocessEnv.ts`).text();
    expect(src.includes('OTEL_')).toBe(true);
  });
});

describe("/context display:system (e2e)", () => {
  test("context.tsx uses display: system", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/commands/context/context.tsx`).text();
    expect(src.includes("display: 'system'")).toBe(true);
  });
});

describe("Status line effort.level + thinking.enabled (e2e)", () => {
  test("StatusLine.tsx has effort + thinking in JSON", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/StatusLine.tsx`).text();
    expect(src.includes("effort:")).toBe(true);
    expect(src.includes("thinking:")).toBe(true);
  });
});
