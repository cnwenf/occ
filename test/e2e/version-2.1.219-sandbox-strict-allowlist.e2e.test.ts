import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.219 `sandbox.network.strictAllowlist` (e2e).
 *
 * Binary evidence (2.1.220 linux-x64 ELF):
 *
 * 1. Settings schema (offset ~247994700):
 *    strictAllowlist: v.boolean().optional().describe(
 *      "When true, the sandbox runtime deterministically denies hosts not in " +
 *      "allowedDomains instead of prompting. Enforced for sandboxed commands " +
 *      "only — in-process tools such as WebFetch are not gated by this " +
 *      "setting. Only honored from user, managed/policy, or CLI (--settings) " +
 *      "settings — project settings (.claude/settings.json and " +
 *      ".claude/settings.local.json) are ignored.")
 *
 * 2. Runtime config builder (offset ~251493220):
 *    strictAllowlist: YLt().some((K) => K?.sandbox?.network?.strictAllowlist === !0) || void 0
 *    YLt() enumerates the NON-project settings sources (user, managed/policy,
 *    CLI --settings) — the .describe() is authoritative.
 *
 * 3. Enforcement gate (offset ~251290836):
 *    for (deniedDomains)  if match → deny
 *    for (allowedDomains) if match → allow
 *    if (!r || Hl.network.strictAllowlist) → deny WITHOUT prompting   (r = ask callback)
 *    else → prompt via r
 *
 * OCC's installed @anthropic-ai/sandbox-runtime@0.0.44 NetworkConfigSchema has
 * no strictAllowlist field (zod "strip" would drop it), so the identical
 * observable contract (deny-without-prompt) is enforced in the wrappedCallback
 * next to the allowManagedDomainsOnly branch — see sandbox-adapter.ts
 * shouldEnforceStrictAllowlist() + initialize().
 */
describe('2.1.219 sandbox.network.strictAllowlist (e2e)', () => {
  test('SandboxNetworkConfigSchema accepts strictAllowlist boolean, rejects non-boolean', async () => {
    const script = `
import { SandboxNetworkConfigSchema } from "${REPO_ROOT}/src/entrypoints/sandboxTypes.ts";
const schema = SandboxNetworkConfigSchema();
const cases = [
  { strictAllowlist: true },
  { strictAllowlist: false },
  { strictAllowlist: undefined },
  {},
  { strictAllowlist: "yes" },
  { strictAllowlist: 1 },
];
const out = cases.map((c) => schema.safeParse(c).success);
console.log(JSON.stringify(out));
`
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
    expect(out[0]).toBe(true) // true
    expect(out[1]).toBe(true) // false
    expect(out[2]).toBe(true) // undefined
    expect(out[3]).toBe(true) // omitted
    expect(out[4]).toBe(false) // non-boolean string
    expect(out[5]).toBe(false) // non-boolean number
  })

  test('shouldEnforceStrictAllowlist honors user/flag/policy and IGNORES project/local sources', async () => {
    // Behavioral: mock the settings module with a mutable global so each call
    // to getSettingsForSource returns a controlled value per source, then
    // toggle the active source between calls in the SAME process. This is the
    // security-critical binary nuance — project settings must NOT be honored.
    const script = `
import { mock } from "bun:test";
let activeSource = null;
const SOURCES = ["userSettings","projectSettings","localSettings","flagSettings","policySettings"];
const SETTINGS_PATH = "${REPO_ROOT}/src/utils/settings/settings.ts";
// Spread the real module so every named import other modules expect is
// present; override only getSettingsForSource with a controlled, mutable
// closure so we can toggle the active source between calls in one process.
const real = await import(SETTINGS_PATH);
await mock.module(SETTINGS_PATH, () => ({
  ...real,
  getSettingsForSource: (s) => (s === activeSource ? { sandbox: { network: { strictAllowlist: true } } } : null),
}));
const mod = await import("${REPO_ROOT}/src/utils/sandbox/sandbox-adapter.ts");
const results = {};
for (const s of SOURCES) { activeSource = s; results[s] = mod.shouldEnforceStrictAllowlist(); }
activeSource = null; results.none = mod.shouldEnforceStrictAllowlist();
console.log(JSON.stringify(results));
`
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
    // Honored sources → true when they carry strictAllowlist===true
    expect(out.userSettings).toBe(true)
    expect(out.flagSettings).toBe(true)
    expect(out.policySettings).toBe(true)
    // IGNORED sources → false even when they carry strictAllowlist===true
    expect(out.projectSettings).toBe(false)
    expect(out.localSettings).toBe(false)
    // No source → false
    expect(out.none).toBe(false)
  })

  test('wrappedCallback denies without prompting when strictAllowlist is on (deny-before-prompt)', async () => {
    // Behavioral contract: the strictAllowlist deny branch must sit BEFORE the
    // sandboxAskCallback fallthrough so a non-allowlisted host is denied
    // without ever prompting (binary: `if (!r || strictAllowlist) return deny`).
    const script = `
import { readFileSync } from "fs";
const src = readFileSync("${REPO_ROOT}/src/utils/sandbox/sandbox-adapter.ts","utf8");
const strictIdx = src.indexOf("shouldEnforceStrictAllowlist()");
const promptIdx = src.indexOf("return sandboxAskCallback(hostPattern)");
console.log(JSON.stringify({
  hasStrictBranch: strictIdx !== -1,
  denyBeforePrompt: strictIdx !== -1 && strictIdx < promptIdx,
  logsStrict: src.includes("[sandbox] Blocked network request to") && src.includes("(strictAllowlist)"),
}));
`
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
    expect(out.hasStrictBranch).toBe(true)
    expect(out.denyBeforePrompt).toBe(true)
    expect(out.logsStrict).toBe(true)
  })
})
