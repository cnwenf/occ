/**
 * CC 2.1.301 (occ160 WP-C) — the tool_decision OTel event gained:
 *   - `classifier_verdict` + `permission_mode` (always, ungated), so auto-mode
 *     classifier decisions can be told apart from permission-rule decisions
 *     (both surface as source:"config");
 *   - `classifier_category` — the built-in rule a classifier block matched —
 *     ONLY for block verdicts on a built-in category and ONLY when
 *     OTEL_LOG_TOOL_DETAILS is truthy.
 *
 * Byte-verified against the official v2.1.301 linux-x64 ELF (full offsets +
 * recovered code in classifierDecisionTelemetry.ts):
 *   u9e @227797100 / H3n @216936555 / Zfe+xAo @226411221 / Tc @220028587 /
 *   Fl @217201653 / Pfs emit @227800703 (300 Qds @226891992 lacks the fields)
 *   / dispatch-fallback emit @228218908 (300 @227307285 lacks them too; the
 *   fallback additionally gates on `behavior!=="ask"`).
 *
 * Harness mirrors toolDecisionTelemetry288.test.ts (events.js + tracing seams,
 * real runToolUse generator driven with a fake tool/canUseTool) and
 * permissionDenialMisreport.test.ts (direct logPermissionDecision calls with a
 * sandbox-adapter mock).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { z } from 'zod'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill before modules load.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualTracing = await import('../../../utils/telemetry/sessionTracing.js')
const actualTracingExports = { ...actualTracing }
const actualEvents = await import('../../../utils/telemetry/events.js')
const actualEventsExports = { ...actualEvents }

type SpanEnd = { decision?: string; source?: string }
type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const spanEnds: SpanEnd[] = []
const otelCalls: OtelCall[] = []

const TRACING_SPEC = '../../../utils/telemetry/sessionTracing.js'
const EVENTS_SPEC = '../../../utils/telemetry/events.js'
const SANDBOX_SPEC = '../../../utils/sandbox/sandbox-adapter.js'

mock.module(TRACING_SPEC, () => ({
  ...actualTracingExports,
  endToolBlockedOnUserSpan: (decision?: string, source?: string): void => {
    spanEnds.push({ decision, source })
  },
}))

mock.module(EVENTS_SPEC, () => ({
  ...actualEventsExports,
  logOTelEvent: (
    name: string,
    attrs: Record<string, string | undefined> = {},
  ): Promise<void> => {
    otelCalls.push({ name, attrs: { ...attrs } })
    return Promise.resolve()
  },
}))

// permissionLogging's baseMetadata() reads SandboxManager; mock it so tests
// don't read settings or spawn dependency-check shells (misreport pattern).
mock.module(SANDBOX_SPEC, () => ({
  SandboxManager: { isSandboxingEnabled: () => false },
}))

afterAll(() => {
  mock.module(TRACING_SPEC, () => ({ ...actualTracingExports }))
  mock.module(EVENTS_SPEC, () => ({ ...actualEventsExports }))
})

// Units under test — imported AFTER the mocks are registered.
const { logPermissionDecision } = await import('../permissionLogging.js')
const {
  buildClassifierToolDecisionFields,
  permissionModeToExternal,
} = await import('../classifierDecisionTelemetry.js')
type PermissionLogContext = (typeof import('../permissionLogging.js'))['PermissionLogContext']

let runToolUse: (typeof import('../../../services/tools/toolExecution.js'))['runToolUse']
beforeAll(async () => {
  runToolUse = (await import('../../../services/tools/toolExecution.js'))
    .runToolUse
})

import type { AssistantMessage } from 'src/types/message.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { CLASSIFIER_UNAVAILABLE_REASON } from 'src/utils/messages.js'
import type {
  PermissionDecisionReason,
  PermissionMode,
} from 'src/types/permissions.js'

// ---------------------------------------------------------------------------
// Env gate fixture (official Tc — OTEL_LOG_TOOL_DETAILS, boolean-parsed)
// ---------------------------------------------------------------------------

const TOOL_DETAILS_ENV = 'OTEL_LOG_TOOL_DETAILS'
let savedToolDetailsEnv: string | undefined

function enableToolDetails(value = '1'): void {
  process.env[TOOL_DETAILS_ENV] = value
}

function disableToolDetails(): void {
  delete process.env[TOOL_DETAILS_ENV]
}

beforeEach(() => {
  savedToolDetailsEnv = process.env[TOOL_DETAILS_ENV]
  otelCalls.length = 0
  spanEnds.length = 0
})

afterEach(() => {
  if (savedToolDetailsEnv === undefined) {
    delete process.env[TOOL_DETAILS_ENV]
  } else {
    process.env[TOOL_DETAILS_ENV] = savedToolDetailsEnv
  }
})

// ---------------------------------------------------------------------------
// Classifier decisionReason fixtures
// ---------------------------------------------------------------------------

/** Official I3n (@216936040), verbatim — duplicated here on purpose so the test pins the official literal independently of the port. */
const AUTO_MODE_STOPPED_REASON =
  'Auto mode unavailable — stopped after repeated responses with no safety verdict'

