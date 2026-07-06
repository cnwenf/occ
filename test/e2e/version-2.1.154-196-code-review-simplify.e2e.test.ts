import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.154 (E14) + 2.1.196 (E15) e2e (Docker):
 *   E14: /simplify split from /code-review — /code-review finds correctness
 *        bugs + cleanups (effort-scoped, --fix/--comment); /simplify is
 *        cleanup-only and applies fixes (no bug hunting).
 *   E15: /code-review's Find phase uses one finder per correctness angle plus
 *        ONE merged finder covering all cleanup angles (was one per cleanup
 *        angle), capped at (cleanup-angle count × perAngle).
 */

const SIMPLIFY_FILE = `${REPO_ROOT}/src/skills/bundled/simplify.ts`;
const INDEX_FILE = `${REPO_ROOT}/src/skills/bundled/index.ts`;

describe("2.1.154 (E14) /simplify split from /code-review (e2e)", () => {
  test("code-review skill has the official description + argumentHint", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
const desc = "Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence findings; high\\u2192max: broader coverage, may include uncertain findings). Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review.";
console.log(JSON.stringify({
  hasDesc: src.includes(desc),
  hasName: src.includes("name: 'code-review'"),
  hasHint: src.includes("'[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]'"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasDesc).toBe(true);
    expect(out.hasName).toBe(true);
    expect(out.hasHint).toBe(true);
  });

  test("simplify skill has the official description + argumentHint", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
const desc = "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only \\u2014 it does not hunt for bugs; use /code-review for that.";
console.log(JSON.stringify({
  hasDesc: src.includes(desc),
  hasName: src.includes("name: 'simplify'"),
  hasHint: src.includes("argumentHint: '[<target>]'"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasDesc).toBe(true);
    expect(out.hasName).toBe(true);
    expect(out.hasHint).toBe(true);
  });

  test("simplify is no longer an alias of code-review (split)", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
// code-review registration block must NOT carry a simplify alias.
const crBlock = src.slice(src.indexOf("name: 'code-review'"));
const crSlice = crBlock.slice(0, crBlock.indexOf("userInvocable"));
console.log(JSON.stringify({
  noAliasOnCodeReview: !crSlice.includes("aliases: ['simplify']"),
  hasSimplifySkill: src.includes("name: 'simplify'"),
  bothRegistered: src.includes("registerCodeReviewSkill") && src.includes("registerSimplifySkill"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.noAliasOnCodeReview).toBe(true);
    expect(out.hasSimplifySkill).toBe(true);
    expect(out.bothRegistered).toBe(true);
  });

  test("index.ts registers both skills", async () => {
    const script = `
const src = await Bun.file("${INDEX_FILE}").text();
console.log(JSON.stringify({
  cr: src.includes("registerCodeReviewSkill()"),
  sp: src.includes("registerSimplifySkill()"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.cr).toBe(true);
    expect(out.sp).toBe(true);
  });

  test("runtime: two distinct skills with correct descriptions", async () => {
    const script = `
const { registerCodeReviewSkill, registerSimplifySkill } = await import("${SIMPLIFY_FILE}");
const { getBundledSkills, clearBundledSkills } = await import("${REPO_ROOT}/src/skills/bundledSkills.ts");
clearBundledSkills();
registerCodeReviewSkill();
registerSimplifySkill();
const skills = getBundledSkills();
const cr = skills.find(s => s.name === 'code-review');
const sp = skills.find(s => s.name === 'simplify');
console.log(JSON.stringify({
  count: skills.length,
  crAlias: cr?.aliases ?? null,
  spAlias: sp?.aliases ?? null,
  crHint: cr?.argumentHint,
  spHint: sp?.argumentHint,
  crDescOk: cr?.description?.startsWith("Review the current diff for correctness bugs"),
  spDescOk: sp?.description?.startsWith("Review the changed code for reuse"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.count).toBe(2);
    expect(out.crAlias).toBeNull();
    expect(out.spAlias).toBeNull();
    expect(out.crHint).toBe("[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]");
    expect(out.spHint).toBe("[<target>]");
    expect(out.crDescOk).toBe(true);
    expect(out.spDescOk).toBe(true);
  });
});

describe("2.1.196 (E15) /code-review single merged finder (e2e)", () => {
  test("Find phase uses one finder per correctness angle + ONE merged cleanup finder", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
console.log(JSON.stringify({
  pooled: src.includes("One finder per correctness angle plus one finder covering all cleanup angles, pooled before verify"),
  mergedFinder: src.includes("ONE merged finder covering all cleanup angles"),
  mergedComment: src.includes("keeps one finder per angle; cleanup is one finder covering all cleanup angles"),
  budget: src.includes("cleanup-angle count × perAngle"),
  sameBudget: src.includes("same total cleanup-candidate budget the old per-angle finders had"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.pooled).toBe(true);
    expect(out.mergedFinder).toBe(true);
    expect(out.mergedComment).toBe(true);
    expect(out.budget).toBe(true);
    expect(out.sameBudget).toBe(true);
  });

  test("workflow phases + sweep present", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
console.log(JSON.stringify({
  workflow: src.includes("Scope → Find (barrier) → group-by-location → Verify → Sweep (xhigh/max) → Synthesize"),
  sweep: src.includes("Fresh finder hunting only for gaps (xhigh/max)"),
  synthesize: src.includes("Merge duplicates, rank"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.workflow).toBe(true);
    expect(out.sweep).toBe(true);
    expect(out.synthesize).toBe(true);
  });

  test("effort config matches official binary (high/xhigh/max verbatim)", async () => {
    const script = `
const src = await Bun.file("${SIMPLIFY_FILE}").text();
console.log(JSON.stringify({
  high: src.includes("high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false }"),
  xhigh: src.includes("xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true }"),
  max: src.includes("max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true }"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.high).toBe(true);
    expect(out.xhigh).toBe(true);
    expect(out.max).toBe(true);
  });

  test("runtime: xhigh effort yields merged-finder prompt with sweep", async () => {
    const script = `
const { registerCodeReviewSkill } = await import("${SIMPLIFY_FILE}");
const { getBundledSkills, clearBundledSkills } = await import("${REPO_ROOT}/src/skills/bundledSkills.ts");
clearBundledSkills();
registerCodeReviewSkill();
const cr = getBundledSkills().find(s => s.name === 'code-review');
const p = (await cr.getPromptForCommand('xhigh --fix src/app.ts', {}))[0].text;
console.log(JSON.stringify({
  effort: p.includes('correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true'),
  fix: p.includes('Mode: --fix'),
  merged: p.includes('ONE merged finder covering all cleanup angles'),
  sweepOn: p.includes('Fresh finder hunting only for gaps (xhigh/max)'),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.effort).toBe(true);
    expect(out.fix).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.sweepOn).toBe(true);
  });
});
