import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code hook execution gaps (D1/D13/D14) e2e — source-grep + runtime.
 *
 * Verifies OCC's hook *execution* matches the official 2.1.200 binary for
 * three gaps that previously had the schema but threw / weren't executed:
 *
 *   D1 (2.1.89)  — PreToolUse `permissionDecision: 'defer'` pauses the tool
 *                  call (print-mode only, solo-only). Previously the schema
 *                  rejected 'defer' and processHookJSONOutput threw.
 *   D13 (2.1.139) — hook `args` (exec form): when set, spawn the command
 *                  directly via argv without a shell.
 *   D14 (2.1.139) — hook `continueOnBlock`: when a prompt hook rejects, feed
 *                  the rejection reason back to Claude and continue instead
 *                  of hard-stopping.
 *
 * Expected wording/behavior grep-verified against /tmp/occ-audit/claude.strings.
 */

describe('D1 (2.1.89) PreToolUse defer permissionDecision (e2e)', () => {
  test('hook output schema accepts permissionDecision: "defer"', async () => {
    const script = `
import { hookJSONOutputSchema } from "${REPO_ROOT}/src/types/hooks.ts";
const r = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } });
console.log(JSON.stringify({ success: r.success }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
  })

  test('processHookJSONOutput maps defer to permissionBehavior without throwing', async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = processHookJSONOutput({
  json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } },
  command: 't', hookName: 'PreToolUse:Bash', toolUseID: 't1', hookEvent: 'PreToolUse',
});
console.log(JSON.stringify({ permissionBehavior: r.permissionBehavior }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.permissionBehavior).toBe('defer')
  })

  test('source: defer case + throw message + aggregation guards present', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // processHookJSONOutput maps defer -> permissionBehavior='defer'
    expect(src).toContain("case 'defer':")
    expect(src).toMatch(/permissionBehavior = 'defer'/)
    // throw message lists defer as a valid type (binary-exact)
    expect(src).toContain('Valid types are: allow, deny, ask, defer')
    // aggregation: print-mode-only guard (binary-exact wording)
    expect(src).toContain('defer is print-mode only')
    // aggregation: solo-only guard (binary-exact wording)
    expect(src).toContain('defer is solo-only')
    // aggregation precedence: deny > defer > ask > allow
    expect(src).toMatch(/deny > defer > ask > allow/)
  })

  test('source: hook output schema enum includes defer', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/types/hooks.ts`).text()
    expect(src).toMatch(/enum\(\['allow', 'deny', 'ask', 'defer'\]\)/)
  })
})

describe('D13 (2.1.139) hook args exec form (e2e)', () => {
  test('HookCommandSchema accepts command + args', async () => {
    const script = `
import { HookCommandSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HookCommandSchema().safeParse({ type: 'command', command: '/usr/bin/hook', args: ['--flag', 'value'] });
console.log(JSON.stringify({ success: r.success, args: r.success ? r.data.args : null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
    expect(out.args).toEqual(['--flag', 'value'])
  })

  test('source: execCommandHook spawns via argv without a shell when args set', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // branch on hook.args presence
    expect(src).toMatch(/hook\.args && hook\.args\.length > 0/)
    // spawn with shell: false (no shell — argv passed directly)
    expect(src).toMatch(/shell: false/)
    // binary-exact describe wording for the exec form
    expect(src).toMatch(/without a shell/)
  })
})

describe('D14 (2.1.139) hook continueOnBlock (e2e)', () => {
  test('PromptHookSchema accepts continueOnBlock', async () => {
    const script = `
import { HookCommandSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HookCommandSchema().safeParse({ type: 'prompt', prompt: 'check $ARGUMENTS', continueOnBlock: true });
console.log(JSON.stringify({ success: r.success, continueOnBlock: r.success ? r.data.continueOnBlock : null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
    expect(out.continueOnBlock).toBe(true)
  })

  test('source: execPromptHook respects continueOnBlock (binary formula)', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/hooks/execPromptHook.ts`,
    ).text()
    // binary: preventContinuation = !impossible && hook.continueOnBlock !== true
    // (impossible returns early, so the blocking branch reduces to the RHS)
    expect(src).toMatch(/preventContinuation: hook\.continueOnBlock !== true/)
  })

  test('source: schemas/hooks.ts PromptHookSchema has continueOnBlock', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/schemas/hooks.ts`).text()
    expect(src).toContain('continueOnBlock')
  })
})
