/**
 * Gap-137b (OCC-137 re-acceptance round) — `mcp add` confirm-output header
 * redaction e2e against the BUILT artifact.
 *
 * Official 2.1.312 behavior under test (reviewer repro):
 *   claude mcp add --transport http --scope local s https://example.com/mcp \
 *     -H "Authorization: Bearer sk-test-secret-123" -H "X-Custom: plainvalue"
 * prints:
 *   Headers: {
 *     "Authorization": "[REDACTED]",
 *     "X-Custom": "plainvalue"
 *   }
 * and the config file (.claude.json) stores the PLAINTEXT value (display-only
 * redaction — verified: the official writes the raw header map to config).
 *
 * Runs with an isolated temp HOME + temp project dir so the assertion on the
 * stored config is exact and no user state is touched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runOcc } from "./helpers";

const SECRET_VALUE = "Bearer sk-test-secret-123";

/** Collapse whitespace runs so JSON pretty-print spacing can't flake. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ");
}

interface AddResult {
  stdout: string;
  stderr: string;
  code: number;
  home: string;
  projDir: string;
  cleanup: () => void;
}

async function runMcpAdd(transport: "http" | "sse"): Promise<AddResult> {
  const home = mkdtempSync(join(tmpdir(), "occ-mcp-redact-home-"));
  const projDir = mkdtempSync(join(tmpdir(), "occ-mcp-redact-proj-"));
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  };
  const result = await runOcc(
    [
      "mcp", "add",
      "--transport", transport,
      "--scope", "local",
      "s",
      "https://example.com/mcp",
      "-H", `Authorization: ${SECRET_VALUE}`,
      "-H", "X-Custom: plainvalue",
    ],
    { HOME: home, OCC_CWD: projDir },
    30_000,
  );
  return { ...result, home, projDir, cleanup };
}

/** The stored server entry for the temp project from the temp-HOME config. */
function readStoredServer(home: string, projDir: string): {
  type: string;
  url: string;
  headers: Record<string, string>;
} {
  const configFile = join(home, ".claude.json");
  expect(existsSync(configFile)).toBe(true);
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  const project = cfg.projects?.[projDir];
  expect(project).toBeDefined();
  const server = project.mcpServers?.s;
  expect(server).toBeDefined();
  return server;
}

describe("mcp add confirm output redacts sensitive header names (2.1.312 uxn)", () => {
  test("http transport: Authorization -> [REDACTED], X-Custom verbatim, config plaintext", async () => {
    const r = await runMcpAdd("http");
    try {
      // Act/Assert — command succeeded
      expect(r.code).toBe(0);
      expect(norm(r.stdout)).toContain("Added HTTP MCP server s");

      // Display: sensitive name redacted, benign name verbatim
      expect(r.stdout).toContain('"Authorization": "[REDACTED]"');
      expect(r.stdout).toContain('"X-Custom": "plainvalue"');

      // The secret value must NEVER appear in stdout (the leak under test)
      expect(r.stdout).not.toContain("sk-test-secret-123");

      // Display-only: config file stores the plaintext value
      const server = readStoredServer(r.home, r.projDir);
      expect(server.type).toBe("http");
      expect(server.url).toBe("https://example.com/mcp");
      expect(server.headers.Authorization).toBe(SECRET_VALUE);
      expect(server.headers["X-Custom"]).toBe("plainvalue");
    } finally {
      r.cleanup();
    }
  }, 30_000);

  test("sse transport: same redaction contract on the merged confirm print", async () => {
    const r = await runMcpAdd("sse");
    try {
      expect(r.code).toBe(0);
      expect(norm(r.stdout)).toContain("Added SSE MCP server s");

      expect(r.stdout).toContain('"Authorization": "[REDACTED]"');
      expect(r.stdout).toContain('"X-Custom": "plainvalue"');
      expect(r.stdout).not.toContain("sk-test-secret-123");

      const server = readStoredServer(r.home, r.projDir);
      expect(server.type).toBe("sse");
      expect(server.headers.Authorization).toBe(SECRET_VALUE);
      expect(server.headers["X-Custom"]).toBe("plainvalue");
    } finally {
      r.cleanup();
    }
  }, 30_000);
});
