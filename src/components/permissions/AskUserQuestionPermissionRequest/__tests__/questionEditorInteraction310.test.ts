import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * v2.1.310 changelog item 6 — AskUserQuestion: closing the external editor
 * now counts as user interaction so the session's interaction clock does not
 * treat the whole editor round-trip as idle time (notify-after-timeout etc.).
 *
 * Official 310 (binary): `let rr=await sK(er);if(Iq(!0),rr.content!==null…`
 * where `sK` = editPromptInEditor and `Iq` = updateLastInteractionTime.
 * Byte evidence: the `if(Iq(!0),` fused-sequence form has 2 hits in the
 * 2.1.310 ELF and 0 in 2.1.309 (see docs/gap-research-310/triage-T1.md).
 *
 * The OCC handler is an inline closure inside a React-Compiler-memoized
 * Ink component (QuestionView), reachable only through the Select
 * ctrl+g keybinding stack, so this is a structural placement test:
 * `updateLastInteractionTime(true)` must fire immediately after the
 * `editPromptInEditor` await resolves and BEFORE the content check —
 * matching the official ordering (interaction is recorded even when the
 * editor was closed with no changes).
 */

const SRC = readFileSync(
  join(import.meta.dir, '..', 'QuestionView.tsx'),
  'utf8',
)

describe('v2.1.310 item 6 — external-editor close records interaction time', () => {
  test('imports updateLastInteractionTime from bootstrap/state', () => {
    expect(SRC).toContain(
      "import { updateLastInteractionTime } from '../../../bootstrap/state.js'",
    )
  })

  test('calls updateLastInteractionTime(true) right after the editor await, before the content check', () => {
    const awaitIdx = SRC.indexOf('await editPromptInEditor(currentValue)')
    expect(awaitIdx).toBeGreaterThan(-1)
    const updateIdx = SRC.indexOf('updateLastInteractionTime(true);', awaitIdx)
    expect(updateIdx).toBeGreaterThan(awaitIdx)
    const contentCheckIdx = SRC.indexOf(
      'if (result.content !== null',
      awaitIdx,
    )
    expect(contentCheckIdx).toBeGreaterThan(updateIdx)
  })
})
