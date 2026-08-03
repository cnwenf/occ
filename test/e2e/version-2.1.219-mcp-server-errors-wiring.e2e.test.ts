import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOcc } from "./helpers";

/**
 * claude-code 2.1.219 item 4 CALLER-WIRING e2e: `--mcp-config` entries that
 * fail validation are SKIPPED (not fatal) and surfaced as `mcp_server_errors`
 * in the stream-json `system/init` event.
 *
 * Every assertion below was verified against the LIVE official 2.1.220 binary
 * this round (OCC-43): same skip categories, same message bytes, same fatal
 * exit for configs that fail to parse at all.
 *
 * Binary evidence (2.1.220 linux-x64 ELF):
 *   - CLI entry `--mcp-config` block (~267411149): per-entry `Ilr` parse,
 *     skipReason collection, `TEm` store push, TTY-gated stderr warning.
 *   - `parseDynamicMcpConfig` mirrors `Ilr` (~253245xxx): unknown_type /
 *     url_missing_type / invalid_config / reserved_name skip categories.
 *   - QueryEngine init builder reads the store (`mcpServerErrors:CEm()`,
 *     ~267738589); `tAr` filters against mcpClients and emits only when
 *     non-empty (~260839750).
 *
 * Gated out of CI (needs model credentials for the `-p` run); run locally
 * with a real endpoint.
 */
