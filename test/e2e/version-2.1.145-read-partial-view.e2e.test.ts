import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.145 e2e: Read tool returns a truncated "PARTIAL view"
 * page (with a notice) on token-limit excess instead of throwing a hard
 * MaxFileReadTokenExceededError. Matches the binary's
 * Djt="[Truncated: PARTIAL view — ", Kct=2000.
 */
describe("2.1.145 Read PARTIAL view (e2e)", () => {
  const FILE = `${REPO_ROOT}/src/tools/FileReadTool/FileReadTool.ts`;

  test("has the PARTIAL view prefix, line/char messages, and 2000-line cap", async () => {
    const script = `
const src = await Bun.file("${FILE}").text();
console.log(JSON.stringify({
  prefix: src.includes("[Truncated: PARTIAL view \\u2014 ") || src.includes("[Truncated: PARTIAL view — "),
  lineMsg: src.includes("showing lines 1-"),
  charMsg: src.includes("showing the first "),
  cap: src.includes("PARTIAL_VIEW_MAX_LINES = 2000"),
  builder: src.includes("buildPartialViewIfNeeded"),
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
    expect(out.builder).toBe(true);
    expect(out.isPartialView).toBe(true);
    expect(out.truncatedByTokenCap).toBe(true);
    // The text path must NOT still call the throwing validateContentTokens
    // (the notebook path keeps it; the text path replaces it with the builder).
    expect(out.noHardThrowOnTextPath).toBe(true);
  });

  test("line-based notice tells the model to page with Read offset/limit or Grep", async () => {
    const script = `
const src = await Bun.file("${FILE}").text();
console.log(JSON.stringify({
  nextPage: src.includes("for the next page"),
  grepHint: src.includes("to find a specific section"),
  doNotAnswer: src.includes("Do NOT answer from this page alone"),
  longLines: src.includes("cannot be paginated by line"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.nextPage).toBe(true);
    expect(out.grepHint).toBe(true);
    expect(out.doNotAnswer).toBe(true);
    expect(out.longLines).toBe(true);
  });
});
