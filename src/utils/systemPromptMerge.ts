import { createHash } from 'node:crypto';

import { logError } from './log.js';

/**
 * CC 2.1.283 — `--system-prompt` / `--append-system-prompt` now accept their
 * text and `-file` forms TOGETHER (changelog: "Changed --system-prompt and
 * --append-system-prompt to accept their text and -file forms together").
 * The 282-era mutual-exclusion error is gone from the official binary
 * ("Cannot use both --system-prompt" v282=2 → v283=0).
 *
 * Byte-exact ports from the official 2.1.283 linux-x64 ELF (strings/byte
 * reads only — never executed):
 * - `or()` @212162145: file text first (trailing newline stripped), `\n\n`,
 *   flag text; either alone passes through.
 * - `C$n()` @203745647: Remote Control carrier-session predicate —
 *   `CLAUDE_CODE_BRIDGE_PROMPT_SHA256 !== void 0 || Kk.isBridgeCarrierChild`.
 *   OCC has no bridge-carrier-child surface (BRIDGE_MODE dormant, zero hits),
 *   so only the env-var half is reachable here.
 * - `qvr()` @203745738: decodes the append-prompt file buffer; in an RC
 *   session the contents must sha256-match the daemon-written prompt or the
 *   file is dropped (logged, undefined). Always unsets the env var first.
 */

/** Official 283 `or(e,o)` @212162145. */
export function mergePromptTexts(
  fileText: string | undefined,
  flagText: string | undefined,
): string | undefined {
  if (!flagText) return fileText;
  if (!fileText) return flagText;
  return `${fileText.replace(/\r?\n$/, '')}\n\n${flagText}`;
}

/** Official 283 `C$n()` @203745647 (env-var half; carrier-child surface not ported). */
export function isRemoteControlCarrierSession(): boolean {
  return process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 !== undefined;
}

/** Official 283 `qvr()` @203745738. */
export function decodeAppendSystemPromptFile(
  contents: Buffer,
): string | undefined {
  const isRemoteControlSession = isRemoteControlCarrierSession();
  const expectedSha256 = process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;
  delete process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;
  if (
    !isRemoteControlSession ||
    (expectedSha256 !== undefined &&
      createHash('sha256').update(contents).digest('hex') ===
        expectedSha256.toLowerCase())
  ) {
    return contents.toString('utf8');
  }
  logError(
    '[bridge:carrier] --append-system-prompt-file does not match the prompt the daemon wrote; dropped',
  );
  return undefined;
}
