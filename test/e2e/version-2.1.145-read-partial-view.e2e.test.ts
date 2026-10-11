import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.145 e2e: Read tool returns a truncated "PARTIAL view"
 * page (with a notice) on token-limit excess instead of throwing a hard
 * MaxFileReadTokenExceededError.
 *
 * Updated for the OCC-154 #006 Slice A+B official reconciliation: the
 * PARTIAL-notice builder moved from FileReadTool.ts to
 * src/tools/FileReadTool/allowLarge.ts, and the 2.1.145-era symbols
 * `PARTIAL_VIEW_MAX_LINES = 2000` / `buildPartialViewIfNeeded` were replaced
 * by the official token-cap surface (`ALLOW_LARGE_FIELD_NAME` /
 * `buildTokenCapPartialView` / `PARTIAL_VIEW_PREFIX`). Notice and builder
 * pins now grep allowLarge.ts; the tool-integration pins (isPartialView /
 * truncatedByTokenCap / no hard throw on the text path) still grep
 * FileReadTool.ts, which keeps them.
 */
describe("2.1.145 Read PARTIAL view (e2e)", () => {
  const NOTICE = `${REPO_ROOT}/src/tools/FileReadTool/allowLarge.ts`;
  const TOOL = `${REPO_ROOT}/src/tools/FileReadTool/FileReadTool.ts`;

  test("has the PARTIAL view prefix, line/char messages, allow_large field, and token-cap builder", async () => {
    const script = `
const notice = await Bun.file("${NOTICE}").text();
const tool = await Bun.file("${TOOL}").text();
console.log(JSON.stringify({
  prefix: notice.includes("[Truncated: PARTIAL view \\u2014 ") || notice.includes("[Truncated: PARTIAL view — "),
  lineMsg: notice.includes("showing lines 1-"),
  charMsg: notice.includes("showing the first "),
  field: notice.includes("ALLOW_LARGE_FIELD_NAME = 'allow_large'"),
  builder: notice.includes("export function buildTokenCapPartialView"),
  isPartialView: tool.includes("isPartialView: true"),
  truncatedByTokenCap: tool.includes("truncatedByTokenCap"),
  noHardThrowOnTextPath: !/await validateContentTokens\\(content, ext, maxTokens\\)/.test(tool),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.prefix).toBe(true);
    expect(out.lineMsg).toBe(true);
    expect(out.charMsg).toBe(true);
    expect(out.field).toBe(true);
    expect(out.builder).toBe(true);
    expect(out.isPartialView).toBe(true);
    expect(out.truncatedByTokenCap).toBe(true);
    // The text path must NOT still call the throwing validateContentTokens
    // (the notebook path in FileReadTool.ts keeps it for cellsJson; the text
    // path goes through the allowLarge.ts token-cap builder instead).
    expect(out.noHardThrowOnTextPath).toBe(true);
  });

  test("line-based notice tells the model to page with Read offset/limit or Grep", async () => {
    const script = `
const notice = await Bun.file("${NOTICE}").text();
console.log(JSON.stringify({
  nextPage: notice.includes("for the next page"),
  grepHint: notice.includes("to find a specific section"),
  doNotAnswer: notice.includes("Do NOT answer from this page alone"),
  longLines: notice.includes("cannot be paginated by line"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.nextPage).toBe(true);
    expect(out.grepHint).toBe(true);
    expect(out.doNotAnswer).toBe(true);
    expect(out.longLines).toBe(true);
  });
});
