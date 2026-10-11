import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.145 e2e: Read tool returns a truncated "PARTIAL view"
 * page (with a notice) on token-limit excess instead of throwing a hard
 * MaxFileReadTokenExceededError. Matches the binary's
 * Djt="[Truncated: PARTIAL view — ", Kct=2000.
 *
 * UPDATED (OCC-114 acceptance): the 2.1.296 #006 `allow_large` port (OCC-154,
 * commit 9d31a5f) relocated the PARTIAL-view notice builder + its byte-exact
 * strings from FileReadTool.ts into the new allowLarge.ts
 * (`buildPartialViewIfNeeded` → `buildTokenCapPartialView`), and replaced the
 * fixed 2000-line partial clamp with the official token-proportional budget
 * (`baseMaxTokens`, 0.85 share, 0.7 shrink). The 2000-line DEFAULT read cap
 * (Kct lineage) now lives in prompt.ts as `MAX_LINES_TO_READ = 2000`. The
 * FileReadTool.ts side keeps the integration pins (isPartialView /
 * truncatedByTokenCap / no-hard-throw text path). All notice strings were
 * re-verified byte-exact against the official 2.1.296 ELF (forensics only):
 * prefix @211781055, "showing lines 1-" @99766758, "showing the first "
 * @99358396, "for the next page" @99766877, "to find a specific section"
 * @99766909, "Do NOT answer from this page alone" @99226884, "cannot be
 * paginated by line" @99227011. The prior pins grepped the pre-#006 file and
 * left main CI red — this repoints them at the files that now hold the truth.
 */
describe("2.1.145 Read PARTIAL view (e2e)", () => {
  const FILE = `${REPO_ROOT}/src/tools/FileReadTool/FileReadTool.ts`;
  const ALLOW = `${REPO_ROOT}/src/tools/FileReadTool/allowLarge.ts`;
  const PROMPT = `${REPO_ROOT}/src/tools/FileReadTool/prompt.ts`;

  test("has the PARTIAL view prefix, line/char messages, and 2000-line cap", async () => {
    const script = `
const src = await Bun.file("${FILE}").text();
const allow = await Bun.file("${ALLOW}").text();
const prompt = await Bun.file("${PROMPT}").text();
console.log(JSON.stringify({
  prefix: allow.includes("[Truncated: PARTIAL view \\u2014 ") || allow.includes("[Truncated: PARTIAL view — "),
  lineMsg: allow.includes("showing lines 1-"),
  charMsg: allow.includes("showing the first "),
  cap: prompt.includes("MAX_LINES_TO_READ = 2000"),
  field: allow.includes("ALLOW_LARGE_FIELD_NAME = 'allow_large'"),
  builder: allow.includes("buildTokenCapPartialView") && src.includes("buildTokenCapPartialView"),
  isPartialView: src.includes("isPartialView: true"),
  truncatedByTokenCap: src.includes("truncatedByTokenCap"),
  noHardThrowOnTextPath: !/await validateContentTokens\\(content, ext, maxTokens\\)/.test(src),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.prefix).toBe(true);
    expect(out.lineMsg).toBe(true);
    expect(out.charMsg).toBe(true);
    expect(out.cap).toBe(true);
    expect(out.field).toBe(true);
    expect(out.builder).toBe(true);
    expect(out.isPartialView).toBe(true);
    expect(out.truncatedByTokenCap).toBe(true);
    // The text path must NOT still call the throwing validateContentTokens
    // (the notebook path keeps it; the text path replaces it with the builder).
    expect(out.noHardThrowOnTextPath).toBe(true);
  });

  test("line-based notice tells the model to page with Read offset/limit or Grep", async () => {
    const script = `
const allow = await Bun.file("${ALLOW}").text();
console.log(JSON.stringify({
  nextPage: allow.includes("for the next page"),
  grepHint: allow.includes("to find a specific section"),
  doNotAnswer: allow.includes("Do NOT answer from this page alone"),
  longLines: allow.includes("cannot be paginated by line"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.nextPage).toBe(true);
    expect(out.grepHint).toBe(true);
    expect(out.doNotAnswer).toBe(true);
    expect(out.longLines).toBe(true);
  });
});