function blockReason(category?: string): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'Blocked: this action needs review',
    ...(category !== undefined && { category }),
  }
}

/**
 * The official allow-through-classifier path (`Mt` @~229058944) stamps
 * `classifierAllowed:!0` onto the decisionReason; u9e's accept branch emits
 * classifier_verdict:"allow" only for that stamp. OCC's classifier allow path
 * does not stamp it yet (the stamping site lives in permissions.ts — outside
 * this WP's cluster), so tests supply it structurally, exactly as the official
 * reads it.
 */
function allowReasonWithStamp(): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'ok',
    classifierAllowed: true,
  } as unknown as PermissionDecisionReason
}

function allowReasonWithoutStamp(): PermissionDecisionReason {
  return { type: 'classifier', classifier: 'auto-mode', reason: 'ok' }
}

function unavailableReason(): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: CLASSIFIER_UNAVAILABLE_REASON,
  }
}

function stoppedReason(): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: AUTO_MODE_STOPPED_REASON,
  }
}

function noVerdictReason(): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'classifier overflow — will compact',
    noVerdict: true,
  }
}

// ---------------------------------------------------------------------------
// Section A — pure unit tests: u9e (buildClassifierToolDecisionFields) +
// Fl (permissionModeToExternal)
// ---------------------------------------------------------------------------

