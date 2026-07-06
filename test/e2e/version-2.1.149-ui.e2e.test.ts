import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const readSrc = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");

/**
 * I1 (2.1.149): GFM task-list checkboxes. markdown output must render
 * `- [ ]` / `- [x]` task-list checkboxes instead of dropping them.
 */
describe("I1 (2.1.149): GFM task-list checkboxes", () => {
  test("Markdown.tsx renders [ ]/[x] task-list markers", () => {
    const src = readSrc("src/components/Markdown.tsx");
    expect(src).toContain("formatTaskList");
    expect(src).toContain("listHasTaskItems");
    // The checkbox marker: `[${checked ? 'x' : ' '}]`
    expect(src).toMatch(/checked\s*\?\s*['"]x['"]\s*:\s*['"]\s['"]/);
    // Dispatches on the marked task-list token (task/checkbox)
    expect(src).toMatch(/\.task\b/);
    expect(src).toMatch(/'checkbox'/);
  });

  test("formatTaskList produces [ ] / [x] checkboxes", async () => {
    const script = `
import { marked, type Tokens } from 'marked';
import { formatTaskList } from "${REPO_ROOT}/src/components/Markdown.tsx";
marked.use({ gfm: true });
const tokens = marked.lexer('- [ ] unchecked task\\n- [x] **bold** task\\n- normal item\\n');
const list = tokens.find(t => t.type === 'list');
const out = formatTaskList(list, 'dark', null);
console.log(JSON.stringify({
  hasUnchecked: out.includes('[ ]'),
  hasChecked: out.includes('[x]'),
  uncheckedText: out.includes('unchecked task'),
  checkedText: out.includes('bold'),
  boldRendered: !out.includes('**'),
  normalBullet: out.includes('- normal item'),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasUnchecked).toBe(true);
    expect(out.hasChecked).toBe(true);
    expect(out.uncheckedText).toBe(true);
    expect(out.checkedText).toBe(true);
    expect(out.boldRendered).toBe(true);
    expect(out.normalBullet).toBe(true);
  });
});

/**
 * I3 (2.1.141): spinner warms to amber after 10s of thinking. The thinking-
 * text color interpolates toward the theme `warning` (amber) color; intensity
 * is 0 until 10s, ramps to 1 over the next 10s.
 */
describe("I3 (2.1.141): spinner amber warm-up after 10s", () => {
  test("SpinnerAnimationRow wires the amber warm-up + warning color", () => {
    const src = readSrc("src/components/Spinner/SpinnerAnimationRow.tsx");
    expect(src).toContain("computeThinkingAmberIntensity");
    expect(src).toContain("amberIntensity");
    // Interpolates the thinking shimmer color toward the warning (amber) color
    expect(src).toContain("warningRGB");
    expect(src).toMatch(/getTheme\(themeName\)\.warning/);
    // Tracks thinking-burst start so the ramp begins at 10s of thinking
    expect(src).toContain("thinkingBurstStartRef");
  });

  test("amber intensity: 0 at <=10s, 0.5 at 15s, 1 at 20s, 0 with tools", async () => {
    const script = `
import { computeThinkingAmberIntensity } from "${REPO_ROOT}/src/components/Spinner/utils.ts";
const i = (ms, tools) => computeThinkingAmberIntensity(ms, tools, true, true);
console.log(JSON.stringify({
  at0: i(0, false),
  at5s: i(5000, false),
  at10s: i(10000, false),
  at15s: i(15000, false),
  at20s: i(20000, false),
  at25s: i(25000, false),
  withTools: i(15000, true),
  notThinking: computeThinkingAmberIntensity(15000, false, false, true),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.at0).toBe(0);
    expect(out.at5s).toBe(0);
    expect(out.at10s).toBe(0);
    expect(out.at15s).toBe(0.5);
    expect(out.at20s).toBe(1);
    expect(out.at25s).toBe(1);
    expect(out.withTools).toBe(0);
    expect(out.notThinking).toBe(0);
  });
});

/**
 * I10 (2.1.118): custom named themes from ~/.claude/themes/*.json.
 * Files: { "name", "base", "overrides": { "<colorKey>": "rgb(...)" } }.
 * Referenced in config as "custom:<name>".
 */
describe("I10 (2.1.118): custom themes from ~/.claude/themes", () => {
  test("customThemes.ts has the loader, custom: prefix, and JSON shape", () => {
    const src = readSrc("src/commands/theme/customThemes.ts");
    expect(src).toContain("CUSTOM_THEME_PREFIX");
    expect(src).toContain("'custom:'");
    expect(src).toContain("loadCustomThemes");
    expect(src).toContain("getCustomThemesDir");
    expect(src).toContain("parseCustomThemeFile");
    expect(src).toContain("resolveCustomTheme");
    expect(src).toContain("overrides");
    // "New custom theme…" picker entry + sentinel value
    expect(src).toContain("'__new_custom_theme__'");
    expect(src).toContain("New custom theme");
    // Loads from <configDir>/themes (~/.claude/themes)
    expect(src).toMatch(/getClaudeConfigHomeDir\(\),\s*['"]themes['"]/);
  });

  test("ThemePicker shows custom options + the 'is a custom theme' warning", () => {
    const src = readSrc("src/components/ThemePicker.tsx");
    expect(src).toContain("loadCustomThemes");
    expect(src).toContain("NEW_CUSTOM_THEME_LABEL");
    expect(src).toContain("NEW_CUSTOM_THEME_VALUE");
    expect(src).toContain("buildCustomThemeSlug");
    expect(src).toContain("is a custom theme; selecting a preset here replaces it");
  });

  test("theme.tsx shows 'Using custom theme' on select", () => {
    const src = readSrc("src/commands/theme/theme.tsx");
    expect(src).toContain("parseCustomThemeSlug");
    expect(src).toContain("Using custom theme");
  });

  test("ThemeProvider resolves custom slugs to their base palette", () => {
    const src = readSrc("src/components/design-system/ThemeProvider.tsx");
    expect(src).toContain("isCustomThemeSetting");
    expect(src).toContain("findCustomTheme");
    expect(src).toContain("loadCustomThemes");
  });

  test("loadCustomThemes reads ~/.claude/themes/*.json and resolves overrides", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "occ-theme-"));
    const themesDir = join(tmp, ".claude", "themes");
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(
      join(themesDir, "solarized.json"),
      JSON.stringify({ name: "Solarized", base: "dark", overrides: { claude: "rgb(38,139,210)", warning: "rgb(203,75,22)" } }),
    );
    writeFileSync(join(themesDir, "bad.json"), "{not valid json");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(tmp, ".claude") };
    const script = `
import { loadCustomThemes, resolveCustomTheme, buildCustomThemeSlug, parseCustomThemeSlug, isCustomThemeSetting } from "${REPO_ROOT}/src/commands/theme/customThemes.ts";
const themes = await loadCustomThemes();
const solarized = themes.find(t => t.slug === 'solarized');
const resolved = solarized ? resolveCustomTheme(solarized) : null;
console.log(JSON.stringify({
  count: themes.length,
  slug: solarized?.slug,
  name: solarized?.name,
  base: solarized?.base,
  overrideKeys: Object.keys(solarized?.overrides ?? {}),
  resolvedClaude: resolved?.claude,
  resolvedWarning: resolved?.warning,
  resolvedError: resolved?.error,
  builtSlug: buildCustomThemeSlug('solarized'),
  parsedSlug: parseCustomThemeSlug('custom:solarized'),
  isCustom: isCustomThemeSetting('custom:solarized'),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.env(env).quiet()).stdout.toString().trim(),
    );
    expect(out.count).toBe(1); // bad.json skipped
    expect(out.slug).toBe("solarized");
    expect(out.name).toBe("Solarized");
    expect(out.base).toBe("dark");
    expect(out.overrideKeys).toEqual(["claude", "warning"]);
    expect(out.resolvedClaude).toBe("rgb(38,139,210)"); // override applied
    expect(out.resolvedWarning).toBe("rgb(203,75,22)"); // override applied
    expect(out.resolvedError).toBe("rgb(255,107,128)"); // inherited from base dark
    expect(out.builtSlug).toBe("custom:solarized");
    expect(out.parsedSlug).toBe("solarized");
    expect(out.isCustom).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("UI gaps parse check (no TDZ)", () => {
  test("all touched modules import cleanly", async () => {
    const script = `
await Promise.all([
  import("${REPO_ROOT}/src/components/Markdown.tsx"),
  import("${REPO_ROOT}/src/components/Spinner/SpinnerAnimationRow.tsx"),
  import("${REPO_ROOT}/src/components/Spinner/utils.ts"),
  import("${REPO_ROOT}/src/components/ThemePicker.tsx"),
  import("${REPO_ROOT}/src/commands/theme/theme.tsx"),
  import("${REPO_ROOT}/src/commands/theme/customThemes.ts"),
  import("${REPO_ROOT}/src/components/design-system/ThemeProvider.tsx"),
]);
console.log("OK");
`;
    const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim();
    expect(out).toBe("OK");
  });
});
