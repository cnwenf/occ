import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tests for the --forward-subagent-text feature (CC 2.1.211 port).
 *
 * Covers:
 * 1. The gate logic (shouldForwardSubagentContent)
 * 2. The normalizeMessage forwarding (agent_progress → parent_tool_use_id)
 * 3. The CLI guard (--forward-subagent-text without --print + stream-json errors)
 */

// --- Gate logic tests ---

/**
 * Mirrors the binary's gate:
 *   if(!St && Vt.type!=="tool_use" && Vt.type!=="tool_result") continue;
 * When forwardSubagentText is false, only tool_use/tool_result are forwarded.
 * When true, all content (including text/thinking) is forwarded.
 */
function shouldForwardSubagentContent(
  contentType: string,
  forwardSubagentText: boolean,
): boolean {
  if (forwardSubagentText) return true
  return contentType === 'tool_use' || contentType === 'tool_result'
}

describe('shouldForwardSubagentContent gate', () => {
  test('forwards tool_use when flag is false', () => {
    expect(shouldForwardSubagentContent('tool_use', false)).toBe(true)
  })

  test('forwards tool_result when flag is false', () => {
    expect(shouldForwardSubagentContent('tool_result', false)).toBe(true)
  })

  test('suppresses text when flag is false', () => {
    expect(shouldForwardSubagentContent('text', false)).toBe(false)
  })

  test('suppresses thinking when flag is false', () => {
    expect(shouldForwardSubagentContent('thinking', false)).toBe(false)
  })

  test('forwards text when flag is true', () => {
    expect(shouldForwardSubagentContent('text', true)).toBe(true)
  })

  test('forwards thinking when flag is true', () => {
    expect(shouldForwardSubagentContent('thinking', true)).toBe(true)
  })

  test('forwards tool_use when flag is true', () => {
    expect(shouldForwardSubagentContent('tool_use', true)).toBe(true)
  })

  test('forwards tool_result when flag is true', () => {
    expect(shouldForwardSubagentContent('tool_result', true)).toBe(true)
  })

  test('suppresses redacted_thinking when flag is false', () => {
    expect(shouldForwardSubagentContent('redacted_thinking', false)).toBe(false)
  })

  test('forwards redacted_thinking when flag is true', () => {
    expect(shouldForwardSubagentContent('redacted_thinking', true)).toBe(true)
  })
})

// --- normalizeMessage forwarding tests ---

describe('normalizeMessage forwards agent_progress with parent_tool_use_id', () => {
  test('yields assistant text with parent_tool_use_id from agent_progress', async () => {
    const { normalizeMessage } = await import('../../src/utils/queryHelpers.js')
    const { getSessionId } = await import('../../src/bootstrap/state.js')

    // Build a synthetic agent_progress message containing a subagent
    // assistant message with a text block.
    const subagentMessage = {
      type: 'assistant' as const,
      uuid: 'sub-uuid-1',
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Subagent says hello' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        id: 'msg_sub_1',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parentToolUseID: 'toolu_parent_1',
      requestId: 'req_1',
      isMeta: false,
      isVisibleInTranscriptOnly: false,
      session_id: 'sess_1',
    }

    const progressMessage = {
      type: 'progress' as const,
      uuid: 'prog-uuid-1',
      toolUseID: 'toolu_progress_1',
      parentToolUseID: 'toolu_parent_1',
      data: {
        type: 'agent_progress',
        message: subagentMessage,
        prompt: '',
        agentId: 'agent_1',
        agentType: 'subagent',
        description: 'Test subagent',
        resolvedModel: 'claude-sonnet-4-20250514',
      },
    }

    const results = [...normalizeMessage(progressMessage as any)]

    // Should yield an assistant message with parent_tool_use_id set
    const assistantMsg = results.find(r => r.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.parent_tool_use_id).toBe('toolu_parent_1')
    expect(assistantMsg!.session_id).toBe(getSessionId())
  })

  test('yields user messages with parent_tool_use_id from agent_progress', async () => {
    const { normalizeMessage } = await import('../../src/utils/queryHelpers.js')

    const subagentUserMessage = {
      type: 'user' as const,
      uuid: 'sub-user-1',
      message: {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'inner_tool_1', content: 'result data' }],
      },
      parentToolUseID: 'toolu_parent_2',
      isMeta: false,
      isVisibleInTranscriptOnly: false,
      toolUseResult: 'result data',
      session_id: 'sess_2',
    }

    const progressMessage = {
      type: 'progress' as const,
      uuid: 'prog-uuid-2',
      toolUseID: 'toolu_progress_2',
      parentToolUseID: 'toolu_parent_2',
      data: {
        type: 'agent_progress',
        message: subagentUserMessage,
        prompt: '',
        agentId: 'agent_2',
        agentType: 'subagent',
        description: 'Test subagent',
        resolvedModel: 'claude-sonnet-4-20250514',
      },
    }

    const results = [...normalizeMessage(progressMessage as any)]

    const userMsg = results.find(r => r.type === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.parent_tool_use_id).toBe('toolu_parent_2')
  })

  test('parent assistant messages have parent_tool_use_id null', async () => {
    const { normalizeMessage } = await import('../../src/utils/queryHelpers.js')

    const parentMessage = {
      type: 'assistant' as const,
      uuid: 'parent-uuid-1',
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Parent says hello' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        id: 'msg_parent_1',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      requestId: 'req_parent_1',
      isMeta: false,
      isVisibleInTranscriptOnly: false,
      session_id: 'sess_parent',
    }

    const results = [...normalizeMessage(parentMessage as any)]

    const assistantMsg = results.find(r => r.type === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.parent_tool_use_id).toBeNull()
  })
})

