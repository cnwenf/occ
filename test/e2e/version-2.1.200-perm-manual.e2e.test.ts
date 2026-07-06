import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 e2e (permissions):
 *   G2: auto-mode classifier denial prefix + unavailable taxonomy
 *   G10: 'default' permission mode renamed to 'Manual' + 'manual' alias
 *
 * Verified against /tmp/occ-audit/claude.strings:
 *   G2  Bhr="Permission for this action was denied by the Claude Code auto mode classifier. Reason: "
 *       iGe="Classifier unavailable"
 *       HIo="Auto mode could not evaluate this action and is blocking it for safety"
 *       T$t="Auto mode classifier transcript exceeded context window — falling back to manual approval (try /compact to reduce conversation size)"
 *       cZa: e.reason===iGe ? `classifier:${e.classifier}:unavailable` : `classifier:${e.classifier}`
 *       mapping: reason===iGe -> automode-unavailable; startsWith(HIo) -> automode-parsing-error; else -> automode-blocked
 *   G10 default:{title:"Manual",shortTitle:"Manual",...}
 *       y_(e){return e==="manual"?"default":e}  (PERMISSION_MODE_MANUAL_ALIAS="manual")
 */
describe("2.1.200 permission taxonomy + Manual mode (e2e)", () => {
  // ---- G2: classifier denial prefix + unavailable taxonomy ----
  describe("G2 classifier denial prefix + taxonomy", () => {
    const msgPath = `${REPO_ROOT}/src/utils/messages.ts`;
    const msgSrc = readFileSync(msgPath, "utf8");

    test("source-grep: binary-exact denial prefix (Bhr)", () => {
      expect(msgSrc).toContain(
        "Permission for this action was denied by the Claude Code auto mode classifier. Reason: ",
      );
    });

    test("source-grep: iGe/HIo/T$t reason constants + taxonomy functions", () => {
      expect(msgSrc).toContain("CLASSIFIER_UNAVAILABLE_REASON = 'Classifier unavailable'");
      expect(msgSrc).toContain(
        "CLASSIFIER_PARSING_ERROR_REASON_PREFIX =\n  'Auto mode could not evaluate this action and is blocking it for safety'",
      );
      expect(msgSrc).toContain(
        "Auto mode classifier transcript exceeded context window — falling back to manual approval (try /compact to reduce conversation size)",
      );
      expect(msgSrc).toContain("getClassifierDecisionTaxonomy");
      expect(msgSrc).toContain("getAutoModePermissionDecision");
      // cZa taxonomy string form (literal ${classifier} — not interpolated).
      expect(msgSrc).toContain(`classifier:\${classifier}:unavailable`);
      // permissionDecision mapping values.
      expect(msgSrc).toContain("automode-unavailable");
      expect(msgSrc).toContain("automode-parsing-error");
      expect(msgSrc).toContain("automode-blocked");
    });

    test("runtime: taxonomy + permissionDecision mapping", async () => {
      const script = `
import {
  CLASSIFIER_UNAVAILABLE_REASON,
  CLASSIFIER_PARSING_ERROR_REASON_PREFIX,
  CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
  getClassifierDecisionTaxonomy,
  getAutoModePermissionDecision,
} from "${msgPath}";
const unavailable = { type: "classifier", classifier: "auto-mode", reason: CLASSIFIER_UNAVAILABLE_REASON };
const parsing = { type: "classifier", classifier: "auto-mode", reason: CLASSIFIER_PARSING_ERROR_REASON_PREFIX + " — stage 1 unparseable" };
const blocked = { type: "classifier", classifier: "auto-mode", reason: "destructive git operation" };
console.log(JSON.stringify({
  txUnavailable: getClassifierDecisionTaxonomy(unavailable),
  txBlocked: getClassifierDecisionTaxonomy(blocked),
  decUnavailable: getAutoModePermissionDecision({ behavior: "deny", decisionReason: unavailable }),
  decParsing: getAutoModePermissionDecision({ behavior: "deny", decisionReason: parsing }),
  decBlocked: getAutoModePermissionDecision({ behavior: "deny", decisionReason: blocked }),
  decUserReject: getAutoModePermissionDecision({ behavior: "deny", userRejected: true }),
  decRule: getAutoModePermissionDecision({ behavior: "deny", decisionReason: { type: "rule" } }),
  decAllow: getAutoModePermissionDecision({ behavior: "allow" }),
  tTooLong: CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON.includes("try /compact"),
}));
`;
      const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
      expect(out.txUnavailable).toBe("classifier:auto-mode:unavailable");
      expect(out.txBlocked).toBe("classifier:auto-mode");
      expect(out.decUnavailable).toBe("automode-unavailable");
      expect(out.decParsing).toBe("automode-parsing-error");
      expect(out.decBlocked).toBe("automode-blocked");
      expect(out.decUserReject).toBe("user-rejected");
      expect(out.decRule).toBe("permission-rule");
      expect(out.decAllow).toBe("allow");
      expect(out.tTooLong).toBe(true);
    });

    test("source-grep: yoloClassifier uses the reason constants", () => {
      const ycSrc = readFileSync(
        `${REPO_ROOT}/src/utils/permissions/yoloClassifier.ts`,
        "utf8",
      );
      expect(ycSrc).toContain("CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON");
      expect(ycSrc).toContain("CLASSIFIER_UNAVAILABLE_REASON");
      expect(ycSrc).toContain("CLASSIFIER_PARSING_ERROR_REASON_PREFIX");
      // Old wording removed.
      expect(ycSrc).not.toContain("Classifier unavailable - blocking for safety");
      expect(ycSrc).not.toContain("Classifier transcript exceeded context window'");
    });
  });

  // ---- G10: 'default' mode → 'Manual' + 'manual' alias ----
  describe("G10 Manual permission mode", () => {
    const modePath = `${REPO_ROOT}/src/utils/permissions/PermissionMode.ts`;
    const modeSrc = readFileSync(modePath, "utf8");

    test("source-grep: default mode titled Manual + manual alias", () => {
      expect(modeSrc).toContain("title: 'Manual'");
      expect(modeSrc).toContain("shortTitle: 'Manual'");
      expect(modeSrc).toContain("PERMISSION_MODE_MANUAL_ALIAS = 'manual'");
      expect(modeSrc).toContain("normalizePermissionModeInput");
    });

    test("runtime: permissionModeFromString accepts 'manual' -> 'default'", async () => {
      const script = `
import { permissionModeFromString, normalizePermissionModeInput, permissionModeTitle, PERMISSION_MODE_MANUAL_ALIAS } from "${modePath}";
console.log(JSON.stringify({
  manual: permissionModeFromString("manual"),
  default: permissionModeFromString("default"),
  normManual: normalizePermissionModeInput("manual"),
  normDefault: normalizePermissionModeInput("default"),
  title: permissionModeTitle("default"),
  alias: PERMISSION_MODE_MANUAL_ALIAS,
}));
`;
      const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
      expect(out.manual).toBe("default");
      expect(out.default).toBe("default");
      expect(out.normManual).toBe("default");
      expect(out.normDefault).toBe("default");
      expect(out.title).toBe("Manual");
      expect(out.alias).toBe("manual");
    });
  });
});
