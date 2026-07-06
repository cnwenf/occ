import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code bash-permission safety gaps (source-grep + runtime e2e):
 *   G6 (2.1.126): --dangerously-skip-permissions bypasses protected-path write
 *     prompts for .claude/.git/.vscode/shell-config files (they no longer leak
 *     through as bypass-immune safetyCheck 'ask').
 *   G7 (2.1.160): shell-startup-file detection includes .zshenv/.zlogin/
 *     .bash_login/.zlogout and ~/.config/git (previously missing, so writes to
 *     them were auto-allowed in acceptEdits).
 *   G9 (2.1.98): redirects to /dev/tcp/… and /dev/udp/… open network
 *     connections and must prompt (input redirects previously slipped past
 *     extractOutputRedirections and were auto-allowed as read-only); grep/rg
 *     -f FILE reading a pattern file outside the working directory must prompt.
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   "Redirect involving /dev/tcp or /dev/udp opens a network connection"
 *   shell-startup list: .bashrc/.bash_profile/.bash_login/.bash_logout/.zshrc/
 *     .zprofile/.zshenv/.zlogin/.zlogout/.profile + ~/.config/git
 */
describe("bashperm safety gaps G6/G7/G9 (source-grep + runtime)", () => {
  const path = `${REPO_ROOT}/src/tools/BashTool/bashPermissions.ts`;
  const src = readFileSync(path, "utf8");

  test("source-grep: G6 bypass-suppression helper present", () => {
    // G6: protected-path/safety 'ask' results are suppressed in bypassPermissions
    // mode so --dangerously-skip-permissions skips the write prompts.
    expect(src).toContain("function maybeSuppressForBypass");
    expect(src).toContain("mode === 'bypassPermissions'");
    expect(src).toContain(
      "Protected-path/safety prompt bypassed in bypassPermissions mode",
    );
    // Applied at the checkPathConstraints call sites.
    expect(src).toContain("maybeSuppressForBypass(");
  });

  test("source-grep: G7 shell-startup-file list includes the missing files", () => {
    expect(src).toContain("SHELL_STARTUP_FILES = new Set([");
    // The four files the generic DANGEROUS_FILES list was missing:
    expect(src).toContain("'.zshenv'");
    expect(src).toContain("'.zlogin'");
    expect(src).toContain("'.bash_login'");
    expect(src).toContain("'.zlogout'");
    // ~/.config/git directory (config/ignore/attributes) detection:
    expect(src).toMatch(/\.config\/git/);
    expect(src).toContain("function isShellStartupFileTarget");
  });

  test("source-grep: G9 /dev/tcp,/dev/udp binary-exact message", () => {
    expect(src).toContain("DEV_NETWORK_REDIRECT_RE");
    expect(src).toMatch(/\/dev\/(?:tcp|udp)/);
    expect(src).toContain(
      "Redirect involving /dev/tcp or /dev/udp opens a network connection",
    );
    // Input-redirect extraction (extractOutputRedirections is output-only):
    expect(src).toContain("function extractInputRedirectTargets");
  });

  test("source-grep: G9 grep/rg -f pattern-file detection", () => {
    expect(src).toContain("function extractPatternFilePaths");
    expect(src).toContain("'-f'");
    expect(src).toContain("'--file'");
    expect(src).toContain("function isPathOutsideWorkingDir");
  });

  test("source-grep: dedicated safety function wired into the flow", () => {
    expect(src).toContain(
      "function checkBashRedirectAndPatternSafety",
    );
    // Called at all three checkPathConstraints sites.
    const calls = src.split("checkBashRedirectAndPatternSafety(").length - 1;
    // 1 definition-site reference (in the comment block) + 3 call sites.
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("bashperm safety gaps G6/G7/G9 (runtime)", () => {
  async function run(script: string): Promise<any> {
    const result = await $`bun -e ${script}`.quiet();
    return JSON.parse(result.stdout.toString().trim());
  }

  const importPath = `${REPO_ROOT}/src/tools/BashTool/bashPermissions.ts`;
  const ctxPath = `${REPO_ROOT}/src/Tool.ts`;

  test("G9: /dev/tcp and /dev/udp redirects prompt (default mode)", async () => {
    const script = `
import { checkBashRedirectAndPatternSafety } from "${importPath}";
import { getEmptyToolPermissionContext } from "${ctxPath}";
const ctx = getEmptyToolPermissionContext();
const r = (cmd) => checkBashRedirectAndPatternSafety({ command: cmd }, ctx, null, null);
console.log(JSON.stringify({
  outTcp: r("echo x > /dev/tcp/host/80").behavior,
  inTcp: r("cat < /dev/tcp/host/80").behavior,
  rwTcp: r("exec 3<>/dev/tcp/host/80").behavior,
  outUdp: r("echo x > /dev/udp/host/80").behavior,
  inTcpMsg: r("cat < /dev/tcp/host/80").message,
}));
`;
    const out = await run(script);
    expect(out.outTcp).toBe("ask");
    expect(out.inTcp).toBe("ask");
    expect(out.rwTcp).toBe("ask");
    expect(out.outUdp).toBe("ask");
    expect(out.inTcpMsg).toContain(
      "Redirect involving /dev/tcp or /dev/udp opens a network connection",
    );
  });

  test("G9: grep/rg -f pattern file outside cwd prompts; inside cwd passes", async () => {
    const script = `
import { checkBashRedirectAndPatternSafety } from "${importPath}";
import { getEmptyToolPermissionContext } from "${ctxPath}";
const ctx = getEmptyToolPermissionContext();
const r = (cmd) => checkBashRedirectAndPatternSafety({ command: cmd }, ctx, null, null);
console.log(JSON.stringify({
  grepF: r("grep -f /etc/passwd foo").behavior,
  rgF: r("rg -f /etc/passwd foo").behavior,
  grepFileEq: r("grep --file=/etc/passwd foo").behavior,
  grepFInside: r("grep -f ./local foo").behavior,
}));
`;
    const out = await run(script);
    expect(out.grepF).toBe("ask");
    expect(out.rgF).toBe("ask");
    expect(out.grepFileEq).toBe("ask");
    expect(out.grepFInside).toBe("passthrough");
  });

  test("G7: shell-startup files prompt in acceptEdits (the gap)", async () => {
    const script = `
import { checkBashRedirectAndPatternSafety } from "${importPath}";
import { getEmptyToolPermissionContext } from "${ctxPath}";
const ctx = { ...getEmptyToolPermissionContext(), mode: "acceptEdits" };
const r = (cmd) => checkBashRedirectAndPatternSafety({ command: cmd }, ctx, null, null);
console.log(JSON.stringify({
  zshenv: r("echo x > .zshenv").behavior,
  zlogin: r("echo x > .zlogin").behavior,
  bashLogin: r("echo x > .bash_login").behavior,
  zlogout: r("echo x > .zlogout").behavior,
  configGit: r("echo x > .config/git/config").behavior,
  bashrc: r("echo x > .bashrc").behavior,
  normal: r("echo x > normal.txt").behavior,
  zshenvReason: r("echo x > .zshenv").decisionReason?.type,
}));
`;
    const out = await run(script);
    expect(out.zshenv).toBe("ask");
    expect(out.zlogin).toBe("ask");
    expect(out.bashLogin).toBe("ask");
    expect(out.zlogout).toBe("ask");
    expect(out.configGit).toBe("ask");
    expect(out.bashrc).toBe("ask");
    expect(out.normal).toBe("passthrough");
    expect(out.zshenvReason).toBe("safetyCheck");
  });

  test("G6: bypassPermissions mode bypasses the dedicated prompts", async () => {
    const script = `
import { checkBashRedirectAndPatternSafety } from "${importPath}";
import { getEmptyToolPermissionContext } from "${ctxPath}";
const ctx = { ...getEmptyToolPermissionContext(), mode: "bypassPermissions" };
const r = (cmd) => checkBashRedirectAndPatternSafety({ command: cmd }, ctx, null, null);
console.log(JSON.stringify({
  zshenv: r("echo x > .zshenv").behavior,
  devTcp: r("cat < /dev/tcp/host/80").behavior,
  grepF: r("grep -f /etc/passwd foo").behavior,
}));
`;
    const out = await run(script);
    expect(out.zshenv).toBe("passthrough");
    expect(out.devTcp).toBe("passthrough");
    expect(out.grepF).toBe("passthrough");
  });

  test("G6: bashToolCheckPermission bypasses protected-path write prompts (.git/.claude/.vscode)", async () => {
    const script = `
import { bashToolCheckPermission } from "${importPath}";
import { getEmptyToolPermissionContext } from "${ctxPath}";
const bypass = { ...getEmptyToolPermissionContext(), mode: "bypassPermissions" };
const def = getEmptyToolPermissionContext();
const r = (cmd, ctx) => bashToolCheckPermission({ command: cmd }, ctx, false, undefined).behavior;
console.log(JSON.stringify({
  gitDefault: r("echo x > .git/config", def),
  gitBypass: r("echo x > .git/config", bypass),
  claudeDefault: r("echo x > .claude/x", def),
  claudeBypass: r("echo x > .claude/x", bypass),
  vscodeDefault: r("echo x > .vscode/x", def),
  vscodeBypass: r("echo x > .vscode/x", bypass),
}));
`;
    const out = await run(script);
    // Default mode still prompts (safetyCheck).
    expect(out.gitDefault).toBe("ask");
    expect(out.claudeDefault).toBe("ask");
    expect(out.vscodeDefault).toBe("ask");
    // Bypass mode no longer prompts (was 'ask' before the fix).
    expect(out.gitBypass).not.toBe("ask");
    expect(out.claudeBypass).not.toBe("ask");
    expect(out.vscodeBypass).not.toBe("ask");
  });
});
