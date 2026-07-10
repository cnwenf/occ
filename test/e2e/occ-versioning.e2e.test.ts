import { describe, expect, test } from "bun:test";
import { runOcc } from "./helpers";

describe("occ --version", () => {
  test("prints OCC branding, not Claude Code", async () => {
    const res = await runOcc(["--version"], {}, 30_000);
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    expect(out).toContain("OCC");
    expect(out).not.toContain("Claude Code");
    expect(out).toContain("2.1.204");
  });
});
