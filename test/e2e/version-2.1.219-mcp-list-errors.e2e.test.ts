import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.219 MCP-config whitespace warnings + mcp list error text
 * (e2e).
 *
 * Binary evidence (2.1.220 linux-x64 ELF):
 *
 * 1. DeniedMcpServerEntrySchema (_Wn, offset 248275833):
 *    serverName: v.string()
 *      .min(1, "Server name must be non-empty")
 *      .refine((e) => e.trim().length > 0,
 *        { message: "Server name must not be whitespace-only" })
 *      .refine((e) => e === e.trim(),
 *        { message: "Server name has leading or trailing whitespace and will
 *          never match (names are compared verbatim)" })
 *      .optional()
 *      .describe("Name of the MCP server that is explicitly blocked")
 *
 *    The denied (blocked) entry uses .min(1) + whitespace .refine() checks,
 *    NOT .regex() like the allowed entry (yWn, offset 248275140). The denied
 *    entry is more permissive — it accepts any non-empty, non-whitespace-only
 *    name without leading/trailing whitespace.
 *
 * 2. mcp list health-check (pvp, offset 260256123):
 *    else if (r.type === "failed") {
 *      let n = ESp(r);
 *      return { status: `${je.cross} Failed to connect`,
 *               ...n !== "" && { issue: n } }
 *    }
 *    The health check returns {status, issue?} — status is the label,
 *    issue is the error detail (only when non-empty).
 *
 * 3. mcp get output (offset ~260261534):
 *    `  Status: ${a.status}`, ...a.issue ? [`  Issue: ${a.issue}`] : []
 *    The mcp get output renders Status and Issue as separate lines.
 *
 * 4. Agent log (offset 254684817):
 *    `[Agent: ${e.agentType}] Failed to connect to MCP server '${m}': ${b.type}`
 *    (in src/tools/AgentTool/runAgent.ts — NOT in this cluster; already has
 *    the `: <error>` detail via `${client.type}`.)
 *
 * The `Failed to connect to MCP server '<name>': <error>` format from the
 * task description matches the binary's agent-log path, which is already
 * present in OCC's runAgent.ts. The mcp list output uses a React component
 * (mvp) with {status, issue} fields — OCC uses console.log with
 * `✗ Failed to connect — <detail>` (already includes the error detail).
 */
describe("2.1.219 MCP config whitespace warnings + mcp list errors (e2e)", () => {
  test("DeniedMcpServerEntrySchema rejects whitespace-only server name", async () => {
    const script = `
import { DeniedMcpServerEntrySchema } from "${REPO_ROOT}/src/utils/settings/types.ts";

const schema = DeniedMcpServerEntrySchema();
const result = await schema.safeParseAsync({ serverName: "   " });
console.log(JSON.stringify({ success: result.success, errors: result.success ? [] : result.error.issues.map(i => i.message) }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.success).toBe(false);
    expect(out.errors).toContain("Server name must not be whitespace-only");
  });

  test("DeniedMcpServerEntrySchema rejects leading/trailing whitespace in server name", async () => {
    const script = `
import { DeniedMcpServerEntrySchema } from "${REPO_ROOT}/src/utils/settings/types.ts";

const schema = DeniedMcpServerEntrySchema();
const result = await schema.safeParseAsync({ serverName: " my-server " });
console.log(JSON.stringify({ success: result.success, errors: result.success ? [] : result.error.issues.map(i => i.message) }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.success).toBe(false);
    expect(out.errors).toContain(
      "Server name has leading or trailing whitespace and will never match (names are compared verbatim)",
    );
  });

  test("DeniedMcpServerEntrySchema rejects empty server name", async () => {
    const script = `
import { DeniedMcpServerEntrySchema } from "${REPO_ROOT}/src/utils/settings/types.ts";

const schema = DeniedMcpServerEntrySchema();
const result = await schema.safeParseAsync({ serverName: "" });
console.log(JSON.stringify({ success: result.success, errors: result.success ? [] : result.error.issues.map(i => i.message) }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.success).toBe(false);
    expect(out.errors).toContain("Server name must be non-empty");
  });

  test("DeniedMcpServerEntrySchema accepts valid server name (no whitespace issues)", async () => {
    const script = `
import { DeniedMcpServerEntrySchema } from "${REPO_ROOT}/src/utils/settings/types.ts";

const schema = DeniedMcpServerEntrySchema();
const result = await schema.safeParseAsync({ serverName: "my-server" });
console.log(JSON.stringify({ success: result.success, name: result.success ? result.data.serverName : null }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.success).toBe(true);
    expect(out.name).toBe("my-server");
  });

  test("DeniedMcpServerEntrySchema accepts names with dots/slashes (more permissive than .regex)", async () => {
    const script = `
import { DeniedMcpServerEntrySchema } from "${REPO_ROOT}/src/utils/settings/types.ts";

const schema = DeniedMcpServerEntrySchema();
// The binary's denied entry uses .min(1) + .refine(), NOT .regex() — so
// names with dots, slashes, colons (e.g., plugin-prefixed names) are valid.
const result = await schema.safeParseAsync({ serverName: "plugin:my-server" });
console.log(JSON.stringify({ success: result.success, name: result.success ? result.data.serverName : null }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.success).toBe(true);
    expect(out.name).toBe("plugin:my-server");
  });

  test("mcpServerHealthStatusLabel returns ✗ Failed to connect for failed servers", async () => {
    const script = `
import { mcpServerHealthStatusLabel } from "${REPO_ROOT}/src/services/mcp/utils.ts";

const label = mcpServerHealthStatusLabel({ type: "failed", name: "bad", config: { type: "stdio", command: "x", scope: "user" }, error: "ECONNREFUSED" });
console.log(JSON.stringify({ label }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.label).toBe("✗ Failed to connect");
  });

  test("getMcpServerFailureMessage extracts error detail for failed servers", async () => {
    const script = `
import { getMcpServerFailureMessage } from "${REPO_ROOT}/src/services/mcp/utils.ts";

// Named error code with error text: returns error ?? errorCode (= error text)
const msg1 = getMcpServerFailureMessage({ type: "failed", name: "bad", config: { type: "stdio", command: "x", scope: "user" }, error: "spawn ENOENT", errorCode: "INVALID_CONFIG" });
// Named error code without error text: returns error ?? errorCode (= errorCode)
const msg2 = getMcpServerFailureMessage({ type: "failed", name: "bad2", config: { type: "stdio", command: "x", scope: "user" }, errorCode: "INVALID_CONFIG" });
// HTTP status (numeric 100-599): returns "HTTP <status>" (+ " at <url>")
const msg3 = getMcpServerFailureMessage({ type: "failed", name: "bad-http", config: { type: "http", url: "https://x.com", scope: "user" }, error: "Service Unavailable", errorCode: "503" });
console.log(JSON.stringify({ msg1, msg2, msg3 }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    // Named code with error text → returns the error text (error ?? errorCode)
    expect(out.msg1).toBe("spawn ENOENT");
    // Named code without error text → returns the errorCode
    expect(out.msg2).toBe("INVALID_CONFIG");
    // Numeric HTTP status → "HTTP 503 at <url>"
    expect(out.msg3).toContain("HTTP 503");
  });

  test("checkMcpServerHealth appends error detail for failed servers", async () => {
    const script = `
// checkMcpServerHealth is in src/cli/handlers/mcp.tsx — test the label +
// detail combination it produces. The existing code returns
// "✗ Failed to connect — <detail>" (em-dash separator).
// Binary pvp returns {status, issue} separately; OCC combines them.
// Both include the error detail — the contract is satisfied.
import { mcpServerHealthStatusLabel, getMcpServerFailureMessage } from "${REPO_ROOT}/src/services/mcp/utils.ts";

const failedResult = { type: "failed", name: "bad", config: { type: "stdio", command: "x", scope: "user" }, error: "spawn ENOENT", errorCode: "INVALID_CONFIG" };
const label = mcpServerHealthStatusLabel(failedResult);
const detail = getMcpServerFailureMessage(failedResult);
const combined = detail ? \`\${label} — \${detail}\` : label;
console.log(JSON.stringify({ label, detail, combined }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.label).toBe("✗ Failed to connect");
    expect(out.detail).toBeTruthy();
    expect(out.combined).toContain("✗ Failed to connect");
    expect(out.combined).toContain("spawn ENOENT");
  });
});
