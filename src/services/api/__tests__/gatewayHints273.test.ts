import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { AgentContext } from 'src/utils/agentContext.js'

import {
  AGENT_TYPE_HEADER,
  BUILTIN_AGENT_QUERY_SOURCE_PREFIX,
  COMPACTION_HEADER,
  COMPACTION_REQUEST_GATEWAY_HEADER,
  CONTEXT_COMPACTED_GATEWAY_HEADER,
  CONTEXT_COMPACTED_HEADER,
  MAX_TOOL_DURATION_ENTRIES,
  MAX_TOOL_DURATION_HEADER_BYTES,
  PREV_TOOL_DURATIONS_HEADER,
  REQUEST_CLASS_HEADER,
  applyContextCompactedHeaders,
  applyPrevToolDurationsHeader,
  armPendingContextCompacted,
  buildPrevToolDurationsHeader,
  classifyQuerySource,
  consumePendingContextCompacted,
  forgetPendingContextCompacted,
  getAgentTypeHeader,
  getCompactionKind,
  getRequestClassHeader,
  isGatewayHintHeadersEnabled,
  isFirstPartyAnthropicGateway,
  isMainThreadQuerySource,
  parseTriBool,
  sanitizeHeaderValue,
  sanitizeToolNameForHeader,
  shouldSendContextCompactedHeader,
  toWellFormedString,
} from '../gatewayHints.js'

/**
 * Official 2.1.273 gateway hint headers — unit tests for the byte-verified
 * port in src/services/api/gatewayHints.ts (official symbols in parens).
 *
 * Gate tests avoid module mocking: with no env override the official gate
 * `Tle()` collapses to `fl()` (firstParty && api.anthropic.com) because OCC
 * has no Statsig (default false) — so the no-env expectation is exactly
 * isFirstPartyAnthropicGateway(), whatever the ambient provider config is.
 */

const ENV_KEY = 'CLAUDE_CODE_GATEWAY_HINT_HEADERS'

let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  // Start each test with a clean pending-context-compacted store.
  forgetPendingContextCompacted()
})

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnv
  }
  forgetPendingContextCompacted()
})

function subagentCtx(
  overrides: Partial<AgentContext> = {},
): AgentContext {
  return { agentType: 'subagent', ...overrides } as AgentContext
}

// ---------------------------------------------------------------------------
// Constants (official Lsr/Fsr/$sr/Bsr/Usr/spn/ipn/eCs/tCs/WG)
// ---------------------------------------------------------------------------

describe('2.1.273 gatewayHints constants', () => {
  test('header names match the official binary strings', () => {
    expect(CONTEXT_COMPACTED_GATEWAY_HEADER).toBe('x-cc-context-compacted')
    expect(COMPACTION_REQUEST_GATEWAY_HEADER).toBe('x-cc-compaction-request')
    expect(COMPACTION_HEADER).toBe('x-claude-code-compaction')
    expect(CONTEXT_COMPACTED_HEADER).toBe('x-claude-code-context-compacted')
    expect(PREV_TOOL_DURATIONS_HEADER).toBe(
      'x-claude-code-prev-tool-durations',
    )
    expect(REQUEST_CLASS_HEADER).toBe('x-claude-code-request-class')
    expect(AGENT_TYPE_HEADER).toBe('x-claude-code-agent-type')
  })

  test('limits + prefix match official eCs/tCs/WG', () => {
    expect(MAX_TOOL_DURATION_ENTRIES).toBe(32)
    expect(MAX_TOOL_DURATION_HEADER_BYTES).toBe(4096)
    expect(BUILTIN_AGENT_QUERY_SOURCE_PREFIX).toBe('agent:builtin:')
  })
})

// ---------------------------------------------------------------------------
// parseTriBool (official O.triBool env parse)
// ---------------------------------------------------------------------------

