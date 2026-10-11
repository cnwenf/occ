import { afterEach, describe, expect, test } from "bun:test";
import {
  ENV_WINDOW_KEY,
  isAutoCompactWindowCeiling,
  resolveAutoCompactWindow,
  wrapAutoCompactWindowCeiling,
} from "../../../utils/autoCompactWindow.js";
import { parseAutoCompactWindowFromFrontmatter } from "../../../utils/frontmatterParser.js";
import { computeSubagentAutoCompactWindow, FORK_AGENT } from "../forkSubagent.js";
import {
  type CustomAgentDefinition,
  parseAgentFromJson,
  parseAgentFromMarkdown,
  parseAgentsFromJson,
} from "../loadAgentsDir.js";

/**
 * Claude Code 2.1.296 (OCC-154 #002): `autoCompactWindow` became settable on
 * subagent frontmatter and `--agents` definitions — "so a subagent can
 * auto-compact earlier than the main conversation's window". Official pieces
 * ported verbatim (v296 ELF offsets):
 *   bounds @207848454:            `b0=1e5, TN=1e6`
 *   frontmatter parser @211911797: `function ihr(e){let n=h0n(e);
 *                                   return n!==void 0&&n>=b0&&n<=TN?n:void 0}`
 *   markdown warning @217695969:   `Agent file ${e} has invalid
 *                                   autoCompactWindow '${ut}'. Must be an
 *                                   integer from ${b0} to ${TN}.` {level:"warn"}
 *   plugin warning @217649573:     `Plugin agent file ${e} has invalid
 *                                   autoCompactWindow '${Cn}'. Must be an
 *                                   integer from ${b0} to ${TN}.`
 *   --agents schema @217449940:    `autoCompactWindow:E().int().min(b0)
 *                                   .max(TN).optional()` (between maxTurns
 *                                   and skills)
 *   ceiling predicate:             `nIt(e){return typeof e==="object"&&
 *                                   "ceiling"in e}`
 *   ceiling wrapper @223498818:    `function WJn(e,s){let n=e;
 *                                   return s===void 0?n:{ceiling:s,inner:n}}`
 *   resolver ceiling branch (iv):  resolve inner; env or inner.window<=ceiling
 *                                   → inner; else {window:min(ctx,ceiling),
 *                                   configured:ceiling, source:"settings"}
 *   spawn wiring @223555765:       `autoCompactWindow: e.agentType===Q$&&Xa(e)
 *                                   ? n.options.autoCompactWindow
 *                                   : WJn(n.options.autoCompactWindow,
 *                                         e.autoCompactWindow)`
 *                                   (Q$="fork" @211657790, Xa=isBuiltInAgent
 *                                   — resolved via chunk export alias block
 *                                   @243898894 `Xa as isBuiltInAgent`)
 *   inProcessRunner @242303606:    threshold re-wraps with the teammate's
 *                                   agentDefinition.autoCompactWindow (NO
 *                                   fork check at this site)
 */

function makeFrontmatter(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "acw-agent", description: "demo agent", ...extra };
}

function makeCustomAgent(
  extra: Partial<CustomAgentDefinition> = {},
): CustomAgentDefinition {
  return {
    agentType: "custom-agent",
    whenToUse: "demo",
    getSystemPrompt: () => "prompt",
    source: "projectSettings",
    ...extra,
  };
}

afterEach(() => {
  delete process.env[ENV_WINDOW_KEY];
});

describe("2.1.296: parseAutoCompactWindowFromFrontmatter (official ihr)", () => {
  test("accepts integers within [1e5, 1e6] inclusive", () => {
    expect(parseAutoCompactWindowFromFrontmatter(200000)).toBe(200000);
    expect(parseAutoCompactWindowFromFrontmatter("250000")).toBe(250000);
    expect(parseAutoCompactWindowFromFrontmatter(100000)).toBe(100000);
    expect(parseAutoCompactWindowFromFrontmatter(1000000)).toBe(1000000);
  });

  test("rejects out-of-range, non-integer, and non-numeric values", () => {
    expect(parseAutoCompactWindowFromFrontmatter(99999)).toBeUndefined();
    expect(parseAutoCompactWindowFromFrontmatter(1000001)).toBeUndefined();
    expect(parseAutoCompactWindowFromFrontmatter("abc")).toBeUndefined();
    expect(parseAutoCompactWindowFromFrontmatter(150000.5)).toBeUndefined();
    expect(parseAutoCompactWindowFromFrontmatter(undefined)).toBeUndefined();
    expect(parseAutoCompactWindowFromFrontmatter(null)).toBeUndefined();
  });
});

