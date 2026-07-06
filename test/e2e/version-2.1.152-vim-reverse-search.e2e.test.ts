import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.152: vim NORMAL-mode '/' opens reverse history search.
 *
 * Source-grep test: verifies '/' in NORMAL idle triggers onHistorySearch.
 *
 * Binary evidence:
 *   if(L.command.type==="idle"&&P.key==="/"&&a){a(),P.preventDefault();return}
 */
describe("2.1.152 vim '/' reverse history search (e2e)", () => {
  test("'/' dispatches onHistorySearch in transitions.ts fromIdle", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/transitions.ts", "utf8");
const checks = {
  slashCheck: src.includes("input === '/'") && src.includes("onHistorySearch"),
  onHistorySearchCtx: src.includes("onHistorySearch?: () => void"),
  inFromIdle: src.includes("input === '/' && ctx.onHistorySearch"),
};
console.log(JSON.stringify(checks));
const failed = Object.entries(checks).filter(([,v]) => !v);
if (failed.length) throw new Error("Missing: " + failed.map(([k]) => k).join(", "));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(Object.values(out).every(Boolean)).toBe(true);
  });

  test("onHistorySearch prop in useVimInput + textInputTypes", async () => {
    const script = `
const fs = await import("fs");
const hookSrc = fs.readFileSync("${REPO_ROOT}/src/hooks/useVimInput.ts", "utf8");
const typeSrc = fs.readFileSync("${REPO_ROOT}/src/types/textInputTypes.ts", "utf8");
const checks = {
  propInHook: hookSrc.includes("onHistorySearch?: () => void"),
  passedInCtx: hookSrc.includes("onHistorySearch,"),
  propInTypes: typeSrc.includes("onHistorySearch?: () => void"),
};
console.log(JSON.stringify(checks));
const failed = Object.entries(checks).filter(([,v]) => !v);
if (failed.length) throw new Error("Missing: " + failed.map(([k]) => k).join(", "));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(Object.values(out).every(Boolean)).toBe(true);
  });

  test("onHistorySearch wired in VimTextInput + PromptInput", async () => {
    const script = `
const fs = await import("fs");
const vimSrc = fs.readFileSync("${REPO_ROOT}/src/components/VimTextInput.tsx", "utf8");
const promptSrc = fs.readFileSync("${REPO_ROOT}/src/components/PromptInput/PromptInput.tsx", "utf8");
const checks = {
  vimTextInputPasses: vimSrc.includes("onHistorySearch: props.onHistorySearch"),
  promptInputWires: promptSrc.includes("onHistorySearch") && promptSrc.includes("setIsSearchingHistory(true)"),
};
console.log(JSON.stringify(checks));
const failed = Object.entries(checks).filter(([,v]) => !v);
if (failed.length) throw new Error("Missing: " + failed.map(([k]) => k).join(", "));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(Object.values(out).every(Boolean)).toBe(true);
  });

  test("parse check: no TDZ on import", async () => {
    const script = `
await import("${REPO_ROOT}/src/vim/transitions.ts");
await import("${REPO_ROOT}/src/hooks/useVimInput.ts");
await import("${REPO_ROOT}/src/components/VimTextInput.tsx");
console.log(JSON.stringify({ ok: true }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.ok).toBe(true);
  });
});
