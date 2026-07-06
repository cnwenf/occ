import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.118: vim visual mode (v) + visual-line mode (V).
 *
 * Source-grep test: verifies the VISUAL state machine, transition function,
 * and operator functions exist in src/vim/ and are wired in useVimInput.
 *
 * Binary evidence:
 *   - mode: "INSERT" | "NORMAL" | "VISUAL" | "VISUAL LINE"
 *   - {mode:"VISUAL",kind:$,anchor:P,command:{type:"idle"}}
 *   - if((W==="v"||W==="V")&&(command.type==="idle"||"count")){H(offset,kind)}
 */
describe("2.1.118 vim visual mode (e2e)", () => {
  test("VISUAL state + VisualKind in types.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/types.ts", "utf8");
const checks = {
  visualState: src.includes("mode: 'VISUAL'"),
  kind: src.includes("VisualKind"),
  anchor: src.includes("anchor: number"),
  visualKinds: src.includes("VISUAL_KINDS"),
  isVisualKindKey: src.includes("isVisualKindKey"),
  visualOp: src.includes("'visualOp'"),
  visualChange: src.includes("'visualChange'"),
  visualReplace: src.includes("'visualReplace'"),
  visualCase: src.includes("'visualCase'"),
  textObject: src.includes("type: 'textObject'"),
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

  test("transitionVisual + VisualTransitionResult in transitions.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/transitions.ts", "utf8");
const checks = {
  transitionVisual: src.includes("export function transitionVisual"),
  visualTransitionResult: src.includes("VisualTransitionResult"),
  fromVisualIdle: src.includes("fromVisualIdle"),
  fromVisualCount: src.includes("fromVisualCount"),
  handleVisualOperatorInput: src.includes("handleVisualOperatorInput"),
  toggleKind: src.includes("toggleKind"),
  swap: src.includes("exit: 'swap'"),
  selectRange: src.includes("exit: 'selectRange'"),
  onHistorySearch: src.includes("onHistorySearch"),
  slashDispatch: src.includes("input === '/'"),
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

  test("visual operators in operators.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/vim/operators.ts", "utf8");
const checks = {
  getVisualRange: src.includes("export function getVisualRange"),
  executeVisualOperator: src.includes("export function executeVisualOperator"),
  executeVisualReplace: src.includes("export function executeVisualReplace"),
  executeVisualCase: src.includes("export function executeVisualCase"),
  getVisualSpan: src.includes("export function getVisualSpan"),
  replayVisualOp: src.includes("export function replayVisualOp"),
  replayVisualChange: src.includes("export function replayVisualChange"),
  executeVisualPaste: src.includes("export function executeVisualPaste"),
  linewiseChange: src.includes("linewise && op === 'change'"),
  linewiseDelete: src.includes("linewise && op === 'delete'"),
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

  test("VISUAL mode wired in useVimInput.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/hooks/useVimInput.ts", "utf8");
const checks = {
  enterVisual: src.includes("enterVisual"),
  exitVisual: src.includes("exitVisual"),
  visualMode: src.includes("state.mode === 'VISUAL'"),
  transitionVisualCall: src.includes("transitionVisual(state.command"),
  vVEntry: src.includes("isVisualKindKey(vimInput)"),
  visualKindsRef: src.includes("VISUAL_KINDS[vimInput]"),
  visualChangeDotRepeat: src.includes("visualOp") && src.includes("visualChange"),
  onHistorySearchProp: src.includes("onHistorySearch"),
  escapeVisual: src.includes("escape") && src.includes("VISUAL"),
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

  test("VimMode includes VISUAL in textInputTypes.ts", async () => {
    const script = `
const fs = await import("fs");
const src = fs.readFileSync("${REPO_ROOT}/src/types/textInputTypes.ts", "utf8");
const checks = {
  visual: src.includes("'VISUAL'"),
  visualLine: src.includes("'VISUAL LINE'"),
  onHistorySearch: src.includes("onHistorySearch"),
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
await import("${REPO_ROOT}/src/vim/types.ts");
await import("${REPO_ROOT}/src/vim/transitions.ts");
await import("${REPO_ROOT}/src/vim/operators.ts");
await import("${REPO_ROOT}/src/hooks/useVimInput.ts");
console.log(JSON.stringify({ ok: true }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.ok).toBe(true);
  });
});
