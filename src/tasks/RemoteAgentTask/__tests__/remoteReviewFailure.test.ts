import { describe, expect, test } from 'bun:test';
import { classifyHttpPollError, classifyReviewFailure, parseStoppedReviewPayload, remoteReviewFailureGuidance, remoteReviewFailureMessage, truncateRelayedErrorText, REMOTE_REVIEW_FAILURE_REASONS, type RemoteReviewFailureReason } from '../remoteReviewFailure.js';

// CC 2.1.280 #053 — byte-verified ports of yG (@200385650), XMr (@200389447),
// vnr (@200386428), $s (@190592283), re (@190617057) and the jFt success-path
// failure classifier (@200402274). Every expected string below is verbatim
// from the official binary (em dashes are the binary's —).

const EM_DASH = '—';

describe('remoteReviewFailureMessage (yG port) — exact official wording', () => {
  test('renders every reason in the enum with the timeout minutes', () => {
    expect(remoteReviewFailureMessage('session_error', 30)).toBe('cloud session returned an error');
    expect(remoteReviewFailureMessage('poll_timeout', 30)).toBe('cloud session exceeded 30 minutes');
    expect(remoteReviewFailureMessage('poll_timeout_after_api_error', 30)).toBe('cloud session exceeded 30 minutes (API polls were failing)');
    expect(remoteReviewFailureMessage('no_review_output', 30)).toBe(`no review output ${EM_DASH} orchestrator may have exited early`);
    expect(remoteReviewFailureMessage('orchestrator_error', 30)).toBe('orchestrator reported an error');
    expect(remoteReviewFailureMessage('session_start_failed', 30)).toBe('cloud session could not start');
    expect(remoteReviewFailureMessage('session_archived', 30)).toBe('cloud session was archived before producing output');
    expect(remoteReviewFailureMessage('session_not_found', 30)).toBe(`cloud session was not found ${EM_DASH} it was deleted, or Claude Code is now signed in to a different account or organization than the one that started the review`);
    expect(remoteReviewFailureMessage('stopped_remotely', 30)).toBe('cloud review was stopped before it finished');
    expect(remoteReviewFailureMessage('cancelled', 30)).toBe('cancelled');
  });

  test('undefined timeoutMinutes renders "its wait" (yG default branch)', () => {
    expect(remoteReviewFailureMessage('poll_timeout')).toBe('cloud session exceeded its wait');
    expect(remoteReviewFailureMessage('poll_timeout_after_api_error')).toBe('cloud session exceeded its wait (API polls were failing)');
  });

  test('the enum covers exactly the ten reasons yG handles', () => {
    expect(REMOTE_REVIEW_FAILURE_REASONS).toHaveLength(10);
    for (const reason of REMOTE_REVIEW_FAILURE_REASONS) {
      expect(remoteReviewFailureMessage(reason, 30).length).toBeGreaterThan(0);
      expect(remoteReviewFailureGuidance(reason).length).toBeGreaterThan(0);
    }
  });
});

describe('remoteReviewFailureGuidance (XMr port) — anti-retry vs retry branches', () => {
  test('stopped_remotely and session_archived get the non-retryable stopped guidance', () => {
    const expected = 'It was stopped from claude.ai or another Claude client, or ended by the server. Tell the user that plainly; they can run the review again if they did not stop it themselves. Do not start another review, cloud or local, unless the user asks.';
    expect(remoteReviewFailureGuidance('stopped_remotely')).toBe(expected);
    expect(remoteReviewFailureGuidance('session_archived')).toBe(expected);
  });

  test('session_not_found gets the account/resume guidance', () => {
    expect(remoteReviewFailureGuidance('session_not_found')).toBe('Tell the user that plainly. If they signed in to a different account or organization, the review may still finish under the one that started it; signing back in as that account first and then resuming this conversation (claude --resume) re-attaches it if it is still there. Do not start another review, cloud or local, unless the user asks.');
  });

  test('all remaining reasons get the retry guidance (OCC command names)', () => {
    const retryable: RemoteReviewFailureReason[] = ['session_error', 'poll_timeout', 'poll_timeout_after_api_error', 'no_review_output', 'orchestrator_error', 'session_start_failed', 'cancelled'];
    for (const reason of retryable) {
      expect(remoteReviewFailureGuidance(reason)).toBe('Tell the user to retry /ultrareview, or use /review for a local review instead.');
    }
  });
});

