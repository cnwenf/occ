import { afterEach, describe, expect, test } from "bun:test";
import { parseDynamicMcpConfig } from "../config";
import { getMcpServerNameCollisionKey } from "../mcpStringUtils";

/**
 * claude-code 2.1.285 bullet #93 — the MCP server name `widgets` is reserved in
 * cloud sessions and on self-hosted runners; a user server under it, or a close
 * spelling such as `widgets_`, no longer loads.
 *
 * Byte evidence (official 2.1.285 linux-x64 ELF, strings dump):
 *   - a9e="widgets"                          new285.txt @ 23972878
 *   - Jd(e)=ys(`${Us(e)}tool`)?.serverName   new285.txt @ 34903711
 *   - Us(e)=`mcp__${wn(e)}__`                new285.txt @ 19977107
 *   - ys = split("__") serverName parser     new285.txt @ 19976961
 *   - wn = light normalizer (case-sensitive) new285.txt @ 36336340 / @ 19976914
 *   - hRe widgets branch:
 *       CN=Jd(a9e); if(r===CN) return
 *         (n?.hosted ?? a.CLAUDE_CODE_REMOTE) && !(n?.hostCarrier && e===a9e)
 *                                            new285.txt @ 34904041
 *   - 2.1.284 MRe has NO widgets branch      gone284.txt @ 35296792
 *
 * OCC scope note: `hostCarrier` (the self-hosted-runner carrier carve-out) is
 * not plumbed in OCC — src/self-hosted-runner/main.ts is a no-op stub and OCC
 * registers no internal "widgets" server — so the portable gate reduces to the
 * cloud-session env `CLAUDE_CODE_REMOTE`. These tests pin that reduced gate and
 * the exact collision-key rule.
 */

describe("getMcpServerNameCollisionKey (2.1.285 Jd port)", () => {
  test("exact and trailing-underscore/space spellings collapse to 'widgets'", () => {
    // Arrange / Act / Assert — the close-spelling rule from bullet #93: a name
    // whose normalized form has TRAILING underscores merges them into the "__"
    // delimiter, so it round-trips to the same key as "widgets".
    expect(getMcpServerNameCollisionKey("widgets")).toBe("widgets");
    expect(getMcpServerNameCollisionKey("widgets_")).toBe("widgets");
    expect(getMcpServerNameCollisionKey("widgets__")).toBe("widgets");
    expect(getMcpServerNameCollisionKey("widgets ")).toBe("widgets");
  });

  test("case, hyphen, leading-underscore and superstring spellings do NOT collapse", () => {
    // The official uses the LIGHT `wn` normalizer (case-sensitive, hyphens and
    // leading underscores preserved), NOT the aggressive `hj`. Only trailing
    // underscore/space spellings collide.
    expect(getMcpServerNameCollisionKey("Widgets")).toBe("Widgets");
    expect(getMcpServerNameCollisionKey("widgets-")).toBe("widgets-");
    expect(getMcpServerNameCollisionKey("_widgets")).toBe("_widgets");
    expect(getMcpServerNameCollisionKey("mywidgets")).toBe("mywidgets");
    expect(getMcpServerNameCollisionKey("widgets1")).toBe("widgets1");
  });
});

describe("2.1.285 bullet #93 — widgets reserved at load time", () => {
  const ORIGINAL_REMOTE = process.env.CLAUDE_CODE_REMOTE;

  afterEach(() => {
    // Restore the ambient env so tests stay isolated regardless of order.
    if (ORIGINAL_REMOTE === undefined) {
      delete process.env.CLAUDE_CODE_REMOTE;
    } else {
      process.env.CLAUDE_CODE_REMOTE = ORIGINAL_REMOTE;
    }
  });

  function parse(mcpServers: Record<string, unknown>) {
    return parseDynamicMcpConfig({
      configObject: { mcpServers },
      expandVars: false,
      scope: "dynamic",
      filePath: "command line",
    });
  }

  function reservedSkips(result: ReturnType<typeof parse>) {
    return result.errors
      .filter((e) => e.mcpErrorMetadata?.skipReason === "reserved_name")
      .map((e) => ({
        name: e.mcpErrorMetadata?.serverName,
        message: e.message,
      }));
  }

  const httpEntry = { type: "http", url: "http://x.test" };

  test("gate ON: exact 'widgets' is skipped as reserved_name", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "1";

    // Act
    const result = parse({ widgets: httpEntry });

    // Assert
    expect(reservedSkips(result)).toEqual([
      {
        name: "widgets",
        message: '"widgets" is a reserved MCP server name and was not loaded',
      },
    ]);
    expect(Object.keys(result.config!.mcpServers)).toEqual([]);
  });

  test("gate ON: close spelling 'widgets_' is skipped as reserved_name", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "1";

    // Act
    const result = parse({ widgets_: httpEntry });

    // Assert — the message uses the RAW config key, matching official `F(he,…)`.
    expect(reservedSkips(result)).toEqual([
      {
        name: "widgets_",
        message: '"widgets_" is a reserved MCP server name and was not loaded',
      },
    ]);
    expect(Object.keys(result.config!.mcpServers)).toEqual([]);
  });

  test("gate ON: type 'sdk' is exempt from the widgets reservation", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "1";

    // Act
    const result = parse({ widgets: { type: "sdk", name: "host" } });

    // Assert — official: `hRe(...) && Te.type!=="sdk"`; SDK hosts own naming.
    expect(reservedSkips(result)).toEqual([]);
    expect(Object.keys(result.config!.mcpServers)).toEqual(["widgets"]);
  });

  test("gate ON: case / hyphen / leading-underscore variants are NOT reserved", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "1";

    // Act
    const result = parse({
      Widgets: httpEntry,
      "widgets-": httpEntry,
      _widgets: httpEntry,
    });

    // Assert — mutation pin: an aggressive normalizer (hj) would wrongly
    // reserve these; the light `wn` round-trip does not.
    expect(reservedSkips(result)).toEqual([]);
    expect(Object.keys(result.config!.mcpServers).sort()).toEqual([
      "Widgets",
      "_widgets",
      "widgets-",
    ]);
  });

  test("gate ON: a normal server loads while 'widgets' is skipped", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "1";

    // Act
    const result = parse({
      good: { command: "echo", args: ["hi"] },
      widgets: httpEntry,
    });

    // Assert
    expect(reservedSkips(result).map((s) => s.name)).toEqual(["widgets"]);
    expect(Object.keys(result.config!.mcpServers)).toEqual(["good"]);
  });

  test("gate OFF (env unset): 'widgets' and 'widgets_' both load", () => {
    // Arrange
    delete process.env.CLAUDE_CODE_REMOTE;

    // Act
    const result = parse({ widgets: httpEntry, widgets_: httpEntry });

    // Assert — mutation pin: the reservation MUST be gated on the cloud env.
    expect(reservedSkips(result)).toEqual([]);
    expect(Object.keys(result.config!.mcpServers).sort()).toEqual([
      "widgets",
      "widgets_",
    ]);
  });

  test("gate OFF (CLAUDE_CODE_REMOTE=0): 'widgets' loads", () => {
    // Arrange
    process.env.CLAUDE_CODE_REMOTE = "0";

    // Act
    const result = parse({ widgets: httpEntry });

    // Assert — isEnvTruthy("0") is false, so the gate stays closed.
    expect(reservedSkips(result)).toEqual([]);
    expect(Object.keys(result.config!.mcpServers)).toEqual(["widgets"]);
  });
});
