import axios from 'axios';
import { readFile, stat } from 'fs/promises';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { getLastAPIRequest } from 'src/bootstrap/state.js';
import { logEventTo1P } from 'src/services/analytics/firstPartyEventLogger.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { isPolicyAllowed } from 'src/services/policyLimits/index.js';
import { getLastAssistantMessage, normalizeMessagesForAPI } from 'src/utils/messages.js';
import type { CommandResultDisplay } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, useInput } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { queryHaiku } from '../services/api/claude.js';
import { startsWithApiErrorPrefix } from '../services/api/errors.js';
import type { Message } from '../types/message.js';
import { checkAndRefreshOAuthTokenIfNeeded } from '../utils/auth.js';
import { openBrowser } from '../utils/browser.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { type GitRepoState, getGitState, getIsGit } from '../utils/git.js';
import { getAuthHeaders, getUserAgent } from '../utils/http.js';
import { getInMemoryErrors, logError } from '../utils/log.js';
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js';
import { extractTeammateTranscriptsFromTasks, getTranscriptPath, loadAllSubagentTranscriptsFromDisk, MAX_TRANSCRIPT_READ_BYTES } from '../utils/sessionStorage.js';
import { jsonStringify } from '../utils/slowOperations.js';
import { redactSecrets } from '../utils/secretRedaction/index.js';
import { asSystemPrompt } from '../utils/systemPromptType.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import TextInput from './TextInput.js';

// This value was determined experimentally by testing the URL length limit
const GITHUB_URL_LIMIT = 7250;
const GITHUB_ISSUES_REPO_URL = ("external" as string) === 'ant' ? 'https://github.com/anthropics/claude-cli-internal/issues' : 'https://github.com/anthropics/claude-code/issues';

// ---------------------------------------------------------------------------
// CC 2.1.309 items 25/26/66 (OCC-131 WP-E) — feedback failure classifier +
// refusal-reason plumbing + oversized-payload strip retry.
//
// Official symbol → OCC name map (BIN309 byte offsets; all user-facing
// strings byte-verbatim):
//   `Ur`  → ORG_NOT_ENABLED_MESSAGE          @~258326955
//   `Dr`  → THIRD_PARTY_BLOCKED_MESSAGE      @~258326955
//   `Br`  → ZDR_ORG_MESSAGE                  @~258326955
//   `a$o` → POLICY_DISABLED_MESSAGE          @244459946
//   `As`  → classifyFeedbackFailure          @~258326955
//   `Or`  → FeedbackErrorBodySchema          @~258326955
//   `ou`  → normalizeServerMessage           @247249784
//   `yxe` → orgRefusalMessage                @~258326955
//   `CYt` → orgRefusalDisplayMessage         @~258326955
//   `RYt` → credentialRefusalDisplayMessage  @~258326955
//   `cCt` → serverStatusSuffix               @~258326955
//   `l$o` → appendBugReportPointer           @244460015
//   `B3n` → GITHUB_ISSUES_REPO_URL (pre-existing OCC constant, same value)
//   `zne` → getFeedbackDisabledReason        @~244460400
//   `Ld`  → getEnvDisabledReason             @244460301
//   `Qg`  → inline in getFeedbackDisabledReason
//   `_xe` → FEEDBACK_PAYLOAD_BUDGET_BYTES    (8388608)
//   `xYt` → postFeedback                     @258339024
//   `Sxe` → submitFeedback (strip-retry)     @258341400
//
// Item 66 ([VSCode] feedback error showed only HTTP status): OCC ships no
// VSCode extension and no SDK submitFeedback control path — the portable
// delta is this shared refusal plumbing, which now surfaces the server's
// reason in every OCC feedback error render (N-A-deduped for the VSCode
// surface itself).
// ---------------------------------------------------------------------------

/** Official `_xe` = 8388608 (8 MiB feedback payload budget). */
export const FEEDBACK_PAYLOAD_BUDGET_BYTES = 8388608;

// Official UI/refusal strings (BIN309 byte-verbatim).
export const ZDR_ORG_MESSAGE = 'Feedback collection is not available for organizations with custom data retention policies.';
const ORG_NOT_ENABLED_MESSAGE = 'Feedback has not been enabled for your organization.';
const THIRD_PARTY_BLOCKED_MESSAGE = 'Feedback containing third-party provider content cannot be submitted.';
export const POLICY_DISABLED_MESSAGE = 'Feedback submission is disabled by your organization\'s policy.';
const ORG_DOES_NOT_ACCEPT_MESSAGE = 'Your organization does not accept feedback.';

/** Official `ou()` @247249784: `i=200, o=i*4` + invisible-char pattern. */
const SERVER_MESSAGE_MAX_CHARS = 200;
const INVISIBLE_CHARACTERS_PATTERN = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}]+/gu;