describe('CC 2.1.301 u9e — buildClassifierToolDecisionFields', () => {
  test('returns undefined for non-classifier decision reasons', () => {
    // Arrange
    const ruleReason: PermissionDecisionReason = {
      type: 'rule',
      rule: {
        source: 'policySettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      },
    }
    // Act / Assert
    expect(buildClassifierToolDecisionFields('reject', ruleReason)).toBeUndefined()
    expect(buildClassifierToolDecisionFields('reject', undefined)).toBeUndefined()
    expect(buildClassifierToolDecisionFields('accept', undefined)).toBeUndefined()
  })

  test('returns undefined for non-auto-mode classifiers (official gate n.classifier!=="auto-mode")', () => {
    const bashAllow: PermissionDecisionReason = {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: 'Allowed by prompt rule: "npm test"',
    }
    expect(buildClassifierToolDecisionFields('reject', bashAllow)).toBeUndefined()
    expect(buildClassifierToolDecisionFields('accept', bashAllow)).toBeUndefined()
  })

  test('accept + classifierAllowed stamp → {classifier_verdict:"allow"}', () => {
    expect(buildClassifierToolDecisionFields('accept', allowReasonWithStamp())).toEqual(
      { classifier_verdict: 'allow' },
    )
  })

  test('accept WITHOUT the classifierAllowed stamp → undefined (OCC never stamps it yet — dormant branch)', () => {
    expect(
      buildClassifierToolDecisionFields('accept', allowReasonWithoutStamp()),
    ).toBeUndefined()
  })

  test('reject + "Classifier unavailable" reason (official WWe) → unavailable', () => {
    expect(
      buildClassifierToolDecisionFields('reject', unavailableReason()),
    ).toEqual({ classifier_verdict: 'unavailable' })
  })

  test('reject + the official I3n stopped-after-repeated-no-verdict reason → unavailable', () => {
    expect(buildClassifierToolDecisionFields('reject', stoppedReason())).toEqual({
      classifier_verdict: 'unavailable',
    })
  })

  test('reject + noVerdict flag (CC 2.1.288 #65 overflow path) → no_verdict', () => {
    expect(buildClassifierToolDecisionFields('reject', noVerdictReason())).toEqual({
      classifier_verdict: 'no_verdict',
    })
  })

  test('reject block + built-in category + OTEL_LOG_TOOL_DETAILS=1 → verdict AND category', () => {
    enableToolDetails('1')
    expect(
      buildClassifierToolDecisionFields('reject', blockReason('production_deploy')),
    ).toEqual({
      classifier_verdict: 'block',
      classifier_category: 'production_deploy',
    })
  })

  test('reject block + built-in cowork category (Uko) + env truthy → verdict AND category', () => {
    enableToolDetails('true')
    expect(
      buildClassifierToolDecisionFields(
        'reject',
        blockReason('cowork_skill_persistence'),
      ),
    ).toEqual({
      classifier_verdict: 'block',
      classifier_category: 'cowork_skill_persistence',
    })
  })

  test('reject block + built-in category WITHOUT the env gate → verdict only (classifier_category is the ONLY gated field)', () => {
    disableToolDetails()
    expect(
      buildClassifierToolDecisionFields('reject', blockReason('production_deploy')),
    ).toEqual({ classifier_verdict: 'block' })
  })

  test('reject block + built-in category + OTEL_LOG_TOOL_DETAILS=0 → verdict only', () => {
    enableToolDetails('0')
    expect(
      buildClassifierToolDecisionFields('reject', blockReason('data_exfiltration')),
    ).toEqual({ classifier_verdict: 'block' })
  })

  test('reject block + out-of-set category (OCC coarse 2.1.200 taxonomy) → verdict only even with env=1 (official Zfe validates against the built-in 79-set; the coarse categories appear in NEITHER the 300 nor 301 binary)', () => {
    enableToolDetails('1')
    expect(
      buildClassifierToolDecisionFields('reject', blockReason('behavioral_risk')),
    ).toEqual({ classifier_verdict: 'block' })
  })

  test('reject block + no category → verdict only even with env=1', () => {
    enableToolDetails('1')
    expect(buildClassifierToolDecisionFields('reject', blockReason())).toEqual({
      classifier_verdict: 'block',
    })
  })

  test('unavailable/no_verdict verdicts never carry a category even when set + env=1 (official only reads Zfe on the block branch)', () => {
    enableToolDetails('1')
    const withCategory = {
      ...unavailableReason(),
      category: 'production_deploy',
    } as PermissionDecisionReason
    expect(buildClassifierToolDecisionFields('reject', withCategory)).toEqual({
      classifier_verdict: 'unavailable',
    })
  })
})

describe('CC 2.1.301 Fl — permissionModeToExternal', () => {
  test('every user-addressable mode maps to its own external name (official Kl table is identity on `external`)', () => {
    for (const mode of [
      'default',
      'plan',
      'acceptEdits',
      'bypassPermissions',
      'dontAsk',
      'auto',
    ] as PermissionMode[]) {
      expect(permissionModeToExternal(mode)).toBe(mode)
    }
  })

  test("OCC-internal 'bubble' and undefined fall back to 'default' (official Ft(e)=Kl[e]??Kl.default)", () => {
    expect(permissionModeToExternal('bubble')).toBe('default')
    expect(permissionModeToExternal(undefined)).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// Section B — logPermissionDecision (official Pfs emit site @227800703)
// ---------------------------------------------------------------------------

function makeLogCtx(opts?: {
  permissionMode?: PermissionMode
  appStateMode?: PermissionMode
  withGetAppState?: boolean
}): PermissionLogContext {
  const withGetAppState = opts?.withGetAppState ?? true
  const toolUseContext = {
    toolDecisions: new Map<string, unknown>(),
    ...(withGetAppState && {
      getAppState: () => ({
        toolPermissionContext: { mode: opts?.appStateMode ?? 'default' },
      }),
    }),
  } as unknown as ToolUseContext
  return {
    tool: { name: 'Bash' } as PermissionLogContext['tool'],
    input: {},
    toolUseContext,
    messageId: 'msg-301',
    toolUseID: 'tu-301',
    ...(opts?.permissionMode !== undefined && {
      permissionMode: opts.permissionMode,
    }),
  } as PermissionLogContext
}

function toolDecisionEvents(): OtelCall[] {
  return otelCalls.filter(c => c.name === 'tool_decision')
}

describe('CC 2.1.301 Pfs site — logPermissionDecision tool_decision fields', () => {
  test('config accept + stamped classifier reason → classifier_verdict:"allow" + permission_mode from ctx (captured mode)', () => {
    const ctx = makeLogCtx({ permissionMode: 'auto' })
    logPermissionDecision(
      ctx,
      {
        decision: 'accept',
        source: 'config',
        decisionReason: allowReasonWithStamp(),
      },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'accept',
      source: 'config',
      classifier_verdict: 'allow',
      permission_mode: 'auto',
      tool_name: 'Bash',
    })
  })

  test('config accept + modeAtRecheck wins over the ctx-captured mode (official Fl(n.decision==="accept"&&n.modeAtRecheck||H))', () => {
    const ctx = makeLogCtx({ permissionMode: 'default' })
    logPermissionDecision(
      ctx,
      {
        decision: 'accept',
        source: 'config',
        decisionReason: allowReasonWithStamp(),
        modeAtRecheck: 'acceptEdits',
      },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.permission_mode).toBe('acceptEdits')
    expect(events[0].attrs.classifier_verdict).toBe('allow')
  })

  test('config reject + classifier block + env=1 → verdict + category + permission_mode derived from app state when ctx omits it', () => {
    enableToolDetails('1')
    const ctx = makeLogCtx({ appStateMode: 'auto' })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: 'config',
        decisionReason: blockReason('credential_leakage'),
      },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'reject',
      source: 'config',
      classifier_verdict: 'block',
      classifier_category: 'credential_leakage',
      permission_mode: 'auto',
    })
  })

  test('config reject WITHOUT decisionReason (legacy out-of-cluster callers) → no classifier fields, permission_mode still present', () => {
    const ctx = makeLogCtx({ appStateMode: 'plan' })
    logPermissionDecision(
      ctx,
      { decision: 'reject', source: 'config' },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
    expect(events[0].attrs.classifier_category).toBeUndefined()
    expect(events[0].attrs.permission_mode).toBe('plan')
    // Regression: the pre-301 fields are untouched.
    expect(events[0].attrs).toMatchObject({
      decision: 'reject',
      source: 'config',
      tool_name: 'Bash',
    })
  })

  test('non-config source never gets classifier fields even with a classifier reason attached (official be gate V==="config")', () => {
    enableToolDetails('1')
    const ctx = makeLogCtx({ permissionMode: 'auto' })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: { type: 'user_reject', hasFeedback: false },
        decisionReason: blockReason('production_deploy'),
      },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.source).toBe('user_reject')
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
    expect(events[0].attrs.permission_mode).toBe('auto')
  })

  test('classifier SOURCE OBJECT stringifies to "classifier" (not "config") → u9e gate skips the fields', () => {
    enableToolDetails('1')
    const ctx = makeLogCtx({ permissionMode: 'auto' })
    logPermissionDecision(
      ctx,
      {
        decision: 'accept',
        source: { type: 'classifier' },
        decisionReason: allowReasonWithStamp(),
      },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.source).toBe('classifier')
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
    expect(events[0].attrs.permission_mode).toBe('auto')
  })

  test('minimal ctx (no getAppState, no permissionMode) → permission_mode "default", no crash (keeps the misreport-test ctx shape valid; matches the official Ft undefined fallback)', () => {
    const ctx = makeLogCtx({ withGetAppState: false })
    logPermissionDecision(
      ctx,
      { decision: 'reject', source: 'config' },
      undefined,
    )
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.permission_mode).toBe('default')
  })

  test('stored toolDecisions record is unchanged by 301 (source/decision/timestamp only — the official Pfs added nothing to the stored record)', () => {
    const ctx = makeLogCtx({ permissionMode: 'auto' })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: 'config',
        decisionReason: blockReason('production_deploy'),
      },
      undefined,
    )
    const stored = (ctx.toolUseContext.toolDecisions as Map<string, unknown>).get(
      'tu-301',
    ) as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['decision', 'source', 'timestamp'])
    expect(stored.decision).toBe('reject')
    expect(stored.source).toBe('config')
  })
})

