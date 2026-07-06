import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code hook matchers + inputs e2e (source-grep).
 *
 * Covers four binary-verified gaps:
 *  - D9  (2.1.191): hook matchers support comma-separated tool lists
 *    (e.g. 'Bash,PowerShell'). Binary: matchesPattern splits on /[|,]/ when
 *    comma-hyphen support is on, and the simple-match char class admits ','.
 *  - D10 (2.1.195): hyphenated identifiers exact-match instead of
 *    substring-matching as regex. Binary: the simple-match char class is
 *    /^[a-zA-Z0-9_|, -]+$/ for matcher events, so 'mcp__foo-bar' is a literal
 *    exact match.
 *  - D16 (2.1.119): PostToolUse/PostToolUseFailure hook inputs carry
 *    duration_ms. Binary: hook_event_name:"PostToolUse",...,duration_ms:l.
 *  - D18 (2.1.142): prompt/agent hooks on contextless events
 *    (SessionStart/Setup/SubagentStart) throw
 *    "<type>-type hooks are not supported for <event> events (no conversation
 *    context is available). Use a command-type hook instead."
 */
describe("hook matchers + inputs (source-grep e2e)", () => {
  const HOOKS = `${REPO_ROOT}/src/utils/hooks.ts`;

  test("D9: matchesPattern splits comma-separated tool lists", async () => {
    const script = `
const src = await Bun.file("${HOOKS}").text();
const fn = src.slice(src.indexOf("function matchesPattern"), src.indexOf("type IfConditionMatcher"));
console.log(JSON.stringify({
  // comma is admitted to the simple-match char class when support is on
  commaInCharClass: /\\/\\^\\\\\\[a-zA-Z0-9_\\|, -\\]\\+\\/\\$/.test(fn) || fn.includes("a-zA-Z0-9_|, -"),
  // split on both | and , (not just |)
  splitsOnCommaAndPipe: fn.includes("/[|,]/"),
  // commaHyphenSupport param exists
  hasCommaHyphenSupportParam: fn.includes("commaHyphenSupport"),
  // filter(Boolean) + flatMap present (matches official pipeline)
  hasFilterBoolean: fn.includes(".filter(Boolean)"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.commaInCharClass).toBe(true);
    expect(out.splitsOnCommaAndPipe).toBe(true);
    expect(out.hasCommaHyphenSupportParam).toBe(true);
    expect(out.hasFilterBoolean).toBe(true);
  });

  test("D10: hyphenated identifiers exact-match (hyphen in simple char class)", async () => {
    const script = `
const src = await Bun.file("${HOOKS}").text();
const fn = src.slice(src.indexOf("function matchesPattern"), src.indexOf("type IfConditionMatcher"));
console.log(JSON.stringify({
  // the commaHyphenSupport char class includes '-' (and space + comma)
  hyphenInCharClass: fn.includes("a-zA-Z0-9_|, -"),
  // gate set exists and includes the tool matcher events
  gateSetDefined: src.includes("MATCHER_COMMA_HYPHEN_EVENTS"),
  gateHasPreToolUse: src.includes("'PreToolUse'"),
  gateHasPostToolUse: src.includes("'PostToolUse'"),
  // caller passes the flag through
  callerPassesFlag: src.includes("matchesPattern(matchQuery, matcher.matcher, commaHyphenSupport)"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hyphenInCharClass).toBe(true);
    expect(out.gateSetDefined).toBe(true);
    expect(out.gateHasPreToolUse).toBe(true);
    expect(out.gateHasPostToolUse).toBe(true);
    expect(out.callerPassesFlag).toBe(true);
  });

  test("D16: PostToolUse + PostToolUseFailure hook inputs include duration_ms", async () => {
    const script = `
const src = await Bun.file("${HOOKS}").text();
// PostToolUse input block
const post = src.slice(src.indexOf("hook_event_name: 'PostToolUse'"), src.indexOf("yield* executeHooks", src.indexOf("hook_event_name: 'PostToolUse'")));
const fail = src.slice(src.indexOf("hook_event_name: 'PostToolUseFailure'"), src.indexOf("yield* executeHooks", src.indexOf("hook_event_name: 'PostToolUseFailure'")));
console.log(JSON.stringify({
  postHasDuration: post.includes("duration_ms: durationMs"),
  failHasDuration: fail.includes("duration_ms: durationMs"),
  postFnHasParam: /executePostToolHooks[\\s\\S]*?durationMs\\?: number/.test(src),
  failFnHasParam: /executePostToolUseFailureHooks[\\s\\S]*?durationMs\\?: number/.test(src),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.postHasDuration).toBe(true);
    expect(out.failHasDuration).toBe(true);
    expect(out.postFnHasParam).toBe(true);
    expect(out.failFnHasParam).toBe(true);
  });

  test("D16: duration wired from toolExecution through toolHooks", async () => {
    const script = `
const toolHooks = await Bun.file("${REPO_ROOT}/src/services/tools/toolHooks.ts").text();
const toolExec = await Bun.file("${REPO_ROOT}/src/services/tools/toolExecution.ts").text();
console.log(JSON.stringify({
  // runPostToolUseHooks accepts + forwards durationMs
  hooksAcceptsDuration: toolHooks.includes("durationMs?: number"),
  hooksForwardsPost: toolHooks.includes("undefined,\\n      durationMs,") || toolHooks.includes("durationMs,"),
  // toolExecution passes durationMs to both post-hook runners
  execPassesPost: /runPostToolUseHooks\\([\\s\\S]*?durationMs,/.test(toolExec),
  execPassesFail: /runPostToolUseFailureHooks\\([\\s\\S]*?durationMs,/.test(toolExec),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hooksAcceptsDuration).toBe(true);
    expect(out.hooksForwardsPost).toBe(true);
    expect(out.execPassesPost).toBe(true);
    expect(out.execPassesFail).toBe(true);
  });

  test("D18: command-type hook error for prompt/agent on contextless events", async () => {
    const script = `
const src = await Bun.file("${HOOKS}").text();
console.log(JSON.stringify({
  promptError: src.includes("prompt-type hooks are not supported for "),
  agentError: src.includes("agent-type hooks are not supported for "),
  noConversationContext: src.includes("(no conversation context is available). Use a command-type hook instead."),
  // event name interpolated into the message
  eventInterpolated: src.includes("for \${hookEvent} events"),
  // old generic wording is gone
  oldPromptWordingGone: !src.includes("ToolUseContext is required for prompt hooks. This is a bug."),
  oldAgentWordingGone: !src.includes("ToolUseContext is required for agent hooks. This is a bug."),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.promptError).toBe(true);
    expect(out.agentError).toBe(true);
    expect(out.noConversationContext).toBe(true);
    expect(out.eventInterpolated).toBe(true);
    expect(out.oldPromptWordingGone).toBe(true);
    expect(out.oldAgentWordingGone).toBe(true);
  });
});