// --- CLI guard e2e test ---

/**
 * Runs the OCC CLI (built dist/cli.js or source) with the given args + env,
 * capturing stdout/stderr.
 */
function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const REPO_ROOT = existsSync('/occ/src/entrypoints/cli.tsx')
    ? '/occ'
    : process.cwd()
  const entrypoint = process.env.OCC_ENTRYPOINT ?? join(REPO_ROOT, 'dist/cli.js')
  const bin = 'bun'
  return new Promise(resolve => {
    const child = spawn(bin, [entrypoint, ...args], {
      env: { ...process.env, ...env },
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!) } catch {}
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
  })
}

describe('CLI guard: --forward-subagent-text', () => {
  test(
    'errors without --print and --output-format=stream-json',
    async () => {
      // --forward-subagent-text alone (no --print, no --output-format) should
      // emit the upstream guard error and exit non-zero.
      //
      // This spawns the full built CLI (dist/cli.js), which under the GitHub
      // Actions runner takes longer than the suite's default 10s per-test
      // cap (locally ~5s; CI is slower). The guard is real and must run —
      // raise the per-test timeout rather than skipping. ci.yml builds dist
      // before `bun test`, so the entrypoint exists in CI.
      const result = await runCli(
        ['--forward-subagent-text', '-p', 'hello'],
        { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      )
      const combined = result.stdout + result.stderr
      expect(combined).toContain('--forward-subagent-text requires --print and --output-format=stream-json')
      expect(result.code).not.toBe(0)
    },
    { timeout: 30_000 },
  )

  test('env var alone does not error (silently disables)', async () => {
    // When only the env var is set (not the CLI flag), upstream silently
    // disables rather than erroring. The binary guard:
    //   if(pe){if(!St||L!=="stream-json"){if(k)return ls(...);pe=!1}}
    // Only errors when `k` (the CLI flag) is truthy. Env-only → silent disable.
    // We verify no guard error is emitted. Use --output-format=stream-json
    // with -p so the CLI enters a valid mode path (no guard error), then
    // fails fast on missing API creds.
    const result = await runCli(
      ['-p', '--output-format=stream-json', 'hello'],
      {
        CLAUDE_CODE_FORWARD_SUBAGENT_TEXT: '1',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
        ANTHROPIC_API_KEY: '',  // No API creds → fast failure
      },
      3000,
    )
    const combined = result.stdout + result.stderr
    expect(combined).not.toContain('--forward-subagent-text requires --print')
  })
})
