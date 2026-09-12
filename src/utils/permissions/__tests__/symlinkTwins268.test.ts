import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolPermissionContext } from "../../../Tool";
import { getPlatform } from "../../platform";
import {
  _clearMatcherCacheForTesting,
  matchingRuleForInput,
} from "../filesystem";
import { isPathAllowed, validatePath } from "../pathValidation";
import {
  _clearPhysicalTwinsForTesting,
  _clearSymlinkEquivalencesForTesting,
  collapsePatternSlashes,
  escapePatternPath,
  getOrInitPhysicalTwins,
  getTrustedSymlinkEquivalences,
  makePhysicalTwinsKey,
  normalizeTrailingGlobstar,
  resolvePhysicalTwinPattern,
  toTrustedSymlinkSpelling,
  unescapePatternSegment,
  unusablePatternReason,
} from "../symlinkEquivalences";

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as symlinkResolutionStash251).
if (typeof globalThis.MACRO === "undefined") {
  (globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

/** Create a minimal ToolPermissionContext with deny/ask/allow rules. */
function makeContext(
  opts: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  } = {},
): ToolPermissionContext {
  return {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext;
}

// Symlink farm laid out once per file:
//   <farm>/real/secret.txt      (physical directory + file)
//   <farm>/link -> real         (symlinked spelling of the same directory)
//   <farm>/star*dir/f.txt       (physical dir whose name has a glob char)
//   <farm>/link3 -> star*dir    (symlink to the glob-named dir)
let farm: string;
let farmReal: string;

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), "occ-e13-"));
  farmReal = realpathSync(farm);
  mkdirSync(join(farmReal, "real"));
  writeFileSync(join(farmReal, "real", "secret.txt"), "top secret");
  symlinkSync("real", join(farmReal, "link"));
  mkdirSync(join(farmReal, "star*dir"));
  writeFileSync(join(farmReal, "star*dir", "f.txt"), "x");
  symlinkSync("star*dir", join(farmReal, "link3"));
});

afterAll(() => {
  rmSync(farm, { recursive: true, force: true });
});

beforeEach(() => {
  _clearMatcherCacheForTesting();
  _clearPhysicalTwinsForTesting();
  _clearSymlinkEquivalencesForTesting();
});

