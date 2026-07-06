import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * claude-code new hook *event types* (D2/D3/D4) e2e — source-grep + runtime.
 *
 * Verifies OCC matches the official 2.1.200 binary for three hook events that
 * previously did not exist as first-class event types:
 *
 *   D2 (2.1.152)  — MessageDisplay: fires with each batch of newly completed
 *                  lines while an assistant message streams. Display-only:
 *                  displayContent replaces the on-screen delta without
 *                  changing the stored message.
 *   D3 (cross)    — PostToolBatch: fires once after every tool call in a
 *                  batch has resolved, before the next model request.
 *                  PostToolUse fires per-tool; PostToolBatch fires once with
 *                  the full batch.
 *   D4 (cross)    — UserPromptExpansion: fires when a user-typed slash command
 *                  (or MCP prompt) expands into a prompt, before
 *                  UserPromptSubmit.
 *
 * Expected wording/behavior grep-verified against /tmp/occ-audit/claude.strings.
 */

describe('D2/D3/D4 hook event registration (source-grep)', () => {
  test('HOOK_EVENTS includes the three new events in binary order', async () => {
    const core = await Bun.file(`${REPO_ROOT}/src/entrypoints/sdk/coreTypes.ts`).text()
    // PostToolBatch after PostToolUseFailure
    expect(core).toMatch(/'PostToolUseFailure',\s*\n\s*\/\/[^]*'PostToolBatch'/)
    expect(core).toContain("'PostToolBatch'")
    // UserPromptExpansion after UserPromptSubmit
    expect(core).toContain("'UserPromptExpansion'")
    // MessageDisplay at the end (after FileChanged)
    expect(core).toMatch(/'FileChanged',\s*\n[^]*'MessageDisplay',\s*\n\] as const/)
  })

  test('runtime HOOK_EVENTS bundle (agentSdkTypes.js) is not stale', async () => {
    const js = await Bun.file(`${REPO_ROOT}/src/entrypoints/agentSdkTypes.js`).text()
    expect(js).toContain("'PostToolBatch'")
    expect(js).toContain("'UserPromptExpansion'")
    expect(js).toContain("'MessageDisplay'")
  })

  test('SDK HOOK_EVENTS + HookInputSchema + SyncHookJSONOutputSchema parity', async () => {
    const schemas = await Bun.file(
      `${REPO_ROOT}/src/entrypoints/sdk/coreSchemas.ts`,
    ).text()
    expect(schemas).toContain("'PostToolBatch'")
    expect(schemas).toContain("'UserPromptExpansion'")
    expect(schemas).toContain("'MessageDisplay'")
    // input schemas exist
    expect(schemas).toContain('PostToolBatchHookInputSchema')
    expect(schemas).toContain('UserPromptExpansionHookInputSchema')
    expect(schemas).toContain('MessageDisplayHookInputSchema')
    // hook-specific output schemas exist
    expect(schemas).toContain('PostToolBatchHookSpecificOutputSchema')
    expect(schemas).toContain('UserPromptExpansionHookSpecificOutputSchema')
    expect(schemas).toContain('MessageDisplayHookSpecificOutputSchema')
    // binary-exact output field: displayContent for MessageDisplay
    expect(schemas).toMatch(/hookEventName: z\.literal\('MessageDisplay'\),\s*\n\s*displayContent/)
    // binary-exact: PostToolBatch tool_calls element shape
    expect(schemas).toMatch(/tool_name: z\.string\(\),\s*\n\s*tool_input: z\.unknown\(\),\s*\n\s*tool_use_id: z\.string\(\),\s*\n\s*tool_response: z\.unknown\(\)\.optional\(\)/)
    // binary-exact: UserPromptExpansion expansion_type enum
    expect(schemas).toMatch(/expansion_type: z\.enum\(\['slash_command', 'mcp_prompt'\]\)/)
  })

  test('hookJSONOutputSchema (types/hooks.ts) recognises new hookSpecificOutput', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/types/hooks.ts`).text()
    expect(src).toMatch(/hookEventName: z\.literal\('PostToolBatch'\)/)
    expect(src).toMatch(/hookEventName: z\.literal\('UserPromptExpansion'\)/)
    expect(src).toMatch(/hookEventName: z\.literal\('MessageDisplay'\)/)
    // binary-exact display-only describe wording
    expect(src).toContain('Display-only: replaces the delta on screen without changing the stored message.')
  })
})

describe('D2/D3/D4 matcher + processHookJSONOutput (source-grep)', () => {
  test('matchQuery switch: UserPromptExpansion matches on command_name', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // binary: case"UserPromptExpansion":i=r.command_name;break
    expect(src).toMatch(/case 'UserPromptExpansion':\s*\n\s*matchQuery = hookInput\.command_name/)
  })

  test('MATCHER_COMMA_HYPHEN_EVENTS includes UserPromptExpansion (binary F8f set)', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // binary F8f set: UserPromptExpansion sits between PermissionDenied and
    // SessionStart (admits comma/hyphen literals for command_name matchers).
    expect(src).toMatch(/'PermissionDenied',[\s\S]*?'UserPromptExpansion',[\s\S]*?'SessionStart',/)
  })

  test('processHookJSONOutput maps the three new hookSpecificOutput cases', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // binary: case"MessageDisplay":u.displayContent=e.hookSpecificOutput.displayContent;break
    expect(src).toMatch(/case 'MessageDisplay':\s*\n\s*result\.displayContent = json\.hookSpecificOutput\.displayContent/)
    // binary: case"PostToolBatch":u.additionalContext=e.hookSpecificOutput.additionalContext;break
    expect(src).toMatch(/case 'PostToolBatch':\s*\n\s*result\.additionalContext = json\.hookSpecificOutput\.additionalContext/)
    // binary: case"UserPromptExpansion":u.additionalContext=e.hookSpecificOutput.additionalContext;break
    expect(src).toMatch(/case 'UserPromptExpansion':\s*\n\s*result\.additionalContext = json\.hookSpecificOutput\.additionalContext/)
  })

  test('HookResult + AggregatedHookResult carry displayContent', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toContain('displayContent?: string')
  })
})

describe('D2/D3/D4 execute functions (source-grep)', () => {
  test('three execute functions exist with binary-exact names', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toMatch(/export async function\* executePostToolBatchHooks/)
    expect(src).toMatch(/export async function\* executeUserPromptExpansionHooks/)
    expect(src).toMatch(/export async function\* executeMessageDisplayHooks/)
  })

  test('PostToolBatch builds tool_calls input + hook-<uuid> toolUseID', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toMatch(/hook_event_name: 'PostToolBatch'/)
    expect(src).toMatch(/tool_calls: toolCalls/)
    // binary: toolUseID `hook-${f.uuid(...)}`
    expect(src).toMatch(/toolUseID: `hook-\$\{randomUUID\(\)\}`/)
  })

  test('UserPromptExpansion builds expansion fields + command_name matchQuery', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toMatch(/hook_event_name: 'UserPromptExpansion'/)
    expect(src).toMatch(/expansion_type: expansion\.expansion_type/)
    expect(src).toMatch(/matchQuery: expansion\.command_name/)
  })

  test('MessageDisplay builds per-flush delta input', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toMatch(/hook_event_name: 'MessageDisplay'/)
    expect(src).toMatch(/delta: display\.delta/)
    expect(src).toMatch(/final: display\.final/)
  })
})

describe('D2/D3/D4 runtime (parse + schema + processHookJSONOutput)', () => {
  test('HooksSchema accepts the three new event keys', async () => {
    const script = `
import { HooksSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HooksSchema().safeParse({ PostToolBatch: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] }], MessageDisplay: [], UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'echo x' }] }] });
console.log(JSON.stringify({ success: r.success }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
  })

  test('hookJSONOutputSchema validates the three new hookSpecificOutput', async () => {
    const script = `
import { hookJSONOutputSchema } from "${REPO_ROOT}/src/types/hooks.ts";
const md = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: 'replaced' } });
const ptb = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'ctx' } });
const upe = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'ctx2' } });
console.log(JSON.stringify({ md: md.success, ptb: ptb.success, upe: upe.success }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.md).toBe(true)
    expect(out.ptb).toBe(true)
    expect(out.upe).toBe(true)
  })

  test('processHookJSONOutput maps new hookSpecificOutput to result fields', async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const md = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: 'D' } }, command: 'c', hookName: 'MessageDisplay', toolUseID: 't1', hookEvent: 'MessageDisplay' });
const ptb = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'A' } }, command: 'c', hookName: 'PostToolBatch', toolUseID: 't2', hookEvent: 'PostToolBatch' });
const upe = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'B' } }, command: 'c', hookName: 'UserPromptExpansion', toolUseID: 't3', hookEvent: 'UserPromptExpansion' });
console.log(JSON.stringify({ displayContent: md.displayContent, ptbCtx: ptb.additionalContext, upeCtx: upe.additionalContext }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.displayContent).toBe('D')
    expect(out.ptbCtx).toBe('A')
    expect(out.upeCtx).toBe('B')
  })

  test('isHookEvent recognises the three new events', async () => {
    const script = `
import { isHookEvent } from "${REPO_ROOT}/src/types/hooks.ts";
console.log(JSON.stringify({
  ptb: isHookEvent('PostToolBatch'),
  upe: isHookEvent('UserPromptExpansion'),
  md: isHookEvent('MessageDisplay'),
  bogus: isHookEvent('NotAnEvent'),
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.ptb).toBe(true)
    expect(out.upe).toBe(true)
    expect(out.md).toBe(true)
    expect(out.bogus).toBe(false)
  })

  test('execute functions are exported and callable', async () => {
    const script = `
import * as H from "${REPO_ROOT}/src/utils/hooks.ts";
console.log(JSON.stringify({
  ptb: typeof H.executePostToolBatchHooks,
  upe: typeof H.executeUserPromptExpansionHooks,
  md: typeof H.executeMessageDisplayHooks,
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.ptb).toBe('function')
    expect(out.upe).toBe('function')
    expect(out.md).toBe('function')
  })
})
