import { basename, isAbsolute } from 'path'
import React from 'react'
import { logError } from 'src/utils/log.js'
import { useDebounceCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '../ink.js'
import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { AppStoreContext } from '../state/AppState.js'
import type { ToolPermissionContext } from '../Tool.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { logForDebugging } from '../utils/debug.js'
import {
  asImageFilePath,
  getImageFromClipboard,
  isImageFilePath,
  PASTE_THRESHOLD,
  tryReadImageFromPath,
} from '../utils/imagePaste.js'
import type { ImageWithDimensions } from '../utils/imagePaste.js'
import { readClipboardImageViaOSC52 } from '../utils/osc52ClipboardRead.js'
import { readPastedFileGuarded } from '../utils/permissions/guardedRead.js'
import { getPersistedReadDenyContext } from '../utils/permissions/readDeny.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { getPlatform } from '../utils/platform.js'

const CLIPBOARD_CHECK_DEBOUNCE_MS = 50
const PASTE_COMPLETION_TIMEOUT_MS = 100

/** Telemetry event for a drag/paste of image paths that produced no image. */
const IMAGE_DRAG_EVENT = 'input_image_drag'

/** Official v290's three failure reasons (byte-verified @220573300). */
type ImageDragFailureReason = 'read_withheld' | 'read_failed' | 'read_threw'

/**
 * Official `p("input_image_drag", reason)` / `m("input_image_drag",
 * "read_threw")`. OCC's PII-free diagnostics sink is the testable stand-in for
 * the OTel counter (which no-ops under NODE_ENV=test); the event name and the
 * reason strings are byte-identical, and neither carries a path.
 */
function logImageDragFailure(reason: ImageDragFailureReason): void {
  logForDiagnosticsNoPII('warn', IMAGE_DRAG_EVENT, { reason })
}

/**
 * Official `he=K.every((be)=>yr(PNr(be)??""))` with `yr` = `isAbsolute` from
 * "path" (byte-verified in the chunk's import list @220572106): every cleaned
 * image path in the gesture is absolute. The temp-screenshot clipboard
 * fallback only applies to a real drag — a VSCode-terminal bare filename must
 * not trigger a clipboard read.
 */
function allPastedImagePathsAbsolute(imagePaths: readonly string[]): boolean {
  return imagePaths.every(
    imagePath => isAbsolute(asImageFilePath(imagePath) ?? ''),
  )
}

/**
 * CC 2.1.311 (ITEM 31) paste image-path extraction. The five regexes below
 * are byte-identical to the official binary (@259374500 in the 2.1.311
 * linux-x64 ELF):
 *
 *   Mr=/ (?=["']?(?:\/|[A-Za-z]:\\))/
 *   Wr=/^(?:\/(?!\/)[^ \r\\/]*(?:\\.[^ \r\\/]*)*\/|[A-Za-z]:\\|\\\\)[^\r]*$/
 *   Ir=/^(["'])(?:\/[^/\r]+\/|[A-Za-z]:\\|\\\\)[^\r]*\1$/
 *   Dr=/[^\\] /
 *   Yt=/\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i
 */
const PATH_TOKEN_SPLIT = / (?=["']?(?:\/|[A-Za-z]:\\))/
const ABSOLUTE_PATH_SHAPE =
  /^(?:\/(?!\/)[^ \r\\/]*(?:\\.[^ \r\\/]*)*\/|[A-Za-z]:\\|\\\\)[^\r]*$/
const QUOTED_PATH_SHAPE = /^(["'])(?:\/[^/\r]+\/|[A-Za-z]:\\|\\\\)[^\r]*\1$/
const UNESCAPED_SPACE = /[^\\] /
const TEMP_SCREENSHOT = /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i

/**
 * Official `ie` entry: a raw text fragment (string) or an index into the
 * image-path list (number). The results handler walks this list to rebuild
 * the leftover text (`Te` @259376890) after failed/refused reads.
 */
type PastePart = string | number

type PastedImageExtraction = {
  imagePaths: string[]
  parts: PastePart[]
}

/**
 * Official per-token qualification, verbatim predicate
 * `Ir.test(re)||Wr.test(re)&&(!Dr.test(re)||BEo(re))` with `re=N.trim()`:
 * a token counts as a path when it is a quoted absolute path, or an absolute
 * path shape that either has no unescaped interior space or IS an image file
 * path (the shell-escaped `My\ File.png` case).
 */
function tokenQualifiesAsPath(token: string): boolean {
  const trimmed = token.trim()
  return (
    QUOTED_PATH_SHAPE.test(trimmed) ||
    (ABSOLUTE_PATH_SHAPE.test(trimmed) &&
      (!UNESCAPED_SPACE.test(trimmed) || isImageFilePath(trimmed)))
  )
}

/**
 * Official v311 `M()` (byte-verified @259374500): per-LINE extraction.
 *
 * ```js
 * for(let I of J.split("\n")){
 *   let V=I.split(Mr).filter((N)=>N.trim());
 *   if(V.length>1 && !V.every((N)=>{let re=N.trim();
 *      return Ir.test(re)||Wr.test(re)&&(!Dr.test(re)||BEo(re))})){
 *     ie.push(I); continue }
 *   for(let N of V)
 *     if(BEo(N)) ie.push(q.length), q.push(N);
 *     else ie.push(N)
 * }
 * ```
 *
 * A line is split into candidate path tokens on spaces preceding a path
 * start. When a line yields multiple tokens, EVERY token must qualify as a
 * path shape — otherwise the whole RAW line stays text. This replaces the
 * v310 flatten-split, which attached images from lines like
 * `/review look at /tmp/shot.png`. Single-token lines skip qualification.
 * Raw tokens/lines are stored verbatim; whitespace-only lines vanish.
 */
function extractPastedImagePaths(pastedText: string): PastedImageExtraction {
  const imagePaths: string[] = []
  const parts: PastePart[] = []
  for (const line of pastedText.split('\n')) {
    const tokens = line.split(PATH_TOKEN_SPLIT).filter(token => token.trim())
    if (tokens.length > 1 && !tokens.every(tokenQualifiesAsPath)) {
      parts.push(line)
      continue
    }
    for (const token of tokens) {
      if (isImageFilePath(token)) {
        parts.push(imagePaths.length)
        imagePaths.push(token)
      } else {
        parts.push(token)
      }
    }
  }
  return { imagePaths, parts }
}

type PasteHandlerProps = {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  /** Stdin querier — used to read the local clipboard image via OSC 52
   *  on an empty bracketed paste (the Cmd+V-on-Mac-over-SSH case, where
   *  the terminal pastes nothing because the clipboard holds an image).
   *  Null outside the Ink tree. */
  querier?: TerminalQuerier | null
}

export function usePasteHandler({
  onPaste,
  onInput,
  onImagePaste,
  querier,
}: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  pasteState: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
  isPasting: boolean
} {
  const [pasteState, setPasteState] = React.useState<{
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }>({ chunks: [], timeoutId: null })
  const [isPasting, setIsPasting] = React.useState(false)
  const isMountedRef = React.useRef(true)
  // Mirrors pasteState.timeoutId but updated synchronously. When paste + a
  // keystroke arrive in the same stdin chunk, both wrappedOnInput calls run
  // in the same discreteUpdates batch before React commits — the second call
  // reads stale pasteState.timeoutId (null) and takes the onInput path. If
  // that key is Enter, it submits the old input and the paste is lost.
  const pastePendingRef = React.useRef(false)

  const isMacOS = React.useMemo(() => getPlatform() === 'macos', [])

  const appStore = React.useContext(AppStoreContext)

  /**
   * Official v290's paste-read context getter (byte-verified @220572106):
   * ```js
   * ()=>{let he=o?.getState().toolPermissionContext; return he?[he,igs(he)]:[]}
   * ```
   * `o` is the app store read from context — BOTH the live context and the
   * persisted-deny-only view (`igs`) are consulted on every read, and a
   * missing store yields an empty array, which `resolveGuardedRead` fails
   * closed on (`"refused"`). Live closure, not a snapshot: official re-invokes
   * it on both sides of the symlink resolution.
   */
  const getPermissionContexts = React.useCallback(
    (): readonly ToolPermissionContext[] => {
      const context = appStore?.getState().toolPermissionContext
      return context ? [context, getPersistedReadDenyContext()] : []
    },
    [appStore],
  )

  /** Official `iLo`'s third parameter: `sgs(path, getPermissionContexts, …)`. */
  const readPastedImage = React.useCallback(
    (path: string) => readPastedFileGuarded(path, getPermissionContexts),
    [getPermissionContexts],
  )

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const checkClipboardForImageImpl = React.useCallback(() => {
    if (!onImagePaste || !isMountedRef.current) return

    // OSC 52 read first (SSH path): the terminal returns the local
    // clipboard image bytes inline. Works only on terminals that allow
    // OSC 52 read (iTerm2/kitty/wezterm, opt-in). This is the only way to
    // pull a *local* clipboard image to a remote process over plain SSH —
    // bracketed paste cannot carry image bytes, so an image clipboard
    // arrives as an empty paste. Falls through to the native clipboard
    // reader (macOS) when OSC 52 is unsupported/empty.
    void (async () => {
      try {
        if (querier) {
          const osc52 = await readClipboardImageViaOSC52(querier)
          if (osc52 && isMountedRef.current) {
            onImagePaste(
              osc52.buffer.toString('base64'),
              osc52.mediaType,
              undefined,
              undefined,
            )
            return
          }
        }
        const imageData = await getImageFromClipboard()
        if (imageData && isMountedRef.current) {
          onImagePaste(
            imageData.base64,
            imageData.mediaType,
            undefined, // no filename for clipboard images
            imageData.dimensions,
          )
        }
      } catch (error) {
        if (isMountedRef.current) {
          logError(error as Error)
        }
      } finally {
        if (isMountedRef.current) {
          setIsPasting(false)
        }
      }
    })()
  }, [onImagePaste, querier])

  const checkClipboardForImage = useDebounceCallback(
    checkClipboardForImageImpl,
    CLIPBOARD_CHECK_DEBOUNCE_MS,
  )

  const resetPasteTimeout = React.useCallback(
    (currentTimeoutId: ReturnType<typeof setTimeout> | null) => {
      if (currentTimeoutId) {
        clearTimeout(currentTimeoutId)
      }
      return setTimeout(
        (
          setPasteState,
          onImagePaste,
          onPaste,
          setIsPasting,
          checkClipboardForImage,
          isMacOS,
          hasQuerier,
          pastePendingRef,
          readPastedImage,
        ) => {
          pastePendingRef.current = false
          setPasteState(({ chunks }) => {
            // Join chunks and filter out orphaned focus sequences
            // These can appear when focus events split during paste
            const pastedText = chunks
              .join('')
              .replace(/\[I$/, '')
              .replace(/\[O$/, '')

            // CC 2.1.311 (ITEM 31): per-line image-path extraction (official
            // `M()`). When dragging multiple images, they may come as
            // newline-separated or space-separated paths; a line only yields
            // image attachments when EVERY token on it is a path shape —
            // otherwise the whole raw line stays text. Spaces within paths
            // are escaped (e.g., `file\ name.png`), so splitting on spaces
            // preceding a path start is safe.
            const { imagePaths, parts } = extractPastedImagePaths(pastedText)

            if (onImagePaste && imagePaths.length > 0) {
              // Official `I`: the temp-screenshot check runs over the
              // extracted image PATHS, not the whole pasted text.
              const isTempScreenshot = imagePaths.some(imagePath =>
                TEMP_SCREENSHOT.test(imagePath),
              )

              // Process all image paths
              void Promise.all(
                imagePaths.map(imagePath =>
                  tryReadImageFromPath(imagePath, readPastedImage),
                ),
              )
                .then(results => {
                  if (!isMountedRef.current) {
                    return
                  }
                  // Official: `re=me.includes("refused")` — a denial withholds
                  // THAT image, disables the clipboard fallback for the whole
                  // gesture and reports `read_withheld` instead of
                  // `read_failed` when nothing survived.
                  const anyRefused = results.includes('refused')
                  // Official `be`: every cleaned image path is absolute.
                  const allAbsolute = allPastedImagePathsAbsolute(imagePaths)
                  const validImages = results.filter(
                    (r): r is ImageWithDimensions & { path: string } =>
                      r !== null && r !== 'refused',
                  )
                  // Official `ke=pe.length===0&&I&&F&&!re&&be`: the clipboard
                  // fallback gate — no image survived, the gesture looks like
                  // a macOS temp-screenshot drag, nothing was refused, and
                  // every path was absolute.
                  const tempScreenshotFallback =
                    validImages.length === 0 &&
                    isTempScreenshot &&
                    isMacOS &&
                    !anyRefused &&
                    allAbsolute
                  // Official `Te`: rebuild the leftover text from the parts
                  // list. Failed or refused image reads are re-emitted as raw
                  // text — EXCEPT temp-screenshot paths in the clipboard-
                  // fallback case (those are consumed by the clipboard read).
                  const leftoverText = parts
                    .flatMap(part => {
                      if (typeof part === 'string') {
                        return [part]
                      }
                      const imagePath = imagePaths[part] ?? ''
                      const readFailed =
                        results[part] === null || results[part] === 'refused'
                      return readFailed &&
                        !(
                          tempScreenshotFallback &&
                          TEMP_SCREENSHOT.test(imagePath)
                        )
                        ? [imagePath]
                        : []
                    })
                    .join('\n')

                  if (validImages.length > 0) {
                    // Successfully read at least one image
                    for (const imageData of validImages) {
                      const filename = basename(imageData.path)
                      onImagePaste(
                        imageData.base64,
                        imageData.mediaType,
                        filename,
                        imageData.dimensions,
                        imageData.path,
                      )
                    }
                    // Official `if(Te)H(Te)`: paste the leftover text (raw
                    // non-image parts plus failed/refused reads).
                    if (leftoverText && onPaste) {
                      onPaste(leftoverText)
                    }
                    setIsPasting(false)
                  } else if (tempScreenshotFallback) {
                    // For temporary screenshot files that no longer exist,
                    // paste any non-screenshot leftover, then try clipboard.
                    if (leftoverText && onPaste) {
                      onPaste(leftoverText)
                    }
                    checkClipboardForImage()
                  } else {
                    logImageDragFailure(
                      anyRefused ? 'read_withheld' : 'read_failed',
                    )
                    // Official `H(J)`: the FULL cleaned text on total failure,
                    // not the reconstruction.
                    if (onPaste) {
                      onPaste(pastedText)
                    }
                    setIsPasting(false)
                  }
                })
                .catch(error => {
                  // Official gained this arm in v290 alongside the guard: a
                  // read that throws must not leave the paste half-swallowed.
                  if (!isMountedRef.current) {
                    return
                  }
                  logImageDragFailure('read_threw')
                  logForDebugging(
                    `Image paste read failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    { level: 'error' },
                  )
                  if (onPaste) {
                    onPaste(pastedText)
                  }
                  setIsPasting(false)
                })
              return { chunks: [], timeoutId: null }
            }

            // If paste is empty (common when trying to paste images with Cmd+V),
            // check if clipboard has an image (macOS), or try OSC 52 read under
            // SSH (the querier path — the terminal pastes empty because the
            // clipboard holds an image, not text).
            if ((isMacOS || hasQuerier) && onImagePaste && pastedText.length === 0) {
              checkClipboardForImage()
              return { chunks: [], timeoutId: null }
            }

            // Handle regular paste
            if (onPaste) {
              onPaste(pastedText)
            }
            // Reset isPasting state after paste is complete
            setIsPasting(false)
            return { chunks: [], timeoutId: null }
          })
        },
        PASTE_COMPLETION_TIMEOUT_MS,
        setPasteState,
        onImagePaste,
        onPaste,
        setIsPasting,
        checkClipboardForImage,
        isMacOS,
        !!querier,
        pastePendingRef,
        readPastedImage,
      )
    },
    [
      checkClipboardForImage,
      isMacOS,
      onImagePaste,
      onPaste,
      querier,
      readPastedImage,
    ],
  )

  // Paste detection is now done via the InputEvent's keypress.isPasted flag,
  // which is set by the keypress parser when it detects bracketed paste mode.
  // This avoids the race condition caused by having multiple listeners on stdin.
  // Previously, we had a stdin.on('data') listener here which competed with
  // the 'readable' listener in App.tsx, causing dropped characters.

  const wrappedOnInput = (input: string, key: Key, event: InputEvent): void => {
    // Detect paste from the parsed keypress event.
    // The keypress parser sets isPasted=true for content within bracketed paste.
    const isFromPaste = event.keypress.isPasted

    // If this is pasted content, set isPasting state for UI feedback
    if (isFromPaste) {
      setIsPasting(true)
    }

    // Handle large pastes (>PASTE_THRESHOLD chars)
    // Usually we get one or two input characters at a time. If we
    // get more than the threshold, the user has probably pasted.
    // Unfortunately node batches long pastes, so it's possible
    // that we would see e.g. 1024 characters and then just a few
    // more in the next frame that belong with the original paste.
    // This batching number is not consistent.

    // Handle potential image filenames (even if they're shorter than paste
    // threshold). CC 2.1.311 (ITEM 31): route through the same per-line
    // extraction the paste timer uses, so a path-looking token embedded in
    // prose no longer drags the input into the image-paste machinery.
    // (OCC-specific pre-check — official ge() has no equivalent; kept for
    // the drag-drop-without-bracketed-paste case.)
    const hasImageFilePath =
      extractPastedImagePaths(input).imagePaths.length > 0

    // Handle empty paste (clipboard image on macOS, or OSC 52 read under SSH)
    // When the user pastes an image with Cmd+V, the terminal sends an empty
    // bracketed paste sequence. The keypress parser emits this as isPasted=true
    // with empty input. On macOS we check the local clipboard; under SSH (or
    // whenever a querier is available) we try OSC 52 read first.
    if (isFromPaste && input.length === 0 && (isMacOS || querier) && onImagePaste) {
      checkClipboardForImage()
      // Reset isPasting since there's no text content to process
      setIsPasting(false)
      return
    }

    // Check if we should handle as paste (from bracketed paste, large input, or continuation)
    const shouldHandleAsPaste =
      onPaste &&
      (input.length > PASTE_THRESHOLD ||
        pastePendingRef.current ||
        hasImageFilePath ||
        isFromPaste)

    if (shouldHandleAsPaste) {
      pastePendingRef.current = true
      setPasteState(({ chunks, timeoutId }) => {
        return {
          chunks: [...chunks, input],
          timeoutId: resetPasteTimeout(timeoutId),
        }
      })
      return
    }
    onInput(input, key)
    if (input.length > 10) {
      // Ensure that setIsPasting is turned off on any other multicharacter
      // input, because the stdin buffer may chunk at arbitrary points and split
      // the closing escape sequence if the input length is too long for the
      // stdin buffer.
      setIsPasting(false)
    }
  }

  return {
    wrappedOnInput,
    pasteState,
    isPasting,
  }
}
