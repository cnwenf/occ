import axios from 'axios';
import { readFile, stat } from 'fs/promises';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getLastAPIRequest } from 'src/bootstrap/state.js';
import { logEventTo1P } from 'src/services/analytics/firstPartyEventLogger.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
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
        logEvent('tengu_bug_report_submitted', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          last_assistant_message_id: lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        // 1P-only: freeform text approved for BQ. Join on feedback_id.
        logEventTo1P('tengu_bug_report_description', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          description: redactSensitiveInfo(description) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
      setStep('done');
    } else {
      if (result.isZdrOrg) {
        setError('Feedback collection is not available for organizations with custom data retention policies.');
      } else {
        setError('Could not submit feedback. Please try again later.');
      }
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
        // Clear error when user starts editing to allow retry
        if (error) {
          setError(null);
        }
      }} columns={textInputColumns} onSubmit={() => setStep('consent')} onExitMessage={() => onDone('Feedback cancelled', {
        display: 'system'
      })} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} showCursor />
          {error && <Box flexDirection="column" gap={1}>
              <Text color="error">{error}</Text>
              <Text dimColor>
                Edit and press Enter to retry, or Esc to cancel
              </Text>
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
async function submitFeedback(data: FeedbackData, signal?: AbortSignal): Promise<{
  success: boolean;
  feedbackId?: string;
  isZdrOrg?: boolean;
}> {
  if (isEssentialTrafficOnly()) {
    return {
      success: false
    };
  }
  try {
    // Ensure OAuth token is fresh before getting auth headers
    // This prevents 401 errors from stale cached tokens
    await checkAndRefreshOAuthTokenIfNeeded();
    const authResult = getAuthHeaders();
    if (authResult.error) {
      return {
        success: false
      };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers
    };
    const response = await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {
      content: jsonStringify(data)
    }, {
      headers,
      timeout: 30000,
      // 30 second timeout to prevent hanging
      signal
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
        success: false
      };
    }
    sanitizeAndLogError(new Error('Failed to submit feedback:' + response.status));
    return {
      success: false
    };
  } catch (err) {
    // Handle cancellation/abort - don't log as error
    if (axios.isCancel(err)) {
      return {
        success: false
      };
    }
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      const errorData = err.response.data;
      if (errorData?.error?.type === 'permission_error' && errorData?.error?.message?.includes('Custom data retention settings')) {
        sanitizeAndLogError(new Error('Cannot submit feedback because custom data retention settings are enabled'));
        return {
          success: false,
          isZdrOrg: true
        };
      }
    }
    // Use our safe error logging function to avoid leaking API keys
    sanitizeAndLogError(err);
    return {
      success: false
    };
  }
}
