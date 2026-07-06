import { c as _c } from "react/compiler-runtime";
import chalk from 'chalk';
import type { UUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js';
import type { CommandResultDisplay, ResumeEntrypoint } from '../../commands.js';
import { LogSelector } from '../../components/LogSelector.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Spinner } from '../../components/Spinner.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { setClipboard } from '../../ink/termio/osc.js';
import { Box, Text, useInput } from '../../ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { LogOption } from '../../types/logs.js';
import { agenticSessionSearch } from '../../utils/agenticSessionSearch.js';
import { checkCrossProjectResume } from '../../utils/crossProjectResume.js';
import { getWorktreePaths } from '../../utils/getWorktreePaths.js';
import { logError } from '../../utils/log.js';
import { getLastSessionLog, getSessionIdFromLog, isCustomTitleEnabled, isLiteLog, loadAllProjectsMessageLogs, loadFullLog, loadSameRepoMessageLogs, searchSessionsByCustomTitle } from '../../utils/sessionStorage.js';
import { validateUuid } from '../../utils/uuid.js';
type ResumeResult = {
  resultType: 'sessionNotFound';
  arg: string;
} | {
  resultType: 'multipleMatches';
  arg: string;
  count: number;
};
function resumeHelpMessage(result: ResumeResult): string {
  switch (result.resultType) {
    case 'sessionNotFound':
      return `Session ${chalk.bold(result.arg)} was not found.`;
    case 'multipleMatches':
      return `Found ${result.count} sessions matching ${chalk.bold(result.arg)}. Please use /resume to pick a specific session.`;
  }
}

// E23 (2.1.117+2.1.122): /resume offers to summarize stale large sessions, and
// pasting a PR URL into /resume finds the creating session. Mirrors the 2.1.200
// binary: sessions that create a PR store prNumber + prRepository; the resume
// search parses the PR URL (regex `\/([^/]+)\/([^/]+)\/pull\/`) and matches.

// A session is a summarize candidate when it is older than STALE_SESSION_AGE_DAYS
// AND has more than LARGE_SESSION_MESSAGE_THRESHOLD messages.
const STALE_SESSION_AGE_DAYS = 7;
const LARGE_SESSION_MESSAGE_THRESHOLD = 50;
const STALE_SESSION_AGE_MS = STALE_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;

const PR_URL_PATTERN = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** Parse a PR URL into { repository: "owner/repo", number }. null if not a PR URL. */
export function parsePrUrl(arg: string): { repository: string; number: number } | null {
  if (!arg || !arg.includes('/pull/')) return null;
  const match = PR_URL_PATTERN.exec(arg);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  const number = parseInt(numberStr, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repository: `${owner}/${repo}`, number };
}

/** True when a session is both stale (old) and large (many messages). */
export function isStaleLargeSession(log: LogOption, now: number = Date.now()): boolean {
  const count = log.messageCount ?? 0;
  if (count < LARGE_SESSION_MESSAGE_THRESHOLD) return false;
  const modified = log.modified instanceof Date ? log.modified.getTime() : Number(log.modified);
  if (!Number.isFinite(modified)) return false;
  return now - modified >= STALE_SESSION_AGE_MS;
}

/** Find sessions that created a given PR (by prNumber + prRepository). */
export function findSessionsByPrUrl(
  logs: LogOption[],
  prInfo: { repository: string; number: number },
): LogOption[] {
  return logs.filter(l => l.prNumber === prInfo.number && l.prRepository === prInfo.repository);
}

/**
 * E23 (2.1.117): offer to summarize a stale, large session before resuming it.
 * y = summarize (/compact) then resume · n = resume directly · esc = back.
 */
function SummarizeStaleOffer({
  log,
  onSummarize,
  onResumeDirectly,
  onCancel,
}: {
  log: LogOption;
  onSummarize: () => void;
  onResumeDirectly: () => void;
  onCancel: () => void;
}): React.ReactNode {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onSummarize();
    else if (input === 'n' || input === 'N') onResumeDirectly();
    else if (key.escape) onCancel();
  });
  const modifiedMs = log.modified instanceof Date ? log.modified.getTime() : Number(log.modified);
  const ageDays = Number.isFinite(modifiedMs)
    ? Math.max(1, Math.round((Date.now() - modifiedMs) / (24 * 60 * 60 * 1000)))
    : 0;
  return (
    <Box flexDirection="column">
      <Text>{`This conversation is large (${log.messageCount} messages) and stale (${ageDays} days old).`}</Text>
      <Text>Summarize it before resuming?</Text>
      <Text dimColor={true}>y = summarize then resume · n = resume directly · esc = back</Text>
    </Box>
  );
}
function ResumeError(t0) {
  const $ = _c(10);
  const {
    message,
    args,
    onDone
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onDone) {
    t1 = () => {
      const timer = setTimeout(onDone, 0);
      return () => clearTimeout(timer);
    };
    t2 = [onDone];
    $[0] = onDone;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  React.useEffect(t1, t2);
  let t3;
  if ($[3] !== args) {
    t3 = <Text dimColor={true}>{figures.pointer} /resume {args}</Text>;
    $[3] = args;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== message) {
    t4 = <MessageResponse><Text>{message}</Text></MessageResponse>;
    $[5] = message;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== t3 || $[8] !== t4) {
    t5 = <Box flexDirection="column">{t3}{t4}</Box>;
    $[7] = t3;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function ResumeCommand({
  onDone,
  onResume,
  onResumeAndSummarize
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onResume: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
  onResumeAndSummarize: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[]>([]);
  const [worktreePaths, setWorktreePaths] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [resuming, setResuming] = React.useState(false);
  const [showAllProjects, setShowAllProjects] = React.useState(false);
  // E23: a stale, large session awaiting the summarize/confirm offer.
  const [summarizeOfferLog, setSummarizeOfferLog] = React.useState<{ sessionId: UUID; fullLog: LogOption } | null>(null);
  const {
    rows
  } = useTerminalSize();
  const insideModal = useIsInsideModal();
  const loadLogs = React.useCallback(async (allProjects: boolean, paths: string[]) => {
    setLoading(true);
    try {
      const allLogs = allProjects ? await loadAllProjectsMessageLogs() : await loadSameRepoMessageLogs(paths);
      const resumable = filterResumableSessions(allLogs, getSessionId());
      if (resumable.length === 0) {
        onDone('No conversations found to resume');
        return;
      }
      setLogs(resumable);
    } catch (_err) {
      onDone('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, [onDone]);
  React.useEffect(() => {
    async function init() {
      const paths_0 = await getWorktreePaths(getOriginalCwd());
      setWorktreePaths(paths_0);
      void loadLogs(false, paths_0);
    }
    void init();
  }, [loadLogs]);
  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects;
    setShowAllProjects(newValue);
    void loadLogs(newValue, worktreePaths);
  }, [showAllProjects, loadLogs, worktreePaths]);
  async function handleSelect(log: LogOption) {
    const sessionId = validateUuid(getSessionIdFromLog(log));
    if (!sessionId) {
      onDone('Failed to resume conversation');
      return;
    }

    // Load full messages for lite logs
    const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;

    // Check if this conversation is from a different directory
    const crossProjectCheck = checkCrossProjectResume(fullLog, showAllProjects, worktreePaths);
    if (crossProjectCheck.isCrossProject) {
      if (crossProjectCheck.isSameRepoWorktree) {
        // Same repo worktree - can resume directly
        setResuming(true);
        void onResume(sessionId, fullLog, 'slash_command_picker');
        return;
      }

      // Different project - show command instead of resuming
      const crossCmd = (crossProjectCheck as { isCrossProject: true; isSameRepoWorktree: false; command: string }).command;
      const raw = await setClipboard(crossCmd);
      if (raw) process.stdout.write(raw);

      // Format the output message
      const message = ['', 'This conversation is from a different directory.', '', 'To resume, run:', `  ${crossCmd}`, '', '(Command copied to clipboard)', ''].join('\n');
      onDone(message, {
        display: 'user'
      });
      return;
    }

    // E23 (2.1.117): offer to summarize stale, large sessions before resuming.
    if (isStaleLargeSession(fullLog)) {
      setSummarizeOfferLog({ sessionId, fullLog });
      return;
    }

    // Same directory - proceed with resume
    setResuming(true);
    void onResume(sessionId, fullLog, 'slash_command_picker');
  }
  function confirmSummarize() {
    if (!summarizeOfferLog) return;
    const { sessionId, fullLog } = summarizeOfferLog;
    setSummarizeOfferLog(null);
    setResuming(true);
    void onResumeAndSummarize(sessionId, fullLog, 'slash_command_picker');
  }
  function resumeWithoutSummarize() {
    if (!summarizeOfferLog) return;
    const { sessionId, fullLog } = summarizeOfferLog;
    setSummarizeOfferLog(null);
    setResuming(true);
    void onResume(sessionId, fullLog, 'slash_command_picker');
  }
  function handleCancel() {
    onDone('Resume cancelled', {
      display: 'system'
    });
  }
  if (loading) {
    return <Box>
        <Spinner />
        <Text> Loading conversations…</Text>
      </Box>;
  }
  if (resuming) {
    return <Box>
        <Spinner />
        <Text> Resuming conversation…</Text>
      </Box>;
  }
  if (summarizeOfferLog) {
    return <SummarizeStaleOffer log={summarizeOfferLog.fullLog} onSummarize={confirmSummarize} onResumeDirectly={resumeWithoutSummarize} onCancel={() => setSummarizeOfferLog(null)} />;
  }
  return <LogSelector logs={logs} maxHeight={insideModal ? Math.floor(rows / 2) : rows - 2} onCancel={handleCancel} onSelect={handleSelect} onLogsChanged={() => loadLogs(showAllProjects, worktreePaths)} showAllProjects={showAllProjects} onToggleAllProjects={handleToggleAllProjects} onAgenticSearch={agenticSessionSearch} />;
}
export function filterResumableSessions(logs: LogOption[], currentSessionId: string): LogOption[] {
  return logs.filter(l => !l.isSidechain && getSessionIdFromLog(l) !== currentSessionId);
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const onResume = async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    try {
      await context.resume?.(sessionId, log, entrypoint);
      onDone(undefined, {
        display: 'skip'
      });
    } catch (error) {
      logError(error as Error);
      onDone(`Failed to resume: ${(error as Error).message}`);
    }
  };
  // E23 (2.1.117): resume a stale, large session AND queue /compact to
  // summarize it. The /compact nextInput fires after the session is restored.
  const onResumeAndSummarize = async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    try {
      await context.resume?.(sessionId, log, entrypoint);
      onDone(undefined, {
        display: 'skip',
        nextInput: '/compact',
        submitNextInput: true
      });
    } catch (error) {
      logError(error as Error);
      onDone(`Failed to resume: ${(error as Error).message}`);
    }
  };
  const arg = args?.trim();

  // No argument provided - show picker
  if (!arg) {
    return <ResumeCommand key={Date.now()} onDone={onDone} onResume={onResume} onResumeAndSummarize={onResumeAndSummarize} />;
  }

  // Load logs to search (includes same-repo worktrees)
  const worktreePaths = await getWorktreePaths(getOriginalCwd());
  const logs = await loadSameRepoMessageLogs(worktreePaths);
  if (logs.length === 0) {
    const message = 'No conversations found to resume.';
    return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
  }

  // First, check if arg is a valid UUID
  const maybeSessionId = validateUuid(arg);
  if (maybeSessionId) {
    const matchingLogs = logs.filter(l => getSessionIdFromLog(l) === maybeSessionId).sort((a, b) => b.modified.getTime() - a.modified.getTime());
    if (matchingLogs.length > 0) {
      const log = matchingLogs[0]!;
      const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
      void onResume(maybeSessionId, fullLog, 'slash_command_session_id');
      return null;
    }

    // Enriched logs didn't find it — try direct file lookup. This handles
    // sessions filtered out by enrichLogs (e.g., first message >16KB makes
    // firstPrompt extraction fail, causing the session to be dropped).
    const directLog = await getLastSessionLog(maybeSessionId);
    if (directLog) {
      void onResume(maybeSessionId, directLog, 'slash_command_session_id');
      return null;
    }
  }

  // E23 (2.1.122): pasting a PR URL into /resume finds the creating session.
  // Sessions that created a PR store prNumber + prRepository; match them.
  const prInfo = parsePrUrl(arg);
  if (prInfo) {
    const prMatches = findSessionsByPrUrl(logs, prInfo).sort((a, b) => b.modified.getTime() - a.modified.getTime());
    if (prMatches.length === 1) {
      const log = prMatches[0]!;
      const sessionId = validateUuid(getSessionIdFromLog(log));
      if (sessionId) {
        const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
        void onResume(sessionId, fullLog, 'slash_command_session_id');
        return null;
      }
    }
    // Multiple PR matches - show error
    if (prMatches.length > 1) {
      const message = resumeHelpMessage({
        resultType: 'multipleMatches',
        arg,
        count: prMatches.length
      });
      return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
    }
    // 0 matches — fall through to the sessionNotFound error below.
  }

  // Next, try exact custom title match (only if feature is enabled)
  if (isCustomTitleEnabled()) {
    const titleMatches = await searchSessionsByCustomTitle(arg, {
      exact: true
    });
    if (titleMatches.length === 1) {
      const log = titleMatches[0]!;
      const sessionId = getSessionIdFromLog(log);
      if (sessionId) {
        const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
        void onResume(sessionId, fullLog, 'slash_command_title');
        return null;
      }
    }

    // Multiple matches - show error
    if (titleMatches.length > 1) {
      const message = resumeHelpMessage({
        resultType: 'multipleMatches',
        arg,
        count: titleMatches.length
      });
      return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
    }
  }

  // No match found - show error
  const message = resumeHelpMessage({
    resultType: 'sessionNotFound',
    arg
  });
  return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
};
