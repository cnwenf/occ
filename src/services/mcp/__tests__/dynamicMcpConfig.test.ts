import { afterEach, describe, expect, test } from "bun:test";
import {
  parseDynamicMcpConfig,
  parseDynamicMcpConfigFromFile,
} from "../config";
import {
  getSkippedMcpServerErrors,
  recordSkippedMcpServerErrors,
  resetSkippedMcpServerErrorsForTest,
} from "../skippedMcpServerErrors";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * claude-code 2.1.219 item 4 — per-entry `--mcp-config` validation
 * (binary `Ilr`, 2.1.220 linux-x64 ELF) + the skipped-errors module store
 * (binary `TEm`/`CEm`/`wEm`).
 *
 * Expected messages/categories were verified against the LIVE official
 * 2.1.220 binary in OCC-43 (byte-identical).
 */
describe("2.1.219 parseDynamicMcpConfig (binary Ilr port)", () => {
  function parse(mcpServers: Record<string, unknown>, expandVars = false) {
    return parseDynamicMcpConfig({
      configObject: { mcpServers },
      expandVars,
      scope: "dynamic",
      filePath: "command line",
    });
  }

  function skips(result: ReturnType<typeof parse>) {
    return result.errors
      .filter((e) => e.mcpErrorMetadata?.skipReason)
      .map((e) => ({
        name: e.mcpErrorMetadata?.serverName,
        type: e.mcpErrorMetadata?.skipReason,
        message: e.message,
      }));
  }

  test("valid stdio entry loads with no errors", () => {
    const result = parse({ good: { command: "echo", args: ["hi"] } });
    expect(Object.keys(result.config!.mcpServers)).toEqual(["good"]);
    expect(result.errors).toHaveLength(0);
  });

  test("unknown_type: type not in the registry is skipped", () => {
    const result = parse({ bogus: { type: "unknowntype", command: "x" } });
    expect(result.config!.mcpServers).toEqual({});
    expect(skips(result)).toEqual([
      {
        name: "bogus",
        type: "unknown_type",
        message: 'Skipped — unknown MCP server type "unknowntype" for server "bogus"',
      },
    ]);
    const err = result.errors[0];
    expect(err.path).toBe("mcpServers.bogus");
    expect(err.suggestion).toBe(
      "Valid types are: stdio, sse, http (or streamable-http), ws, sdk",
    );
  });

  test("streamable-http is an alias of the http schema (not unknown)", () => {
    const result = parse({
      alias: { type: "streamable-http", url: "http://example.com/mcp" },
    });
    expect(Object.keys(result.config!.mcpServers)).toEqual(["alias"]);
    expect(skips(result)).toHaveLength(0);
  });

  test("url_missing_type: url without type (and no command) is skipped", () => {
    const result = parse({ nourl: { url: "http://example.com/mcp" } });
    expect(skips(result)).toEqual([
      {
        name: "nourl",
        type: "url_missing_type",
        message:
          'Skipped — MCP server "nourl" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
      },
    ]);
  });

  test("invalid_config: schema failure joins issues with '; ' and strips 'Invalid input: '", () => {
    const result = parse({
      badstdio: { type: "stdio" },
      badhttp: { type: "http", url: 123 },
    });
    expect(skips(result)).toEqual([
      {
        name: "badstdio",
        type: "invalid_config",
        message:
          'Skipped — invalid MCP server config for "badstdio": command: expected string, received undefined',
      },
      {
        name: "badhttp",
        type: "invalid_config",
        message:
          'Skipped — invalid MCP server config for "badhttp": url: expected string, received number',
      },
    ]);
  });

  test("reserved_name: workspace is skipped", () => {
    const result = parse({ workspace: { type: "http", url: "http://x.test" } });
    expect(skips(result)).toEqual([
      {
        name: "workspace",
        type: "reserved_name",
        message: '"workspace" is a reserved MCP server name and was not loaded',
      },
    ]);
  });

  test("reserved_name: claude-in-chrome is skipped, but type sdk is exempt", () => {
    const result = parse({
      "claude-in-chrome": { type: "http", url: "http://x.test" },
      "claude-in-chrome-sdk": { type: "sdk", name: "host" },
    });
    expect(skips(result).map((s) => s.name)).toEqual(["claude-in-chrome"]);
    expect(Object.keys(result.config!.mcpServers)).toEqual([
      "claude-in-chrome-sdk",
    ]);
  });

  test("top-level shape failure are fatal (config null)", () => {
    const serversInstead = parseDynamicMcpConfig({
      configObject: { servers: { a: { command: "x" } } },
      expandVars: true,
      scope: "dynamic",
      filePath: "command line",
    });
    expect(serversInstead.config).toBeNull();
    expect(serversInstead.errors[0].message).toBe(
      'Missing "mcpServers" — found "servers" instead. Claude Code reads MCP servers from the "mcpServers" key.',
    );
    expect(serversInstead.errors[0].suggestion).toBe(
      'Rename the top-level "servers" key to "mcpServers" in command line.',
    );
    expect(serversInstead.errors[0].mcpErrorMetadata?.severity).toBe("fatal");

    const empty = parseDynamicMcpConfig({
      configObject: {},
      expandVars: true,
      scope: "dynamic",
      filePath: "command line",
    });
    expect(empty.config).toBeNull();
    // The fatal branch keeps the raw zod message (no prefix strip).
    expect(empty.errors[0].message).toBe(
      "Invalid input: expected record, received undefined",
    );
  });

  test("whitespace warning is non-fatal and does not skip", () => {
    const result = parse({ wsy: { command: " echo " } });
    expect(Object.keys(result.config!.mcpServers)).toEqual(["wsy"]);
    expect(skips(result)).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe(
      "Leading or trailing whitespace in: command",
    );
    expect(result.errors[0].mcpErrorMetadata?.severity).toBe("warning");
    expect(result.errors[0].mcpErrorMetadata?.skipReason).toBeUndefined();
  });

  test("expandVars: missing vars warn; empty-expanded url sets configError/url_invalid", () => {
    process.env.OCC43_EMPTY = "";
    try {
      const result = parse(
        {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCP ${VAR} syntax, not a JS template
          missingvar: { command: "x", env: { FOO: "${OCC43_NOPE_42}" } },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCP ${VAR} syntax, not a JS template
          emptyurl: { type: "http", url: "${OCC43_EMPTY}" },
        },
        true,
      );
      // Both entries still load (warnings, not skips).
      expect(Object.keys(result.config!.mcpServers).sort()).toEqual([
        "emptyurl",
        "missingvar",
      ]);
      expect(skips(result)).toHaveLength(0);
      const messages = result.errors.map((e) => e.message).sort();
      expect(messages).toEqual([
        "Missing environment variables: OCC43_NOPE_42",
      ]);
      const emptyUrl = result.config!.mcpServers.emptyurl as Record<
        string,
        unknown
      >;
      expect(emptyUrl.configErrorReason).toBe("url_invalid");
      // Built via concatenation so the literal MCP "${VAR}" reference stays
      // a plain string without tripping noTemplateCurlyInString.
      const expectedConfigError =
        '\'url\' "$' +
        "{OCC43_EMPTY}" +
        '" expanded to an empty string. Set the referenced environment variable, or update the server\'s config and reconnect.';
      expect(emptyUrl.configError).toBe(expectedConfigError);
    } finally {
      delete process.env.OCC43_EMPTY;
    }
  });
});

