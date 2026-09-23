/**
 * CC 2.1.280 (changelog #005, security 🔒) — symlink "landing" write-permission
 * subsystem tests. Binary anchors (official v2.1.280 linux-x64 ELF):
 * - XZe leaf-symlink deny          @194287497
 * - r2e/JZe/pr carriedOut          @194287970/@194288100
 * - lPn/F9t/Or ask sentences       @194288316/@194289151
 * - Dr final-ask merge             @194288763
 * - $r/U9t unresolved deny         @194285675/@194289227
 * - k6/Tn/pu path display          @193836066/@190620617/@190617057
 * - Rxn validatePath write tail    @195392838
 * - tool wiring Write/Edit/Notebook @198310186/@201063176/@201076162
 *
 * Farm layout (all under realpath'd tmpdir `farmReal`):
 *   inside/plain.txt                        (plain file inside working dir)
 *   inside/link.txt   -> ../outside/secret.txt   (leaf link escaping the wd)
 *   inside/link2.txt  -> plain.txt               (leaf link staying inside)
 *   inside/dirlink    -> ../outside              (dir link escaping the wd)
 *   inside/loop1.txt <-> loop2.txt               (circular)
 *   inside/nb.ipynb   -> ../outside/nb.ipynb     (notebook leaf link)
 *   outside/secret.txt
 *   outside/.claude/settings.json           (safety-merge target)
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import type { ToolPermissionContext, ToolUseContext } from "../../../Tool";
import { FileEditTool } from "../../../tools/FileEditTool/FileEditTool";
import { FileWriteTool } from "../../../tools/FileWriteTool/FileWriteTool";
import { NotebookEditTool } from "../../../tools/NotebookEditTool/NotebookEditTool";
import {
  identityWritePathDescriptor,
  resolveWritePathDescriptor,
  type UnresolvedWritePathDescriptor,
  type WritePathDescriptor,
} from "../../fsOperations";
import {
  _clearMatcherCacheForTesting,
  checkLeafSymlinkWriteDeny,
  checkPathSafetyForAutoEdit,
  checkWritePermissionForTool,
  computeWriteCarriedOut,
  formatPathForPermissionMessage,
  unresolvedWriteDenyDecision,
  wherePathLeadsUndeterminedReason,
} from "../filesystem";
import { validatePath } from "../pathValidation";
import {
  _clearPhysicalTwinsForTesting,
  _clearSymlinkEquivalencesForTesting,
} from "../symlinkEquivalences";
import { getSessionWritePermissionStash } from "../symlinkResolutionStash";

if (typeof globalThis.MACRO === "undefined") {
  (globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

function makeContext(
  opts: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
    workdir?: string;
    mode?: ToolPermissionContext["mode"];
  } = {},
): ToolPermissionContext {
  return {
    mode: opts.mode ?? "default",
    additionalWorkingDirectories: new Map(
      opts.workdir !== undefined
        ? [
            [
              opts.workdir,
              { path: opts.workdir, source: "userSettings" as const },
            ],
          ]
        : [],
    ),
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext;
}

type WriteCheckTool = Parameters<typeof checkWritePermissionForTool>[0];
const fakeEditTool = {
  name: "Edit",
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as WriteCheckTool;

let farm: string;
let farmReal: string;
let inside: string;
let outside: string;
let link: string; // inside/link.txt (leaf -> outside/secret.txt)
let secret: string; // outside/secret.txt
let link2: string; // inside/link2.txt (leaf -> inside/plain.txt)
let plain: string; // inside/plain.txt
let dirlinkNew: string; // inside/dirlink/new.txt (tail under escaping dir link)
let landingNew: string; // outside/new.txt (its physical landing)
let loop1: string; // inside/loop1.txt (circular)
let nbLink: string; // inside/nb.ipynb (leaf -> outside/nb.ipynb)
let claudeSettings: string; // outside/.claude/settings.json

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), "occ-land280-"));
  farmReal = realpathSync(farm);
  inside = join(farmReal, "inside");
  outside = join(farmReal, "outside");
  mkdirSync(inside);
  mkdirSync(outside);
  mkdirSync(join(outside, ".claude"));
  writeFileSync(join(inside, "plain.txt"), "ok");
  writeFileSync(join(outside, "secret.txt"), "top secret");
  writeFileSync(join(outside, ".claude", "settings.json"), "{}");
  writeFileSync(join(outside, "nb.ipynb"), '{"cells":[],"nbformat":4,"nbformat_minor":5,"metadata":{}}');
  symlinkSync(join("..", "outside", "secret.txt"), join(inside, "link.txt"));
  symlinkSync("plain.txt", join(inside, "link2.txt"));
  symlinkSync(join("..", "outside"), join(inside, "dirlink"));
  symlinkSync("loop2.txt", join(inside, "loop1.txt"));
  symlinkSync("loop1.txt", join(inside, "loop2.txt"));
  symlinkSync(join("..", "outside", "nb.ipynb"), join(inside, "nb.ipynb"));
  link = join(inside, "link.txt");
  secret = join(outside, "secret.txt");
  link2 = join(inside, "link2.txt");
  plain = join(inside, "plain.txt");
  dirlinkNew = join(inside, "dirlink", "new.txt");
  landingNew = join(outside, "new.txt");
  loop1 = join(inside, "loop1.txt");
  nbLink = join(inside, "nb.ipynb");
  claudeSettings = join(outside, ".claude", "settings.json");
});

afterAll(() => {
  rmSync(farm, { recursive: true, force: true });
});

beforeEach(() => {
  _clearMatcherCacheForTesting();
  _clearPhysicalTwinsForTesting();
  _clearSymlinkEquivalencesForTesting();
});

const insideCtx = (
  opts: Parameters<typeof makeContext>[0] = {},
): ToolPermissionContext => makeContext({ workdir: inside, ...opts });

// The v280 carriedOut ask sentence (F9t @194288316 + Or @194289151).
const resolvesSentence = (requested: string, landing: string): string =>
  `${requested} resolves through a symlink to ${landing}, which is outside the allowed working directories`;

describe("formatPathForPermissionMessage (binary k6 = pu(Tn(e),160) @193836066)", () => {
  test("short ASCII path is identity", () => {
    expect(formatPathForPermissionMessage("/a/b.txt")).toBe("/a/b.txt");
  });

  test("paths over 160 chars truncate with the official [+N chars] tail (pu @190620617)", () => {
    const long = "x".repeat(200);
    expect(formatPathForPermissionMessage(long)).toBe(
      `${"x".repeat(160)}… [+40 chars]`,
    );
  });

  test("a split surrogate pair at the cut drops the high surrogate (re @190617057)", () => {
    const s = `${"a".repeat(159)}\u{1F600}${"b".repeat(50)}`;
    expect(formatPathForPermissionMessage(s)).toBe(
      `${"a".repeat(159)}… [+52 chars]`,
    );
  });

  test("each Pn-matched codepoint becomes its own U+FFFD (Pn exact @193836066)", () => {
    expect(formatPathForPermissionMessage("a\u0007b")).toBe("a\uFFFDb");
    // per-character replacement, NOT run-collapse: two controls -> two U+FFFD
    expect(formatPathForPermissionMessage("a\u0007\u0008b")).toBe(
      "a\uFFFD\uFFFDb",
    );
    expect(formatPathForPermissionMessage("a\u2028b")).toBe("a\uFFFDb");
    expect(formatPathForPermissionMessage("a\u061cb")).toBe("a\uFFFDb");
    expect(formatPathForPermissionMessage("a\u202eb")).toBe("a\uFFFDb");
  });

  test("U+2800 braille blank is untouched (not in the exact Pn class)", () => {
    expect(formatPathForPermissionMessage("a\u2800b")).toBe("a\u2800b");
  });

  test("E deletes Cf-class invisibles inside zp; Mn variation selectors survive", () => {
    // ZWJ/ZWSP (Cf) and BOM are deleted by E @190823811
    expect(formatPathForPermissionMessage("a\u200Db")).toBe("ab");
    expect(formatPathForPermissionMessage("a\u200Bb")).toBe("ab");
    expect(formatPathForPermissionMessage("a\uFEFFb")).toBe("ab");
    // VS15/VS16 are category Mn — not in Pn, not deleted by E
    expect(formatPathForPermissionMessage("a\uFE0Eb")).toBe("a\uFE0Eb");
    expect(formatPathForPermissionMessage("a\uFE0Fb")).toBe("a\uFE0Fb");
  });

  test("Private Use Area becomes U+FFFD (Pn \\p{Co} fires before E sees it)", () => {
    expect(formatPathForPermissionMessage("a\uE000b\uF8FFc")).toBe(
      "a\uFFFDb\uFFFDc",
    );
  });

  test("ANSI stripping appends one U+FFFD marker (Tn: r===e?r:r+marker)", () => {
    expect(formatPathForPermissionMessage("\u001B[31mfoo\u001B[0m")).toBe(
      "foo\uFFFD",
    );
  });
});

describe("checkLeafSymlinkWriteDeny (binary XZe @194287497)", () => {
  test("non-leaf descriptor → null", () => {
    expect(checkLeafSymlinkWriteDeny("/a/b", identityWritePathDescriptor("/a/b"))).toBeNull();
    const d = resolveWritePathDescriptor(dirlinkNew);
    expect(d.leafIsSymlink).toBe(false);
    expect(checkLeafSymlinkWriteDeny(dirlinkNew, d)).toBeNull();
  });

  test("resolved leaf symlink → byte-exact deny with blockedPath = landing", () => {
    const d = resolveWritePathDescriptor(link);
    const decision = checkLeafSymlinkWriteDeny(link, d);
    expect(decision).not.toBeNull();
    expect(decision!.behavior).toBe("deny");
    expect(decision!.message).toBe(
      `Refusing to write ${link}: it is a symbolic link. Write to the link's target path instead: ${secret}.`,
    );
    expect(decision!.decisionReason).toEqual({
      type: "other",
      reason: "Write target is a symbolic link",
    });
    expect(decision!.blockedPath).toBe(secret);
  });

  test("unresolved leaf → 'a target that could not be determined', NO blockedPath", () => {
    const d: UnresolvedWritePathDescriptor = {
      unresolved: true,
      requested: link,
      spellings: [link],
      stoppedAt: link,
      leafIsSymlink: true,
    };
    const decision = checkLeafSymlinkWriteDeny(link, d);
    expect(decision).not.toBeNull();
    expect(decision!.message).toBe(
      `Refusing to write ${link}: it is a symbolic link. Write to the link's target path instead: a target that could not be determined.`,
    );
    expect("blockedPath" in decision!).toBe(false);
  });
});

describe("unresolved write deny (binary $r/U9t @194285675/@194289227)", () => {
  test("byte-exact message and reason (note the intentional wording difference)", () => {
    const d = unresolvedWriteDenyDecision("/p/q");
    expect(d.behavior).toBe("deny");
    expect(d.message).toBe(
      "Refusing to write /p/q: where it leads on disk could not be determined (a link on the way could not be examined, or the links do not resolve).",
    );
    expect(d.decisionReason).toEqual({
      type: "other",
      reason:
        "Where /p/q leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)",
    });
    expect("blockedPath" in d).toBe(false);
  });

  test("wherePathLeadsUndeterminedReason (U9t) standalone", () => {
    expect(wherePathLeadsUndeterminedReason("/p/q")).toBe(
      "Where /p/q leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)",
    );
  });
});

describe("computeWriteCarriedOut (binary r2e @194287970)", () => {
  test("identity descriptor (landing ≡ requested) → null (JZe)", () => {
    expect(
      computeWriteCarriedOut(identityWritePathDescriptor(plain), insideCtx()),
    ).toBeNull();
    const d = resolveWritePathDescriptor(plain);
    expect(computeWriteCarriedOut(d, insideCtx())).toBeNull();
  });

  test("unresolved descriptor → null (JZe guard)", () => {
    const d = resolveWritePathDescriptor(loop1);
    expect(d.unresolved).toBe(true);
    expect(computeWriteCarriedOut(d, insideCtx())).toBeNull();
  });

  test("escaping leaf link: landingOutside + spellingInside → carriedOut (the #005 attack shape)", () => {
    const d = resolveWritePathDescriptor(link);
    const c = computeWriteCarriedOut(d, insideCtx());
    expect(c).not.toBeNull();
    expect(c!.landing).toBe(secret);
    expect(c!.landingOutside).toBe(true);
    expect(c!.spellingInside).toBe(true);
    expect(c!.carriedOut).toBe(true);
  });

  test("escaping dir-link tail (nonexistent landing): carriedOut", () => {
    const d = resolveWritePathDescriptor(dirlinkNew);
    const c = computeWriteCarriedOut(d, insideCtx());
    expect(c).not.toBeNull();
    expect(c!.landing).toBe(landingNew);
    expect(c!.carriedOut).toBe(true);
  });

  test("leaf link staying inside: landingOutside=false → carriedOut=false", () => {
    const d = resolveWritePathDescriptor(link2);
    const c = computeWriteCarriedOut(d, insideCtx());
    expect(c).not.toBeNull();
    expect(c!.landing).toBe(plain);
    expect(c!.landingOutside).toBe(false);
    expect(c!.carriedOut).toBe(false);
  });

  test("whole-farm working dir: landing is not outside → carriedOut=false", () => {
    const d = resolveWritePathDescriptor(link);
    const c = computeWriteCarriedOut(d, makeContext({ workdir: farmReal }));
    expect(c).not.toBeNull();
    expect(c!.spellingInside).toBe(true); // both inside and outside are under farmReal
    // with the whole farm as the working dir nothing is "outside"
    expect(c!.landingOutside).toBe(false);
    expect(c!.carriedOut).toBe(false);
  });
});

describe("checkWritePermissionForTool — unresolved DENY (step 1.55, binary D_ @194285675)", () => {
  test("real circular symlink → byte-exact deny, before any allow/ask rule", () => {
    const ctx = insideCtx({ allow: [`Edit(/${farmReal}/inside/**)`] });
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: loop1 },
      ctx,
    );
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toBe(
      `Refusing to write ${loop1}: where it leads on disk could not be determined (a link on the way could not be examined, or the links do not resolve).`,
    );
    expect(result.decisionReason).toEqual({
      type: "other",
      reason: `Where ${loop1} leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)`,
    });
  });

  test("injected unresolved descriptor takes the same branch", () => {
    const p = join(inside, "phantom.txt");
    const d: UnresolvedWritePathDescriptor = {
      unresolved: true,
      requested: p,
      spellings: [p],
      stoppedAt: p,
      leafIsSymlink: false,
    };
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: p },
      insideCtx(),
      undefined,
      d,
    );
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain(
      "where it leads on disk could not be determined",
    );
  });
});

describe("checkWritePermissionForTool — carriedOut final ask (binary Dr @194288763)", () => {
  test("escaping symlink in default mode → ask with sentence, blockedPath, safetyCheck reason", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: link },
      insideCtx(),
    ) as {
      behavior: string;
      message: string;
      blockedPath?: string;
      decisionReason?: { type: string; reason?: string; classifierApprovable?: boolean };
    };
    expect(result.behavior).toBe("ask");
    const sentence = resolvesSentence(link, secret);
    expect(result.message).toBe(
      `Claude requested permissions to write to ${link}, but you haven't granted it yet. ${sentence}.`,
    );
    expect(result.blockedPath).toBe(secret);
    expect(result.decisionReason).toEqual({
      type: "safetyCheck",
      reason: sentence,
      classifierApprovable: false,
    });
  });

  test("acceptEdits does NOT auto-allow a carried-out write (Nh judges the landing)", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: link },
      insideCtx({ mode: "acceptEdits" }),
    ) as { behavior: string; blockedPath?: string };
    expect(result.behavior).toBe("ask");
    expect(result.blockedPath).toBe(secret);
  });

  test("acceptEdits DOES allow a link landing inside (no over-deny)", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: link2 },
      insideCtx({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("allow");
    expect(result.decisionReason).toEqual({
      type: "mode",
      mode: "acceptEdits",
    });
  });

  test("escaping dir-link tail (nonexistent landing) → same Dr ask shape", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: dirlinkNew },
      insideCtx(),
    ) as { behavior: string; message: string; blockedPath?: string };
    expect(result.behavior).toBe("ask");
    expect(result.message).toBe(
      `Claude requested permissions to write to ${dirlinkNew}, but you haven't granted it yet. ${resolvesSentence(dirlinkNew, landingNew)}.`,
    );
    expect(result.blockedPath).toBe(landingNew);
  });

  test("plain path outside the working dir → workingDir ask (unchanged)", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: secret },
      insideCtx(),
    ) as { behavior: string; message: string; decisionReason?: unknown };
    expect(result.behavior).toBe("ask");
    expect(result.message).toBe(
      `Claude requested permissions to write to ${secret}, but you haven't granted it yet.`,
    );
    expect(result.decisionReason).toEqual({
      type: "workingDir",
      reason: "Path is outside allowed working directories",
    });
    expect("blockedPath" in result).toBe(false);
  });

  test("plain path inside the working dir, default mode → plain ask, no reason", () => {
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: plain },
      insideCtx(),
    ) as { behavior: string; decisionReason?: unknown };
    expect(result.behavior).toBe("ask");
    expect(result.decisionReason).toBeUndefined();
  });
});

describe("checkWritePermissionForTool — safety-branch merge (binary lPn @194288316)", () => {
  test("unsafe landing via dirlink → ask message merged with the landing sentence, classifierApprovable:false, blockedPath=landing", () => {
    const requested = `${inside}/dirlink/.claude/settings.json`;
    const d = resolveWritePathDescriptor(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.landing).toBe(claudeSettings);
    const baseSafety = checkPathSafetyForAutoEdit(requested, d.spellings) as {
      safe: boolean;
      message?: string;
    };
    expect(baseSafety.safe).toBe(false);
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: requested },
      insideCtx(),
    ) as {
      behavior: string;
      message: string;
      blockedPath?: string;
      decisionReason?: { type: string; reason?: string; classifierApprovable?: boolean };
    };
    expect(result.behavior).toBe("ask");
    const sentence = resolvesSentence(requested, claudeSettings);
    expect(result.message).toBe(`${baseSafety.message} ${sentence}.`);
    expect(result.blockedPath).toBe(claudeSettings);
    expect(result.decisionReason?.type).toBe("safetyCheck");
    expect(result.decisionReason?.reason).toBe(result.message);
    expect(result.decisionReason?.classifierApprovable).toBe(false);
  });
});

describe("tool wiring — leaf deny overrides ALLOW, rule deny wins (binary @198310186/@201063176/@201076162)", () => {
  function makeToolContext(
    toolUseId: string,
    permCtx: ToolPermissionContext,
  ): ToolUseContext {
    return {
      toolUseId,
      getAppState: () => ({ toolPermissionContext: permCtx }),
    } as unknown as ToolUseContext;
  }

  test("FileWriteTool: allow-rule-covered escaping leaf link is STILL denied (XZe after D_)", async () => {
    const ctx = insideCtx({
      allow: [`Edit(/${farmReal}/inside/**)`, `Edit(/${farmReal}/outside/**)`],
    });
    const result = (await FileWriteTool.checkPermissions(
      { file_path: link, content: "x" },
      makeToolContext("tu-s3-write-leaf", ctx),
    )) as { behavior: string; message: string; blockedPath?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe(
      `Refusing to write ${link}: it is a symbolic link. Write to the link's target path instead: ${secret}.`,
    );
    expect(result.blockedPath).toBe(secret);
  });

  test("FileWriteTool: a rule DENY takes precedence over the leaf deny", async () => {
    const ctx = insideCtx({ deny: [`Edit(/${farmReal}/inside/link.txt)`] });
    const result = (await FileWriteTool.checkPermissions(
      { file_path: link, content: "x" },
      makeToolContext("tu-s3-write-deny", ctx),
    )) as { behavior: string; message: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe(`Permission to edit ${link} has been denied.`);
  });

  test("FileWriteTool: check-time stash holds the descriptor spellings (v280 stash site)", async () => {
    const ctx = insideCtx();
    await FileWriteTool.checkPermissions(
      { file_path: dirlinkNew, content: "x" },
      makeToolContext("tu-s3-stash", ctx),
    );
    const entry = getSessionWritePermissionStash().consume(
      "tu-s3-stash",
      dirlinkNew,
      "write",
    );
    expect(Array.isArray(entry)).toBe(true);
    const stashed = entry as string[];
    expect(stashed).toContain(dirlinkNew);
    expect(stashed).toContain(landingNew);
  });

  test("FileEditTool: escaping leaf link denied with the XZe message", async () => {
    const ctx = insideCtx({
      allow: [`Edit(/${farmReal}/inside/**)`, `Edit(/${farmReal}/outside/**)`],
    });
    const result = (await FileEditTool.checkPermissions(
      { file_path: link, old_string: "a", new_string: "b" },
      makeToolContext("tu-s3-edit-leaf", ctx),
    )) as { behavior: string; message: string; blockedPath?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe(
      `Refusing to write ${link}: it is a symbolic link. Write to the link's target path instead: ${secret}.`,
    );
    expect(result.blockedPath).toBe(secret);
  });

  test("NotebookEditTool: escaping notebook leaf link denied with the XZe message", async () => {
    const ctx = insideCtx({
      allow: [`Edit(/${farmReal}/inside/**)`, `Edit(/${farmReal}/outside/**)`],
    });
    const result = (await NotebookEditTool.checkPermissions(
      { notebook_path: nbLink, new_source: "x" },
      makeToolContext("tu-s3-nb-leaf", ctx),
    )) as { behavior: string; message: string; blockedPath?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe(
      `Refusing to write ${nbLink}: it is a symbolic link. Write to the link's target path instead: ${join(outside, "nb.ipynb")}.`,
    );
    expect(result.blockedPath).toBe(join(outside, "nb.ipynb"));
  });

  test("FileWriteTool: escaping dir-link tail asks with the Dr merge (pass-through of D_)", async () => {
    const ctx = insideCtx();
    const result = (await FileWriteTool.checkPermissions(
      { file_path: dirlinkNew, content: "x" },
      makeToolContext("tu-s3-write-ask", ctx),
    )) as { behavior: string; message: string; blockedPath?: string };
    expect(result.behavior).toBe("ask");
    expect(result.message).toBe(
      `Claude requested permissions to write to ${dirlinkNew}, but you haven't granted it yet. ${resolvesSentence(dirlinkNew, landingNew)}.`,
    );
    expect(result.blockedPath).toBe(landingNew);
  });
});

describe("validatePath write tail (binary Rxn @195392838)", () => {
  test("carried-out write: resolvedPath becomes the landing", () => {
    const result = validatePath(dirlinkNew, inside, insideCtx(), "write");
    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe(landingNew);
  });

  test("plain inside write: resolvedPath stays the requested absolute path", () => {
    const result = validatePath(plain, inside, insideCtx(), "write");
    expect(result.allowed).toBe(false); // default mode, no rules
    expect(result.resolvedPath).toBe(plain);
  });

  test("acceptEdits inside write: allowed, resolvedPath is the requested path", () => {
    const result = validatePath(
      plain,
      inside,
      insideCtx({ mode: "acceptEdits" }),
      "write",
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(plain);
  });

  test("escaping symlink write is judged on the LANDING (deny rule on the physical dir catches it)", () => {
    const ctx = insideCtx({
      deny: [`Edit(/${farmReal}/outside/**)`],
      mode: "acceptEdits",
    });
    const result = validatePath(dirlinkNew, inside, ctx, "write");
    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("read lane keeps the pre-280 safeResolvePath flow", () => {
    const result = validatePath(secret, inside, insideCtx(), "read");
    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe(secret);
  });
});
