import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.191 e2e: /rewind can resume from BEFORE a /clear.
 *
 * /clear preserves the pre-clear conversation on disk as a previous session;
 * /rewind surfaces it as the "previous-session entry at the top" and restores
 * the pre-/clear conversation. The situation descriptor below is the exact
 * wording the 2.1.200 binary uses for the rewind-past-clear proactive
 * suggestion (grep-verified).
 */
describe("2.1.191 /rewind resume from before /clear (e2e)", () => {
  test("rewind-past-clear situation matches official binary wording exactly", async () => {
    const script = `
import { rewindPastClearSituation } from "${REPO_ROOT}/src/commands/rewind/index.ts";
console.log(JSON.stringify(rewindPastClearSituation));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.id).toBe("rewind-past-clear");
    expect(out.situation).toContain("User ran /clear earlier this session");
    expect(out.situation).toContain("before I cleared we had X");
    expect(out.situation).toContain("undo a /clear");
    expect(out.situation).toContain("Do NOT match regret about file edits");
    expect(out.feature).toBe("/rewind can take you back to before /clear — pick the previous-session entry to restore the pre-/clear conversation.");
    expect(out.action).toBe("Press Esc twice or type /rewind, then pick the previous-session entry at the top");
  });

  test("rewind exports pre-clear resume helpers", async () => {
    const script = `
import * as rewind from "${REPO_ROOT}/src/commands/rewind/index.ts";
console.log(JSON.stringify({
  find: typeof rewind.findPreClearSession,
  load: typeof rewind.loadPreClearMessages,
  resume: typeof rewind.resumeFromBeforeClear,
  path: typeof rewind.preClearTranscriptPath,
  read: typeof rewind.readPreClearTranscript,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.find).toBe("function");
    expect(out.load).toBe("function");
    expect(out.resume).toBe("function");
    expect(out.path).toBe("function");
    expect(out.read).toBe("function");
  });

  test("preClearTranscriptPath resolves a .jsonl path for a prior session", async () => {
    const script = `
import { preClearTranscriptPath } from "${REPO_ROOT}/src/commands/rewind/index.ts";
const p = preClearTranscriptPath("11111111-2222-3333-4444-555555555555");
console.log(JSON.stringify({ path: p }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.path.endsWith(".jsonl")).toBe(true);
    expect(out.path).toContain("11111111-2222-3333-4444-555555555555");
  });
});
