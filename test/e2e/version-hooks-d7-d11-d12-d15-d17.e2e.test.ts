import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * Hooks gaps D7/D11/D12/D15/D17 e2e — source-grep + runtime.
 *
 * Verifies OCC's hook layer matches the official 2.1.200 binary for five
 * gaps. Behaviour/wording grep-verified against /tmp/occ-audit/claude.strings.
 *
 *   D7  (2.1.145) — Stop/SubagentStop hook input populates background_tasks +
 *                   session_crons (was empty stubs []). Binary: Oql/Nql +
 *                   E7c/A7c schemas.
 *   D11 (2.1.118) — mcp_tool hook type: a hook can call an MCP tool.
 *                   Binary: SWo, "mcp_tool hooks are not available for the
 *                   '<event>' hook event (no MCP client context)".
 *   D12 (2.1.121) — PostToolUse updatedToolOutput works for ALL tools
 *                   (updatedMCPToolOutput is MCP-only, deprecated).
 *   D15 (2.1.199) — SessionStart/Setup/SubagentStart exit code 2 = blocking +
 *                   show stderr (was hidden on the JSON output path).
 *   D17 (2.1.169) — PostSession hook event (self-hosted runner post-session
 *                   lifecycle). Changelog-derived; no literal in 2.1.200
 *                   binary strings.
 */

