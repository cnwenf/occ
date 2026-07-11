import { realpath } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { findCanonicalGitRoot, getBranch, gitExe } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  validateWorktreeSlug,
  type WorktreeSession,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Path to an existing worktree of the current repository to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Creating worktree'
  },
  shouldDefer: true,
  async checkPermissions(input) {
    // 2.1.206 #5: Ask confirmation before entering a worktree outside
    // `.claude/worktrees/`. The create flow (no `path`) always lands in
    // `.claude/worktrees/`, so allow without prompting. An existing-worktree
    // `path` is allowed only if it resolves under the repo's
    // `.claude/worktrees/` dir; otherwise ask with a `safetyCheck` reason
    // (`classifierApprovable: false` — auto mode cannot pre-approve a
    // permission-root relocation). Mirrors the binary's `checkPermissions`
    // gate: `d3i(e.path)?.managed` → allow; else ask.
    if (!input.path) {
      return { behavior: 'allow', updatedInput: input }
    }
    const gitRoot = findCanonicalGitRoot(getCwd())
    if (!gitRoot) {
      // No git repo → can't determine the managed dir. Defer to call()
      // which throws an actionable "not in a git repository" error.
      return { behavior: 'allow', updatedInput: input }
    }
    const managedDir = resolve(gitRoot, '.claude', 'worktrees')
    const resolved = resolve(getCwd(), input.path)
    let realResolved: string
    try {
      realResolved = await realpath(resolved)
    } catch {
      // Path doesn't resolve → can't prove it's managed. Ask before
      // entering (call()/enterExistingWorktree will throw the realpath
      // error if the user approves).
      return {
        behavior: 'ask',
        message: `Enter the worktree at ${resolved}? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`,
        updatedInput: { ...input, path: resolved },
        decisionReason: {
          type: 'safetyCheck',
          reason:
            'permission-root relocation to a model-supplied worktree outside .claude/worktrees/',
          classifierApprovable: false,
        },
      }
    }
    const isManaged =
      realResolved === managedDir || realResolved.startsWith(managedDir + sep)
    if (isManaged) {
      return { behavior: 'allow', updatedInput: { ...input, path: realResolved } }
    }
    const note =
      realResolved !== resolved ? ` (resolves to ${realResolved})` : ''
    return {
      behavior: 'ask',
      message: `Enter the worktree at ${resolved}${note}? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`,
      updatedInput: { ...input, path: resolved },
      decisionReason: {
        type: 'safetyCheck',
        reason:
          'permission-root relocation to a model-supplied worktree outside .claude/worktrees/',
        classifierApprovable: false,
      },
    }
  },
  toAutoClassifierInput(input) {
    return input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // Validate not already in a worktree created by this session. When the
    // caller passes `path`, switching into another existing worktree is
    // allowed mid-session.
    if (getCurrentWorktreeSession() && !input.path) {
      throw new Error(
        'Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.',
      )
    }

    // Entering an existing worktree (mid-session switch) takes a separate
    // path that does not create a new worktree.
    if (input.path) {
      return enterExistingWorktree(input.path)
    }

    // Resolve to main repo root so worktree creation works from within a worktree
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    const slug = input.name ?? getPlanSlug()

    const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * Returns the realpath-normalized paths of every worktree registered in the
 * repository at `gitRoot` (via `git worktree list --porcelain`).
 */
async function listRegisteredWorktreePaths(
  gitRoot: string,
): Promise<string[]> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain'],
    { cwd: gitRoot },
  )
  if (result.code !== 0) {
    throw new Error(
      `Cannot enter worktree: failed to list registered worktrees: ${
        result.error ?? result.stderr
      }`,
    )
  }
  const paths: string[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const wtPath = line.slice('worktree '.length).trim()
      if (!wtPath) continue
      try {
        paths.push(await realpath(wtPath))
      } catch {
        paths.push(wtPath)
      }
    }
  }
  return paths
}

/**
 * Switch the session into an existing registered worktree instead of creating
 * a new one (claude-code 2.1.105: EnterWorktree `path` parameter). Mirrors
 * the create flow's side effects (chdir, session state, cache invalidation)
 * but skips worktree creation.
 */
async function enterExistingWorktree(
  worktreePathInput: string,
): Promise<{ data: Output }> {
  // Must be in a git repository to locate registered worktrees.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot enter an existing worktree: the current directory is not in a git repository.',
    )
  }

  // Resolve relative to the current directory, then normalize via realpath so
  // the registered-worktree lookup is path-stable.
  const resolvedPath = resolve(getCwd(), worktreePathInput)
  let realResolved: string
  try {
    realResolved = await realpath(resolvedPath)
  } catch (e) {
    throw new Error(
      `Cannot enter worktree: ${worktreePathInput}: ${(e as Error).message}`,
    )
  }

  // Verify the path is a registered worktree of the current repository.
  const registered = await listRegisteredWorktreePaths(gitRoot)
  if (!registered.includes(realResolved)) {
    throw new Error(
      `Cannot enter worktree: ${worktreePathInput} is not a registered worktree of ${gitRoot}. Run 'git -C ${gitRoot} worktree list' to see registered worktrees.`,
    )
  }

  const originalCwd = getCwd()
  process.chdir(realResolved)
  setCwd(realResolved)
  setOriginalCwd(getCwd())

  const worktreeBranch = await getBranch().catch(() => undefined)

  const session: WorktreeSession = {
    originalCwd,
    worktreePath: realResolved,
    worktreeName: basename(realResolved),
    worktreeBranch,
    sessionId: getSessionId(),
  }
  restoreWorktreeSession(session)
  saveWorktreeState(session)
  // Clear cached system prompt sections so env_info_simple recomputes with
  // worktree context.
  clearSystemPromptSections()
  // Clear memoized caches that depend on CWD
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()

  logEvent('tengu_worktree_entered_existing', {
    mid_session: true,
  })

  const branchInfo = worktreeBranch ? ` on branch ${worktreeBranch}` : ''

  return {
    data: {
      worktreePath: realResolved,
      worktreeBranch,
      message: `Entered worktree at ${realResolved}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    },
  }
}
