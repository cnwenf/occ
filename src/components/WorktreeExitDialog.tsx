import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { asSessionId } from '../types/ids.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  // 2.1.301 #7: nullable commit count — null means the baseline is unknown
  // (no originalHeadCommit on hook-created worktrees, or rev-list failed), so
  // "clean" cannot be distinguished from "may hold unpushed commits".
  const [commitCount, setCommitCount] = useState<number | null>(null);
  // Official `Co` — the current session's title, surfaced in the hook-based
  // subtitle ("This session was named …"). Lazy-required below (cycle).
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(undefined);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();
  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // 2.1.301 #7: count unpushed commits only when a baseline exists, and
        // treat a failed rev-list as UNKNOWN (null) instead of collapsing it
        // to 0 (official: `xn=Pn===0?parseInt(Wn.trim())||0:null`). Hook-made
        // worktrees carry no originalHeadCommit, so their count stays null.
        let count: number | null = null;
        if (worktreeSession.originalHeadCommit) {
          const {
            stdout: commitsStr,
            code
          } = await execFileNoThrow('git', ['rev-list', '--count', `${worktreeSession.originalHeadCommit}..HEAD`]);
          count = code === 0 ? parseInt(commitsStr.trim()) || 0 : null;
        }
        setCommitCount(count);

        // Lazy require — same cycle-breaking pattern as recordWorktreeExit
        // (sessionStorage → commands → exit → ExitFlow → here).
        let currentSessionTitle: string | undefined;
        try {
          /* eslint-disable @typescript-eslint/no-require-imports */
          currentSessionTitle = (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).getCurrentSessionTitle(asSessionId(worktreeSession.sessionId));
          /* eslint-enable @typescript-eslint/no-require-imports */
        } catch {
          currentSessionTitle = undefined;
        }
        setSessionTitle(currentSessionTitle);

        // Official `fn = to.hookBased && xn === null`: a hook-created worktree
        // with an unknown commit baseline always asks — never silent removal.
        const hookForcedAsk = Boolean(worktreeSession.hookBased) && count === null;

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && (count === 0 || hookForcedAsk)) {
          if (hookForcedAsk) {
            setStatus('asking');
            return;
          }
          setStatus('removing');
          void cleanupWorktree().then(() => {
            process.chdir(worktreeSession.originalCwd);
            setCwd(worktreeSession.originalCwd);
            recordWorktreeExit();
            getPlansDirectory.cache.clear?.();
            setResultMessage('Worktree removed (no changes)');
          }).catch(error => {
            logForDebugging(`Failed to clean up worktree: ${error}`, {
              level: 'error'
            });
            setResultMessage('Worktree cleanup failed, exiting anyway');
          }).then(() => {
            setStatus('done');
          });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [worktreeSession]);
  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);
  if (!worktreeSession) {
    onDone('No active worktree session found', {
      display: 'system'
    });
    return null;
  }
  if (status === 'loading' || status === 'done') {
    return null;
  }
  async function handleSelect(value: string) {
    if (!worktreeSession) return;
    const hasTmux = Boolean(worktreeSession.tmuxSessionName);
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount ?? -1,
        changed_files: changes.length
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Reattach to tmux session with: tmux attach -t ${worktreeSession.tmuxSessionName}`);
      } else {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}`);
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount ?? -1,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(`Worktree kept at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Tmux session terminated.`);
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount ?? -1,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error'
        });
        setResultMessage('Worktree cleanup failed, exiting anyway');
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? ' Tmux session terminated.' : '';
      if (commitCount === null) {
        // Official Fr() kn===null branch (byte-verified v301 strings).
        if (worktreeSession.hookBased) {
          setResultMessage(`Worktree removed.${changes.length > 0 ? ' Uncommitted changes were discarded.' : ''}${tmuxNote}`);
        } else {
          setResultMessage(`Worktree and branch ${worktreeSession.worktreeBranch} removed.${changes.length > 0 ? ' Uncommitted changes were discarded.' : ''}${tmuxNote}`);
        }
      } else if (commitCount > 0 && changes.length > 0) {
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} and uncommitted changes were discarded.${tmuxNote}`);
      } else if (commitCount > 0) {
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${worktreeSession.worktreeBranch} ${commitCount === 1 ? 'was' : 'were'} discarded.${tmuxNote}`);
      } else if (changes.length > 0) {
        setResultMessage(`Worktree removed. Uncommitted changes were discarded.${tmuxNote}`);
      } else {
        setResultMessage(`Worktree removed.${tmuxNote}`);
      }
      setStatus('done');
    }
  }
  if (status === 'keeping') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>Keeping worktree…</Text>
      </Box>;
  }
  if (status === 'removing') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>Removing worktree…</Text>
      </Box>;
  }
  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount !== null && commitCount > 0;
  let subtitle = '';
  if (commitCount === null) {
    // 2.1.301 #7 — official Kn kn===null branch (byte-verified v301 strings).
    // Hook-made worktrees: Claude Code can't tell whether they hold unpushed
    // commits; optionally surface the session name so the user can resume it.
    if (worktreeSession.hookBased) {
      subtitle = `${hasUncommitted ? `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree. ` : ''}A WorktreeCreate hook made this worktree, so Claude Code can't tell whether it has unpushed commits.${sessionTitle ? ` This session was named "${sessionTitle}". Keep the worktree to resume it later.` : ''}`;
    } else {
      subtitle = `${hasUncommitted ? `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}, and the ` : 'The '}branch ${branchName} may hold unpushed commits (commit baseline unavailable). The branch will be deleted if you remove.`;
    }
  } else if (hasUncommitted && hasCommits) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'} and ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. All will be lost if you remove.`;
  } else if (hasUncommitted) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree.`;
  } else if (hasCommits) {
    subtitle = `You have ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. The branch will be deleted if you remove the worktree.`;
  } else {
    subtitle = 'You are working in a worktree. Keep it to continue working there, or remove it to clean up.';
  }
  function handleCancel() {
    if (onCancel) {
      // Abort exit and return to the session
      onCancel();
      return;
    }
    // Fallback: treat Escape as "keep" if no onCancel provided
    void handleSelect('keep');
  }
  // Official Os/sr (2.1.301 #7): tr = count unknown-or-positive; sr = hook
  // worktree with an unknown baseline and no uncommitted files. OCC has no
  // submodule/moved-off surface, so the official Et!==null/nt!==null branches
  // reduce to their Et===null && nt===null form here.
  const mayHoldUnpushed = commitCount === null || commitCount > 0;
  const hookUnknownState = Boolean(worktreeSession.hookBased) && commitCount === null && !hasUncommitted;
  const removeDescription = hasUncommitted || mayHoldUnpushed ? hookUnknownState ? 'Any unpushed commits in the worktree may be lost.' : 'All changes and commits will be lost.' : 'Clean up the worktree directory.';
  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);
  const options = hasTmuxSession ? [{
    label: 'Keep worktree and tmux session',
    value: 'keep-with-tmux',
    description: `Stays at ${worktreeSession.worktreePath}. Reattach with: tmux attach -t ${worktreeSession.tmuxSessionName}`
  }, {
    label: 'Keep worktree, kill tmux session',
    value: 'keep-kill-tmux',
    description: `Keeps worktree at ${worktreeSession.worktreePath}, terminates tmux session.`
  }, {
    label: 'Remove worktree and tmux session',
    value: 'remove-with-tmux',
    description: removeDescription
  }] : [{
    label: 'Keep worktree',
    value: 'keep',
    description: `Stays at ${worktreeSession.worktreePath}`
  }, {
    label: 'Remove worktree',
    value: 'remove',
    description: removeDescription
  }];
  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';
  return <Dialog title="Exiting worktree session" subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>;
}
