import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * WP-R (triage-T3.md Item 57) — reactive compaction re-asks ONCE for a
 * missing <summary> block.
 *
 * Official v311 evidence (linux-x64 ELF, /tmp/cc-diff-311/v311/package/claude,
 * byte-verified with grep -aboF + dd):
 *   - Regexes @250550151: `N3e=/<analysis>[\s\S]*?<\/analysis>/`,
 *     `jen=/<summary>([\s\S]*?)<\/summary>/`; `FJ(e){return jen.test(
 *     e.replace(N3e,""))}`; `Mbe(e){return/^[ \t]*<summary>/m.test(
 *     e.replace(N3e,""))}`.
 *   - Reask paragraph Wen @250550486 (template literal starting \n\n,
 *     'For this reply only: …The user did not write it.'; 0 occurrences in
 *     v310).
 *   - Ken reask block @250555900-250556300:
 *     `!FJ(je)&&!Mbe(je)` → if already reask (Se): `{ok:!1,reason:"error",
 *     detail:"no <summary> block in the second reply either",errorKind:
 *     "unknown"}` (@250555990; 0 in v310) → else if `R6s()&&n.toolUseContext
 *     .compactionApiAttemptsLeft?.count!==0`: `t("Reactive compact: the reply
 *     has no <summary> block, asking for the summary once more",{level:
 *     "info"})` (@250556153; 0 in v310) then `Ken(...,!0)` — ONE recursion;
 *     abort during the reask returns `{ok:!1,reason:"aborted"}`; if the gate
 *     is off the raw reply is ACCEPTED (falls through to ok).
 *   - R6s @248136129: `k("tengu_dapper_fountain",!0)` — default true.
 *   - The reask prompt is `content: Se ? Ee+Wen : Ee` — the ORIGINAL compact
 *     prompt plus the paragraph appended, reactive path only (forkLabel
 *     "reactive-compact"); manual /compact is unchanged.
 *
 * OCC mapping: compactionRequestKind==='reactive' (getCompactionKind:
 * isAutoCompact && thresholdSource===undefined) ≡ the official reactive path.
 * The official ok/reason envelope maps to throws from compactConversation;
 * the verbatim second-failure detail is the thrown Error message.
 */

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-reask311-'))
const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

const {
  COMPACT_SUMMARY_REASK_PARAGRAPH,
  REACTIVE_COMPACT_REASK_LOG_MESSAGE,
  REACTIVE_COMPACT_SECOND_REPLY_NO_SUMMARY_DETAIL,
  replyHasSummaryBlock,
  shouldReaskForMissingSummaryBlock,
  reaskForMissingSummaryBlock,
} = await import('../compact.js')

afterAll(() => {
  if (SAVED_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true })
})

// ── Verbatim official strings ───────────────────────────────────────────────

describe('Item 57 verbatim literals (byte-verified v311)', () => {
  test('reask paragraph ≡ Wen @250550486', () => {
    expect(COMPACT_SUMMARY_REASK_PARAGRAPH).toBe(
      '\n\nFor this reply only: write what the instructions above ask for, with the summary inside <summary></summary> tags. Every message before those instructions, the newest one included, is conversation to summarize: do not answer it, and do not do the work that it asks for. What it says on how to summarize still holds. This paragraph is about how to write this summary. The user did not write it.',
    )
  })

  test('reask log line ≡ t(...) @250556153', () => {
    expect(REACTIVE_COMPACT_REASK_LOG_MESSAGE).toBe(
      'Reactive compact: the reply has no <summary> block, asking for the summary once more',
    )
  })

  test('second-failure detail ≡ Ken @250555990', () => {
    expect(REACTIVE_COMPACT_SECOND_REPLY_NO_SUMMARY_DETAIL).toBe(
      'no <summary> block in the second reply either',
    )
  })
})

// ── FJ/Mbe: summary-block detection ─────────────────────────────────────────

describe('replyHasSummaryBlock (official FJ||Mbe after N3e strip)', () => {
  test('detects a closed <summary> block', () => {
    expect(replyHasSummaryBlock('prose\n<summary>the summary</summary>\nrest')).toBe(true)
  })

  test('detects a line-start <summary> without a closing tag (Mbe)', () => {
    expect(replyHasSummaryBlock('prose\n  <summary> unclosed tail')).toBe(true)
    expect(replyHasSummaryBlock('<summary>unclosed')).toBe(true)
  })

  test('rejects a reply with no summary markup', () => {
    expect(replyHasSummaryBlock('Here is the summary you asked for, in prose.')).toBe(false)
    expect(replyHasSummaryBlock('')).toBe(false)
  })

  test('<analysis> content is stripped before the check (N3e)', () => {
    expect(
      replyHasSummaryBlock('<analysis>draft <summary>fake</summary> notes</analysis> plain tail'),
    ).toBe(false)
    expect(
      replyHasSummaryBlock('<analysis>notes</analysis>\n<summary>real</summary>'),
    ).toBe(true)
  })

  test('mid-line inline <summary> without closing tag is not a block start', () => {
    // Mbe anchors at line start ([ \t]* prefix only).
    expect(replyHasSummaryBlock('text before <summary> unclosed')).toBe(false)
  })
})

