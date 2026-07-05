import { describe, expect, test } from "bun:test";
import rewind from "../index";

/**
 * claude-code 2.1.108: /undo is now an alias for /rewind.
 */
describe("2.1.108 /undo alias for /rewind", () => {
  test("rewind command has 'undo' in its aliases", () => {
    expect(rewind.aliases).toContain("undo");
    expect(rewind.aliases).toContain("checkpoint"); // existing alias preserved
    expect(rewind.name).toBe("rewind");
  });
});
