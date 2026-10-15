import { describe, expect, test } from "bun:test";
import { addMcpConfig, parseDynamicMcpConfig } from "../config";
import { isReservedPrototypeMcpServerName } from "../mcpStringUtils";

/**
 * CC 2.1.299 (#042) — MCP servers named after Object.prototype members.
 *
 * Official v299 binary evidence (dd, v2.1.299 linux-x64 ELF):
 * - `mG(e){return e in Object.prototype&&fa(e)}` @215351978 with
 *   `fa(e){return oo(`${po(e)}t`)===null}` (tool-name round-trip failure).
 * - Dynamic/file config parse @226013700:
 *   `for(let _e of Object.keys(Q).filter(mG)) G(_e,O_e(_e),…,"reserved_name")`
 *   + main loop `if(mG(_e))continue`, where
 *   `O_e(e)=`"${e}" is a reserved MCP server name and was not loaded``
 *   @225978509. (v296 @217792400 had a `__proto__`-only guard.)
 * - `mcp add` @225998100 (`BW`): charset check then
 *   `if(EBe(e))throw …"this name is reserved."` — EBe's first branch is mG.
 *
 * FORENSIC NOTE: `mG("constructor")` and `mG("prototype")` are FALSE —
 * `mcp__constructor__t` round-trips fine, so official v299 accepts those as
 * ordinary server names in dynamic/file config; the #042 fix for them is
 * own-property-safe by-name lookups (covered by the readOwnOption tests in
 * pluginOptionsProtoKeys295.test.ts + the lookup call sites), not refusal.
 * The reserved set under mG is exactly the Object.prototype members whose
 * `__`-delimited tool-name form collapses the server segment to "":
 * __proto__, __defineGetter__, __defineSetter__, __lookupGetter__,
 * __lookupSetter__.
 */
describe("CC 2.1.299 isReservedPrototypeMcpServerName (binary mG port)", () => {
  test("reserved: Object.prototype members that fail the tool-name round-trip", () => {
    expect(isReservedPrototypeMcpServerName("__proto__")).toBe(true);
    expect(isReservedPrototypeMcpServerName("__defineGetter__")).toBe(true);
    expect(isReservedPrototypeMcpServerName("__defineSetter__")).toBe(true);
    expect(isReservedPrototypeMcpServerName("__lookupGetter__")).toBe(true);
    expect(isReservedPrototypeMcpServerName("__lookupSetter__")).toBe(true);
  });

  test("not reserved: Object.prototype members that round-trip (official mG semantics)", () => {
    // mG requires BOTH `in Object.prototype` AND a failed round-trip —
    // constructor/prototype/toString/… parse back cleanly from
    // `mcp__<name>__t`, so official v299 does NOT refuse them here.
    expect(isReservedPrototypeMcpServerName("constructor")).toBe(false);
    expect(isReservedPrototypeMcpServerName("prototype")).toBe(false);
    expect(isReservedPrototypeMcpServerName("toString")).toBe(false);
    expect(isReservedPrototypeMcpServerName("valueOf")).toBe(false);
    expect(isReservedPrototypeMcpServerName("hasOwnProperty")).toBe(false);
    expect(isReservedPrototypeMcpServerName("isPrototypeOf")).toBe(false);
    expect(isReservedPrototypeMcpServerName("propertyIsEnumerable")).toBe(false);
    expect(isReservedPrototypeMcpServerName("toLocaleString")).toBe(false);
  });

  test("not reserved: ordinary names", () => {
    expect(isReservedPrototypeMcpServerName("my-server")).toBe(false);
    expect(isReservedPrototypeMcpServerName("widgets")).toBe(false);
    expect(isReservedPrototypeMcpServerName("workspace")).toBe(false);
    expect(isReservedPrototypeMcpServerName("mcp")).toBe(false);
    expect(isReservedPrototypeMcpServerName("")).toBe(false);
    // A `__`-leading name that is NOT on Object.prototype fails the `in`
    // half of mG — official only reserves the prototype-collision spellings.
    expect(isReservedPrototypeMcpServerName("__myserver__")).toBe(false);
  });
});

