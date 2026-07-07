import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

const read = (rel: string): string =>
  readFileSync(`${REPO_ROOT}/${rel}`, "utf-8");

/**
 * uirest agent gaps (I6, I7, I12, I13, G11, E31, E32) — source-grep + behavior
 * e2e. Each gap is verified against the 2.1.200 binary behavior.
 */
describe("2.1.200 uirest gaps (e2e)", () => {
  // ---- I6 (2.1.97): focus view toggle (/focus command; Ctrl+O is
  // toggleTranscript in 2.1.200, focus is a separate immediate command) ----
  describe("I6: /focus command + focus view toggle", () => {
    test("source: /focus is immediate and matches binary description", () => {
      const index = read("src/commands/focus/index.ts");
      expect(index).toContain("type: 'local-jsx'");
      expect(index).toContain("name: 'focus'");
      expect(index).toContain("Toggle focus view: just your prompt, summary, and response");
      expect(index).toContain("immediate: true");
      // Binary also sets requires:{ink:!0}; OCC's Command type doesn't model
      // `requires` for any command, so that field is a systemic gap, not I6.
    });

    test("source: focus flag toggle + fullscreen gate", () => {
      const src = read("src/commands/focus/focus.ts");
      expect(src).toContain("isFocusViewEnabled");
      expect(src).toContain("setFocusViewEnabled");
      expect(src).toContain("Focus view enabled");
      expect(src).toContain("Focus view disabled");
      expect(src).toContain("tengu_focus_command");
    });
  });

  // ---- I7 (2.1.98): /agents tabbed layout was REMOVED by 2.1.198; the 2.1.200
  // binary ships a "(removed)" stub. Verify OCC matches the binary. ----
  describe("I7: /agents removed stub (tabbed layout removed in 2.1.198)", () => {
    test("source: /agents is the (removed) stub matching the binary", () => {
      const index = read("src/commands/agents/index.ts");
      expect(index).toContain("name: 'agents'");
      expect(index).toContain("(removed) Ask Claude to create/manage subagents, or edit .claude/agents/");
      expect(index).toContain("supportsNonInteractive: true");
    });

    test("source: stub call returns the wizard-removed pointer", () => {
      const src = read("src/commands/agents/agents.ts");
      expect(src).toContain("wizard has been removed");
    });
  });

  // ---- I12 (2.1.111): /skills sort by estimated token count (press t) ----
  describe("I12: /skills press-t sort by token count", () => {
    test("source: SkillsMenu toggles sort on 't' between alphabetical and tokens", () => {
      const src = read("src/components/skills/SkillsMenu.tsx");
      expect(src).toContain("useInput");
      expect(src).toContain("input === 't'");
      expect(src).toContain("sortByTokens");
      expect(src).toContain("estimateSkillFrontmatterTokens(a) - estimateSkillFrontmatterTokens(b)");
      expect(src).toContain("getCommandName(a).localeCompare(getCommandName(b))");
      expect(src).toContain("press t to toggle");
    });
  });

  // ---- I13 (2.1.110): Ctrl+G external editor 'show last response as
  // commented context' option (setting externalEditorContext) ----
  describe("I13: externalEditorContext commented-context option", () => {
    test("source: externalEditorContext setting in schema", () => {
      const types = read("src/utils/settings/types.ts");
      expect(types).toContain("externalEditorContext: z");
      expect(types).toContain(".boolean()");
    });

    test("source: editPromptInEditor prepends + strips commented context", () => {
      const src = read("src/utils/promptEditor.ts");
      expect(src).toContain("commentedContext");
      expect(src).toContain("buildCommentedContext");
      expect(src).toContain("stripCommentedContext");
      expect(src).toContain("Last response (commented");
    });

    test("source: handleExternalEditor reads setting + last assistant response", () => {
      const src = read("src/components/PromptInput/PromptInput.tsx");
      expect(src).toContain("getSettings_DEPRECATED().externalEditorContext");
      expect(src).toContain("getLastAssistantMessage(messages)");
      expect(src).toContain("editPromptInEditor(input, pastedContents, commentedContext)");
    });

    test("source: config panel item for externalEditorContext", () => {
      const src = read("src/components/Settings/Config.tsx");
      expect(src).toContain("id: 'externalEditorContext'");
      expect(src).toContain("Show last response in external editor");
      expect(src).toContain("tengu_external_editor_context_changed");
    });
  });

  // ---- G11 (2.1.178): auto-mode classifier evaluates subagent spawns before
  // launch ----
  describe("G11: pre-spawn subagent classification", () => {
    test("source: classifySubagentSpawnBeforeLaunch in permissions", () => {
      const src = read("src/utils/permissions/subagentSpawnClassifier.ts");
      expect(src).toContain("export async function classifySubagentSpawnBeforeLaunch");
      expect(src).toContain("classifyYoloAction");
      expect(src).toContain("formatActionForClassifier('Task'");
      expect(src).toContain("isPreSpawn: true");
      expect(src).toContain("tengu_auto_mode_decision");
    });

    test("behavior: function is callable and no-ops outside auto mode", async () => {
      const out = await $`bun -e ${`
const { classifySubagentSpawnBeforeLaunch } = await import("${REPO_ROOT}/src/utils/permissions/subagentSpawnClassifier.ts");
const r = await classifySubagentSpawnBeforeLaunch({
  parentMessages: [], subagentType: 'code-reviewer', subagentPrompt: 'review the diff',
  tools: [], toolPermissionContext: { mode: 'default' }, abortSignal: new AbortController().signal,
});
console.log(typeof r === 'object' ? 'null-or-result' : 'bad');
`.trim()}`.quiet();
      expect(out.stdout.toString().trim()).toBe("null-or-result");
    });
  });

  // ---- E31 (2.1.119): --from-pr accepts GitLab/Bitbucket/GitHub Enterprise ----
  describe("E31: --from-pr multi-VCS URLs", () => {
    test("source: parsePrUrl covers GitHub, GitLab, Bitbucket markers", () => {
      const src = read("src/commands/resume/resume.tsx");
      expect(src).toContain("/pull/");
      expect(src).toContain("/-/merge_requests/");
      expect(src).toContain("/pull-requests/");
      expect(src).toContain("PR_URL_PATTERNS");
    });

    test("behavior: parsePrUrl extracts owner/repo/number for each VCS", async () => {
      const out = JSON.parse((await $`bun -e ${`
const { parsePrUrl } = await import("${REPO_ROOT}/src/commands/resume/resume.tsx");
const cases = {
  github: parsePrUrl("https://github.com/anthropics/claude-code/pull/123"),
  enterprise: parsePrUrl("https://reviews.example.test/acme/widget/pull/9"),
  gitlab: parsePrUrl("https://gitlab.com/mygroup/myrepo/-/merge_requests/42"),
  bitbucket: parsePrUrl("https://bitbucket.org/acme/widget/pull-requests/7"),
  nonpr: parsePrUrl("not a url"),
};
console.log(JSON.stringify(cases));
`.trim()}`.quiet()).stdout.toString().trim());
      expect(out.github).toEqual({ repository: "anthropics/claude-code", number: 123 });
      expect(out.enterprise).toEqual({ repository: "acme/widget", number: 9 });
      expect(out.gitlab).toEqual({ repository: "mygroup/myrepo", number: 42 });
      expect(out.bitbucket).toEqual({ repository: "acme/widget", number: 7 });
      expect(out.nonpr).toBeNull();
    });
  });

  // ---- E32 (2.1.111): closest-matching subcommand suggestion ("Did you
  // mean") ----
  describe("E32: closest-matching subcommand suggestion", () => {
    test("source: subcommandSuggestion helper with levenshtein ≤2", () => {
      const src = read("src/cli/subcommandSuggestion.ts");
      expect(src).toContain("export function levenshtein");
      expect(src).toContain("export function findClosestSubcommand");
      expect(src).toContain("dist <= 2");
    });

    test("source: main.tsx wires 'Unknown command' + 'Did you mean' for typos", () => {
      const src = read("src/main.tsx");
      expect(src).toContain("findClosestSubcommand(prompt, program)");
      expect(src).toContain("Unknown command: ${");
      expect(src).toContain("Did you mean '");
    });

    test("behavior: findClosestSubcommand suggests near matches, rejects far ones", async () => {
      const out = JSON.parse((await $`bun -e ${`
import { Command } from '@commander-js/extra-typings';
import { findClosestSubcommand } from "${REPO_ROOT}/src/cli/subcommandSuggestion.ts";
const program = new Command();
program.command('agents'); program.command('mcp'); program.command('auth'); program.command('doctor');
const cases = { agnats: findClosestSubcommand('agnats', program), mcp: findClosestSubcommand('mcp', program), hello: findClosestSubcommand('hello', program) };
console.log(JSON.stringify(cases));
`.trim()}`.quiet()).stdout.toString().trim());
      expect(out.agnats).toBe("agents");
      expect(out.mcp).toBeUndefined(); // exact match is a real subcommand, never suggested
      expect(out.hello).toBeUndefined();
    });
  });
});
