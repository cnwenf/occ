import { describe, expect, test } from 'bun:test'
import { FileEditTool } from '../FileEditTool.js'

// CC 2.1.291 (G#9): the FileEditTool "File does not exist" ask message is
// wrapped in the escaper before it is returned — byte-verified official 291:
//   `File does not exist. ${EU} ${se()}.`;if(Ye)ot+=` Did you mean ${Ye}?`;
//   else if(st)ot+=` Did you mean ${st}?`;
//   return{result:!1,behavior:"ask",message:ad(ot),errorCode:4}
// i.e. the WHOLE assembled message `ot` is escaped once via `ad(ot)` at the
// return boundary (not each interpolation). OCC maps ad ->
// escapeControlCharsAsEntities. This is a regression test: for an ordinary
// (control-char-free) path the wrap is the identity, so the message and
// errorCode are unchanged.

function contextWithNoRules() {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

describe('FileEditTool file-not-found message wrap (CC 2.1.291 G#9)', () => {
  test('nonexistent file with non-empty old_string returns an ask with errorCode 4', async () => {
    const result = await FileEditTool.validateInput(
      {
        file_path: '/tmp/occ-does-not-exist-g9/foo.txt',
        old_string: 'a',
        new_string: 'b',
      } as never,
      contextWithNoRules(),
    )

    expect(result.result).toBe(false)
    expect(result.behavior).toBe('ask')
    expect(result.errorCode).toBe(4)
    expect(result.message).toContain('File does not exist.')
    // Identity for a control-char-free message: no spurious entities injected.
    expect(result.message).not.toContain('&#')
  })
})
