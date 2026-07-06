import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 e2e: ReadMcpResourceDirTool (MCP resource directory
 * reader) exists and is registered. Matches the binary:
 *   tZ="ReadMcpResourceDirTool", aliases:["ReadMcpResourceDir"],
 *   searchHint:"list the children of an MCP directory resource",
 *   method:"resources/directory/read", subdir mimeType "inode/directory".
 */
describe("2.1.200 ReadMcpResourceDirTool (e2e)", () => {
  const TOOL = `${REPO_ROOT}/src/tools/ReadMcpResourceDirTool/ReadMcpResourceDirTool.ts`;

  test("tool has the binary's name, alias, searchHint, and method", async () => {
    const script = `
const src = await Bun.file("${TOOL}").text();
const prompt = await Bun.file("${REPO_ROOT}/src/tools/ReadMcpResourceDirTool/prompt.ts").text();
console.log(JSON.stringify({
  nameConst: src.includes("READ_MCP_RESOURCE_DIR_TOOL_NAME"),
  nameLiteral: prompt.includes("'ReadMcpResourceDirTool'"),
  alias: src.includes("'ReadMcpResourceDir'"),
  searchHint: src.includes("list the children of an MCP directory resource"),
  method: src.includes("resources/directory/read"),
  inodeDir: prompt.includes("inode/directory"),
  shouldDefer: src.includes("shouldDefer: true"),
  maxResult: src.includes("100_000"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.nameConst).toBe(true);
    expect(out.nameLiteral).toBe(true);
    expect(out.alias).toBe(true);
    expect(out.searchHint).toBe(true);
    expect(out.method).toBe(true);
    expect(out.inodeDir).toBe(true);
    expect(out.shouldDefer).toBe(true);
    expect(out.maxResult).toBe(true);
  });

  test("gated behind tengu_mcp_skills flag + directoryRead capability", async () => {
    const script = `
const src = await Bun.file("${TOOL}").text();
console.log(JSON.stringify({
  flag: src.includes("tengu_mcp_skills"),
  notEnabled: src.includes("Directory listing is not enabled in this build."),
  capability: src.includes("io.modelcontextprotocol/skills"),
  directoryRead: src.includes("directoryRead"),
  notADirectory: src.includes("Not a directory resource"),
  fallbackHint: src.includes("use ReadMcpResource instead"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.flag).toBe(true);
    expect(out.notEnabled).toBe(true);
    expect(out.capability).toBe(true);
    expect(out.directoryRead).toBe(true);
    expect(out.notADirectory).toBe(true);
    expect(out.fallbackHint).toBe(true);
  });

  test("tool is registered in tools.ts and surfaced via mcp/client.ts", async () => {
    const script = `
const tools = await Bun.file("${REPO_ROOT}/src/tools.ts").text();
const client = await Bun.file("${REPO_ROOT}/src/services/mcp/client.ts").text();
console.log(JSON.stringify({
  toolsImport: tools.includes("ReadMcpResourceDirTool/ReadMcpResourceDirTool.js"),
  toolsBase: tools.includes("ReadMcpResourceDirTool,"),
  toolsSpecial: tools.includes("ReadMcpResourceDirTool.name"),
  clientImport: client.includes("ReadMcpResourceDirTool/ReadMcpResourceDirTool.js"),
  clientPush: client.includes("ReadMcpResourceDirTool,"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.toolsImport).toBe(true);
    expect(out.toolsBase).toBe(true);
    expect(out.toolsSpecial).toBe(true);
    expect(out.clientImport).toBe(true);
    expect(out.clientPush).toBe(true);
  });
});
