import { feature } from 'src/utils/featureFlags.js'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  isMemoryLoadingPaused,
  getOriginalCwd,
  setCachedClaudeMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getClaudeMds,
  getMemoryFiles,
} from './utils/claudemd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
} from './utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import {
  getCommonDir,
  readGitHead,
  resolveGitDir,
} from './utils/git/gitFilesystem.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

const MAX_STATUS_CHARS = 2000

// Official 2.1.295 git-status builder args (binary `lQn` = v294 `Z8n`):
// ["--no-optional-locks","status","--short",Y_] with Y_="--ignore-submodules=dirty".
const GIT_STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--short',
  '--ignore-submodules=dirty',
] as const
const GIT_LOG_ARGS = ['--no-optional-locks', 'log', '--oneline', '-n', '5'] as const
const GIT_USER_NAME_ARGS = ['config', 'user.name'] as const

type GitStatusFields = {
  branch: string
  mainBranch: string
  status: string
  log: string
  userName: string
}

/**
 * Assemble the git-status system-context block. Shared by the global builder
 * (getGitStatus) and the worktree builder (getGitStatusForWorktree) — the
 * official binary uses ONE message tail for both paths (v295 `dQn`: identical
 * POe truncation + array + join("\n\n") after the `S===null` fork).
 */
