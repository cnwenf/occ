import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { cacheMarketplaceFromGit } from "../marketplaceManager";

/**
 * claude-code 2.1.90: `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` keeps the
 * existing marketplace clone when `git pull` fails (useful offline). Without it,
 * a failed pull triggers rm + re-clone.
 */

function git(cwd: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).toString();
}

function makeBareRemote(repoDir: string): string {
  // A normal repo we commit into, then a bare clone acts as the "remote".
  git(repoDir, "init", "--initial-branch=main");
  writeFileSync(join(repoDir, "README.md"), "v1\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "v1");
  const barePath = `${repoDir}.git`;
  execSync(`git clone --bare "${repoDir}" "${barePath}"`, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return barePath;
}

function corruptOriginUrl(cachePath: string, badUrl: string): void {
  // Force `git pull` to fail by pointing origin at a non-existent remote.
  execSync(`git remote set-url origin "${badUrl}"`, { cwd: cachePath });
}

describe("cacheMarketplaceFromGit: CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE", () => {
  let workdir: string;
  let remote: string;
  let cachePath: string;
  const savedEnv = process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "mm-"));
    const srcRepo = join(workdir, "src");
    mkdirSync(srcRepo, { recursive: true });
    remote = makeBareRemote(srcRepo);
    cachePath = join(workdir, "cache");
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(`${workdir}.git`, { recursive: true, force: true });
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE;
    } else {
      process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = savedEnv;
    }
  });

  test("initial clone succeeds and populates the cache", async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath);
    expect(existsSync(join(cachePath, "README.md"))).toBe(true);
  });

  test("with env set: failed pull keeps the existing clone (no rm)", async () => {
    // First clone — populates the cache.
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath);
    // Drop a sentinel file to prove the dir is NOT removed on pull failure.
    const sentinel = join(cachePath, "SENTINEL_KEEP");
    writeFileSync(sentinel, "kept");
    // Make pull fail.
    corruptOriginUrl(cachePath, "file:///nonexistent/remote-xyz");

    process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = "1";
    // Second call: pull fails, env set → keep existing clone, return early.
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath);

    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(cachePath, "README.md"))).toBe(true);
  });

  test("without env: failed pull triggers rm + re-clone from the (valid) gitUrl", async () => {
    // First clone.
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath);
    const sentinel = join(cachePath, "SENTINEL_RECLONE");
    writeFileSync(sentinel, "temp");
    // Make pull fail (corrupt origin), but the *gitUrl* arg stays valid.
    corruptOriginUrl(cachePath, "file:///nonexistent/remote-xyz");

    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE;
    // Second call: pull fails, no env → rm + re-clone from valid file:// remote.
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath);

    // Sentinel must be gone — the dir was removed and re-cloned fresh.
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(cachePath, "README.md"))).toBe(true);
  });
});
