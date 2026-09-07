import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const readSrc = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");

/**
 * OCC-118 self-acceptance gap fixes — onboarding confirmation-dialog parity with
 * official claude-code 2.1.263. Byte-level forensics on the official binary show
 * all three onboarding confirmations render through a dedicated component with
 * `hideIndexes:!0` (no "1./2." number gutter), and the folder-trust dialog uses
 * `cancelFirst:!0, focus:"cancel"` so the cursor defaults to the safe "No, exit".
 *
 * Official 2.1.263 evidence:
 *  - Trust:   e(En,{hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:"Yes, I trust this folder",cancelLabel:…"No, exit"})
 *  - Bypass:  e(En,{hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:"Yes, I accept",cancelLabel:"No, exit"})
 *  - ApiKey:  e(En,{hideIndexes:!0,focus:"cancel",…onConfirm:()=>"yes",onCancel:()=>"no"})
 */
describe("OCC-118: onboarding confirmation dialogs match official 2.1.263", () => {
  test("TrustDialog defaults to the safe 'No, exit' (cancel-first) + hides indexes", () => {
    const src = readSrc("src/components/TrustDialog/TrustDialog.tsx");
    // "No, exit" must be the FIRST option (default cursor) — matches cancelFirst/focus:cancel
    const noExitIdx = src.indexOf('label: "No, exit"');
    const trustIdx = src.indexOf('label: "Yes, I trust this folder"');
    expect(noExitIdx).toBeGreaterThan(-1);
    expect(trustIdx).toBeGreaterThan(-1);
    expect(noExitIdx).toBeLessThan(trustIdx);
    // No number gutter, matching official hideIndexes:!0
    expect(src).toMatch(/<Select[^>]*hideIndexes=\{true\}/);
  });

  test("BypassPermissionsModeDialog hides indexes (official hideIndexes:!0)", () => {
    const src = readSrc("src/components/BypassPermissionsModeDialog.tsx");
    expect(src).toMatch(/<Select[^>]*hideIndexes=\{true\}/);
    // Order already cancel-first: "No, exit" before "Yes, I accept"
    expect(src.indexOf('label: "No, exit"')).toBeLessThan(src.indexOf('label: "Yes, I accept"'));
  });

  test("ApproveApiKey hides indexes + focuses 'No (recommended)' without a selected tick", () => {
    const src = readSrc("src/components/ApproveApiKey.tsx");
    expect(src).toMatch(/<Select[^>]*hideIndexes=\{true\}/);
    expect(src).toContain('defaultFocusValue="no"');
    // Official En renders focus:"cancel" only — no pre-selected value, so no ✔ tick.
    expect(src).not.toContain("defaultValue=");
  });
});
