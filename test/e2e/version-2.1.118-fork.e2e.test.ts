import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.118 e2e: /fork writes a POINTER + hydrates on demand.
 *
 * Instead of copying the full parent conversation into the fork's session file,
 * /fork writes a small `fork-context-ref` pointer entry referencing the parent
 * session + last parent message UUID. The fork's conversation prefix is
 * hydrated on demand from the parent session file when the fork is loaded.
 *
 * Metadata + pointer shape grep-verified against the 2.1.200 binary.
 */

const PARENT = "aaaaaaaa-1111-1111-1111-111111111111";
const FORK = "bbbbbbbb-2222-2222-2222-222222222222";
const LEAF = "cccccccc-3333-3333-3333-333333333333";
const ROOT = "dddddddd-4444-4444-4444-444444444444";

describe("2.1.118 /fork pointer + hydrate (e2e)", () => {
  test("fork command metadata matches official binary", async () => {
    const script = `
import fork from "${REPO_ROOT}/src/commands/fork/index.ts";
console.log(JSON.stringify({
  type: fork.type,
  name: fork.name,
  description: fork.description,
  argumentHint: fork.argumentHint,
  enabled: fork.isEnabled?.(),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.type).toBe("local-jsx");
    expect(out.name).toBe("fork");
    expect(out.description).toBe("Spawn a background agent that inherits the full conversation");
    expect(out.argumentHint).toBe("<directive>");
    expect(out.enabled).toBe(true);
  });

  test("writeForkPointer writes ONLY a fork-context-ref pointer (not the full parent conversation)", async () => {
    // Compute the parent session file path the same way pointer.ts does.
    const setup = `
import { getTranscriptPathForSession } from "${REPO_ROOT}/src/utils/sessionStorage.ts";
console.log(JSON.stringify({
  parentPath: getTranscriptPathForSession("${PARENT}"),
  forkPath: getTranscriptPathForSession("${FORK}"),
}));
`;
    const paths = JSON.parse((await $`bun -e ${setup}`.quiet()).stdout.toString().trim());
    const parentPath: string = paths.parentPath;
    const forkPath: string = paths.forkPath;

    // Seed a parent session file with a 2-message chain (root -> leaf).
    mkdirSync(dirname(parentPath), { recursive: true });
    const root = JSON.stringify({ type: "user", uuid: ROOT, parentUuid: null, isSidechain: false, message: { role: "user", content: "first turn" } });
    const leaf = JSON.stringify({ type: "assistant", uuid: LEAF, parentUuid: ROOT, isSidechain: false, message: { role: "assistant", content: "reply" } });
    writeFileSync(parentPath, `${root}\n${leaf}\n`);

    // Write the fork pointer.
    const write = `
import { writeForkPointer } from "${REPO_ROOT}/src/commands/fork/index.ts";
await writeForkPointer({ forkedSessionId: "${FORK}", parentSessionId: "${PARENT}", parentLastUuid: "${LEAF}" });
console.log("done");
`;
    await $`bun -e ${write}`.quiet();

    // The fork file must contain ONLY the pointer line — NOT the parent's
    // messages (that's the pre-2.1.118 full-copy behavior we replaced).
    expect(existsSync(forkPath)).toBe(true);
    const forkContent = readFileSync(forkPath, "utf8").trim();
    const lines = forkContent.split("\n");
    expect(lines.length).toBe(1);
    const pointer = JSON.parse(lines[0]);
    expect(pointer.type).toBe("fork-context-ref");
    expect(pointer.parentSessionId).toBe(PARENT);
    expect(pointer.parentLastUuid).toBe(LEAF);
    // Pointer must NOT carry the parent's conversation content.
    expect(pointer.message).toBeUndefined();

    // Cleanup parent + fork files.
    try { rmSync(parentPath, { force: true }); } catch {}
    try { rmSync(forkPath, { force: true }); } catch {}
  }, 30_000);

  test("hydrateForkPrefix hydrates the prefix on demand from the parent session", async () => {
    const setup = `
import { getTranscriptPathForSession } from "${REPO_ROOT}/src/utils/sessionStorage.ts";
console.log(JSON.stringify({ parentPath: getTranscriptPathForSession("${PARENT}") }));
`;
    const paths = JSON.parse((await $`bun -e ${setup}`.quiet()).stdout.toString().trim());
    const parentPath: string = paths.parentPath;

    // Seed parent: root -> mid -> leaf (3-message chain). Leaf is the branch point.
    const MID = "eeeeeeee-5555-5555-5555-555555555555";
    mkdirSync(dirname(parentPath), { recursive: true });
    const root = JSON.stringify({ type: "user", uuid: ROOT, parentUuid: null, isSidechain: false, message: { role: "user", content: "root turn" } });
    const mid = JSON.stringify({ type: "assistant", uuid: MID, parentUuid: ROOT, isSidechain: false, message: { role: "assistant", content: "mid reply" } });
    const leaf = JSON.stringify({ type: "user", uuid: LEAF, parentUuid: MID, isSidechain: false, message: { role: "user", content: "leaf turn" } });
    writeFileSync(parentPath, `${root}\n${mid}\n${leaf}\n`);

    // Hydrate the prefix ending at LEAF — should walk root -> mid -> leaf.
    const hydrate = `
import { hydrateForkPrefix, _clearHydrateCache } from "${REPO_ROOT}/src/commands/fork/index.ts";
_clearHydrateCache();
const prefix = await hydrateForkPrefix({ parentSessionId: "${PARENT}", parentLastUuid: "${LEAF}" });
console.log(JSON.stringify(prefix.map(m => ({ type: m.type, uuid: m.uuid }))));
`;
    const out = (await $`bun -e ${hydrate}`.quiet()).stdout.toString().trim();
    const prefix = JSON.parse(out);
    expect(prefix.length).toBe(3);
    expect(prefix[0].uuid).toBe(ROOT);
    expect(prefix[1].uuid).toBe(MID);
    expect(prefix[2].uuid).toBe(LEAF);
    // Hydrated prefix must strip isSidechain (fork owns its own chain).
    expect(prefix[0].isSidechain).toBeUndefined();
    expect(prefix[0].parentUuid).toBeUndefined();

    try { rmSync(parentPath, { force: true }); } catch {}
  });

  test("hydrateForkPrefix returns empty prefix when parent message is missing", async () => {
    const hydrate = `
import { hydrateForkPrefix, _clearHydrateCache } from "${REPO_ROOT}/src/commands/fork/index.ts";
_clearHydrateCache();
const prefix = await hydrateForkPrefix({ parentSessionId: "${PARENT}", parentLastUuid: "missing-uuid-0000" });
console.log(JSON.stringify(prefix));
`;
    const out = (await $`bun -e ${hydrate}`.quiet()).stdout.toString().trim();
    expect(JSON.parse(out)).toEqual([]);
  });
});
