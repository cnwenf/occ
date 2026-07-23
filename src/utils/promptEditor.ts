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
const EDITOR_OVERRIDES: Record<string, string> = {
  code: 'code -w', // VS Code: wait for file to be closed
  subl: 'subl --wait', // Sublime Text: wait for file to be closed
}

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// sync IO: called from sync context (React components, sync command handlers)
export function editFileInEditor(filePath: string): EditorResult {
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
    execSync_DEPRECATED(`${editorCommand} "${filePath}"`, {
      stdio: 'inherit',
    })

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
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
  commentedContext?: string,
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
    const fileContent = contextBlock ? `${contextBlock}\n${expandedPrompt}` : expandedPrompt

    // Write expanded prompt to temp file
    writeFileSync_DEPRECATED(tempFile, fileContent, {
      encoding: 'utf-8',
      flush: true,
    })

    // Delegate to editFileInEditor
    const result = editFileInEditor(tempFile)

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
