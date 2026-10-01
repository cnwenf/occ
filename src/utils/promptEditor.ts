import { basename } from 'node:path'
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../history.js'
import instances from '../ink/instances.js'
import type { PastedContent } from './config.js'
import { classifyGuiEditor, getExternalEditor } from './editor.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { getFsImplementation } from './fsOperations.js'
import { toIDEDisplayName } from './ide.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'
import { generateTempFilePath } from './tempfile.js'

// Map of editor command overrides (e.g., to add wait flags)
// Official v286 `var N={code:"code -w",subl:"subl --wait"}` (~@214205400;
// v285 `var D=...` — unchanged across the delta).
const EDITOR_OVERRIDES: Record<string, string> = {
  code: 'code -w', // VS Code: wait for file to be closed
  subl: 'subl --wait', // Sublime Text: wait for file to be closed
}

/**
 * CC 2.1.286 (item 48) — Ctrl+G opens the external editor on the cursor's
 * line. Byte-verified official v286 editor module (offsets into
 * /tmp/cc-diff-286/v286/package/claude):
 *
 *   - `b=/\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/` — PLUS_N family.
 *   - `D=new Set(["code","cursor","windsurf","codium"])` — VSCode family.
 *   - TRUE-NEW `R` @214204398 (editorFileArgv):
 *       `function R(n,e,r){let o=E(n);if(o)return A(o,e,r);
 *        return r&&b.test(h(st(n," ")))?["+${r}",e]:[e]}`
 *     — v286 refactors the line-argv logic that v285 only had inline inside
 *     `openFileInExternalEditor` (bHe ≡ v285 uHe, unchanged) so the prompt
 *     editor path can reuse it.
 *   - `A` (guiGotoArgv): `if(!r)return[e];if(D.has(n))return["-g",`${e}:${r}`];
 *     if(n==="subl")return[`${e}:${r}`];return[e]`.
 *   - prompt-editor spawn `kZ(n,e)` @214205691 (v285 `jQ(n)` @213022642):
 *     v285 spawned `x(d,[...s,n],...)` — plain `[...flags, filePath]`, NO
 *     line. v286 builds `l=R(c,n,e)` then `I(p,[...f,...l],{stdio:"inherit"})`.
 *   - `editPromptInEditor` `L$(n,e,r,o)` (v285 `c$(n,e,r)`) — NEW 4th param
 *     `o` = cursor offset; line computed as
 *     `l=o===void 0?void 0:1+zt(d,"\n")+zt(e?ate(f,e):f,"\n")` with
 *     `f=n.slice(0,o)` (raw input prefix), `d` = prepended commented context
 *     (ends with newline), `ate` = expandPastedContents.
 *   - caller PromptInput handleExternalEditor: v285 @224043107
 *     `Cy=await c$(ij,M.pastedContents,lj)` (3 args) → v286 @225289387
 *     `mh=await L$(lO,L.pastedContents,l6,L.cursorOffset)` (4 args). The
 *     FleetView `chat:externalEditor` caller stays 1-arg in both versions.
 *   - helpers (chunk-xjjs8j5r): `st(t,n)` @196526143 (beforeFirst) and
 *     `zt(t,n,e=0)` @196526240 (count substring occurrences, advance by 1).
 *
 * editor.ts is read-only for this port (owned elsewhere), and its
 * PLUS_N_EDITORS / VSCODE_FAMILY / guiGotoArgv are module-private — so the
 * argv logic is replicated here verbatim (mirroring official R/A), while
 * GUI classification reuses editor.ts's exported classifyGuiEditor (≡ the
 * official E lookup as already aligned in prior rounds).
 */
const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/
const VSCODE_FAMILY = new Set(['code', 'cursor', 'windsurf', 'codium'])

/** Official `st` @196526143: text before the first occurrence of `sep`. */
export function beforeFirstSpace(text: string, sep: string): string {
  const idx = text.indexOf(sep)
  return idx === -1 ? text : text.slice(0, idx)
}

/**
 * Official `zt` @196526240: count non-overlapping-by-advance-1 occurrences of
 * `needle` in `haystack` (`i=t.indexOf(n,i+1)` — advance by 1, not by needle
 * length, so overlapping matches count).
 */
export function countSubstringOccurrences(
  haystack: string,
  needle: string,
  from: number = 0,
): number {
  let count = 0
  let idx = haystack.indexOf(needle, from)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + 1)
  }
  return count
}

/** Official `A` — GUI editor goto-line argv (VSCode `-g file:line`, subl `file:line`). */
function guiGotoArgv(
  guiFamily: string,
  filePath: string,
  line?: number,
): string[] {
  if (!line) return [filePath]
  if (VSCODE_FAMILY.has(guiFamily)) return ['-g', `${filePath}:${line}`]
  if (guiFamily === 'subl') return [`${filePath}:${line}`]
  return [filePath]
}

