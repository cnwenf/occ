import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.186+ e2e: skills allowlist / shadowing / frontmatter /
 * attribution (gaps C4, C5, C6, C7).
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   - sessionSkillAllowlist (jt field) + "is not in this session's skills
 *     allowlist" + errorCode 8 (the eZt validation gate).
 *   - dropShadowedBundledSkills (AXe) + dropShadowedFallbackSkills (XV).
 *   - frontmatter: display-name, default-enabled, fallback, metadata +
 *     normalizeKeys (fm(..., {normalizeKeys:!0})).
 *   - attributionSkillName / attributionSkillHash (upt/om) + attributionPlugin
 *     + "_PROTO_skill_name" per-turn tagging.
 */

const ALLOWLIST_SRC = readFileSync(
  `${REPO_ROOT}/src/skills/sessionSkillAllowlist.ts`,
  "utf8",
);
const LOAD_SRC = readFileSync(`${REPO_ROOT}/src/skills/loadSkillsDir.ts`, "utf8");
const ATTR_SRC = readFileSync(
  `${REPO_ROOT}/src/tools/SkillTool/skillAttribution.ts`,
  "utf8",
);
const SKILL_TOOL_SRC = readFileSync(
  `${REPO_ROOT}/src/tools/SkillTool/SkillTool.ts`,
  "utf8",
);
const RUN_AGENT_SRC = readFileSync(
  `${REPO_ROOT}/src/tools/AgentTool/runAgent.ts`,
  "utf8",
);