type FeedbackFailureReason = 'zdr_org' | 'org_refused' | 'scope_refused' | 'auth_refused' | 'http_error' | 'policy_blocked' | 'auth_error' | 'timeout' | 'network_error' | 'payload_too_large_precheck' | 'payload_too_large_413' | 'payload_too_large_range_error' | 'payload_too_large_timeout' | 'missing_feedback_id' | 'data_residency';
type FeedbackRefusal = {
  kind: 'org' | 'credential' | 'transient' | 'other';
  serverMessage?: string;
  reportContent?: true;
};
type PostFeedbackFailure = {
  success: false;
  payloadTooLarge?: boolean;
  isZdrOrg?: boolean;
  failureReason?: FeedbackFailureReason;
  statusCode?: number;
  refusal?: FeedbackRefusal;
};
type PostFeedbackResult = {
  success: true;
  feedbackId: string;
} | PostFeedbackFailure;
type SubmitFeedbackFailure = {
  success: false;
  isZdrOrg?: boolean;
  failureReason?: FeedbackFailureReason;
  statusCode?: number;
  refusal?: FeedbackRefusal;
};
export type SubmitFeedbackResult = {
  success: true;
  feedbackId?: string;
  retriedAfterTooLarge: boolean;
} | SubmitFeedbackFailure;

/**
 * Official `ou()` @247249784 (byte-verified):
 * `function ou(n){let e=n===void 0?"":Br(hn(n).replace(r," "));return e===""?void 0:pt(re(e,o),i)}`
 * with i=200, o=800. Declared deviation: the chunk helpers `hn`/`Br`/`re`/`pt`
 * are compiled into unextractable bun bytecode chunks — the input here is
 * always a zod-narrowed `string | undefined` (so `hn`'s non-string stringify
 * is unreachable), and `re(e,800)→pt(e,200)` is implemented as the equivalent
 * single 200-char truncation (both steps are pure truncation; the composite
 * can never exceed 200 chars). Whitespace collapse+trim mirrors `Br`.
 */
export function normalizeServerMessage(message: string | undefined): string | undefined {
  const cleaned = (message ?? '').replace(INVISIBLE_CHARACTERS_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned.slice(0, SERVER_MESSAGE_MAX_CHARS);
}

/** Official `Or()` @~258326955: error body schema, every field `.catch(undefined)`. */
function feedbackErrorBodySchema() {
  return z.object({
    error: z.object({
      type: z.string().optional().catch(undefined),
      message: z.string().optional().catch(undefined),
      details: z.object({
        error_code: z.string().optional().catch(undefined)
      }).nullish().catch(undefined)
    }).catch(undefined)
  }).catch(undefined);
}

/**
 * Official `As(status, data)` @~258326955 — classifies a failed feedback
 * POST into {failureReason, refusal} so the UI can show the server's actual
 * reason instead of a generic "try again later" (items 25/66).
 */
export function classifyFeedbackFailure(statusCode: number, data: unknown): PostFeedbackFailure {
  const parsed = feedbackErrorBodySchema().safeParse(data);
  const error = parsed.success ? parsed.data?.error : undefined;
  const errorCode = error?.details?.error_code;
  const rawMessage = error?.message;
  const serverMessage = normalizeServerMessage(rawMessage);
  if (errorCode === 'feedback_retention_blocked' || errorCode === undefined && statusCode === 403 && error?.type === 'permission_error' && rawMessage?.includes('Custom data retention settings')) {
    return {
      success: false,
      isZdrOrg: true,
      failureReason: 'zdr_org',
      statusCode,
      refusal: {
        kind: 'org',
        serverMessage
      }
    };
  }
  if (errorCode === 'feedback_disabled' || errorCode === 'feedback_third_party_blocked' || errorCode === undefined && statusCode === 403 && (rawMessage === ORG_NOT_ENABLED_MESSAGE || rawMessage === POLICY_DISABLED_MESSAGE)) {
    return {
      success: false,
      failureReason: 'org_refused',
      statusCode,
      refusal: {
        kind: 'org',
        serverMessage,
        ...(errorCode === 'feedback_third_party_blocked' && rawMessage === THIRD_PARTY_BLOCKED_MESSAGE && {
          reportContent: true as const
        })
      }
    };
  }
  if (errorCode === 'oauth_scope_insufficient' || statusCode === 401) {
    return {
      success: false,
      failureReason: errorCode === 'oauth_scope_insufficient' ? 'scope_refused' : 'auth_refused',
      statusCode,
      refusal: {
        kind: 'credential',
        serverMessage
      }
    };
  }
  const isTransient = errorCode === 'feedback_check_unavailable' || statusCode === 408 || statusCode === 429 || statusCode >= 500;
  return {
    success: false,
    failureReason: 'http_error',
    statusCode,
    refusal: {
      kind: isTransient ? 'transient' : 'other',
      serverMessage
    }
  };
}

/**
 * Official `l$o(message, refusalMessage)` @244460015 — appends the public
 * bug-report pointer unless the refusal IS the org policy-disabled message.
 * Declared deviation: the official also suppresses the pointer under HIPAA
 * compliance taint (`Coe(N7()).length>0`); OCC has no compliance-taint store,
 * so only the policy-message condition is checked.
 */
export function appendBugReportPointer(message: string, refusalMessage?: string): string {
  const punctuated = /[.!?…]$/.test(message) ? message : `${message}.`;
  if (refusalMessage === POLICY_DISABLED_MESSAGE) {
    return punctuated;
  }
  return `${punctuated} To report a bug, open an issue at ${GITHUB_ISSUES_REPO_URL}. Issues are public, so leave out anything confidential.`;
}

/** Official `yxe(result)` — org-refusal reason (ZDR text, server message, or generic). */
export function orgRefusalMessage(result: SubmitFeedbackFailure | PostFeedbackFailure): string | undefined {
  if ('isZdrOrg' in result && result.isZdrOrg) {
    return ZDR_ORG_MESSAGE;
  }
  if (result.refusal?.kind !== 'org') {
    return undefined;
  }
  return result.refusal.serverMessage ?? ORG_DOES_NOT_ACCEPT_MESSAGE;
}

/** Official `CYt(result)` — org-refusal UI message with bug-report pointer. */
export function orgRefusalDisplayMessage(result: SubmitFeedbackFailure | PostFeedbackFailure): string | undefined {
  const reason = orgRefusalMessage(result);
  return reason === undefined ? undefined : appendBugReportPointer(`Couldn't send feedback: ${reason}`, reason);
}

/** Official `cCt(result)` — ` (server returned NNN: msg)` suffix (msg trailing period stripped). */
export function serverStatusSuffix(result: SubmitFeedbackFailure | PostFeedbackFailure): string | undefined {
  if (!result.statusCode) {
    return undefined;
  }
  const message = result.refusal?.serverMessage?.replace(/\.$/, '');
  return ` (server returned ${result.statusCode}${message === undefined ? '' : `: ${message}`})`;
}

/** Official `RYt(result)` — credential-refusal UI message (scope vs credentials). */
export function credentialRefusalDisplayMessage(result: SubmitFeedbackFailure | PostFeedbackFailure): string | undefined {
  if (result.refusal?.kind !== 'credential') {
    return undefined;
  }
  const suffix = serverStatusSuffix(result) ?? '';
  return result.failureReason === 'scope_refused' ? `Couldn't send feedback: the sign-in this session uses is not allowed to send feedback${suffix}.` : `Couldn't send feedback: the server did not accept the credentials this session uses${suffix}.`;
}

/** Official `Ld(command)` @244460301 — env-var disable reasons (byte-verbatim). */
export function getEnvDisabledReason(command = '/feedback'): string | null {
  if (isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND)) {
    return `${command} has been disabled via the DISABLE_FEEDBACK_COMMAND environment variable`;
  }
  if (isEnvTruthy(process.env.DISABLE_BUG_COMMAND)) {
    return `${command} has been disabled via the DISABLE_BUG_COMMAND environment variable`;
  }
  if (isEssentialTrafficOnly()) {
    return `${command} has been disabled via the CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC environment variable`;
  }
  return null;
}