/**
 * Official TRUE-NEW `R` @214204398 — the shared GUI/terminal line-argv
 * builder: GUI family → guiGotoArgv; PLUS_N terminal editor → [`+line`,
 * file]; anything else (or no line) → [file].
 */
export function editorFileArgv(
  editorCommand: string,
  filePath: string,
  line?: number,
): string[] {
  const guiFamily = classifyGuiEditor(editorCommand)
  if (guiFamily !== undefined) {
    return guiGotoArgv(guiFamily, filePath, line)
  }
  return line &&
    PLUS_N_EDITORS.test(basename(beforeFirstSpace(editorCommand, ' ')))
    ? [`+${line}`, filePath]
    : [filePath]
}

/**
 * Official v286 `L$` cursor-line expression — 1-based line of the cursor
 * inside the temp file:
 *   `l=o===void 0?void 0:1+zt(d,"\n")+zt(e?ate(f,e):f,"\n")`
 * where `f=n.slice(0,o)` is the RAW input prefix before the cursor, `d` is
 * the text prepended before the prompt in the temp file (the commented
 * context block INCLUDING its trailing newline — '' when there is none), and
 * the prefix is expanded through pastedContents so collapsed paste refs count
 * as their expanded line count.
 */
export function computePromptEditorCursorLine(
  rawInput: string,
  prependedText: string,
  pastedContents: Record<number, PastedContent> | undefined,
  cursorOffset: number | undefined,
): number | undefined {
  if (cursorOffset === undefined) {
    return undefined
  }
  const rawPrefix = rawInput.slice(0, cursorOffset)
  const expandedPrefix = pastedContents
    ? expandPastedTextRefs(rawPrefix, pastedContents)
    : rawPrefix
  return (
    1 +
    countSubstringOccurrences(prependedText, '\n') +
    countSubstringOccurrences(expandedPrefix, '\n')
  )
}

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// sync IO: called from sync context (React components, sync command handlers)
// CC 2.1.286 (item 48): optional `line` — official kZ(n,e) @214205691 builds
// `l=R(c,n,e)` (editorFileArgv on the RAW editor, pre-override — kZ passes
// `c`, then spawns `p`/`f` from the override) and appends it after the editor
// flags. v285 jQ(n) @213022642 had no line param and spawned `[...s,n]`.
export function editFileInEditor(filePath: string, line?: number): EditorResult {
  const fs = getFsImplementation()
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    throw new Error('Ink instance not found - cannot pause rendering')
  }

  const editor = getExternalEditor()
  if (!editor) {
    return { content: null }
  }

  try {
    fs.statSync(filePath)
  } catch {
    return { content: null }
  }

  const useAlternateScreen = !isGuiEditor(editor)

  if (useAlternateScreen) {
    // Terminal editors (vi, nano, etc.) take over the terminal. Delegate to
    // Ink's alt-screen-aware handoff so fullscreen mode (where <AlternateScreen>
    // already entered alt screen) doesn't get knocked back to the main buffer
    // by a hardcoded ?1049l. enterAlternateScreen() internally calls pause()
    // and suspendStdin(); exitAlternateScreen() undoes both and resets frame
    // state so the next render writes from scratch.
    inkInstance.enterAlternateScreen()
  } else {
    // GUI editors (code, subl, etc.) open in a separate window — suspend
    // terminal modes (mouse tracking + focus reporting + kitty keyboard)
    // while the editor is open. Without this, SGR mouse sequences and focus
    // events accumulate as garbage in the input buffer while stdin is
    // suspended (2.1.216 #16).
    inkInstance.enterGuiEditorHandoff()
  }

  try {
    // Use override command if available, otherwise use the editor as-is
    const editorCommand = EDITOR_OVERRIDES[editor] ?? editor
    // CC 2.1.286 (item 48): official kZ spawns argv `[...f,...R(c,n,e)]`.
    // OCC keeps its established execSync shell-string mechanism (same as the
    // pre-286 code and editor.ts's win32 path) and renders the argv list into
    // it with each element quoted — with no `line` this produces exactly the
    // pre-286 command string `${editorCommand} "${filePath}"`.
    const fileArgv = editorFileArgv(editor, filePath, line)
    execSync_DEPRECATED(
      `${editorCommand} ${fileArgv.map(arg => `"${arg}"`).join(' ')}`,
      {
        stdio: 'inherit',
      },
    )

    // Read the edited content
    const editedContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
    return { content: editedContent }
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status
      if (status !== 0) {
        const editorName = toIDEDisplayName(editor)
        return {
          content: null,
          error: `${editorName} exited with code ${status}`,
        }
      }
    }
    return { content: null }
  } finally {
    if (useAlternateScreen) {
      inkInstance.exitAlternateScreen()
    } else {
      inkInstance.exitGuiEditorHandoff()
    }
  }
}

