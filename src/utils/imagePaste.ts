import { feature } from 'src/utils/featureFlags.js'
import { randomBytes } from 'crypto'
import { homedir, tmpdir } from 'os'
import { writeFileSync } from 'fs'
import { execa } from 'execa'
import { basename, extname, isAbsolute, join } from 'path'
import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  detectImageFormatFromBase64,
  type ImageDimensions,
  maybeResizeAndDownsampleImageBuffer,
} from './imageResizer.js'
import { logError } from './log.js'
import { readClipboardImageViaOSC52 } from './osc52ClipboardRead.js'
import type { TerminalQuerier } from '../ink/terminal-querier.js'

// Native NSPasteboard reader. GrowthBook gate tengu_collage_kaleidoscope is
// a kill switch (default on). Falls through to osascript when off.
// The gate string is inlined at each callsite INSIDE the feature() condition
// — module-scope helpers are NOT tree-shaken (see docs/feature-gating.md).

type SupportedPlatform = 'darwin' | 'linux' | 'win32'

// Threshold in characters for when to consider text a "large paste"
export const PASTE_THRESHOLD = 800
function getClipboardCommands() {
  const platform = process.platform as SupportedPlatform

  // Platform-specific temporary file paths
  // Use CLAUDE_CODE_TMPDIR if set, otherwise fall back to platform defaults
  const baseTmpDir =
    process.env.CLAUDE_CODE_TMPDIR ||
    (platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp')
  const screenshotFilename = 'claude_cli_latest_screenshot.png'
  const tempPaths: Record<SupportedPlatform, string> = {
    darwin: join(baseTmpDir, screenshotFilename),
    linux: join(baseTmpDir, screenshotFilename),
    win32: join(baseTmpDir, screenshotFilename),
  }

  const screenshotPath = tempPaths[platform] || tempPaths.linux

  // Platform-specific clipboard commands
  const commands: Record<
    SupportedPlatform,
    {
      checkImage: string
      saveImage: string
      getPath: string
      deleteFile: string
    }
  > = {
    darwin: {
      checkImage: `osascript -e 'the clipboard as «class PNGf»'`,
      saveImage: `osascript -e 'set png_data to (the clipboard as «class PNGf»)' -e 'set fp to open for access POSIX file "${screenshotPath}" with write permission' -e 'write png_data to fp' -e 'close access fp'`,
      getPath: `osascript -e 'get POSIX path of (the clipboard as «class furl»)'`,
      deleteFile: `rm -f "${screenshotPath}"`,
    },
    linux: {
      checkImage:
        'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"',
      saveImage: `xclip -selection clipboard -t image/png -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/png > "${screenshotPath}" 2>/dev/null || xclip -selection clipboard -t image/bmp -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/bmp > "${screenshotPath}"`,
      getPath:
        'xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null',
      deleteFile: `rm -f "${screenshotPath}"`,
    },
    win32: {
      checkImage:
        'powershell -NoProfile -Command "(Get-Clipboard -Format Image) -ne $null"',
      saveImage: `powershell -NoProfile -Command "$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
      getPath: 'powershell -NoProfile -Command "Get-Clipboard"',
      deleteFile: `del /f "${screenshotPath}"`,
    },
  }

  return {
    commands: commands[platform] || commands.linux,
    screenshotPath,
  }
}

export type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
}

/**
 * Check if clipboard contains an image without retrieving it.
 */
export async function hasImageInClipboard(): Promise<boolean> {
  // Test / scp escape hatch: a configured source file counts as "has image".
  // This lets the OCC_CLIPBOARD_IMAGE_SRC path (and REPL tests on headless
  // machines) report truthfully without a live clipboard.
  const overrideSrc = getClipboardImageSrcOverride()
  if (overrideSrc && getFsImplementation().existsSync(overrideSrc)) {
    return true
  }
  if (process.platform !== 'darwin') {
    // Linux/Win32: shell out to the platform check command. On a dev machine
    // with a graphical session (or a clipboard-synced SSH session), xclip /
    // wl-paste / powershell report image targets. Headless sandboxes return
    // false — callers fall through to the no-image hint.
    const { commands } = getClipboardCommands()
    try {
      const result = await execa(commands.checkImage, {
        shell: true,
        reject: false,
      })
      return result.exitCode === 0
    } catch {
      return false
    }
  }
  if (
    feature('NATIVE_CLIPBOARD_IMAGE') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
  ) {
    // Native NSPasteboard check (~0.03ms warm). Fall through to osascript
    // when the module/export is missing. Catch a throw too: it would surface
    // as an unhandled rejection in useClipboardImageHint's setTimeout.
    try {
      const { getNativeModule } = await import('image-processor-napi')
      const nativeModule = getNativeModule()
      if (nativeModule && 'hasClipboardImage' in nativeModule) {
        const hasImage = (nativeModule as unknown as Record<string, Function>).hasClipboardImage
        if (hasImage) return hasImage()
      }
    } catch (e) {
      logError(e as Error)
    }
  }
  const result = await execFileNoThrowWithCwd('osascript', [
    '-e',
    'the clipboard as «class PNGf»',
  ])
  return result.code === 0
}

export async function getImageFromClipboard(): Promise<ImageWithDimensions | null> {
  // Fast path: native NSPasteboard reader (macOS only). Reads PNG bytes
  // directly in-process and downsamples via CoreGraphics if over the
  // dimension cap. ~5ms cold, sub-ms warm — vs. ~1.5s for the osascript
  // path below. Throws if the native module is unavailable, in which case
  // the catch block falls through to osascript. A `null` return from the
  // native call is authoritative (clipboard has no image).
  if (
    feature('NATIVE_CLIPBOARD_IMAGE') &&
    process.platform === 'darwin' &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
  ) {
    try {
      const { getNativeModule } = await import('image-processor-napi')
      const nativeModule = getNativeModule()
      const readClipboard = nativeModule && 'readClipboardImage' in nativeModule
        ? (nativeModule as unknown as Record<string, Function>).readClipboardImage
        : undefined
      if (!readClipboard) {
        throw new Error('native clipboard reader unavailable')
      }
      const native = readClipboard(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
      if (!native) {
        return null
      }
      // The native path caps dimensions but not file size. A complex
      // 2000×2000 PNG can still exceed the 3.75MB raw / 5MB base64 API
      // limit — for that edge case, run through the same size-cap that
      // the osascript path uses (degrades to JPEG if needed). Cheap if
      // already under: just a sharp metadata read.
      const buffer: Buffer = native.png
      if (buffer.length > IMAGE_TARGET_RAW_SIZE) {
        const resized = await maybeResizeAndDownsampleImageBuffer(
          buffer,
          buffer.length,
          'png',
        )
        return {
          base64: resized.buffer.toString('base64'),
          mediaType: `image/${resized.mediaType}`,
          // resized.dimensions sees the already-downsampled buffer; native knows the true originals.
          dimensions: {
            originalWidth: native.originalWidth,
            originalHeight: native.originalHeight,
            displayWidth: resized.dimensions?.displayWidth ?? native.width,
            displayHeight: resized.dimensions?.displayHeight ?? native.height,
          },
        }
      }
      return {
        base64: buffer.toString('base64'),
        mediaType: 'image/png',
        dimensions: {
          originalWidth: native.originalWidth,
          originalHeight: native.originalHeight,
          displayWidth: native.width,
          displayHeight: native.height,
        },
      }
    } catch (e) {
      logError(e as Error)
      // Fall through to osascript fallback.
    }
  }

  const { commands, screenshotPath } = getClipboardCommands()
  try {
    // Check if clipboard has image
    const checkResult = await execa(commands.checkImage, {
      shell: true,
      reject: false,
    })
    if (checkResult.exitCode !== 0) {
      return null
    }

    // Save the image
    const saveResult = await execa(commands.saveImage, {
      shell: true,
      reject: false,
    })
    if (saveResult.exitCode !== 0) {
      return null
    }

    // Read the image and convert to base64
    let imageBuffer = getFsImplementation().readFileBytesSync(screenshotPath)

    // BMP is not supported by the API — convert to PNG via Sharp.
    // This handles WSL2 where Windows copies images as BMP by default.
    if (
      imageBuffer.length >= 2 &&
      imageBuffer[0] === 0x42 &&
      imageBuffer[1] === 0x4d
    ) {
      const sharp = await getImageProcessor()
      imageBuffer = await sharp(imageBuffer).png().toBuffer()
    }

    // Resize if needed to stay under 5MB API limit
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    const base64Image = resized.buffer.toString('base64')

    // Detect format from magic bytes
    const mediaType = detectImageFormatFromBase64(base64Image)

    // Cleanup (fire-and-forget, don't await)
    void execa(commands.deleteFile, { shell: true, reject: false })

    return {
      base64: base64Image,
      mediaType,
      dimensions: resized.dimensions,
    }
  } catch {
    return null
  }
}

export async function getImagePathFromClipboard(): Promise<string | null> {
  const { commands } = getClipboardCommands()

  try {
    // Try to get text from clipboard
    const result = await execa(commands.getPath, {
      shell: true,
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    return result.stdout.trim()
  } catch (e) {
    logError(e as Error)
    return null
  }
}

/**
 * Env var that, when set to an existing image file path, makes the clipboard
 * image readers use that file as the clipboard source instead of shelling
 * out. Two purposes:
 *   1. REPL/headless test hook — drive `chat:imagePaste` without a live
 *      clipboard or display.
 *   2. SSH escape hatch — `scp` a screenshot to a known path on the dev
 *      machine, set this var, and Ctrl+V drops the path into the REPL.
 */
export const CLIPBOARD_IMAGE_SRC_ENV = 'OCC_CLIPBOARD_IMAGE_SRC'

/** Returns the configured override file path, or undefined if unset. */
export function getClipboardImageSrcOverride(): string | undefined {
  const v = process.env[CLIPBOARD_IMAGE_SRC_ENV]
  return v && v.length > 0 ? v : undefined
}

/**
 * Env var pointing at the local-watcher inbox file on the dev machine. The
 * shipped `scripts/occ-clipboard-watch.sh` auto-scps new local screenshots
 * to `DEFAULT_CLIPBOARD_WATCH_PATH`; set this to override the destination.
 * Set to an empty string to disable the watch-path branch entirely.
 */
export const CLIPBOARD_WATCH_PATH_ENV = 'OCC_CLIPBOARD_WATCH_PATH'

/** Default inbox path for the local clipboard watcher. */
export const DEFAULT_CLIPBOARD_WATCH_PATH = join(homedir(), '.occ', 'clipboard-latest.png')

/**
 * Returns the watch-path file path, or undefined when disabled.
 *
 * - Unset → `DEFAULT_CLIPBOARD_WATCH_PATH` (~/.occ/clipboard-latest.png).
 * - Set to a non-empty string → that path.
 * - Set to empty string → undefined (watch-path branch disabled).
 */
export function getClipboardWatchPath(): string | undefined {
  const v = process.env[CLIPBOARD_WATCH_PATH_ENV]
  if (v !== undefined) return v.length > 0 ? v : undefined
  return DEFAULT_CLIPBOARD_WATCH_PATH
}

export type SavedClipboardImage = {
  path: string
  mediaType: string
  dimensions?: ImageDimensions
}

/**
 * Read the clipboard image (or the `$OCC_CLIPBOARD_IMAGE_SRC` override file)
 * and persist it to a unique temp file, returning the file path.
 *
 * This is the SSH-friendly paste path: the file path is inserted into the
 * REPL input box, and the agent reads it via FileReadTool — no in-band
 * base64 image needs to survive the SSH terminal paste transport.
 *
 * Returns null when no image is available (no clipboard image and no valid
 * override). Never throws — callers show the no-image hint.
 */
export async function saveClipboardImageToTempFile(
  opts: { querier?: TerminalQuerier | null } = {},
): Promise<SavedClipboardImage | null> {
  try {
    // 1. Explicit override (test hook + scp escape hatch).
    const overrideSrc = getClipboardImageSrcOverride()
    if (overrideSrc && getFsImplementation().existsSync(overrideSrc)) {
      const buffer = getFsImplementation().readFileBytesSync(overrideSrc)
      const mediaType = detectImageFormatFromBase64(buffer.toString('base64'))
      return writeUniqueTempImageFile(buffer, mediaType)
    }

    // 2. OSC 52 read (SSH path): the terminal returns the local clipboard
    //    image bytes inline. This is the only mechanism that can pull a
    //    *local* clipboard image to a remote process over a plain SSH
    //    session — bracketed paste cannot carry image bytes. Works only on
    //    terminals that allow OSC 52 read (iTerm2/kitty/wezterm, opt-in).
    //    Returns null when unsupported or when the clipboard holds text;
    //    callers fall through to the next branch.
    if (opts.querier) {
      const osc52 = await readClipboardImageViaOSC52(opts.querier)
      if (osc52) {
        const ext = osc52.mediaType.replace(/^image\//, '') || 'png'
        const resized = await maybeResizeAndDownsampleImageBuffer(
          osc52.buffer,
          osc52.buffer.length,
          ext,
        )
        return writeUniqueTempImageFile(
          resized.buffer,
          `image/${resized.mediaType}`,
          resized.dimensions,
        )
      }
    }

    // 3. Default watch path (local-watcher escape hatch): a local script
    //    (scripts/occ-clipboard-watch.sh) auto-scps new screenshots to this
    //    path on the dev machine; Ctrl+V reads it. Reliable and
    //    terminal-agnostic — works even when OSC 52 read is blocked. Not
    //    deleted after read: it's the watcher's inbox, not a one-shot.
    const watchPath = getClipboardWatchPath()
    if (watchPath && getFsImplementation().existsSync(watchPath)) {
      const buffer = getFsImplementation().readFileBytesSync(watchPath)
      if (buffer.length > 0) {
        const ext = detectImageFormatFromBase64(buffer.toString('base64'))
        const extName = ext.replace(/^image\//, '') || 'png'
        const resized = await maybeResizeAndDownsampleImageBuffer(
          buffer,
          buffer.length,
          extName,
        )
        return writeUniqueTempImageFile(
          resized.buffer,
          `image/${resized.mediaType}`,
          resized.dimensions,
        )
      }
    }

    // 4. Local clipboard (macOS native / Linux xclip / wl-paste). On a
    //    headless SSH box with no clipboard tools this returns null —
    //    callers show the no-image hint.
    const image = await getImageFromClipboard()
    if (!image) {
      return null
    }
    const buffer = Buffer.from(image.base64, 'base64')
    return writeUniqueTempImageFile(buffer, image.mediaType, image.dimensions)
  } catch (e) {
    logError(e as Error)
    return null
  }
}

const TEMP_IMAGE_EXT_ALLOW = /^(png|jpe?g|gif|webp|bmp)$/i

function writeUniqueTempImageFile(
  buffer: Buffer,
  mediaType: string,
  dimensions?: ImageDimensions,
): SavedClipboardImage {
  const baseTmpDir =
    process.env.CLAUDE_CODE_TMPDIR ||
    (process.platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : tmpdir())
  const ext = mediaType.replace(/^image\//, '').toLowerCase()
  const safeExt = TEMP_IMAGE_EXT_ALLOW.test(ext) ? ext.replace('jpeg', 'jpg') : 'png'
  const name = `occ-clipboard-${Date.now()}-${randomBytes(6).toString('hex')}.${safeExt}`
  const filePath = join(baseTmpDir, name)
  writeFileSync(filePath, buffer)
  return {
    path: filePath,
    mediaType: `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    dimensions,
  }
}


/**
 * Regex pattern to match supported image file extensions. Kept in sync with
 * MIME_BY_EXT in BriefTool/upload.ts — attachments.ts uses this to set isImage
 * on the wire, and remote viewers fetch /preview iff isImage is true. An ext
 * here but not in MIME_BY_EXT (e.g. bmp) uploads as octet-stream and has no
 * /preview variant → broken thumbnail.
 */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/**
 * Remove outer single or double quotes from a string
 * @param text Text to clean
 * @returns Text without outer quotes
 */
function removeOuterQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Remove shell escape backslashes from a path (for macOS/Linux/WSL)
 * On Windows systems, this function returns the path unchanged
 * @param path Path that might contain shell-escaped characters
 * @returns Path with escape backslashes removed (on macOS/Linux/WSL only)
 */
function stripBackslashEscapes(path: string): string {
  const platform = process.platform as SupportedPlatform

  // On Windows, don't remove backslashes as they're part of the path
  if (platform === 'win32') {
    return path
  }

  // On macOS/Linux/WSL, handle shell-escaped paths
  // Double-backslashes (\\) represent actual backslashes in the filename
  // Single backslashes followed by special chars are shell escapes

  // First, temporarily replace double backslashes with a placeholder
  // Use random salt to prevent injection attacks where path contains literal placeholder
  const salt = randomBytes(8).toString('hex')
  const placeholder = `__DOUBLE_BACKSLASH_${salt}__`
  const withPlaceholder = path.replace(/\\\\/g, placeholder)

  // Remove single backslashes that are shell escapes
  // This handles cases like "name\ \(15\).png" -> "name (15).png"
  const withoutEscapes = withPlaceholder.replace(/\\(.)/g, '$1')

  // Replace placeholders back to single backslashes
  return withoutEscapes.replace(new RegExp(placeholder, 'g'), '\\')
}

/**
 * Check if a given text represents an image file path
 * @param text Text to check
 * @returns Boolean indicating if text is an image path
 */
export function isImageFilePath(text: string): boolean {
  const cleaned = removeOuterQuotes(text.trim())
  const unescaped = stripBackslashEscapes(cleaned)
  return IMAGE_EXTENSION_REGEX.test(unescaped)
}

/**
 * Clean and normalize a text string that might be an image file path
 * @param text Text to process
 * @returns Cleaned text with quotes removed, whitespace trimmed, and shell escapes removed, or null if not an image path
 */
export function asImageFilePath(text: string): string | null {
  const cleaned = removeOuterQuotes(text.trim())
  const unescaped = stripBackslashEscapes(cleaned)

  if (IMAGE_EXTENSION_REGEX.test(unescaped)) {
    return unescaped
  }

  return null
}

/**
 * Try to find and read an image file, falling back to clipboard search
 * @param text Pasted text that might be an image filename or path
 * @returns Object containing the image path and base64 data, or null if not found
 */
export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  // Strip terminal added spaces or quotes to dragged in paths
  const cleanedPath = asImageFilePath(text)

  if (!cleanedPath) {
    return null
  }

  const imagePath = cleanedPath
  let imageBuffer

  try {
    if (isAbsolute(imagePath)) {
      imageBuffer = getFsImplementation().readFileBytesSync(imagePath)
    } else {
      // VSCode Terminal just grabs the text content which is the filename
      // instead of getting the full path of the file pasted with cmd-v. So
      // we check if it matches the filename of the image in the clipboard.
      const clipboardPath = await getImagePathFromClipboard()
      if (clipboardPath && imagePath === basename(clipboardPath)) {
        imageBuffer = getFsImplementation().readFileBytesSync(clipboardPath)
      }
    }
  } catch (e) {
    logError(e as Error)
    return null
  }
  if (!imageBuffer) {
    return null
  }
  if (imageBuffer.length === 0) {
    logForDebugging(`Image file is empty: ${imagePath}`, { level: 'warn' })
    return null
  }

  // BMP is not supported by the API — convert to PNG via Sharp.
  if (
    imageBuffer.length >= 2 &&
    imageBuffer[0] === 0x42 &&
    imageBuffer[1] === 0x4d
  ) {
    const sharp = await getImageProcessor()
    imageBuffer = await sharp(imageBuffer).png().toBuffer()
  }

  // Resize if needed to stay under 5MB API limit
  // Extract extension from path for format hint
  const ext = extname(imagePath).slice(1).toLowerCase() || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    imageBuffer.length,
    ext,
  )
  const base64Image = resized.buffer.toString('base64')

  // Detect format from the actual file contents using magic bytes
  const mediaType = detectImageFormatFromBase64(base64Image)
  return {
    path: imagePath,
    base64: base64Image,
    mediaType,
    dimensions: resized.dimensions,
  }
}
