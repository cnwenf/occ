import { afterEach, describe, expect, test } from "bun:test";
import { subprocessEnv } from "../subprocessEnv";

/**
 * claude-code 2.1.120: AI_AGENT env for subprocesses + ${CLAUDE_EFFORT} in skills.
 */
const SAVED = process.env.AI_AGENT;
afterEach(() => {
  if (SAVED === undefined) delete process.env.AI_AGENT;
  else process.env.AI_AGENT = SAVED;
});

describe("2.1.120 AI_AGENT env", () => {
  test("subprocessEnv sets AI_AGENT when unset", () => {
    delete process.env.AI_AGENT;
    const env = subprocessEnv();
    expect(env.AI_AGENT).toBe("Claude Code");
  });

  test("subprocessEnv respects a user-set AI_AGENT", () => {
    process.env.AI_AGENT = "MyCustomAgent";
    const env = subprocessEnv();
    expect(env.AI_AGENT).toBe("MyCustomAgent");
  });
});