/**
 * Official `zne(command)` @~244460400: `Ld(e) ?? fp("allow_product_feedback",e,"is",Qg(e))`.
 * Declared deviation: the official `fp` walks a policy-message classification
 * subsystem (route_missing/cache_miss/latched/org_denied builders) OCC's
 * policyLimits does not have; OCC uses the org_denied fallback `Qg(e)` —
 * `<command> is disabled by your organization's policy.` + bug-report pointer.
 * `isEnvTruthy` (OCC convention, as in commands/feedback/index.ts) replaces the
 * official's raw env truthiness.
 */
export function getFeedbackDisabledReason(command = '/feedback'): string | null {
  return getEnvDisabledReason(command) ?? (isPolicyAllowed('allow_product_feedback') ? null : appendBugReportPointer(`${command} is disabled by your organization's policy.`));
}

/**
 * Official panel failure-render chain @~284805457 — builds the error message
 * for a failed submit, plus `isFinal` (official `Kt` flag): org refusals that
 * are NOT reportContent disable retry (message stays, resubmit blocked,
 * retry hint hidden) because resending identical content cannot succeed.
 */
export function buildFeedbackErrorMessage(result: SubmitFeedbackFailure): {
  message: string;
  isFinal: boolean;
} {
  const orgMessage = orgRefusalDisplayMessage(result);
  const message = orgMessage ?? credentialRefusalDisplayMessage(result);
  if (message !== undefined) {
    return {
      message,
      isFinal: orgMessage !== undefined && result.refusal?.reportContent !== true
    };
  }
  if (result.failureReason === 'auth_error') {
    return {
      message: 'Couldn\'t send feedback: not signed in. Run /login, then retry.',
      isFinal: false
    };
  }
  if (result.failureReason === 'policy_blocked') {
    return {
      message: getFeedbackDisabledReason('/feedback') ?? 'Feedback is disabled by your organization\'s policy.',
      isFinal: false
    };
  }
  const suffix = serverStatusSuffix(result) ?? (result.failureReason === 'timeout' ? ' (request timed out)' : result.failureReason === 'network_error' ? ' (couldn\'t reach the service)' : '');
  return {
    message: `Couldn't send feedback${suffix}. If it keeps failing, you can file at ${GITHUB_ISSUES_REPO_URL} instead.`,
    isFinal: false
  };
}
type Props = {
  abortSignal: AbortSignal;
  messages: Message[];
  initialDescription?: string;
  onDone(result: string, options?: {
    display?: CommandResultDisplay;
  }): void;
  backgroundTasks?: {
    [taskId: string]: {
      type: string;
      identity?: {
        agentId: string;
      };
      messages?: Message[];
    };
  };
};
type Step = 'userInput' | 'consent' | 'submitting' | 'done';
type FeedbackData = {
  // latestAssistantMessageId is the message ID from the latest main model call
  latestAssistantMessageId: string | null;
  message_count: number;
  datetime: string;
  description: string;
  platform: string;
  gitRepo: boolean;
  terminal: string;
  version: string | null;
  transcript: Message[];
  errors: unknown;
  lastApiRequest: unknown;
  subagentTranscripts?: {
    [agentId: string]: Message[];
  };
  rawTranscriptJsonl?: string;
};