// ---------------------------------------------------------------------------
// Section C — runToolUse dispatch fallback (official emit site @228218908;
// 288 harness: real generator, fake tool + fake canUseTool)
// ---------------------------------------------------------------------------

type StoredDecision = {
  source: string
  decision: 'accept' | 'reject' | 'abort'
  timestamp: number
}

function makeFakeTool(name: string): Tool {
  return {
    name,
    inputSchema: z.object({}),
    async call() {
      return { data: { ok: true } }
    },
    mapToolResultToToolResultBlockParam(_data: unknown, toolUseId: string) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: () => name,
  } as unknown as Tool
}

function makeContext(
  tool: Tool,
  mode: PermissionMode = 'default',
  toolDecisions?: Map<string, StoredDecision>,
): ToolUseContext {
  const appState = getDefaultAppState()
  const scopedAppState = {
    ...appState,
    toolPermissionContext: { ...appState.toolPermissionContext, mode },
  }
  return {
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => scopedAppState,
    toolDecisions,
    options: {
      tools: [tool],
      mcpClients: [],
      mainLoopModel: 'claude-opus-5',
      isNonInteractiveSession: true,
    },
  } as unknown as ToolUseContext
}

async function drive(
  ctx: ToolUseContext,
  tool: Tool,
  toolUseID: string,
  canUseTool: (ctx: ToolUseContext) => unknown,
): Promise<void> {
  const toolUse = { type: 'tool_use', id: toolUseID, name: tool.name, input: {} }
  const assistantMessage = {
    uuid: 'a-301-1',
    requestId: undefined,
    message: { id: 'msg_301_1', role: 'assistant', content: [toolUse] },
  } as unknown as AssistantMessage
  const canUseToolFn = (async () => canUseTool(ctx)) as never
  for await (const _update of runToolUse(
    toolUse as never,
    assistantMessage,
    canUseToolFn,
    ctx,
  )) {
    // drain the generator
  }
}

