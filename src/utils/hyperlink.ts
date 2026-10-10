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

/**
 * Official `Fe` — byte-verified in the v295 ELF @94784380 (`ESC[28m ESC[39m
 * ESC[49m`, sitting right beside the markdown URL/nbsp regexes).
 *
 * CC 2.1.295 changelog #031: "Fixed a link address shown as text being hidden
 * by a colour or conceal style a reply left on, including where it wraps in a
 * table or a question preview." Emitted ahead of a link ADDRESS SHOWN AS TEXT,
 * it resets conceal (SGR 28), foreground (39) and background (49) so the address
 * stays visible no matter what SGR state a prior reply left active. This is the
 * 295 delta: `shownUrlStart` and `afterStyle` are both 0→3 occurrences in the
 * 2.1.294→295 strings diff.
 */
export const SHOWN_URL_NEUTRALIZER = '\x1b[28m\x1b[39m\x1b[49m'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks)
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    // No OSC-8 support: the address is shown as bare text (any `content` label
    // is ignored). Prepend the neutralizer so a conceal/colour style a prior
    // reply left on cannot hide it (CC 2.1.295 #031 — official `Fe`).
    return `${SHOWN_URL_NEUTRALIZER}${url}`
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  // CC 2.1.295 #031 — when the ADDRESS ITSELF is the visible text (no distinct
  // label), emit official `Fe` ahead of it so a residual conceal/colour can't
  // hide the URL. With a distinct label the visible text is the label, not the
  // address, so official skips it (its "address-shown-as-text" flag `U` is
  // false). Official also gates on an `afterStyle` flag OCC does not track, so
  // OCC applies `Fe` unconditionally in the shown-as-text case — a safe superset
  // that matches official's unconditional `pe(e)=ue(e,Fe)` variant.
  const shownUrlStart = displayText === url ? SHOWN_URL_NEUTRALIZER : ''
  return `${shownUrlStart}${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
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
