import { rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import type { Dirent } from "fs";
import { walkTeamMemoryTree } from "../index.js";

/**
 * Claude Code 2.1.218 #16 (directory-tree half): "Fixed crashes (maximum call
 * stack exceeded) when a deeply nested watched directory tree was deleted or
 * moved". The team-memory sync watcher (`watcher.ts`) fires on a watched
 * directory tree and `readLocalTeamMemory` walks that tree via `walkDir`.
 *
 * The pre-fix `walkDir` recursed into subdirectories (`await walkDir(fullPath)`).
 * On a deeply-nested tree this blows the JS call stack. This test ports the
 * walk to an explicit-queue iterative form (`walkTeamMemoryTree`) and proves it
 * traverses a deeply-nested tree without overflowing.
 *
 * Runtime note: Bun relieves the native stack across `await` boundaries, so a
 * pure-async recursion does not reproduce the "Maximum call stack size exceeded"
 * crash on Bun at the depths a real filesystem allows (PATH_MAX ≈ 4096 →
 * ~1500 levels). The crash the changelog names is the synchronous-recursion
 * class. To make RED→GREEN real and host-PATH_MAX-independent, the
 * stack-guard subtests feed BOTH a synchronous recursive walker (the crash
 * class — throws RangeError) and the production iterative walker (GREEN) the
 * SAME synthetic 50 000-level tree via an injectable readdir. 50 000 reliably
 * overflows sync recursion on Bun (5/5) while staying under the test budget
 * for the iterative walk.
 *
 * RED against the old code: the old `readLocalTeamMemory` had no exported
 * `walkTeamMemoryTree` — the test fails to import (SyntaxError: Export named
 * 'walkTeamMemoryTree' not found). GREEN after the iterative implementation.
 */

const TEST_ROOT = "/tmp/occ-16/.test-deep";
const SYNTHETIC_DEPTH = 50_000;

function cleanupTree() {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

interface FakeDirent extends Dirent {
  name: string;
}

/**
 * Fake readdir simulating a single chain of `depth` nested directories: each
 * call returns one subdir "d" until the chain reaches `depth`, then one file
 * "leaf.txt". Depth is encoded in the trailing "/d" segment count so it is
 * unlimited regardless of host PATH_MAX.
 */
function makeFakeReaddir(depth: number): (dir: string) => Promise<FakeDirent[]> {
  return (dir: string) => {
    const consumed = (dir.match(/\/d/g) ?? []).length;
    if (consumed >= depth) {
      return Promise.resolve([
        {
          name: "leaf.txt",
          isDirectory: () => false,
          isFile: () => true,
        } as FakeDirent,
      ]);
    }
    return Promise.resolve([
      {
        name: "d",
        isDirectory: () => true,
        isFile: () => false,
      } as FakeDirent,
    ]);
  };
}

/** Synchronous feed mirroring `makeFakeReaddir` but returning Dirents directly. */
function syncFeed(dir: string, depth: number): FakeDirent[] {
  const consumed = (dir.match(/\/d/g) ?? []).length;
  if (consumed >= depth) {
    return [
      { name: "leaf.txt", isDirectory: () => false, isFile: () => true } as FakeDirent,
    ];
  }
  return [
    { name: "d", isDirectory: () => true, isFile: () => false } as FakeDirent,
  ];
}

describe("2.1.218 #16 — iterative guard for deeply-nested watched-directory tree", () => {
  test("iterative walker traverses a real deeply-nested tree without throwing", async () => {
    // Build a real tree at the max depth the host filesystem can represent
    // (Linux PATH_MAX ≈ 4096 → ~1500 single-char-segment levels).
    cleanupTree();
    mkdirSync(TEST_ROOT, { recursive: true });
    let p = TEST_ROOT;
    let depth = 0;
    for (let i = 0; i < 1500; i++) {
      const next = join(p, "d");
      if (next.length > 4080) break;
      try {
        mkdirSync(next);
      } catch {
        break;
      }
      p = next;
      depth = i + 1;
    }
    const leafPath = join(p, "leaf.txt");
    writeFileSync(leafPath, "leaf-content");
    expect(depth).toBeGreaterThan(500); // sanity: built a genuinely deep tree

    const visited: string[] = [];
    await walkTeamMemoryTree(TEST_ROOT, async fullPath => {
      visited.push(fullPath);
    });

    expect(visited).toContain(leafPath);
    expect(visited.length).toBe(1); // exactly one file in the chain
    cleanupTree();
  });

  test(
    "iterative walker completes a 50 000-level synthetic tree (no stack overflow)",
    async () => {
      let leafDepth = 0;
      const fakeReaddir = makeFakeReaddir(SYNTHETIC_DEPTH);
      await walkTeamMemoryTree(
        "",
        async fullPath => {
          leafDepth = (fullPath.match(/\/d/g) ?? []).length;
        },
        fakeReaddir as unknown as typeof import("fs/promises").readdir,
      );
      expect(leafDepth).toBe(SYNTHETIC_DEPTH);
    },
    30_000, // 50k awaits need headroom over the default 5s budget
  );

  test("RED reference: a synchronous recursive walker overflows on the same 50 000-level tree", () => {
    let leafDepth = 0;
    // Sync recursive walker — the crash class the changelog names ("maximum
    // call stack exceeded"). Driven by the same synthetic feed so depth is
    // host-PATH_MAX-independent. 50 000 reliably overflows sync recursion on
    // Bun (the iterative walker above completes the same tree).
    function syncWalk(dir: string): void {
      for (const entry of syncFeed(dir, SYNTHETIC_DEPTH)) {
        if (entry.isDirectory()) {
          syncWalk(`${dir}/d`);
        } else if (entry.isFile()) {
          leafDepth = (dir.match(/\/d/g) ?? []).length;
        }
      }
    }
    expect(() => syncWalk("")).toThrow(/Maximum call stack/i);
    expect(leafDepth).toBe(0); // never reached the leaf — overflowed first
  });
});
