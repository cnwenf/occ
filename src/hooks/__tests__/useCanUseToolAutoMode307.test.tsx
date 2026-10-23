import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import type { AssistantMessage } from '../../types/message.js'
import type { Tool as ToolType, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../useCanUseTool.js'

/**
 * CC 2.1.307 B6 — F-04 regression coverage for the `useCanUseTool` auto-mode
 * denial record / prior-denial lookup / subsequent-approval removal wiring.
 *
 * Before this file the record site had ZERO test coverage: the reviewer's
 * mutation probes (drop the removal side effect, diverge the inputKey, drop
 * the notification-reason truncation) all survived. These tests drive the
 * REAL hook — the actual `useCanUseTool` module is imported and mounted in a
 * real ink render (same discipline as usePasteHandlerDeny291.test.tsx), and
 * the returned callback is invoked with a `forceDecision` so the production
 * record / lookup / removal / truncation / telemetry code runs verbatim. No
 * layer is reimplemented. `forceDecision` only bypasses the permission ENGINE
 * (`hasPermissionsToUseTool`); everything the reviewer flagged as untested is
 * downstream of that bypass and still executes.
 *
 * Official binary evidence (v307 linux-x64 ELF, /tmp/cc-fix-307, re-verified
 * this round via `grep -aboF` + bounded `dd | tr -d '\0'`):
 *   - record gate `_o` @275126117: classifier + auto-mode + !noVerdict, then
 *     `Ao=Be.mcpInfo?void 0:uh.includes(Be.name)?Ke.command:void 0` and
 *     `h({...,...typeof Ao==="string"&&Ao.trim()!==""&&{command:Ao},
 *     inputKey:uee(Be,Ke),reason:xo,...})`.
 *   - truncation `go` @275126396: `if(go.length>80)go=`${re(go,79)}…``
 *     (strictly >80 → first 79 units + …; 80 is left intact). The STORED
 *     reason `xo` is the full text; only the notification reason truncates.
 *   - prior-denial lookup @275125051: `bt.find((Mt)=>Mt.toolName===Be.name&&
 *     Mt.inputKey===xt)` with `xt=uee(Be,Ke)`.
 *   - subsequent approval @275128255: `if(Pt){let Eo=Pt;ro.then((Yo)=>{if(
 *     Yo.behavior==="allow")i("tengu_auto_mode_subsequent_approval",{toolName:
 *     Dn(Be.name),isMcp:Be.isMcp??!1,...,msSinceDeny:Date.now()-Eo.timestamp,
 *     allowReasonType:de(Yo.decisionReason?.type)}),L(Eo)})}`.
 *   - `uee` @275124601: shell-family non-mcp → `_({command:x.command})`,
 *     else `_(x)` (full input JSON). `_` = JSON.stringify.
 */

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

// ---------------------------------------------------------------------------
// Sandbox mock (registered BEFORE the module-under-test import graph resolves).
// logPermissionDecision → baseMetadata → SandboxManager.isSandboxingEnabled()
// would otherwise spawn dependency-check shells. Snapshot/passthrough/restore
// discipline per dangerousRmAutoDenyWindow281.test.ts: bun's mock.module is
// process-global and mock.restore() does not heal already-resolved bindings,
// so the leaked closure delegates to the real impl once the flag is off.
// ---------------------------------------------------------------------------
const actualSandbox = {
  ...(await import('../../utils/sandbox/sandbox-adapter.js')),
}
const actualIsSandboxingEnabled = actualSandbox.SandboxManager.isSandboxingEnabled
let sandboxMockActive = true
mock.module('../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualSandbox,
  SandboxManager: {
    ...actualSandbox.SandboxManager,
    isSandboxingEnabled: () =>
      sandboxMockActive ? false : actualIsSandboxingEnabled(),
  },
}))

