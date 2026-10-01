import { describe, expect, test } from 'bun:test'
import type { PastedContent } from '../config.js'
import {
  beforeFirstSpace,
  computePromptEditorCursorLine,
  countSubstringOccurrences,
  editorFileArgv,
} from '../promptEditor.js'

/**
 * CC 2.1.286 (item 48) — "Ctrl+G external editor now opens on the cursor's
 * line" (pure-logic layer; the React wiring is a single 4th-arg pass-through
 * in PromptInput.tsx and is covered by the source-grep e2e pins).
 *
 * Official v286 binary forensics (all offsets into
 * /tmp/cc-diff-286/v286/package/claude unless noted; v285 =
 * /tmp/cc-diff-286/v285/package/claude):
 *
 *   - Editor module @~214202000–214208000. TRUE-NEW `R` @214204398
 *     (editorFileArgv):
 *       `function R(n,e,r){let o=E(n);if(o)return A(o,e,r);
 *        return r&&b.test(h(st(n," ")))?["+${r}",e]:[e]}`
 *     with `E` = classifyGuiEditor (T list: code/cursor/windsurf/codium/subl/
 *     atom/gedit/notepad++/notepad), `A` = guiGotoArgv (`!r→[e]`;
 *     `D.has(n)→["-g",`${e}:${r}`]`; `n==="subl"→[`${e}:${r}`]`; else `[e]`;
 *     D = code/cursor/windsurf/codium), `b` = PLUS_N regex
 *     `/\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/`, `h` = basename,
 *     `st` = beforeFirst @196526143.
 *   - v285 had NO `R`: prompt-editor spawn `jQ(n)` @213022642 spawned
 *     `x(d,[...s,n],...)` — plain `[...flags, filePath]`, no line. v286 spawn
 *     `kZ(n,e)` @214205691 builds `l=R(c,n,e)` then `I(p,[...f,...l],...)`.
 *     The line-argv logic existed in v285 only inline inside
 *     openFileInExternalEditor (uHe ≡ v286 bHe — unchanged); R is the v286
 *     refactor making it reusable by the prompt path.
 *   - `L$(n,e,r,o)` (editPromptInEditor; v285 `c$(n,e,r)`) — NEW 4th param
 *     `o` = cursor offset; cursor line:
 *       `f=n.slice(0,o)`
 *       `l=o===void 0?void 0:1+zt(d,"\n")+zt(e?ate(f,e):f,"\n")`
 *     with `d` = prepended commented context (trailing newline included),
 *     `e` = pastedContents, `ate` = expandPastedContents. `zt` @196526240
 *     counts occurrences advancing by 1 (`i=t.indexOf(n,i+1)`).
 *   - Caller PromptInput handleExternalEditor: v285 @224043107
 *     `Cy=await c$(ij,M.pastedContents,lj)` (3 args) → v286 @225289387
 *     `mh=await L$(lO,L.pastedContents,l6,L.cursorOffset)` (4 args). The
 *     FleetView `chat:externalEditor` caller stays 1-arg in both
 *     (v285 @213193842 / v286 @214376989).
 *
 * OCC adaptation notes:
 *   - editor.ts is read-only for this port and keeps its PLUS_N / VSCODE /
 *     guiGotoArgv private, so promptEditor.ts replicates them verbatim
 *     (mirroring official R/A) and reuses editor.ts's exported
 *     classifyGuiEditor (≡ official E as aligned in prior rounds).
 *   - OCC's commented-context text is its own (pre-existing divergence, not
 *     part of the 286 delta) — the cursor-line formula only counts newlines
 *     of the actually-prepended text, so it is layout-agnostic.
 */

const FILE = '/tmp/claude-prompt-abc123/prompt.md'

