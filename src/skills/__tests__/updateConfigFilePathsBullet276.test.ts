import { describe, expect, test } from 'bun:test'

/**
 * claude-code 2.1.276: "/update-config was writing Write(path) permission
 * rules instead of Edit(path) rules for file-path permissions."
 *
 * The fix is a fourth bullet under **Permission Rule Syntax:** in the skill
 * prompt body, byte-extracted from the official v276 binary (@205449868
 * region; marker: "are not matched by file permission checks"). The bullet
 * is accurate for OCC's engine too: buildPatternBuckets()
 * (src/utils/permissions/filesystem.ts) applies Edit rules to every
 * file-writing tool and Read rules to reads, so Write(path)/NotebookEdit(path)/
 * Glob(path) rules are never matched.
 *
 * Source-grep convention (cf. test/e2e/version-hooks-matchers.e2e.test.ts):
 * the bullet lives in the SETTINGS_EXAMPLES_DOCS template literal, so the
 * test reads the source, unescapes the template-literal \` escapes, and
 * pins the RUNTIME string byte-exactly. The behavioral path
 * (registerUpdateConfigSkill + getPromptForCommand) is deliberately NOT
 * exercised here: it regenerates the full settings JSON schema, which
 * currently throws on the pre-existing `enabledPlugins` key (zod
 * toJSONSchema "Undefined cannot be represented in JSON Schema" — present
 * at HEAD before this change), and the bundledSkills import graph pulls
 * @anthropic-ai/sandbox-runtime, whose @pondwader/socks5-server dep is
 * absent in some environments.
 *
 * NOTE: the surrounding example-block divergences (OCC's `Write(/etc/*)` ask
 * example and colon-style Bash patterns) are pre-existing and recorded
 * separately — this test pins ONLY the new bullet.
 */

const UPDATE_CONFIG_SOURCE = new URL(
  '../bundled/updateConfig.ts',
  import.meta.url,
).pathname

// Byte-exact official v276 bullet (runtime form — real backticks, no
// trailing period). Source-escaped form in the binary: \`"Edit(src/**)"\` etc.
const FILE_PATHS_BULLET = `- File paths: \`"Edit(src/**)"\` - path rules in \`permissions\` use \`Edit(path)\` for every file-writing tool (Write, Edit, NotebookEdit) and \`Read(path)\` for reads. \`Write(path)\`, \`NotebookEdit(path)\` and \`Glob(path)\` rules are not matched by file permission checks. Bare tool names (\`"Write"\`), deny/ask \`Tool(param:value)\` rules and hook \`if\` conditions still use each tool's own name`

const TOOL_ONLY_BULLET = '- Tool only: `"Read"` - allows all Read operations'

const SYNTAX_HEADER = '**Permission Rule Syntax:**'
const ENV_HEADER = '### Environment Variables'

/** The permission-syntax block as the runtime prompt renders it. */
async function getPermissionRuleSyntaxBlock(): Promise<string> {
  const src = await Bun.file(UPDATE_CONFIG_SOURCE).text()
  const start = src.indexOf(SYNTAX_HEADER)
  const end = src.indexOf(ENV_HEADER, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  // Template-literal source escapes → runtime characters.
  return src.slice(start, end).replaceAll('\\`', '`')
}

describe('2.1.276 update-config skill — File paths permission bullet', () => {
  test('skill text contains the byte-exact fourth bullet', async () => {
    const block = await getPermissionRuleSyntaxBlock()
    expect(block).toContain(FILE_PATHS_BULLET)
  })

  test('bullet is the 4th item — after Tool-only, before ### Environment Variables', async () => {
    const block = await getPermissionRuleSyntaxBlock()
    const toolOnlyIdx = block.indexOf(TOOL_ONLY_BULLET)
    const bulletIdx = block.indexOf(FILE_PATHS_BULLET)
    expect(toolOnlyIdx).toBeGreaterThan(-1)
    expect(bulletIdx).toBeGreaterThan(toolOnlyIdx)
    // Nothing but whitespace between the bullet's end and the section header.
    expect(block.slice(bulletIdx + FILE_PATHS_BULLET.length).trim()).toBe('')
  })

  test('bullet has no trailing period (official text ends at "own name")', async () => {
    const block = await getPermissionRuleSyntaxBlock()
    const bulletIdx = block.indexOf(FILE_PATHS_BULLET)
    expect(bulletIdx).toBeGreaterThan(-1)
    const line = block
      .slice(bulletIdx)
      .split('\n')[0]
    expect(line).toBe(FILE_PATHS_BULLET)
    expect(line.endsWith("each tool's own name")).toBe(true)
  })

  test('bullet documents the Edit(path)/Read(path) engine semantics (anti Write(path) guidance)', async () => {
    const block = await getPermissionRuleSyntaxBlock()
    expect(block).toContain('are not matched by file permission checks')
    // The changelog's core guidance: file-writing tools share Edit(path).
    expect(block).toContain(
      'use `Edit(path)` for every file-writing tool (Write, Edit, NotebookEdit)',
    )
    // The first three bullets are untouched by this port.
    expect(block).toContain('- Exact match: `"Bash(npm run test)"`')
    expect(block).toContain(TOOL_ONLY_BULLET)
  })
})