// Dynamic imports AFTER mock registration. Relative specifiers resolve to the
// same absolute modules the hook imports (`../utils/autoModeDenials.js`,
// `src/services/analytics/index.js`), so the store instance the hook mutates is
// the one these tests read, and the analytics sink attached here receives the
// hook's logEvent calls (proven by permissionDenialMisreport.test.ts).
const { default: useCanUseTool } = await import('../useCanUseTool.js')
const { render } = await import('../../ink.js')
const {
  _resetDenialsForTesting,
  getAutoModeDenials,
} = await import('../../utils/autoModeDenials.js')
const {
  attachAnalyticsSink,
  _resetForTesting,
} = await import('../../services/analytics/index.js')
type AnalyticsSink = import('../../services/analytics/index.js').AnalyticsSink

type ForceDecision = Parameters<CanUseToolFn>[5]
type RecordedEvent = { eventName: string; metadata: Record<string, unknown> }
type CapturedNotification = {
  key: string
  priority?: string
  jsx?: React.ReactNode
}

// Stable no-op setters: the hook memoizes its callback on these identities, and
// neither the deny nor the forceDecision-allow path invokes them (queue ops and
// persistPermissions are only reached on the interactive 'ask' / user-allow
// paths, which these tests do not drive).
const noopSetQueue = () => {}
const noopSetPermissionContext = () => {}

let box: { current: CanUseToolFn | null }
let notifications: CapturedNotification[]
let recordedEvents: RecordedEvent[]
let unmountInstance: (() => void) | null = null

function Harness({
  callbackBox,
}: {
  callbackBox: { current: CanUseToolFn | null }
}) {
  callbackBox.current = useCanUseTool(noopSetQueue, noopSetPermissionContext)
  return null
}

async function mountHook(): Promise<void> {
  box = { current: null }
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  stdout.on('data', () => {})
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  if (typeof stdin.ref !== 'function') stdin.ref = () => {}
  if (typeof stdin.unref !== 'function') stdin.unref = () => {}

  const instance = await render(<Harness callbackBox={box} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
  })
  unmountInstance = () => instance.unmount()
}

/** Recursively collect the string leaves of a React element tree. */
function collectJsxText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectJsxText)
  if (React.isValidElement(node)) {
    return collectJsxText((node.props as { children?: unknown })?.children)
  }
  return []
}

/** The dim ` · ${reason}` notification segment (not the ` · /permissions` tail). */
function notifReasonSegment(notif: CapturedNotification | undefined): string | undefined {
  return collectJsxText(notif?.jsx).find(
    text => text.startsWith(' · ') && text !== ' · /permissions',
  )
}

function makeBashTool(display = 'rm -rf build'): ToolType {
  return {
    name: 'Bash',
    mcpInfo: undefined,
    isMcp: false,
    userFacingName: () => 'Bash',
    description: async (input: { command?: string }) =>
      display || input?.command || '',
  } as unknown as ToolType
}

function makeMcpTool(): ToolType {
  return {
    name: 'mcp__srv__dangerous',
    mcpInfo: { serverName: 'srv', toolName: 'dangerous' },
    isMcp: true,
    userFacingName: () => 'mcp__srv__dangerous',
    description: async () => 'mcp call',
  } as unknown as ToolType
}

function makeToolUseContext(): ToolUseContext {
  return {
    options: { isNonInteractiveSession: false, tools: [], mcpClients: [] },
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        awaitAutomatedChecksBeforeDialog: false,
      },
    }),
    addNotification: (notif: unknown) => {
      notifications.push(notif as CapturedNotification)
    },
    toolDecisions: new Map(),
    agentId: undefined,
  } as unknown as ToolUseContext
}

const assistantMessage = { message: { id: 'msg_1' } } as unknown as AssistantMessage

function denyByClassifier(
  reason: string,
  opts: { noVerdict?: boolean } = {},
): ForceDecision {
  return {
    behavior: 'deny',
    message: 'denied by auto mode',
    decisionReason: {
      type: 'classifier',
      classifier: 'auto-mode',
      reason,
      ...(opts.noVerdict ? { noVerdict: true } : {}),
    },
  } as unknown as ForceDecision
}