describe("2.1.219 parseDynamicMcpConfigFromFile (binary Rlr gates)", () => {
  function tempDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "occ-dyn-file-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("missing file is fatal with the binary message", () => {
    const result = parseDynamicMcpConfigFromFile({
      filePath: "/nonexistent/occ43-no-such-file.json",
      expandVars: true,
      scope: "dynamic",
    });
    expect(result.config).toBeNull();
    expect(result.errors[0].message).toBe(
      "MCP config file not found: /nonexistent/occ43-no-such-file.json",
    );
  });

  test("invalid JSON file is fatal", () => {
    const { dir, cleanup } = tempDir();
    try {
      const filePath = join(dir, "bad.json");
      writeFileSync(filePath, "not json at all");
      const result = parseDynamicMcpConfigFromFile({
        filePath,
        expandVars: true,
        scope: "dynamic",
      });
      expect(result.config).toBeNull();
      expect(result.errors[0].message).toBe("MCP config is not a valid JSON");
    } finally {
      cleanup();
    }
  });

  test("valid file parses per-entry (skip + load)", () => {
    const { dir, cleanup } = tempDir();
    try {
      const filePath = join(dir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          mcpServers: {
            good: { command: "echo" },
            bogus: { type: "nope" },
          },
        }),
      );
      const result = parseDynamicMcpConfigFromFile({
        filePath,
        expandVars: true,
        scope: "dynamic",
      });
      expect(Object.keys(result.config!.mcpServers)).toEqual(["good"]);
      expect(result.errors[0].mcpErrorMetadata?.skipReason).toBe(
        "unknown_type",
      );
      expect(result.errors[0].file).toBe(filePath);
    } finally {
      cleanup();
    }
  });
});

describe("2.1.219 skipped-errors module store (binary TEm/CEm)", () => {
  afterEach(() => resetSkippedMcpServerErrorsForTest());

  test("starts empty, records append, getter reads", () => {
    expect(getSkippedMcpServerErrors()).toEqual([]);
    recordSkippedMcpServerErrors([
      { name: "a", type: "unknown_type", message: "m1" },
    ]);
    recordSkippedMcpServerErrors([
      { name: "b", type: "invalid_config", message: "m2" },
    ]);
    expect(getSkippedMcpServerErrors()).toEqual([
      { name: "a", type: "unknown_type", message: "m1" },
      { name: "b", type: "invalid_config", message: "m2" },
    ]);
  });
});
