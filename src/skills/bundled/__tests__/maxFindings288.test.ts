import { beforeEach, describe, expect, mock, test } from 'bun:test'
// Type-only import (erased at runtime — does not defeat the mock.module below).
import type { BundledSkillDefinition } from '../../bundledSkills.js'

// Test-isolation guard: `simplify.ts` transitively loads `src/utils/messages.ts`,
// whose module graph reaches the (in-flight, unrelated) `src/utils/sendNowCut.ts`
// mid-evaluation and trips a circular-import TDZ on `INTERRUPT_MESSAGE`. This
// unit test never exercises sendNowCut, so stub it to keep the /code-review
// max-findings logic independently runnable regardless of that module's load
// order. Harmless once the cycle is fixed upstream. NOTE: the mock MUST register
// before the modules below load, so they are pulled in via top-level `await
// import()` (static imports would hoist above `mock.module` and defeat it).
mock.module('../../../utils/sendNowCut.ts', () => ({
  stampSendNowCut: (m: unknown) => m,
  stampSendNowCutSignal: () => {},
  USER_REJECTED_TOOL_USE: 'User rejected tool use',
  INTERRUPT_MESSAGE_PREFIXES: [],
}))

const {
  CODE_REVIEW_MAX_FINDINGS_CAP,
  buildMaxFindingsNotes,
  parseMaxFindingsFlag,
  registerCodeReviewSkill,
  resolveMaxFindings,
} = await import('../simplify.js')
const { clearBundledSkills, getBundledSkills } = await import(
  '../../bundledSkills.js'
)

/**
 * CC 2.1.288 #5 — `--max-findings <n>|all` for /code-review (EXPLICIT-FLAG
 * HALF only). Byte-verified against /tmp/cc-diff-288/v288/package/claude
 * (@216200378 parser `He`, @216201900 resolver `on` + notes `nn`,
 * @216203700 help text).
 *
 * STAGED (not ported here): the cross-session reuse half — official
 * `onUserTypedArgs` skill hook + `codeReviewLastMaxFindings` persistence + the
 * "chose/set last time" notes. `BundledSkillDefinition` has no typed-args hook
 * and OCC has no `codeReviewLast*` key, so `reused` is always false here.
 */

const IGNORED_NOTE =
  '`--max-findings` was ignored: type a whole number above zero, `all`, or `default` after it. Using the usual limit.'
const CAP_NOTE =
  'This review reports at most 32 findings, so the limit is 32 here.'

describe('CC 2.1.288 #5 — parseMaxFindingsFlag', () => {
  test('cap constant is 32 (official We)', () => {
    expect(CODE_REVIEW_MAX_FINDINGS_CAP).toBe(32)
  })

  test('parses a positive integer', () => {
    expect(parseMaxFindingsFlag('high --max-findings 5')).toEqual({
      maxFindings: 5,
      maxFindingsIgnored: false,
      cleanedArgs: 'high',
    })
  })

  test('parses `all` and `default` keywords', () => {
    expect(parseMaxFindingsFlag('--max-findings all').maxFindings).toBe('all')
    expect(parseMaxFindingsFlag('--max-findings default').maxFindings).toBe(
      'default',
    )
  })

  test('parses the `=` form', () => {
    expect(parseMaxFindingsFlag('--max-findings=7').maxFindings).toBe(7)
  })

  test('zero / negative / non-numeric are ignored', () => {
    expect(parseMaxFindingsFlag('--max-findings 0')).toEqual({
      maxFindings: undefined,
      maxFindingsIgnored: true,
      cleanedArgs: '',
    })
    expect(parseMaxFindingsFlag('--max-findings abc').maxFindingsIgnored).toBe(
      true,
    )
    expect(parseMaxFindingsFlag('--max-findings -3').maxFindingsIgnored).toBe(
      true,
    )
  })

  test('bare flag with no value is ignored', () => {
    const r = parseMaxFindingsFlag('--max-findings')
    expect(r.maxFindings).toBeUndefined()
    expect(r.maxFindingsIgnored).toBe(true)
  })

  test('last occurrence wins (official `.at(-1)`)', () => {
    expect(
      parseMaxFindingsFlag('--max-findings 3 --max-findings 9').maxFindings,
    ).toBe(9)
  })

  test('absent flag → undefined, not ignored, args untouched', () => {
    expect(parseMaxFindingsFlag('high --fix')).toEqual({
      maxFindings: undefined,
      maxFindingsIgnored: false,
      cleanedArgs: 'high --fix',
    })
  })

  test('flag is stripped from cleanedArgs so it is not mistaken for a target', () => {
    expect(parseMaxFindingsFlag('--max-findings 12 1234').cleanedArgs.trim()).toBe(
      '1234',
    )
  })
})

