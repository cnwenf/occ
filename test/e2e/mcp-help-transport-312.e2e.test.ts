import { describe, expect, test } from "bun:test";
import { runOcc } from "./helpers";

/** Collapse whitespace/newlines so wrapped --help lines compare contiguously. */
const norm = (s: string) => s.replace(/\s+/g, " ");

/**
 * MCP subcommand help-text transport alignment (official claude-code 2.1.312).
 *
 * Self-acceptance discovery (OCC-137): two MCP help strings had drifted from
 * the official 2.1.312 binary — a LOW-severity text divergence first noted in
 * docs/upstream-version-gap-occ108.md §5 ("`mcp add --header` / `add-json`
 * 帮助文本写错 transport") and carried (结转) through occ109 without a fix.
 *
 * Both strings below are byte-exact from the official 2.1.312 linux-x64 ELF
 * (`strings -n 8 package/claude`), and OCC's real functionality matches them:
 *   - `mcp add-json` accepts stdio / sse / http (streamable-http alias) / ws
 *     configs (McpServerConfigSchema enum, src/services/mcp/types.ts:26) —
 *     verified live: `occ mcp add-json` stores all four and `mcp list` renders
 *     them as (HTTP)/(SSE)/(WS). So "(stdio, SSE, HTTP, or WebSocket)" is
 *     truthful for OCC, while the old "(stdio or SSE)" understated it.
 *   - `mcp add -H/--header` sets headers for HTTP/SSE servers (the sibling
 *     `--client-id` already reads "OAuth client ID for HTTP/SSE servers");
 *     the old "Set WebSocket headers" was simply wrong.
 *
 * Per aligning-with-official-binary: assert the OFFICIAL behavior (behavioral
 * e2e against the built CLI's --help render), not a source-grep.
 */
describe("mcp help transport text matches official 2.1.312", () => {
  test("mcp add-json --help lists stdio, SSE, HTTP, or WebSocket", async () => {
    const r = await runOcc(["mcp", "add-json", "--help"]);
    expect(r.code).toBe(0);
    const out = norm(r.stdout);
    expect(out).toContain(
      "Add an MCP server (stdio, SSE, HTTP, or WebSocket) with a JSON string",
    );
    // The stale understated string must be gone.
    expect(out).not.toContain("Add an MCP server (stdio or SSE)");
  }, 30_000);

  test("mcp add --help describes -H/--header as HTTP/SSE headers", async () => {
    const r = await runOcc(["mcp", "add", "--help"]);
    expect(r.code).toBe(0);
    const out = norm(r.stdout);
    expect(out).toContain(
      'Set headers for HTTP/SSE servers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    );
    // The wrong "WebSocket headers" wording must be gone.
    expect(out).not.toContain("Set WebSocket headers");
  }, 30_000);
});