describe("symlinkEquivalences helpers (2.1.268 E13)", () => {
  test("unescapePatternSegment unescapes only the official escapable class (qat)", () => {
    expect(unescapePatternSegment("star\\*dir")).toBe("star*dir");
    expect(unescapePatternSegment("a\\[b\\]")).toBe("a[b]");
    expect(unescapePatternSegment("a\\\\b")).toBe("a\\b");
    // 'n' is NOT in the escapable class — backslash is kept
    expect(unescapePatternSegment("a\\nb")).toBe("a\\nb");
    expect(unescapePatternSegment("plain")).toBe("plain");
  });

  test("escapePatternPath escapes literals for gitignore patterns (Rte escapeGlobs)", () => {
    expect(escapePatternPath("/a(b)/c[d]")).toBe("/a\\(b\\)/c\\[d\\]");
    expect(escapePatternPath("/x*y")).toBe("/x\\*y");
    expect(escapePatternPath("/a\\b")).toBe("/a\\\\b");
    expect(escapePatternPath("!negated")).toBe("\\!negated");
    expect(escapePatternPath("#comment")).toBe("\\#comment");
    expect(escapePatternPath("/trail  ")).toBe("/trail\\ \\ ");
    // '?' is intentionally NOT escaped by the official — faithful port
    expect(escapePatternPath("/q?x")).toBe("/q?x");
  });

  test("collapsePatternSlashes collapses slashes and handles BOM (fn)", () => {
    expect(collapsePatternSlashes("/a//b///c")).toBe("/a/b/c");
    expect(collapsePatternSlashes("/**")).toBe("/**");
    expect(collapsePatternSlashes("   ")).toBe("   ");
    expect(collapsePatternSlashes("\uFEFF!x")).toBe("\\!x");
    expect(collapsePatternSlashes("\uFEFFx")).toBe("x");
  });

  test("normalizeTrailingGlobstar strips /** per official qn semantics", () => {
    expect(normalizeTrailingGlobstar("/a/b/**", false)).toBe("/a/b");
    expect(normalizeTrailingGlobstar("/a/**", true)).toBe("/a");
    // single-segment allow pattern re-anchors with a leading slash
    expect(normalizeTrailingGlobstar("a/**", true)).toBe("/a");
    expect(normalizeTrailingGlobstar("a/**", false)).toBe("a");
    expect(normalizeTrailingGlobstar("/**", true)).toBe("/**");
    expect(normalizeTrailingGlobstar("/a/b", false)).toBe("/a/b");
  });

  test("unusablePatternReason flags blank/comment/trailing-backslash and probe failures (zo)", () => {
    expect(unusablePatternReason("")).toBe(
      "skipped by the ignore library (blank, comment, or trailing backslash)",
    );
    expect(unusablePatternReason("# comment")).toBe(
      "skipped by the ignore library (blank, comment, or trailing backslash)",
    );
    expect(unusablePatternReason("/trailing\\")).toBe(
      "skipped by the ignore library (blank, comment, or trailing backslash)",
    );
    expect(unusablePatternReason("/valid/pattern/**")).toBeNull();
  });

  test("equivalences table only registers machine-verified pairs (Yp guard)", () => {
    const equivalences = getTrustedSymlinkEquivalences();
    const pairs: Array<[string, string]> = [
      ["/private/tmp", "/tmp"],
      ["/private/var", "/var"],
      ["/private/etc", "/etc"],
      ["/usr/bin", "/bin"],
      ["/usr/lib", "/lib"],
      ["/usr/sbin", "/sbin"],
    ];
    for (const [physical, symlinked] of pairs) {
      let expected = false;
      try {
        expected = realpathSync(symlinked) === physical;
      } catch {
        expected = false;
      }
      expect(equivalences.get(physical) === symlinked).toBe(expected);
    }
    // Cache identity: same Map instance until cleared
    expect(getTrustedSymlinkEquivalences()).toBe(equivalences);
    _clearSymlinkEquivalencesForTesting();
    expect(getTrustedSymlinkEquivalences()).not.toBe(equivalences);
  });

  test("toTrustedSymlinkSpelling maps real locations back to symlink spellings (jxt)", () => {
    const equivalences = getTrustedSymlinkEquivalences();
    if (equivalences.size === 0) {
      // No trusted pairs on this machine — mapper must be the identity
      expect(toTrustedSymlinkSpelling("/some/path")).toBe("/some/path");
      return;
    }
    const [physical, symlinked] = equivalences.entries().next()
      .value as [string, string];
    expect(toTrustedSymlinkSpelling(physical)).toBe(symlinked);
    expect(toTrustedSymlinkSpelling(`${physical}/sub/file.txt`)).toBe(
      `${symlinked}/sub/file.txt`,
    );
    // Boundary: a longer dir sharing the prefix string is NOT remapped
    expect(toTrustedSymlinkSpelling(`${physical}suffix/x`)).toBe(
      `${physical}suffix/x`,
    );
    expect(toTrustedSymlinkSpelling("/unrelated/path")).toBe(
      "/unrelated/path",
    );
  });

  test("physicalTwinsByPattern memo accumulates per root-NUL-pattern key", () => {
    const key = makePhysicalTwinsKey("/", "/a/**");
    const set1 = getOrInitPhysicalTwins(key);
    set1.add("/x/**");
    const set2 = getOrInitPhysicalTwins(key);
    expect(set2).toBe(set1); // same Set instance (persists across recompiles)
    expect(set2.has("/x/**")).toBe(true); // twins accumulate
    expect(getOrInitPhysicalTwins(makePhysicalTwinsKey("/", "/b/**")).size).toBe(
      0,
    );
    _clearPhysicalTwinsForTesting();
    expect(getOrInitPhysicalTwins(key).size).toBe(0);
  });
});