describe('beforeFirstSpace — official `st` @196526143', () => {
  test('returns text before the first space', () => {
    expect(beforeFirstSpace('code -w', ' ')).toBe('code')
  })

  test('returns the whole string when the separator is absent', () => {
    // Arrange / Act / Assert — official: `e===-1?t:t.slice(0,e)`
    expect(beforeFirstSpace('vim', ' ')).toBe('vim')
  })

  test('empty string stays empty', () => {
    expect(beforeFirstSpace('', ' ')).toBe('')
  })

  test('leading separator yields empty prefix', () => {
    expect(beforeFirstSpace(' vim', ' ')).toBe('')
  })
})

describe('countSubstringOccurrences — official `zt` @196526240', () => {
  test('counts newlines', () => {
    expect(countSubstringOccurrences('a\nb\nc', '\n')).toBe(2)
  })

  test('empty haystack → 0', () => {
    expect(countSubstringOccurrences('', '\n')).toBe(0)
  })

  test('advances by 1 so overlapping matches count (official `i+1`)', () => {
    // Arrange / Act / Assert — 'aaa'.indexOf('aa') at 0 then at 1 → 2.
    expect(countSubstringOccurrences('aaa', 'aa')).toBe(2)
    expect(countSubstringOccurrences('aaa', 'a')).toBe(3)
  })

  test('honors the `from` start offset', () => {
    // 'a\nb\nc' — newlines at 1 and 3; starting at 2 leaves only index 3.
    expect(countSubstringOccurrences('a\nb\nc', '\n', 2)).toBe(1)
  })
})

describe('editorFileArgv — official TRUE-NEW `R` @214204398', () => {
  describe('GUI family (E hit → A argv)', () => {
    test('vscode family gets -g file:line', () => {
      expect(editorFileArgv('code', FILE, 5)).toEqual(['-g', `${FILE}:5`])
      expect(editorFileArgv('cursor', FILE, 3)).toEqual(['-g', `${FILE}:3`])
      expect(editorFileArgv('windsurf', FILE, 2)).toEqual(['-g', `${FILE}:2`])
      expect(editorFileArgv('codium', FILE, 9)).toEqual(['-g', `${FILE}:9`])
    })

    test('subl gets file:line', () => {
      expect(editorFileArgv('subl', FILE, 7)).toEqual([`${FILE}:7`])
    })

    test('other GUI editors get no line argument (A fallthrough)', () => {
      expect(editorFileArgv('notepad', FILE, 2)).toEqual([FILE])
      expect(editorFileArgv('gedit', FILE, 4)).toEqual([FILE])
    })

    test('GUI family with no line → plain [file]', () => {
      expect(editorFileArgv('code', FILE, undefined)).toEqual([FILE])
      expect(editorFileArgv('subl', FILE)).toEqual([FILE])
    })

    test('substring family match (code-insiders includes code)', () => {
      // Official E: `T.find((r)=>e.includes(r))` — first token basename.
      expect(editorFileArgv('code-insiders', FILE, 4)).toEqual(['-g', `${FILE}:4`])
    })

    test('flags after the binary do not affect classification', () => {
      expect(editorFileArgv('code --wait', FILE, 5)).toEqual(['-g', `${FILE}:5`])
    })
  })

  describe('PLUS_N terminal editors (b regex → +line argv)', () => {
    test.each(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'micro', 'helix', 'hx'])(
      '%s gets +line before the file',
      editor => {
        expect(editorFileArgv(editor, FILE, 5)).toEqual(['+5', FILE])
      },
    )

    test('full path still matches via basename', () => {
      expect(editorFileArgv('/usr/local/bin/nvim', FILE, 12)).toEqual(['+12', FILE])
    })

    test('no line → plain [file]', () => {
      expect(editorFileArgv('vim', FILE, undefined)).toEqual([FILE])
    })

    test('line 0 is falsy → plain [file] (official `r&&` truthiness)', () => {
      expect(editorFileArgv('vim', FILE, 0)).toEqual([FILE])
    })
  })

  describe('everything else', () => {
    test('non-GUI non-PLUS_N editor ignores the line', () => {
      expect(editorFileArgv('cat', FILE, 5)).toEqual([FILE])
    })

    test('PLUS_N word only counts in the first token (official st(n," "))', () => {
      // 'sudo vim' → beforeFirstSpace = 'sudo' → basename 'sudo' → no match.
      expect(editorFileArgv('sudo vim', FILE, 5)).toEqual([FILE])
    })

    test('word-boundary regex does not match substrings of other words', () => {
      // 'voodoo' contains 'vi'? no — but e.g. 'microscope' must not match micro.
      expect(editorFileArgv('microscope', FILE, 5)).toEqual([FILE])
      expect(editorFileArgv('viper', FILE, 5)).toEqual([FILE])
    })
  })
})