/**
 * Re-collapse expanded pasted text by finding content that matches
 * pastedContents and replacing it with references.
 */
function recollapsePastedContent(
  editedPrompt: string,
  originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let collapsed = editedPrompt

  // Find pasted content in the edited text and re-collapse it
  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'text') {
      const pasteId = parseInt(id)
      const contentStr = content.content

      // Check if this exact content exists in the edited prompt
      const contentIndex = collapsed.indexOf(contentStr)
      if (contentIndex !== -1) {
        // Replace with reference
        const numLines = getPastedTextRefNumLines(contentStr)
        const ref = formatPastedTextRef(pasteId, numLines)
        collapsed =
          collapsed.slice(0, contentIndex) +
          ref +
          collapsed.slice(contentIndex + contentStr.length)
      }
    }
  }

  return collapsed
}

// sync IO: called from sync context (React components, sync command handlers)
// CC 2.1.286 (item 48): NEW 4th param `cursorOffset` — official v286 `L$(n,e,r,o)`
// (v285 `c$(n,e,r)` @224043107 caller, 3 args). The temp file is written as
// `contextPrefix + expandedPrompt` (official `p=d+m`, where `d` is the
// commented context INCLUDING its trailing newline) and the cursor's 1-based
// line inside that content is passed to the spawn so the editor opens there.
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
  commentedContext?: string,
  cursorOffset?: number,
): EditorResult {
  const fs = getFsImplementation()
  const tempFile = generateTempFilePath()

  try {
    // Expand any pasted text references before editing
    const expandedPrompt = pastedContents
      ? expandPastedTextRefs(currentPrompt, pastedContents)
      : currentPrompt

    // 2.1.110 (I13): when externalEditorContext is on, prepend the last
    // assistant response as commented context so the user can see it while
    // editing. Lines are prefixed with "# " (shell-style comment) and the
    // block is separated from the prompt by a blank line. The prefix is
    // stripped on read-back so it never leaks into the submitted prompt.
    const contextBlock = buildCommentedContext(commentedContext)
    // Official `d=r?k(r):""` — the prepended text as it appears in the temp
    // file (contextBlock plus the separating newline); '' when no context.
    const contextPrefix = contextBlock ? `${contextBlock}\n` : ''
    const fileContent = `${contextPrefix}${expandedPrompt}`

    // Official `l=o===void 0?void 0:1+zt(d,"\n")+zt(e?ate(f,e):f,"\n")`.
    const cursorLine = computePromptEditorCursorLine(
      currentPrompt,
      contextPrefix,
      pastedContents,
      cursorOffset,
    )

    // Write expanded prompt to temp file
    writeFileSync_DEPRECATED(tempFile, fileContent, {
      encoding: 'utf-8',
      flush: true,
    })

    // Delegate to editFileInEditor — official `let i=kZ(u,l)` (v285: `jQ(u)`).
    const result = editFileInEditor(tempFile, cursorLine)

    if (result.content === null) {
      return result
    }

    let finalContent = result.content
    // Strip the commented context block back out so it isn't submitted as
    // part of the prompt. Only removes a leading block produced above.
    finalContent = stripCommentedContext(finalContent, contextBlock)

    // Trim a single trailing newline if present (common editor behavior)
    if (finalContent.endsWith('\n') && !finalContent.endsWith('\n\n')) {
      finalContent = finalContent.slice(0, -1)
    }

    // Re-collapse pasted content if it wasn't edited
    if (pastedContents) {
      finalContent = recollapsePastedContent(
        finalContent,
        currentPrompt,
        pastedContents,
      )
    }

    return { content: finalContent }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Build a "# "-prefixed comment block from the last assistant response text.
 * Returns '' (falsy) when there's no context to show. The block is bounded by
 * a header line so it's self-describing and easy to strip on read-back.
 */
function buildCommentedContext(commentedContext?: string): string {
  if (!commentedContext || !commentedContext.trim()) return ''
  const lines = commentedContext.split('\n')
  const commented = lines.map(line => `# ${line}`).join('\n')
  return `# Last response (commented — not part of your prompt):\n${commented}`
}

/**
 * Remove the leading commented-context block from the editor output. Only
 * strips the exact block written by buildCommentedContext (matched by its
 * header) so user-authored leading comments are preserved.
 */
function stripCommentedContext(content: string, contextBlock: string): string {
  if (!contextBlock) return content
  if (content.startsWith(contextBlock)) {
    const rest = content.slice(contextBlock.length)
    return rest.startsWith('\n') ? rest.slice(1) : rest
  }
  return content
}