describe("resolvePhysicalTwinPattern (2.1.268 zp)", () => {
  test("resolves the physical twin of a symlinked rule prefix", () => {
    expect(resolvePhysicalTwinPattern("/", `/${farmReal}/link/**`)).toBe(
      `${farmReal}/real/**`,
    );
  });

  test("resolves a fully-literal symlinked rule pattern (no glob tail)", () => {
    expect(
      resolvePhysicalTwinPattern("/", `/${farmReal}/link/secret.txt`),
    ).toBe(`${farmReal}/real/secret.txt`);
  });

  test("resolves through a link with a nonexistent tail", () => {
    expect(
      resolvePhysicalTwinPattern("/", `/${farmReal}/link/deep/new.txt`),
    ).toBe(`${farmReal}/real/deep/new.txt`);
  });

  test("returns null when the prefix is already the physical spelling", () => {
    expect(resolvePhysicalTwinPattern("/", `/${farmReal}/real/**`)).toBeNull();
  });

  test("returns null for a nonexistent prefix (fail closed)", () => {
    expect(resolvePhysicalTwinPattern("/", `/${farmReal}/nope/**`)).toBeNull();
  });

  test("returns null when the pattern is not root-anchored or prefix is empty", () => {
    expect(resolvePhysicalTwinPattern("/", "relative/dir/**")).toBeNull();
    expect(resolvePhysicalTwinPattern("/", "/**")).toBeNull();
    expect(resolvePhysicalTwinPattern("/", "/")).toBeNull();
  });

  test("returns null when the first glob segment starts the pattern", () => {
    // literal prefix is empty (prefixEnd === 0)
    expect(resolvePhysicalTwinPattern("/", `/${farmReal}/li*nk/**`)).toBeNull();
  });

  test("escapes glob metacharacters in the resolved physical prefix", () => {
    expect(resolvePhysicalTwinPattern("/", `/${farmReal}/link3/**`)).toBe(
      `${farmReal}/star\\*dir/**`,
    );
    // The escaped physical spelling is already literal — no twin
    expect(
      resolvePhysicalTwinPattern("/", `/${farmReal}/star\\*dir/**`),
    ).toBeNull();
  });

  test("Windows platform guard returns null before touching the filesystem", () => {
    // getPlatform is lodash-memoized with no args → cache key undefined
    const cache = (getPlatform as unknown as { cache: Map<unknown, unknown> })
      .cache;
    cache.set(undefined, "windows");
    try {
      expect(resolvePhysicalTwinPattern("/", `/${farmReal}/link/**`)).toBeNull();
    } finally {
      cache.delete(undefined);
    }
  });
});