describe('parseStoppedReviewPayload (vnr port)', () => {
  test('stopped payload parses to {error, stopped: true}', () => {
    expect(parseStoppedReviewPayload('{"error":"stopped by user","reason":"stopped"}')).toEqual({
      error: 'stopped by user',
      stopped: true
    });
  });

  test('error with a non-stopped reason parses to {error, stopped: false}', () => {
    expect(parseStoppedReviewPayload('{"error":"boom","reason":"crashed"}')).toEqual({
      error: 'boom',
      stopped: false
    });
  });

  test('error with no reason field is stopped: false', () => {
    expect(parseStoppedReviewPayload('{"error":"boom"}')).toEqual({
      error: 'boom',
      stopped: false
    });
  });

  test('ordinary non-JSON review text returns null', () => {
    expect(parseStoppedReviewPayload('Found 2 bugs:\n- null deref in foo.ts')).toBeNull();
  });

  test('JSON without a string error returns null', () => {
    expect(parseStoppedReviewPayload('{"reason":"stopped"}')).toBeNull();
    expect(parseStoppedReviewPayload('{"error":42,"reason":"stopped"}')).toBeNull();
  });

  test('JSON arrays return null (vnr: !Array.isArray guard)', () => {
    expect(parseStoppedReviewPayload('[{"error":"x","reason":"stopped"}]')).toBeNull();
  });

  test('null / undefined input returns null', () => {
    expect(parseStoppedReviewPayload(null)).toBeNull();
    expect(parseStoppedReviewPayload(undefined)).toBeNull();
  });
});

describe('classifyHttpPollError ($s port)', () => {
  // Real AxiosError subclasses Error — mirror that so message extraction
  // (`error instanceof Error ? error.message : ...`) sees the real shape.
  const axiosError = (status?: number, code?: string): unknown => Object.assign(new Error(`Request failed (${status ?? code})`), {
    isAxiosError: true,
    name: 'AxiosError',
    response: status === undefined ? undefined : { status },
    code
  });

  test('404 is kind http with status 404 (the session-not-found signal)', () => {
    expect(classifyHttpPollError(axiosError(404))).toEqual({
      kind: 'http',
      status: 404,
      message: 'Request failed (404)'
    });
  });

  test('403 and 401 are kind auth — they do NOT carry status 404', () => {
    expect(classifyHttpPollError(axiosError(403))).toEqual({
      kind: 'auth',
      status: 403,
      message: 'Request failed (403)'
    });
    expect(classifyHttpPollError(axiosError(401)).kind).toBe('auth');
  });

  test('ECONNABORTED is timeout; ECONNREFUSED/ENOTFOUND are network', () => {
    expect(classifyHttpPollError(axiosError(undefined, 'ECONNABORTED')).kind).toBe('timeout');
    expect(classifyHttpPollError(axiosError(undefined, 'ECONNREFUSED')).kind).toBe('network');
    expect(classifyHttpPollError(axiosError(undefined, 'ENOTFOUND')).kind).toBe('network');
  });

  test('non-axios errors are kind other with no status', () => {
    expect(classifyHttpPollError(new Error('socket hang up'))).toEqual({
      kind: 'other',
      status: undefined,
      message: 'socket hang up'
    });
    expect(classifyHttpPollError('string failure').kind).toBe('other');
    expect(classifyHttpPollError(null).kind).toBe('other');
  });
});

describe('truncateRelayedErrorText (re port)', () => {
  test('text at or under the limit passes through', () => {
    expect(truncateRelayedErrorText('abc', 3)).toBe('abc');
    expect(truncateRelayedErrorText('abc', 10)).toBe('abc');
  });

  test('non-positive limit returns empty string', () => {
    expect(truncateRelayedErrorText('abc', 0)).toBe('');
    expect(truncateRelayedErrorText('abc', -1)).toBe('');
  });

  test('truncates to maxChars code units', () => {
    expect(truncateRelayedErrorText('abcdef', 3)).toBe('abc');
  });

  test('drops a trailing high surrogate so pairs are never cut in half', () => {
    // 'a' + U+1F600 (D83D DE00) — limit 2 would cut between the surrogates.
    const text = 'a😀b';
    expect(truncateRelayedErrorText(text, 2)).toBe('a');
    // Limit 3 keeps the full pair.
    expect(truncateRelayedErrorText(text, 3)).toBe('a😀');
  });
});

describe('classifyReviewFailure (official Vr expression port) — precedence', () => {
  const base = {
    stoppedPayload: null,
    resultFailed: false,
    timedOut: false,
    sessionDone: false
  };

  test('stopped payload outranks everything → stopped_remotely', () => {
    expect(classifyReviewFailure({
      ...base,
      stoppedPayload: { error: 'x', stopped: true },
      resultFailed: true,
      timedOut: true
    })).toBe('stopped_remotely');
  });

  test('non-stopped error payload → orchestrator_error (outranks result/timeout)', () => {
    expect(classifyReviewFailure({
      ...base,
      stoppedPayload: { error: 'boom', stopped: false },
      resultFailed: true
    })).toBe('orchestrator_error');
  });

  test('failed result event → session_error', () => {
    expect(classifyReviewFailure({ ...base, resultFailed: true })).toBe('session_error');
  });

  test('timeout without idle-done → poll_timeout', () => {
    expect(classifyReviewFailure({ ...base, timedOut: true })).toBe('poll_timeout');
  });

  test('timeout WITH idle-done → no_review_output (official ur&&!yn guard)', () => {
    expect(classifyReviewFailure({ ...base, timedOut: true, sessionDone: true })).toBe('no_review_output');
  });

  test('nothing fired → no_review_output', () => {
    expect(classifyReviewFailure(base)).toBe('no_review_output');
  });
});
