import { describe, expect, test } from "bun:test";
import {
  parseAgentFromJson,
  parseAgentFromMarkdown,
  parseAgentsFromJson,
} from "../loadAgentsDir.js";

/**
 * Claude Code 2.1.271 (Gap-126b): `omitClaudeMd` became settable on custom
 * and plugin agents via markdown frontmatter and `--agents` JSON — "letting
 * custom and plugin subagents run without user, project and local CLAUDE.md
 * files; managed policy files still load". Official pieces ported verbatim:
 *   markdown: `let pe=r.omitClaudeMd,Se=pe==="true"||pe===!0?!0:void 0`
 *             (no invalid-value warning, unlike `background`)
 *   plugin:   `let rt=H.omitClaudeMd,kt=rt==="true"||rt===!0?!0:void 0`
 *   --agents JSON schema: `omitClaudeMd:P().optional()` (boolean)
 *   spread:   `...kt&&{omitClaudeMd:kt}` / `...Se&&{omitClaudeMd:Se}`
 * The enforcement side (runAgent.ts shouldOmitClaudeMd) already existed in
 * OCC for the built-in Explore/Plan agents; this round wires the input chain.
 */

function makeFrontmatter(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "omit-agent", description: "demo agent", ...extra };
}

describe("2.1.271: parseAgentFromMarkdown carries omitClaudeMd", () => {
  test("boolean true lands on the agent definition", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/omit.md",
      "/x/.claude/agents",
      makeFrontmatter({ omitClaudeMd: true }),
      "body",
      "projectSettings",
    );
    expect(agent?.omitClaudeMd).toBe(true);
  });

  test("string 'true' lands on the agent definition", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/omit.md",
      "/x/.claude/agents",
      makeFrontmatter({ omitClaudeMd: "true" }),
      "body",
      "projectSettings",
    );
    expect(agent?.omitClaudeMd).toBe(true);
  });

  test("false / 'false' / invalid values leave the field undefined (silent, no warning)", () => {
    for (const value of [false, "false", "yes", 1, null]) {
      const agent = parseAgentFromMarkdown(
        "/x/.claude/agents/omit.md",
        "/x/.claude/agents",
        makeFrontmatter({ omitClaudeMd: value }),
        "body",
        "projectSettings",
      );
      expect(agent).not.toBeNull();
      expect(agent?.omitClaudeMd).toBeUndefined();
    }
  });

  test("no omitClaudeMd frontmatter leaves the field absent", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/plain.md",
      "/x/.claude/agents",
      makeFrontmatter(),
      "body",
      "projectSettings",
    );
    expect(agent).not.toBeNull();
    expect("omitClaudeMd" in (agent as object)).toBe(false);
  });
});

describe("2.1.271: --agents JSON carries omitClaudeMd", () => {
  const jsonDef = {
    description: "Reviews code",
    prompt: "You are a code reviewer",
    omitClaudeMd: true,
  };

  test("parseAgentFromJson spreads omitClaudeMd onto the definition", () => {
    const agent = parseAgentFromJson("reviewer", jsonDef, "flagSettings");
    expect(agent?.omitClaudeMd).toBe(true);
  });

  test("parseAgentsFromJson (the --agents flag path) carries it through", () => {
    const agents = parseAgentsFromJson({ reviewer: jsonDef }, "flagSettings");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.omitClaudeMd).toBe(true);
  });

  test("omitted / false leaves the field absent", () => {
    const without = parseAgentFromJson(
      "reviewer",
      { description: "d", prompt: "p" },
      "flagSettings",
    );
    expect(without).not.toBeNull();
    expect("omitClaudeMd" in (without as object)).toBe(false);

    const falsy = parseAgentFromJson(
      "reviewer",
      { description: "d", prompt: "p", omitClaudeMd: false },
      "flagSettings",
    );
    expect(falsy).not.toBeNull();
    expect("omitClaudeMd" in (falsy as object)).toBe(false);
  });

  test("non-boolean omitClaudeMd is rejected by the schema (strict boolean, like background)", () => {
    const agent = parseAgentFromJson(
      "reviewer",
      { description: "d", prompt: "p", omitClaudeMd: "true" },
      "flagSettings",
    );
    // z.object().parse throws on type mismatch → parseAgentFromJson returns null
    expect(agent).toBeNull();
  });
});
