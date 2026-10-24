/**
 * CC 2.1.307 A2 — the OTel `claude_code.safety_event` emitter (unit level).
 *
 * Official changelog: "Added the claude_code.safety_event OpenTelemetry event
 * for each tool call a permission rule, auto mode, a safety check, a hook or
 * the sandbox stopped, prompted or sent back".
 *
 * All expectations below are byte-verified against the official v307 linux-x64
 * ELF (/tmp/cc-diff-308/v307/package/claude — never executed; strings-recovered
 * via grep -aboF + bounded dd into /tmp/cc-diff-308/new307.txt):
 *
 *   LMn (@36240106) — emitter + skip gates + attribute set/order
 *   BMn (@36241973) — OTel leg: UMn tool_name override (UMn=[] @36242337 —
 *     dormant), kc()-gated classifier_category, tool_use_id,
 *     String(sandboxViolationCount), String(sandbox_enabled)
 *   CYr (@36239601) — record → category ("user_rejected"/"other"/"sandbox_*"
 *     fallbacks INSIDE the reasonCode!==undefined block)
 *   HMn (@36242349) — reason-code prefix → category
 *   PMn/Xne/EMn (@36235574+) — decisionReason → reason code
 *   I5 (@34256176) / MOn / IOn (@39257818) — rule-source + circuit-breaker
 *   jMn (@36243228) — tool_class; $Mn (@36241792) — tool_name/tool_source
 *   MMn/_Yr/kYr (@36238161 region) — reason_code sanitizer + "hook:tool.check"
 *     exception (i8e="tool.check" @34255560)
 *   FMn/bYr — `FMn(){return k(bYr,!0)}`, bYr="tengu_snoopy_creek" (default ON)
 *   wYr=new Set([Qo,vc]) = {AskUserQuestion @19220928, ExitPlanMode @43677492}
 *
 * Harness mirrors toolDecisionOtelFields302.test.ts: events.js seam mocked so
 * the emitted attribute object is captured verbatim ({...attrs} preserves JS
 * string-key insertion order = OTel wire order); sandbox-adapter mocked so
 * isSandboxingEnabled() is deterministic; growthbook mocked so the
 * tengu_snoopy_creek gate is toggleable.
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

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill before modules load.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const EVENTS_SPEC = '../../../utils/telemetry/events.js'
const SANDBOX_SPEC = '../../../utils/sandbox/sandbox-adapter.js'
const GROWTHBOOK_SPEC = '../../../services/analytics/growthbook.js'

const actualEvents = await import(EVENTS_SPEC)
const actualEventsExports = { ...actualEvents }
const actualGrowthbook = await import(GROWTHBOOK_SPEC)
const actualGrowthbookExports = { ...actualGrowthbook }
// Eager spread copy BEFORE mocking (OCC-97/132): the partial factory used to
// drop every other export (SandboxManager.reset, SandboxPolicyRefusalError, …)
// with NO restore, poisoning every later file in a shared-process run
// (OCC-132 A/B: apparmorUsernsCheck310 +29).
const actualSandbox = await import(SANDBOX_SPEC)
const actualSandboxExports = { ...actualSandbox }

type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []

// Official FMn(){return k(bYr,!0)} — gate default TRUE; toggled per test.
let safetyGateEnabled = true

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

mock.module(SANDBOX_SPEC, () => ({
  ...actualSandboxExports,
  SandboxManager: { isSandboxingEnabled: () => false },
}))

mock.module(GROWTHBOOK_SPEC, () => ({
  ...actualGrowthbookExports,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(
    feature: string,
    defaultValue: T,
  ): T =>
    feature === 'tengu_snoopy_creek'
      ? (safetyGateEnabled as T)
      : actualGrowthbookExports.getFeatureValue_CACHED_MAY_BE_STALE(
          feature,
          defaultValue,
        ),
}))

afterAll(() => {
  mock.module(EVENTS_SPEC, () => ({ ...actualEventsExports }))
  mock.module(GROWTHBOOK_SPEC, () => ({ ...actualGrowthbookExports }))
  // Explicit re-mock restore — mock.restore() alone does NOT undo mock.module
  // overrides (OCC-132 A/B evidence).
  mock.module(SANDBOX_SPEC, () => ({ ...actualSandboxExports }))
})

// Units under test — imported AFTER the mocks are registered.
const {
  SAFETY_CATEGORIES,
  SAFETY_DECISION_SOURCES,
  SAFETY_ATTR_VALUE_RE,
  SAFETY_TOOL_NAME_ALLOWLIST,
  buildSafetyReasonCode,
  deriveSafetyCategory,
  deriveSafetyCategoryFromCode,
  sanitizeSafetyReasonCode,
  deriveToolClass,
  classifyToolName,
  buildSafetyToolName,
  applySafetyToolNameAllowlist,
  logSafetyEvent,
} = await import('../safetyEvent.js')

import type { Tool } from 'src/Tool.js'
import {
  CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
  CLASSIFIER_UNAVAILABLE_REASON,
} from 'src/utils/messages.js'
import type { PermissionDecisionReason } from 'src/types/permissions.js'

// ---------------------------------------------------------------------------
// Env gate fixture (official kc — OTEL_LOG_TOOL_DETAILS, boolean-parsed)
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
  safetyGateEnabled = true
})

afterEach(() => {
  if (savedToolDetailsEnv === undefined) {
    delete process.env[TOOL_DETAILS_ENV]
  } else {
    process.env[TOOL_DETAILS_ENV] = savedToolDetailsEnv
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type SafetyRecord = Parameters<typeof deriveSafetyCategory>[0]

function makeRecord(overrides: Partial<SafetyRecord> = {}): SafetyRecord {
  return { decision: 'reject', source: 'config', ...overrides }
}

function makeTool(opts?: {
  name?: string
  mcpInfo?: { serverName: string; toolName: string }
  isMcp?: boolean
}): Tool {
  return {
    name: opts?.name ?? 'Bash',
    ...(opts?.mcpInfo !== undefined && { mcpInfo: opts.mcpInfo }),
    ...(opts?.isMcp !== undefined && { isMcp: opts.isMcp }),
  } as Tool
}

function ruleReason(
  source: string,
  ruleBehavior: 'allow' | 'deny' | 'ask' = 'deny',
): PermissionDecisionReason {
  return {
    type: 'rule',
    rule: {
      source,
      ruleBehavior,
      ruleValue: { toolName: 'Bash' },
    },
  } as PermissionDecisionReason
}

function classifierBlockReason(category?: string): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'Blocked: this action needs review',
    ...(category !== undefined && { category }),
  }
}

function safetyCalls(): OtelCall[] {
  return otelCalls.filter(c => c.name === 'safety_event')
}

function definedKeys(attrs: Record<string, string | undefined>): string[] {
  return Object.keys(attrs).filter(k => attrs[k] !== undefined)
}

// ---------------------------------------------------------------------------
// Section A — verbatim constants (TYr / EYr / _Yr / UMn)
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — verbatim official constants', () => {
  test('SAFETY_CATEGORIES is the official TYr allowlist, in order', () => {
    expect(SAFETY_CATEGORIES).toEqual([
      'safety_check',
      'managed_policy',
      'permission_rule',
      'static_analysis',
      'hook',
      'auto_mode_block',
      'auto_mode_no_verdict',
      'permission_mode',
      'sandbox_override',
    ])
  })

  test('SAFETY_DECISION_SOURCES is the official EYr list, in order', () => {
    expect(SAFETY_DECISION_SOURCES).toEqual([
      'config',
      'classifier',
      'hook',
      'user_temporary',
      'user_permanent',
      'user_reject',
      'user_abort',
    ])
  })

  test('SAFETY_ATTR_VALUE_RE is the official _Yr regex source', () => {
    expect(SAFETY_ATTR_VALUE_RE.source).toBe('^[A-Za-z][A-Za-z+:-]{0,199}$')
  })

  test('SAFETY_TOOL_NAME_ALLOWLIST is the official UMn — EMPTY in v307 (dormant other_tool override)', () => {
    expect(SAFETY_TOOL_NAME_ALLOWLIST).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Section B — deriveSafetyCategoryFromCode (official HMn) per reason-code family
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — HMn: reason-code prefix → category', () => {
  test('rule family: policySettings → managed_policy; every other rule source → permission_rule', () => {
    expect(deriveSafetyCategoryFromCode('rule:policySettings')).toBe(
      'managed_policy',
    )
    expect(deriveSafetyCategoryFromCode('rule:projectSettings')).toBe(
      'permission_rule',
    )
    expect(deriveSafetyCategoryFromCode('rule:session')).toBe('permission_rule')
  })

  test('mode family → permission_mode', () => {
    expect(deriveSafetyCategoryFromCode('mode:plan')).toBe('permission_mode')
    expect(deriveSafetyCategoryFromCode('mode:bypassPermissions')).toBe(
      'permission_mode',
    )
  })

  test('hook family → hook', () => {
    expect(deriveSafetyCategoryFromCode('hook:PermissionRequest')).toBe('hook')
    expect(deriveSafetyCategoryFromCode('hook:PreToolUse')).toBe('hook')
    expect(deriveSafetyCategoryFromCode('hook:tool.check')).toBe('hook')
  })

  test('classifier family: bare/other → auto_mode_block; :unavailable / :no-verdict suffix → auto_mode_no_verdict', () => {
    expect(deriveSafetyCategoryFromCode('classifier:auto-mode')).toBe(
      'auto_mode_block',
    )
    expect(deriveSafetyCategoryFromCode('classifier:other')).toBe(
      'auto_mode_block',
    )
    expect(
      deriveSafetyCategoryFromCode('classifier:auto-mode:unavailable'),
    ).toBe('auto_mode_no_verdict')
    expect(deriveSafetyCategoryFromCode('classifier:auto-mode:no-verdict')).toBe(
      'auto_mode_no_verdict',
    )
  })

  test('classifierTranscriptTooLong → auto_mode_no_verdict', () => {
    expect(deriveSafetyCategoryFromCode('classifierTranscriptTooLong')).toBe(
      'auto_mode_no_verdict',
    )
  })

  test('safety-check family (safetyCheck/workingDir/outsideReadsBlocked/restrictedMode/noProjectDirectory) → safety_check', () => {
    for (const code of [
      'safetyCheck',
      'workingDir',
      'outsideReadsBlocked',
      'restrictedMode',
      'noProjectDirectory',
    ]) {
      expect(deriveSafetyCategoryFromCode(code)).toBe('safety_check')
    }
  })

  test('sandboxOverride → sandbox_override', () => {
    expect(deriveSafetyCategoryFromCode('sandboxOverride')).toBe(
      'sandbox_override',
    )
  })

  test('bashMiss family uses the official vYr/DMn map verbatim', () => {
    expect(deriveSafetyCategoryFromCode('bashMiss:too-complex')).toBe(
      'static_analysis',
    )
    expect(deriveSafetyCategoryFromCode('bashMiss:cd-git-compound')).toBe(
      'static_analysis',
    )
    expect(deriveSafetyCategoryFromCode('bashMiss:sed-dangerous')).toBe(
      'static_analysis',
    )
    expect(deriveSafetyCategoryFromCode('bashMiss:working-dir')).toBe(
      'safety_check',
    )
    expect(deriveSafetyCategoryFromCode('bashMiss:safety-check')).toBe(
      'safety_check',
    )
    expect(deriveSafetyCategoryFromCode('bashMiss:ask-rule')).toBe(
      'permission_rule',
    )
    // vYr maps these two to undefined (explicit no-category tags).
    expect(deriveSafetyCategoryFromCode('bashMiss:no-rule-match')).toBeUndefined()
    expect(deriveSafetyCategoryFromCode('bashMiss:other-untagged')).toBeUndefined()
    // Unknown bashMiss kinds fall out of the map → undefined.
    expect(deriveSafetyCategoryFromCode('bashMiss:something-new')).toBeUndefined()
  })

  test('subcommands family: first TYr-allowlist-order category among the expanded parts; empty rest → undefined', () => {
    // HMn maps {rule → permission_rule (idx 2), mode → permission_mode (idx 7)}
    // — TYr.find picks permission_rule FIRST (allowlist order, not code order).
    expect(
      deriveSafetyCategoryFromCode('subcommands:mode:plan+rule:session'),
    ).toBe('permission_rule')
    expect(
      deriveSafetyCategoryFromCode('subcommands:hook:PreToolUse+mode:plan'),
    ).toBe('hook')
    expect(deriveSafetyCategoryFromCode('subcommands:')).toBeUndefined()
  })

  test('unknown codes → undefined (HMn default arm)', () => {
    expect(deriveSafetyCategoryFromCode('unknown')).toBeUndefined()
    expect(deriveSafetyCategoryFromCode('readOnlyCommand')).toBeUndefined()
    expect(deriveSafetyCategoryFromCode('asyncAgent')).toBeUndefined()
    expect(deriveSafetyCategoryFromCode('other')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Section C — deriveSafetyCategory (official CYr) over records
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — CYr: record → category', () => {
  test('reasonCode maps through HMn', () => {
    expect(
      deriveSafetyCategory(makeRecord({ reasonCode: 'rule:projectSettings' })),
    ).toBe('permission_rule')
    expect(
      deriveSafetyCategory(makeRecord({ reasonCode: 'mode:acceptEdits' })),
    ).toBe('permission_mode')
  })

  test('permission_rule + ruleSource policySettings upgrades to managed_policy', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'rule:session', ruleSource: 'policySettings' }),
      ),
    ).toBe('managed_policy')
  })

  test('circuitBreaker defined forces safety_check regardless of the code mapping', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({
          reasonCode: 'rule:projectSettings',
          circuitBreaker: 'dangerousRemoval',
        }),
      ),
    ).toBe('safety_check')
  })

  test('unmapped code + reasonType asyncAgent → permission_mode', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'asyncAgent', reasonType: 'asyncAgent' }),
      ),
    ).toBe('permission_mode')
  })

  test('reject + unmapped code + user_reject/user_abort source → user_rejected', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'unknown', source: 'user_reject' }),
      ),
    ).toBe('user_rejected')
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'unknown', source: 'user_abort' }),
      ),
    ).toBe('user_rejected')
  })

  test('reject + unmapped code + non-user source + reasonType present → other', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'unknown', reasonType: 'rule', source: 'config' }),
      ),
    ).toBe('other')
  })

  test('accept + unmapped code → undefined (no reject fallback, no violations)', () => {
    expect(
      deriveSafetyCategory(
        makeRecord({ decision: 'accept', reasonCode: 'readOnlyCommand' }),
      ),
    ).toBeUndefined()
  })

  test('reasonCode undefined skips the WHOLE fallback block → undefined without violations', () => {
    // CYr's user_rejected/other/asyncAgent fallbacks live INSIDE
    // `if(e.reasonCode!==void 0)` — a bare config accept (no record) skips.
    expect(deriveSafetyCategory(makeRecord({ source: 'user_reject' }))).toBeUndefined()
    expect(deriveSafetyCategory(makeRecord())).toBeUndefined()
  })

  test('sandbox violations (dormant in OCC — no violation surface): network → sandbox_network, else sandbox_other', () => {
    expect(
      deriveSafetyCategory(makeRecord(), [{ kind: 'network' }]),
    ).toBe('sandbox_network')
    expect(
      deriveSafetyCategory(makeRecord(), [{ kind: 'write' }]),
    ).toBe('sandbox_other')
    // A mapped reasonCode still wins over violations.
    expect(
      deriveSafetyCategory(
        makeRecord({ reasonCode: 'rule:session' }),
        [{ kind: 'network' }],
      ),
    ).toBe('permission_rule')
  })
})

// ---------------------------------------------------------------------------
// Section D — buildSafetyReasonCode (official PMn/Xne over OCC decisionReason)
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — PMn: decisionReason → reason code', () => {
  test('undefined reason → unknown', () => {
    expect(buildSafetyReasonCode('deny', undefined)).toBe('unknown')
  })

  test('rule → rule:<source>; mode → mode:<mode>', () => {
    expect(buildSafetyReasonCode('deny', ruleReason('projectSettings'))).toBe(
      'rule:projectSettings',
    )
    expect(
      buildSafetyReasonCode('allow', { type: 'mode', mode: 'acceptEdits' }),
    ).toBe('mode:acceptEdits')
  })

  test('hook → hook:<event part when allowlisted, else other>', () => {
    expect(
      buildSafetyReasonCode('deny', {
        type: 'hook',
        hookName: 'PermissionRequest',
      }),
    ).toBe('hook:PermissionRequest')
    expect(
      buildSafetyReasonCode('deny', { type: 'hook', hookName: 'PreToolUse:Bash' }),
    ).toBe('hook:PreToolUse')
    expect(
      buildSafetyReasonCode('deny', { type: 'hook', hookName: 'Weird:x' }),
    ).toBe('hook:other')
    // i8e="tool.check" (@34255560) — in yYr=[...Pd,i8e], and the MMn regex
    // exception exists precisely for this dotted code.
    expect(
      buildSafetyReasonCode('deny', { type: 'hook', hookName: 'tool.check' }),
    ).toBe('hook:tool.check')
  })

  test('classifier → classifier:<auto-mode|other>[:unavailable|:no-verdict] (EMn)', () => {
    expect(buildSafetyReasonCode('deny', classifierBlockReason())).toBe(
      'classifier:auto-mode',
    )
    expect(
      buildSafetyReasonCode('deny', {
        type: 'classifier',
        classifier: 'auto-mode',
        reason: CLASSIFIER_UNAVAILABLE_REASON,
      }),
    ).toBe('classifier:auto-mode:unavailable')
    expect(
      buildSafetyReasonCode('deny', {
        type: 'classifier',
        classifier: 'auto-mode',
        reason: 'x',
        noVerdict: true,
      }),
    ).toBe('classifier:auto-mode:no-verdict')
    // OMn(hYr=["auto-mode"], ...) → non-allowlisted classifiers become "other".
    expect(
      buildSafetyReasonCode('deny', {
        type: 'classifier',
        classifier: 'bash',
        reason: 'blocked',
      }),
    ).toBe('classifier:other')
  })

  test('other → official reason-string constants map to their code names; anything else → other', () => {
    expect(
      buildSafetyReasonCode('allow', {
        type: 'other',
        reason: 'Read-only command is allowed',
      }),
    ).toBe('readOnlyCommand')
    expect(
      buildSafetyReasonCode('allow', {
        type: 'other',
        reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
      }),
    ).toBe('sandboxAutoAllow')
    expect(
      buildSafetyReasonCode('deny', {
        type: 'other',
        reason: CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
      }),
    ).toBe('classifierTranscriptTooLong')
    expect(
      buildSafetyReasonCode('deny', {
        type: 'other',
        reason: 'tool permission request aborted',
      }),
    ).toBe('canUseToolAborted')
    expect(
      buildSafetyReasonCode('deny', { type: 'other', reason: 'Preapproved host' }),
    ).toBe('other')
  })

  test('other + bashMissKind (dormant in OCC — no bashMissKind surface) → bashMiss:<kind>', () => {
    expect(
      buildSafetyReasonCode('deny', {
        type: 'other',
        reason: 'x',
        bashMissKind: 'too-complex',
      } as PermissionDecisionReason),
    ).toBe('bashMiss:too-complex')
  })

  test('safetyCheck → outsideReadsBlocked/noConfigHome for the official strings, else the type name', () => {
    expect(
      buildSafetyReasonCode('deny', {
        type: 'safetyCheck',
        reason: 'dangerous rm',
        classifierApprovable: false,
      }),
    ).toBe('safetyCheck')
    expect(
      buildSafetyReasonCode('deny', {
        type: 'safetyCheck',
        reason: 'permission check needs a config or temp path; the session has none',
        classifierApprovable: false,
      }),
    ).toBe('noConfigHome')
  })

  test('asyncAgent → hookRewrittenInputAsk / noApprovalSurface for the official strings, else asyncAgent', () => {
    expect(
      buildSafetyReasonCode('deny', {
        type: 'asyncAgent',
        reason: 'ask rule on hook-rewritten input',
      }),
    ).toBe('hookRewrittenInputAsk')
    expect(
      buildSafetyReasonCode('deny', {
        type: 'asyncAgent',
        reason:
          'no approval surface in this session; permission request denied automatically',
      }),
    ).toBe('noApprovalSurface')
    expect(
      buildSafetyReasonCode('deny', { type: 'asyncAgent', reason: 'x' }),
    ).toBe('asyncAgent')
  })

  test('permissionPromptTool / sandboxOverride / workingDir → the type name', () => {
    expect(
      buildSafetyReasonCode('ask', {
        type: 'permissionPromptTool',
        permissionPromptToolName: 'p',
        toolResult: {},
      }),
    ).toBe('permissionPromptTool')
    expect(
      buildSafetyReasonCode('allow', {
        type: 'sandboxOverride',
        reason: 'excludedCommand',
      }),
    ).toBe('sandboxOverride')
    expect(
      buildSafetyReasonCode('deny', { type: 'workingDir', reason: 'x' }),
    ).toBe('workingDir')
  })

  test('subcommandResults deny: single shared code passes through; multiple collapse to sorted distinct PREFIXES', () => {
    const single = {
      type: 'subcommandResults',
      reasons: new Map([
        ['rm -rf /', { behavior: 'deny', message: '', decisionReason: ruleReason('session') }],
        ['ls', { behavior: 'allow', message: '' }],
      ]),
    } as unknown as PermissionDecisionReason
    expect(buildSafetyReasonCode('deny', single)).toBe('rule:session')

    const multiple = {
      type: 'subcommandResults',
      reasons: new Map([
        ['rm -rf /', { behavior: 'deny', message: '', decisionReason: ruleReason('session') }],
        ['curl x', { behavior: 'deny', message: '', decisionReason: { type: 'mode', mode: 'plan' } }],
      ]),
    } as unknown as PermissionDecisionReason
    // Non-ask: prefixes (tt(w,":")) sorted + "+"-joined under "subcommands:".
    expect(buildSafetyReasonCode('deny', multiple)).toBe('subcommands:mode+rule')
  })

  test('subcommandResults ask: passthrough counts as ask; multiple keep FULL codes sorted', () => {
    const multiple = {
      type: 'subcommandResults',
      reasons: new Map([
        ['rm -rf /', { behavior: 'ask', message: '', decisionReason: ruleReason('session') }],
        ['curl x', { behavior: 'passthrough', message: '', decisionReason: { type: 'mode', mode: 'plan' } }],
      ]),
    } as unknown as PermissionDecisionReason
    expect(buildSafetyReasonCode('ask', multiple)).toBe(
      'subcommands:mode:plan+rule:session',
    )
  })
})

// ---------------------------------------------------------------------------
// Section E — sanitizeSafetyReasonCode (official MMn + _Yr + kYr)
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — MMn: reason_code attribute sanitizer', () => {
  test('undefined passes through as undefined', () => {
    expect(sanitizeSafetyReasonCode(undefined)).toBeUndefined()
  })

  test('regex-conforming codes are kept verbatim', () => {
    expect(sanitizeSafetyReasonCode('rule:policySettings')).toBe(
      'rule:policySettings',
    )
    expect(sanitizeSafetyReasonCode('subcommands:mode+rule')).toBe(
      'subcommands:mode+rule',
    )
    expect(sanitizeSafetyReasonCode('bashMiss:cd-git-compound')).toBe(
      'bashMiss:cd-git-compound',
    )
  })

  test('the kYr exception keeps hook:tool.check (the dot fails _Yr)', () => {
    expect(SAFETY_ATTR_VALUE_RE.test('hook:tool.check')).toBe(false)
    expect(sanitizeSafetyReasonCode('hook:tool.check')).toBe('hook:tool.check')
  })

  test('values failing _Yr are DROPPED (underscore, dot, leading digit, empty)', () => {
    expect(sanitizeSafetyReasonCode('has_underscore')).toBeUndefined()
    expect(sanitizeSafetyReasonCode('some.dot')).toBeUndefined()
    expect(sanitizeSafetyReasonCode('1leading-digit')).toBeUndefined()
    expect(sanitizeSafetyReasonCode('')).toBeUndefined()
  })

  test('length bound: 200 chars kept, 201 chars dropped ({0,199} after the first char)', () => {
    const ok = `a${'b'.repeat(199)}`
    const tooLong = `a${'b'.repeat(200)}`
    expect(ok).toHaveLength(200)
    expect(sanitizeSafetyReasonCode(ok)).toBe(ok)
    expect(sanitizeSafetyReasonCode(tooLong)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Section F — tool_class (jMn) / tool_name (WCr, $Mn, Gzr/Dn, UMn)
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — jMn tool_class', () => {
  test('mcpInfo or isMcp → mcp', () => {
    expect(
      deriveToolClass(
        makeTool({
          name: 'mcp__slack__read',
          mcpInfo: { serverName: 'slack', toolName: 'read' },
        }),
      ),
    ).toBe('mcp')
    expect(deriveToolClass(makeTool({ name: 'X', isMcp: true }))).toBe('mcp')
  })

  test('AYr={Bash,Monitor} → bash; PowerShell → powershell', () => {
    expect(deriveToolClass(makeTool({ name: 'Bash' }))).toBe('bash')
    expect(deriveToolClass(makeTool({ name: 'Monitor' }))).toBe('bash')
    expect(deriveToolClass(makeTool({ name: 'PowerShell' }))).toBe('powershell')
  })

  test('xYr={Read,Edit,Write,NotebookEdit,Glob,Grep} → file', () => {
    for (const name of ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(deriveToolClass(makeTool({ name }))).toBe('file')
    }
  })

  test('WebFetch/WebSearch → web; everything else → other', () => {
    expect(deriveToolClass(makeTool({ name: 'WebFetch' }))).toBe('web')
    expect(deriveToolClass(makeTool({ name: 'WebSearch' }))).toBe('web')
    expect(deriveToolClass(makeTool({ name: 'AskUserQuestion' }))).toBe('other')
    expect(deriveToolClass(makeTool({ name: 'Task' }))).toBe('other')
  })
})

describe('CC 2.1.307 A2 — WCr tool-name classification', () => {
  test('mcp__ → mcp_tool; skill__ → skill_tool (r8="skill__"); __ → dynamic_tool; else other_tool', () => {
    expect(classifyToolName('mcp__slack__read')).toBe('mcp_tool')
    expect(classifyToolName('skill__foo')).toBe('skill_tool')
    expect(classifyToolName('agent__custom')).toBe('dynamic_tool')
    expect(classifyToolName('Bash')).toBe('other_tool')
  })

  test('UMn allowlist override → other_tool fallback mechanism (dormant: UMn is empty in v307)', () => {
    expect(applySafetyToolNameAllowlist('Bash')).toBe('Bash')
    expect(applySafetyToolNameAllowlist('mcp_tool')).toBe('mcp_tool')
  })
})

describe('CC 2.1.307 A2 — $Mn tool_name resolution', () => {
  test('mcp class → mcp_tool (Gzr→Dn: OCC has no builtinToolsServedByMcp surface, vT→undefined)', () => {
    expect(
      buildSafetyToolName(
        makeTool({
          name: 'mcp__slack__read',
          mcpInfo: { serverName: 'slack', toolName: 'read' },
        }),
        'mcp',
        undefined,
      ),
    ).toBe('mcp_tool')
  })

  test('catalog hit → canonical tool name (sAe find via toolMatchesName)', () => {
    const canonical = makeTool({ name: 'Bash' })
    expect(
      buildSafetyToolName(makeTool({ name: 'Bash' }), 'bash', [canonical]),
    ).toBe('Bash')
  })

  test('catalog miss → WCr classification', () => {
    expect(
      buildSafetyToolName(makeTool({ name: 'mcp__x__y' }), 'other', [
        makeTool({ name: 'Bash' }),
      ]),
    ).toBe('mcp_tool')
    expect(
      buildSafetyToolName(makeTool({ name: 'whatever' }), 'other', [
        makeTool({ name: 'Bash' }),
      ]),
    ).toBe('other_tool')
  })

  test('no catalog surface → the real tool object is the registry entry: plain names canonical, dynamic names classified', () => {
    expect(
      buildSafetyToolName(makeTool({ name: 'Bash' }), 'bash', undefined),
    ).toBe('Bash')
    expect(
      buildSafetyToolName(makeTool({ name: 'mcp__x__y' }), 'other', undefined),
    ).toBe('mcp_tool')
  })
})

// ---------------------------------------------------------------------------
// Section G — logSafetyEvent emit shape (LMn + BMn OTel leg)
// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — logSafetyEvent emit', () => {
  test('rule deny: emits safety_event ONCE with the official attribute set, order, and values', () => {
    const emitted = logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('projectSettings'),
        permissionMode: 'default',
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_307' },
    )
    expect(emitted).toBe(true)
    const calls = safetyCalls()
    expect(calls).toHaveLength(1)
    const attrs = calls[0].attrs
    // Official wire order (LMn attrs → BMn appends), undefined-valued keys
    // dropped by the emitter seam exactly as the official Si drops them.
    expect(definedKeys(attrs)).toEqual([
      'category',
      'decision',
      'decision_source',
      'reason_type',
      'reason_code',
      'rule_source',
      'tool_class',
      'tool_name',
      'tool_source',
      'permission_mode',
      'tool_use_id',
      'sandbox_violation_count',
      'sandbox_enabled',
    ])
    expect(attrs.category).toBe('permission_rule')
    expect(attrs.decision).toBe('reject')
    expect(attrs.decision_source).toBe('config')
    expect(attrs.reason_type).toBe('rule')
    expect(attrs.reason_code).toBe('rule:projectSettings')
    expect(attrs.rule_source).toBe('projectSettings')
    expect(attrs.tool_class).toBe('bash')
    expect(attrs.tool_name).toBe('Bash')
    expect(attrs.tool_source).toBe('builtin')
    expect(attrs.permission_mode).toBe('default')
    expect(attrs.tool_use_id).toBe('tu_307')
    // OCC has no sandbox-violation surface → String(0) (BMn), documented.
    expect(attrs.sandbox_violation_count).toBe('0')
    expect(attrs.sandbox_enabled).toBe('false')
  })

  test('bare config accept (no decisionReason) → NO emit (CYr undefined skip gate)', () => {
    const emitted = logSafetyEvent(
      { decision: 'accept', source: 'config', sourceString: 'config' },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_1' },
    )
    expect(emitted).toBe(false)
    expect(safetyCalls()).toHaveLength(0)
  })

  test('user reject without decisionReason → category user_rejected, reason_code unknown, reason_type suppressed (bU h-flag)', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: { type: 'user_reject', hasFeedback: false },
        sourceString: 'user_reject',
      },
      { tool: makeTool({ name: 'Read' }), toolUseID: 'tu_2' },
    )
    const calls = safetyCalls()
    expect(calls).toHaveLength(1)
    const attrs = calls[0].attrs
    expect(attrs.category).toBe('user_rejected')
    expect(attrs.decision).toBe('reject')
    expect(attrs.decision_source).toBe('user_reject')
    expect(attrs.reason_code).toBe('unknown')
    expect(attrs.reason_type).toBeUndefined()
    expect(attrs.tool_class).toBe('file')
    expect(attrs.tool_name).toBe('Read')
  })

  test('user abort → decision stays RAW reject (not the tool_decision abort label), category user_rejected', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: { type: 'user_abort' },
        sourceString: 'user_abort',
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_3' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.decision).toBe('reject')
    expect(attrs.decision_source).toBe('user_abort')
    expect(attrs.category).toBe('user_rejected')
  })

  test('user permanent accept after a rule ask → accept + permission_rule + grant_scope always', () => {
    logSafetyEvent(
      {
        decision: 'accept',
        source: { type: 'user', permanent: true },
        sourceString: 'user_permanent',
        decisionReason: ruleReason('session', 'ask'),
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_4' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.decision).toBe('accept')
    expect(attrs.decision_source).toBe('user_permanent')
    expect(attrs.category).toBe('permission_rule')
    expect(attrs.reason_code).toBe('rule:session')
    expect(attrs.grant_scope).toBe('always')
    // reason_type suppressed: the user answered the prompt (bU h-flag).
    expect(attrs.reason_type).toBeUndefined()
  })

  test('user temporary accept → grant_scope once', () => {
    logSafetyEvent(
      {
        decision: 'accept',
        source: { type: 'user', permanent: false },
        sourceString: 'user_temporary',
        decisionReason: ruleReason('session', 'ask'),
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_5' },
    )
    expect(safetyCalls()[0].attrs.grant_scope).toBe('once')
  })

  test('hook deny PreToolUse:Bash → category hook + hook_event pre_tool_use', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: { type: 'hook', hookName: 'PreToolUse:Bash' },
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_6' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('hook')
    expect(attrs.reason_code).toBe('hook:PreToolUse')
    expect(attrs.hook_event).toBe('pre_tool_use')
  })

  test('hook deny PermissionRequest → category hook, hook_event absent (official checks includes("hook:PreToolUse"))', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: { type: 'hook' },
        sourceString: 'hook',
        decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_7' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('hook')
    expect(attrs.decision_source).toBe('hook')
    expect(attrs.hook_event).toBeUndefined()
  })

  test('classifier block with builtin category: classifier_category emitted only under OTEL_LOG_TOOL_DETAILS (kc gate)', () => {
    enableToolDetails('1')
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: classifierBlockReason('production_deploy'),
        permissionMode: 'auto',
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_8' },
    )
    let attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('auto_mode_block')
    expect(attrs.reason_code).toBe('classifier:auto-mode')
    expect(attrs.classifier_category).toBe('production_deploy')
    expect(attrs.permission_mode).toBe('auto')

    otelCalls.length = 0
    disableToolDetails()
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: classifierBlockReason('production_deploy'),
        permissionMode: 'auto',
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_8b' },
    )
    attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('auto_mode_block')
    expect(attrs.classifier_category).toBeUndefined()
  })

  test('classifier unavailable → auto_mode_no_verdict', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: {
          type: 'classifier',
          classifier: 'auto-mode',
          reason: CLASSIFIER_UNAVAILABLE_REASON,
        },
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_9' },
    )
    expect(safetyCalls()[0].attrs.category).toBe('auto_mode_no_verdict')
  })

  test('safetyCheck with circuitBreaker → safety_check + circuit_breaker attribute', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: {
          type: 'safetyCheck',
          reason: 'dangerous removal',
          classifierApprovable: false,
          circuitBreaker: 'dangerousRemoval',
        },
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_10' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('safety_check')
    expect(attrs.reason_code).toBe('safetyCheck')
    expect(attrs.circuit_breaker).toBe('dangerousRemoval')
  })

  test('mode deny → permission_mode category', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: { type: 'mode', mode: 'plan' },
        permissionMode: 'plan',
      },
      { tool: makeTool({ name: 'Write' }), toolUseID: 'tu_11' },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.category).toBe('permission_mode')
    expect(attrs.reason_code).toBe('mode:plan')
    expect(attrs.permission_mode).toBe('plan')
  })

  test('mcp tool → tool_class mcp, tool_name mcp_tool, tool_source mcp', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('userSettings'),
      },
      {
        tool: makeTool({
          name: 'mcp__slack__read_channel',
          mcpInfo: { serverName: 'slack', toolName: 'read_channel' },
        }),
        toolUseID: 'tu_12',
      },
    )
    const attrs = safetyCalls()[0].attrs
    expect(attrs.tool_class).toBe('mcp')
    expect(attrs.tool_name).toBe('mcp_tool')
    expect(attrs.tool_source).toBe('mcp')
  })

  test('wYr skip: AskUserQuestion (tool_class other) with a mapped category → NO emit', () => {
    const emitted = logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('session'),
      },
      { tool: makeTool({ name: 'AskUserQuestion' }), toolUseID: 'tu_13' },
    )
    expect(emitted).toBe(false)
    expect(safetyCalls()).toHaveLength(0)
  })

  test('wYr skip: ExitPlanMode → NO emit; a non-wYr other-class tool DOES emit', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('session'),
      },
      { tool: makeTool({ name: 'ExitPlanMode' }), toolUseID: 'tu_14' },
    )
    expect(safetyCalls()).toHaveLength(0)

    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('session'),
      },
      { tool: makeTool({ name: 'Task' }), toolUseID: 'tu_15' },
    )
    expect(safetyCalls()).toHaveLength(1)
    expect(safetyCalls()[0].attrs.tool_class).toBe('other')
    expect(safetyCalls()[0].attrs.tool_name).toBe('Task')
  })

  test('tengu_snoopy_creek gate OFF (FMn false) → NO emit', () => {
    safetyGateEnabled = false
    const emitted = logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'config',
        decisionReason: ruleReason('session'),
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_16' },
    )
    expect(emitted).toBe(false)
    expect(safetyCalls()).toHaveLength(0)
  })

  test('unknown sourceString → decision_source other (EYr.find ?? "other")', () => {
    logSafetyEvent(
      {
        decision: 'reject',
        source: 'config',
        sourceString: 'unknown',
        decisionReason: ruleReason('session'),
      },
      { tool: makeTool({ name: 'Bash' }), toolUseID: 'tu_17' },
    )
    expect(safetyCalls()[0].attrs.decision_source).toBe('other')
  })
})