// Utility function to redact sensitive information from strings.
// 2.1.286 alignment: delegates to the ported official secret-redaction engine
// (src/utils/secretRedaction). Its 46-rule table covers everything the old
// hand-rolled regexes caught (sk-ant keys, AKIA ids, AIza keys, GCP service
// accounts, x-api-key/authorization headers, AWS_/GOOGLE_ env assignments,
// API_KEY/TOKEN/SECRET/PASSWORD key=value pairs) and additionally fixes the
// v2.1.286 changelog cases: Bearer/Basic BEFORE the key name (#17),
// percent-encoded tokens (#18), zero-width characters inside key names (#19)
// and URL passwords containing punctuation (#20). The engine module imports
// nothing from the app, so this cannot reintroduce the TDZ cycle that kept
// commands/feedback/index.ts from importing this file.
export function redactSensitiveInfo(text: string): string {
  return redactSecrets(text);
}

// Get sanitized error logs with sensitive information redacted
function getSanitizedErrorLogs(): Array<{
  error?: string;
  timestamp?: string;
}> {
  // Sanitize error logs to remove any API keys
  return getInMemoryErrors().map(errorInfo => {
    // Create a copy of the error info to avoid modifying the original
    const errorCopy = {
      ...errorInfo
    } as {
      error?: string;
      timestamp?: string;
    };

    // Sanitize error if present and is a string
    if (errorCopy && typeof errorCopy.error === 'string') {
      errorCopy.error = redactSensitiveInfo(errorCopy.error);
    }
    return errorCopy;
  });
}
async function loadRawTranscriptJsonl(): Promise<string | null> {
  try {
    const transcriptPath = getTranscriptPath();
    const {
      size
    } = await stat(transcriptPath);
    if (size > MAX_TRANSCRIPT_READ_BYTES) {
      logForDebugging(`Skipping raw transcript read: file too large (${size} bytes)`, {
        level: 'warn'
      });
      return null;
    }
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}
export function Feedback({
  abortSignal,
  messages,
  initialDescription,
  onDone,
  backgroundTasks = {}
}: Props): React.ReactNode {
  const [step, setStep] = useState<Step>('userInput');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Official `Kt` flag @~284804104: true when the error is a permanent org
  // refusal — the message survives edits, resubmission is blocked, and the
  // "Edit and press Enter to retry" hint is hidden.
  const [errorIsFinal, setErrorIsFinal] = useState(false);
  const [envInfo, setEnvInfo] = useState<{
    isGit: boolean;
    gitState: GitRepoState | null;
  }>({
    isGit: false,
    gitState: null
  });
  const [title, setTitle] = useState<string | null>(null);
  const textInputColumns = useTerminalSize().columns - 4;
  useEffect(() => {
    async function loadEnvInfo() {
      const isGit = await getIsGit();
      let gitState: GitRepoState | null = null;
      if (isGit) {
        gitState = await getGitState();
      }
      setEnvInfo({
        isGit,
        gitState
      });
    }
    void loadEnvInfo();
  }, []);
  const submitReport = useCallback(async () => {
    setStep('submitting');
    setError(null);
    setErrorIsFinal(false);
    setFeedbackId(null);

    // Get sanitized errors for the report
    const sanitizedErrors = getSanitizedErrorLogs();

    // Extract last assistant message ID from messages array
    const lastAssistantMessage = getLastAssistantMessage(messages);
    const lastAssistantMessageId = lastAssistantMessage?.requestId ?? null;
    const [diskTranscripts, rawTranscriptJsonl] = await Promise.all([loadAllSubagentTranscriptsFromDisk(), loadRawTranscriptJsonl()]);
    const teammateTranscripts = extractTeammateTranscriptsFromTasks(backgroundTasks);
    const subagentTranscripts = {
      ...diskTranscripts,
      ...teammateTranscripts
    };
    const reportData: FeedbackData = {
      latestAssistantMessageId: lastAssistantMessageId as string | null,
      message_count: messages.length,
      datetime: new Date().toISOString(),
      description,
      platform: env.platform,
      gitRepo: envInfo.isGit,
      terminal: env.terminal,
      version: MACRO.VERSION,
      transcript: normalizeMessagesForAPI(messages),
      errors: sanitizedErrors,
      lastApiRequest: getLastAPIRequest(),
      ...(Object.keys(subagentTranscripts).length > 0 && {
        subagentTranscripts
      }),
      ...(rawTranscriptJsonl && {
        rawTranscriptJsonl
      })
    };
    const [result, t] = await Promise.all([submitFeedback(reportData, abortSignal), generateTitle(description, abortSignal)]);
    setTitle(t);
    if (result.success) {
      if (result.feedbackId) {
        setFeedbackId(result.feedbackId);
        // 2.1.309 items 25/26: tengu_bug_report_submitted (with the official
        // retried_after_too_large/strip_level fields) is now logged inside
        // submitFeedback — the official Sxe panel-submit wrapper owns it.
        // 1P-only: freeform text approved for BQ. Join on feedback_id.
        logEventTo1P('tengu_bug_report_description', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          description: redactSensitiveInfo(description) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
      setStep('done');
    } else {
      // 2.1.309 items 25/66: show the server's actual refusal reason (org /
      // credential / policy / transient) instead of the generic "Could not
      // submit feedback. Please try again later." isFinal (official `Kt`)
      // marks permanent org refusals — retry is then disabled because
      // resending identical content cannot succeed.
      const {
        message,
        isFinal
      } = buildFeedbackErrorMessage(result);
      setError(message);
      setErrorIsFinal(isFinal);
      // Stay on userInput step so user can retry with their content preserved
      setStep('userInput');
    }
  }, [description, envInfo.isGit, messages]);

  // Handle cancel - this will be called by Dialog's automatic Esc handling
  const handleCancel = useCallback(() => {
    // Don't cancel when done - let other keys close the dialog
    if (step === 'done') {
      if (error) {
        onDone('Error submitting feedback / bug report', {
          display: 'system'
        });
      } else {
        onDone('Feedback / bug report submitted', {
          display: 'system'
        });
      }
      return;
    }
    onDone('Feedback / bug report cancelled', {
      display: 'system'
    });
  }, [step, error, onDone]);

  // During text input, use Settings context where only Escape (not 'n') triggers confirm:no.
  // This allows typing 'n' in the text field while still supporting Escape to cancel.
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: step === 'userInput'
  });
  useInput((input, key) => {
    // Allow any key press to close the dialog when done or when there's an error
    if (step === 'done') {
      if (key.return && title) {
        // Open GitHub issue URL when Enter is pressed
        // 2.1.287: getSanitizedErrorLogs() arg dropped here ONLY — errors still
        // go to the Anthropic report POST in submitReport() (unchanged).
        const issueUrl = createGitHubIssueUrl(feedbackId ?? '', title, description);
        void openBrowser(issueUrl);
      }
      if (error) {
        onDone('Error submitting feedback / bug report', {
          display: 'system'
        });
      } else {
        onDone('Feedback / bug report submitted', {
          display: 'system'
        });
      }
      return;
    }

    // When in userInput step with error, allow user to edit and retry
    // (don't close on any keypress - they can still press Esc to cancel)
    if (error && step !== 'userInput') {
      onDone('Error submitting feedback / bug report', {
        display: 'system'
      });
      return;
    }
    if (step === 'consent' && (key.return || input === ' ')) {
      void submitReport();
    }
  });
  return <Dialog title="Submit Feedback / Bug Report" onCancel={handleCancel} isCancelActive={step !== 'userInput'} inputGuide={exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : step === 'userInput' ? <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="continue" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline> : step === 'consent' ? <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="submit" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline> : null}>
      {step === 'userInput' && <Box flexDirection="column" gap={1}>
          <Text>Describe the issue below:</Text>
          <TextInput value={description} onChange={value => {
        setDescription(value);
        // Clear error when user starts editing to allow retry — unless the
        // error is final (permanent org refusal), which official `fe`/`Kt`
        // keeps pinned so the user cannot edit around it.
        if (error && !errorIsFinal) {
          setError(null);
        }
      }} columns={textInputColumns} onSubmit={() => {
        // Official `if(fe)return` — a final refusal blocks resubmission.
        if (errorIsFinal) {
          return;
        }
        setStep('consent');
      }} onExitMessage={() => onDone('Feedback cancelled', {
        display: 'system'
      })} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} showCursor />
          {error && <Box flexDirection="column" gap={1}>
              <Text color="error">{error}</Text>
              {!errorIsFinal && <Text dimColor>
                Edit and press Enter to retry, or Esc to cancel
              </Text>}
            </Box>}
        </Box>}

      {step === 'consent' && <Box flexDirection="column">
          <Text>This report will include:</Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>
              - Your feedback / bug description:{' '}
              <Text dimColor>{description}</Text>
            </Text>
            <Text>
              - Environment info:{' '}
              <Text dimColor>
                {env.platform}, {env.terminal}, v{MACRO.VERSION}
              </Text>
            </Text>
            {envInfo.gitState && <Text>
                - Git repo metadata:{' '}
                <Text dimColor>
                  {envInfo.gitState.branchName}
                  {envInfo.gitState.commitHash ? `, ${envInfo.gitState.commitHash.slice(0, 7)}` : ''}
                  {envInfo.gitState.remoteUrl ? ` @ ${envInfo.gitState.remoteUrl}` : ''}
                  {!envInfo.gitState.isHeadOnRemote && ', not synced'}
                  {!envInfo.gitState.isClean && ', has local changes'}
                </Text>
              </Text>}
            <Text>- Current session transcript</Text>
            {/* 2.1.287 alignment (official consent screen @~234334584 region):
                new row after the Session transcript row. Official gates it on
                `f!=="share"` — OCC's consent screen has no share/feedback mode
                distinction (NO-SURFACE), so the row renders unconditionally. */}
            <Text>
              - Recent error messages:{' '}
              <Text dimColor>
                up to the last 100 since you launched Claude Code (may include file paths)
              </Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text wrap="wrap" dimColor>
              We will use your feedback to debug related issues or to improve{' '}
              Claude Code&apos;s functionality (eg. to reduce the risk of bugs
              occurring in the future).
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              Press <Text bold>Enter</Text> to confirm and submit.
            </Text>
          </Box>
        </Box>}

      {step === 'submitting' && <Box flexDirection="row" gap={1}>
          <Text>Submitting report…</Text>
        </Box>}

      {step === 'done' && <Box flexDirection="column">
          {error ? <Text color="error">{error}</Text> : <Text color="success">Thank you for your report!</Text>}
          {feedbackId && <Text dimColor>Feedback ID: {feedbackId}</Text>}
          <Box marginTop={1}>
            <Text>Press </Text>
            <Text bold>Enter </Text>
            <Text>
              to open your browser and draft a GitHub issue, or any other key to
              close.
            </Text>
          </Box>
        </Box>}
    </Dialog>;
}
// 2.1.287 alignment (official `st(c,i,o)` @~234334584, byte-verified in
// docs/gap-research-287/cluster-b-protocol-auth-security.md Item 6): the
// `errors` param is DROPPED — the pre-filled GitHub issue no longer embeds
// recent error messages (the `**Errors**` json section and the old v286
// truncation note are gone; both v286-only, v287=0 hits). Errors still flow
// to the Anthropic report POST above (:169-190, unchanged — official keeps
// it). Description is budgeted as a LINE ARRAY with a per-line
// encoded-length loop and a 50-byte slack.
export function createGitHubIssueUrl(feedbackId: string, title: string, description: string): string {
  const sanitizedTitle = redactSensitiveInfo(title);
  const sanitizedDescription = redactSensitiveInfo(description);
  // Official v287 normalizes the description via Cs(o) into an array of lines
  // and concatenates each line's encoding WITHOUT a separator in the budget
  // loop below. OCC's call site holds a plain string, so split into lines that
  // KEEP their trailing '\n' — the separator-less concatenation then rebuilds
  // the original text exactly (faithful Cs(o) mirror).
  const descriptionLines = sanitizedDescription.split(/(?<=\n)/);
  const baseUrl = `${GITHUB_ISSUES_REPO_URL}/new?title=${encodeURIComponent(sanitizedTitle)}&labels=user-reported,bug&body=`;
  const encodedHeader = encodeURIComponent(`**Bug Description**\n`);
  const encodedEnvInfo = encodeURIComponent(`\n\n**Environment Info**\n` + `- Platform: ${env.platform}\n` + `- Terminal: ${env.terminal}\n` + `- Version: ${MACRO.VERSION || 'unknown'}\n` + `- Feedback ID: ${feedbackId}\n`);
  let encodedDescription = encodeURIComponent(descriptionLines.join(''));
  const descriptionBudget = GITHUB_URL_LIMIT - baseUrl.length - encodedHeader.length - encodedEnvInfo.length;
  if (encodedDescription.length > descriptionBudget) {
    const encodedNote = encodeURIComponent(`…\n\n**Note:** The description was shortened to fit GitHub's link length limit. The full description was sent to Anthropic with the feedback report; its Feedback ID is below.`);
    const URL_SLACK = 50; // Official `h=50` — extra safety margin
    const lineBudget = descriptionBudget - encodedNote.length - URL_SLACK;
    encodedDescription = '';
    for (const line of descriptionLines) {
      const encodedLine = encodeURIComponent(line);
      if (encodedDescription.length + encodedLine.length > lineBudget) {
        break;
      }
      encodedDescription += encodedLine;
    }
    encodedDescription += encodedNote;
  }
  return baseUrl + encodedHeader + encodedDescription + encodedEnvInfo;
}
async function generateTitle(description: string, abortSignal: AbortSignal): Promise<string> {
  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt(['Generate a concise, technical issue title (max 80 chars) for a public GitHub issue based on this bug report for Claude Code.', 'Claude Code is an agentic coding CLI based on the Anthropic API.', 'The title should:', '- Include the type of issue [Bug] or [Feature Request] as the first thing in the title', '- Be concise, specific and descriptive of the actual problem', '- Use technical terminology appropriate for a software issue', '- For error messages, extract the key error (e.g., "Missing Tool Result Block" rather than the full message)', '- Be direct and clear for developers to understand the problem', '- If you cannot determine a clear issue, use "Bug Report: [brief description]"', '- Any LLM API errors are from the Anthropic API, not from any other model provider', 'Your response will be directly used as the title of the Github issue, and as such should not contain any other commentary or explaination', 'Examples of good titles include: "[Bug] Auto-Compact triggers to soon", "[Bug] Anthropic API Error: Missing Tool Result Block", "[Bug] Error: Invalid Model Name for Opus"']),
      userPrompt: description,
      signal: abortSignal,
      options: {
        hasAppendSystemPrompt: false,
        toolChoice: undefined,
        isNonInteractiveSession: false,
        agents: [],
        querySource: 'feedback',
        mcpTools: []
      }
    });
    const firstBlock = Array.isArray(response.message.content) ? response.message.content[0] : undefined;
    const title = firstBlock && typeof firstBlock !== 'string' && firstBlock.type === 'text' ? firstBlock.text : 'Bug Report';

    // Check if the title contains an API error message
    if (startsWithApiErrorPrefix(title)) {
      return createFallbackTitle(description);
    }
    return title;
  } catch (error) {
    // If there's any error in title generation, use a fallback title
    logError(error);
    return createFallbackTitle(description);
  }
}
function createFallbackTitle(description: string): string {
  // Create a safe fallback title based on the bug description

  // Try to extract a meaningful title from the first line
  const firstLine = description.split('\n')[0] || '';

  // If the first line is very short, use it directly
  if (firstLine.length <= 60 && firstLine.length > 5) {
    return firstLine;
  }

  // For longer descriptions, create a truncated version
  // Truncate at word boundaries when possible
  let truncated = firstLine.slice(0, 60);
  if (firstLine.length > 60) {
    // Find the last space before the 60 char limit
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 30) {
      // Only trim at word if we're not cutting too much
      truncated = truncated.slice(0, lastSpace);
    }
    truncated += '...';
  }
  return truncated.length < 10 ? 'Bug Report' : truncated;
}

