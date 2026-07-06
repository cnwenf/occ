import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.162 e2e: LSP workspaceSymbol operation takes a `query`
 * parameter (schema) and passes it through to workspace/symbol instead of
 * hardcoding query:''. Matches the binary:
 *   query:A.string().optional().describe("The symbol name or partial name
 *   to search for (workspaceSymbol only). Most language servers return no
 *   results for an empty query, so always provide it when using workspaceSymbol.")
 */
describe("2.1.162 LSP workspaceSymbol query (e2e)", () => {
  test("schema has the query param with the binary's description", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/tools/LSPTool/schemas.ts").text();
console.log(JSON.stringify({
  hasQuery: src.includes("query:") && src.includes(".optional()"),
  desc: src.includes("workspaceSymbol only"),
  emptyQueryNote: src.includes("Most language servers return no results for an empty query"),
  alwaysProvide: src.includes("always provide it when using workspaceSymbol"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasQuery).toBe(true);
    expect(out.desc).toBe(true);
    expect(out.emptyQueryNote).toBe(true);
    expect(out.alwaysProvide).toBe(true);
  });

  test("LSPTool passes input.query through instead of hardcoding ''", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/tools/LSPTool/LSPTool.ts").text();
console.log(JSON.stringify({
  passesQuery: src.includes("input.query ?? ''"),
  noHardcodedEmpty: !src.includes("query: '', // Empty query returns all symbols"),
  method: src.includes("workspace/symbol"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.passesQuery).toBe(true);
    expect(out.noHardcodedEmpty).toBe(true);
    expect(out.method).toBe(true);
  });

  test("prompt documents the query parameter", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/tools/LSPTool/prompt.ts").text();
console.log(JSON.stringify({
  hasQueryDoc: src.includes("- query: The symbol name or partial name to search for"),
  emptyQueryNote: src.includes("no results for an empty query"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasQueryDoc).toBe(true);
    expect(out.emptyQueryNote).toBe(true);
  });
});
