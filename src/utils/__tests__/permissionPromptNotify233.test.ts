import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * 2.1.233 alignment (OCC-95): permission-prompt Notification hooks
 * (binary pkc + vPe). If a structured-IO permission prompt goes unanswered
 * for 6 seconds, a Notification hook fires with
 * `Claude needs your permission to use <tool>` / notification type
 * `permission_prompt`; CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS
 * disables it (raw truthy env check — any non-empty value).
 */

// Mock the hook executor BEFORE the module under test loads — mirrors the
// official $V call. permissionPromptNotify.ts imports only this export from
// hooks.js, so the minimal mock is sufficient.
const hookCalls: Array<{
  message: string
  title?: string
  notificationType: string
}> = []

mock.module('../hooks.js', () => ({
  executeNotificationHooks: (data: {
    message: string
    title?: string
    notificationType: string
  }) => {
    hookCalls.push(data)
    return Promise.resolve()
  },
}))

const {
  getToolDisplayName,
  schedulePermissionPromptNotifyHook,
} = await import('../permissionPromptNotify.js')

const ENV_KEY = 'CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS'
const TEST_DELAY_MS = 20
const SETTLE_WAIT_MS = 80
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  hookCalls.length = 0
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
})

afterAll(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
})

describe('2.1.233 — getToolDisplayName (binary vPe)', () => {
  test('leaves camelCase names as-is (regex only uppercases word starts)', () => {
    // \b\w only matches at word boundaries; it uppercases, never lowercases,
    // so interior capitals survive: WebFetch stays WebFetch.
    expect(getToolDisplayName('WebFetch')).toBe('WebFetch')
    expect(getToolDisplayName('Bash')).toBe('Bash')
  })

  test('uses only the last __-separated segment', () => {
    expect(getToolDisplayName('mcp__server__tool_name')).toBe('Tool Name')
    expect(getToolDisplayName('a__b__c')).toBe('C')
  })

  test('turns underscores into spaces and uppercases each word start', () => {
    expect(getToolDisplayName('snake_case_tool')).toBe('Snake Case Tool')
  })

  test('handles empty and camelCase-only names', () => {
    expect(getToolDisplayName('')).toBe('')
    expect(getToolDisplayName('SandboxNetworkAccess')).toBe(
      'SandboxNetworkAccess',
    )
  })
})

describe('2.1.233 — schedulePermissionPromptNotifyHook (binary pkc)', () => {
  test('fires the Notification hook after the delay with the exact payload', async () => {
    const cancel = schedulePermissionPromptNotifyHook(
      getToolDisplayName('WebFetch'),
      TEST_DELAY_MS,
    )
    expect(hookCalls.length).toBe(0) // not before the delay
    await Bun.sleep(SETTLE_WAIT_MS)
    expect(hookCalls).toEqual([
      {
        message: 'Claude needs your permission to use WebFetch',
        notificationType: 'permission_prompt',
      },
    ])
    cancel() // idempotent clearTimeout
  })

  test('the cancel closure stops the hook when the prompt settles early', async () => {
    const cancel = schedulePermissionPromptNotifyHook(
      getToolDisplayName('Bash'),
      TEST_DELAY_MS,
    )
    cancel()
    await Bun.sleep(SETTLE_WAIT_MS)
    expect(hookCalls).toEqual([])
  })

  test('env var disables the hook entirely (no timer, no fire)', async () => {
    process.env[ENV_KEY] = '1'
    const cancel = schedulePermissionPromptNotifyHook(
      getToolDisplayName('Bash'),
      TEST_DELAY_MS,
    )
    await Bun.sleep(SETTLE_WAIT_MS)
    expect(hookCalls).toEqual([])
    expect(cancel()).toBeUndefined() // no-op closure, binary `return()=>{}`
  })

  test('raw truthy gate: even "0" disables (byte-equivalent to if(V.X))', async () => {
    // The binary uses a raw string truthy check, not a bool() parser —
    // ANY non-empty value disables, including "0" and "false".
    for (const value of ['0', 'false']) {
      process.env[ENV_KEY] = value
      const cancel = schedulePermissionPromptNotifyHook(
        getToolDisplayName('Bash'),
        TEST_DELAY_MS,
      )
      await Bun.sleep(SETTLE_WAIT_MS)
      expect(hookCalls).toEqual([])
      cancel()
    }
  })

  test('the hook fires at most once per scheduled prompt', async () => {
    const cancel = schedulePermissionPromptNotifyHook(
      getToolDisplayName('Bash'),
      TEST_DELAY_MS,
    )
    await Bun.sleep(SETTLE_WAIT_MS)
    await Bun.sleep(SETTLE_WAIT_MS)
    expect(hookCalls.length).toBe(1)
    cancel()
  })
})