function buildGitStatusMessage({
  branch,
  mainBranch,
  status,
  log,
  userName,
}: GitStatusFields): string {
  const truncatedStatus =
    status.length > MAX_STATUS_CHARS
      ? status.substring(0, MAX_STATUS_CHARS) +
        '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
      : status

  return [
    `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
    `Current branch: ${branch}`,
    `Main branch (you will usually use this for PRs): ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${log}`,
  ].join('\n\n')
}

// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // Clear context caches immediately when injection changes
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in tests
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  const isGitStart = Date.now()
  const isGit = await getIsGit()
  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
    duration_ms: Date.now() - isGitStart,
    is_git: isGit,
  })

  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
      duration_ms: Date.now() - startTime,
    })
    return null
  }

  try {
    const gitCmdsStart = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),
      getDefaultBranch(),
      execFileNoThrow(gitExe(), [...GIT_STATUS_ARGS], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), [...GIT_LOG_ARGS], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), [...GIT_USER_NAME_ARGS], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
    ])

    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - gitCmdsStart,
      status_length: status.length,
    })

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startTime,
      truncated: status.length > MAX_STATUS_CHARS,
    })

    return buildGitStatusMessage({ branch, mainBranch, status, log, userName })
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
  }
})

/**
 * Official 2.1.295 (#035): "Fixed subagents in their own linked worktree
 * being shown the parent session's git branch, status and recent commits."
 *
 * Binary mechanism (v295 `dQn(e)`, git-status builder @215537428):
 *   if(pZ()&&!Ht()){                       // inside an agent ALS-cwd override, not remote
 *     let Te=se(),Re=gr(Te);               // current (agent) cwd → repo root
 *     let Ce=Vl(),...,Fe=bAe(Me),Ge=bAe(Re) // main-session cwd + agent cwd worktree info
 *     if(...Ge.gitDir!==Ge.commonDir && Ge.commonDir===Fe.commonDir
 *            && Ge.gitDir!==Fe.gitDir){     // agent cwd is a LINKED worktree of the SAME repo
 *       let Je=await q2(Ge.workTree,{pin:Ge})
 *       if(Je.ok)S={cwd:Te,pin:Ge,filterDriversOff:Je.args}}
 *   }
 *   w = S===null ? {preserveOutputOnError:!1,env:ks()}
 *                : {cwd:S.cwd,preserveOutputOnError:!1,env:ks(void 0,{repository:S.pin})}
 *   H = it(Mt(),[...S?.filterDriversOff??[],...lQn],w)   // status runs IN the worktree
 *   branch = S===null ? Id()
 *                     : sse(S.pin.gitDir).then(Te=>Te?.type==="branch"?Te.name:"HEAD")
 *
 * `pZ()` = an agent-scoped AsyncLocalStorage cwd override is active (subagent
 * context); `se()` = ALS cwd ?? session cwd; `Vl()` = session originalCwd;
 * `bAe` = worktree-info resolver ({gitDir,workTree,commonDir}); `sse` = HEAD
 * reader ({type:"branch",name} | {type:"detached",sha} | null).
 *
 * OCC mapping: the subagent's ALS cwd override IS the explicit `worktreePath`
 * passed to runAgent, and the session originalCwd is OCC's `getOriginalCwd()`
 * (binary `Vl()`; NOT `getCwd()`, which runAgent's `runWithCwdOverride`
 * wrapper already points at the worktree). The
 * worktree-info resolver maps to resolveGitDir + getCommonDir; `sse` maps
 * byte-for-byte to readGitHead. Returns null when `worktreePath` is NOT a
 * linked worktree of the current session's repo (binary: S stays null →
 * caller keeps the global-path git status).
 *
 * STAGED (official mechanisms intentionally not ported — the worktree-pin
 * subsystem is absent from OCC, staged since OCC-46 for 2.1.222):
 *   - `env:ks(void 0,{repository:S.pin})` — the GIT_DIR/GIT_WORK_TREE/
 *     GIT_COMMON_DIR pinned env (binary `kus`). Running the git commands with
 *     cwd=worktreePath resolves the identical worktree natively; the pin is a
 *     sandbox hardening on top.
 *   - `filterDriversOff` (`q2`/`rHn`) — the config-safety scan that neutralizes
 *     filter/LFS drivers via `-c key=value` args. Deeply coupled to the pin
 *     subsystem's config reader; status/log output is unaffected for repos
 *     without smudge/clean filters, and for repos WITH them the official args
 *     only skip driver execution (a perf/safety optimization).
 */
export async function getGitStatusForWorktree(
  worktreePath: string,
): Promise<string | null> {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_worktree_started')

  try {
    // Binary `Ge=bAe(gr(se()))` vs `Fe=bAe(gr(Vl()))` — worktree info for the
    // agent cwd and the main-session cwd. `Vl()` reads the session
    // originalCwd — NOT the ALS-overridable current cwd — because runAgent
    // executes inside runWithCwdOverride(worktreePath), where getCwd() would
    // already return the worktree. `Re===null → git_status_skipped_not_git`.
    const [worktreeGitDir, mainGitDir] = await Promise.all([
      resolveGitDir(worktreePath),
      resolveGitDir(getOriginalCwd()),
    ])
    if (worktreeGitDir === null || mainGitDir === null) {
      logForDiagnosticsNoPII('info', 'git_status_worktree_skipped_not_git')
      return null
    }
    const worktreeCommonDir = (await getCommonDir(worktreeGitDir)) ?? worktreeGitDir
    const mainCommonDir = (await getCommonDir(mainGitDir)) ?? mainGitDir

    // Binary linked-worktree condition, verbatim:
    // Ge.gitDir!==Ge.commonDir && Ge.commonDir===Fe.commonDir && Ge.gitDir!==Fe.gitDir
    if (
      worktreeGitDir === worktreeCommonDir ||
      worktreeCommonDir !== mainCommonDir ||
      worktreeGitDir === mainGitDir
    ) {
      logForDiagnosticsNoPII('info', 'git_status_worktree_skipped_not_linked')
      return null
    }

    // Binary `w={cwd:S.cwd,preserveOutputOnError:!1,env:ks(void 0,{repository:S.pin})}`
    // (pin env staged — see doc comment).
    const worktreeExecOptions = {
      cwd: worktreePath,
      preserveOutputOnError: false as const,
    }
    const [head, mainBranch, status, log, userName] = await Promise.all([
      // Binary: sse(S.pin.gitDir).then(Te=>Te?.type==="branch"?Te.name:"HEAD")
      readGitHead(worktreeGitDir),
      getDefaultBranch(),
      execFileNoThrowWithCwd(gitExe(), [...GIT_STATUS_ARGS], worktreeExecOptions).then(
        ({ stdout }) => stdout.trim(),
      ),
      execFileNoThrowWithCwd(gitExe(), [...GIT_LOG_ARGS], worktreeExecOptions).then(
        ({ stdout }) => stdout.trim(),
      ),
      execFileNoThrowWithCwd(gitExe(), [...GIT_USER_NAME_ARGS], worktreeExecOptions).then(
        ({ stdout }) => stdout.trim(),
      ),
    ])

    logForDiagnosticsNoPII('info', 'git_status_worktree_completed', {
      duration_ms: Date.now() - startTime,
      status_length: status.length,
    })

    return buildGitStatusMessage({
      branch: head?.type === 'branch' ? head.name : 'HEAD',
      mainBranch,
      status,
      log,
      userName,
    })
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
  }
}

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    // Include system prompt injection if set (for cache breaking, ant-only)
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // CLAUDE_CODE_DISABLE_CLAUDE_MDS: hard off, always.
    // --bare: skip auto-discovery (cwd walk), BUT honor explicit --add-dir.
    // --bare means "skip what I didn't ask for", not "ignore what I asked for".
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      isMemoryLoadingPaused() ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
    // Await the async I/O (readFile/readdir directory walk) so the event
    // loop yields naturally at the first fs.readFile.
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // Cache for the auto-mode classifier (yoloClassifier.ts reads this
    // instead of importing claudemd.ts directly, which would create a
    // cycle through permissions/filesystem → permissions → yoloClassifier).
    setCachedClaudeMdContent(claudeMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      claudemd_length: claudeMd?.length ?? 0,
      claudemd_disabled: Boolean(shouldDisableClaudeMd),
    })

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)

// -- K1 (lean prompt) + K3 (ultracode) context-layer hooks ---------------
//
// These re-export the decision logic from src/utils/effort/ so the context /
// system-prompt layer can consult them without importing the effort module
// graph directly (and so source-grep verification can pin the wiring here).
//
// K1: lean_prompt-capable models get the lean system prompt by default; the
// full prompt is opt-in at higher effort (xhigh / max).
import { shouldUseLeanPrompt as _shouldUseLeanPrompt } from './utils/effort/leanPrompt.js'
import {
  getUltracodeTurnReminders as _getUltracodeTurnReminders,
  type UltracodeReminder as _UltracodeReminder,
} from './utils/effort/ultracode.js'

export function shouldUseLeanSystemPrompt(
  model: string,
  effort?: string,
): boolean {
  return _shouldUseLeanPrompt(model, effort)
}

// K3: when ultracode is active for the session, the context layer surfaces the
// per-turn ultracode meta reminders (isMeta) to the query loop. The array
// matches the 2.1.206 binary's per-turn reminder dispatch:
//   keyword-trigger turn → [workflow_keyword_request, ultra_effort_enter("full")]
//   subsequent turns    → [ultra_effort_enter("still")]
//   turn ultracode off  → [ultra_effort_exit]
//   otherwise           → []
// src/query.ts maps each reminder into a user-role isMeta message via
// buildHarnessReminderMessage() (the 2.1.201 non-system path).
export function getUltracodeSystemReminders(): _UltracodeReminder[] {
  return _getUltracodeTurnReminders()
}