describe('CC 2.1.301 fallback site — headless tool_decision fields', () => {
  test('auto-mode classifier block → reject/config + classifier_verdict:"block" + category under env=1 + permission_mode:"auto"', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_block', () => ({
      behavior: 'deny',
      message: 'blocked by auto mode',
      decisionReason: blockReason('production_deploy'),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'reject',
      source: 'config',
      classifier_verdict: 'block',
      classifier_category: 'production_deploy',
      permission_mode: 'auto',
      tool_name: 'Grep',
    })
  })

  test('same block WITHOUT OTEL_LOG_TOOL_DETAILS → classifier_verdict present, classifier_category absent (verdict is ungated)', async () => {
    disableToolDetails()
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_nogate', () => ({
      behavior: 'deny',
      message: 'blocked by auto mode',
      decisionReason: blockReason('production_deploy'),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.classifier_verdict).toBe('block')
    expect(events[0].attrs.classifier_category).toBeUndefined()
  })

  test('classifier unavailable → classifier_verdict:"unavailable" (never a category, even with env=1)', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_unavail', () => ({
      behavior: 'deny',
      message: 'classifier unavailable — blocked for safety',
      decisionReason: unavailableReason(),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.classifier_verdict).toBe('unavailable')
    expect(events[0].attrs.classifier_category).toBeUndefined()
  })

  test('classifier noVerdict (overflow) → classifier_verdict:"no_verdict"', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_noverdict', () => ({
      behavior: 'deny',
      message: 'overflow — will compact',
      decisionReason: noVerdictReason(),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.classifier_verdict).toBe('no_verdict')
  })

  test('auto-mode allow with the classifierAllowed stamp → accept/config + classifier_verdict:"allow"', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_allow', () => ({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: allowReasonWithStamp(),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'accept',
      source: 'config',
      classifier_verdict: 'allow',
      permission_mode: 'auto',
    })
  })

  test('ask with a classifier reason → reject/config WITHOUT classifier fields (official fallback-only behavior!=="ask" gate)', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'auto')
    await drive(ctx, tool, 'tu_301_ask', () => ({
      behavior: 'ask',
      message: 'needs approval',
      decisionReason: blockReason('production_deploy'),
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.decision).toBe('reject')
    expect(events[0].attrs.source).toBe('config')
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
    expect(events[0].attrs.classifier_category).toBeUndefined()
  })

  test('rule-based config deny → source:"config" with NO classifier_verdict (the changelog distinction: rules stay verdict-less) + permission_mode present', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'acceptEdits')
    await drive(ctx, tool, 'tu_301_rule', () => ({
      behavior: 'deny',
      message: 'denied by policy',
      decisionReason: {
        type: 'rule',
        rule: {
          source: 'policySettings',
          ruleBehavior: 'deny',
          ruleValue: { toolName: 'Grep' },
        },
      },
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'reject',
      source: 'config',
      permission_mode: 'acceptEdits',
    })
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
  })

  test('regression (CC 2.1.288 #31/#32 intact): session-rule allow still emits accept/user_temporary with permission_mode added', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool, 'default')
    await drive(ctx, tool, 'tu_301_reg', () => ({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    expect(spanEnds).toHaveLength(1)
    expect(spanEnds[0]).toEqual({ decision: 'accept', source: 'user_temporary' })
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'accept',
      source: 'user_temporary',
      permission_mode: 'default',
      tool_name: 'Grep',
    })
    expect(events[0].attrs.classifier_verdict).toBeUndefined()
  })

  test('regression: a stored toolDecisions entry still suppresses the fallback emit entirely', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool('Grep')
    const stored: StoredDecision = {
      decision: 'reject',
      source: 'config',
      timestamp: Date.now(),
    }
    const ctx = makeContext(tool, 'auto', new Map([['tu_301_prec', stored]]))
    await drive(ctx, tool, 'tu_301_prec', () => ({
      behavior: 'deny',
      message: 'blocked by auto mode',
      decisionReason: blockReason('production_deploy'),
    }))
    expect(toolDecisionEvents()).toHaveLength(0)
  })
})