describe('2.1.273 parseTriBool', () => {
  test('truthy strings → true', () => {
    expect(parseTriBool('1')).toBe(true)
    expect(parseTriBool('true')).toBe(true)
    expect(parseTriBool('YES')).toBe(true)
    expect(parseTriBool(' on ')).toBe(true)
    expect(parseTriBool(true)).toBe(true)
  })

  test('defined-falsy strings → false', () => {
    expect(parseTriBool('0')).toBe(false)
    expect(parseTriBool('false')).toBe(false)
    expect(parseTriBool('NO')).toBe(false)
    expect(parseTriBool('off')).toBe(false)
    expect(parseTriBool(false)).toBe(false)
  })

  test('undefined / unrecognized / empty → undefined (fall through)', () => {
    expect(parseTriBool(undefined)).toBeUndefined()
    expect(parseTriBool('')).toBeUndefined()
    expect(parseTriBool('maybe')).toBeUndefined()
    expect(parseTriBool('2')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Gate (official Tle / fl)
// ---------------------------------------------------------------------------

describe('2.1.273 isGatewayHintHeadersEnabled (official Tle)', () => {
  test('env tri-bool overrides everything', () => {
    process.env[ENV_KEY] = '1'
    expect(isGatewayHintHeadersEnabled()).toBe(true)
    process.env[ENV_KEY] = '0'
    expect(isGatewayHintHeadersEnabled()).toBe(false)
  })

  test('unrecognized env value falls through to the provider gate', () => {
    process.env[ENV_KEY] = 'maybe'
    // No Statsig in OCC → Tle() collapses to fl().
    expect(isGatewayHintHeadersEnabled()).toBe(isFirstPartyAnthropicGateway())
  })

  test('no env → equals the first-party-gateway predicate fl()', () => {
    expect(isGatewayHintHeadersEnabled()).toBe(isFirstPartyAnthropicGateway())
  })
})

// ---------------------------------------------------------------------------
// Sanitizers (official Fg / nCs / afn)
// ---------------------------------------------------------------------------

describe('2.1.273 toWellFormedString (official Fg)', () => {
  test('well-formed strings pass through unchanged', () => {
    expect(toWellFormedString('Bash')).toBe('Bash')
    expect(toWellFormedString('héllo 😀')).toBe('héllo 😀')
    expect(toWellFormedString('')).toBe('')
  })

  test('lone surrogates are replaced with U+FFFD', () => {
    expect(toWellFormedString('a\uD800b')).toBe('a�b')
    expect(toWellFormedString('\uDC00')).toBe('�')
    // A well-formed pair is untouched.
    expect(toWellFormedString('😀')).toBe('😀')
  })
})

describe('2.1.273 sanitizeToolNameForHeader (official nCs)', () => {
  test('plain ASCII names pass through', () => {
    expect(sanitizeToolNameForHeader('Bash')).toBe('Bash')
    expect(sanitizeToolNameForHeader('mcp__server__tool')).toBe(
      'mcp__server__tool',
    )
  })

  test('entry separators, % and non-printables are percent-encoded', () => {
    expect(sanitizeToolNameForHeader('a;b')).toBe('a%3Bb')
    expect(sanitizeToolNameForHeader('a=b')).toBe('a%3Db')
    expect(sanitizeToolNameForHeader('a,b')).toBe('a%2Cb')
    expect(sanitizeToolNameForHeader('a b')).toBe('a%20b')
    expect(sanitizeToolNameForHeader('100%')).toBe('100%25')
    expect(sanitizeToolNameForHeader('tab\tname')).toBe('tab%09name')
    expect(sanitizeToolNameForHeader('é')).toBe('%C3%A9')
  })
})

describe('2.1.273 sanitizeHeaderValue (official afn)', () => {
  test('keeps printable ASCII including the tool-entry separators', () => {
    // afn only encodes % and non-\x20-\x7e — ';', '=', ',', ' ' survive
    // (they are legitimate inside the composed header values).
    expect(sanitizeHeaderValue('Bash=12;Read=3')).toBe('Bash=12;Read=3')
    expect(sanitizeHeaderValue('a b,c')).toBe('a b,c')
  })

  test('encodes % and non-printable / non-ASCII', () => {
    expect(sanitizeHeaderValue('50%')).toBe('50%25')
    expect(sanitizeHeaderValue('wf-é')).toBe('wf-%C3%A9')
    expect(sanitizeHeaderValue('nl\n')).toBe('nl%0A')
  })
})

// ---------------------------------------------------------------------------
// buildPrevToolDurationsHeader (official Hsr)
// ---------------------------------------------------------------------------

describe('2.1.273 buildPrevToolDurationsHeader (official Hsr)', () => {
  test('empty entries → undefined', () => {
    expect(buildPrevToolDurationsHeader([])).toBeUndefined()
  })

  test('formats name=ms entries joined by ";"', () => {
    expect(
      buildPrevToolDurationsHeader([
        { toolName: 'Bash', durationMs: 12 },
        { toolName: 'Read', durationMs: 3 },
      ]),
    ).toBe('Bash=12;Read=3')
  })

  test('rounds to integer ms and clamps negatives to 0', () => {
    expect(
      buildPrevToolDurationsHeader([
        { toolName: 'A', durationMs: 12.4 },
        { toolName: 'B', durationMs: 12.6 },
        { toolName: 'C', durationMs: -5 },
      ]),
    ).toBe('A=12;B=13;C=0')
  })

  test('skips non-finite durations', () => {
    expect(
      buildPrevToolDurationsHeader([
        { toolName: 'A', durationMs: Number.NaN },
        { toolName: 'B', durationMs: Number.POSITIVE_INFINITY },
        { toolName: 'C', durationMs: 7 },
      ]),
    ).toBe('C=7')
    expect(
      buildPrevToolDurationsHeader([{ toolName: 'A', durationMs: Number.NaN }]),
    ).toBeUndefined()
  })

  test('caps at 32 entries (official eCs)', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      toolName: `T${i}`,
      durationMs: i,
    }))
    const header = buildPrevToolDurationsHeader(entries)
    expect(header).toBeDefined()
    expect((header as string).split(';')).toHaveLength(
      MAX_TOOL_DURATION_ENTRIES,
    )
    expect((header as string).endsWith('T31=31')).toBe(true)
  })

  test('stops before exceeding 4096 value bytes (official tCs)', () => {
    // Each entry: 200-char sanitized name + '=' + ms → >128 bytes; 40 of them
    // would blow the 4096 cap. The builder must STOP (break), not truncate
    // mid-entry, and keep the total ≤ 4096.
    const name = 'x'.repeat(200)
    const entries = Array.from({ length: 40 }, (_, i) => ({
      toolName: `${name}${i}`,
      durationMs: i,
    }))
    const header = buildPrevToolDurationsHeader(entries)
    expect(header).toBeDefined()
    expect((header as string).length).toBeLessThanOrEqual(
      MAX_TOOL_DURATION_HEADER_BYTES,
    )
    // Adding one more entry would exceed the cap → fewer than 32 entries.
    expect((header as string).split(';').length).toBeLessThan(
      MAX_TOOL_DURATION_ENTRIES,
    )
  })

  test('a single oversized entry → undefined (nothing fits)', () => {
    const header = buildPrevToolDurationsHeader([
      { toolName: 'y'.repeat(MAX_TOOL_DURATION_HEADER_BYTES), durationMs: 1 },
    ])
    expect(header).toBeUndefined()
  })

  test('tool names are sanitized before composing', () => {
    expect(
      buildPrevToolDurationsHeader([
        { toolName: 'My;Tool=x', durationMs: 5 },
      ]),
    ).toBe('My%3BTool%3Dx=5')
  })
})

// ---------------------------------------------------------------------------
// classifyQuerySource / isMainThreadQuerySource / shouldSend (ii / _fe / YF)
// ---------------------------------------------------------------------------

describe('2.1.273 classifyQuerySource (official ii)', () => {
  test('undefined → undefined', () => {
    expect(classifyQuerySource(undefined)).toBeUndefined()
  })

  test('main-thread sources → main', () => {
    expect(classifyQuerySource('repl_main_thread')).toBe('main')
    expect(classifyQuerySource('repl_main_thread:outputStyle:Explanatory')).toBe(
      'main',
    )
    expect(classifyQuerySource('sdk')).toBe('main')
  })

  test('agent sources + hook_agent → subagent', () => {
    expect(classifyQuerySource('agent:builtin:Explore')).toBe('subagent')
    expect(classifyQuerySource('agent:custom')).toBe('subagent')
    expect(classifyQuerySource('agent:default')).toBe('subagent')
    expect(classifyQuerySource('hook_agent')).toBe('subagent')
  })

  test('everything else → auxiliary', () => {
    expect(classifyQuerySource('compact')).toBe('auxiliary')
    expect(classifyQuerySource('session_memory')).toBe('auxiliary')
    expect(classifyQuerySource('workflow')).toBe('auxiliary')
    expect(classifyQuerySource('verify_api_key')).toBe('auxiliary')
  })
})

describe('2.1.273 isMainThreadQuerySource (official _fe)', () => {
  test('undefined counts as main thread', () => {
    expect(isMainThreadQuerySource(undefined)).toBe(true)
  })

  test('main → true; subagent/auxiliary → false', () => {
    expect(isMainThreadQuerySource('repl_main_thread')).toBe(true)
    expect(isMainThreadQuerySource('agent:builtin:x')).toBe(false)
    expect(isMainThreadQuerySource('compact')).toBe(false)
  })
})

describe('2.1.273 shouldSendContextCompactedHeader (official YF, XF≡false)', () => {
  test('main thread without agentId → true', () => {
    expect(shouldSendContextCompactedHeader(undefined, undefined)).toBe(true)
    expect(shouldSendContextCompactedHeader('repl_main_thread', undefined)).toBe(
      true,
    )
  })

  test('any agentId → false', () => {
    expect(shouldSendContextCompactedHeader('repl_main_thread', 'a1')).toBe(
      false,
    )
  })

  test('non-main query source → false', () => {
    expect(shouldSendContextCompactedHeader('agent:builtin:x', undefined)).toBe(
      false,
    )
    expect(shouldSendContextCompactedHeader('compact', undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getRequestClassHeader / getAgentTypeHeader (official MLr / DLr)
// ---------------------------------------------------------------------------

describe('2.1.273 getRequestClassHeader (official MLr)', () => {
  test('undefined source → no header', () => {
    expect(getRequestClassHeader(undefined, undefined)).toBeUndefined()
  })

  test('compact → "compaction" (special-cased before ii)', () => {
    expect(getRequestClassHeader('compact', undefined)).toBe('compaction')
  })

  test('main / auxiliary classes pass through ii', () => {
    expect(getRequestClassHeader('repl_main_thread', undefined)).toBe('main')
    expect(getRequestClassHeader('session_memory', undefined)).toBe('auxiliary')
  })

  test('subagent source + subagent ctx with workflowRunId → "workflow"', () => {
    expect(
      getRequestClassHeader(
        'agent:builtin:wf-scan',
        subagentCtx({ workflowRunId: 'run1' }),
      ),
    ).toBe('workflow')
  })

  test('subagent without workflowRunId (or without ctx) → "subagent"', () => {
    expect(
      getRequestClassHeader('agent:builtin:Explore', subagentCtx()),
    ).toBe('subagent')
    expect(
      getRequestClassHeader('agent:builtin:Explore', undefined),
    ).toBe('subagent')
  })

  test('teammate ctx does not reclass a subagent source without workflowRunId', () => {
    expect(
      getRequestClassHeader('agent:builtin:x', {
        agentType: 'teammate',
      } as never),
    ).toBe('subagent')
  })

  test('OCC workflow querySource stays auxiliary (documented dormancy)', () => {
    // OCC's WorkflowTool passes querySource 'workflow' (pre-existing
    // deviation; the official passes v6() = agent:builtin:*). classify →
    // 'auxiliary', so the workflow class is NOT produced here even with a
    // workflowRunId-carrying context. See docs/upstream-version-gap-occ127.md.
    expect(
      getRequestClassHeader('workflow', subagentCtx({ workflowRunId: 'r' })),
    ).toBe('auxiliary')
  })
})

describe('2.1.273 getAgentTypeHeader (official DLr)', () => {
  test('non-agent sources → no header', () => {
    expect(getAgentTypeHeader(undefined, undefined)).toBeUndefined()
    expect(
      getAgentTypeHeader('repl_main_thread', subagentCtx()),
    ).toBeUndefined()
    expect(getAgentTypeHeader('workflow', subagentCtx())).toBeUndefined()
  })

  test('teammate ctx → "teammate"', () => {
    expect(
      getAgentTypeHeader('agent:builtin:x', {
        agentType: 'teammate',
      } as never),
    ).toBe('teammate')
  })

  test('agent:builtin:<name> → <name>; empty tail → undefined', () => {
    expect(
      getAgentTypeHeader('agent:builtin:Explore', subagentCtx()),
    ).toBe('Explore')
    expect(getAgentTypeHeader('agent:builtin:', subagentCtx())).toBeUndefined()
  })

  test('agent:custom* → "custom"', () => {
    expect(getAgentTypeHeader('agent:custom', subagentCtx())).toBe('custom')
    expect(
      getAgentTypeHeader('agent:custom:my-agent', subagentCtx()),
    ).toBe('custom')
  })

  test('agent:default → undefined (no builtin/custom prefix)', () => {
    expect(getAgentTypeHeader('agent:default', subagentCtx())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getCompactionKind (official gkt)
// ---------------------------------------------------------------------------

describe('2.1.273 getCompactionKind (official gkt)', () => {
  test('manual trigger → "manual" regardless of probe', () => {
    expect(getCompactionKind('manual', undefined)).toBe('manual')
    expect(getCompactionKind('manual', 'req_123')).toBe('manual')
  })

  test('auto trigger + defined probe → "auto"', () => {
    expect(getCompactionKind('auto', 'auto-compact-threshold')).toBe('auto')
    expect(getCompactionKind('auto', 'req_123')).toBe('auto')
  })

  test('auto trigger + undefined probe → "reactive"', () => {
    expect(getCompactionKind('auto', undefined)).toBe('reactive')
  })

  test('only definedness matters — falsy-but-defined probe → "auto"', () => {
    expect(getCompactionKind('auto', '')).toBe('auto')
    expect(getCompactionKind('auto', 0)).toBe('auto')
    expect(getCompactionKind('auto', null)).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// Pending context-compacted store (official I_t / kZn / AZn)
// ---------------------------------------------------------------------------

describe('2.1.273 pending context-compacted store', () => {
  test('consume without arm → undefined', () => {
    expect(consumePendingContextCompacted()).toBeUndefined()
  })

  test('arm then consume returns the kind once (read-and-clear)', () => {
    armPendingContextCompacted('auto')
    expect(consumePendingContextCompacted()).toBe('auto')
    expect(consumePendingContextCompacted()).toBeUndefined()
  })

  test('re-arm overwrites the pending kind', () => {
    armPendingContextCompacted('reactive')
    armPendingContextCompacted('manual')
    expect(consumePendingContextCompacted()).toBe('manual')
  })

  test('forget clears without sending', () => {
    armPendingContextCompacted('auto')
    forgetPendingContextCompacted()
    expect(consumePendingContextCompacted()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Header application (official dar / far)
// ---------------------------------------------------------------------------

describe('2.1.273 applyContextCompactedHeaders (official dar)', () => {
  test('both kinds undefined → headers untouched', () => {
    const headers: Record<string, string> = {}
    applyContextCompactedHeaders(headers, undefined, undefined)
    expect(headers).toEqual({})
  })

  test('gate enabled via env → x-claude-code-* twins set', () => {
    process.env[ENV_KEY] = '1'
    const headers: Record<string, string> = {}
    applyContextCompactedHeaders(headers, 'auto', 'manual')
    expect(headers[CONTEXT_COMPACTED_HEADER]).toBe('auto')
    expect(headers[COMPACTION_HEADER]).toBe('manual')
  })

  test('x-cc-* gateway twins track fl() only', () => {
    process.env[ENV_KEY] = '1'
    const headers: Record<string, string> = {}
    applyContextCompactedHeaders(headers, 'auto', 'reactive')
    const gateway = isFirstPartyAnthropicGateway()
    expect(headers[CONTEXT_COMPACTED_GATEWAY_HEADER] !== undefined).toBe(
      gateway,
    )
    expect(headers[COMPACTION_REQUEST_GATEWAY_HEADER] !== undefined).toBe(
      gateway,
    )
  })

  test('gate disabled via env → only x-cc-* twins (when fl()), never x-claude-code-*', () => {
    process.env[ENV_KEY] = '0'
    const headers: Record<string, string> = {}
    applyContextCompactedHeaders(headers, 'auto', 'manual')
    expect(headers[CONTEXT_COMPACTED_HEADER]).toBeUndefined()
    expect(headers[COMPACTION_HEADER]).toBeUndefined()
    const gateway = isFirstPartyAnthropicGateway()
    expect(headers[CONTEXT_COMPACTED_GATEWAY_HEADER] !== undefined).toBe(
      gateway,
    )
  })

  test('only one kind defined → only its headers set', () => {
    process.env[ENV_KEY] = '1'
    const headers: Record<string, string> = {}
    applyContextCompactedHeaders(headers, undefined, 'auto')
    expect(headers[CONTEXT_COMPACTED_HEADER]).toBeUndefined()
    expect(headers[COMPACTION_HEADER]).toBe('auto')
  })
})

describe('2.1.273 applyPrevToolDurationsHeader (official far)', () => {
  test('undefined value → no header even when gate enabled', () => {
    process.env[ENV_KEY] = '1'
    const headers: Record<string, string> = {}
    applyPrevToolDurationsHeader(headers, undefined)
    expect(headers).toEqual({})
  })

  test('gate enabled → header set verbatim', () => {
    process.env[ENV_KEY] = '1'
    const headers: Record<string, string> = {}
    applyPrevToolDurationsHeader(headers, 'Bash=12;Read=3')
    expect(headers[PREV_TOOL_DURATIONS_HEADER]).toBe('Bash=12;Read=3')
  })

  test('gate disabled → no header', () => {
    process.env[ENV_KEY] = '0'
    const headers: Record<string, string> = {}
    applyPrevToolDurationsHeader(headers, 'Bash=12')
    expect(headers[PREV_TOOL_DURATIONS_HEADER]).toBeUndefined()
  })
})
