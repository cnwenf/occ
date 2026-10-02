// OCC-105 Cluster-B Item 6 (2.1.286 → 2.1.287) — /feedback + /bug GitHub
// issue URL no longer embeds recent error messages; over-budget descriptions
// are shortened per-line and end with the new v287 note. Ported from the
// byte-verified official `st(c,i,o)` recovery in
// docs/gap-research-287/cluster-b-protocol-auth-security.md (Item 6).
//
// Consent-render test: STAGED — OCC has no existing render-test harness for
// the Feedback component (the generic src/ink render harness exists, but the
// consent step requires driving TextInput submission through the full Dialog
// + keybinding stack). The consent row is byte-checked at source level below
// instead.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Must be set before importing Feedback.tsx (MACRO.VERSION is read inside
// createGitHubIssueUrl and transitively at import time).
(globalThis as any).MACRO ??= { VERSION: '2.1.287', BUILD_TIME: 'test', BUILD_TARGET: 'test' };

const GITHUB_URL_LIMIT = 7250; // mirrors src/components/Feedback.tsx constant
const REPO_ISSUES_URL = 'https://github.com/anthropics/claude-code/issues';

// Byte-verified v287 strings (report Item 6 novelty counts: v286=0 / v287=1+).
const V287_NOTE = `…\n\n**Note:** The description was shortened to fit GitHub's link length limit. The full description was sent to Anthropic with the feedback report; its Feedback ID is below.`;
const V286_OLD_NOTE = '**Note:** Content was truncated.';
const CONSENT_ROW_LABEL = '- Recent error messages:';
const CONSENT_ROW_DIM = 'up to the last 100 since you launched Claude Code (may include file paths)';

let createGitHubIssueUrl: typeof import('../Feedback.js').createGitHubIssueUrl;
let env: typeof import('../../utils/env.js').env;
let feedbackSource: string;

beforeAll(async () => {
  ({ createGitHubIssueUrl } = await import('../Feedback.js'));
  ({ env } = await import('../../utils/env.js'));
  feedbackSource = await readFile(join(import.meta.dir, '..', 'Feedback.tsx'), 'utf8');
});

function decodeBody(url: string): string {
  const bodyIndex = url.indexOf('&body=');
  expect(bodyIndex).toBeGreaterThan(0);
  return decodeURIComponent(url.slice(bodyIndex + '&body='.length));
}

describe('createGitHubIssueUrl — v287 st(c,i,o) port', () => {
  test('URL structure: /new?title=<encoded>&labels=user-reported,bug&body= with Bug Description header + Environment Info footer', () => {
    const url = createGitHubIssueUrl('fb-1234', '[Bug] it broke', 'something went wrong');
    expect(url.startsWith(`${REPO_ISSUES_URL}/new?title=`)).toBe(true);
    expect(url).toContain(`title=${encodeURIComponent('[Bug] it broke')}`);
    expect(url).toContain('&labels=user-reported,bug&body=');
    const body = decodeBody(url);
    expect(body.startsWith('**Bug Description**\nsomething went wrong')).toBe(true);
    expect(body).toContain(
      `\n\n**Environment Info**\n- Platform: ${env.platform}\n- Terminal: ${env.terminal}\n- Version: `,
    );
    expect(body.endsWith(`- Feedback ID: fb-1234\n`)).toBe(true);
  });

  test('URL never embeds errors: no **Errors** section (raw or encoded), no json fence, 3-param signature', () => {
    // v287 drops the errors param entirely — the builder cannot receive them.
    expect(createGitHubIssueUrl.length).toBe(3);
    const url = createGitHubIssueUrl('fb-1', '[Bug] crash', 'it crashed\nwith details');
    expect(url).not.toContain('**Errors**');
    expect(url).not.toContain(encodeURIComponent('**Errors**'));
    expect(url).not.toContain(encodeURIComponent('```json'));
    expect(decodeBody(url)).not.toContain('**Errors**');
    // The old v286 truncation note is gone too (v286=3 / v287=0).
    expect(url).not.toContain(encodeURIComponent(V286_OLD_NOTE));
    expect(feedbackSource).not.toContain('Content was truncated');
  });

  test('under-budget description is preserved verbatim in the body', () => {
    const description = Array.from({ length: 40 }, (_, i) => `line ${i}: short detail`).join('\n');
    const url = createGitHubIssueUrl('fb-2', '[Bug] small', description);
    expect(decodeBody(url)).toContain(`**Bug Description**\n${description}\n\n**Environment Info**`);
    expect(url).not.toContain(encodeURIComponent(V287_NOTE));
    expect(url.length).toBeLessThanOrEqual(GITHUB_URL_LIMIT);
  });

  test('over-budget description is shortened at line boundaries and ends with the new v287 note', () => {
    const description = Array.from({ length: 1200 }, (_, i) => `line ${i}: ${'x'.repeat(60)} some-failing-module.ts:${i}`).join('\n');
    const url = createGitHubIssueUrl('fb-3', '[Bug] huge', description);
    // Whole URL fits the GitHub limit (official budget: X = Pt - f - _ - R,
    // truncated body leaves the 50-byte slack unspent).
    expect(url.length).toBeLessThanOrEqual(GITHUB_URL_LIMIT);
    const body = decodeBody(url); // must not throw → no %XX sequence was cut
    // Body ends with the note + the Environment Info footer (official f+_+b+R).
    expect(body).toContain(V287_NOTE + `\n\n**Environment Info**\n`);
    expect(body).not.toContain(V286_OLD_NOTE);
    // What survives before the note is a true line-boundary prefix of the
    // description (per-line encoded budget loop, separator-less concatenation).
    const header = '**Bug Description**\n';
    const kept = body.slice(header.length, body.indexOf(V287_NOTE));
    expect(description.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.endsWith('\n')).toBe(true);
    // Feedback ID still present after the note (official keeps R intact).
    expect(body.endsWith('- Feedback ID: fb-3\n')).toBe(true);
  });

  test('over-budget note string is byte-identical to the v287 recovery', () => {
    const description = 'y'.repeat(GITHUB_URL_LIMIT * 2);
    const url = createGitHubIssueUrl('fb-4', '[Bug] long single line', description);
    expect(url).toContain(encodeURIComponent(V287_NOTE));
    expect(feedbackSource).toContain(
      "**Note:** The description was shortened to fit GitHub's link length limit. The full description was sent to Anthropic with the feedback report; its Feedback ID is below.",
    );
  });

  test('consent screen source carries the byte-exact v287 Recent error messages row', () => {
    expect(feedbackSource).toContain(CONSENT_ROW_LABEL);
    expect(feedbackSource).toContain(CONSENT_ROW_DIM);
    // Row sits after the Session transcript row (official placement).
    const transcriptIdx = feedbackSource.indexOf('- Current session transcript');
    const rowIdx = feedbackSource.indexOf(CONSENT_ROW_LABEL);
    expect(transcriptIdx).toBeGreaterThan(0);
    expect(rowIdx).toBeGreaterThan(transcriptIdx);
    // dimColor applies to the second segment only (official e(n,{dimColor:!0,…})):
    // the dim wrapper opens after the label and wraps the dim string.
    const rowSlice = feedbackSource.slice(rowIdx, rowIdx + 400);
    expect(rowSlice.indexOf('dimColor')).toBeGreaterThan(0);
    expect(rowSlice.indexOf(CONSENT_ROW_DIM)).toBeGreaterThan(rowSlice.indexOf('dimColor'));
  });
});