// Helper function to sanitize and log errors without exposing API keys
function sanitizeAndLogError(err: unknown): void {
  if (err instanceof Error) {
    // Create a copy with potentially sensitive info redacted
    const safeError = new Error(redactSensitiveInfo(err.message));

    // Also redact the stack trace if present
    if (err.stack) {
      safeError.stack = redactSensitiveInfo(err.stack);
    }
    logError(safeError);
  } else {
    // For non-Error objects, convert to string and redact sensitive info
    const errorString = redactSensitiveInfo(String(err));
    logError(new Error(errorString));
  }
}
/**
 * Official `xYt(payload, signal, sessionId, credentials)` @258339024 — single
 * feedback POST attempt with the 309 payload-budget precheck, 413 branch,
 * `validateStatus:(s)=>s!==401`, and `As()` failure classification.
 *
 * Declared deviations (pre-existing OCC seams kept):
 * - OCC posts the `{content: jsonStringify(data)}` envelope (the official
 *   posts the serialized payload directly); the precheck measures the same
 *   serialized string that goes into the envelope.
 * - The official `gv` fetch wrapper's data-residency reason has no OCC
 *   surface (`data_residency` stays in the reason union for parity); the
 *   wrapper's `no-auth` reason maps to OCC's getAuthHeaders() error.
 * - The official serializes with `dCt` (redaction-aware); OCC keeps its
 *   existing jsonStringify path.
 */
