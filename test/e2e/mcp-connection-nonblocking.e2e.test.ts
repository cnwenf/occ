import { describe, expect, test } from "bun:test";
import { runOcc, tempFile } from "./helpers";

/**
 * claude-code 2.1.89: MCP_CONNECTION_NONBLOCKING=true skips the MCP connection
 * wait in -p mode; --mcp-config server connections are bounded at 5s instead of
 * blocking on the slowest server.
 *
 * Scenario: an --mcp-config with a stdio server that hangs indefinitely. The
 * model answer ("OCC_OK") doesn't depend on MCP, so both runs succeed. The
 * feature contract under test:
 *   - WITHOUT NONBLOCKING: the 5s bound means the run still completes (it does
 *     NOT block forever on the hanging server). Cap + model latency < 45s.
 *   - WITH NONBLOCKING: the wait is skipped entirely; completes < 30s.
 *
 * A broken implementation (no 5s bound) would hang → timeout → fail.
 */
// 真实模型 e2e：需要模型回复 "OCC_OK"，依赖本地凭证。
// GitHub Actions 上无凭证且 CI=true，自动跳过；本地 CI 未设，正常运行。
describe.skipIf(!!process.env.CI)("2.1.89 MCP_CONNECTION_NONBLOCKING (e2e, Docker)", () => {
  test("bounded wait completes despite a hanging MCP server; NONBLOCKING skips it", async () => {
    const { path: mcpConfigPath, cleanup } = tempFile(
      "mcp.json",
      JSON.stringify({
        mcpServers: {
          // Hangs long enough to exceed the 5s MCP bound + test timeouts, but
          // NOT forever — if a subprocess ever leaks, it self-terminates in
          // 60s (the prior 100000s value crashed the host on orphan leak).
          slow: { command: "sleep", args: ["60"] },
        },
      }),
    );

    try {
      const commonArgs = [
        "-p",
        "Reply with exactly: OCC_OK",
        "--mcp-config",
        mcpConfigPath,
      ];

      const bounded = await runOcc(commonArgs, {}, 120_000);
      const nonblocking = await runOcc(
        commonArgs,
        { MCP_CONNECTION_NONBLOCKING: "1" },
        120_000,
      );

      // Both must reach the model and print the answer.
      expect(bounded.stdout).toContain("OCC_OK");
      expect(nonblocking.stdout).toContain("OCC_OK");

      // The 5s bound prevents blocking on the hanging server: bounded must
      // finish well under the server's 100000s sleep. 45s accommodates the 5s
      // cap + generous model latency headroom.
      expect(bounded.durationMs).toBeLessThan(45_000);
      // NONBLOCKING skips the wait entirely — even faster.
      expect(nonblocking.durationMs).toBeLessThan(30_000);
    } finally {
      cleanup();
    }
  }, 280_000);
});