describe("2.1.186 C4 sessionSkillAllowlist (e2e)", () => {
  test("source-grep: allowlist state + binary-exact rejection message", () => {
    expect(ALLOWLIST_SRC).toContain("sessionSkillAllowlist");
    expect(ALLOWLIST_SRC).toContain("setSessionSkillAllowlist");
    expect(ALLOWLIST_SRC).toContain("getSessionSkillAllowlist");
    expect(ALLOWLIST_SRC).toContain("clearSessionSkillAllowlist");
    // Binary-exact error message + errorCode.
    expect(SKILL_TOOL_SRC).toContain(
      "is not in this session's skills allowlist",
    );
    expect(SKILL_TOOL_SRC).toContain("errorCode: 8");
  });

  test("source-grep: runAgent sets/clears the allowlist from skills frontmatter", () => {
    expect(RUN_AGENT_SRC).toContain("setSessionSkillAllowlist");
    expect(RUN_AGENT_SRC).toContain("clearSessionSkillAllowlist");
    expect(RUN_AGENT_SRC).toContain("agentDefinition.skills");
  });

  test("runtime: allowlist matching (exact / plugin-qualified / :suffix)", async () => {
    const script = `
const { setSessionSkillAllowlist, isSkillAllowedBySession, clearSessionSkillAllowlist, getSessionSkillAllowlist } = await import("${REPO_ROOT}/src/skills/sessionSkillAllowlist.ts");
setSessionSkillAllowlist(['foo','plugin:bar',':baz']);
const out = {
  exact: isSkillAllowedBySession('foo'),
  qualified: isSkillAllowedBySession('plugin:bar'),
  suffix: isSkillAllowedBySession('x:baz'),
  denied: isSkillAllowedBySession('other'),
  set: getSessionSkillAllowlist() !== undefined,
};
clearSessionSkillAllowlist();
out.cleared = getSessionSkillAllowlist() === undefined;
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out).toEqual({ exact: true, qualified: true, suffix: true, denied: false, set: true, cleared: true });
  });
});

describe("2.1.186 C5 skill shadowing (e2e)", () => {
  test("source-grep: dropShadowedBundledSkills + dropShadowedFallbackSkills", () => {
    expect(LOAD_SRC).toContain("dropShadowedBundledSkills");
    expect(LOAD_SRC).toContain("dropShadowedFallbackSkills");
    // Applied at the SkillTool assembly + prompt listing sites.
    expect(SKILL_TOOL_SRC).toContain("dropShadowedSkills");
  });

  test("runtime: bundled + fallback shadowing", async () => {
    const script = `
const { dropShadowedBundledSkills, dropShadowedFallbackSkills } = await import("${REPO_ROOT}/src/skills/loadSkillsDir.ts");
const user = { type:'prompt', name:'foo', source:'userSettings', loadedFrom:'skills' };
const bundled = { type:'prompt', name:'foo', source:'bundled', loadedFrom:'bundled' };
const r1 = dropShadowedBundledSkills([user, bundled]);
const real = { type:'prompt', name:'bar', source:'plugin', loadedFrom:'plugin', disableModelInvocation:false };
const fb = { type:'prompt', name:'bar', source:'bundled', loadedFrom:'bundled', fallback:true, disableModelInvocation:false };
const r2 = dropShadowedFallbackSkills([real, fb]);
console.log(JSON.stringify({ bundledKept: r1.length === 1 && r1[0].source === 'userSettings', fallbackKept: r2.length === 1 && !r2[0].fallback }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out).toEqual({ bundledKept: true, fallbackKept: true });
  });
});

describe("2.1.186 C6 frontmatter fields + normalizeKeys (e2e)", () => {
  test("source-grep: new fields + normalizeKeys", () => {
    expect(LOAD_SRC).toContain("display-name");
    expect(LOAD_SRC).toContain("default-enabled");
    expect(LOAD_SRC).toContain("fallback");
    expect(LOAD_SRC).toContain("metadata");
    expect(LOAD_SRC).toContain("normalizeKeys");
    expect(LOAD_SRC).toContain("normalizeFrontmatterKeys");
    expect(LOAD_SRC).toContain("parseSkillFrontmatter");
  });

  test("runtime: kebab fields normalized + parsed", async () => {
    const script = `
const { parseSkillFrontmatter, parseSkillFrontmatterFields } = await import("${REPO_ROOT}/src/skills/loadSkillsDir.ts");
const fm = parseSkillFrontmatter('---\\ndisplay-name: My Skill\\ndefault-enabled: false\\nfallback: true\\nmetadata:\\n  version: 2\\n---\\nbody', 'x.md', { normalizeKeys: true });
const pf = parseSkillFrontmatterFields(fm.frontmatter, 'body', 'myskill');
console.log(JSON.stringify({
  displayName: pf.displayName,
  defaultEnabled: pf.defaultEnabled,
  fallback: pf.fallback,
  metadataVersion: pf.metadata?.version,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out).toEqual({ displayName: "My Skill", defaultEnabled: false, fallback: true, metadataVersion: 2 });
  });
});

describe("2.1.186 C7 skill attribution (e2e)", () => {
  test("source-grep: attributionSkillName / attributionSkillHash + SkillTool wiring", () => {
    expect(ATTR_SRC).toContain("attributionSkillName");
    expect(ATTR_SRC).toContain("attributionSkillHash");
    expect(ATTR_SRC).toContain("attributionPlugin");
    expect(ATTR_SRC).toContain("setSkillAttribution");
    expect(ATTR_SRC).toContain("getSkillAttribution");
    // SkillTool records attribution on skill invocation.
    expect(SKILL_TOOL_SRC).toContain("setSkillAttribution");
  });

  test("runtime: attribution name/hash/plugin", async () => {
    const script = `
const { setSkillAttribution, getAttributionSkillName, getAttributionSkillHash, attributionSkillHash, deriveAttributionPlugin, clearSkillAttribution, getSkillAttribution } = await import("${REPO_ROOT}/src/tools/SkillTool/skillAttribution.ts");
setSkillAttribution('plugin:myskill');
const out = {
  name: getAttributionSkillName(),
  hash: getAttributionSkillHash(),
  hashMatches: getAttributionSkillHash() === attributionSkillHash('plugin:myskill'),
  plugin: deriveAttributionPlugin('plugin:myskill'),
  frag: getSkillAttribution(),
};
clearSkillAttribution();
out.cleared = getAttributionSkillName() === undefined;
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.name).toBe("plugin:myskill");
    expect(out.hashMatches).toBe(true);
    expect(out.plugin).toBe("plugin");
    expect(out.frag).toEqual({ attributionSkill: "plugin:myskill", attributionPlugin: "plugin" });
    expect(out.cleared).toBe(true);
  });
});
