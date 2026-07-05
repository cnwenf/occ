import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.98 e2e (Docker):
 *   1. /export resolves absolute paths + ~ and preserves user extensions
 *   2. CLAUDE_CODE_PERFORCE_MODE blocks read-only files with a `p4 edit` hint
 */
async function run(script: string): Promise<any> {
  const result = await $`bun -e ${script}`.quiet();
  return JSON.parse(result.stdout.toString().trim());
}

describe("2.1.98 /export path resolution (e2e)", () => {
  test("absolute path + .md extension preserved", async () => {
    const script = `
import { resolveExportFilepath } from "${REPO_ROOT}/src/commands/export/export.tsx";
console.log(JSON.stringify({ p: resolveExportFilepath("/tmp/abs-notes.md") }));
`;
    expect((await run(script)).p).toBe("/tmp/abs-notes.md");
  });

  test("~ expanded, .txt appended when no extension", async () => {
    const script = `
import { resolveExportFilepath } from "${REPO_ROOT}/src/commands/export/export.tsx";
console.log(JSON.stringify({ p: resolveExportFilepath("~/conversation") }));
`;
    expect((await run(script)).p).toBe(join(homedir(), "conversation.txt"));
  });
});

describe("2.1.98 CLAUDE_CODE_PERFORCE_MODE (e2e)", () => {
  test("read-only file blocked with p4 edit hint when mode is on", async () => {
    const script = `
process.env.CLAUDE_CODE_PERFORCE_MODE = "1";
const { perforceReadOnlyError } = await import("${REPO_ROOT}/src/utils/perforce.ts");
console.log(JSON.stringify({
  ro: perforceReadOnlyError(0o444),
  rw: perforceReadOnlyError(0o644),
}));
`;
    const out = await run(script);
    expect(out.ro).toContain("p4 edit");
    expect(out.rw).toBeNull();
  });
});
