import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { asSessionId } from '../types/ids.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, computeWorktreeExitAtStake, formatAtStakePhrase, getCurrentWorktreeSession, isDisplayUnsafeBranchName, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import type { WorktreeExitAtStake } from '../utils/worktree.js';
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
// Official `Ww(h,R)` telemetry formatter (2.1.304 #30, vver @269337347):
// commits (?? -1), head (only when classified — not 'not_read'), and
// commits_on_kept_branch (only for the onKeptBranch refinement, ?? -1).
// DEVIATION: the official also emits worktrees_inside when R!==0 — OCC has
// no source for that count, so the field is omitted.
function atStakeTelemetry(atStake: WorktreeExitAtStake | null, changedFiles: number) {
  return {
    commits: atStake?.commits ?? -1,
    changed_files: changedFiles,
    ...(atStake !== null && atStake.head !== 'not_read' ? {
      head: atStake.head as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    } : {}),
    ...(atStake !== null && 'onKeptBranch' in atStake ? {
      commits_on_kept_branch: atStake.onKeptBranch ?? -1
    } : {})
  };
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
  // 2.1.304 #30 (official `Cn`): the at-stake classification replaces the
  // bare nullable rev-list count (2.1.301 #7). `commits === null` still means
  // the at-stake count is unknown (hook worktree, unreadable HEAD, failed
  // git), so "clean" cannot be distinguished from "may hold unpushed commits".
  const [atStake, setAtStake] = useState<WorktreeExitAtStake | null>(null);
  const commitCount = atStake === null ? null : atStake.commits;
  // Official v304 dialog locals `nr`/`er` (byte-verified @269342900 region,
  // OCC-164 supplement):
  //   nr = xt.head==="another_branch"||xt.head==="like_its_branch"
  //   er = xt.head!=="another_branch" ? null
  //        : fve(xt.branch) ? "another branch" : `branch ${xt.branch}`
  // `nr` (branchWillBeDeleted): removal deletes the worktree's own named
  // branch. `er` (keptBranchDisplay): display string for the branch HEAD has
  // moved to, sanitized through the official `fve` (≡
  // isDisplayUnsafeBranchName) so hidden/control characters in a branch name
  // never echo into dialog copy.
  const branchWillBeDeleted = atStake !== null && (atStake.head === 'another_branch' || atStake.head === 'like_its_branch');
  const keptBranchDisplay = atStake !== null && atStake.head === 'another_branch' ? isDisplayUnsafeBranchName(atStake.branch) ? 'another branch' : `branch ${atStake.branch}` : null;
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
        // Official 2.1.304 #30 (`Cn`): classify HEAD and count at-stake
        // commits on refs/heads/<worktreeBranch> (not HEAD) so a detached or
        // moved-off HEAD can no longer hide branch commits from the guard.
        // Hook worktrees carry no worktreeBranch/originalHeadCommit, so the
        // classifier short-circuits to {head:'not_read', commits:null}
        // without any git call — the 2.1.301 #7 hookForcedAsk behavior below
        // is preserved.
        const stake = await computeWorktreeExitAtStake(worktreeSession);
        setAtStake(stake);
        const count = stake.commits;

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

        // If no changes and no commits, clean up silently.
        // Official 2.1.304 #30 guard — FULL gate (vver @269341114,
        // byte-verified in the OCC-164 supplement round):
        //   No.length===0 && (Cn.commits===0||pn) && !("onKeptBranch" in Cn)
        //     && !wo && !Uo
        // `wo` is the current session title (`fo=c1().getCurrentSessionTitle(io)`):
        // a named session is worth keeping to resume, so even a clean worktree
        // asks instead of removing silently. The onKeptBranch refinement means
        // HEAD moved to another branch that holds commits the session baseline
        // lacks — removal would keep that branch (nothing lost) but must never
        // happen silently. Reductions (documented in
        // docs/upstream-version-gap-occ164-2026-10.md): `!Uo` is the official KX
        // unverifiable-changes scan (OCC has no KX layer) and the official also
        // probes the nested-worktree count `lo!==0` (OCC creates no nested
        // worktrees).
        if (changeLines.length === 0 && (count === 0 || hookForcedAsk) && !('onKeptBranch' in stake) && !currentSessionTitle) {
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
            // Official v304 removedMessage (@269341114 region): when HEAD has
            // moved to another branch, that branch survives the removal — say
            // so (through the official `fve` display-unsafe fallback).
            setResultMessage(stake.head !== 'another_branch' ? 'Worktree removed (no changes)' : `Worktree removed. ${isDisplayUnsafeBranchName(stake.branch) ? 'The branch that it was on' : `Branch ${stake.branch}`} is kept.`);
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
    // Official v304 `lr` keep-path location suffix (@269342900 region):
    //   lr = !ro.worktreeBranch ? ""
    //        : xt.head==="detached" ? " with HEAD detached"
    //        : ` on ${er??`branch ${ro.worktreeBranch}`}`
    const keptSuffix = !worktreeSession.worktreeBranch ? '' : atStake !== null && atStake.head === 'detached' ? ' with HEAD detached' : ` on ${keptBranchDisplay ?? `branch ${worktreeSession.worktreeBranch}`}`;
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', atStakeTelemetry(atStake, changes.length));
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath}${keptSuffix}. Reattach to tmux session with: tmux attach -t ${worktreeSession.tmuxSessionName}`);
      } else {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath}${keptSuffix}`);
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', atStakeTelemetry(atStake, changes.length));
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(`Worktree kept at ${worktreeSession.worktreePath}${keptSuffix}. Tmux session terminated.`);
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', atStakeTelemetry(atStake, changes.length));
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
        // Official v304 `os` (@269344300 region): the "on <branch>" clause
        // only renders when the worktree branch is the one being deleted
        // (`nr` ≡ branchWillBeDeleted).
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}${branchWillBeDeleted ? ` on ${worktreeSession.worktreeBranch}` : ''} and uncommitted changes were discarded.${tmuxNote}`);
      } else if (commitCount > 0) {
        // Official v304 `os`: a detached HEAD loses no branch — the
        // "on <branch> " clause is suppressed.
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} ${atStake !== null && atStake.head === 'detached' ? '' : `on ${worktreeSession.worktreeBranch} `}${commitCount === 1 ? 'was' : 'were'} discarded.${tmuxNote}`);
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
  // Official `tOt`-style at-stake phrase (2.1.304 #30): detached HEAD →
  // "on <branch> or at the detached HEAD"; another-branch HEAD → "on <branch>
  // that <other> doesn't have"; otherwise plain "on <branch>". (like_its_branch
  // never reaches a counted branch below — its commits are always null.)
  // Official v304 `Pr` (@269344300 region, OCC-164 supplement — supersedes
  // WP7 deviation #8's 'the current HEAD' fallback): the tOt other-branch
  // argument is the sanitized kept-branch display `er`, falling back to "the
  // worktree's current branch" when `er` is null or the unsafe-name
  // placeholder:
  //   Pr = er===null||er==="another branch" ? "the worktree's current branch" : er
  const otherBranchName = keptBranchDisplay === null || keptBranchDisplay === 'another branch' ? "the worktree's current branch" : keptBranchDisplay;
  const atStakePhrase = atStake === null ? `on ${branchName}` : formatAtStakePhrase(atStake, branchName, otherBranchName);
  let subtitle = '';
  if (commitCount === null) {
    // 2.1.301 #7 — official Kn kn===null branch (byte-verified v301 strings).
    // Hook-made worktrees: Claude Code can't tell whether they hold unpushed
    // commits; optionally surface the session name so the user can resume it.
    if (worktreeSession.hookBased) {
      subtitle = `${hasUncommitted ? `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree. ` : ''}A WorktreeCreate hook made this worktree, so Claude Code can't tell whether it has unpushed commits.${sessionTitle ? ` This session was named "${sessionTitle}". Keep the worktree to resume it later.` : ''}`;
    } else {
      // Official v304 (@269346618 region) refined the v301 copy: a detached
      // HEAD joins the "may hold" clause, and when a commit baseline EXISTS
      // but counting still failed the message reads "commits that could not
      // be counted" instead of "(commit baseline unavailable)":
      //   `branch ${jr}${xt.head==="detached"?" or the detached HEAD":""} may hold
      //    ${ro.originalHeadCommit?"commits that could not be counted"
      //      :"unpushed commits (commit baseline unavailable)"}.
      //    The branch will be deleted if you remove.`
      subtitle = `${hasUncommitted ? `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}, and the ` : 'The '}branch ${branchName}${atStake !== null && atStake.head === 'detached' ? ' or the detached HEAD' : ''} may hold ${worktreeSession.originalHeadCommit ? 'commits that could not be counted' : 'unpushed commits (commit baseline unavailable)'}. The branch will be deleted if you remove.`;
    }
  } else if (hasUncommitted && hasCommits) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'} and ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} ${atStakePhrase}. All will be lost if you remove.`;
  } else if (hasUncommitted) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree.`;
  } else if (hasCommits) {
    // Official v304 (@269346618 region): a detached HEAD → the commits "may
    // be lost" (no branch is deleted); otherwise the named-branch conditional
    // (`nr && jr` → "Branch <jr>", else "The branch") will be deleted.
    subtitle = `You have ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} ${atStakePhrase}. ${atStake !== null && atStake.head === 'detached' ? commitCount === 1 ? 'It may be lost' : 'They may be lost' : `${branchWillBeDeleted && branchName ? `Branch ${branchName}` : 'The branch'} will be deleted`} if you remove the worktree.`;
  } else if (sessionTitle) {
    // Official v304 `else if(wo)` branch (@269346618 region): a named session
    // gets its own keep-to-resume copy even when nothing is at stake.
    subtitle = `This session was named "${sessionTitle}". Keep the worktree to resume it later, or remove it to clean up.`;
  } else {
    subtitle = 'You are working in a worktree. Keep it to continue working there, or remove it to clean up.';
  }
  // Official v304 then appends `ir` (the submodule note — OCC has no submodule
  // surface, reduction) and the kept-branch suffix (@269347664):
  //   if(er!==null) ys = ys + ` The worktree is now on ${er}, which is kept either way.`
  if (keptBranchDisplay !== null) {
    subtitle += ` The worktree is now on ${keptBranchDisplay}, which is kept either way.`;
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
  // Official v304 `js` remove-description builder (@269347898 region,
  // byte-verified in the OCC-164 supplement). Symbol map: Ar=hasUncommitted,
  // yr=mayHoldUnpushed, nr=branchWillBeDeleted, jr=branchName,
  // As=hookUnknownState (the official `As` also requires nt===null — OCC has
  // no submodule surface, reduction):
  //   js = Ar||yr ? nr&&!yr ? "All uncommitted changes will be lost."
  //         : As ? "Any unpushed commits in the worktree may be lost."
  //         : nr ? `${Ar?`Uncommitted changes and ${jn===null?"any ":""}commits`
  //                 : jn===null?"Any commits":"Commits"} only on ${jr} will be lost.`
  //         : "All changes and commits will be lost."
  //        : "Clean up the worktree directory."
  const mayHoldUnpushed = commitCount === null || commitCount > 0;
  const hookUnknownState = Boolean(worktreeSession.hookBased) && commitCount === null && !hasUncommitted;
  const removeDescription = hasUncommitted || mayHoldUnpushed ? branchWillBeDeleted && !mayHoldUnpushed ? 'All uncommitted changes will be lost.' : hookUnknownState ? 'Any unpushed commits in the worktree may be lost.' : branchWillBeDeleted ? `${hasUncommitted ? `Uncommitted changes and ${commitCount === null ? 'any ' : ''}commits` : commitCount === null ? 'Any commits' : 'Commits'} only on ${branchName} will be lost.` : 'All changes and commits will be lost.' : 'Clean up the worktree directory.';
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