describe("2.1.296: ceiling wrapper + predicate (official WJn / nIt)", () => {
  test("wrap is identity when ceiling is undefined", () => {
    const inherited = { default: 500000, byModel: {} };
    expect(wrapAutoCompactWindowCeiling(inherited, undefined)).toBe(inherited);
    expect(wrapAutoCompactWindowCeiling(undefined, undefined)).toBeUndefined();
  });

  test("wrap produces {ceiling, inner} preserving the inherited value", () => {
    expect(wrapAutoCompactWindowCeiling(undefined, 300000)).toEqual({
      ceiling: 300000,
      inner: undefined,
    });
    expect(wrapAutoCompactWindowCeiling(800000, 300000)).toEqual({
      ceiling: 300000,
      inner: 800000,
    });
  });

  test("predicate matches only the ceiling shape", () => {
    expect(isAutoCompactWindowCeiling({ ceiling: 1, inner: undefined })).toBe(
      true,
    );
    expect(isAutoCompactWindowCeiling({ default: undefined, byModel: {} })).toBe(
      false,
    );
    expect(isAutoCompactWindowCeiling(500000)).toBe(false);
    expect(isAutoCompactWindowCeiling(undefined)).toBe(false);
  });
});

describe("2.1.296: resolveAutoCompactWindow ceiling branch (official iv)", () => {
  const MODEL = "claude-sonnet-5";

  test("caps a larger inherited window to the ceiling", () => {
    const override = wrapAutoCompactWindowCeiling(
      { default: 800000, byModel: {} },
      300000,
    );
    expect(resolveAutoCompactWindow(MODEL, 1_000_000, override)).toEqual({
      window: 300000,
      configured: 300000,
      source: "settings",
    });
  });

  test("passes the inner result through when already at or below ceiling", () => {
    const override = wrapAutoCompactWindowCeiling(
      { default: 200000, byModel: {} },
      300000,
    );
    expect(resolveAutoCompactWindow(MODEL, 1_000_000, override)).toEqual({
      window: 200000,
      configured: 200000,
      source: "settings",
    });
  });

  test("caps the auto (full-context) window when ceiling is below it", () => {
    const override = wrapAutoCompactWindowCeiling(undefined, 200000);
    expect(resolveAutoCompactWindow(MODEL, 250000, override)).toEqual({
      window: 200000,
      configured: 200000,
      source: "settings",
    });
  });

  test("env override is exempt from the ceiling (official: source==='env' → inner)", () => {
    process.env[ENV_WINDOW_KEY] = "150000";
    const override = wrapAutoCompactWindowCeiling(
      { default: 800000, byModel: {} },
      100000,
    );
    expect(resolveAutoCompactWindow(MODEL, 1_000_000, override)).toEqual({
      window: 150000,
      configured: 150000,
      source: "env",
    });
  });

  test("nested ceilings: the tighter one wins regardless of wrap order", () => {
    const tightInner = wrapAutoCompactWindowCeiling(
      wrapAutoCompactWindowCeiling({ default: 800000, byModel: {} }, 300000),
      500000,
    );
    expect(resolveAutoCompactWindow(MODEL, 1_000_000, tightInner)).toEqual({
      window: 300000,
      configured: 300000,
      source: "settings",
    });
    const tightOuter = wrapAutoCompactWindowCeiling(
      wrapAutoCompactWindowCeiling({ default: 800000, byModel: {} }, 500000),
      300000,
    );
    expect(resolveAutoCompactWindow(MODEL, 1_000_000, tightOuter)).toEqual({
      window: 300000,
      configured: 300000,
      source: "settings",
    });
  });
});

