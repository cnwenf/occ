import { describe, expect, test } from "bun:test";
import { SandboxSettingsSchema } from "../sandboxTypes";

/**
 * claude-code 2.1.113: `sandbox.network.deniedDomains` setting to block
 * specific domains even when a broader allowedDomains wildcard permits them.
 */
describe("2.1.113 sandbox.network.deniedDomains", () => {
  test("accepts deniedDomains array", () => {
    const result = SandboxSettingsSchema().safeParse({
      network: { deniedDomains: ["evil.example.com"] },
    });
    expect(result.success).toBe(true);
  });

  test("accepts deniedDomains alongside allowedDomains", () => {
    const result = SandboxSettingsSchema().safeParse({
      network: {
        allowedDomains: ["*.example.com"],
        deniedDomains: ["bad.example.com"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts omitted deniedDomains", () => {
    expect(
      SandboxSettingsSchema().safeParse({ network: {} }).success,
    ).toBe(true);
  });

  test("rejects non-array deniedDomains", () => {
    expect(
      SandboxSettingsSchema().safeParse({
        network: { deniedDomains: "evil.example.com" },
      }).success,
    ).toBe(false);
  });
});
