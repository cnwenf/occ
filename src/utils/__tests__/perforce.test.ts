import { afterEach, describe, expect, test } from "bun:test";
import { isPerforceMode, perforceReadOnlyError } from "../perforce";

/**
 * claude-code 2.1.98: CLAUDE_CODE_PERFORCE_MODE — Edit/Write/NotebookEdit fail
 * on read-only files (no owner-write bit) with a `p4 edit` hint instead of
 * silently overwriting them. Mirrors v98's `JZ6(mode) = c91() && (mode & 0o200) === 0`.
 */
const SAVED = process.env.CLAUDE_CODE_PERFORCE_MODE;
afterEach(() => {
  if (SAVED === undefined) {
    delete process.env.CLAUDE_CODE_PERFORCE_MODE;
  } else {
    process.env.CLAUDE_CODE_PERFORCE_MODE = SAVED;
  }
});

describe("2.1.98 perforceReadOnlyError", () => {
  test("off by default (no env): never blocks", () => {
    delete process.env.CLAUDE_CODE_PERFORCE_MODE;
    expect(isPerforceMode()).toBe(false);
    // read-only mode 0o444
    expect(perforceReadOnlyError(0o444)).toBeNull();
  });

  test("on + read-only file (no owner-write bit): returns the p4 edit hint", () => {
    process.env.CLAUDE_CODE_PERFORCE_MODE = "1";
    expect(isPerforceMode()).toBe(true);
    const err = perforceReadOnlyError(0o444); // r--r--r--
    expect(err).not.toBeNull();
    expect(err).toContain("p4 edit");
    expect(err).toContain("read-only");
    expect(err).toContain("Do not chmod");
  });

  test("on + writable file (owner-write bit set): no error", () => {
    process.env.CLAUDE_CODE_PERFORCE_MODE = "1";
    expect(perforceReadOnlyError(0o644)).toBeNull(); // rw-r--r--
    expect(perforceReadOnlyError(0o755)).toBeNull(); // rwxr-xr-x
    expect(perforceReadOnlyError(0o600)).toBeNull(); // rw-------
  });

  test("on + mode 0 (no bits): blocks", () => {
    process.env.CLAUDE_CODE_PERFORCE_MODE = "1";
    expect(perforceReadOnlyError(0)).not.toBeNull();
  });

  test("off even when file is read-only", () => {
    delete process.env.CLAUDE_CODE_PERFORCE_MODE;
    expect(perforceReadOnlyError(0o444)).toBeNull();
  });
});
