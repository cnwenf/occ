import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code hook alignment (D5/D6/D8) e2e — source-grep + runtime.
 *
 * Verifies OCC matches the official 2.1.200 binary for three hook gaps:
 *
 *   D5 (2.1.89)    — PermissionDenied hook was dead, gated behind
 *                    feature('TRANSCRIPT_CLASSIFIER')=false. Un-gated so it
 *                    fires on auto-mode classifier denials; retry message
 *                    realigned to binary wording.
 *   D6 (2.1.163)   — Stop/SubagentStop hooks can return
 *                    hookSpecificOutput.additionalContext — non-error
 *                    feedback delivered to the model/subagent so the
 *                    conversation continues and it can act on it.
 *   D8 (2.1.198+)  — Notification hook matcherMetadata gains
 *                    agent_needs_input + agent_completed values.
 *
 * Expected wording/behavior grep-verified against /tmp/occ-audit/claude.strings.
 */

describe('D5 PermissionDenied un-gate (source-grep)', () => {
  test('gate no longer requires feature(TRANSCRIPT_CLASSIFIER) — only the classifier check', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/tools/toolExecution.ts`,
    ).text()
    // binary: the only gate is decisionReason.type === 'classifier' &&
    // classifier === 'auto-mode' (no feature flag). The feature() call must
    // appear ONLY inside a comment, not as a live condition.
    const liveFeature = src.match(/if\s*\(\s*feature\(['"]TRANSCRIPT_CLASSIFIER['"]\)/)
    expect(liveFeature).toBeNull()
    // The live gate retains the auto-mode classifier check.
    expect(src).toMatch(
      /permissionDecision\.decisionReason\?\.type === 'classifier' &&\s*\n\s*permissionDecision\.decisionReason\.classifier === 'auto-mode'/,
    )
  })

  test('retry message is binary-exact', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/services/tools/toolExecution.ts`,
    ).text()
    // binary: "The PermissionDenied hook indicated you may retry this tool call."
    expect(src).toContain(
      'The PermissionDenied hook indicated you may retry this tool call.',
    )
    // the old mis-aligned wording is gone
    expect(src).not.toContain('this command is now approved')
  })
})

describe('D6 Stop/SubagentStop additionalContext (source-grep)', () => {
  test('syncHookResponseSchema recognises Stop + SubagentStop with additionalContext', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/types/hooks.ts`).text()
    // binary: hookEventName:A.literal("Stop"),additionalContext:A.string().optional()
    expect(src).toMatch(/hookEventName: z\.literal\('Stop'\),/)
    expect(src).toMatch(/hookEventName: z\.literal\('SubagentStop'\),/)
    // binary-exact describe wording for both events
    expect(src).toContain(
      'Hook-specific output for the Stop event. additionalContext is non-error feedback delivered to the model; the conversation continues so the model can act on it.',
    )
    expect(src).toContain(
      'Hook-specific output for the SubagentStop event. additionalContext is non-error feedback delivered to the subagent; the subagent continues so it can act on it.',
    )
  })

  test('processHookJSONOutput maps Stop/SubagentStop additionalContext (binary grouping)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // binary: case"Stop":case"SubagentStop":u.additionalContext=e.hookSpecificOutput.additionalContext;break
    expect(src).toMatch(
      /case 'Stop':\s*\n\s*case 'SubagentStop':\s*\n\s*result\.additionalContext = json\.hookSpecificOutput\.additionalContext\s*\n\s*break/,
    )
  })

  test('stopHooks consumer injects additionalContexts as hook_additional_context', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/query/stopHooks.ts`).text()
    // binary: if(O.additionalContexts&&O.additionalContexts.length>0){...xi({type:"hook_additional_context",content:O.additionalContexts,hookName:j,toolUseID:I,hookEvent:j})...}
    expect(src).toMatch(
      /if \(result\.additionalContexts && result\.additionalContexts\.length > 0\)/,
    )
    expect(src).toMatch(/type: 'hook_additional_context'/)
    // hookName/hookEvent follow agentId → SubagentStop | Stop (binary j=s.agentId?"SubagentStop":"Stop")
    expect(src).toMatch(
      /const stopHookEvent = toolUseContext\.agentId\s*\n\s*\?\s*'SubagentStop'\s*\n\s*:\s*'Stop'/,
    )
  })
})

describe('D6 Stop/SubagentStop additionalContext (runtime)', () => {
  test('hookJSONOutputSchema validates Stop + SubagentStop additionalContext', async () => {
    const script = `
import { hookJSONOutputSchema } from "${REPO_ROOT}/src/types/hooks.ts";
const stop = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'final feedback' } });
const sub = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: 'sub feedback' } });
console.log(JSON.stringify({ stop: stop.success, sub: sub.success }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.stop).toBe(true)
    expect(out.sub).toBe(true)
  })

  test('processHookJSONOutput maps Stop/SubagentStop additionalContext to result', async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const stop = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'A' } }, command: 'c', hookName: 'Stop', toolUseID: 't1', hookEvent: 'Stop' });
const sub = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: 'B' } }, command: 'c', hookName: 'SubagentStop', toolUseID: 't2', hookEvent: 'SubagentStop' });
console.log(JSON.stringify({ stopCtx: stop.additionalContext, subCtx: sub.additionalContext }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.stopCtx).toBe('A')
    expect(out.subCtx).toBe('B')
  })
})

describe('D8 Notification matcherMetadata agent_needs_input + agent_completed (source-grep + runtime)', () => {
  test('matcherMetadata values include the two new agent lifecycle types in binary order', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/hooks/hooksConfigManager.ts`,
    ).text()
    // binary: values:["permission_prompt","idle_prompt","auth_success","elicitation_dialog","elicitation_complete","elicitation_response","agent_needs_input","agent_completed"]
    // (tolerate an inline version-comment between the values; the runtime
    // test below asserts the exact full list.)
    expect(src).toMatch(
      /'elicitation_response',[\s\S]*?'agent_needs_input',[\s\S]*?'agent_completed',/,
    )
  })

  test('getHookEventMetadata().Notification.matcherMetadata.values matches the binary list exactly', async () => {
    const script = `
import { getHookEventMetadata } from "${REPO_ROOT}/src/utils/hooks/hooksConfigManager.ts";
const meta = getHookEventMetadata(['Bash', 'Read']);
console.log(JSON.stringify(meta.Notification.matcherMetadata));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.fieldToMatch).toBe('notification_type')
    expect(out.values).toEqual([
      'permission_prompt',
      'idle_prompt',
      'auth_success',
      'elicitation_dialog',
      'elicitation_complete',
      'elicitation_response',
      'agent_needs_input',
      'agent_completed',
    ])
  })
})
