import { describe, expect, test } from "bun:test";
import {
  CMDLET_ALLOWLIST,
  isAllowlistedCommand,
  resolveToCanonical,
} from "../readOnlyValidation";
import type { ParsedCommandElement } from "../../../utils/powershell/parser";

/**
 * claude-code 2.1.90: "Removed `Get-DnsClientCache` and `ipconfig /displaydns`
 * from auto-allow (DNS cache privacy)". The DNS client cache exposes resolved
 * hostnames — a fingerprinting/exfiltration vector — so both are now prompts.
 */
describe("2.1.90 DNS cache privacy removals", () => {
  test("get-dnsclientcache is no longer in the allowlist", () => {
    expect(CMDLET_ALLOWLIST["get-dnsclientcache"]).toBeUndefined();
    expect(CMDLET_ALLOWLIST[resolveToCanonical("Get-DnsClientCache")]).toBeUndefined();
  });

  test("ipconfig safeFlags no longer include /displaydns", () => {
    const ipconfig = CMDLET_ALLOWLIST["ipconfig"];
    expect(ipconfig).toBeDefined();
    expect(ipconfig!.safeFlags).not.toContain("/displaydns");
    // Regression: the read-only display flags that remained are intact.
    expect(ipconfig!.safeFlags).toContain("/all");
    expect(ipconfig!.safeFlags).toContain("/allcompartments");
  });

  test("get-dnsclientcache is not auto-allowed (prompts instead)", () => {
    const cmd: ParsedCommandElement = {
      name: "Get-DnsClientCache",
      nameType: "cmdlet",
      elementType: "CommandAst",
      args: [],
      text: "Get-DnsClientCache",
      elementTypes: ["StringConstant"],
    };
    expect(isAllowlistedCommand(cmd, "Get-DnsClientCache")).toBe(false);
  });

  test("get-dnsclient (the non-cache variant) is still auto-allowed (regression)", () => {
    // Confirms the removal was scoped to the *cache* cmdlet only.
    const cmd: ParsedCommandElement = {
      name: "Get-DnsClient",
      nameType: "cmdlet",
      elementType: "CommandAst",
      args: [],
      text: "Get-DnsClient",
      elementTypes: ["StringConstant"],
    };
    expect(isAllowlistedCommand(cmd, "Get-DnsClient")).toBe(true);
  });
});