function allowByClassifier(reason: string): ForceDecision {
  return {
    behavior: 'allow',
    userModified: false,
    decisionReason: { type: 'classifier', classifier: 'auto-mode', reason },
  } as unknown as ForceDecision
}

/** Invoke the real hook callback and flush the subsequent-approval microtask. */
async function drive(
  tool: ToolType,
  input: Record<string, unknown>,
  forceDecision: ForceDecision,
  toolUseID = 'tu_1',
): Promise<unknown> {
  expect(box.current).not.toBeNull()
  const decision = await box.current?.(
    tool,
    input,
    makeToolUseContext(),
    assistantMessage,
    toolUseID,
    forceDecision,
  )
  // Flush the `promise.then(...)` subsequent-approval handler + .finally.
  await new Promise(resolve => setTimeout(resolve, 0))
  return decision
}

function subsequentApprovalEvents(): RecordedEvent[] {
  return recordedEvents.filter(
    event => event.eventName === 'tengu_auto_mode_subsequent_approval',
  )
}

beforeEach(async () => {
  _resetDenialsForTesting()
  _resetForTesting()
  notifications = []
  recordedEvents = []
  const sink: AnalyticsSink = {
    logEvent: (eventName, metadata) => {
      recordedEvents.push({ eventName, metadata: { ...metadata } })
    },
    logEventAsync: async (eventName, metadata) => {
      recordedEvents.push({ eventName, metadata: { ...metadata } })
    },
  }
  attachAnalyticsSink(sink)
  await mountHook()
})

afterEach(() => {
  unmountInstance?.()
  unmountInstance = null
  _resetForTesting()
})

afterAll(() => {
  sandboxMockActive = false
  mock.restore()
  _resetForTesting()
})

