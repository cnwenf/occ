import { describe, expect, test } from "bun:test";
import {
  extractAgentCacheTtl,
  parseAgentFromJson,
  parseAgentFromMarkdown,
} from "../loadAgentsDir.js";

/**
 * Claude Code 2.1.248 (Gap-108b): markdown agent frontmatter may set
 * `experimental.cacheTtl` ("5m" | "1h") to pin the prompt cache TTL for the
 * agent's requests. Official pieces ported verbatim:
 *   uBt — the frontmatter extractor (case-insensitive `cacheTtl` key,
 *         exact-literal value match, everything else silently ignored)
 *   qTt/Tvt — the resolver ladder (covered in
 *         src/services/api/__tests__/prompt-cache-ttl.test.ts)
 * JSON-defined agents deliberately do NOT get cacheTtl — the official only
 * parses it for markdown agents.
 */

function makeFrontmatter(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "ttl-agent", description: "demo agent", ...extra };
}

describe("2.1.248: extractAgentCacheTtl (official uBt)", () => {
  test("accepts the exact literals 5m and 1h", () => {
    expect(
      extractAgentCacheTtl({ experimental: { cacheTtl: "5m" } }),
    ).toBe("5m");
    expect(
      extractAgentCacheTtl({ experimental: { cacheTtl: "1h" } }),
    ).toBe("1h");
  });

  test("matches the cacheTtl key case-insensitively", () => {
    expect(
      extractAgentCacheTtl({ experimental: { CacheTTL: "1h" } }),
    ).toBe("1h");
    expect(
      extractAgentCacheTtl({ experimental: { CACHETTL: "5m" } }),
    ).toBe("5m");
    expect(
      extractAgentCacheTtl({ experimental: { cacheTTL: "1h" } }),
    ).toBe("1h");
  });

  test("ignores values other than the two literals", () => {
    expect(extractAgentCacheTtl({ experimental: { cacheTtl: "2h" } })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: { cacheTtl: "30m" } })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: { cacheTtl: 5 } })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: { cacheTtl: true } })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: { cacheTtl: null } })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: {} })).toBeUndefined();
  });

  test("ignores missing or malformed experimental blocks", () => {
    expect(extractAgentCacheTtl({})).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: null })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: "1h" })).toBeUndefined();
    expect(extractAgentCacheTtl({ experimental: 42 })).toBeUndefined();
  });
});

describe("2.1.248: parseAgentFromMarkdown carries cacheTtl onto the definition", () => {
  test("frontmatter experimental.cacheTtl lands on the agent definition", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/ttl.md",
      "/x/.claude/agents",
      makeFrontmatter({ experimental: { cacheTtl: "1h" } }),
      "body",
      "projectSettings",
    );
    expect(agent?.cacheTtl).toBe("1h");
  });

  test("no cacheTtl frontmatter leaves the field undefined", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/plain.md",
      "/x/.claude/agents",
      makeFrontmatter(),
      "body",
      "projectSettings",
    );
    expect(agent).not.toBeNull();
    expect(agent?.cacheTtl).toBeUndefined();
    expect("cacheTtl" in (agent as object)).toBe(false);
  });

  test("invalid cacheTtl values are silently dropped", () => {
    const agent = parseAgentFromMarkdown(
      "/x/.claude/agents/bad.md",
      "/x/.claude/agents",
      makeFrontmatter({ experimental: { cacheTtl: "2h" } }),
      "body",
      "projectSettings",
    );
    expect(agent).not.toBeNull();
    expect(agent?.cacheTtl).toBeUndefined();
  });
});

describe("2.1.248: JSON-defined agents do NOT get cacheTtl (official fidelity)", () => {
  test("parseAgentFromJson ignores any experimental.cacheTtl-like input", () => {
    const agent = parseAgentFromJson(
      "json-agent",
      {
        description: "demo agent",
        prompt: "body",
        experimental: { cacheTtl: "1h" },
      },
      "userSettings",
    );
    expect(agent).not.toBeNull();
    expect(agent?.cacheTtl).toBeUndefined();
  });
});