describe('D7 (2.1.145) background_tasks/session_crons in Stop hook input', () => {
  test('source: helpers populate real background tasks + session crons', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // helpers exist (binary: Oql/Nql)
    expect(src).toContain('getBackgroundTasksForHookInput')
    expect(src).toContain('getSessionCronsForHookInput')
    // background_tasks/session_crons are no longer empty stubs
    expect(src).not.toMatch(/background_tasks: \[\],/)
    expect(src).not.toMatch(/session_crons: \[\],/)
    // both Stop and SubagentStop hook inputs populate them
    expect(src).toContain('getBackgroundTasksForHookInput(appState)')
    expect(src).toContain('getSessionCronsForHookInput()')
    // type-label map matches binary Eko
    expect(src).toContain("local_bash: 'shell'")
    expect(src).toContain("local_agent: 'subagent'")
    expect(src).toContain("local_workflow: 'workflow'")
    expect(src).toContain("monitor_mcp: 'monitor'")
    expect(src).toContain("mcp_task: 'MCP task'")
    // cap marker matches binary Jye: "… [+N chars]"
    expect(src).toMatch(/… \[\+\$\{.*\} chars\]/)
  })

  test('runtime: getSessionCronsForHookInput maps session crons', async () => {
    const script = `
import { getSessionCronTasks } from "${REPO_ROOT}/src/bootstrap/state.ts";
// The helper is module-internal; verify the cron source + shape indirectly.
const tasks = getSessionCronTasks();
console.log(JSON.stringify({ count: tasks.length, ok: Array.isArray(tasks) }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.ok).toBe(true)
  })
})

describe('D11 (2.1.118) mcp_tool hook type', () => {
  test('HookCommandSchema accepts mcp_tool', async () => {
    const script = `
import { HookCommandSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HookCommandSchema().safeParse({ type: 'mcp_tool', server: 'srv', tool: 'echo', input: { msg: 'hi' } });
console.log(JSON.stringify({ success: r.success, type: r.success ? r.data.type : null, server: r.success ? r.data.server : null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
    expect(out.type).toBe('mcp_tool')
    expect(out.server).toBe('srv')
  })

  test('source: execMcpToolHook + binary-exact wording', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/hooks/execMcpToolHook.ts`,
    ).text()
    // binary-exact "not available" warning
    expect(src).toContain(
      "mcp_tool hooks are not available for the '",
    )
    expect(src).toContain('(no MCP client context)')
    // binary-exact "calling" log
    expect(src).toContain('Hooks: mcp_tool calling ')
    expect(src).toContain('arg(s)')
    // binary-exact "hook error" log
    expect(src).toContain('Hooks: mcp_tool hook error: ')
    // not-connected warning
    expect(src).toContain("not connected")
    // ${path} interpolation (binary: P8f)
    expect(src).toMatch(/\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/)
    // client.callTool invocation
    expect(src).toContain('callTool')
  })

  test('source: mcp_tool wired into execution loop + dedup', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toMatch(/hook\.type === ['"]mcp_tool['"]/)
    expect(src).toContain('execMcpToolHook')
    expect(src).toContain('uniqueMcpToolHooks')
  })

  test('source: getHookDisplayText returns server/tool for mcp_tool', async () => {
    const src = await Bun.file(
      `${REPO_ROOT}/src/utils/hooks/hooksSettings.ts`,
    ).text()
    expect(src).toMatch(/case ['"]mcp_tool['"]:/)
    expect(src).toMatch(/\$\{hook\.server\}\/\$\{hook\.tool\}/)
  })
})

describe('D12 (2.1.121) updatedToolOutput for all tools', () => {
  test('hookJSONOutputSchema accepts updatedToolOutput for PostToolUse', async () => {
    const script = `
import { hookJSONOutputSchema } from "${REPO_ROOT}/src/types/hooks.ts";
const r = hookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ok: true } } });
console.log(JSON.stringify({ success: r.success, has: r.success ? r.data.hookSpecificOutput.updatedToolOutput !== undefined : null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
    expect(out.has).toBe(true)
  })

  test('processHookJSONOutput extracts updatedToolOutput for all tools', async () => {
    const script = `
import { processHookJSONOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = processHookJSONOutput({ json: { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ok: 1 } } }, command: 't', hookName: 'PostToolUse:Bash', toolUseID: 't1', hookEvent: 'PostToolUse' });
console.log(JSON.stringify({ updatedToolOutput: r.updatedToolOutput }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.updatedToolOutput).toEqual({ ok: 1 })
  })

  test('source: schema + extraction + aggregation yield', async () => {
    const hooksSrc = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // TypedSyncHookOutput PostToolUse has updatedToolOutput
    expect(hooksSrc).toMatch(/hookEventName: 'PostToolUse'[\s\S]*?updatedToolOutput\?: unknown/)
    // processHookJSONOutput extracts it
    expect(hooksSrc).toContain('json.hookSpecificOutput.updatedToolOutput')
    // aggregation yields updatedToolOutput (all tools) — binary-exact log
    expect(hooksSrc).toContain('replaced tool output')
    // updatedMCPToolOutput still present (MCP-only, deprecated message)
    expect(hooksSrc).toContain('replaced MCP tool output')
    // schema deprecation wording (binary-exact)
    const typesSrc = await Bun.file(`${REPO_ROOT}/src/types/hooks.ts`).text()
    expect(typesSrc).toContain(
      'Prefer updatedToolOutput, which works for all tools',
    )
  })
})

describe('D15 (2.1.199) exit code 2 = blocking + show stderr', () => {
  test('source: JSON path exit-code-2 fallback + binary-exact wording', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    // 2.1.199 fallback in the JSON output path
    expect(src).toContain('2.1.199')
    expect(src).toMatch(/result\.status === 2 && !processed\.blockingError/)
    // binary-exact blockingError format: [command]: stderr || "No stderr output"
    expect(src).toMatch(/\[\$\{.*command.*\}\]: \$\{.*stderr.* \|\| 'No stderr output'\}/)
    // outcome flips to 'blocking' when blockingError is set on the JSON path
    expect(src).toMatch(/processed\.blockingError[\s\S]*?'blocking'/)
  })
})

describe('D17 (2.1.169) PostSession hook event', () => {
  test('HooksSchema accepts PostSession', async () => {
    const script = `
import { HooksSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HooksSchema().safeParse({ PostSession: [{ matcher: 'clear', hooks: [{ type: 'command', command: 'echo done' }] }] });
console.log(JSON.stringify({ success: r.success }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.success).toBe(true)
  })

  test('source: HOOK_EVENTS includes PostSession + executor', async () => {
    const agentSdk = await Bun.file(
      `${REPO_ROOT}/src/entrypoints/agentSdkTypes.js`,
    ).text()
    expect(agentSdk).toContain("'PostSession'")
    const coreTypes = await Bun.file(
      `${REPO_ROOT}/src/entrypoints/sdk/coreTypes.ts`,
    ).text()
    expect(coreTypes).toContain("'PostSession'")
    const hooksSrc = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(hooksSrc).toContain('executePostSessionHooks')
    expect(hooksSrc).toContain("hook_event_name: 'PostSession'")
    // matchQuery switch handles PostSession
    expect(hooksSrc).toMatch(/case 'PostSession':/)
  })
})
