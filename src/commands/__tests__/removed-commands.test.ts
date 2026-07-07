import { describe, expect, test } from "bun:test";
import {
  INTERNAL_ONLY_COMMANDS,
  REMOTE_SAFE_COMMANDS,
  getCommandName,
} from "../../commands";

/**
 * claude-code 2.1.92: "Removed /tag command" and "Removed /vim command
 * (toggle vim mode via /config → Editor mode)". The vim *mode* (src/vim/)
 * stays; only the slash commands are gone.
 */
describe("2.1.92 removed slash commands", () => {
  const internalNames = INTERNAL_ONLY_COMMANDS.map((c) => getCommandName(c));
  const remoteSafeNames = [...REMOTE_SAFE_COMMANDS].map((c) => getCommandName(c));

  test("/tag is no longer registered", () => {
    expect(internalNames).not.toContain("tag");
    expect(remoteSafeNames).not.toContain("tag");
  });

  test("/vim is no longer registered", () => {
    expect(internalNames).not.toContain("vim");
    expect(remoteSafeNames).not.toContain("vim");
  });

  test("core commands are still present (regression)", () => {
    // /cost + /stats were merged into /usage as aliases (2.1.118, E13) — they
    // are no longer standalone registered commands. clear/help/theme stay.
    for (const name of ["clear", "help", "theme"]) {
      expect(internalNames.includes(name) || remoteSafeNames.includes(name)).toBe(true);
    }
  });
});
