import { describe, expect, test } from "bun:test";
import { parseAgentFromMarkdown } from "../loadAgentsDir.js";

/**
 * Claude Code 2.1.218: "Changed agent markdown files to reject agent names
 * containing `:`, which is reserved for plugin namespacing."
 *
 * Red: before the fix, an agent whose frontmatter `name` contains `:` would
 * load fine, colliding with the plugin-namespacing convention
 * (`plugin:agent`). It must now be rejected.
 */

function makeFrontmatter(name: string): Record<string, unknown> {
  return { name, description: "demo agent" };
}

describe("2.1.218: agent name rejects `:` (reserved for plugin namespacing)", () => {
  test("name with `:` is rejected (returns null)", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/bad.md",
      "/x/.claude/agents",
      makeFrontmatter("plugin:agent"),
      "body",
      "projectSettings",
    );
    expect(agent).toBeNull();
  });

  test("name with multiple `:` is rejected", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/bad.md",
      "/x/.claude/agents",
      makeFrontmatter("a:b:c"),
      "body",
      "projectSettings",
    );
    expect(agent).toBeNull();
  });

  test("plain name without `:` still loads", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/good.md",
      "/x/.claude/agents",
      makeFrontmatter("reviewer"),
      "body",
      "projectSettings",
    );
    expect(agent).not.toBeNull();
    // agentType/name is the frontmatter name
    const name = (agent as { agentType?: string }).agentType;
    expect(name).toBe("reviewer");
  });
});