describe("CC 2.1.299 parseDynamicMcpConfig reserved-prototype filter", () => {
  function parse(mcpServers: Record<string, unknown>) {
    return parseDynamicMcpConfig({
      configObject: { mcpServers },
      expandVars: false,
      scope: "dynamic",
      filePath: "command line",
    });
  }

  test("__proto__ own key (JSON.parse shape) is skipped with reserved_name and the official byte-exact message", () => {
    // JSON.parse keeps "__proto__" as an inert OWN data property — the shape
    // a hostile --mcp-config file arrives in.
    const parsed = JSON.parse(
      '{"mcpServers":{"__proto__":{"type":"stdio","command":"echo","args":["pwned"]}}}',
    );
    const result = parseDynamicMcpConfig({
      configObject: parsed,
      expandVars: false,
      scope: "dynamic",
      filePath: "command line",
    });
    expect(Object.keys(result.config!.mcpServers)).toEqual([]);
    // Result record's prototype must not have been re-pointed by the entry.
    expect(Object.getPrototypeOf(result.config!.mcpServers)).toBe(
      Object.prototype,
    );
    const reserved = result.errors.filter(
      (e) => e.mcpErrorMetadata?.skipReason === "reserved_name",
    );
    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toBe(
      '"__proto__" is a reserved MCP server name and was not loaded',
    );
    expect(reserved[0].suggestion).toBe(
      'Rename this server in your MCP config — "__proto__" cannot be used as a server name',
    );
    expect(reserved[0].path).toBe("mcpServers.__proto__");
    expect(reserved[0].mcpErrorMetadata?.serverName).toBe("__proto__");
  });

  test("__defineGetter__ entry is skipped with reserved_name (v299 generalization)", () => {
    const result = parse({
      __defineGetter__: { type: "stdio", command: "echo" },
      good: { type: "stdio", command: "echo" },
    });
    expect(Object.keys(result.config!.mcpServers)).toEqual(["good"]);
    const reserved = result.errors.filter(
      (e) => e.mcpErrorMetadata?.skipReason === "reserved_name",
    );
    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toBe(
      '"__defineGetter__" is a reserved MCP server name and was not loaded',
    );
  });

  test("constructor/prototype entries LOAD as ordinary servers (official mG semantics — not refused)", () => {
    const result = parse({
      constructor: { type: "stdio", command: "echo" },
      prototype: { type: "stdio", command: "echo" },
    });
    expect(
      Object.hasOwn(result.config!.mcpServers, "constructor"),
    ).toBe(true);
    expect(Object.hasOwn(result.config!.mcpServers, "prototype")).toBe(true);
    expect(
      result.errors.filter(
        (e) => e.mcpErrorMetadata?.skipReason === "reserved_name",
      ),
    ).toHaveLength(0);
  });

  test("existing reserved_name skips (workspace etc.) are unaffected", () => {
    const result = parse({ workspace: { type: "http", url: "http://x.test" } });
    const reserved = result.errors.filter(
      (e) => e.mcpErrorMetadata?.skipReason === "reserved_name",
    );
    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toBe(
      '"workspace" is a reserved MCP server name and was not loaded',
    );
  });
});

describe("CC 2.1.299 addMcpConfig reserved-prototype refusal (binary BW)", () => {
  test("__proto__ is refused before any config access", async () => {
    await expect(
      addMcpConfig(
        "__proto__",
        { type: "stdio", command: "echo" },
        "user",
      ),
    ).rejects.toThrow(
      'Cannot add MCP server "__proto__": this name is reserved.',
    );
  });

  test("__lookupGetter__ is refused", async () => {
    await expect(
      addMcpConfig(
        "__lookupGetter__",
        { type: "stdio", command: "echo" },
        "user",
      ),
    ).rejects.toThrow("this name is reserved.");
  });

  test("charset-invalid names keep the pre-existing refusal", async () => {
    await expect(
      addMcpConfig("bad name!", { type: "stdio", command: "echo" }, "user"),
    ).rejects.toThrow(
      "Invalid name bad name!. Names can only contain letters, numbers, hyphens, and underscores.",
    );
  });
});
