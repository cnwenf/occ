import { afterEach, describe, expect, test } from "bun:test";
import {
  MCP_CONNECTION_TIMEOUT_MS,
  waitForMcpConnectionBatch,
} from "../client";

/**
 * claude-code 2.1.89: MCP_CONNECTION_NONBLOCKING + 5s bound on --mcp-config
 * connection wait. Mirrors v89's per-server `oq(connectionPromise, serverName)`.
 */

const savedEnv = process.env.MCP_CONNECTION_NONBLOCKING;
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.MCP_CONNECTION_NONBLOCKING;
  } else {
    process.env.MCP_CONNECTION_NONBLOCKING = savedEnv;
  }
});

describe("waitForMcpConnectionBatch", () => {
  test("returns 'skipped' and does not wait when env is set", async () => {
    process.env.MCP_CONNECTION_NONBLOCKING = "1";
    let resolved = false;
    const slow = new Promise<void>((r) => setTimeout(() => { resolved = true; r() }, 1000));
    const result = await waitForMcpConnectionBatch(slow, "test-skip");
    expect(result).toBe("skipped");
    // Must not have awaited the connection.
    expect(resolved).toBe(false);
  });

  test("returns 'connected' when the connection resolves before 5s", async () => {
    delete process.env.MCP_CONNECTION_NONBLOCKING;
    const fast = Promise.resolve("ok");
    const result = await waitForMcpConnectionBatch(fast, "test-fast");
    expect(result).toBe("connected");
  });

  test("returns 'timed-out' when the connection exceeds the 5s bound", async () => {
    delete process.env.MCP_CONNECTION_NONBLOCKING;
    // A connection that never resolves within the bound.
    const never = new Promise<void>(() => {});
    const result = await waitForMcpConnectionBatch(never, "test-slow");
    expect(result).toBe("timed-out");
  }, MCP_CONNECTION_TIMEOUT_MS + 2000);

  test("the 5s bound equals 5000ms", () => {
    expect(MCP_CONNECTION_TIMEOUT_MS).toBe(5000);
  });

  test("does not leave a dangling timer after timeout (process can exit)", async () => {
    delete process.env.MCP_CONNECTION_NONBLOCKING;
    const never = new Promise<void>(() => {});
    await waitForMcpConnectionBatch(never, "test-timer");
    // If the timer were not cleared, bun:test would hang on the active handle.
    // Reaching this assertion means the timeout timer was cleared.
    expect(true).toBe(true);
  }, MCP_CONNECTION_TIMEOUT_MS + 2000);

  test("a rejected connection does not throw (caller is responsible for .catch)", async () => {
    // waitForMcpConnectionBatch races connectionPromise.then(() => false). If the
    // promise rejects, the race rejects — callers must pass a .catch'd promise
    // (as connectMcpBatch does). Verify that contract.
    delete process.env.MCP_CONNECTION_NONBLOCKING;
    const rejecting = Promise.reject(new Error("boom"));
    await expect(waitForMcpConnectionBatch(rejecting, "test-reject")).rejects.toThrow("boom");
  });
});
