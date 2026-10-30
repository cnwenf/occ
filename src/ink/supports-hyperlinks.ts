import supportsHyperlinksLib from 'supports-hyperlinks'

import { isEnvDefinedFalsy } from '../utils/envUtils.js'

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

  // CC 2.1.314 (OCC-138, changelog item 93): FORCE_HYPERLINK is a value-aware
  // override. Official v314 wrapper `ZWe` (byte-verified @259538525 region of
  // the 2.1.314 linux-x64 ELF):
  //   `let i=(r?.env??process.env).FORCE_HYPERLINK; if(!i)return;
  //    return !(os(i)||parseInt(i,10)===0)`
  // where `os` (@243469354) lowercases/trims and matches
  // ["0","false","no","off"] — byte-identical to isEnvDefinedFalsy.
  // v312's `tje` ignored the value entirely (any set value returned
  // stdoutSupported), so `false`/`no`/`off` wrongly turned hyperlinks ON.
  // Unset OR empty → no override; fall through to detection.
  // Honored from process.env, which includes values injected via settings.json
  // env (SAFE_ENV_VARS allowlist).
  const forceHyperlink = env['FORCE_HYPERLINK']
  if (forceHyperlink) {
    return !(
      isEnvDefinedFalsy(forceHyperlink) ||
      parseInt(forceHyperlink, 10) === 0
    )
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
