/**
 * CC 2.1.216 #18 — `.claude` symlink write-redirect guard.
 *
 * Workflow saves and scheduled-task state are written under `<project>/.claude/`.
 * If `.claude` (or the write target) is a repository-committed symlink that
 * resolves outside the project root, an unguarded write would silently land
 * outside the project. The official 2.1.216 binary hardens this with a
 * realpath-containment check: a write whose resolved form falls outside the
 * project directory is refused rather than followed.
 *
 * Binary recon (s21216.txt) — the official's analogous refusals:
 *   - Worktree creation: `Cannot create worktree: ${n} is a symlink. A
 *     repository-committed symlink at .claude, .claude/worktrees, or
 *     .claude/worktrees/<name> could redirect worktree creation outside
 *     the repository. Remove the symlink and retry.`
 *   - Read-deny gate: `... it resolved outside the projects directory.`
 *   - Write path validation decisionReason: `Path contains '..' traversal
 *     after a directory segment, which may follow a symlink outside the
 *     working directory`.
 *
 * The internal scheduled-task / workflow-save writes reuse the same
 * realpath-containment behavior: resolve every form of the target (lexical +
 * symlink chain + deepest existing ancestor for not-yet-existing files) and
 * refuse when a resolved form is outside a resolved form of the project root.
 * A `.claude` symlink that resolves WITHIN the project is allowed (the
 * redirect stays inside). Resolving both sides with
 * `getPathsForPermissionCheck` also handles macOS `/tmp` → `/private/tmp`,
 * where the project root itself lives under a symlinked ancestor.
 */
import { normalize, sep } from 'path'
import { getPathsForPermissionCheck } from './fsOperations.js'

/**
 * Thrown when a write under `.claude/` would follow a symlink whose
 * resolved form is outside the project directory.
 */
export class ClaudeWriteOutsideProjectError extends Error {
  /** The original (pre-realpath) write target. */
  readonly target: string
  /** The most-resolved form of the target, used as evidence in the message. */
  readonly resolved: string
  constructor(target: string, resolved: string) {
    super(
      `Cannot write to "${target}": it resolves to "${resolved}", which is outside the project directory.`,
    )
    this.name = 'ClaudeWriteOutsideProjectError'
    this.target = target
    this.resolved = resolved
  }
}

/**
 * Assert that every resolved form of `target` sits inside some resolved
 * form of `projectRoot`. Throws `ClaudeWriteOutsideProjectError` if any
 * resolved form escapes — a single escaping form means the write would
 * be redirected outside the project, which is exactly what #18 hardens.
 *
 * Using `.every` (not `.some`) mirrors the established jobs-dir guard in
 * `src/utils/permissions/filesystem.ts` (`allInsideJobDir`): a path is only
 * safe when ALL of its resolved forms are contained.
 */
export function assertWriteInsideProject(
  target: string,
  projectRoot: string,
): void {
  const targetForms = getPathsForPermissionCheck(target).map(p =>
    normalize(p),
  )
  const rootForms = getPathsForPermissionCheck(projectRoot).map(p =>
    normalize(p),
  )
  const inside = targetForms.every(t =>
    rootForms.some(r => t === r || t.startsWith(r + sep)),
  )
  if (!inside) {
    // The last form is the most-resolved (realpath'd) — best evidence.
    const resolved = targetForms[targetForms.length - 1] ?? target
    throw new ClaudeWriteOutsideProjectError(target, resolved)
  }
}
