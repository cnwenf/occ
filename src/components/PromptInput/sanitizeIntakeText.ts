// CC 2.1.278 (D3): sanitize untrusted text on the intake paths that can carry
// raw ANSI/control sequences into the prompt editor state.
//
// The official 2.1.278 crash fix strips ANSI/control sequences when text
// re-enters the editor from sources other than the keyboard — OCC's two such
// paths are history recall (`useArrowKeyHistory` → onSetInput) and the
// external-editor read-back (`handleExternalEditor` → trackAndSetInput).
// ANSI-colored history entries or editor content previously reached the
// layout/cursor math raw (multi-cell escape bytes counted as characters),
// which is the crash class the official fix addresses.
//
// This reuses OCC's EXISTING strip utilities — no new regexes:
//   stripAnsi              (strip-ansi npm pkg; already used by onTextPaste)
//   decodePastedNewlines   (kitty CSIu newline decode + CR/CRLF → LF)
//   tab → 4 spaces         (same replaceAll as onTextPaste)
// The composition is byte-for-byte the existing onTextPaste intake pipeline
// (PromptInput.tsx: `decodePastedNewlines(stripAnsi(rawText)).replaceAll('\t', '    ')`),
// extracted here so both intake paths and the paste path share one definition.

import stripAnsi from 'strip-ansi';
import { decodePastedNewlines } from './pasteNewlineDecoder.js';

/**
 * Sanitize text entering the prompt editor from an external source (history
 * recall, external-editor read-back, paste). Strips ANSI escape sequences,
 * decodes paste-encoded newlines, normalizes CR/CRLF → LF, and expands tabs
 * to 4 spaces — identical to the existing paste-intake composition.
 */
export function sanitizeIntakeText(text: string): string {
  return decodePastedNewlines(stripAnsi(text)).replaceAll('\t', '    ');
}
