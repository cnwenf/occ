import { describe, expect, test } from "bun:test";
import { runOcc } from "./helpers";

/**
 * OCC-111 self-acceptance round (official stuck at 2.1.251): a byte-level
 * `--help` surface diff between the OCC build and the official 2.1.251 ELF
 * found 5 CLI divergences. All asserted strings below are byte-verified from
 * the official 2.1.251 linux-x64 `claude --help` output / argParser error.
 *
 *   Gap-111a  --permission-mode choices expose the user-facing "manual" alias
 *             in place of the internal "default"; error wording matches.
 *   Gap-111b  --allowedTools / --disallowedTools example "Bash(git:*)" ->
 *             "Bash(git *)".
 *   Gap-111c  --name description now mentions the prompt box + /resume picker.
 *   Gap-111d  --print description rewritten to the official non-interactive
 *             wording (+ silent-invalid-settings sentence).
 *   Gap-111g  --ax-screen-reader drops the OCC-extra "Overridden by ..."
 *             sentence (official honors the same env var/setting but does not
 *             document it in --help).
 *   Gap-111h  top-level `stop <id>` gains the official `kill` alias
 *             (renders as `stop|kill <id>`).
 *   Gap-111i  the deprecated `--mcp-debug` flag is removed — official 2.1.251
 *             has no such option and rejects it as an unknown option.
 *
 * Runs against the BUILT dist/cli.js. The `--help` parity and invalid-mode
 * cases need no model creds; the accepted-mode round-trips do, so they are
 * gated out of CI like the other live-model e2e suites.
 */

describe.skipIf(!!process.env.CI)("2.1.251 CLI --help parity (OCC-111, e2e)", () => {
  // One `--help` capture shared by the pure-text assertions.
  let help = "";

  test("--help captures cleanly", async () => {
    const res = await runOcc(["--help"], {}, 30_000);
    expect(res.code).toBe(0);
    help = res.stdout;
    expect(help.length).toBeGreaterThan(0);
  }, 60_000);

  test("Gap-111a: --permission-mode choices expose manual, not default", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    // The official renders the user-facing alias "manual" in the choices list.
    expect(help).toContain(
      '(choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
    );
    // The internal "default" must NOT appear as a displayed choice.
    expect(help).not.toContain('"default", "dontAsk"');
  }, 60_000);

  test("Gap-111b: allowedTools/disallowedTools use Bash(git *) example", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    expect(help).toContain(
      'Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")',
    );
    expect(help).toContain(
      'Comma or space-separated list of tool names to deny (e.g. "Bash(git *) Edit")',
    );
    // The stale colon-form example must be gone from both.
    expect(help).not.toContain("Bash(git:*)");
  }, 60_000);

  test("Gap-111c: --name description mentions prompt box + /resume picker", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    expect(help).toContain(
      "Set a display name for this session (shown in the prompt box, /resume picker, and terminal title)",
    );
    // Old, shorter wording must be gone.
    expect(help).not.toContain("(shown in /resume and terminal title)");
  }, 60_000);

  test("Gap-111d: --print uses the official non-interactive wording", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    expect(help).toContain(
      "Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY, e.g. piped or redirected output). Only use this in directories you trust. Settings files that fail validation are silently ignored in this mode (no error dialog is shown).",
    );
    // Old "-p mode" wording must be gone.
    expect(help).not.toContain("when Claude is run with the -p mode");
  }, 60_000);

  test("Gap-111h: top-level stop command renders as stop|kill <id>", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    expect(help).toContain("stop|kill <id>");
  }, 60_000);

  test("Gap-111g: --ax-screen-reader matches the official wording exactly", async () => {
    if (!help) help = (await runOcc(["--help"], {}, 30_000)).stdout;
    expect(help).toContain("--ax-screen-reader");
    expect(help).toContain(
      "Render screen-reader friendly output (flat text, no decorative borders or animations).",
    );
    // The OCC-extra override note must be gone (official omits it).
    expect(help).not.toContain("Overridden by the CLAUDE_AX_SCREEN_READER");
  }, 60_000);

  test("Gap-111i: removed --mcp-debug is rejected like official (unknown option)", async () => {
    // Official 2.1.251 has no --mcp-debug; it exits non-zero at parse time
    // with commander's unknown-option error. No model creds needed.
    const res = await runOcc(["--mcp-debug", "-p", "hi"], {}, 30_000);
    expect(res.code).not.toBe(0);
    const combined = `${res.stdout}${res.stderr}`;
    expect(combined).toContain("unknown option '--mcp-debug'");
  }, 60_000);

  test("Gap-111a: invalid --permission-mode rejected with the official error", async () => {
    // Exits at parse time (no model call), so this needs no creds.
    const res = await runOcc(["--permission-mode", "bogus", "-p", "hi"], {}, 30_000);
    expect(res.code).not.toBe(0);
    const combined = `${res.stdout}${res.stderr}`;
    expect(combined).toContain(
      "Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.",
    );
  }, 60_000);

  test("Gap-111a: 'default' is still accepted (normalized, not rejected)", async () => {
    // `default` is intentionally absent from the DISPLAYED choices but must
    // remain a valid input (normalized by the argParser), matching official.
    const res = await runOcc(
      ["--permission-mode", "default", "-p", "say OK"],
      {},
      120_000,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
  }, 180_000);

  test("Gap-111a: 'manual' alias accepted and normalized to default", async () => {
    const res = await runOcc(
      ["--permission-mode", "manual", "-p", "say OK"],
      {},
      120_000,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
  }, 180_000);
});
