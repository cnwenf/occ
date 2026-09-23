/**
 * CC 2.1.280 (changelog #005, security 🔒) — resolveWritePathDescriptor
 * unit tests. Binary `da(inputPath)` @190660855 in the official v2.1.280
 * linux-x64 ELF. Real-tmpdir symlink farm (same conventions as
 * permissions/__tests__/symlinkTwins268.test.ts).
 *
 * Farm layout (all under the realpath'd tmpdir `farmReal`):
 *   realdir/file.txt                (physical dir + file)
 *   dirlink -> realdir              (directory symlink, relative)
 *   target.txt                      (physical file)
 *   leaf.txt -> target.txt          (leaf file symlink, relative)
 *   leafabs.txt -> <farmReal>/target.txt   (leaf file symlink, absolute)
 *   a.txt -> b.txt -> c.txt         (symlink chain; c.txt physical)
 *   dangling.txt -> nowhere.txt     (dangling leaf symlink)
 *   loop1.txt <-> loop2.txt         (circular symlinks)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join, normalize, sep } from "path";
import {
  NodeFsOperations,
  getPathsForPermissionCheck,
  identityWritePathDescriptor,
  resolveWritePathDescriptor,
  setFsImplementation,
  stripTrailingSlashesAndGit,
  type WritePathDescriptor,
} from "../fsOperations";

// getPathsForPermissionCheck can reach getBundledSkillsRoot (MACRO.VERSION);
// mirror the cli.tsx polyfill like the other symlink suites.
if (typeof globalThis.MACRO === "undefined") {
  (globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

let farm: string;
let farmReal: string;

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), "occ-desc280-"));
  farmReal = realpathSync(farm);
  mkdirSync(join(farmReal, "realdir"));
  writeFileSync(join(farmReal, "realdir", "file.txt"), "x");
  symlinkSync("realdir", join(farmReal, "dirlink"));
  writeFileSync(join(farmReal, "target.txt"), "t");
  symlinkSync("target.txt", join(farmReal, "leaf.txt"));
  symlinkSync(join(farmReal, "target.txt"), join(farmReal, "leafabs.txt"));
  symlinkSync("b.txt", join(farmReal, "a.txt"));
  symlinkSync("c.txt", join(farmReal, "b.txt"));
  writeFileSync(join(farmReal, "c.txt"), "c");
  symlinkSync("nowhere.txt", join(farmReal, "dangling.txt"));
  symlinkSync(join(farmReal, "loop2.txt"), join(farmReal, "loop1.txt"));
  symlinkSync(join(farmReal, "loop1.txt"), join(farmReal, "loop2.txt"));
});

afterAll(() => {
  rmSync(farm, { recursive: true, force: true });
  setFsImplementation(NodeFsOperations);
});

function resolvedAt(p: string): WritePathDescriptor {
  return resolveWritePathDescriptor(p);
}

describe("resolveWritePathDescriptor — plain paths (binary da @190660855)", () => {
  test("plain existing file: identity landing, not a leaf symlink", () => {
    const p = join(farmReal, "target.txt");
    const d = resolvedAt(p);
    expect(d.unresolved).toBe(false);
    expect(d.requested).toBe(p);
    if (d.unresolved) return;
    expect(d.landing).toBe(p);
    expect(d.leafIsSymlink).toBe(false);
    expect(d.spellings).toContain(p);
  });

  test("plain existing directory: identity landing", () => {
    const p = join(farmReal, "realdir");
    const d = resolvedAt(p);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.landing).toBe(p);
    expect(d.leafIsSymlink).toBe(false);
  });

  test("nonexistent plain path: ENOENT tail branch keeps the requested landing", () => {
    const p = join(farmReal, "realdir", "brand-new.txt");
    const d = resolvedAt(p);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    // binary: `E=Nn(b===""?k:join(k,b))` — deepest existing + remaining tail
    expect(d.landing).toBe(p);
    expect(d.leafIsSymlink).toBe(false);
    expect(d.spellings).toContain(p);
  });
});

describe("resolveWritePathDescriptor — directory-symlink pass-through", () => {
  test("nonexistent file under a symlinked dir lands at the physical tail (changelog #005 attack shape)", () => {
    const requested = join(farmReal, "dirlink", "new.txt");
    const landing = join(farmReal, "realdir", "new.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    // The link hop is NOT the leaf → leafIsSymlink stays false; the landing is
    // physical-dir + remaining tail.
    expect(d.leafIsSymlink).toBe(false);
    expect(d.landing).toBe(landing);
    expect(d.spellings).toContain(requested);
    expect(d.spellings).toContain(landing);
  });

  test("existing file under a symlinked dir resolves physically", () => {
    const requested = join(farmReal, "dirlink", "file.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.landing).toBe(join(farmReal, "realdir", "file.txt"));
    expect(d.leafIsSymlink).toBe(false);
  });

  test("leaf directory symlink itself: leafIsSymlink=true, landing is the dir target", () => {
    const requested = join(farmReal, "dirlink");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(d.landing).toBe(join(farmReal, "realdir"));
    // onHop leaf spelling: composed target of the leaf link joined the set
    expect(d.spellings).toContain(join(farmReal, "realdir"));
  });
});

describe("resolveWritePathDescriptor — leaf file symlinks", () => {
  test("relative leaf symlink: leafIsSymlink, landing = composed target", () => {
    const requested = join(farmReal, "leaf.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(d.landing).toBe(join(farmReal, "target.txt"));
    expect(d.spellings).toContain(requested);
    expect(d.spellings).toContain(join(farmReal, "target.txt"));
  });

  test("absolute leaf symlink: same semantics", () => {
    const requested = join(farmReal, "leafabs.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(d.landing).toBe(join(farmReal, "target.txt"));
  });

  test("chain a.txt -> b.txt -> c.txt: final physical landing, leaf flag set", () => {
    const requested = join(farmReal, "a.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(d.landing).toBe(join(farmReal, "c.txt"));
    // every leaf-hop composed target joined the spellings
    expect(d.spellings).toContain(join(farmReal, "b.txt"));
    expect(d.spellings).toContain(join(farmReal, "c.txt"));
  });

  test("dangling leaf symlink: resolved with landing = missing target, leaf flag set", () => {
    const requested = join(farmReal, "dangling.txt");
    const d = resolvedAt(requested);
    // binary: the leaf hop happens (u=true), then the reseeded target is
    // absent → ENOENT tail branch → RESOLVED at the target path.
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(d.landing).toBe(join(farmReal, "nowhere.txt"));
    expect(d.spellings).toContain(join(farmReal, "nowhere.txt"));
  });
});

describe("resolveWritePathDescriptor — unresolved cases (binary y() !g branch)", () => {
  test("circular symlinks exhaust the hop budget → unresolved with stoppedAt", () => {
    const requested = join(farmReal, "loop1.txt");
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(true);
    expect(d.requested).toBe(requested);
    if (!d.unresolved) return;
    expect(d.leafIsSymlink).toBe(true);
    expect(typeof d.stoppedAt).toBe("string");
    expect(d.stoppedAt.length).toBeGreaterThan(0);
    expect(d.spellings).toContain(requested);
  });

  test("dot segment in the absent tail after a link hop → unresolved (binary uN guard)", () => {
    // `a.kind==="absent"&&c&&a.remaining.some(uN)` → y(): after hopping
    // dirlink, `missing/../x.txt` is physically undecidable.
    // NOTE: built by concatenation — path.join would lexically collapse the
    // `missing/..` pair before the walker ever sees it.
    const requested = `${farmReal}/dirlink/missing/../x.txt`;
    const d = resolvedAt(requested);
    expect(d.unresolved).toBe(true);
    if (!d.unresolved) return;
    expect(d.stoppedAt).toBe(join(farmReal, "realdir", "missing"));
  });
});

describe("resolveWritePathDescriptor — degraded accept (binary g branch)", () => {
  test("EACCES without any readlink → resolved with the lexical landing", () => {
    const requested = join(farmReal, "realdir", "eacces-probe.txt");
    const realImpl = NodeFsOperations;
    setFsImplementation({
      ...realImpl,
      lstatSync(p: string) {
        if (p === requested) {
          const e = new Error(
            "EACCES: permission denied",
          ) as Error & { code?: string };
          e.code = "EACCES";
          throw e;
        }
        return realImpl.lstatSync(p);
      },
    });
    try {
      const d = resolvedAt(requested);
      // binary: `g=!c&&(p==="EACCES"||…)` → `i(Nn(n))` — resolved, lexical.
      expect(d.unresolved).toBe(false);
      if (d.unresolved) return;
      expect(d.landing).toBe(normalize(requested));
      expect(d.leafIsSymlink).toBe(false);
      expect(d.spellings).toContain(normalize(requested));
    } finally {
      setFsImplementation(realImpl);
    }
  });

  test("EACCES AFTER a readlink is NOT degraded-accepted → unresolved", () => {
    // binary `g=!c&&…` — sawReadlink (c=true) forces the unresolved branch.
    const blocked = join(farmReal, "realdir", "blocked.txt");
    const viaLink = join(farmReal, "dirlink", "blocked.txt");
    const realImpl = NodeFsOperations;
    setFsImplementation({
      ...realImpl,
      lstatSync(p: string) {
        if (p === blocked) {
          const e = new Error(
            "EACCES: permission denied",
          ) as Error & { code?: string };
          e.code = "EACCES";
          throw e;
        }
        return realImpl.lstatSync(p);
      },
    });
    try {
      const d = resolvedAt(viaLink);
      expect(d.unresolved).toBe(true);
      if (!d.unresolved) return;
      expect(d.stoppedAt).toBe(blocked);
    } finally {
      setFsImplementation(realImpl);
    }
  });
});

describe("resolveWritePathDescriptor — special inputs", () => {
  test("UNC path: identity descriptor early return (binary On&&!wl branch)", () => {
    const p = "//server/share/x.txt";
    const d = resolvedAt(p);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.landing).toBe(p);
    expect(d.leafIsSymlink).toBe(false);
    expect(d.spellings).toContain(p);
  });

  test("tilde input expands against homedir NFC (binary da() prologue)", () => {
    const d = resolvedAt("~/occ-descriptor-probe.txt");
    const expected = join(homedir().normalize("NFC"), "occ-descriptor-probe.txt");
    expect(d.requested).toBe(expected);
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.landing).toBe(expected);
  });

  test("relative input: requested keeps its form; absolute spelling joins the set", () => {
    const d = resolvedAt("occ-relative-descriptor-probe");
    expect(d.requested).toBe("occ-relative-descriptor-probe");
    expect(d.unresolved).toBe(false);
    if (d.unresolved) return;
    expect(d.spellings).toContain("occ-relative-descriptor-probe");
    expect(d.spellings).toContain(
      join(process.cwd(), "occ-relative-descriptor-probe"),
    );
    // the walk resolves cwd physically, so the landing is the realpath'd cwd
    expect(d.landing).toBe(
      join(
        realpathSync(process.cwd()),
        "occ-relative-descriptor-probe",
      ),
    );
  });

  test("spellings are a superset of getPathsForPermissionCheck (OCC union, fail-closed)", () => {
    const requested = join(farmReal, "dirlink", "new.txt");
    const d = resolvedAt(requested);
    for (const p of getPathsForPermissionCheck(requested)) {
      expect(d.spellings).toContain(p);
    }
    // requested is always the first spelling
    expect(d.spellings[0]).toBe(requested);
  });
});

describe("identityWritePathDescriptor (binary wqe)", () => {
  test("exact official shape", () => {
    const d = identityWritePathDescriptor("/a/b");
    expect(d).toEqual({
      unresolved: false,
      requested: "/a/b",
      spellings: ["/a/b"],
      landing: "/a/b",
      leafIsSymlink: false,
    });
  });
});

describe("stripTrailingSlashesAndGit (binary yr @191121789)", () => {
  test("strips trailing slashes and a trailing .git component, looping", () => {
    expect(stripTrailingSlashesAndGit("a/b/.git")).toBe("a/b");
    expect(stripTrailingSlashesAndGit("a/b/.git/")).toBe("a/b");
    expect(stripTrailingSlashesAndGit("a/b//")).toBe("a/b");
    expect(stripTrailingSlashesAndGit("a/.git/.git")).toBe("a");
    expect(stripTrailingSlashesAndGit("/x")).toBe("/x");
    expect(stripTrailingSlashesAndGit("plain")).toBe("plain");
    expect(stripTrailingSlashesAndGit(".git")).toBe("");
    // interior .git is untouched
    expect(stripTrailingSlashesAndGit("/repo/.git/config")).toBe(
      `/repo/.git/config`,
    );
  });

  test("landing comparison identity: sep-joined tails are unaffected", () => {
    expect(stripTrailingSlashesAndGit(join("a", "b") + sep)).toBe("a/b");
  });
});