describe('CC 2.1.307 B6 F-04: useCanUseTool auto-mode denial wiring (real hook)', () => {
  test('an auto-mode classifier deny records a row with command + canonical inputKey', async () => {
    // Act — Bash denied by the auto-mode classifier (no noVerdict).
    await drive(makeBashTool(), { command: 'rm -rf build' }, denyByClassifier('dangerous removal'))

    // Assert — exactly one row, with the shell command and the canonical
    // `{"command":...}` inputKey (official `Ao` + `uee`). Kills a mutation
    // that drops the record side effect or the command/inputKey fields.
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(1)
    expect(denials[0]).toMatchObject({
      toolName: 'Bash',
      command: 'rm -rf build',
      inputKey: '{"command":"rm -rf build"}',
      reason: 'dangerous removal',
      display: 'rm -rf build',
    })
    expect(typeof denials[0]?.timestamp).toBe('number')

    // The immediate notification is posted with the auto-mode-denied key.
    expect(notifications.length).toBe(1)
    expect(notifications[0]?.key).toBe('auto-mode-denied')
  })

  test('replaying an identical denied call then allowing it removes the row and fires tengu_auto_mode_subsequent_approval', async () => {
    // Arrange — first call denied → row recorded.
    const tool = makeBashTool()
    const input = { command: 'rm -rf build' }
    await drive(tool, input, denyByClassifier('dangerous removal'))
    expect(getAutoModeDenials().length).toBe(1)

    // Act — replay the IDENTICAL call, this time allowed. The hook's lookup
    // finds the prior denial (toolName + inputKey) and the subsequent-approval
    // handler removes it + emits telemetry.
    await drive(tool, input, allowByClassifier('user approved'), 'tu_2')

    // Assert — row REMOVED (kills "drop the removal side effect": the store
    // would still hold 1 row).
    expect(getAutoModeDenials().length).toBe(0)

    // Assert — the subsequent-approval event fired with the official shape.
    const events = subsequentApprovalEvents()
    expect(events.length).toBe(1)
    expect(events[0]?.metadata).toMatchObject({
      toolName: 'Bash',
      isMcp: false,
      allowReasonType: 'classifier',
    })
    expect(typeof events[0]?.metadata.msSinceDeny).toBe('number')
  })

  test('inputKey canonicalization: a replay with different non-command fields still matches and removes the prior denial', async () => {
    // Arrange — deny with extra input fields beyond `command`.
    const tool = makeBashTool()
    await drive(
      tool,
      { command: 'rm -rf build', description: 'first', timeout: 30 },
      denyByClassifier('dangerous removal'),
    )
    expect(getAutoModeDenials()[0]?.inputKey).toBe('{"command":"rm -rf build"}')

    // Act — replay the SAME command with DIFFERENT other fields, then allow.
    // Official `uee` keys shell-family non-mcp tools on `{command}` only, so
    // the lookup still matches. Kills "diverge the inputKey" (keying on the
    // full input would miss the prior row → no removal → store keeps 1 row).
    await drive(
      tool,
      { command: 'rm -rf build', description: 'second' },
      allowByClassifier('user approved'),
      'tu_2',
    )

    // Assert
    expect(getAutoModeDenials().length).toBe(0)
    expect(subsequentApprovalEvents().length).toBe(1)
  })

  test('notification reason truncates to 79 chars + … above 80; the stored reason keeps the full text', async () => {
    // Arrange — a 100-char classifier reason.
    const reason = 'x'.repeat(100)

    // Act
    await drive(makeBashTool(), { command: 'rm -rf build' }, denyByClassifier(reason))

    // Assert — the notification segment is the truncated form (79 units + …).
    // Kills "drop the truncation" (the segment would be the full 100 chars).
    expect(notifReasonSegment(notifications[0])).toBe(` · ${'x'.repeat(79)}…`)

    // The STORED denial.reason is the full, untruncated text (official `xo`
    // is stored verbatim; only the display reason `go` truncates).
    expect(getAutoModeDenials()[0]?.reason).toBe(reason)
  })

  test('truncation boundary: an exactly-80-char reason is NOT truncated', async () => {
    // Official `if(go.length>80)` is STRICT: 80 chars stay intact.
    const reason = 'y'.repeat(80)
    await drive(makeBashTool(), { command: 'rm -rf build' }, denyByClassifier(reason))

    expect(notifReasonSegment(notifications[0])).toBe(` · ${reason}`)
    expect(notifReasonSegment(notifications[0])?.endsWith('…')).toBe(false)
  })

  test('truncation boundary: an 81-char reason truncates to 79 + …', async () => {
    // 81 > 80 → first 79 units + … (the 80th/81st chars are dropped).
    const reason = 'z'.repeat(81)
    await drive(makeBashTool(), { command: 'rm -rf build' }, denyByClassifier(reason))

    expect(notifReasonSegment(notifications[0])).toBe(` · ${'z'.repeat(79)}…`)
  })

  test('an mcp tool denial records NO command and keys on the full input JSON', async () => {
    // Act — official `Ao=Be.mcpInfo?void 0:...` and `uee` falls back to the
    // full input for mcp tools (the shell-family branch requires `!h.mcpInfo`).
    await drive(
      makeMcpTool(),
      { someArg: 'x' },
      denyByClassifier('mcp denied'),
    )

    // Assert — no command field; inputKey is the whole input JSON. Kills a
    // mutation that records a command for mcp tools or uses the {command} key.
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(1)
    expect(denials[0]?.command).toBeUndefined()
    expect(denials[0]?.inputKey).toBe('{"someArg":"x"}')
    expect(denials[0]?.toolName).toBe('mcp__srv__dangerous')
  })

  test('a noVerdict classifier denial is NOT recorded and posts no notification', async () => {
    // Act — official gate returns early on `ao.decisionReason.noVerdict`.
    const decision = await drive(
      makeBashTool(),
      { command: 'rm -rf build' },
      denyByClassifier('no verdict yet', { noVerdict: true }),
    )

    // Assert — the deny decision is still returned, but nothing is recorded
    // and no notification posts. Kills a mutation that drops the `!noVerdict`
    // guard (which would record a verdict-less denial).
    expect((decision as { behavior: string }).behavior).toBe('deny')
    expect(getAutoModeDenials().length).toBe(0)
    expect(notifications.length).toBe(0)
  })
})
