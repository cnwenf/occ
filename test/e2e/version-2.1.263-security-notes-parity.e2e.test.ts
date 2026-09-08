import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const readSrc = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");

/**
 * OCC-119 self-acceptance gap fix (Gap-119a) — onboarding security-notes copy
 * parity with official claude-code 2.1.263. Byte-level forensics on the official
 * linux-x64 ELF recovered the security step verbatim:
 *
 *   e(t,{bold:!0,children:"Security notes:"}),
 *   e(o,{flexDirection:"column",width:70,children:r(W,{children:[
 *     r(W.Item,{children:[
 *       e(t,{children:"Claude can make mistakes."}),
 *       r(t,{dimColor:!0,wrap:"wrap",children:[
 *         "You're responsible for Claude's actions and should always",
 *         e(WS,{}),
 *         "review them, especially when running code.",
 *         e(WS,{})]})]}),
 *     r(W.Item,{children:[
 *       e(t,{children:"Due to prompt injection risks, only use it with code you trust"}),
 *       e(Wf,{url:"https://code.claude.com/docs/en/security"})]})]})}),
 *
 * where Wf (LearnMore) renders: Text dimColor ["Learn more: ", Link(url)] on one line.
 * Live A/B render (official, 200x50 tmux):
 *
 *   1. Claude can make mistakes.
 *      You're responsible for Claude's actions and should always
 *      review them, especially when running code.
 *
 *   2. Due to prompt injection risks, only use it with code you trust
 *      Learn more: https://code.claude.com/docs/en/security
 *
 * OCC shipped stale pre-2.1.263 copy ("You should always review Claude's
 * responses…" + "For more details see:\n<Link>") — this test pins the official
 * strings and forbids the stale variants from returning.
 */
describe("OCC-119: onboarding security notes match official 2.1.263", () => {
  test("item 1 renders the official copy (period + responsibility sentence)", () => {
    const src = readSrc("src/components/Onboarding.tsx");
    expect(src).toContain("Claude can make mistakes.");
    expect(src).toContain(
      "re responsible for Claude",
    );
    expect(src).toContain("review them, especially when running code.");
  });

  test("item 2 renders the one-line dimColor 'Learn more:' link form", () => {
    const src = readSrc("src/components/Onboarding.tsx");
    expect(src).toContain("Due to prompt injection risks, only use it with code you trust");
    expect(src).toContain("Learn more:");
    expect(src).toContain('https://code.claude.com/docs/en/security');
  });

  test("stale pre-2.1.263 copy must not return", () => {
    const src = readSrc("src/components/Onboarding.tsx");
    expect(src).not.toContain("You should always review");
    expect(src).not.toContain("For more details see");
    // The period-less headline variant (exact JSX text node, not substring of the fixed one)
    expect(src).not.toMatch(/<Text>Claude can make mistakes<\/Text>/);
  });
});
