import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { StreamingMarkdown, StreamingPreview } from '../Markdown.js'
import { streamingTextStore } from '../streamingTextStore.js'

/**
 * CC 2.1.314 changelog #24 — "Fixed markdown tables jumping between grid and
 * stacked layouts on half-typed rows while streaming, and long tables falling
 * back to raw pipes."
 *
 * VERDICT: ALREADY-ALIGNED (grounded no-op — characterization test only).
 *
 * Official v314 evidence (byte-verified, 2.1.314 linux-x64 ELF): the fix
 * lives ENTIRELY inside the official streaming chunker `Kgo` @273643200
 * region, which cuts streaming markdown into 4096-char chunks (`Ue=4096`,
 * `Ro=1536`) and re-lexes the tail chunk. v314 adds an `openTable` state
 * (ABSENT from the v312 chunker `Plo` @268885400 region):
 *   ko()={chunks:[],frozenSource:"",gapAfterChunks:!1,stablePrefix:"",
 *     openFence:null,openTable:null,isLinkless:!1}
 *   ni=/^ {0,3}\|[^\n]*\n[ |:\r-]*$/   si=/^ {0,3}\|/   ii=1024   pi=64
 *   let N=f.openTable??"",L=N+g.substring(_),…
 *   let D=B.at(-1),G=D?.type==="table"&&gtn(Y),…X=D?.type==="table"&&!G?D:null;
 *   u=X!==null||D?.type==="paragraph"&&ni.test(D.raw+L.substring(Y.length)),…
 *   K=g[oe+O-1]==="\n"&&X!==null&&X.header.length<=pi?jTr(X.raw):"";
 *   g=$e(f,g,oe+O,!1),f.openTable=K!==""&&K.length<=ii?K:null
 *   tail-hide: if(p&&u){if(R=R.substring(0,R.lastIndexOf("\n")+1),
 *     c&&$t(R.trim(),"\n")<2)R=""}
 * i.e. a chunk cut that lands mid-table loses the header row in the tail
 * chunk; v312 re-lexed the fragment as a raw-pipe paragraph (or a partial
 * table with a different column count → layout flip). v314 freezes completed
 * tables whole and carries `jTr(X.raw)` (the header) into `openTable` so the
 * next chunk re-lexes with the header prepended, and hides the half-typed
 * tail row.
 *
 * OCC has NO counterpart seam: StreamingMarkdown (Markdown.tsx) does no
 * 4096-char chunking — its stablePrefix advances only at BLOCK boundaries
 * (sum of raw lengths of all tokens before the last non-space token) and the
 * unstable suffix is re-lexed WHOLE from the table's first line every delta,
 * so a table token is never cut mid-header and can never degrade to raw
 * pipes or flip column count. StreamingPreview additionally truncates the
 * visible text at the last '\n' (`text.substring(0, text.lastIndexOf('\n')
 * + 1)`), so half-typed rows are never rendered at all. Both changelog
 * symptoms are structurally impossible in OCC — porting the official
 * `openTable` machinery would mean first porting the chunker it patches
 * (which OCC deliberately does not have), i.e. invention, not alignment.
 *
 * This file PINS that immunity so a future refactor that introduces
 * chunk-style cuts cannot silently regress it.
 */

const COLUMNS = 100

function render(node: React.ReactNode): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>,
    COLUMNS,
  )
}

const TABLE = '| Name | Value |\n|-------|-------|\n| alpha | one |\n| beta | two |\n'

/** Prefixes of TABLE cut at each line boundary once the delimiter row is
 * complete (before that, marked has not seen a table yet — that pre-table
 * state is out of scope for the changelog item). */
function lineBoundaryPrefixes(src: string, fromLine: number): string[] {
  const lines = src.split('\n')
  const out: string[] = []
  for (let i = fromLine; i <= lines.length; i++) {
    out.push(lines.slice(0, i).join('\n'))
  }
  return out
}

/** Raw ASCII pipe on any rendered line = the "fell back to raw pipes" bug. */
function hasRawPipeLine(out: string): boolean {
  return out.split('\n').some(line => line.includes('|'))
}

afterEach(() => {
  streamingTextStore.clear()
})

describe('2.1.314 #24 streaming table layout stability (characterization)', () => {
  test('every row-boundary streaming prefix renders the GRID layout, never raw pipes', async () => {
    for (const prefix of lineBoundaryPrefixes(TABLE, 2)) {
      const out = stripAnsi(await render(<StreamingMarkdown>{prefix}</StreamingMarkdown>))
      // grid borders + cell separators present (MarkdownTable renderTableFormat)
      expect(out).toContain('┌')
      expect(out).toContain('│')
      // never the raw-pipe fallback
      expect(hasRawPipeLine(out)).toBe(false)
    }
  })

  test('layout does not jump between grid and stacked across streaming prefixes', async () => {
    // The official bug flipped grid↔stacked as chunk cuts changed the
    // column count of the re-lexed fragment. OCC re-lexes whole: every
    // prefix from the delimiter row onward keeps the SAME grid shape, and
    // the completed rows only ever accumulate.
    const outputs: string[] = []
    for (const prefix of lineBoundaryPrefixes(TABLE, 2)) {
      outputs.push(stripAnsi(await render(<StreamingMarkdown>{prefix}</StreamingMarkdown>)))
    }
    for (const out of outputs) {
      // grid top border present in EVERY prefix = never stacked/vertical
      expect(out).toContain('┌')
    }
    // rows accumulate monotonically — earlier rows never disappear
    expect(outputs[0]).not.toContain('alpha')
    expect(outputs[1]).toContain('alpha')
    expect(outputs[1]).not.toContain('beta')
    expect(outputs[2]).toContain('alpha')
    expect(outputs[2]).toContain('beta')
  })

  test('a LONG table (>4096 chars, the official chunk size) never falls back to raw pipes', async () => {
    const rows: string[] = ['| Key | Payload | Comment |', '|-----|---------|---------|']
    for (let i = 0; i < 120; i++) {
      rows.push(`| row-${i} | payload-value-${i} | some explanatory comment ${i} |`)
    }
    const long = `${rows.join('\n')}\n`
    expect(long.length).toBeGreaterThan(4096)
    const out = stripAnsi(await render(<StreamingMarkdown>{long}</StreamingMarkdown>))
    expect(out).toContain('┌')
    expect(out).toContain('│')
    expect(hasRawPipeLine(out)).toBe(false)
    expect(out).toContain('row-0')
    expect(out).toContain('row-119')
  })

  test('half-typed rows are never rendered by the live StreamingPreview', async () => {
    // StreamingPreview truncates at the last '\n' — the in-progress line
    // ("| gamma | thr") stays invisible until its newline arrives, so the
    // grid can never show a half-typed row (the official needed `ni`/`u`
    // tail-hiding inside its chunker for the same guarantee).
    streamingTextStore.set(`${TABLE}| gamma | thr`)
    const hidden = stripAnsi(
      await render(<StreamingPreview showStreamingText={true} isBriefOnly={false} />),
    )
    expect(hidden).toContain('│')
    expect(hasRawPipeLine(hidden)).toBe(false)
    expect(hidden).not.toContain('gamma')
    expect(hidden).not.toContain('thr')

    streamingTextStore.set(`${TABLE}| gamma | three |\n`)
    const shown = stripAnsi(
      await render(<StreamingPreview showStreamingText={true} isBriefOnly={false} />),
    )
    expect(shown).toContain('gamma')
    expect(shown).toContain('three')
    expect(hasRawPipeLine(shown)).toBe(false)
  })
})
