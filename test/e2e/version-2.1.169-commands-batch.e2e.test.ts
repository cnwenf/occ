import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * Batch registration test for 5 slash commands added to match the official
 * claude-code 2.1.200 binary. These commands span several upstream versions:
 *   - /reload-skills  (2.1.105)
 *   - /scroll-speed   (2.1.139)
 *   - /cd             (2.1.169)
 *   - /recap          (away-summary feature)
 *   - /autocompact    (config-panel command)
 *
 * For each command we assert (source-grep):
 *   (a) it is registered in src/commands.ts (import + COMMANDS() array entry),
 *   (b) its name + description (+ type + argumentHint) match the official
 *       binary strings EXACTLY (verified via /tmp/occ-audit/claude.strings),
 *   (c) isEnabled is not hardcoded to `() => false`.
 *
 * A runtime check additionally imports commands.ts and confirms each command
 * is discoverable via getBuiltInCommandByName (catches load/syntax errors that
 * source-grep misses).
 */

const COMMANDS_DIR = join(REPO_ROOT, "src/commands");
const COMMANDS_TS = join(REPO_ROOT, "src/commands.ts");

interface Expected {
  /** Slash command name (also the directory name). */
  name: string;
  /** Variable name used in commands.ts (camelCase). */
  varName: string;
  /** Official `type` field. */
  type: "local-jsx" | "local" | "prompt";
  /** Official description (exact binary string). */
  description: string;
  /** Official argumentHint, if present. */
  argumentHint?: string;
}

// Exact shapes verified from the 2.1.200 binary strings dump:
//   grep -aoE 'type:"[^"]*",name:"(cd|recap|scroll-speed|autocompact|reload-skills)"[^}]*'
const EXPECTED: Expected[] = [
  {
    name: "cd",
    varName: "cd",
    type: "local-jsx",
    description: "Move this session to a new working directory",
    argumentHint: "<path>",
  },
  {
    name: "recap",
    varName: "recap",
    type: "local",
    description: "Generate a one-line session recap now",
  },
  {
    name: "scroll-speed",
    varName: "scrollSpeed",
    type: "local-jsx",
    description: "Adjust mouse wheel scroll speed",
  },
  {
    name: "autocompact",
    varName: "autocompact",
    type: "local-jsx",
    description: "Set how full the context gets before auto-summarizing",
    argumentHint: "[auto|<tokens>]",
  },
  {
    name: "reload-skills",
    varName: "reloadSkills",
    type: "local",
    description: "Pick up skills added or changed on disk during this session",
  },
];

// Matches `isEnabled: () => false` with any spacing (the only forbidden shape).
const HARDCODED_FALSE = /isEnabled:\s*\(\s*\)\s*=>\s*false\b/;

describe("2.1.169 commands batch — registration vs official 2.1.200", () => {
  const commandsSrc = readFileSync(COMMANDS_TS, "utf8");

  for (const cmd of EXPECTED) {
    describe(`/${cmd.name}`, () => {
      const indexSrc = readFileSync(
        join(COMMANDS_DIR, cmd.name, "index.ts"),
        "utf8",
      );

      test("(a) registered in src/commands.ts", () => {
        // Import line present.
        const importPresent = commandsSrc.includes(
          `./commands/${cmd.name}/index.js`,
        );
        // Array entry present (varName, on its own line).
        const arrayPresent = new RegExp(`^\\s*${cmd.varName},\\s*$`, "m").test(
          commandsSrc,
        );
        expect(importPresent).toBe(true);
        expect(arrayPresent).toBe(true);
      });

      test("(b) name + description + type match official binary exactly", () => {
        expect(indexSrc).toContain(`name: '${cmd.name}'`);
        expect(indexSrc).toContain(`description: '${cmd.description}'`);
        expect(indexSrc).toContain(`type: '${cmd.type}'`);
        if (cmd.argumentHint) {
          expect(indexSrc).toContain(`argumentHint: '${cmd.argumentHint}'`);
        }
      });

      test("(c) isEnabled is not hardcoded false", () => {
        expect(HARDCODED_FALSE.test(indexSrc)).toBe(false);
      });
    });
  }

  test("runtime: all 5 load and are discoverable via getBuiltInCommandByName", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const names = ${JSON.stringify(EXPECTED.map((c) => c.name))};
const out = {};
for (const n of names) {
  const c = getBuiltInCommandByName(n);
  out[n] = c ? { name: c.name, type: c.type, description: c.description } : null;
}
console.log(JSON.stringify(out));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );

    for (const cmd of EXPECTED) {
      const found = out[cmd.name];
      expect(found, `/${cmd.name} not registered (getBuiltInCommandByName)`).not.toBe(
        null,
      );
      expect(found.name).toBe(cmd.name);
      expect(found.type).toBe(cmd.type);
      expect(found.description).toBe(cmd.description);
    }
  });
});