describe("2.1.296: parseAgentFromMarkdown carries autoCompactWindow", () => {
  test("valid integer lands on the agent definition", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/acw.md",
      "/x/.claude/agents",
      makeFrontmatter({ autoCompactWindow: 200000 }),
      "body",
      "projectSettings",
    );
    expect(agent?.autoCompactWindow).toBe(200000);
  });

  test("numeric string lands on the agent definition", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/acw.md",
      "/x/.claude/agents",
      makeFrontmatter({ autoCompactWindow: "250000" }),
      "body",
      "projectSettings",
    );
    expect(agent?.autoCompactWindow).toBe(250000);
  });

  test("invalid values leave the field undefined (agent still parses, warning logged)", () => {
    for (const value of ["abc", 50, 2000000, 150000.5, null]) {
      const agent = parseAgentFromMarkdown(
        "/x/.claude/agents/acw.md",
        "/x/.claude/agents",
        makeFrontmatter({ autoCompactWindow: value }),
        "body",
        "projectSettings",
      );
      expect(agent).not.toBeNull();
      expect(agent?.autoCompactWindow).toBeUndefined();
    }
  });

  test("absent key leaves the field undefined", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/acw.md",
      "/x/.claude/agents",
      makeFrontmatter(),
      "body",
      "projectSettings",
    );
    expect(agent?.autoCompactWindow).toBeUndefined();
  });
});

describe("2.1.296: --agents JSON carries autoCompactWindow", () => {
  test("parseAgentFromJson keeps an in-range integer", () => {
    const agent = parseAgentFromJson("acw", {
      description: "demo",
      prompt: "prompt",
      autoCompactWindow: 200000,
    });
    expect(agent?.autoCompactWindow).toBe(200000);
  });

  test("parseAgentFromJson rejects out-of-range values (zod min/max)", () => {
    expect(
      parseAgentFromJson("acw", {
        description: "demo",
        prompt: "prompt",
        autoCompactWindow: 50,
      }),
    ).toBeNull();
    expect(
      parseAgentFromJson("acw", {
        description: "demo",
        prompt: "prompt",
        autoCompactWindow: 2000000,
      }),
    ).toBeNull();
  });

  test("parseAgentsFromJson accepts in-range and drops the record on out-of-range", () => {
    const good = parseAgentsFromJson({
      acw: { description: "demo", prompt: "p", autoCompactWindow: 300000 },
    });
    expect(good).toHaveLength(1);
    expect(good[0]?.autoCompactWindow).toBe(300000);

    const bad = parseAgentsFromJson({
      acw: { description: "demo", prompt: "p", autoCompactWindow: 1 },
    });
    expect(bad).toHaveLength(0);
  });
});

describe("2.1.296: spawn wiring (official Hn site, fork passthrough)", () => {
  test("built-in fork agent passes the inherited override through untouched", () => {
    const inherited = { default: 500000, byModel: {} };
    expect(computeSubagentAutoCompactWindow(FORK_AGENT, inherited)).toBe(
      inherited,
    );
    expect(computeSubagentAutoCompactWindow(FORK_AGENT, undefined)).toBe(
      undefined,
    );
  });

  test("custom agent wraps its autoCompactWindow as a ceiling", () => {
    const agent = makeCustomAgent({ autoCompactWindow: 300000 });
    expect(computeSubagentAutoCompactWindow(agent, undefined)).toEqual({
      ceiling: 300000,
      inner: undefined,
    });
    expect(computeSubagentAutoCompactWindow(agent, 800000)).toEqual({
      ceiling: 300000,
      inner: 800000,
    });
  });

  test("custom agent without autoCompactWindow passes inherited through", () => {
    const inherited = { default: 500000, byModel: {} };
    expect(computeSubagentAutoCompactWindow(makeCustomAgent(), inherited)).toBe(
      inherited,
    );
  });

  test("non-fork built-in agents go through the wrap path", () => {
    const builtIn = {
      agentType: "Explore",
      whenToUse: "demo",
      getSystemPrompt: () => "prompt",
      source: "built-in" as const,
      baseDir: "built-in" as const,
      autoCompactWindow: 400000,
    };
    expect(computeSubagentAutoCompactWindow(builtIn, undefined)).toEqual({
      ceiling: 400000,
      inner: undefined,
    });
  });
});
