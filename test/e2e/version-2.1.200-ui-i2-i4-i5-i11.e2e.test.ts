import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const readSrc = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");

/**
 * claude-code 2.1.200 UI gaps (I2, I4, I5, I11) — source-grep e2e.
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   I2  (2.1.149): /diff detail view keyboard-scrollable — byline gains a
 *                  "scroll" hint; ↑/↓ (and PgUp/PgDn) scroll the detail content.
 *   I4  (2.1.111): after Ctrl+U clears 3+ chars, a "Ctrl+Y to paste deleted
 *                  text" hint surfaces (official kill-paste-hint, prepend,
 *                  timeoutMs 5000). Ctrl+U clears the buffer; Ctrl+Y yanks it.
 *   I5  (cross):   "Yes, and switch to auto mode" permission-prompt option
 *                  (value "yes-enable-auto-mode", description
 *                  "· workflows run best with it on") offered for
 *                  workflow-agent contexts; selecting it switches to auto.
 *   I11 (cross):   "Auto (match terminal)" theme option is un-gated (always
 *                  first in the picker; official Q={label,value:"auto"}).
 */

describe("I2 (2.1.149): /diff detail view keyboard-scrollable", () => {
  const src = readSrc("src/components/diff/DiffDialog.tsx");

  test("detail byline gains a scroll hint", () => {
    // Detail-mode byline: ↑/↓ scroll, ← back, esc close (mirrors official
    // "scroll" / "back" / "close" byline parts).
    expect(src).toContain("↑/↓ scroll");
    expect(src).toContain("← back");
  });

  test("detail content is wrapped in a ScrollBox with a constrained viewport", () => {
    expect(src).toContain("ScrollBox");
    expect(src).toMatch(/ref=\{scrollRef\}/);
    // Height is derived from terminal rows so the viewport is constrained
    // (ScrollBox culls content outside [scrollTop, scrollTop+height]).
    expect(src).toMatch(/height=\{Math\.max\(3,\s*terminalRows\s*-\s*8\)\}/);
  });

  test("↑/↓ scroll the detail view (reusing diff:previousFile/nextFile handlers)", () => {
    // In detail mode the up/down handlers scroll instead of navigating files.
    expect(src).toMatch(/scrollRef\.current\?\.scrollBy\(-1\)/);
    expect(src).toMatch(/scrollRef\.current\?\.scrollBy\(1\)/);
  });

  test("PgUp/PgDn scroll by a viewport", () => {
    expect(src).toContain("key.pageUp");
    expect(src).toContain("key.pageDown");
    expect(src).toMatch(/scrollRef\.current\?\.scrollBy\(/);
  });

  test("scroll resets to top when the viewed file/source changes", () => {
    expect(src).toMatch(/scrollRef\.current\?\.scrollTo\(0\)/);
  });
});

describe("I4 (2.1.111): Ctrl+U clear + Ctrl+Y restore (kill-paste-hint)", () => {
  const src = readSrc("src/hooks/useTextInput.ts");

  test("Ctrl+U (killToLineStart) surfaces the Ctrl+Y paste hint for 3+ chars", () => {
    // Official kill-paste-hint: key, text, priority immediate, timeoutMs 5000.
    expect(src).toContain("'kill-paste-hint'");
    expect(src).toContain("'Ctrl+Y to paste deleted text'");
    expect(src).toContain("priority: 'immediate'");
    expect(src).toContain("timeoutMs: 5000");
    // Only fires when 3+ chars were killed (mirrors ue.length>=3).
    expect(src).toMatch(/killed\.length\s*>=\s*3/);
  });

  test("Ctrl+U clears the buffer (deleteToLineStart) and Ctrl+Y yanks (kill ring)", () => {
    // Ctrl+U → killToLineStart (prepend to kill ring); Ctrl+Y → yank (getLastKill).
    // 2.1.200: Ctrl+U is NOOP'd in fullscreen (yields to scroll:halfPageUp);
    // killToLineStart is the non-fullscreen fallback.
    expect(src).toMatch(/\['u',.*killToLineStart\]/);
    expect(src).toMatch(/\['y',\s*yank\]/);
    expect(src).toContain("pushToKillRing(killed, 'prepend')");
    expect(src).toContain("getLastKill()");
  });
});

describe("I5 (cross): 'Yes, and switch to auto mode' permission option", () => {
  const opts = readSrc(
    "src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx",
  );
  const req = readSrc(
    "src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx",
  );

  test("option builder exposes the auto-mode option with official copy", () => {
    // Official SSr/ESr: label "Yes, and switch to auto mode", description
    // "· workflows run best with it on", value "yes-enable-auto-mode".
    expect(opts).toContain("'Yes, and switch to auto mode'");
    expect(opts).toContain("'· workflows run best with it on'");
    expect(opts).toContain("'yes-enable-auto-mode'");
    expect(opts).toContain("showEnableAutoModeOption");
  });

  test("option value is part of the BashToolUseOption union", () => {
    expect(opts).toMatch(/yes-enable-auto-mode/);
  });

  test("BashPermissionRequest offers the option for workflow-agent contexts", () => {
    // canOfferAutoMode gates the option (workerBadge = workflow-agent signal,
    // mode !== 'auto' so it isn't offered when already in auto).
    expect(req).toContain("canOfferAutoMode");
    expect(req).toMatch(/workerBadge.*toolPermissionContext\.mode !== 'auto'/);
    expect(req).toContain("showEnableAutoModeOption: canOfferAutoMode");
  });

  test("selecting the option switches the session to auto mode", () => {
    // Mirrors official enableAutoMode: a setMode:auto permission update is
    // applied (allowing this call + switching the mode for subsequent prompts).
    expect(req).toContain("'yes-enable-auto-mode'");
    expect(req).toMatch(/type:\s*'setMode'/);
    expect(req).toMatch(/mode:\s*'auto'/);
  });
});

describe("I11 (cross): 'Auto (match terminal)' theme option un-gated", () => {
  const src = readSrc("src/components/ThemePicker.tsx");

  test("Auto option is always present (not behind a feature flag)", () => {
    // Official Q={label:"Auto (match terminal)",value:"auto"} is un-gated.
    // The feature("AUTO_THEME") ternary that hid it is removed.
    expect(src).toContain('"Auto (match terminal)"');
    expect(src).toContain('value: "auto" as const');
    expect(src).not.toContain("AUTO_THEME");
  });

  test("Auto option is first in the picker order", () => {
    // The options array literal starts with the Auto entry.
    expect(src).toMatch(/\[\{[\s\S]*label: "Auto \(match terminal\)"[\s\S]*value: "auto" as const[\s\S]*\},\s*\{[\s\S]*label: "Dark mode"/);
  });

  test("'auto' is a resolvable ThemeSetting (ThemeProvider follows the terminal)", () => {
    const provider = readSrc("src/components/design-system/ThemeProvider.tsx");
    expect(provider).toContain("themeSetting");
    expect(provider).toContain("'auto'");
    expect(provider).toContain("getSystemThemeName");
  });
});

describe("UI gaps I2/I4/I5/I11 parse check (no TDZ)", () => {
  test("all touched modules import cleanly", async () => {
    const script = `
await Promise.all([
  import("${REPO_ROOT}/src/components/diff/DiffDialog.tsx"),
  import("${REPO_ROOT}/src/hooks/useTextInput.ts"),
  import("${REPO_ROOT}/src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx"),
  import("${REPO_ROOT}/src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx"),
  import("${REPO_ROOT}/src/components/ThemePicker.tsx"),
  import("${REPO_ROOT}/src/components/design-system/ThemeProvider.tsx"),
]);
console.log("OK");
`;
    const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim();
    expect(out).toBe("OK");
  });
});
