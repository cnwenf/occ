import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettingsFile } from "../settings";

/**
 * M9 (Claude Code 2.1.214): guard against unbounded memory growth when a
 * settings file path points at a device file or multi-GB file. Oversized
 * (>2 MiB) settings files and non-regular files (e.g. a device file) must
 * fail at startup with a clear error instead of being read in full.
 *
 * Red-test: before the fix, parseSettingsFileUncached called readFileSync
 * directly with no size/regularity guard.
 */

const MAX = 2 * 1024 * 1024; // 2 MiB

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "occ-m9-"));
}

describe("M9 (2.1.214): settings file size/regularity guard", () => {
  test("a settings file larger than 2 MiB is rejected with a size error", () => {
    const dir = tmpDir();
    const big = join(dir, "big.json");
    // Valid JSON, but oversized (2.1 MiB). Guard fires on size, before parse.
    const padding = " ".repeat(MAX + 1024 - 2);
    writeFileSync(big, `{` + padding + `}`, "utf8");

    const { settings, errors } = parseSettingsFile(big);
    expect(settings).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message.toLowerCase()).toMatch(/too large|size|exceed|limit|big/);
  });

  test("a non-regular file (directory) is rejected, not read", () => {
    const dir = tmpDir();
    const sub = join(dir, "subdir");
    mkdirSync(sub);

    const { settings, errors } = parseSettingsFile(sub);
    expect(settings).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message.toLowerCase()).toMatch(/regular file|not a file|directory/);
  });

  test("a small valid settings file still parses (no regression)", () => {
    const dir = tmpDir();
    const small = join(dir, "small.json");
    writeFileSync(small, JSON.stringify({ permissions: { allow: ["Edit(src/**)"] } }), "utf8");

    const { settings, errors } = parseSettingsFile(small);
    expect(errors).toEqual([]);
    expect(settings).not.toBeNull();
    expect(settings?.permissions?.allow).toContain("Edit(src/**)");
  });

  test("a small malformed settings file returns a parse error, NOT a size error", () => {
    const dir = tmpDir();
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json", "utf8");

    const { errors } = parseSettingsFile(malformed);
    expect(errors.length).toBeGreaterThan(0);
    // Must not be mistaken for a size/regularity error.
    expect(errors[0]?.message.toLowerCase()).not.toMatch(/too large|regular file/);
  });
});
