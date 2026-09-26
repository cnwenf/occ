import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  decodeAppendSystemPromptFile,
  isRemoteControlCarrierSession,
  mergePromptTexts,
} from '../systemPromptMerge.js';

/**
 * CC 2.1.283 — dual `--system-prompt`/`--append-system-prompt` text+file forms.
 * Byte-exact ports from the official 2.1.283 linux-x64 ELF:
 * - `or()` @212162145 — merge: file text (trailing newline stripped) + `\n\n`
 *   + flag text; either alone passes through. The 282 mutual-exclusion error
 *   ("Cannot use both --system-prompt") is gone (v282=2 → v283=0).
 * - `C$n()` @203745647 — RC carrier-session predicate (env-var half; OCC has
 *   no bridge-carrier-child surface).
 * - `qvr()` @203745738 — sha256 validation of the append file in RC sessions,
 *   always unsetting CLAUDE_CODE_BRIDGE_PROMPT_SHA256 first.
 */

const ORIGINAL_ENV = process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;
  } else {
    process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 = ORIGINAL_ENV;
  }
});

describe('mergePromptTexts (official 283 or())', () => {
  test('returns file text when no flag text is given', () => {
    expect(mergePromptTexts('from file', undefined)).toBe('from file');
    expect(mergePromptTexts('from file', '')).toBe('from file');
  });

  test('returns flag text when no file text is given', () => {
    expect(mergePromptTexts(undefined, 'from flag')).toBe('from flag');
    expect(mergePromptTexts('', 'from flag')).toBe('from flag');
  });

  test('merges file-first with a blank line, stripping the file trailing newline', () => {
    expect(mergePromptTexts('from file\n', 'from flag')).toBe(
      'from file\n\nfrom flag',
    );
    expect(mergePromptTexts('from file\r\n', 'from flag')).toBe(
      'from file\n\nfrom flag',
    );
    expect(mergePromptTexts('from file', 'from flag')).toBe(
      'from file\n\nfrom flag',
    );
    // Only ONE trailing newline is stripped.
    expect(mergePromptTexts('from file\n\n', 'from flag')).toBe(
      'from file\n\n\nfrom flag',
    );
  });

  test('returns undefined when neither is given', () => {
    expect(mergePromptTexts(undefined, undefined)).toBeUndefined();
  });
});

describe('isRemoteControlCarrierSession (official 283 C$n() env half)', () => {
  test('false when CLAUDE_CODE_BRIDGE_PROMPT_SHA256 is unset', () => {
    delete process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;
    expect(isRemoteControlCarrierSession()).toBe(false);
  });

  test('true when CLAUDE_CODE_BRIDGE_PROMPT_SHA256 is set', () => {
    process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 = 'abc';
    expect(isRemoteControlCarrierSession()).toBe(true);
  });
});

describe('decodeAppendSystemPromptFile (official 283 qvr())', () => {
  const contents = Buffer.from('append from file', 'utf8');
  const sha = createHash('sha256').update(contents).digest('hex');

  test('outside an RC session: decodes utf8, does not consult the env var', () => {
    delete process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256;
    expect(decodeAppendSystemPromptFile(contents)).toBe('append from file');
  });

  test('in an RC session with a matching sha256: decodes utf8', () => {
    process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 = sha;
    expect(decodeAppendSystemPromptFile(contents)).toBe('append from file');
    // The env var is always consumed (official a.unset).
    expect(process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256).toBeUndefined();
  });

  test('in an RC session with a matching UPPERCASE sha256: decodes (lowercased compare)', () => {
    process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 = sha.toUpperCase();
    expect(decodeAppendSystemPromptFile(contents)).toBe('append from file');
  });

  test('in an RC session with a mismatched sha256: drops the file contents', () => {
    process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256 = 'deadbeef';
    expect(decodeAppendSystemPromptFile(contents)).toBeUndefined();
    expect(process.env.CLAUDE_CODE_BRIDGE_PROMPT_SHA256).toBeUndefined();
  });
});
