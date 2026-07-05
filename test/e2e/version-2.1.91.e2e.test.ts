import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.91 e2e (Docker): four deterministic, model-independent
 * checks that run the real OCC code in-container.
 *
 *   1. permissions.defaultMode: "auto" validates (schema fix)
 *   2. disableSkillShellExecution strips inline shell syntax
 *   3. MCP _meta["anthropic/maxResultSizeChars"] override caps at 500K
 *   4. multi-line deep-link query (%0A) is accepted, CRLF normalized
 */
async function run(script: string): Promise<any> {
  const result = await $`bun -e ${script}`.quiet();
  return JSON.parse(result.stdout.toString().trim());
}

describe("2.1.91 defaultMode: auto (e2e)", () => {
  test("SettingsSchema accepts permissions.defaultMode: 'auto'", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ permissions: { defaultMode: "auto" } });
console.log(JSON.stringify({ success: r.success }));
`;
    expect((await run(script)).success).toBe(true);
  });
});

describe("2.1.91 disableSkillShellExecution (e2e)", () => {
  test("stripShellExecutionSyntax replaces !\`cmd\` and ```! blocks", async () => {
    const script = `
import { stripShellExecutionSyntax } from "${REPO_ROOT}/src/utils/promptShellExecution.ts";
console.log(JSON.stringify({
  inline: stripShellExecutionSyntax("run !\`echo hi\` now"),
  block: stripShellExecutionSyntax("a\\n\`\`\`!\\necho hi\\n\`\`\`\\nb"),
}));
`;
    const out = await run(script);
    expect(out.inline).toContain("[shell command execution disabled by policy]");
    expect(out.inline).not.toContain("echo hi");
    expect(out.block).toContain("[shell command execution disabled by policy]");
  });
});

describe("2.1.91 MCP maxResultSizeChars override (e2e)", () => {
  test("caps an override at 500K and falls back to default otherwise", async () => {
    const script = `
import { resolveMcpMaxResultSizeChars, MCP_MAX_RESULT_SIZE_CHARS_CEILING } from "${REPO_ROOT}/src/services/mcp/client.ts";
console.log(JSON.stringify({
  ceiling: MCP_MAX_RESULT_SIZE_CHARS_CEILING,
  override: resolveMcpMaxResultSizeChars(200000, 100000),
  capped: resolveMcpMaxResultSizeChars(1_000_000, 100000),
  invalid: resolveMcpMaxResultSizeChars("big", 100000),
  missing: resolveMcpMaxResultSizeChars(undefined, 100000),
}));
`;
    const out = await run(script);
    expect(out.ceiling).toBe(500_000);
    expect(out.override).toBe(200_000);
    expect(out.capped).toBe(500_000);
    expect(out.invalid).toBe(100_000);
    expect(out.missing).toBe(100_000);
  });
});

describe("2.1.91 multi-line deep-link query (e2e)", () => {
  test("accepts %0A and normalizes %0D%0A to LF", async () => {
    const script = `
import { parseDeepLink } from "${REPO_ROOT}/src/utils/deepLink/parseDeepLink.ts";
console.log(JSON.stringify({
  lf: parseDeepLink("claude-cli://open?q=line1%0Aline2").query,
  crlf: parseDeepLink("claude-cli://open?q=line1%0D%0Aline2").query,
  tab: parseDeepLink("claude-cli://open?q=col1%09col2").query,
}));
`;
    const out = await run(script);
    expect(out.lf).toBe("line1\nline2");
    expect(out.crlf).toBe("line1\nline2");
    expect(out.tab).toBe("col1\tcol2");
  });

  test("still rejects NUL (%00) in the query", async () => {
    const script = `
import { parseDeepLink } from "${REPO_ROOT}/src/utils/deepLink/parseDeepLink.ts";
try { parseDeepLink("claude-cli://open?q=hi%00there"); console.log(JSON.stringify({ threw: false })); }
catch { console.log(JSON.stringify({ threw: true })); }
`;
    expect((await run(script)).threw).toBe(true);
  });
});
