/**
 * CC 2.1.316 (OCC-139): `CLAUDE_CODE_SUBAGENT_EFFORT` workflow apply site.
 *
 * Changelog bullet 4: "Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort
 * level subagents run at when nothing else names one, instead of inheriting
 * the session's."
 *
 * Official v316 resolver `Pxo` (@291219542, byte-verified):
 *   `function Pxo(e,t){if(e.effort!==void 0||uE(e)||w_(t)!==void 0)return;
 *     let n=i.CLAUDE_CODE_SUBAGENT_EFFORT;if(n===void 0)return;
 *     let o=XCt();if(o!==void 0)g("subagent_effort_default");
 *     else if(n!=="inherit")f("subagent_effort_default","unknown_level");
 *     return o}`
 *
 * Its SINGLE call site (@297031178, byte-verified — the Workflow tool's
 * agent() harness, NOT the Task/Agent tool):
 *   `at=rK(Te?.effort)??Pxo(ct,Y.permissionLayers),
 *    et=at!==void 0?{...ct,effort:at}:ct`
 * i.e. `Pxo` is consulted ONLY when the named per-agent effort loose-parses
 * to nothing through `rK` (≡ parseEffortEnvValue — levels case-insensitive,
 * 'med' alias, integer pass-through, NO trim; undefined/null/'' are unnamed).
 * OCC-139 review P2-2: the named-effort guard below is that `rK` loose parse
 * — a non-empty UNPARSEABLE named value ('turbo', ' XHIGH ') falls through to
 * the env default exactly like the official `??` chain (the earlier
 * truthiness guard diverged by blocking the env default for those).
 *
 * Official guard arms not applicable to OCC (verified vacuous):
 *   - `e.effort!==void 0` (the base definition's own effort): OCC's workflow
 *     base is GENERAL_PURPOSE_AGENT, which carries no effort field.
 *   - `uE(e)` (@282513324): built-in `web-fetch` agent type — OCC ships no
 *     web-fetch workflow base.
 *   - `w_(t)` (@278930169): scans permissionLayers for a `kind==="effort"`
 *     layer — OCC has no permissionLayers store.
 *
 * Analytics arms (review P3-4 — now asserted, not just claimed): `g(...)` ≡
 * logEvent('subagent_effort_default') on a parsed level; `f(...,"unknown_level")`
 * ≡ logEvent('subagent_effort_default', {reason:'unknown_level'}) on an
 * unparsed non-'inherit' raw value; 'inherit' (case-strict, no trim) fires
 * NOTHING. Harness: the analytics module's OWN testing API —
 * attachAnalyticsSink/_resetForTesting (agentTelemetry.test.ts convention),
 * per the review's "attach a sink" remedy. Deliberately NOT mock.module:
 * bun's module-mock registrations leak to every later-loaded file in a
 * shared-process run (scripts/ci-test.sh root-cause note), and the
 * agentTelemetry sink suite would break; the sink API has no such leak and
 * _resetForTesting() in afterEach leaves zero state behind.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  attachAnalyticsSink,
  _resetForTesting,
  type AnalyticsSink,
} from '../../../services/analytics/index.js'
import { resolveSubagentEffortEnvDefault } from '../primitives.js'

const ENV_VAR = 'CLAUDE_CODE_SUBAGENT_EFFORT'
const SAVED = process.env[ENV_VAR]

const logEventCalls: Array<{ name: string; props?: Record<string, unknown> }> =
  []
const sink: AnalyticsSink = {
  logEvent: (name, props) => {
    logEventCalls.push({ name, props: props as Record<string, unknown> })
  },
  logEventAsync: async (name, props) => {
    logEventCalls.push({ name, props: props as Record<string, unknown> })
  },
}

beforeEach(() => {
  delete process.env[ENV_VAR]
  logEventCalls.length = 0
  // Clear any sink leaked from an earlier file in a shared-process run, then
  // attach OURS (attachAnalyticsSink is idempotent — reset first or a leaked
  // sink would silently take precedence; same trap agentTelemetry documents).
  _resetForTesting()
  attachAnalyticsSink(sink)
})

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = SAVED
  }
  // Leave no sink + no queued events for subsequent files.
  _resetForTesting()
})

describe('CC 2.1.316: resolveSubagentEffortEnvDefault (official Pxo, workflow arm)', () => {
  test('a parseable named per-agent effort blocks the env default (call-site rK ?? short-circuit)', () => {
    process.env[ENV_VAR] = 'xhigh'
    expect(resolveSubagentEffortEnvDefault('high')).toBeUndefined()
    expect(resolveSubagentEffortEnvDefault('low')).toBeUndefined()
  })

  test("empty-string named effort counts as unnamed (rK('')→undefined)", () => {
    process.env[ENV_VAR] = 'xhigh'
    expect(resolveSubagentEffortEnvDefault('')).toBe('xhigh')
  })

  test('returns undefined when the env var is unset (Pxo n===void 0 arm)', () => {
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })

  test('parses a valid env level (Pxo → XCt arm, subagent_effort_default event)', () => {
    process.env[ENV_VAR] = 'xhigh'
    expect(resolveSubagentEffortEnvDefault(undefined)).toBe('xhigh')
  })

  test('applies trim + the med alias through XCt/IH', () => {
    process.env[ENV_VAR] = '  MED '
    expect(resolveSubagentEffortEnvDefault(undefined)).toBe('medium')
  })

  test('garbage env value returns undefined (Pxo unknown_level arm)', () => {
    process.env[ENV_VAR] = 'turbo'
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })

  test('numeric env value returns undefined (XCt uses IH, not the loose rK parser)', () => {
    process.env[ENV_VAR] = '5'
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })

  test("'inherit' keeps session inheritance — undefined with no unknown_level event", () => {
    process.env[ENV_VAR] = 'inherit'
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })

  test("'inherit' match is case-strict (official n!==\"inherit\"); still undefined", () => {
    process.env[ENV_VAR] = 'INHERIT'
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })

  test('env set but empty returns undefined (XCt: IH("") is not a level)', () => {
    process.env[ENV_VAR] = ''
    expect(resolveSubagentEffortEnvDefault(undefined)).toBeUndefined()
  })
})

describe('CC 2.1.316 (OCC-139 review P2-2): named-effort guard is the rK loose parse, not truthiness', () => {
  test("unparseable non-empty named value falls through to the env default (official at=rK(Te?.effort)??Pxo(...))", () => {
    process.env[ENV_VAR] = 'xhigh'
    expect(resolveSubagentEffortEnvDefault('turbo')).toBe('xhigh')
    expect(resolveSubagentEffortEnvDefault('HIGH!')).toBe('xhigh')
  })

  test("named rK parse does NOT trim (oL/rK has no trim): ' XHIGH ' is unparseable and falls to env", () => {
    process.env[ENV_VAR] = 'high'
    expect(resolveSubagentEffortEnvDefault(' XHIGH ')).toBe('high')
  })

  test("parseable named values still block the env default ('med' alias + integer pass-through)", () => {
    process.env[ENV_VAR] = 'xhigh'
    expect(resolveSubagentEffortEnvDefault('med')).toBeUndefined()
    expect(resolveSubagentEffortEnvDefault('5')).toBeUndefined()
    expect(resolveSubagentEffortEnvDefault('XHIGH')).toBeUndefined()
  })
})

describe('CC 2.1.316 (OCC-139 review P3-4): Pxo analytics arms fire exactly as the official', () => {
  test('parsed env level → exactly one subagent_effort_default success event, no unknown_level', () => {
    process.env[ENV_VAR] = 'xhigh'
    resolveSubagentEffortEnvDefault(undefined)
    expect(logEventCalls).toEqual([
      { name: 'subagent_effort_default', props: undefined },
    ])
  })

  test('garbage env value → exactly one unknown_level event', () => {
    process.env[ENV_VAR] = 'turbo'
    resolveSubagentEffortEnvDefault(undefined)
    expect(logEventCalls).toEqual([
      { name: 'subagent_effort_default', props: { reason: 'unknown_level' } },
    ])
  })

  test("'inherit' → NO event (official n!==\"inherit\" suppresses unknown_level)", () => {
    process.env[ENV_VAR] = 'inherit'
    resolveSubagentEffortEnvDefault(undefined)
    expect(logEventCalls).toEqual([])
  })

  test("' inherit ' (untrimmed/upper) → unknown_level fires — the n!==\"inherit\" comparison is case-strict with no trim", () => {
    process.env[ENV_VAR] = ' inherit '
    resolveSubagentEffortEnvDefault(undefined)
    expect(logEventCalls).toEqual([
      { name: 'subagent_effort_default', props: { reason: 'unknown_level' } },
    ])
  })

  test('env unset → NO event (n===void 0 early return)', () => {
    resolveSubagentEffortEnvDefault(undefined)
    expect(logEventCalls).toEqual([])
  })

  test('named effort blocks → NO event (resolver short-circuits before reading env)', () => {
    process.env[ENV_VAR] = 'turbo'
    resolveSubagentEffortEnvDefault('high')
    expect(logEventCalls).toEqual([])
  })
})
