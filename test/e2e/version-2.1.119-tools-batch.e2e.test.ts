import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.119 tools-batch e2e (source-grep): verifies three
 * tool-alignment gaps against the official 2.1.200 binary.
 *
 *   H9  — EnterWorktree `path` parameter (2.1.105): switch into an EXISTING
 *         worktree mid-session instead of always creating a new one.
 *   H11 — WebFetch truncates the raw HTML BEFORE markdown conversion (2.1.117)
 *         instead of truncating the markdown after conversion.
 *   H12 — TaskList returns tasks sorted by ID (2.1.119).
 *
 * Source-grep assertions only (no model credentials required).
 */
describe("2.1.119 tools-batch (source-grep)", () => {
  test("H9: EnterWorktree inputSchema has a `path` property + enter-existing branch", async () => {
    const script = `
import { readFileSync } from "fs";
const src = readFileSync("${REPO_ROOT}/src/tools/EnterWorktreeTool/EnterWorktreeTool.ts", "utf8");
const hasPathField = src.includes("path: z");
const hasPathDesc = src.includes("Path to an existing worktree of the current repository");
const hasEnterBranch = src.includes("enterExistingWorktree") && src.includes("tengu_worktree_entered_existing");
const hasAlreadyMsg = src.includes("to switch into another existing worktree");
console.log(JSON.stringify({ hasPathField, hasPathDesc, hasEnterBranch, hasAlreadyMsg }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasPathField).toBe(true);
    expect(out.hasPathDesc).toBe(true);
    expect(out.hasEnterBranch).toBe(true);
    expect(out.hasAlreadyMsg).toBe(true);
  });

  test("H11: WebFetch truncates raw HTML BEFORE markdown conversion", async () => {
    const script = `
import { readFileSync } from "fs";
const src = readFileSync("${REPO_ROOT}/src/tools/WebFetchTool/utils.ts", "utf8");
const sliceIdx = src.indexOf("htmlContent.slice(0, MAX_MARKDOWN_LENGTH)");
// Find the .turndown( CALL after the slice (an earlier match is a docstring
// comment in getTurndownService, not the conversion call).
const turndownIdx = sliceIdx > -1 ? src.indexOf(".turndown(", sliceIdx) : -1;
const hasHtmlTruncate = sliceIdx > -1;
const truncateBeforeConvert = sliceIdx > -1 && turndownIdx > -1;
console.log(JSON.stringify({ hasHtmlTruncate, truncateBeforeConvert, sliceIdx, turndownIdx }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasHtmlTruncate).toBe(true);
    expect(out.truncateBeforeConvert).toBe(true);
  });

  test("H12: TaskList sorts tasks by id", async () => {
    const script = `
import { readFileSync } from "fs";
const src = readFileSync("${REPO_ROOT}/src/tools/TaskListTool/TaskListTool.ts", "utf8");
const sortIdx = src.indexOf("tasks.sort(");
const sortBody = sortIdx > -1 ? src.slice(sortIdx, sortIdx + 220) : "";
const hasSortById = /Number\\(a\\.id\\)|Number\\(b\\.id\\)|a\\.id/.test(sortBody);
console.log(JSON.stringify({ sortIdx, hasSortById }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.sortIdx).toBeGreaterThan(-1);
    expect(out.hasSortById).toBe(true);
  });
});
