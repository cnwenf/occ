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
import type { ToolPermissionContext } from "../../../Tool";
import {
  DANGEROUS_DIRECTORIES,
  _clearMatcherCacheForTesting,
  checkWritePermissionForTool,
  isDangerousFilePathToAutoEdit,
} from "../filesystem";
import {
  _clearPhysicalTwinsForTesting,
  _clearSymlinkEquivalencesForTesting,
} from "../symlinkEquivalences";

describe("DANGEROUS_DIRECTORIES (claude-code 2.1.90: .husky protected)", () => {
  test("includes .husky", () => {
    expect(DANGEROUS_DIRECTORIES).toContain(".husky");
  });

  test("still includes the pre-2.1.90 set", () => {
    expect(DANGEROUS_DIRECTORIES).toEqual([
      ".git",
      ".vscode",
      ".idea",
      ".claude",
      ".husky",
    ]);
  });
});

describe("isDangerousFilePathToAutoEdit: .husky", () => {
  test("blocks a file directly under .husky/", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.husky/pre-commit")).toBe(true);
  });

  test("blocks a nested file under .husky/", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.husky/scripts/lint.sh")).toBe(
      true,
    );
  });

  test("is case-insensitive against .husky", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.HUSKY/pre-commit")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/repo/.HuSkY/pre-commit")).toBe(true);
  });

  test("still blocks .git paths (regression)", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/.git/config")).toBe(true);
  });

  test("does not block an ordinary source path", () => {
    expect(isDangerousFilePathToAutoEdit("/repo/src/index.ts")).toBe(false);
  });

  test("does not block a file merely named like .husky (segment match only)", () => {
    // A file named ".husky" at the root is a segment match → blocked.
    // But a file whose *name* contains husky but isn't in a .husky dir is fine.
    expect(isDangerousFilePathToAutoEdit("/repo/husky-config.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CC 2.1.280 (Fkt): allow-rule match requires ALL path spellings (requested +
// symlink-resolved) to be allowed — fail-CLOSED. Official v280 `Fkt` @194277899
// (byte-identical to v278 `Ibt` @195625759):
//   `function Fkt(e,n,r){let s=null;for(let u of e){let m=wa(u,n,r,"allow");
//     if(!m){let g=$kt(u);if(g!==u)m=wa(g,n,r,"allow")}
//     if(!m)return null;s??=m}return s}`
// Changelog 2.1.280: a write to a symlinked path is judged by where it lands;
// allow rules no longer approve a write whose resolved target sits outside the
// rule. NARROW PORT — the full official descriptor walker (da() @190660855)
// is staged and NOT exercised here.
// ---------------------------------------------------------------------------

// checkEditableInternalPath may read MACRO.VERSION; mirror the cli.tsx
// polyfill (same convention as symlinkTwins268/symlinkResolutionStash251).
if (typeof globalThis.MACRO === "undefined") {
  (globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

/** Minimal ToolPermissionContext with allow/deny/ask rules (userSettings). */
function makeContext(
  opts: { deny?: string[]; ask?: string[]; allow?: string[] } = {},
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

type WriteCheckTool = Parameters<typeof checkWritePermissionForTool>[0];
const fakeEditTool = {
  name: "Edit",
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as WriteCheckTool;

// Symlink farm laid out once per file (all requested paths use the realpath
// spelling so the requested/resolved pair is deterministic):
//   <farm>/inside/plain.txt                     (plain file inside the rule)
//   <farm>/inside/link2.txt -> plain.txt        (symlink landing INSIDE)
//   <farm>/outside/secret.txt                   (physical file outside)
//   <farm>/inside/link.txt -> ../outside/secret.txt  (symlink landing OUTSIDE)
let farm: string;
let farmReal: string;

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), "occ-fkt280-"));
  farmReal = realpathSync(farm);
  mkdirSync(join(farmReal, "inside"));
  mkdirSync(join(farmReal, "outside"));
  writeFileSync(join(farmReal, "inside", "plain.txt"), "ok");
  writeFileSync(join(farmReal, "outside", "secret.txt"), "top secret");
  symlinkSync("plain.txt", join(farmReal, "inside", "link2.txt"));
  symlinkSync(
    join("..", "outside", "secret.txt"),
    join(farmReal, "inside", "link.txt"),
  );
});

afterAll(() => {
  rmSync(farm, { recursive: true, force: true });
});

beforeEach(() => {
  _clearMatcherCacheForTesting();
  _clearPhysicalTwinsForTesting();
  _clearSymlinkEquivalencesForTesting();
});

describe("checkWritePermissionForTool — 2.1.280 all-spellings allow match (Fkt)", () => {
  test("allow rule on the requested spelling alone does NOT pass a symlink landing outside", () => {
    const ctx = makeContext({ allow: [`Edit(/${farmReal}/inside/**)`] });
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: join(farmReal, "inside", "link.txt") },
      ctx,
    );
    // The resolved spelling <farm>/outside/secret.txt is not covered by the
    // rule → fail-closed to ask (pre-280 OCC allowed on the requested
    // spelling alone).
    expect(result.behavior).toBe("ask");
  });

  test("plain path inside the rule is unaffected (still allowed)", () => {
    const ctx = makeContext({ allow: [`Edit(/${farmReal}/inside/**)`] });
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: join(farmReal, "inside", "plain.txt") },
      ctx,
    );
    expect(result.behavior).toBe("allow");
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("symlink landing INSIDE the allowed area is still allowed (no over-deny)", () => {
    const ctx = makeContext({ allow: [`Edit(/${farmReal}/inside/**)`] });
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: join(farmReal, "inside", "link2.txt") },
      ctx,
    );
    expect(result.behavior).toBe("allow");
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("escaping symlink is allowed when EVERY spelling is covered by allow rules", () => {
    const ctx = makeContext({
      allow: [
        `Edit(/${farmReal}/inside/**)`,
        `Edit(/${farmReal}/outside/**)`,
      ],
    });
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: join(farmReal, "inside", "link.txt") },
      ctx,
    );
    expect(result.behavior).toBe("allow");
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("without any allow rule the escaping symlink still asks (baseline)", () => {
    const ctx = makeContext();
    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: join(farmReal, "inside", "link.txt") },
      ctx,
    );
    expect(result.behavior).toBe("ask");
  });
});