describe('CC 2.1.288 #5 — resolveMaxFindings (asked/stated, We=32 clamp)', () => {
  test('`default` clears → asked/stated undefined', () => {
    expect(resolveMaxFindings('default')).toEqual({
      asked: undefined,
      stated: undefined,
    })
  })

  test('absent → asked/stated undefined', () => {
    expect(resolveMaxFindings(undefined)).toEqual({
      asked: undefined,
      stated: undefined,
    })
  })

  test('integer within cap passes through', () => {
    expect(resolveMaxFindings(5)).toEqual({ asked: 5, stated: 5 })
    expect(resolveMaxFindings(32)).toEqual({ asked: 32, stated: 32 })
  })

  test('integer above cap clamps to 32', () => {
    expect(resolveMaxFindings(33)).toEqual({ asked: 33, stated: 32 })
    expect(resolveMaxFindings(1000)).toEqual({ asked: 1000, stated: 32 })
  })

  test('`all` clamps to 32 in the stated value', () => {
    expect(resolveMaxFindings('all')).toEqual({ asked: 'all', stated: 32 })
  })
})

describe('CC 2.1.288 #5 — buildMaxFindingsNotes', () => {
  test('ignored flag → the official ignored note', () => {
    expect(
      buildMaxFindingsNotes({ asked: undefined, stated: undefined, ignored: true }),
    ).toEqual([IGNORED_NOTE])
  })

  test('clamped value → the official cap note', () => {
    expect(
      buildMaxFindingsNotes({ asked: 'all', stated: 32, ignored: false }),
    ).toEqual([CAP_NOTE])
    expect(
      buildMaxFindingsNotes({ asked: 50, stated: 32, ignored: false }),
    ).toEqual([CAP_NOTE])
  })

  test('in-range value → no note', () => {
    expect(
      buildMaxFindingsNotes({ asked: 5, stated: 5, ignored: false }),
    ).toEqual([])
  })

  test('no flag at all → no note', () => {
    expect(
      buildMaxFindingsNotes({ asked: undefined, stated: undefined, ignored: false }),
    ).toEqual([])
  })
})

describe('CC 2.1.288 #5 — /code-review prompt + help wiring', () => {
  beforeEach(() => {
    clearBundledSkills()
    registerCodeReviewSkill()
  })

  function cmd(): BundledSkillDefinition {
    const c = getBundledSkills().find((s) => s.name === 'code-review')
    expect(c).toBeDefined()
    // getBundledSkills() is typed Command[] upstream, but the registered object
    // is a BundledSkillDefinition at runtime — cast to the real shape.
    return c as unknown as BundledSkillDefinition
  }

  async function promptFor(args: string): Promise<string> {
    const blocks = await cmd().getPromptForCommand(args, {} as never)
    return blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
  }

  test('argumentHint documents the flag verbatim', () => {
    expect(cmd().argumentHint).toContain('[--max-findings <n>|all]')
  })

  test('--max-findings <n> threads the cap into the report line', async () => {
    const p = await promptFor('high --max-findings 4')
    expect(p).toContain('cap the report at 4 findings')
  })

  test('--max-findings all clamps to 32 and surfaces the cap note', async () => {
    const p = await promptFor('--max-findings all')
    expect(p).toContain('cap the report at 32 findings')
    expect(p).toContain(CAP_NOTE)
  })

  test('invalid --max-findings surfaces the ignored note and keeps the tier cap', async () => {
    const p = await promptFor('high --max-findings 0')
    expect(p).toContain(IGNORED_NOTE)
    // high tier default cap is 10
    expect(p).toContain('cap the report at 10 findings')
  })

  test('no flag keeps the effort-tier cap (high = 10)', async () => {
    const p = await promptFor('high')
    expect(p).toContain('cap the report at 10 findings')
    expect(p).not.toContain(IGNORED_NOTE)
    expect(p).not.toContain(CAP_NOTE)
  })

  test('--help documents the flag', async () => {
    const p = await promptFor('--help')
    expect(p).toContain('--max-findings')
    expect(p).toContain(
      'Pass --max-findings <n> to report up to n findings, or --max-findings all for every finding.',
    )
  })
})