describe.skipIf(!!process.env.CI)(
  "2.1.219 mcp_server_errors caller-wiring (e2e)",
  () => {
    function tempMcpDir(): { dir: string; cleanup: () => void } {
      const dir = mkdtempSync(join(tmpdir(), "occ-mcp-wiring-"));
      return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    function firstInitEvent(stdout: string): Record<string, unknown> | null {
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === "system" && parsed.subtype === "init") {
            return parsed;
          }
        } catch {
          // not a JSON line — skip
        }
      }
      return null;
    }

    test("invalid entries are skipped with mcp_server_errors; valid entries still load", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        const configPath = join(dir, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: {
              bogus: { type: "unknowntype", command: "x" },
              nourl: { url: "http://example.com/mcp" },
              good: { command: "echo", args: ["hi"] },
            },
          }),
        );
        const res = await runOcc(
          ["-p", "Reply with exactly the word PONG", "--output-format", "stream-json", "--verbose", "--mcp-config", configPath],
          { OCC_CWD: dir },
          120_000,
        );
        const init = firstInitEvent(res.stdout);
        expect(init).not.toBeNull();

        // The valid entry still loads (skip semantics, not fatal).
        const mcpServers = init!.mcp_servers as Array<Record<string, unknown>>;
        expect(mcpServers.some((s) => s.name === "good")).toBe(true);
        expect(mcpServers.some((s) => s.name === "bogus")).toBe(false);
        expect(mcpServers.some((s) => s.name === "nourl")).toBe(false);

        // Byte-identical to the live official 2.1.220 output.
        const errors = init!.mcp_server_errors as Array<Record<string, unknown>>;
        expect(errors).toHaveLength(2);
        expect(errors[0]).toEqual({
          name: "bogus",
          type: "unknown_type",
          message: 'Skipped — unknown MCP server type "unknowntype" for server "bogus"',
        });
        expect(errors[1]).toEqual({
          name: "nourl",
          type: "url_missing_type",
          message:
            'Skipped — MCP server "nourl" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
        });
      } finally {
        cleanup();
      }
    }, 150_000);

    test("invalid_config category carries zod issue details (Invalid input: prefix stripped)", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        const configPath = join(dir, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: {
              badstdio: { type: "stdio" },
              badhttp: { type: "http", url: 123 },
            },
          }),
        );
        const res = await runOcc(
          ["-p", "Reply with exactly the word PONG", "--output-format", "stream-json", "--verbose", "--mcp-config", configPath],
          { OCC_CWD: dir },
          120_000,
        );
        const init = firstInitEvent(res.stdout);
        expect(init).not.toBeNull();
        const errors = init!.mcp_server_errors as Array<Record<string, unknown>>;
        expect(errors).toHaveLength(2);
        expect(errors[0]).toEqual({
          name: "badstdio",
          type: "invalid_config",
          message:
            'Skipped — invalid MCP server config for "badstdio": command: expected string, received undefined',
        });
        expect(errors[1]).toEqual({
          name: "badhttp",
          type: "invalid_config",
          message:
            'Skipped — invalid MCP server config for "badhttp": url: expected string, received number',
        });
      } finally {
        cleanup();
      }
    }, 150_000);

    test("reserved_name category: workspace entry is skipped, not fatal", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        const configPath = join(dir, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: {
              workspace: { type: "http", url: "http://example.com/mcp" },
              ok: { command: "echo" },
            },
          }),
        );
        const res = await runOcc(
          ["-p", "Reply with exactly the word PONG", "--output-format", "stream-json", "--verbose", "--mcp-config", configPath],
          { OCC_CWD: dir },
          120_000,
        );
        const init = firstInitEvent(res.stdout);
        expect(init).not.toBeNull();
        const errors = init!.mcp_server_errors as Array<Record<string, unknown>>;
        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          name: "workspace",
          type: "reserved_name",
          message: '"workspace" is a reserved MCP server name and was not loaded',
        });
        const mcpServers = init!.mcp_servers as Array<Record<string, unknown>>;
        expect(mcpServers.some((s) => s.name === "ok")).toBe(true);
      } finally {
        cleanup();
      }
    }, 150_000);

    test("mcp_server_errors key is OMITTED when every entry is valid", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        const configPath = join(dir, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: {
              onlygood: { command: "echo", args: ["hi"] },
            },
          }),
        );
        const res = await runOcc(
          ["-p", "Reply with exactly the word PONG", "--output-format", "stream-json", "--verbose", "--mcp-config", configPath],
          { OCC_CWD: dir },
          120_000,
        );
        const init = firstInitEvent(res.stdout);
        expect(init).not.toBeNull();
        expect("mcp_server_errors" in init!).toBe(false);
      } finally {
        cleanup();
      }
    }, 150_000);

    test("fatal: top-level shape failure still exit 1 with the binary's exact stderr", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        // "servers" instead of "mcpServers" — binary-verified message.
        const res1 = await runOcc(
          ["-p", "hi", "--mcp-config", JSON.stringify({ servers: { a: { command: "x" } } })],
          { OCC_CWD: dir },
          60_000,
        );
        expect(res1.code).toBe(1);
        expect(res1.stderr).toContain("Error: Invalid MCP configuration:");
        expect(res1.stderr).toContain(
          'mcpServers: Missing "mcpServers" — found "servers" instead. Claude Code reads MCP servers from the "mcpServers" key.',
        );

        // Empty object — raw zod issue (fatal branch keeps the prefix).
        const res2 = await runOcc(
          ["-p", "hi", "--mcp-config", "{}"],
          { OCC_CWD: dir },
          60_000,
        );
        expect(res2.code).toBe(1);
        expect(res2.stderr).toContain(
          "mcpServers: Invalid input: expected record, received undefined",
        );

        // Non-JSON value is treated as a file path — ENOENT fatal.
        const res3 = await runOcc(
          ["-p", "hi", "--mcp-config", "no-such-file-occ43"],
          { OCC_CWD: dir },
          60_000,
        );
        expect(res3.code).toBe(1);
        expect(res3.stderr).toContain("MCP config file not found:");
      } finally {
        cleanup();
      }
    }, 200_000);

    test("non-TTY stderr carries no skip warning (warning is TTY-gated)", async () => {
      const { dir, cleanup } = tempMcpDir();
      try {
        const configPath = join(dir, "mcp.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: { bogus: { type: "unknowntype" } },
          }),
        );
        const res = await runOcc(
          ["-p", "Reply with exactly the word PONG", "--output-format", "stream-json", "--verbose", "--mcp-config", configPath],
          { OCC_CWD: dir },
          120_000,
        );
        // runOcc pipes stderr (not a TTY) — the binary only prints the
        // "Warning: N MCP server(s) skipped due to invalid config" block when
        // stderr is a TTY.
        expect(res.stderr).not.toContain("skipped due to invalid config");
      } finally {
        cleanup();
      }
    }, 150_000);
  },
);
