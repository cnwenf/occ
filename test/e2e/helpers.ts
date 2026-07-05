import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inside the Docker e2e image the repo lives at /occ; on the host it's the
// repo root. Auto-detect so the same tests run in both.
export const REPO_ROOT = existsSync("/occ/src/entrypoints/cli.tsx")
  ? "/occ"
  : process.cwd();

/**
 * Run the BUILT artifact (dist/cli.js) — no transpilation at run time, which
 * avoids a bun transpiler-cache lock deadlock when `bun test` spawns a child
 * `bun run <source>` process. The Docker image builds dist/cli.js; on the host
 * we build it once before running e2e.
 *
 * Set OCC_ENTRYPOINT to override the script path (e.g. for a custom install).
 */
export const OCC_BIN = "bun";
export const OCC_ARGS = [process.env.OCC_ENTRYPOINT ?? join(REPO_ROOT, "dist/cli.js")];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Run the OCC CLI with the given args + env, capturing stdout/stderr + timing. */
export function runOcc(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    // detached: true makes the child its own process-group leader so we can
    // kill the WHOLE group (OCC + any MCP stdio grandchildren like `sleep`)
    // on timeout — prevents orphaned subprocesses leaking across the test
    // suite (which crashed the host on a prior run).
    const child = spawn(OCC_BIN, [...OCC_ARGS, ...args], {
      env: { ...process.env, ...env },
      cwd: process.env.OCC_CWD ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let done = false;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const killGroup = (signal: NodeJS.Signals = "SIGKILL") => {
      try {
        // -pid targets the process group leader (the child).
        process.kill(-child.pid!, signal);
      } catch {
        // Group already gone; fall back to direct kill.
        try { child.kill(signal); } catch {}
      }
    };
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - start });
    };
    const timer = setTimeout(() => {
      killGroup("SIGKILL");
      finish(-1);
    }, timeoutMs);
    child.on("close", (code) => finish(code ?? -1));
    // Best-effort cleanup if the test process itself exits mid-run: the group
    // would otherwise orphan. Registered late so it doesn't mask normal exit.
    const onExit = () => killGroup("SIGKILL");
    process.once("exit", onExit);
    child.on("close", () => process.removeListener("exit", onExit));
  });
}

/** Write a temp file and return its path + a cleanup handle. */
export function tempFile(name: string, content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "occ-e2e-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Create a fresh empty temp directory for a "real coding task" e2e: point OCC
 * at it via `OCC_CWD`, seed files, run, then assert on disk state. Returns the
 * dir path + a cleanup handle.
 */
export function tempDir(prefix = "occ-e2e-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Write a seeded file into a temp project dir (creating parent dirs as needed).
 */
export function seedFile(dir: string, relPath: string, content: string): string {
  const abs = join(dir, relPath);
  const parent = abs.slice(0, Math.max(0, abs.lastIndexOf("/")));
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
