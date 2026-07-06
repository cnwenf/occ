import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * claude-code 2.1.169 TaskCreate auto-repair (source-grep): verifies H13
 * against the official 2.1.200 binary.
 *
 *   H13a — TaskCreate auto-repairs malformed inputs before schema validation
 *          (TodoWrite-style `tasks`/`todos` and Agent `prompt`/`subagent_type`
 *          are unrecoverable -> steer; `task` wrappers, legacy `title`/`name`/
 *          `content` aliases, and backfilled subject/description are repaired).
 *   H13b — Unloaded-tool errors include the schema hint (buildSchemaNotSentHint)
 *          so the model re-loads the deferred tool via ToolSearch select:<name>.
 *
 * Source-grep assertions only (no model credentials required).
 */
describe('2.1.169 TaskCreate auto-repair (source-grep)', () => {
  test('H13a: TaskCreate defines coerceInput + validationErrorSteer with binary-exact logic', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/TaskCreateTool/TaskCreateTool.ts`,
    ).text()

    // The two tool-def hooks wired into the validation flow.
    expect(src).toContain('coerceInput(input)')
    expect(src).toContain('validationErrorSteer(input)')

    // Repair-log shapeClass tags — must match the binary's FMl tags exactly.
    expect(src).toContain('task_wrapper_string')
    expect(src).toContain('task_wrapper_object')
    expect(src).toContain('alias_')
    expect(src).toContain('backfill_description')
    expect(src).toContain('backfill_subject')
    expect(src).toContain('strip_')
    expect(src).toContain('drop_invalid_activeForm')
    expect(src).toContain('drop_invalid_metadata')

    // Alias maps + key sets — binary-exact (spacing-agnostic; formatter may
    // add spaces after commas).
    expect(src).toMatch(/SUBJECT_ALIASES\s*=\s*\[[\s\S]*'title'[\s\S]*'name'/)
    expect(src).toMatch(/DESCRIPTION_ALIASES\s*=\s*\[[\s\S]*'content'/)
    expect(src).toMatch(/ACTIVE_FORM_ALIASES\s*=\s*\[[\s\S]*'active_form'/)
    expect(src).toMatch(
      /ALLOWED_KEYS\s*=\s*new Set\(\[[\s\S]*'subject'[\s\S]*'description'[\s\S]*'activeForm'[\s\S]*'metadata'/,
    )
    expect(src).toContain("'subagent_type'")

    // Misuse detectors — binary-exact (Yrr/Xrr).
    expect(src).toContain("'tasks' in v || 'todos' in v")
    expect(src).toContain("'prompt' in v || 'subagent_type' in v")
  })

  test('H13a: validationErrorSteer returns binary-exact steering messages', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/tools/TaskCreateTool/TaskCreateTool.ts`,
    ).text()

    // Exact wording from the 2.1.200 binary UMl function.
    expect(src).toContain(
      'TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.',
    )
    expect(src).toContain(
      'This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.',
    )
  })

  test('H13a+b: toolExecution wires coerceInput (pre-parse) + steer + schema-in-unloaded-error', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/tools/toolExecution.ts`,
    ).text()

    // coerceInput runs BEFORE safeParse and the repaired input is what's parsed.
    expect(src).toMatch(/coerceInput\?\.\(input\)/)
    expect(src).toMatch(/safeParse\(parseInput\)/)
    // The coerced-repair analytics event (binary tengu_tool_input_coerced).
    expect(src).toContain('tengu_tool_input_coerced')
    expect(src).toContain('shapeClass')
    expect(src).toContain('coerced_valid')
    expect(src).toContain('coerced_still_invalid')

    // validationErrorSteer is appended to the error content (post Zod, pre hint).
    expect(src).toMatch(/validationErrorSteer\?\.\(input\)/)
    expect(src).toMatch(/errorContent \+= steer/)

    // H13b: the schema-in-unloaded-error hint is appended for deferred tools.
    expect(src).toContain('buildSchemaNotSentHint')
    expect(src).toContain('tengu_deferred_tool_schema_not_sent')
    expect(src).toContain('schema was not sent to the API')
    expect(src).toContain('select:')
  })
})
