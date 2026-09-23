/**
 * Remote-review failure classification — ported from official Claude Code
 * v2.1.280 (changelog #053: "/ultrareview reporting a stopped cloud review
 * as completed or as an error to retry, and waiting out the full timeout
 * when its session was deleted or the signed-in account changed").
 *
 * Every string and branch below is byte-verified against
 * /tmp/cc-diff-280/v280/package/claude (offsets noted per function).
 * v2.1.278 has ZERO occurrences of "stopped_remotely" — this is new in 280.
 */

/**
 * Official failure-reason enum. String pool @97556972 lists:
 * no_review_output, orchestrator_error, poll_timeout,
 * poll_timeout_after_api_error, session_error, session_start_failed,
 * stopped_remotely. The message map (yG @200385650) and guidance map
 * (XMr @200389447) additionally handle session_archived, session_not_found
 * and cancelled — all ten are included so every reason yG can render is
 * representable.
 */
export const REMOTE_REVIEW_FAILURE_REASONS = ['no_review_output', 'orchestrator_error', 'poll_timeout', 'poll_timeout_after_api_error', 'session_error', 'session_start_failed', 'session_archived', 'session_not_found', 'stopped_remotely', 'cancelled'] as const;

export type RemoteReviewFailureReason = (typeof REMOTE_REVIEW_FAILURE_REASONS)[number];

/**
 * OCC keeps its fixed 30-minute review timeout. Official v280 reads a
 * configurable wait (sje @196332619: `client_wait_minutes` clamped to
 * 30..55, default 45) — config plumbing is out of scope for this file
 * (staged divergence); the message map takes the minutes as a parameter
 * exactly like yG does.
 */
export const REMOTE_REVIEW_TIMEOUT_MINUTES = 30;
export const REMOTE_REVIEW_TIMEOUT_MS = REMOTE_REVIEW_TIMEOUT_MINUTES * 60 * 1000;

/**
 * Consecutive-404 polls required before declaring session_not_found.
 * Official jFt poller header @200396881: `L=5` with poll interval `g=1000`.
 */
export const SESSION_NOT_FOUND_404_STREAK = 5;

/** Max chars of relayed orchestrator error text. Official Ioe: `re(s.replace(/[<>]/g,""),200)`. */
export const RELAYED_ERROR_MAX_CHARS = 200;

/**
 * Port of official yG @200385650 — reason → human-readable failure message.
 * `timeoutMinutes` mirrors yG's second arg: undefined renders "its wait".
 * Dashes are em dashes (—) verbatim from the binary.
 */
export function remoteReviewFailureMessage(reason: RemoteReviewFailureReason, timeoutMinutes?: number): string {
  const wait = timeoutMinutes !== undefined ? `${timeoutMinutes} minutes` : 'its wait';
  switch (reason) {
    case 'session_error':
      return 'cloud session returned an error';
    case 'poll_timeout':
      return `cloud session exceeded ${wait}`;
    case 'poll_timeout_after_api_error':
      return `cloud session exceeded ${wait} (API polls were failing)`;
    case 'no_review_output':
      return 'no review output — orchestrator may have exited early';
    case 'orchestrator_error':
      return 'orchestrator reported an error';
    case 'session_start_failed':
      return 'cloud session could not start';
    case 'session_archived':
      return 'cloud session was archived before producing output';
    case 'session_not_found':
      return 'cloud session was not found — it was deleted, or Claude Code is now signed in to a different account or organization than the one that started the review';
    case 'stopped_remotely':
      return 'cloud review was stopped before it finished';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * Port of official XMr @200389447 — reason → anti-retry / retry guidance
 * appended to the failure notification trailing text.
 *
 * The two non-retryable branches (stopped/archived, not-found) are verbatim
 * and command-agnostic. The retryable branch in the official binary says
 * "retry /code-review ultra, or use plain /code-review"; OCC's equivalent
 * commands are /ultrareview and /review, so the command NAMES are adapted
 * while the sentence structure stays official.
 */
export function remoteReviewFailureGuidance(reason: RemoteReviewFailureReason): string {
  switch (reason) {
    case 'session_archived':
    case 'stopped_remotely':
      return 'It was stopped from claude.ai or another Claude client, or ended by the server. Tell the user that plainly; they can run the review again if they did not stop it themselves. Do not start another review, cloud or local, unless the user asks.';
    case 'session_not_found':
      return 'Tell the user that plainly. If they signed in to a different account or organization, the review may still finish under the one that started it; signing back in as that account first and then resuming this conversation (claude --resume) re-attaches it if it is still there. Do not start another review, cloud or local, unless the user asks.';
    case 'session_error':
    case 'poll_timeout':
    case 'poll_timeout_after_api_error':
    case 'no_review_output':
    case 'orchestrator_error':
    case 'session_start_failed':
    case 'cancelled':
      return 'Tell the user to retry /ultrareview, or use /review for a local review instead.';
  }
}

/** Parsed shape of a <remote-review> payload that carries an error object. */
export type StoppedReviewPayload = {
  error: string;
  stopped: boolean;
};

/**
 * Port of official vnr @200386428 — parse review-tag content that is a JSON
 * error envelope. Returns null for ordinary (non-JSON) review text:
 *
 *   function vnr(e){try{let n=J(e);if(n&&typeof n==="object"&&
 *   !Array.isArray(n)){let{error:r,reason:s}=n;if(typeof r==="string")
 *   return{error:r,stopped:s==="stopped"}}}catch{}return null}
 *
 * (J is the official's guarded JSON.parse.) A payload with a string `error`
 * and reason==='stopped' means the user stopped the review from claude.ai or
 * another client; a string `error` with any other reason is an orchestrator
 * error whose text may be relayed to the model.
 */
export function parseStoppedReviewPayload(payload: string | null | undefined): StoppedReviewPayload | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { error, reason } = parsed as { error?: unknown; reason?: unknown };
      if (typeof error === 'string') {
        return { error, stopped: reason === 'stopped' };
      }
    }
  } catch {
    // Not JSON — normal successful review text.
  }
  return null;
}

