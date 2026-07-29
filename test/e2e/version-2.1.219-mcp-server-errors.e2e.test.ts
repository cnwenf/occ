import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.219 `mcp_server_errors` in the stream-json init event (e2e).
 *
 * Binary evidence (2.1.220 linux-x64 ELF, tAr init-event builder at offset
 * ~260839739):
 *   let t=new Set(e.mcpClients.map((o)=>o.name)),
 *       r=e.mcpServerErrors.filter((o)=>!t.has(o.name));
 *   ...r.length>0&&{mcp_server_errors:r.map((o)=>({...o}))}
 *
 * The init event includes `mcp_server_errors: [{name,type,message}, ...]` ONLY
 * when the filtered error array `r` is non-empty. Errors whose `name` already
 * appears in `mcpClients` are filtered out. The key is OMITTED when empty.
 *
 * Zod schema (offset 267590183):
 *   mcp_server_errors: v.array(v.object({name:v.string(),type:v.string(),
 *     message:v.string()})).optional()
 */
describe("2.1.219 mcp_server_errors in init event (e2e)", () => {
  // Helper: run buildSystemInitMessage in a subprocess with MACRO polyfilled.
  // systemInit.ts uses MACRO.VERSION (build-time macro) which is only defined
  // via bun:bundle or the cli.tsx dev polyfill — bun -e has neither.
  async function runBuild(inputs: string): Promise<Record<string, unknown>> {
    const script = `
globalThis.MACRO = { VERSION: "2.1.220" };
const { buildSystemInitMessage } = await import("${REPO_ROOT}/src/utils/messages/systemInit.ts");
const msg = buildSystemInitMessage(${inputs});
console.log(JSON.stringify(msg));
`;
    return JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
  }

  const baseInputs = (overrides: string): string =>
    `{
      tools: [{ name: "Bash" }],
      mcpClients: [{ name: "good-server", type: "stdio" }],
      mcpServerErrors: ${overrides},
      model: "claude-sonnet-4-20250514",
      permissionMode: "default",
      commands: [{ name: "help" }],
      agents: [{ agentType: "general-purpose" }],
      skills: [],
      plugins: [],
      fastMode: false,
    }`;

  test("init event includes mcp_server_errors when non-empty (after filtering)", async () => {
    const out = await runBuild(
      baseInputs(
        `[
          { name: "bad-server", type: "stdio", message: "spawn ENOENT" },
          { name: "broken-http", type: "http", message: "HTTP 503" },
        ]`,
      ),
    );

    expect(out.mcp_server_errors).toBeDefined();
    expect(out.mcp_server_errors).toHaveLength(2);
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[0].name).toBe("bad-server");
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[0].type).toBe("stdio");
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[0].message).toBe("spawn ENOENT");
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[1].name).toBe("broken-http");
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[1].message).toBe("HTTP 503");
  });

  test("mcp_server_errors key is OMITTED when array is empty", async () => {
    const out = await runBuild(baseInputs(`[]`));

    expect(out.mcp_server_errors).toBeUndefined();
    expect("mcp_server_errors" in out).toBe(false);
  });

  test("mcp_server_errors filters out errors for servers already in mcpClients", async () => {
    const out = await runBuild(`{
      tools: [],
      mcpClients: [
        { name: "connected-server", type: "stdio" },
        { name: "also-connected", type: "http" },
      ],
      mcpServerErrors: [
        { name: "connected-server", type: "stdio", message: "should be filtered" },
        { name: "unconnected-fail", type: "sse", message: "ECONNREFUSED" },
      ],
      model: "claude-sonnet-4-20250514",
      permissionMode: "default",
      commands: [],
      agents: [],
      skills: [],
      plugins: [],
      fastMode: false,
    }`);

    // The error for "connected-server" is filtered out (name is in mcpClients)
    expect(out.mcp_server_errors).toBeDefined();
    expect(out.mcp_server_errors).toHaveLength(1);
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[0].name).toBe("unconnected-fail");
    expect((out.mcp_server_errors as Array<Record<string, unknown>>)[0].message).toBe("ECONNREFUSED");
  });

  test("mcp_server_errors key is OMITTED when all errors are filtered out", async () => {
    const out = await runBuild(`{
      tools: [],
      mcpClients: [{ name: "connected-server", type: "stdio" }],
      mcpServerErrors: [
        { name: "connected-server", type: "stdio", message: "filtered out" },
      ],
      model: "claude-sonnet-4-20250514",
      permissionMode: "default",
      commands: [],
      agents: [],
      skills: [],
      plugins: [],
      fastMode: false,
    }`);

    expect(out.mcp_server_errors).toBeUndefined();
  });

  test("mcp_server_errors element shape is exactly {name, type, message}", async () => {
    const out = await runBuild(`{
      tools: [],
      mcpClients: [],
      mcpServerErrors: [
        { name: "err", type: "stdio", message: "boom" },
      ],
      model: "claude-sonnet-4-20250514",
      permissionMode: "default",
      commands: [],
      agents: [],
      skills: [],
      plugins: [],
      fastMode: false,
    }`);

    expect(out.mcp_server_errors).toHaveLength(1);
    const element = (out.mcp_server_errors as Array<Record<string, unknown>>)[0];
    const keys = Object.keys(element).sort();
    expect(keys).toEqual(["message", "name", "type"]);
    expect(element.name).toBe("err");
    expect(element.type).toBe("stdio");
    expect(element.message).toBe("boom");
  });
});
