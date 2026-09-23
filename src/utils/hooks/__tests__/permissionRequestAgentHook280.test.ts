import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { ToolUseContext } from '../../../Tool.js'
import type { HooksSettings } from '../../settings/types.js'

/**
 * 2.1.280 (#085): "Changed PermissionRequest hooks: an agent-type hook no
 * longer runs there, since its answer could never allow or deny the request;
 * it now shows an error pointing to command or http hooks."
 *
 * Binary evidence (official ELFs, programmatic checks):
 *   v280 @199810478 (code site) — the agent branch opens with:
 *     if(Le==="PermissionRequest")throw Error("agent-type hooks are not
 *     supported for PermissionRequest events (an agent hook answers ok or
 *     not ok, and cannot return the allow / deny decision a permission
 *     request needs). Use a command- or http-type hook instead.");
 *     ahead of the no-conversation-context guard (`if(!w)throw ...`).
 *   v280 @98607664 — string table carries the identical literal.
 *   v278 — 0 hits for the literal; the v278 agent branch (@200681828) only
 *     has the `!w` throw.
 *
 * The throw lands in the per-hook catch and surfaces through OCC's existing
 * error-result shape: a hook_non_blocking_error attachment with
 * stderr `Failed to run: <message>` and exitCode 1 (the same path the
 * sibling prompt/agent context errors already use).
 */

// Byte-exact from the v280 ELF (@98607664 string table / @199810478 code
// site). NOTE: no trailing period after "instead". Absent from v278.
const EXPECTED_ERROR =
  'agent-type hooks are not supported for PermissionRequest events (an agent hook answers ok or not ok, and cannot return the allow / deny decision a permission request needs). Use a command- or http-type hook instead.'

// --- Mock seams (OCC-97: Bun's mock.module leaks across test files in the
// same worker — spread the real module, override narrowly, restore below). ---

const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
let mockedHooksConfig: HooksSettings | null = null
mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

const actualAgentModule = await import('../execAgentHook.js')
const execAgentHookSpy = mock(async () => {
  throw new Error('execAgentHook must not run for a PermissionRequest hook')
})
mock.module('../execAgentHook.js', () => ({
  ...actualAgentModule,
  execAgentHook: execAgentHookSpy,
}))

const actualHttpModule = await import('../execHttpHook.js')
const execHttpHookSpy = mock(async () => ({
  aborted: false,
  ok: true,
  statusCode: 200,
  body: '{}',
}))
mock.module('../execHttpHook.js', () => ({
  ...actualHttpModule,
  execHttpHook: execHttpHookSpy,
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../execAgentHook.js', () => ({ ...actualAgentModule }))
  mock.module('../execHttpHook.js', () => ({ ...actualHttpModule }))
})

const { executePermissionRequestHooks } = await import('../../hooks.js')
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')

beforeAll(() => {
  // Interactive-mode trust gate (shouldSkipHookDueToTrust) — session trust
  // latches true for the whole process.
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
  execAgentHookSpy.mockClear()
  execHttpHookSpy.mockClear()
})

function permissionRequestConfig(hook: unknown): HooksSettings {
  return {
    PermissionRequest: [{ matcher: '', hooks: [hook] }],
  } as unknown as HooksSettings
}

function fakeToolUseContext(): ToolUseContext {
  return {
    getAppState: () => ({ sessionHooks: new Map(), messages: [] }),
    abortController: new AbortController(),
    options: {},
  } as unknown as ToolUseContext
}

async function runPermissionRequestHooks(): Promise<any[]> {
  const out: any[] = []
  for await (const item of executePermissionRequestHooks(
    'Bash',
    'tu_test_280',
    { command: 'ls' },
    fakeToolUseContext(),
  )) {
    out.push(item)
  }
  return out
}

function attachmentsOf(results: any[]): any[] {
  return results
    .map(r => r.message?.attachment)
    .filter(a => a !== undefined && a !== null)
}

describe('2.1.280 (#085) — agent-type PermissionRequest hooks no longer run', () => {
  test('agent-type hook is NOT executed and surfaces the byte-exact error as a non-blocking error result', async () => {
    mockedHooksConfig = permissionRequestConfig({
      type: 'agent',
      prompt: 'Decide whether this Bash call is allowed',
    })

    const results = await runPermissionRequestHooks()

    // The agent executor never ran (guard throws before dispatch).
    expect(execAgentHookSpy).not.toHaveBeenCalled()

    const errors = attachmentsOf(results).filter(
      a => a.type === 'hook_non_blocking_error',
    )
    expect(errors).toHaveLength(1)
    // OCC's existing error-result shape wraps the message: catch →
    // stderr `Failed to run: ${errorMessage}`, exitCode 1.
    expect(errors[0].stderr).toBe(`Failed to run: ${EXPECTED_ERROR}`)
    expect(errors[0].exitCode).toBe(1)
    expect(errors[0].hookEvent).toBe('PermissionRequest')

    // No success attachment was produced for the skipped hook.
    expect(
      attachmentsOf(results).some(a => a.type === 'hook_success'),
    ).toBe(false)
  })

  test('command-type PermissionRequest hook is unaffected (still runs, succeeds)', async () => {
    mockedHooksConfig = permissionRequestConfig({
      type: 'command',
      command: `printf '%s' 'ok'`,
    })

    const results = await runPermissionRequestHooks()

    const attachments = attachmentsOf(results)
    expect(attachments.some(a => a.type === 'hook_success')).toBe(true)
    expect(
      attachments.some(
        a =>
          typeof a.stderr === 'string' &&
          a.stderr.includes('agent-type hooks are not supported'),
      ),
    ).toBe(false)
  })

  test('http-type PermissionRequest hook is unaffected (still dispatched to execHttpHook)', async () => {
    mockedHooksConfig = permissionRequestConfig({
      type: 'http',
      url: 'https://hook.invalid/permission-request',
    })

    const results = await runPermissionRequestHooks()

    expect(execHttpHookSpy).toHaveBeenCalledTimes(1)
    const attachments = attachmentsOf(results)
    expect(attachments.some(a => a.type === 'hook_success')).toBe(true)
    expect(
      attachments.some(
        a =>
          typeof a.stderr === 'string' &&
          a.stderr.includes('agent-type hooks are not supported'),
      ),
    ).toBe(false)
  })
})