export async function postFeedback(data: FeedbackData, signal?: AbortSignal): Promise<PostFeedbackResult> {
  if (isEssentialTrafficOnly()) {
    return {
      success: false
    };
  }
  if (!isPolicyAllowed('allow_product_feedback')) {
    return {
      success: false,
      failureReason: 'policy_blocked'
    };
  }
  let serializedLength = 0;
  try {
    // Ensure OAuth token is fresh before getting auth headers
    // This prevents 401 errors from stale cached tokens
    await checkAndRefreshOAuthTokenIfNeeded();
    const authResult = getAuthHeaders();
    if (authResult.error) {
      // Official `no-auth` wrapper reason → auth_error.
      return {
        success: false,
        failureReason: 'auth_error'
      };
    }
    const serialized = jsonStringify(data);
    serializedLength = serialized.length;
    // Official 2.1.309 item 26 precheck: `if(n=k.length,n>_xe)return
    // {success:!1,payloadTooLarge:!0,failureReason:"payload_too_large_precheck"}`
    if (serializedLength > FEEDBACK_PAYLOAD_BUDGET_BYTES) {
      return {
        success: false,
        payloadTooLarge: true,
        failureReason: 'payload_too_large_precheck'
      };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers
    };
    const response = await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {
      content: serialized
    }, {
      headers,
      timeout: 30000,
      // 30 second timeout to prevent hanging
      signal,
      // Official 309: only 401 throws; every other status is classified from
      // the response so the server's refusal reason survives.
      validateStatus: (status: number) => status !== 401
    });
    if (response.status === 200) {
      const result = response.data;
      if (result?.feedback_id) {
        return {
          success: true,
          feedbackId: result.feedback_id
        };
      }
      sanitizeAndLogError(new Error('Failed to submit feedback: request did not return feedback_id'));
      return {
        success: false,
        failureReason: 'missing_feedback_id'
      };
    }
    // Official 2.1.309 item 26: `if(w.status===413)return{success:!1,
    // payloadTooLarge:!0,failureReason:"payload_too_large_413",statusCode:413}`
    if (response.status === 413) {
      return {
        success: false,
        payloadTooLarge: true,
        failureReason: 'payload_too_large_413',
        statusCode: 413
      };
    }
    const debugMessage = 'Failed to submit feedback:' + response.status;
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      logForDebugging(debugMessage);
    } else {
      sanitizeAndLogError(new Error(debugMessage));
    }
    return classifyFeedbackFailure(response.status, response.data);
  } catch (err) {
    // Handle cancellation/abort - don't log as error
    if (axios.isCancel(err)) {
      return {
        success: false
      };
    }
    // Official 309: a serializer RangeError means the payload was too large
    // to even stringify.
    if (err instanceof RangeError) {
      return {
        success: false,
        payloadTooLarge: true,
        failureReason: 'payload_too_large_range_error'
      };
    }
    // Official 309: a timeout with a payload over budget/8 (1 MiB) is
    // presumed to be size-induced → payload_too_large_timeout.
    if (axios.isAxiosError(err) && (err as {
    code?: string;
  }).code === 'ECONNABORTED' && serializedLength > FEEDBACK_PAYLOAD_BUDGET_BYTES / 8) {
      return {
        success: false,
        payloadTooLarge: true,
        failureReason: 'payload_too_large_timeout'
      };
    }
    // Use our safe error logging function to avoid leaking API keys
    sanitizeAndLogError(err);
    if (axios.isAxiosError(err) && err.response) {
      return classifyFeedbackFailure(err.response.status, err.response.data);
    }
    return {
      success: false,
      failureReason: axios.isAxiosError(err) && (err as {
      code?: string;
    }).code === 'ECONNABORTED' ? 'timeout' : 'network_error'
    };
  }
}

