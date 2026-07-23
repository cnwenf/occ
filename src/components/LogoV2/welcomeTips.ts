// A small, synchronous set of welcome tips for the condensed startup logo.
// Inspired by grok-build's tips banner: a single dim line under the brand /
// model rows that surfaces one useful shortcut per session. Deterministic per
// session (hash of session id) so the same boot always shows the same tip and
// we never reach for Math.random (which is forbidden in this runtime).

const TIPS: readonly string[] = [
  'Press / for commands, ? for shortcuts',
  'Type @ to reference a file or directory',
  'Use # to pin a note to memory',
  'Press ! to run a bash command inline',
  'Ctrl+O expands collapsed tool output',
  'Run /help to browse every command',
  'Use the Tab key to accept a suggestion',
  'Press Esc twice to interrupt a run',
];

// FNV-1a 32-bit — stable, dependency-free hash. Good enough to spread tips
// across sessions without collision pile-up.
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit.
  return h >>> 0;
}

/**
 * Pick one welcome tip, deterministically, from a session id and a startup
 * counter. Falls back to a stable tip when the session id is empty (e.g. pipe
 * mode) so the logo never renders an undefined/blank hint line.
 */
export function pickWelcomeTip(
  sessionId: string,
  numStartups: number,
): string {
  const seed = sessionId.length > 0 ? sessionId : `boot-${numStartups}`;
  const idx = (hash32(seed) + numStartups) % TIPS.length;
  return TIPS[idx] ?? TIPS[0]!;
}

/** Exposed for tests so the tip pool and determinism can be asserted. */
export const WELCOME_TIPS: readonly string[] = TIPS;
