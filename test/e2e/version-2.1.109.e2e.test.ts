import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.109 e2e (Docker): rotating thinking hints (14 entries,
 * thresholds 1s..165s) + the "last afterMs <= elapsed" selector.
 */
describe("2.1.109 thinking hints (e2e)", () => {
  test("array has 14 entries; selector returns the right hint by elapsed", async () => {
    const script = `
import { THINKING_HINTS, getThinkingHint } from "${REPO_ROOT}/src/components/Spinner/thinkingHints.ts";
console.log(JSON.stringify({
  count: THINKING_HINTS.length,
  first: getThinkingHint(0),
  at1s: getThinkingHint(1000),
  at6s: getThinkingHint(6000),
  at165s: getThinkingHint(165000),
  past: getThinkingHint(999999),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.count).toBe(14);
    expect(out.first).toBeNull();
    expect(out.at1s).toBe("Hmm…");
    expect(out.at6s).toBe("This one needs a moment…");
    expect(out.at165s).toBe("Still here, still at it…");
    expect(out.past).toBe("Still here, still at it…");
  });
});
