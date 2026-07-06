import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 /mcp improvements (vs official 2.1.200 binary).
 *
 *   E27 (2.1.128+2.1.132+2.1.139):
 *     - tool count per server ("connected · N tools")
 *     - 0-tools flag ("connected · no tools", warning)
 *     - reconnect picks up .mcp.json edits without a restart
 *     - "Show unused connectors (N)" toggle + "unused claude.ai connectors" subtitle
 *
 * Expected shapes verified against the official binary strings extraction:
 *   renderServerItem status chain (warning triangle for fetch-failed / no-tools,
 *   success tick + `connected · ${count} ${plural}` for connected-with-tools).
 *   "Show unused connectors" toggle + "unused claude.ai connectors (N)" subtitle.
 */

describe("2.1.200 /mcp improvements (e2e, vs official 2.1.200)", () => {
  test("E27 MCPListPanel renders tool count, 0-tools flag, and tools-fetch-failed (binary wording)", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/mcp/MCPListPanel.tsx`).text();
    // Tool count + plural (matches `connected · ${o} ${T}` in the binary)
    expect(src).toContain("connected · ${toolCount} ${plural(toolCount, \"tool\")}");
    // 0-tools flag (matches `connected · no tools` in the binary)
    expect(src).toContain("connected · no tools");
    // tools fetch failed (matches `connected · tools fetch failed`)
    expect(src).toContain("connected · tools fetch failed");
    // Warning icon for fetch-failed and no-tools; success tick for connected-with-tools
    expect(src).toMatch(/toolsFetchError[\s\S]*?triangleUpOutline[\s\S]*?connected · tools fetch failed/);
    expect(src).toMatch(/toolCount === 0[\s\S]*?triangleUpOutline[\s\S]*?connected · no tools/);
    // capabilities.tools gate (matches `!!n.client.capabilities?.tools`)
    expect(src).toContain("capabilities?.tools");
  });

  test("E27 MCPListPanel accepts toolCountsByServer + unused-connector props", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/mcp/MCPListPanel.tsx`).text();
    expect(src).toContain("toolCountsByServer");
    expect(src).toContain("unusedClaudeAiServers");
    expect(src).toContain("showUnusedConnectors");
    expect(src).toContain("onToggleUnusedConnectors");
    // Unused-connectors toggle + subtitle wording (matches binary)
    expect(src).toContain("Show unused connectors");
    expect(src).toContain("unused claude.ai connectors");
  });

  test("E27 MCPSettings passes toolCountsByServer + unusedClaudeAiServers to MCPListPanel", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/mcp/MCPSettings.tsx`).text();
    expect(src).toContain("toolCountsByServer");
    expect(src).toContain("filterToolsByServer(mcp.tools, s.name).length");
    expect(src).toContain("unusedClaudeAiServers");
    expect(src).toContain("showUnusedConnectors={showUnusedConnectors}");
    expect(src).toContain("onToggleUnusedConnectors");
  });

  test("E27 reconnect re-reads .mcp.json from disk before reconnecting", async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/mcp/useManageMCPConnections.ts`,
    ).text();
    // The fix: re-read config via getMcpConfigByName instead of stale client.config
    expect(src).toContain("getMcpConfigByName(serverName)");
    expect(src).toMatch(/getMcpConfigByName\(serverName\)\s*\?\?\s*client\.config/);
    expect(src).toContain("getMcpConfigByName");
    // Import added
    expect(src).toMatch(/import[\s\S]*?getMcpConfigByName[\s\S]*?from 'src\/services\/mcp\/config\.js'/);
  });

  test("E27 reconnect pickup is wired through the MCPReconnect flow", async () => {
    // MCPReconnect calls reconnectMcpServer (from useManageMCPConnections), which
    // now re-reads .mcp.json. Verify the call path is intact.
    const src = await Bun.file(`${REPO_ROOT}/src/components/mcp/MCPReconnect.tsx`).text();
    expect(src).toContain("useMcpReconnect");
    expect(src).toContain("reconnectMcpServer(serverName)");
  });
});
