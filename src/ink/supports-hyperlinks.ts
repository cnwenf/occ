import supportsHyperlinksLib from 'supports-hyperlinks'

// Additional terminals that support OSC 8 hyperlinks but aren't detected by supports-hyperlinks.
// Checked against both TERM_PROGRAM and LC_TERMINAL (the latter is preserved inside tmux).
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
]

type EnvLike = Record<string, string | undefined>

type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/**
 * Returns whether stdout supports OSC 8 hyperlinks.
 * Extends the supports-hyperlinks library with additional terminal detection.
 * @param options Optional overrides for testing (env, stdoutSupported)
 */
export function supportsHyperlinks(
  options?: SupportsHyperlinksOptions,
): boolean {
  const env = options?.env ?? process.env

  // FORCE_HYPERLINK explicitly overrides detection: when set, hyperlinks are
  // enabled unless the value is non-empty and parses to 0 (e.g. "0").
  // Honored from process.env, which includes values injected via settings.json
  // env (SAFE_ENV_VARS allowlist).
  if ('FORCE_HYPERLINK' in env) {
    const value = env['FORCE_HYPERLINK'] ?? ''
    return !(value.length > 0 && parseInt(value, 10) === 0)
  }

  const stdoutSupported =
    options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) {
    return true
  }

  // Check for additional terminals not detected by supports-hyperlinks
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true
  }

  // LC_TERMINAL is set by some terminals (e.g. iTerm2) and preserved inside tmux,
  // where TERM_PROGRAM is overwritten to 'tmux'.
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true
  }

  // Kitty sets TERM=xterm-kitty
  const term = env['TERM']
  if (term?.includes('kitty')) {
    return true
  }

  return false
}
