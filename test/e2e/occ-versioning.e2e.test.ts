import { describe, expect, test } from "bun:test";
import { REPO_ROOT, runOcc } from "./helpers";

// Read version from package.json so the assertion doesn't rot on each bump.
// REPO_ROOT-based (not `../../package.json`): inside the Docker e2e image this
// file is mounted at /test/e2e/, where a relative require resolves outside the
// repo — same container-structural fix as occ-update-argv (OCC-124 ledger).
const { version } = require(`${REPO_ROOT}/package.json`) as { version: string };

describe("occ --version", () => {
  test("prints OCC branding, not Claude Code", async () => {
    const res = await runOcc(["--version"], {}, 30_000);
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    expect(out).toContain("OCC");
    expect(out).not.toContain("Claude Code");
    expect(out).toContain(version);
  });
});
