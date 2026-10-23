/**
 * CC 2.1.309 items 25/26/66 (OCC-131 WP-E) — feedback failure classifier,
 * org-refusal reason plumbing, and oversized-payload strip retry.
 *
 * Official symbols → OCC names (all byte-verified against BIN309):
 * - `As(status, data)`        @~258326955 → classifyFeedbackFailure
 * - `yxe(result)`             → orgRefusalMessage
 * - `CYt(result)`             → orgRefusalDisplayMessage
 * - `RYt(result)`             → credentialRefusalDisplayMessage
 * - `cCt(result)`             → serverStatusSuffix
 * - `l$o(message, refusal)`   @~244459786 → appendBugReportPointer
 * - `B3n()`                   → GITHUB_ISSUES_REPO_URL (pre-existing constant)
 * - `zne(command)`            → getFeedbackDisabledReason
 * - `Ld(command)`             @244460301 → getEnvDisabledReason
 * - `ou(message)`             @247249784 → normalizeServerMessage
 * - `xYt(payload, signal,…)`  @258339024 → postFeedback
 * - `Sxe({…})` panel retry    @258341400 → submitFeedback (strip-level retry)
 * - `_xe = 8388608`           → FEEDBACK_PAYLOAD_BUDGET_BYTES
 *
 * Item 66 ([VSCode] feedback error showed only HTTP status): OCC ships no
 * VSCode extension and no SDK submitFeedback control path — the portable
 * delta is the shared refusal-reason plumbing asserted here (the reason now
 * surfaces in every OCC feedback error render, not just the HTTP status).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Must be set before importing Feedback.tsx (MACRO.VERSION is read at import).
(globalThis as any).MACRO ??= { VERSION: '2.1.309', BUILD_TIME: 'test', BUILD_TARGET: 'test' };

const REAL_AXIOS_SNAPSHOT = { ...(await import('axios')) };
const REAL_AUTH_SNAPSHOT = { ...(await import('../../utils/auth.js')) };
const REAL_HTTP_SNAPSHOT = { ...(await import('../../utils/http.js')) };
const REAL_PRIVACY_SNAPSHOT = { ...(await import('../../utils/privacyLevel.js')) };
const REAL_POLICY_SNAPSHOT = { ...(await import('../../services/policyLimits/index.js')) };

type PostCall = { url: string; body: unknown };
const postCalls: PostCall[] = [];
let axiosPostImpl: (url: string, body: unknown) => Promise<{ status: number; data: unknown }>;

await mock.module('axios', () => ({
  ...REAL_AXIOS_SNAPSHOT,
  default: {
    post: async (url: string, body: unknown) => {
      postCalls.push({ url, body });
      return axiosPostImpl(url, body);
    },
    isCancel: (err: unknown) => Boolean(err) && (err as { __cancel?: boolean }).__cancel === true,
    isAxiosError: (err: unknown) =>
      Boolean(err) && (err as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

await mock.module('../../utils/auth.js', () => ({
  ...REAL_AUTH_SNAPSHOT,
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
}));

await mock.module('../../utils/http.js', () => ({
  ...REAL_HTTP_SNAPSHOT,
  getAuthHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } }),
  getUserAgent: () => 'occ-test-agent',
}));

let mockEssentialTrafficOnly = false;
await mock.module('../../utils/privacyLevel.js', () => ({
  ...REAL_PRIVACY_SNAPSHOT,
  isEssentialTrafficOnly: () => mockEssentialTrafficOnly,
}));

let mockPolicyAllowed = true;
await mock.module('../../services/policyLimits/index.js', () => ({
  ...REAL_POLICY_SNAPSHOT,
  isPolicyAllowed: () => mockPolicyAllowed,
}));

const {
  FEEDBACK_PAYLOAD_BUDGET_BYTES,
  ZDR_ORG_MESSAGE,
  POLICY_DISABLED_MESSAGE,
  appendBugReportPointer,
  buildFeedbackErrorMessage,
  classifyFeedbackFailure,
  credentialRefusalDisplayMessage,
  getFeedbackDisabledReason,
  normalizeServerMessage,
  orgRefusalDisplayMessage,
  orgRefusalMessage,
  postFeedback,
  serverStatusSuffix,
  submitFeedback,
} = await import('../Feedback.js');

const GITHUB_ISSUES_URL = 'https://github.com/anthropics/claude-code/issues';

function makeFeedbackData(overrides: Record<string, unknown> = {}): any {
  return {
    latestAssistantMessageId: null,
    message_count: 0,
    datetime: '2026-10-23T00:00:00.000Z',
    description: 'it broke',
    platform: 'linux',
    gitRepo: false,
    terminal: 'tmux',
    version: '2.1.309',
    transcript: [],
    errors: [],
    lastApiRequest: null,
    ...overrides,
  };
}

beforeEach(() => {
  postCalls.length = 0;
  mockEssentialTrafficOnly = false;
  mockPolicyAllowed = true;
  axiosPostImpl = async () => ({ status: 200, data: { feedback_id: 'fb-1' } });
  delete process.env.DISABLE_FEEDBACK_COMMAND;
  delete process.env.DISABLE_BUG_COMMAND;
});

afterAll(() => {
  // Restore real modules for later test files in this worker (OCC-97).
  mock.module('axios', () => ({ ...REAL_AXIOS_SNAPSHOT }));
  mock.module('../../utils/auth.js', () => ({ ...REAL_AUTH_SNAPSHOT }));
  mock.module('../../utils/http.js', () => ({ ...REAL_HTTP_SNAPSHOT }));
  mock.module('../../utils/privacyLevel.js', () => ({ ...REAL_PRIVACY_SNAPSHOT }));
  mock.module('../../services/policyLimits/index.js', () => ({ ...REAL_POLICY_SNAPSHOT }));
});

describe('classifyFeedbackFailure — official As(status, data) port', () => {
  test('error_code feedback_retention_blocked → zdr_org refusal with org kind + normalized serverMessage', () => {
    const result = classifyFeedbackFailure(403, {
      error: {
        type: 'permission_error',
        message: 'Retention blocked. ',
        details: { error_code: 'feedback_retention_blocked' },
      },
    });
    expect(result).toEqual({
      success: false,
      isZdrOrg: true,
      failureReason: 'zdr_org',
      statusCode: 403,
      refusal: { kind: 'org', serverMessage: 'Retention blocked.' },
    });
  });

  test('legacy ZDR shape (no error_code, 403 permission_error + "Custom data retention settings") → zdr_org', () => {
    const result = classifyFeedbackFailure(403, {
      error: { type: 'permission_error', message: 'Custom data retention settings are enabled' },
    });
    expect(result.success).toBe(false);
    expect(result.isZdrOrg).toBe(true);
    expect(result.failureReason).toBe('zdr_org');
    expect(result.refusal?.kind).toBe('org');
  });

  test('error_code feedback_disabled → org_refused with org refusal', () => {
    const result = classifyFeedbackFailure(403, {
      error: {
        message: 'Feedback has not been enabled for your organization.',
        details: { error_code: 'feedback_disabled' },
      },
    });
    expect(result.failureReason).toBe('org_refused');
    expect(result.refusal).toEqual({
      kind: 'org',
      serverMessage: 'Feedback has not been enabled for your organization.',
    });
  });

  test('error_code present but status/message mismatch → still classified by error_code', () => {
    const result = classifyFeedbackFailure(400, {
      error: { message: 'whatever', details: { error_code: 'feedback_disabled' } },
    });
    expect(result.failureReason).toBe('org_refused');
  });

  test('legacy 403 with exact "Feedback has not been enabled for your organization." message (no error_code) → org_refused', () => {
    const result = classifyFeedbackFailure(403, {
      error: { message: 'Feedback has not been enabled for your organization.' },
    });
    expect(result.failureReason).toBe('org_refused');
    expect(result.refusal?.kind).toBe('org');
  });

  test('legacy 403 with exact policy-disabled message (no error_code) → org_refused', () => {
    const result = classifyFeedbackFailure(403, {
      error: { message: "Feedback submission is disabled by your organization's policy." },
    });
    expect(result.failureReason).toBe('org_refused');
  });

  test('feedback_third_party_blocked with matching message → org_refused + reportContent marker', () => {
    const result = classifyFeedbackFailure(403, {
      error: {
        message: 'Feedback containing third-party provider content cannot be submitted.',
        details: { error_code: 'feedback_third_party_blocked' },
      },
    });
    expect(result.failureReason).toBe('org_refused');
    expect(result.refusal).toEqual({
      kind: 'org',
      serverMessage: 'Feedback containing third-party provider content cannot be submitted.',
      reportContent: true,
    });
  });

  test('oauth_scope_insufficient → scope_refused with credential refusal', () => {
    const result = classifyFeedbackFailure(403, {
      error: { message: 'Scope missing', details: { error_code: 'oauth_scope_insufficient' } },
    });
    expect(result.failureReason).toBe('scope_refused');
    expect(result.refusal).toEqual({ kind: 'credential', serverMessage: 'Scope missing' });
  });

  test('401 without error_code → auth_refused with credential refusal', () => {
    const result = classifyFeedbackFailure(401, { error: { message: 'Unauthorized' } });
    expect(result.failureReason).toBe('auth_refused');
    expect(result.refusal?.kind).toBe('credential');
  });

  test('feedback_check_unavailable / 408 / 429 / 5xx → http_error with transient refusal', () => {
    for (const [status, data] of [
      [408, {}],
      [429, {}],
      [500, {}],
      [529, {}],
      [403, { error: { message: 'x', details: { error_code: 'feedback_check_unavailable' } } }],
    ] as Array<[number, unknown]>) {
      const result = classifyFeedbackFailure(status, data);
      expect(result.failureReason).toBe('http_error');
      expect(result.refusal?.kind).toBe('transient');
    }
  });

  test('other statuses (e.g. 404) → http_error with "other" refusal', () => {
    const result = classifyFeedbackFailure(404, { error: { message: 'nope' } });
    expect(result.failureReason).toBe('http_error');
    expect(result.refusal?.kind).toBe('other');
  });

  test('unparseable body → no serverMessage; classification still by status', () => {
    const result = classifyFeedbackFailure(500, 'not-json');
    expect(result.failureReason).toBe('http_error');
    expect(result.refusal).toEqual({ kind: 'transient' });
  });
});

describe('normalizeServerMessage — official ou() port', () => {
  test('undefined → undefined', () => {
    expect(normalizeServerMessage(undefined)).toBeUndefined();
  });

  test('invisible/format characters replaced with space, whitespace collapsed + trimmed', () => {
    expect(normalizeServerMessage('a​ b   c\n\td')).toBe('a b c d');
  });

  test('empty / whitespace-only → undefined', () => {
    expect(normalizeServerMessage('   ')).toBeUndefined();
    expect(normalizeServerMessage('')).toBeUndefined();
  });

  test('long messages capped at 200 chars', () => {
    const normalized = normalizeServerMessage('x'.repeat(5000));
    expect(normalized).toBe('x'.repeat(200));
  });
});

describe('refusal message builders — official yxe/CYt/RYt/cCt/l$o ports', () => {
  test('yxe: zdr_org → verbatim ZDR message', () => {
    expect(orgRefusalMessage({ success: false, isZdrOrg: true })).toBe(ZDR_ORG_MESSAGE);
    expect(ZDR_ORG_MESSAGE).toBe(
      'Feedback collection is not available for organizations with custom data retention policies.',
    );
  });

  test('yxe: org refusal with serverMessage → serverMessage', () => {
    expect(
      orgRefusalMessage({
        success: false,
        refusal: { kind: 'org', serverMessage: 'Org says no.' },
      }),
    ).toBe('Org says no.');
  });

  test('yxe: org refusal without serverMessage → "Your organization does not accept feedback."', () => {
    expect(orgRefusalMessage({ success: false, refusal: { kind: 'org' } })).toBe(
      'Your organization does not accept feedback.',
    );
  });

  test('yxe: non-org refusal → undefined', () => {
    expect(
      orgRefusalMessage({ success: false, refusal: { kind: 'credential', serverMessage: 'x' } }),
    ).toBeUndefined();
    expect(orgRefusalMessage({ success: false })).toBeUndefined();
  });

  test('CYt: org message gets "Couldn\'t send feedback: " prefix + bug-report pointer', () => {
    expect(
      orgRefusalDisplayMessage({
        success: false,
        refusal: { kind: 'org', serverMessage: 'Org says no' },
      }),
    ).toBe(
      `Couldn't send feedback: Org says no. To report a bug, open an issue at ${GITHUB_ISSUES_URL}. Issues are public, so leave out anything confidential.`,
    );
  });

  test('CYt: non-org → undefined', () => {
    expect(credentialRefusalDisplayMessage({ success: false, refusal: { kind: 'org' } })).toBeUndefined();
    expect(orgRefusalDisplayMessage({ success: false, failureReason: 'timeout' })).toBeUndefined();
  });

  test('RYt: scope_refused → verbatim sign-in message with status suffix', () => {
    expect(
      credentialRefusalDisplayMessage({
        success: false,
        failureReason: 'scope_refused',
        statusCode: 403,
        refusal: { kind: 'credential', serverMessage: 'Missing scope.' },
      }),
    ).toBe(
      "Couldn't send feedback: the sign-in this session uses is not allowed to send feedback (server returned 403: Missing scope).",
    );
  });

  test('RYt: auth_refused → verbatim credentials message; trailing period stripped inside suffix', () => {
    expect(
      credentialRefusalDisplayMessage({
        success: false,
        failureReason: 'auth_refused',
        statusCode: 401,
        refusal: { kind: 'credential', serverMessage: 'Bad token.' },
      }),
    ).toBe(
      "Couldn't send feedback: the server did not accept the credentials this session uses (server returned 401: Bad token).",
    );
  });

  test('RYt: no serverMessage, no status → suffix omitted entirely', () => {
    expect(
      credentialRefusalDisplayMessage({
        success: false,
        failureReason: 'auth_refused',
        refusal: { kind: 'credential' },
      }),
    ).toBe("Couldn't send feedback: the server did not accept the credentials this session uses.");
  });

  test('RYt: non-credential refusal → undefined', () => {
    expect(
      credentialRefusalDisplayMessage({
        success: false,
        failureReason: 'http_error',
        refusal: { kind: 'transient' },
      }),
    ).toBeUndefined();
  });

  test('cCt: " (server returned NNN)" without serverMessage; undefined without status', () => {
    expect(serverStatusSuffix({ success: false, statusCode: 500 })).toBe(' (server returned 500)');
    expect(serverStatusSuffix({ success: false })).toBeUndefined();
  });

  test('l$o: appends pointer, adds period when missing, suppresses for the policy-disabled message', () => {
    expect(appendBugReportPointer('Blocked')).toBe(
      `Blocked. To report a bug, open an issue at ${GITHUB_ISSUES_URL}. Issues are public, so leave out anything confidential.`,
    );
    expect(appendBugReportPointer('Blocked.')).toBe(
      `Blocked. To report a bug, open an issue at ${GITHUB_ISSUES_URL}. Issues are public, so leave out anything confidential.`,
    );
    expect(appendBugReportPointer(POLICY_DISABLED_MESSAGE, POLICY_DISABLED_MESSAGE)).toBe(
      POLICY_DISABLED_MESSAGE,
    );
  });
});

describe('getFeedbackDisabledReason — official zne()/Ld() port', () => {
  test('DISABLE_FEEDBACK_COMMAND → verbatim env message', () => {
    process.env.DISABLE_FEEDBACK_COMMAND = '1';
    expect(getFeedbackDisabledReason('/feedback')).toBe(
      '/feedback has been disabled via the DISABLE_FEEDBACK_COMMAND environment variable',
    );
  });

  test('DISABLE_BUG_COMMAND → verbatim env message', () => {
    process.env.DISABLE_BUG_COMMAND = '1';
    expect(getFeedbackDisabledReason('/feedback')).toBe(
      '/feedback has been disabled via the DISABLE_BUG_COMMAND environment variable',
    );
  });

  test('policy denied → "<command> is disabled by your organization\'s policy." + pointer', () => {
    mockPolicyAllowed = false;
    expect(getFeedbackDisabledReason('/feedback')).toBe(
      `/feedback is disabled by your organization's policy. To report a bug, open an issue at ${GITHUB_ISSUES_URL}. Issues are public, so leave out anything confidential.`,
    );
  });

  test('nothing disabled → null', () => {
    expect(getFeedbackDisabledReason('/feedback')).toBeNull();
  });
});

describe('buildFeedbackErrorMessage — official panel UI error chain', () => {
  test('org refusal → message + isFinal true (retry disabled), except reportContent', () => {
    const org = buildFeedbackErrorMessage({
      success: false,
      failureReason: 'org_refused',
      statusCode: 403,
      refusal: { kind: 'org', serverMessage: 'Org says no' },
    });
    expect(org.isFinal).toBe(true);
    expect(org.message).toContain("Couldn't send feedback: Org says no.");

    const reportContent = buildFeedbackErrorMessage({
      success: false,
      failureReason: 'org_refused',
      refusal: {
        kind: 'org',
        serverMessage: 'Feedback containing third-party provider content cannot be submitted.',
        reportContent: true,
      },
    });
    expect(reportContent.isFinal).toBe(false);
  });

  test('zdr_org → verbatim ZDR message, isFinal true', () => {
    const result = buildFeedbackErrorMessage({
      success: false,
      isZdrOrg: true,
      failureReason: 'zdr_org',
      refusal: { kind: 'org' },
    });
    expect(result.message).toContain(ZDR_ORG_MESSAGE);
    expect(result.isFinal).toBe(true);
  });

  test('credential refusal → RYt message, isFinal false', () => {
    const result = buildFeedbackErrorMessage({
      success: false,
      failureReason: 'scope_refused',
      statusCode: 403,
      refusal: { kind: 'credential', serverMessage: 'No scope' },
    });
    expect(result.isFinal).toBe(false);
    expect(result.message).toBe(
      "Couldn't send feedback: the sign-in this session uses is not allowed to send feedback (server returned 403: No scope).",
    );
  });

  test('auth_error → verbatim not-signed-in message', () => {
    expect(buildFeedbackErrorMessage({ success: false, failureReason: 'auth_error' }).message).toBe(
      "Couldn't send feedback: not signed in. Run /login, then retry.",
    );
  });

  test('policy_blocked → zne reason or generic fallback', () => {
    mockPolicyAllowed = false;
    expect(buildFeedbackErrorMessage({ success: false, failureReason: 'policy_blocked' }).message).toBe(
      `/feedback is disabled by your organization's policy. To report a bug, open an issue at ${GITHUB_ISSUES_URL}. Issues are public, so leave out anything confidential.`,
    );
    mockPolicyAllowed = true;
    expect(buildFeedbackErrorMessage({ success: false, failureReason: 'policy_blocked' }).message).toBe(
      'Feedback is disabled by your organization\'s policy.',
    );
  });

  test('generic http_error → status suffix + GitHub file-at pointer', () => {
    const result = buildFeedbackErrorMessage({
      success: false,
      failureReason: 'http_error',
      statusCode: 500,
      refusal: { kind: 'transient', serverMessage: 'Internal failure.' },
    });
    expect(result.message).toBe(
      `Couldn't send feedback (server returned 500: Internal failure). If it keeps failing, you can file at ${GITHUB_ISSUES_URL} instead.`,
    );
    expect(result.isFinal).toBe(false);
  });

  test('timeout / network_error suffixes', () => {
    expect(buildFeedbackErrorMessage({ success: false, failureReason: 'timeout' }).message).toBe(
      `Couldn't send feedback (request timed out). If it keeps failing, you can file at ${GITHUB_ISSUES_URL} instead.`,
    );
    expect(buildFeedbackErrorMessage({ success: false, failureReason: 'network_error' }).message).toBe(
      `Couldn't send feedback (couldn't reach the service). If it keeps failing, you can file at ${GITHUB_ISSUES_URL} instead.`,
    );
  });
});

describe('postFeedback — official xYt() single-attempt port', () => {
  test('essential-traffic-only → bare failure before any POST', async () => {
    mockEssentialTrafficOnly = true;
    const result = await postFeedback(makeFeedbackData());
    expect(result).toEqual({ success: false });
    expect(postCalls.length).toBe(0);
  });

  test('policy blocked → failureReason policy_blocked before any POST', async () => {
    mockPolicyAllowed = false;
    const result = await postFeedback(makeFeedbackData());
    expect(result).toEqual({ success: false, failureReason: 'policy_blocked' });
    expect(postCalls.length).toBe(0);
  });

  test('oversized payload → payload_too_large_precheck without POSTing (budget 8388608)', async () => {
    expect(FEEDBACK_PAYLOAD_BUDGET_BYTES).toBe(8388608);
    const result = await postFeedback(
      makeFeedbackData({ description: 'x'.repeat(FEEDBACK_PAYLOAD_BUDGET_BYTES + 1) }),
    );
    expect(result).toEqual({
      success: false,
      payloadTooLarge: true,
      failureReason: 'payload_too_large_precheck',
    });
    expect(postCalls.length).toBe(0);
  });

  test('200 + feedback_id → success; 200 without id → missing_feedback_id', async () => {
    expect(await postFeedback(makeFeedbackData())).toEqual({ success: true, feedbackId: 'fb-1' });
    axiosPostImpl = async () => ({ status: 200, data: {} });
    expect(await postFeedback(makeFeedbackData())).toEqual({
      success: false,
      failureReason: 'missing_feedback_id',
    });
  });

  test('413 response → payload_too_large_413 with statusCode', async () => {
    axiosPostImpl = async () => ({ status: 413, data: {} });
    expect(await postFeedback(makeFeedbackData())).toEqual({
      success: false,
      payloadTooLarge: true,
      failureReason: 'payload_too_large_413',
      statusCode: 413,
    });
  });

  test('403 org-disabled body → classifyFeedbackFailure result (org_refused + refusal)', async () => {
    axiosPostImpl = async () => ({
      status: 403,
      data: {
        error: {
          message: 'Feedback has not been enabled for your organization.',
          details: { error_code: 'feedback_disabled' },
        },
      },
    });
    const result = await postFeedback(makeFeedbackData());
    expect(result.failureReason).toBe('org_refused');
    expect(result.refusal?.kind).toBe('org');
    expect(result.refusal?.serverMessage).toBe(
      'Feedback has not been enabled for your organization.',
    );
  });

  test('POST uses timeout 30000 and validateStatus that only rejects 401', async () => {
    let capturedConfig: any;
    await mock.module('axios', () => ({
      ...REAL_AXIOS_SNAPSHOT,
      default: {
        post: async (_url: string, _body: unknown, config: unknown) => {
          capturedConfig = config;
          return { status: 200, data: { feedback_id: 'fb-1' } };
        },
        isCancel: () => false,
        isAxiosError: () => false,
      },
    }));
    await postFeedback(makeFeedbackData());
    expect(capturedConfig.timeout).toBe(30000);
    expect(capturedConfig.validateStatus(200)).toBe(true);
    expect(capturedConfig.validateStatus(403)).toBe(true);
    expect(capturedConfig.validateStatus(401)).toBe(false);
    // Restore the call-capturing mock for the remaining tests in this file.
    await mock.module('axios', () => ({
      ...REAL_AXIOS_SNAPSHOT,
      default: {
        post: async (url: string, body: unknown) => {
          postCalls.push({ url, body });
          return axiosPostImpl(url, body);
        },
        isCancel: (err: unknown) => Boolean(err) && (err as { __cancel?: boolean }).__cancel === true,
        isAxiosError: (err: unknown) =>
          Boolean(err) && (err as { isAxiosError?: boolean }).isAxiosError === true,
      },
    }));
  });

  test('network error without response → network_error; ECONNABORTED → timeout', async () => {
    axiosPostImpl = async () => {
      throw { isAxiosError: true, message: 'boom' };
    };
    expect(await postFeedback(makeFeedbackData())).toEqual({
      success: false,
      failureReason: 'network_error',
    });
    axiosPostImpl = async () => {
      throw { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' };
    };
    expect(await postFeedback(makeFeedbackData())).toEqual({
      success: false,
      failureReason: 'timeout',
    });
  });

  test('ECONNABORTED with payload over budget/8 → payload_too_large_timeout', async () => {
    axiosPostImpl = async () => {
      throw { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' };
    };
    const result = await postFeedback(
      makeFeedbackData({ description: 'x'.repeat(Math.floor(FEEDBACK_PAYLOAD_BUDGET_BYTES / 8) + 1) }),
    );
    expect(result).toEqual({
      success: false,
      payloadTooLarge: true,
      failureReason: 'payload_too_large_timeout',
    });
  });

  test('cancelled request → bare failure', async () => {
    axiosPostImpl = async () => {
      throw { __cancel: true };
    };
    expect(await postFeedback(makeFeedbackData())).toEqual({ success: false });
  });
});

describe('submitFeedback — official Sxe strip-level retry port', () => {
  test('first attempt succeeds → success, no retry', async () => {
    const result = await submitFeedback(makeFeedbackData());
    expect(result).toEqual({ success: true, feedbackId: 'fb-1', retriedAfterTooLarge: false });
    expect(postCalls.length).toBe(1);
  });

  test('413 then success → transcript emptied, subagentTranscripts/lastApiRequest stripped, rawTranscriptJsonl kept', async () => {
    axiosPostImpl = async () => {
      if (postCalls.length === 1) return { status: 413, data: {} };
      return { status: 200, data: { feedback_id: 'fb-2' } };
    };
    const result = await submitFeedback(
      makeFeedbackData({
        transcript: [{ role: 'user', content: 'hi' }],
        subagentTranscripts: { a: [{ role: 'user', content: 'x' }] },
        lastApiRequest: { big: true },
        rawTranscriptJsonl: '{"raw":true}',
      }),
    );
    expect(result).toEqual({ success: true, feedbackId: 'fb-2', retriedAfterTooLarge: true });
    expect(postCalls.length).toBe(2);
    const retryContent = JSON.parse((postCalls[1].body as any).content);
    expect(retryContent.transcript).toEqual([]);
    expect(retryContent.subagentTranscripts).toBeUndefined();
    expect(retryContent.lastApiRequest).toBeUndefined();
    expect(retryContent.rawTranscriptJsonl).toBe('{"raw":true}');
    expect(retryContent.description).toBe('it broke');
  });

  test('two consecutive too-large failures → level-2 retry also drops rawTranscriptJsonl', async () => {
    axiosPostImpl = async () => {
      if (postCalls.length <= 2) return { status: 413, data: {} };
      return { status: 200, data: { feedback_id: 'fb-3' } };
    };
    const result = await submitFeedback(
      makeFeedbackData({
        transcript: [{ role: 'user', content: 'hi' }],
        rawTranscriptJsonl: '{"raw":true}',
      }),
    );
    expect(result).toEqual({ success: true, feedbackId: 'fb-3', retriedAfterTooLarge: true });
    expect(postCalls.length).toBe(3);
    const level2Content = JSON.parse((postCalls[2].body as any).content);
    expect(level2Content.transcript).toEqual([]);
    expect(level2Content.rawTranscriptJsonl).toBeUndefined();
  });

  test('all attempts too large → failure passes through classifier fields', async () => {
    axiosPostImpl = async () => ({ status: 413, data: {} });
    const result = await submitFeedback(makeFeedbackData());
    expect(result).toEqual({
      success: false,
      isZdrOrg: undefined,
      failureReason: 'payload_too_large_413',
      statusCode: 413,
      refusal: undefined,
    });
    expect(postCalls.length).toBe(3);
  });

  test('non-too-large failure → no retry, refusal plumbed to caller (item 25/66)', async () => {
    axiosPostImpl = async () => ({
      status: 403,
      data: { error: { message: 'Org says no', details: { error_code: 'feedback_disabled' } } },
    });
    const result = await submitFeedback(makeFeedbackData());
    expect(postCalls.length).toBe(1);
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('org_refused');
    expect(result.refusal).toEqual({ kind: 'org', serverMessage: 'Org says no' });
    expect(result.statusCode).toBe(403);
  });
});
