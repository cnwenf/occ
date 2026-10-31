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
 * i.e. the env default is stamped onto the agent definition only when the
 * named per-agent effort parses to nothing.
 *
 * Official guard arms not applicable to OCC (verified vacuous):
 *   - `uE(e)` (@282513324): built-in `web-fetch` agent type — OCC ships no
 *     web-fetch workflow base.
 *   - `w_(t)` (@278930169): scans permissionLayers for a `kind==="effort"`
 *     layer — OCC has no permissionLayers store.
 * The analytics arms `g(...)`/`f(...,"unknown_level")` map to OCC's stubbed
 * logEvent (no-op parity, per the workflow telemetry convention).
 *
 * '' semantics: official `rK('')` returns undefined (loose parser treats
 * undefined/null/'' as unnamed) and OCC's agentDef only carries `effort` when
 * `opts.effort` is truthy — so '' is treated as unnamed here too.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveSubagentEffortEnvDefault } from '../primitives.js'

const ENV_VAR = 'CLAUDE_CODE_SUBAGENT_EFFORT'
const SAVED = process.env[ENV_VAR]

beforeEach(() => {
  delete process.env[ENV_VAR]
})

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = SAVED
  }
})

describe('CC 2.1.316: resolveSubagentEffortEnvDefault (official Pxo, workflow arm)', () => {
  test('a named per-agent effort blocks the env default (Pxo e.effort!==void 0 guard)', () => {
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
