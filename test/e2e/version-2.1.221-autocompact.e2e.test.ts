import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runOcc, tempDir } from "./helpers";

/**
 * 2.1.221 gap: official SILENTLY added the `--autocompact <auto|tokens>` CLI
 * flag + the `autoCompactWindow` settings key + the non-interactive
 * `/autocompact [auto|<tokens>]` command (no changelog entry). Discovered by
 * the OCC-58 acceptance round via a binary --help surface diff (the flag is
 * present in the 2.1.221/2.1.223 ELFs and absent from 2.1.218/2.1.219/2.1.220).
 *
 * All asserted strings are byte-verified from the official 2.1.223 linux-x64
 * ELF (argParser error, setter messages, env-precedence message, describe
 * output). Runs against the BUILT dist/cli.js with an isolated HOME so the
 * settings persistence is asserted on a temp settings.json.
 *
 * Gated out of CI (needs model creds for the round-trip cases).
 */

const CLEAN_ENV = {
  // Never let the host's own env window leak into precedence assertions.
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "",
} as Record<string, string>;

describe.skipIf(!!process.env.CI)("2.1.221 --autocompact flag (e2e)", () => {
  test("--help shows the official flag description", async () => {
    const res = await runOcc(["--help"], CLEAN_ENV, 30_000);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("--autocompact <auto|tokens>");
    expect(res.stdout).toContain(
      "Auto-compact window size (auto, or 100k–1M tokens)",
    );
  });

  test("invalid value is rejected with the official error message", async () => {
    for (const bad of ["bogus", "99", "5000000"]) {
      const res = await runOcc(
        ["--autocompact", bad, "-p", "hi"],
        CLEAN_ENV,
        30_000,
      );
      expect(res.code).not.toBe(0);
      const combined = `${res.stdout}${res.stderr}`;
      expect(combined).toContain(
        "It must be 'auto', or between 100k and 1M (e.g. 500k, 200000, or 200 as shorthand)",
      );
    }
  });

  test("--autocompact 500k runs a real session (flag is wired, not inert)", async () => {
    const res = await runOcc(
      ["--autocompact", "500k", "-p", "say OK"],
      CLEAN_ENV,
      120_000,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  test("--autocompact auto is accepted", async () => {
    const res = await runOcc(
      ["--autocompact", "auto", "-p", "say YES"],
      CLEAN_ENV,
      120_000,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("YES");
  });
});

describe.skipIf(!!process.env.CI)("2.1.221 /autocompact non-interactive (e2e)", () => {
  test("no args describes the current window (auto default)", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "/autocompact"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Auto-compact window: auto");
      expect(res.stdout).toContain(
        "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.",
      );
    } finally {
      cleanup();
    }
  });

  test("set / describe / reset round-trip persists to settings.json", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // Set 500k — official setter message (with or without the model-cap
      // suffix depending on the endpoint model's window).
      const set = await runOcc(
        ["-p", "/autocompact 500k"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(set.code).toBe(0);
      expect(set.stdout).toContain("Auto-compact window set to 500k tokens");

      const settingsPath = join(dir, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(saved.autoCompactWindow).toBe(500000);

      // Describe now reports the settings source.
      const describe = await runOcc(
        ["-p", "/autocompact"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(describe.stdout).toContain("(from settings)");

      // "reset" clears the override back to auto.
      const reset = await runOcc(
        ["-p", "/autocompact reset"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(reset.stdout).toContain("Auto-compact window set to auto");
      const afterReset = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(afterReset.autoCompactWindow).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("bare shorthand 200 means 200k tokens", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "/autocompact 200"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Auto-compact window set to 200k tokens");
    } finally {
      cleanup();
    }
  });

  test("unparseable value returns the official error text", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "/autocompact 99999999"],
        { ...CLEAN_ENV, HOME: dir },
        60_000,
      );
      expect(res.stdout).toContain(
        "Couldn't parse '99999999'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
      );
    } finally {
      cleanup();
    }
  });

  test("CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const set = await runOcc(
        ["-p", "/autocompact 300k"],
        { ...CLEAN_ENV, HOME: dir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000" },
        60_000,
      );
      expect(set.stdout).toContain(
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.",
      );

      const describe = await runOcc(
        ["-p", "/autocompact"],
        { ...CLEAN_ENV, HOME: dir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000" },
        60_000,
      );
      expect(describe.stdout).toContain(
        "tokens (from CLAUDE_CODE_AUTO_COMPACT_WINDOW)",
      );
    } finally {
      cleanup();
    }
  });
});
