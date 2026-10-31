/**
 * CC 2.1.316 (OCC-139): `CLAUDE_CODE_SUBAGENT_EFFORT` env parser.
 *
 * Changelog bullet 4: "Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort
 * level subagents run at when nothing else names one, instead of inheriting
 * the session's."
 *
 * Official v316 parser `XCt` (@278280656, byte-verified):
 *   `function XCt(){let e=i.CLAUDE_CODE_SUBAGENT_EFFORT;return e===void 0?void 0:IH(e)}`
 *
 * `IH` (@278279939, byte-verified) ≡ OCC's `parseEffortCliLevel` (the 2.1.283
 * Gap-139a port of official `fhe` — same trim+lowercase+alias shape):
 *   `function IH(e){let n=e.trim().toLowerCase(),r=ce[n]??n;return yE(r)?r:void 0}`
 *
 * Note the official parser choice: SUBAGENT_EFFORT goes through the CLI-style
 * parser `IH` (string levels only, WITH trim, `med` alias) — NOT the loose env
 * parser `oL`/`rK` (numeric effort, parseInt fallback, NO trim) used by
 * CLAUDE_CODE_EFFORT_LEVEL (`dv` @278280946). So `'5'` is NOT a valid
 * SUBAGENT_EFFORT value and `' xhigh '` IS (trim applies).
 *
 * The value `'inherit'` parses to undefined (it is not an effort level). At
 * the official apply site (`Pxo` @291219542 — see the WorkflowTool
 * subagentEffortEnv316 test) it means "keep inheriting the session effort"
 * and suppresses the unknown_level analytics branch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSubagentEffortEnvDefault } from '../effort.js'

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

describe('CC 2.1.316: getSubagentEffortEnvDefault (official XCt)', () => {
  test('returns undefined when the env var is unset (XCt void 0 arm)', () => {
    expect(getSubagentEffortEnvDefault()).toBeUndefined()
  })

  test.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
  ])('parses the level %s', (raw, expected) => {
    process.env[ENV_VAR] = raw
    expect(getSubagentEffortEnvDefault()).toBe(expected)
  })

  test('applies the med alias (IH → ce map)', () => {
    process.env[ENV_VAR] = 'med'
    expect(getSubagentEffortEnvDefault()).toBe('medium')
  })

  test('trims and lowercases (IH parser, unlike the oL env parser)', () => {
    process.env[ENV_VAR] = '  XHIGH '
    expect(getSubagentEffortEnvDefault()).toBe('xhigh')
  })

  test('rejects numeric effort — IH is string-levels-only (no oL parseInt arm)', () => {
    process.env[ENV_VAR] = '5'
    expect(getSubagentEffortEnvDefault()).toBeUndefined()
  })

  test('rejects unknown values (IH → void 0)', () => {
    process.env[ENV_VAR] = 'turbo'
    expect(getSubagentEffortEnvDefault()).toBeUndefined()
  })

  test("treats 'inherit' as undefined — the session-inheritance sentinel", () => {
    process.env[ENV_VAR] = 'inherit'
    expect(getSubagentEffortEnvDefault()).toBeUndefined()
  })

  test('empty string parses to undefined (IH: "" is not a level)', () => {
    process.env[ENV_VAR] = ''
    expect(getSubagentEffortEnvDefault()).toBeUndefined()
  })
})
