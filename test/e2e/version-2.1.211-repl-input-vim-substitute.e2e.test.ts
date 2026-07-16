import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * CC 2.1.211 — three fixes ported in this test file:
 *
 * (a) "Fixed edits that leave the input as ? being silently swallowed
 *      and toggling the shortcuts panel."
 * (b) "Fixed a 300ms delay revealing async content (Settings tabs, Stats,
 *      diff views, and other loading states)."
 * (c) "Changed Vim mode s and S (substitute char/line) to work in NORMAL
 *      mode, matching vim behavior."
 *
 * Source-grep tests verify the real code paths exist and are wired correctly.
 * Binary evidence from 2.1.211 binary:
 *   (a) `mo=fi.useCallback(()=>{O("tengu_help_toggled",{}),ke((Bt)=>!Bt)},[])` —
 *       separate toggleHelp callback; onChange no longer checks `value === '?'`.
 *       Non-vim: `Bt.key==="?"&&Z===""` (only when input empty).
 *       Vim: `B.command.type==="idle"&&j.key==="?"&&l){l(),...}` (onToggleHelp).
 *   (b) `useDeferredValue` + `setTimeout(300)` pattern removed.
 *   (c) `s:(e,t)=>({execute:()=>fPo(e,t)})` — substitute char (delete char, enter insert).
 *       `S:(e,t)=>({execute:()=>KOt("change",e,t)})` — substitute line (= cc).
 *       `fPo`: delete count chars at cursor, recordChange type "substitute", enterInsert.
 */

describe("2.1.211 REPL input + vim substitute (e2e)", () => {
  // === (a) "?" swallow fix ===

  test("(a) onChange no longer unconditionally swallows '?'", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/components/PromptInput/PromptInput.tsx", "utf8");
const checks = {
  // The old pattern: if (value === '?') { toggle; return; } — must be gone
  oldSwallowGone: !src.includes("if (value === '?')"),
  // New pattern: only toggle when input was empty (prevents edit swallow)
  inputEmptyGuard: src.includes("input === ''") && src.includes("'?'"),
  // toggleHelp callback exists
  toggleHelpExists: src.includes("tengu_help_toggled"),
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

  test("(a) onToggleHelp prop wired through vim chain", async () => {
    const script = `
const fs = await import("fs");
const typesSrc = fs.readFileSync("${REPO_ROOT}/src/types/textInputTypes.ts", "utf8");
const hookSrc = fs.readFileSync("${REPO_ROOT}/src/hooks/useVimInput.ts", "utf8");
const vimSrc = fs.readFileSync("${REPO_ROOT}/src/components/VimTextInput.tsx", "utf8");
const promptSrc = fs.readFileSync("${REPO_ROOT}/src/components/PromptInput/PromptInput.tsx", "utf8");
const checks = {
  typeDefined: typesSrc.includes("onToggleHelp?: () => void"),
  hookHasProp: hookSrc.includes("onToggleHelp"),
  hookCallsToggle: hookSrc.includes("onToggleHelp?.()"),
  vimPasses: vimSrc.includes("onToggleHelp"),
  promptWires: promptSrc.includes("onToggleHelp"),
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

  test("(a) vim handler calls onToggleHelp instead of onChange('?')", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/hooks/useVimInput.ts", "utf8");
const checks = {
  // Old pattern must be gone: props.onChange('?') in the ? handler
  oldOnChangeGone: !src.includes("props.onChange('?')"),
  // New pattern: calls onToggleHelp
  callsOnToggleHelp: src.includes("onToggleHelp?.()"),
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

  // === (b) 300ms delay fix ===

  test("(b) LogSelector no longer has 300ms setTimeout delay", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/components/LogSelector.tsx", "utf8");
const checks = {
  // The old 300ms delay must be gone
  delayGone: !src.includes("setTimeout(setDebouncedDeepSearchQuery, 300"),
  // useDeferredValue still present (provides React-level deferral without artificial delay)
  deferredValuePresent: src.includes("useDeferredValue"),
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

  // === (c) Vim s/S substitute in NORMAL mode ===

  test("(c) s and S handled in NORMAL mode handleNormalInput", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/transitions.ts", "utf8");
const checks = {
  // s = substitute char (delete char, enter insert) — must be in handleNormalInput
  sHandled: src.includes("input === 's'") && src.includes("executeSubstitute"),
  // S = substitute line (= cc, line-wise change) — must be in handleNormalInput
  sUpperHandled: src.includes("input === 'S'") && src.includes("executeLineOp"),
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

  test("(c) executeSubstitute operator exists in operators.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/operators.ts", "utf8");
const checks = {
  functionExists: src.includes("export function executeSubstitute"),
  // Must delete chars at cursor and enter insert mode
  entersInsert: src.includes("enterInsert"),
  // Must record change as type "substitute"
  recordsSubstitute: src.includes("type: 'substitute'"),
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

  test("(c) substitute type in RecordedChange + replayLastChange", async () => {
    const script = `
const fs = await import("fs");
const typesSrc = fs.readFileSync("${REPO_ROOT}/src/vim/types.ts", "utf8");
const hookSrc = fs.readFileSync("${REPO_ROOT}/src/hooks/useVimInput.ts", "utf8");
const checks = {
  typeInRecordedChange: typesSrc.includes("type: 'substitute'") && typesSrc.includes("count: number"),
  replayCase: hookSrc.includes("case 'substitute'"),
  replayCallsExecute: hookSrc.includes("executeSubstitute"),
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
});
