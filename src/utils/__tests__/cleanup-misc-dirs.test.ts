import { describe, expect, test } from "bun:test";
import { cleanupOldMiscConfigDirs } from "../cleanup";

/**
 * claude-code 2.1.117: cleanupPeriodDays sweep now covers ~/.claude/tasks/,
 * ~/.claude/shell-snapshots/, ~/.claude/backups/.
 */
describe("2.1.117 cleanupOldMiscConfigDirs", () => {
  test("runs without error (covers tasks/shell-snapshots/backups)", async () => {
    const result = await cleanupOldMiscConfigDirs();
    expect(result).toBeDefined();
    expect(typeof result.messages).toBe("number");
    expect(typeof result.errors).toBe("number");
  });
});
