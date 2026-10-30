import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider, getDefaultAppState } from '../../../state/AppState.js'
import type { CollapsedReadSearchGroup } from '../../../types/message.js'
import type { buildMessageLookups } from '../../../utils/messages.js'
import { renderToStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'
import { CollapsedReadSearchContent } from '../CollapsedReadSearchContent.js'

/**
 * CC 2.1.314 changelog #48 — "Fixed a blank line appearing above some `⎿`
 * rows in the transcript view (Ctrl+O)."
 *
 * Official v314 evidence (byte-verified, 2.1.314 linux-x64 ELF):
 *   - relevantMemories rows @277872944 (v314):
 *       d.relevantMemories?.map((tT,zW)=>r(s,{flexDirection:"column",
 *         marginTop:zW>0?1:0,children:[r(n,{dimColor:!0,children:[
 *         e(n,{"aria-hidden":!0,children:"  ⎿  "}),"Recalled ",
 *         hx(tT.path),…
 *     v312 counterpart @274973531:
 *       d.relevantMemories?.map((sh)=>r(s,{flexDirection:"column",
 *         marginTop:1,children:[…  "Recalled ",ik(sh.path) …
 *     — the margin was UNCONDITIONAL `marginTop:1` (the blank line above
 *     the FIRST `⎿ Recalled` row); v314 gates it on the row index.
 *   - Second delta (ended-tool wrapper @~277872300): v312 wrapped each
 *     ended tool row in `e(s,{marginTop:1,children:hn},`ended-${Na.id}`)`;
 *     v314 dropped the margin: `e(s,{children:Dn},`ended-${ti.id}`)`.
 *     OCC has NO counterpart — OCC merges in-progress/ended tool rows into
 *     VerboseToolUse, whose official counterpart (`Xg`, root
 *     `marginTop:V` with `V=Ge?1:0`) is UNCHANGED v312→v314, so OCC's
 *     VerboseToolUse root margin stays as-is.
 *
 * OCC seam: CollapsedReadSearchContent.tsx verbose branch, the
 * `message.relevantMemories?.map` rows — same unconditional `marginTop={1}`
 * as official v312; the fix is the same index gate (`zW>0?1:0`).
 */

const COLUMNS = 100

function fixtureMessage(): CollapsedReadSearchGroup {
  return {
    type: 'collapsed_read_search',
    uuid: 'test-uuid',
    searchCount: 0,
    readCount: 0,
    listCount: 0,
    replCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    readFilePaths: [],
    searchArgs: [],
    messages: [],
    displayMessage: undefined,
    relevantMemories: [
      { path: '/mem/alpha.md', content: 'mem-alpha', mtimeMs: 0 },
      { path: '/mem/beta.md', content: 'mem-beta', mtimeMs: 0 },
    ],
  } as unknown as CollapsedReadSearchGroup
}

function fixtureLookups(): ReturnType<typeof buildMessageLookups> {
  return {
    erroredToolUseIDs: new Set<string>(),
    resolvedToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map(),
    progressMessagesByToolUseID: new Map(),
  } as unknown as ReturnType<typeof buildMessageLookups>
}

function renderVerbose(): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>
      <CollapsedReadSearchContent
        message={fixtureMessage()}
        inProgressToolUseIDs={new Set()}
        shouldAnimate={false}
        verbose={true}
        tools={[]}
        lookups={fixtureLookups()}
      />
    </AppStateProvider>,
    COLUMNS,
  )
}

describe('2.1.314 #48 relevantMemories ⎿ Recalled rows (verbose transcript)', () => {
  test('no blank line above the FIRST ⎿ Recalled row', async () => {
    const out = stripAnsi(await renderVerbose())
    expect(out.split('\n')[0]).toContain('⎿')
    expect(out.split('\n')[0]).toContain('Recalled alpha.md')
  })

  test('the second ⎿ Recalled row keeps its blank-line separator', async () => {
    const out = stripAnsi(await renderVerbose())
    expect(out).toContain('\n\n  ⎿  Recalled beta.md')
  })

  test('single memory renders with no leading blank line at all', async () => {
    const message = fixtureMessage()
    ;(message as { relevantMemories: unknown[] }).relevantMemories = [
      { path: '/mem/only.md', content: 'only-mem', mtimeMs: 0 },
    ]
    const out = stripAnsi(
      await renderToStringIsolated(
        <AppStateProvider initialState={getDefaultAppState()}>
          <CollapsedReadSearchContent
            message={message}
            inProgressToolUseIDs={new Set()}
            shouldAnimate={false}
            verbose={true}
            tools={[]}
            lookups={fixtureLookups()}
          />
        </AppStateProvider>,
        COLUMNS,
      ),
    )
    expect(out.startsWith('  ⎿  Recalled only.md')).toBe(true)
  })
})