/**
 * Official `Sxe({…})` panel submit @258341400 — item 26. An oversized
 * submission no longer fails outright: it is retried with the transcript
 * stripped (level 1, keeping rawTranscriptJsonl when present), then with
 * everything large dropped (level 2). Only `payloadTooLarge` failures
 * trigger a retry; all other failures pass the classifier result straight
 * through (items 25/66).
 *
 * Declared deviations: the official also destructures `recentSessionTranscripts`
 * and `debugLog` out of the payload — OCC's FeedbackData has neither field.
 * Telemetry keeps OCC's existing event surface plus the official retry
 * observability fields (retried_after_too_large, strip_level, reason,
 * status_code, first_attempt_too_large); official-only fields (surface,
 * remote_workspace, third_party_transcripts_dropped, laptop_memory_rows_dropped)
 * belong to subsystems OCC does not ship.
 */
export async function submitFeedback(data: FeedbackData, signal?: AbortSignal): Promise<SubmitFeedbackResult> {
  const firstAttempt = await postFeedback(data, signal);
  let attempt = firstAttempt;
  let stripLevel = 0;
  if (!attempt.success && attempt.payloadTooLarge) {
    const {
      transcript,
      subagentTranscripts,
      lastApiRequest,
      rawTranscriptJsonl,
      ...rest
    } = data;
    stripLevel = 1;
    attempt = await postFeedback({
      ...rest,
      transcript: [],
      ...(rawTranscriptJsonl && {
        rawTranscriptJsonl
      })
    }, signal);
    if (!attempt.success && attempt.payloadTooLarge) {
      stripLevel = 2;
      attempt = await postFeedback({
        ...rest,
        transcript: []
      }, signal);
    }
  }
  const firstAttemptTooLarge = !firstAttempt.success && firstAttempt.payloadTooLarge === true;
  if (attempt.success) {
    logEvent('tengu_bug_report_submitted', {
      surface: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      retried_after_too_large: firstAttemptTooLarge as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      strip_level: String(stripLevel) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      feedback_id: attempt.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_assistant_message_id: (data.latestAssistantMessageId ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return {
      success: true,
      feedbackId: attempt.feedbackId,
      retriedAfterTooLarge: firstAttemptTooLarge
    };
  }
  if (attempt.failureReason) {
    logEvent('tengu_bug_report_failed', {
      surface: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason: attempt.failureReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      status_code: (attempt.statusCode === undefined ? '' : String(attempt.statusCode)) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      first_attempt_too_large: firstAttemptTooLarge as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
  }
  return {
    success: false,
    isZdrOrg: attempt.isZdrOrg,
    failureReason: attempt.failureReason,
    statusCode: attempt.statusCode,
    refusal: attempt.refusal
  };
}
