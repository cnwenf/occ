import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.126 e2e (Docker): Read tool malware-assessment reminder removed.
 */
describe("2.1.126 malware reminder removed (e2e)", () => {
  test("CYBER_RISK_MITIGATION_REMINDER is empty", async () => {
    const script = `
import { CYBER_RISK_MITIGATION_REMINDER } from "${REPO_ROOT}/src/tools/FileReadTool/FileReadTool.ts";
console.log(JSON.stringify({ isEmpty: CYBER_RISK_MITIGATION_REMINDER === "", hasMalware: CYBER_RISK_MITIGATION_REMINDER.includes("malware") }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.isEmpty).toBe(true);
    expect(out.hasMalware).toBe(false);
  });
});