describe('computePromptEditorCursorLine — official L$ `l` expression', () => {
  test('cursorOffset undefined → undefined (v285 behavior preserved)', () => {
    expect(computePromptEditorCursorLine('hello\nworld', '', undefined, undefined)).toBeUndefined()
  })

  test('offset 0 with no context → line 1', () => {
    expect(computePromptEditorCursorLine('hello', '', undefined, 0)).toBe(1)
  })

  test('cursor on the second input line → 2', () => {
    // Arrange — 'line1\nline2\nline3'; offset 8 → prefix 'line1\nl' (1 newline).
    const input = 'line1\nline2\nline3'

    // Act / Assert
    expect(computePromptEditorCursorLine(input, '', undefined, 8)).toBe(2)
  })

  test('cursor on the last line → 3', () => {
    const input = 'line1\nline2\nline3'
    expect(computePromptEditorCursorLine(input, '', undefined, input.length)).toBe(3)
  })

  test('prepended context newlines shift the line (official `1+zt(d,"\\n")`)', () => {
    // Arrange — OCC writes `${contextBlock}\n${prompt}`, so the prepended
    // text passed here includes the separating newline (2 newlines total).
    const prepended = '# ctx header\n# ctx body\n'
    const input = 'line1\nline2'

    // Act / Assert — cursor at offset 6 (start of 'line2'): 1 + 2 + 1 = 4.
    expect(computePromptEditorCursorLine(input, prepended, undefined, 6)).toBe(4)
  })

  test('pasted refs in the prefix expand before counting (official ate(f,e))', () => {
    // Arrange — collapsed ref counts as its expanded line count.
    const pasted: Record<number, PastedContent> = {
      1: { type: 'text', content: 'x\ny\nz' } as PastedContent,
    }
    const input = 'A\n[Pasted text #1 +2 lines]\nB'

    // Act / Assert — whole input as prefix: expanded 'A\nx\ny\nz\nB' has 4
    // newlines → line 5 (the collapsed ref would have counted only 2).
    expect(computePromptEditorCursorLine(input, '', pasted, input.length)).toBe(5)
  })

  test('without pastedContents the raw prefix counts (official `e?...:f`)', () => {
    const input = 'A\n[Pasted text #1 +2 lines]\nB'
    // Raw prefix has 2 newlines → line 3.
    expect(computePromptEditorCursorLine(input, '', undefined, input.length)).toBe(3)
  })

  test('cursor before a pasted ref is unaffected by expansion', () => {
    const pasted: Record<number, PastedContent> = {
      1: { type: 'text', content: 'x\ny\nz' } as PastedContent,
    }
    const input = 'A\n[Pasted text #1 +2 lines]\nB'
    // Prefix 'A\n' — 1 newline → line 2 whether expanded or not.
    expect(computePromptEditorCursorLine(input, '', pasted, 2)).toBe(2)
  })

  test('offset beyond input length clamps via slice (defensive)', () => {
    const input = 'ab\ncd'
    expect(computePromptEditorCursorLine(input, '', undefined, 999)).toBe(2)
  })
})