// Rule-content form note: the official absolute-path rule spelling is
// `Tool(/` + <abs path> + `)` — e.g. for /tmp/x that is `Read(//tmp/x/**)`
// (the `//` = root marker `/` + the path's own leading slash). Since
// `farmReal` already starts with `/`, the tests below interpolate
// `Read(/${farmReal}/...)`. Writing `Read(//${farmReal}/...)` would produce a
// TRIPLE slash → relativePattern `//tmp/...`, which the ignore library never
// matches (only the twin path survived it, because zp runs fn slash-collapse).
describe("twin registration in getPatternsByRoot (2.1.268 E13b)", () => {
  test("deny rule on the symlinked spelling matches input at the real location", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/link/**)`] });
    const rule = matchingRuleForInput(
      `${farmReal}/real/secret.txt`,
      ctx,
      "read",
      "deny",
    );
    expect(rule).not.toBeNull();
    expect(rule?.ruleBehavior).toBe("deny");
  });

  test("deny rule on the symlinked spelling still matches the symlink spelling", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/link/**)`] });
    // matchingRuleForInput does not resolve input symlinks — the literal
    // pattern must keep working alongside the additive twin
    const rule = matchingRuleForInput(
      `${farmReal}/link/secret.txt`,
      ctx,
      "read",
      "deny",
    );
    expect(rule).not.toBeNull();
  });

  test("Edit deny rule twin works for edit-type matching", () => {
    const ctx = makeContext({ deny: [`Edit(/${farmReal}/link/**)`] });
    const rule = matchingRuleForInput(
      `${farmReal}/real/secret.txt`,
      ctx,
      "edit",
      "deny",
    );
    expect(rule).not.toBeNull();
    expect(rule?.ruleBehavior).toBe("deny");
  });

  test("ask rules get physical twins too (deny/ask-only registration)", () => {
    const ctx = makeContext({ ask: [`Read(/${farmReal}/link/**)`] });
    const rule = matchingRuleForInput(
      `${farmReal}/real/secret.txt`,
      ctx,
      "read",
      "ask",
    );
    expect(rule).not.toBeNull();
    expect(rule?.ruleBehavior).toBe("ask");
  });

  test("allow rules get NO physical twin (official: if(L||q===null)continue)", () => {
    const ctx = makeContext({ allow: [`Read(/${farmReal}/link/**)`] });
    expect(
      matchingRuleForInput(
        `${farmReal}/real/secret.txt`,
        ctx,
        "read",
        "allow",
      ),
    ).toBeNull();
    // the literal allow spelling still matches
    expect(
      matchingRuleForInput(`${farmReal}/link/secret.txt`, ctx, "read", "allow"),
    ).not.toBeNull();
  });

  test("twin does not match paths outside the linked directory", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/link/**)`] });
    expect(
      matchingRuleForInput(`${farmReal}/other.txt`, ctx, "read", "deny"),
    ).toBeNull();
    // A sibling sharing only a STRING prefix of the twin dir (`real`) must not
    // match — gitignore segment boundary. (A file lexically UNDER the linked
    // directory, e.g. `real/x.bak`, IS matched by the twin `real/**` — that is
    // the official additive-twin semantics, not over-match.)
    expect(
      matchingRuleForInput(`${farmReal}/realsibling.txt`, ctx, "read", "deny"),
    ).toBeNull();
  });

  test("physical-spelling deny rule needs no twin (already literal)", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/real/**)`] });
    expect(
      matchingRuleForInput(`${farmReal}/real/secret.txt`, ctx, "read", "deny"),
    ).not.toBeNull();
  });
});

describe("multi-spelling deny matching (2.1.268 E13c)", () => {
  test("isPathAllowed deny catches a link-spelling path via its real location", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/real/**)`] });
    // nonexistent file under the symlink: resolvedPath stays link-spelled
    // (non-canonical), so the deny loop must check resolved spellings too
    const result = isPathAllowed(`${farmReal}/link/new.txt`, ctx, "read");
    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("isPathAllowed deny catches a real-location path via link-spelling rule (twin)", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/link/**)`] });
    const result = isPathAllowed(`${farmReal}/real/secret.txt`, ctx, "read");
    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("without a deny rule the same path fails with no rule reason (sanity)", () => {
    const ctx = makeContext({});
    const result = isPathAllowed(`${farmReal}/link/new.txt`, ctx, "read");
    expect(result.allowed).toBe(false);
    expect(result.decisionReason).toBeUndefined();
  });

  test("validatePath: deny on the symlinked spelling blocks real-location input (changelog headline)", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/link/**)`] });
    const result = validatePath(
      `${farmReal}/real/secret.txt`,
      process.cwd(),
      ctx,
      "read",
    );
    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("validatePath: deny on the real location blocks symlinked-spelling input", () => {
    const ctx = makeContext({ deny: [`Read(/${farmReal}/real/**)`] });
    const result = validatePath(
      `${farmReal}/link/secret.txt`,
      process.cwd(),
      ctx,
      "read",
    );
    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });
});
