import { describe, expect, test } from "bun:test";
import { join } from "path";
import type { ToolPermissionContext } from "../../../Tool";
import {
  _clearMatcherCacheForTesting,
  matchingRuleForInput,
} from "../filesystem";

/**
 * M1 (Claude Code 2.1.214): single-segment `dir/**` allow rules must anchor to
 * the rule root, NOT match a same-named directory at any depth.
 *
 * Before the fix, `Edit(./myproject/**)` was normalized to the bare name
 * `myproject`, which the `ignore` library (gitignore semantics) matches at ANY
 * depth — so `Edit(./myproject/**)` silently auto-approved writes to
 * `<cwd>/a/myproject/secret.txt`, a fail-open over-permission bypass.
 *
 * Per official 2.1.214: a single-segment dir-wildcard rule matches only the
 * scope directly under the rule root; an explicit any-depth (double-star
 * prefixed) pattern matches at any depth; deny/ask rules KEEP any-depth
 * matching.
 *
 * Red-test checklist from the OCC security reviewer (OCC-10 / M1), aligned to
 * the official binary behavior via the `aligning-with-official-binary` skill.
 */

const CWD = process.cwd();

/** Create a minimal ToolPermissionContext with allow/deny rules. */
function makeContext(
  opts: {
    allow?: string[];
    deny?: string[];
  } = {},
): ToolPermissionContext {
  return {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext;
}

describe("M1 (2.1.214): single-segment dir/** allow rules anchor to cwd", () => {
  test("Read(./myproject/**) does NOT allow a same-named dir at any depth", () => {
    _clearMatcherCacheForTesting();
    const ctx = makeContext({ allow: ["Read(./myproject/**)"] });

    // Nested same-named directory — must NOT be auto-approved (the bypass).
    expect(
      matchingRuleForInput(
        join(CWD, "a/myproject/secret.txt"),
        ctx,
        "read",
        "allow",
      ),
    ).toBeNull();
    expect(
      matchingRuleForInput(
        join(CWD, "deep/nested/myproject/x"),
        ctx,
        "read",
        "allow",
      ),
    ).toBeNull();
  });

  test("Read(./myproject/**) still allows the legit scope under <cwd>/myproject/**", () => {
    _clearMatcherCacheForTesting();
    const ctx = makeContext({ allow: ["Read(./myproject/**)"] });

    expect(
      matchingRuleForInput(join(CWD, "myproject/file.txt"), ctx, "read", "allow"),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(
        join(CWD, "myproject/sub/file.txt"),
        ctx,
        "read",
        "allow",
      ),
    ).not.toBeNull();
  });

  test("Edit(./proj/**) mirrors Read behavior (edit rules use the same matcher)", () => {
    _clearMatcherCacheForTesting();
    const ctx = makeContext({ allow: ["Edit(./proj/**)"] });

    // Bypass targets — rejected.
    expect(
      matchingRuleForInput(join(CWD, "a/proj/secret.ts"), ctx, "edit", "allow"),
    ).toBeNull();
    expect(
      matchingRuleForInput(
        join(CWD, "deep/nested/proj/x.ts"),
        ctx,
        "edit",
        "allow",
      ),
    ).toBeNull();
    // Legit scope — allowed.
    expect(
      matchingRuleForInput(join(CWD, "proj/file.ts"), ctx, "edit", "allow"),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(join(CWD, "proj/sub/file.ts"), ctx, "edit", "allow"),
    ).not.toBeNull();
  });

  test("**/dir/** (explicit any-depth) still matches a same-named dir anywhere", () => {
    _clearMatcherCacheForTesting();
    const ctx = makeContext({ allow: ["Read(**/myproject/**)"] });

    // The explicit any-depth escape hatch is preserved.
    expect(
      matchingRuleForInput(
        join(CWD, "a/myproject/secret.txt"),
        ctx,
        "read",
        "allow",
      ),
    ).not.toBeNull();
  });

  test("deny(./myproject/**) KEEPS any-depth match (deny semantics unchanged)", () => {
    _clearMatcherCacheForTesting();
    // deny rules are tool-prefixed (Read/Edit) in the deny bucket, matching
    // matcherCache.test.ts convention — NOT a `Deny(...)` wrapper.
    const ctx = makeContext({ deny: ["Read(./myproject/**)"] });

    // deny must still match the nested same-named dir at any depth (regression
    // guard: the M1 fix only anchors `allow`, never `deny`/`ask`).
    expect(
      matchingRuleForInput(
        join(CWD, "a/myproject/secret.txt"),
        ctx,
        "read",
        "deny",
      ),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(
        join(CWD, "deep/nested/myproject/x"),
        ctx,
        "read",
        "deny",
      ),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(join(CWD, "myproject/file.txt"), ctx, "read", "deny"),
    ).not.toBeNull();
  });
});