// ── Reask eligibility gate ──────────────────────────────────────────────────

describe('shouldReaskForMissingSummaryBlock (reactive path only)', () => {
  const base = {
    reply: 'a prose reply with no block',
    compactionRequestKind: 'reactive' as const,
    reaskGateEnabled: true,
    attemptsLeftCount: undefined as number | undefined,
  }

  test('reactive + gate on + missing block → reask', () => {
    expect(shouldReaskForMissingSummaryBlock(base)).toBe(true)
  })

  test('reply already has a summary block → no reask', () => {
    expect(
      shouldReaskForMissingSummaryBlock({ ...base, reply: '<summary>s</summary>' }),
    ).toBe(false)
  })

  test('manual /compact and threshold auto-compact never reask', () => {
    expect(
      shouldReaskForMissingSummaryBlock({ ...base, compactionRequestKind: 'manual' }),
    ).toBe(false)
    expect(
      shouldReaskForMissingSummaryBlock({ ...base, compactionRequestKind: 'auto' }),
    ).toBe(false)
  })

  test('tengu_dapper_fountain gate off → no reask (raw reply accepted)', () => {
    expect(shouldReaskForMissingSummaryBlock({ ...base, reaskGateEnabled: false })).toBe(false)
  })

  test('attempts exhausted (count 0) → no reask (official ?.count!==0)', () => {
    expect(shouldReaskForMissingSummaryBlock({ ...base, attemptsLeftCount: 0 })).toBe(false)
    expect(shouldReaskForMissingSummaryBlock({ ...base, attemptsLeftCount: 1 })).toBe(true)
  })
})

// ── The one-shot reask flow ─────────────────────────────────────────────────

describe('reaskForMissingSummaryBlock (official Ken(...,!0) recursion)', () => {
  test('not eligible → accepts the first reply, never re-asks', async () => {
    let reasks = 0
    const outcome = await reaskForMissingSummaryBlock({
      isReaskEligible: false,
      requestReaskSummary: async () => {
        reasks++
        return '<summary>x</summary>'
      },
      isAborted: () => false,
    })
    expect(outcome).toEqual({ kind: 'accept_first' })
    expect(reasks).toBe(0)
  })

  test('missing block → exactly ONE re-ask with the verbatim log line, second reply accepted', async () => {
    const logs: string[] = []
    let reasks = 0
    const outcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => {
        reasks++
        return 'analysis done\n<summary>the real summary</summary>'
      },
      isAborted: () => false,
      onReaskLog: message => logs.push(message),
    })
    expect(reasks).toBe(1)
    expect(logs).toEqual([REACTIVE_COMPACT_REASK_LOG_MESSAGE])
    expect(outcome).toEqual({
      kind: 'accept_reask',
      reply: 'analysis done\n<summary>the real summary</summary>',
    })
  })

  test('second reply still missing the block → verbatim failure detail', async () => {
    const outcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => 'still just prose, no block',
      isAborted: () => false,
    })
    expect(outcome).toEqual({ kind: 'second_reply_no_block' })
  })

  test('second reply empty → second_reply_empty', async () => {
    const nullOutcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => null,
      isAborted: () => false,
    })
    expect(nullOutcome).toEqual({ kind: 'second_reply_empty' })
    const emptyOutcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => '',
      isAborted: () => false,
    })
    expect(emptyOutcome).toEqual({ kind: 'second_reply_empty' })
  })

  test('second reply is an API error → second_reply_api_error', async () => {
    const outcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => 'API Error: 500 server exploded',
      isAborted: () => false,
    })
    expect(outcome).toEqual({
      kind: 'second_reply_api_error',
      reply: 'API Error: 500 server exploded',
    })
  })

  test('abort during the reask → aborted (honored even with a good reply)', async () => {
    const outcome = await reaskForMissingSummaryBlock({
      isReaskEligible: true,
      requestReaskSummary: async () => '<summary>fine</summary>',
      isAborted: () => true,
    })
    expect(outcome).toEqual({ kind: 'aborted' })
  })
})