export type HttpPollErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'other';

export type HttpPollErrorClassification = {
  kind: HttpPollErrorKind;
  status: number | undefined;
  message: string;
};

/**
 * Port of official $s @190592283 — classify an axios poll error:
 *
 *   401/403 → kind "auth"; ECONNABORTED → "timeout";
 *   ECONNREFUSED/ENOTFOUND → "network"; other axios → "http";
 *   non-axios → "other".
 *
 * The jFt catch block only consumes `.status===404` (404 arrives as kind
 * "http" with status 404). NOTE: 401/403 do NOT count toward the
 * session-not-found streak in the official binary — they reset it — so an
 * account change that surfaces as 404 is detected, while auth errors keep
 * polling toward poll_timeout_after_api_error.
 */
export function classifyHttpPollError(error: unknown): HttpPollErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object' || !('isAxiosError' in error) || !(error as { isAxiosError?: boolean }).isAxiosError) {
    return { kind: 'other', status: undefined, message };
  }
  const axiosError = error as { response?: { status?: number }; code?: string };
  const status = axiosError.response?.status;
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message };
  }
  if (axiosError.code === 'ECONNABORTED') {
    return { kind: 'timeout', status, message };
  }
  if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND') {
    return { kind: 'network', status, message };
  }
  return { kind: 'http', status, message };
}

/**
 * Port of official re @190617057 — truncate relayed error text to maxChars
 * (code units), dropping a trailing high surrogate so a surrogate pair is
 * never cut in half:
 *
 *   function re(e,n){if(n<=0)return"";if(e.length<=n)return e;
 *   let r=e.slice(0,n),i=r.charCodeAt(n-1);
 *   return Ie(i>=55296&&i<=56319?r.slice(0,-1):r)}
 *
 * The official wraps the result in Ie (an unidentified normalization
 * wrapper); ported WITHOUT it — staged, since its behavior could not be
 * byte-verified.
 */
export function truncateRelayedErrorText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(maxChars - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Port of the official failure-reason expression in the jFt success-path
 * classifier @200402274:
 *
 *   let Vr = Br!==null ? (Br.stopped ? "stopped_remotely" : "orchestrator_error")
 *          : (lr&&lr.subtype!=="success") ? "session_error"
 *          : (ur&&!yn) ? "poll_timeout" : "no_review_output";
 *
 * Br = stopped-payload parse of the review text, lr = last result event,
 * ur = timeout fired, yn = idle-completion signal. The stopped payload is
 * checked FIRST — it outranks a success result event, which is what keeps
 * the idle-completed path from marking a stopped review as completed.
 */
export function classifyReviewFailure(input: {
  /** parseStoppedReviewPayload() of the review-tag / fallback text. */
  stoppedPayload: StoppedReviewPayload | null;
  /** A result event exists with subtype !== 'success'. */
  resultFailed: boolean;
  /** The review timeout fired this tick. */
  timedOut: boolean;
  /** The stable-idle / tag-found completion signal fired this tick. */
  sessionDone: boolean;
}): RemoteReviewFailureReason {
  if (input.stoppedPayload !== null) {
    return input.stoppedPayload.stopped ? 'stopped_remotely' : 'orchestrator_error';
  }
  if (input.resultFailed) {
    return 'session_error';
  }
  if (input.timedOut && !input.sessionDone) {
    return 'poll_timeout';
  }
  return 'no_review_output';
}
