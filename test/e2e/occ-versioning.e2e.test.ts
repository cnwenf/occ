import { describe, expect, test } from "bun:test";
import { runOcc } from "./helpers";

// Read version from package.json so the assertion doesn't rot on each bump.
const { version } = require("../../package.json") as { version: string };

describe("occ --version", () => {
  test("prints OCC branding, not Claude Code", async () => {
    const res = await runOcc(["--version"], {}, 30_000);
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    expect(out).toContain("OCC");
    expect(out).not.toContain("Claude Code");
    expect(out).toContain(version);
  });
});
