import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'

// OSC 8 hyperlink escape sequences
// Format: \e]8;;URL\e\\TEXT\e]8;;\e\\
// Using \x07 (BEL) as terminator which is more widely supported
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

// String Terminator (ST) variant of the OSC 8 terminator: ESC followed by
// backslash. Used for sign-in URLs whose spec mandates the ST-terminated form.
export const OSC8_ST = '\x1b\\'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
  /**
   * CC 2.1.295 #031 — official `rw` @220883281 threads `shownUrlStart` (the
   * afterStyleReset `Fe` = "\x1B[28m\x1B[39m\x1B[49m") and emits it immediately
   * before any address DRAWN AS TEXT (the non-hyperlink branch), so a colour or
   * conceal style a reply left open can no longer hide the address. The OSC 8
   * branch does NOT emit it — there the address lives inside the escape
   * sequence, not in drawn text. Defaults to "" so every pre-existing caller
   * (`linkifyIssueReferences`, sign-in, the OSC 8 path) stays byte-identical.
   */
  shownUrlStart?: string
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks) and the
 *                  CC 2.1.295 #031 `shownUrlStart` style reset (draw-as-text only)
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    // #031: prefix a drawn-as-text address with the style reset so a leftover
    // colour/conceal style can't hide it (see HyperlinkOptions.shownUrlStart).
    // STAGED: official rw's fuller `${content}${reset} (${url})` form for
    // meaningful text (needs PBr @220883649 + the exact `dn` normalizer) — a
    // pre-existing OCC divergence, not introduced here.
    const shownUrlStart = options?.shownUrlStart ?? ''
    return `${shownUrlStart}${url}`
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}

/**
 * Emit a URL as a single OSC 8 terminal hyperlink, unconditionally.
 *
 * Unlike {@link createHyperlink}, this does NOT gate on supportsHyperlinks():
 * it always emits the escape sequence. This is intentional for sign-in URLs
 * printed by `claude auth login` / `claude mcp login --no-browser`, which
 * must remain a single clickable unit even when terminal-hyperlink
 * detection fails over SSH/tmux — there TERM_PROGRAM is overwritten (to
 * `tmux`/`ssh`), detection returns false, and a gated URL would wrap into
 * non-clickable text. Wrapping the whole URL in one OSC 8 span also keeps
 * it clickable when it wraps across terminal lines.
 *
 * Format (ST-terminated): ESC ] 8 ; ; URL ST URL ESC ] 8 ; ; ST
 * i.e. \x1b]8;;URL\x1b\\URL\x1b]8;;\x1b\\
 */
export function createSignInHyperlink(url: string): string {
  return `${OSC8_START}${url}${OSC8_ST}${url}${OSC8_START}${OSC8_ST}`
}
