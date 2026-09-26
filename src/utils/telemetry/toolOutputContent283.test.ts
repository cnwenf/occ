// Byte-verified pin of the official Claude Code v2.1.283 `oTr` attribute loop
// (@ELF 201186638): per-string LT truncation + `${k}_truncated` /
// `${k}_original_length` annotation markers, ported as
// `buildToolContentAttributes` and wired inside `addToolContentEvent`.
//
// History: this file originally also pinned the 2.1.283 `tool.output`
// expansion (wbo serializer, KEe redaction, HQn/MCP gate, end-to-end
// emission). That cluster collided with the parallel OCC-138 C2 port
// (published on main as fc9dbb6); per the merge resolution (gap doc
// docs/upstream-version-gap-occ98-2026-09.md §10.2) C2's structure won —
// it fixes the live emission ordering (emit BEFORE endToolSpan clears the
// ALS toolContext store) — and its mcpToolOutputOtel283.test.ts (368 lines)
// carries the wbo/rTr/emission pins. The duplicate OCC-98 helpers were
// pruned; only the oTr-loop pin (which addToolContentEvent consumes) stays.

import { describe, expect, test } from 'bun:test'

import { buildToolContentAttributes } from './sessionTracing.js'

// MAX_CONTENT_SIZE in betaSessionTracing.ts is 60 * 1024.
const MAX_CONTENT_SIZE = 60 * 1024

describe('buildToolContentAttributes (official oTr truncation)', () => {
  test('short strings pass through with no truncation markers', () => {
    const out = buildToolContentAttributes({ output: 'small' })
    expect(out).toEqual({ output: 'small' })
    expect('output_truncated' in out).toBe(false)
    expect('output_original_length' in out).toBe(false)
  })

  test('oversized strings are truncated and annotated', () => {
    const big = 'x'.repeat(MAX_CONTENT_SIZE + 500)
    const out = buildToolContentAttributes({ output: big })
    expect(out.output_truncated).toBe(true)
    expect(out.output_original_length).toBe(MAX_CONTENT_SIZE + 500)
    // truncated content is shorter than the original
    expect((out.output as string).length).toBeLessThan(big.length)
  })

  test('non-string values pass through untouched', () => {
    const out = buildToolContentAttributes({ count: 7, flag: true })
    expect(out).toEqual({ count: 7, flag: true })
  })
})
