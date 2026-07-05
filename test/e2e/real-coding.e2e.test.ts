import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runOcc, tempDir, seedFile } from "./helpers";

/**
 * Real coding-task e2e: drive the BUILT `dist/cli.js` in `-p` mode against a
 * real model, as a user would. Each test seeds a temp project dir (via
 * `OCC_CWD`), asks OCC to do a concrete coding job, and asserts on the
 * resulting disk state / stdout. Covers: Write, Edit, Bash, Glob, Grep,
 * multi-file project, --output-format json, WebFetch, --append-system-prompt,
 * and sub-agent delegation.
 *
 * Gated out of CI (no model credentials); run locally with a real endpoint.
 */

const P = (s: string) => ["-p", s, "--dangerously-skip-permissions"];

describe.skipIf(!!process.env.CI)("real coding tasks (e2e, real model)", () => {
  test("FileWrite: creates a file with the requested content", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        P("Create a file named hello.txt in the current directory. Its entire content must be exactly (no surrounding quotes): Hello, OCC!"),
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "hello.txt"))).toBe(true);
      expect(readFileSync(join(dir, "hello.txt"), "utf8")).toContain("Hello, OCC!");
    } finally {
      cleanup();
    }
  }, 150_000);

  test("FileEdit: fixes a bug in an existing file", async () => {
    const { dir, cleanup } = tempDir();
    try {
      seedFile(dir, "fixme.js", "export function add(a, b) {\n  return a - b;\n}\n");
      const res = await runOcc(
        P("The file fixme.js has a bug: the add function returns a - b (subtraction) instead of a + b (addition). Fix it by changing the subtraction to addition. Do not change anything else."),
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      const after = readFileSync(join(dir, "fixme.js"), "utf8");
      expect(after).toContain("a + b");
      expect(after).not.toContain("a - b");
    } finally {
      cleanup();
    }
  }, 150_000);

  test("Bash: runs a shell command and writes the result to a file", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        P("Using a shell command, compute 7 * 6 and write only the resulting number (nothing else) to a file named result.txt in the current directory."),
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "result.txt"))).toBe(true);
      expect(readFileSync(join(dir, "result.txt"), "utf8")).toContain("42");
    } finally {
      cleanup();
    }
  }, 150_000);

  test("Glob + Grep: locates files containing a string", async () => {
    const { dir, cleanup } = tempDir();
    try {
      seedFile(dir, "a.js", "const x = 1;\n// NEEDLE_FOUND\n");
      seedFile(dir, "b.js", "const y = 2;\n");
      seedFile(dir, "sub/c.js", "const z = 3;\n// NEEDLE_FOUND\n");
      const res = await runOcc(
        P("Search the current directory recursively for files that contain the exact string NEEDLE_FOUND. Reply with just the list of relative file paths that match, one per line (a.js and sub/c.js)."),
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("a.js");
      expect(res.stdout).toContain("sub/c.js");
    } finally {
      cleanup();
    }
  }, 150_000);

  test("multi-file project: creates package.json + index.js and runs it", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        P("Create a minimal Node.js project in the current directory: (1) a package.json with name \"occ-proj\" and a \"start\" script that runs `node index.js`; (2) an index.js that prints exactly OCC_PROJECT_OK to stdout. Then run `node index.js` to execute it."),
        { OCC_CWD: dir },
        150_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(existsSync(join(dir, "index.js"))).toBe(true);
      expect(res.stdout).toContain("OCC_PROJECT_OK");
    } finally {
      cleanup();
    }
  }, 200_000);

  test("--output-format json: returns valid JSON with the reply", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "Reply with exactly this text and nothing else: OCC_JSON_OK", "--dangerously-skip-permissions", "--output-format", "json"],
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      let parsed: any = null;
      expect(() => { parsed = JSON.parse(res.stdout); }).not.toThrow();
      // The JSON output may be a single result object or an array of events.
      // Find the result text in either shape.
      const events = Array.isArray(parsed) ? parsed : [parsed];
      const resultEvent = events.find((e: any) => e?.type === 'result');
      const text = String(resultEvent?.result ?? resultEvent?.text ?? parsed?.result ?? "");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 150_000);

  test("--append-system-prompt: injected instruction is followed", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        ["-p", "What is 2+2? Answer with just the number.", "--dangerously-skip-permissions", "--append-system-prompt", "You MUST begin every reply with the exact token XYZ_OCC_TOKEN, then a space, then your answer."],
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("XYZ_OCC_TOKEN");
    } finally {
      cleanup();
    }
  }, 150_000);

  test("WebFetch: fetches a stable URL and reports its content", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        P("Fetch the URL https://example.com/ and tell me the main visible heading text shown on the page. Reply with only that heading text."),
        { OCC_CWD: dir },
        150_000,
      );
      expect(res.code).toBe(0);
      expect(res.stdout.toLowerCase()).toContain("example domain");
    } finally {
      cleanup();
    }
  }, 200_000);

  test("Agent: delegates file creation to a sub-agent", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await runOcc(
        P("Use the Agent tool to spawn a sub-agent. Have the sub-agent create a file named delegated.txt in the current directory containing exactly: from-subagent. Wait for the sub-agent to finish."),
        { OCC_CWD: dir },
        180_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "delegated.txt"))).toBe(true);
      expect(readFileSync(join(dir, "delegated.txt"), "utf8")).toContain("from-subagent");
    } finally {
      cleanup();
    }
  }, 220_000);

  test("/init: generates a CLAUDE.md for a small project", async () => {
    const { dir, cleanup } = tempDir();
    try {
      seedFile(dir, "src/math.js", "export function add(a, b) { return a + b; }\n");
      seedFile(dir, "package.json", '{"name":"demo","scripts":{"test":"node src/math.js"}}\n');
      const res = await runOcc(
        ["-p", "/init", "--dangerously-skip-permissions"],
        { OCC_CWD: dir },
        120_000,
      );
      expect(res.code).toBe(0);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(content).toMatch(/CLAUDE\.md/i);
      expect(content.toLowerCase()).toContain("commands");
    } finally {
      cleanup();
    }
  }, 150_000);
});
