import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolPermissionContext } from "../../../Tool";
import { getCwd } from "../../cwd";
import {
  _clearMatcherCacheForTesting,
  _clearUnusablePatternWarningsForTesting,
  _getCachedPatternMatchersForTesting,
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  normalizePermissionRulePattern,
} from "../filesystem";

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as symlinkTwins268).
if (typeof globalThis.MACRO === "undefined") {
  (globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

/**
 * Official 2.1.269 (E14): "Fixed a deny or ask permission rule starting with
 * `!` applying beyond the settings source that wrote it; such a rule now
 * applies only within its own source, and a bare `!` negation is ignored."
 *
 * Byte-verified against added.txt lazy-chunk region ~5,703,000–5,712,500
 * (Ki/Qn/Zr factory A(D,F)/zi walk/TWe) and raw-ELF offsets: Ko @184003751,
 * Zo @184004524, Wne @181040444, yut @181040698, Xn @184123267.
 */

/** Create a minimal ToolPermissionContext with per-source deny/ask/allow rules. */
function makeContext(
  opts: {
    deny?: Partial<Record<string, string[]>>;
    ask?: Partial<Record<string, string[]>>;
    allow?: Partial<Record<string, string[]>>;
  } = {},
): ToolPermissionContext {
  return {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: opts.allow ?? {},
    alwaysDenyRules: opts.deny ?? {},
    alwaysAskRules: opts.ask ?? {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext;
}

function cwdFile(name: string): string {
  return `${getCwd()}/${name}`;
}

beforeEach(() => {
  _clearMatcherCacheForTesting();
  _clearUnusablePatternWarningsForTesting();
});

describe("E14 (2.1.269): !-negation is scoped to its own settings source", () => {
  test("(a) project-settings !-deny does NOT negate a user-settings deny pattern", () => {
    const ctx = makeContext({
      deny: {
        userSettings: ["Read(secret.txt)"],
        projectSettings: ["Read(!secret.txt)"],
      },
    });
    const rule = matchingRuleForInput(
      cwdFile("secret.txt"),
      ctx,
      "read",
      "deny",
    );
    expect(rule).not.toBeNull();
    expect(rule?.source).toBe("userSettings");
    expect(rule?.ruleValue.ruleContent).toBe("secret.txt");
  });

  test("(a-ask) project-settings !-ask does NOT negate a user-settings ask pattern", () => {
    const ctx = makeContext({
      ask: {
        userSettings: ["Read(secret.txt)"],
        projectSettings: ["Read(!secret.txt)"],
      },
    });
    const rule = matchingRuleForInput(cwdFile("secret.txt"), ctx, "read", "ask");
    expect(rule).not.toBeNull();
    expect(rule?.source).toBe("userSettings");
  });

  test("(a-reverse) user-settings !-deny does NOT negate a project-settings deny pattern", () => {
    const ctx = makeContext({
      deny: {
        userSettings: ["Read(!secret.txt)"],
        projectSettings: ["Read(secret.txt)"],
      },
    });
    const rule = matchingRuleForInput(
      cwdFile("secret.txt"),
      ctx,
      "read",
      "deny",
    );
    expect(rule).not.toBeNull();
    expect(rule?.source).toBe("projectSettings");
  });

  test("(structure) each deny source gets its own matcher; allow shares one", () => {
    const denyCtx = makeContext({
      deny: {
        userSettings: ["Read(a.txt)"],
        projectSettings: ["Read(b.txt)"],
      },
    });
    const denyResult = _getCachedPatternMatchersForTesting(
      denyCtx,
      "read",
      "deny",
    );
    const bucket = denyResult.get(null);
    expect(bucket).toBeDefined();
    // Official Zr: one matcher per settings source (SETTing_SOURCES order).
    expect(bucket?.matchers.map((m) => m.source)).toEqual([
      "userSettings",
      "projectSettings",
    ]);
    // Bucket-level patternMap merges all sources (consumer: TWe listing).
    expect([...(bucket?.patternMap.keys() ?? [])].sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);

    const allowCtx = makeContext({
      allow: {
        userSettings: ["Read(a.txt)"],
        projectSettings: ["Read(b.txt)"],
      },
    });
    const allowResult = _getCachedPatternMatchersForTesting(
      allowCtx,
      "read",
      "allow",
    );
    const allowBucket = allowResult.get(null);
    // Official: allow matchers use source null (shared).
    expect(allowBucket?.matchers.length).toBe(1);
    expect(allowBucket?.matchers[0]?.source).toBeNull();
  });
});

describe("E14 (2.1.269): bare ! negation is ignored (dropped)", () => {
  test("(b) bare ! deny rule is dropped and does not affect other deny rules", () => {
    const ctx = makeContext({
      deny: { userSettings: ["Read(!)", "Read(secret.txt)"] },
    });
    const rule = matchingRuleForInput(
      cwdFile("secret.txt"),
      ctx,
      "read",
      "deny",
    );
    expect(rule).not.toBeNull();
    expect(rule?.ruleValue.ruleContent).toBe("secret.txt");

    // The bare `!` never registers as a pattern key anywhere.
    const result = _getCachedPatternMatchersForTesting(ctx, "read", "deny");
    for (const bucket of result.values()) {
      expect([...bucket.patternMap.keys()]).not.toContain("!");
      for (const matcher of bucket.matchers) {
        expect([...matcher.patternMap.keys()]).not.toContain("!");
      }
    }
  });

  test("(b-unit) normalizePermissionRulePattern drops bare ! deny/ask forms", () => {
    // Official Ki: `s=!n&&/^!\s*$/.test(r)?"a negation of every path":Ko(r)`
    expect(normalizePermissionRulePattern("!", false)).toBeNull();
    expect(normalizePermissionRulePattern("!  ", false)).toBeNull();
    // Official: the bare-! special case is deny/ask-only (`!n&&`); an allow
    // `!` compiles fine in the ignore library, so Ki returns it unchanged.
    expect(normalizePermissionRulePattern("!", true)).toBe("!");
  });
});

describe("E14 (2.1.269): ! in an allow rule matches the literal path it spells", () => {
  test("(c-unit) unusable !-prefixed allow pattern is escaped to a literal, not dropped", () => {
    // Official Ki escape branch: `d+Wne(yut(L))+_` with Wne called WITHOUT
    // escapeGlobs, and `m=d?!n:n` → allow+bang = keep as literal.
    // Pattern `!foo\` (trailing unescaped backslash = unusable by ignore).
    expect(normalizePermissionRulePattern("!foo\\", true)).toBe("!foo\\\\");
    // Unusable allow WITHOUT bang → dropped (`m=n=true`).
    expect(normalizePermissionRulePattern("foo\\", true)).toBeNull();
    // Unusable deny WITHOUT bang → escaped to the literal path it spells.
    expect(normalizePermissionRulePattern("foo\\", false)).toBe("foo\\\\");
    // Unusable deny WITH bang → dropped (`m=!n=true`).
    expect(normalizePermissionRulePattern("!foo\\", false)).toBeNull();
    // Usable patterns are returned unchanged (Ki: `if(s===null)return e`).
    expect(normalizePermissionRulePattern("dir/**", true)).toBe("dir/**");
    expect(normalizePermissionRulePattern("!dir/x", false)).toBe("!dir/x");
  });

  test("(c-e2e) unusable deny pattern is registered as the literal escape", () => {
    // `Read( )` (blank content) is skipped by the ignore library; official Ki
    // escapes it to `\ ` ("matching the literal path it spells") and registers
    // THAT as the pattern key, and the matcher's ignore() matches the literal
    // path " " with it. (Full matchingRuleForInput e2e on the " " path is not
    // observable in OCC: expandPath normalizes trailing spaces away before
    // the match walk — registration + compile behavior asserted instead.)
    const ctx = makeContext({ deny: { userSettings: ["Read( )"] } });
    const result = _getCachedPatternMatchersForTesting(ctx, "read", "deny");
    const bucket = result.get(null);
    expect([...(bucket?.patternMap.keys() ?? [])]).toEqual(["\\ "]);
    const igResult = bucket?.matchers[0]?.getIg().test(" ");
    expect(igResult?.ignored).toBe(true);
    expect(igResult?.rule?.pattern).toBe("\\ ");
  });
});

describe("E14 (2.1.269): same-source negation still works", () => {
  test("(d) deny !-rule negates a pattern from the SAME source", () => {
    const ctx = makeContext({
      deny: { userSettings: ["Read(*.log)", "Read(!keep.log)"] },
    });
    const denied = matchingRuleForInput(
      cwdFile("debug.log"),
      ctx,
      "read",
      "deny",
    );
    expect(denied).not.toBeNull();
    expect(denied?.ruleValue.ruleContent).toBe("*.log");
    // Same matcher (same source) → the negation re-includes keep.log.
    const kept = matchingRuleForInput(
      cwdFile("keep.log"),
      ctx,
      "read",
      "deny",
    );
    expect(kept).toBeNull();
  });

  test("(d-ask) ask !-rule negates a pattern from the SAME source", () => {
    const ctx = makeContext({
      ask: { projectSettings: ["Read(*.log)", "Read(!keep.log)"] },
    });
    expect(
      matchingRuleForInput(cwdFile("debug.log"), ctx, "read", "ask"),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(cwdFile("keep.log"), ctx, "read", "ask"),
    ).toBeNull();
  });
});

describe("E14 (2.1.269): single-source regressions", () => {
  test("(e) single-source deny matching is unchanged", () => {
    const ctx = makeContext({
      deny: { userSettings: ["Read(secret.txt)", "Read(node_modules/**)"] },
    });
    const direct = matchingRuleForInput(
      cwdFile("secret.txt"),
      ctx,
      "read",
      "deny",
    );
    expect(direct?.ruleValue.ruleContent).toBe("secret.txt");
    const nested = matchingRuleForInput(
      cwdFile("node_modules/pkg/index.js"),
      ctx,
      "read",
      "deny",
    );
    expect(nested?.ruleValue.ruleContent).toBe("node_modules/**");
    expect(
      matchingRuleForInput(cwdFile("src/app.ts"), ctx, "read", "deny"),
    ).toBeNull();
  });

  test("(e-allow) single-source allow matching is unchanged", () => {
    const ctx = makeContext({
      allow: { userSettings: ["Read(docs/**)"] },
    });
    const rule = matchingRuleForInput(
      cwdFile("docs/readme.md"),
      ctx,
      "read",
      "allow",
    );
    expect(rule?.ruleValue.ruleContent).toBe("docs/**");
    expect(
      matchingRuleForInput(cwdFile("src/app.ts"), ctx, "read", "allow"),
    ).toBeNull();
  });

  test("(e-later-wins) later same-source deny rule replaces earlier same-pattern rule", () => {
    // Official Zr: `if(!_)ce.patternMap.delete(P)` before set — within one
    // matcher the later rule object wins for an identical pattern.
    const ctx = makeContext({
      ask: { userSettings: ["Read(x.txt)"] },
      deny: { userSettings: ["Read(x.txt)"] },
    });
    const askRule = matchingRuleForInput(cwdFile("x.txt"), ctx, "read", "ask");
    expect(askRule?.ruleBehavior).toBe("ask");
    const denyRule = matchingRuleForInput(
      cwdFile("x.txt"),
      ctx,
      "read",
      "deny",
    );
    expect(denyRule?.ruleBehavior).toBe("deny");
  });
});

describe("E14 (2.1.269): TWe pattern listing filters negation keys", () => {
  test("getFileReadIgnorePatterns excludes !-prefixed keys", () => {
    const ctx = makeContext({
      deny: { userSettings: ["Read(!negated.txt)", "Read(kept.txt)"] },
    });
    const patterns = getFileReadIgnorePatterns(ctx);
    const nullRootPatterns = patterns.get(null) ?? [];
    expect(nullRootPatterns).toContain("kept.txt");
    expect(nullRootPatterns).not.toContain("!negated.txt");
  });
});
