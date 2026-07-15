/**
 * Workflow save-path resolution — mirrors the official 2.1.210 binary.
 *
 * 2.1.208 #25: "Fixed workflow save dialog showing `~/.claude/workflows/`
 * instead of `CLAUDE_CONFIG_DIR` location for user-scope saves".
 *
 * Binary (2.1.210) verified by string-mining:
 *   - `tkt()  = path.join(un(), "workflows")`  where `un()` is the
 *     config-dir helper (`CLAUDE_CONFIG_DIR ?? ~/.claude`) — the same
 *     function OCC exposes as `getClaudeConfigHomeDir`.
 *   - `zab("user", cwd) = tkt()`  → user-scope workflows dir is
 *     `join(getClaudeConfigHomeDir(), "workflows")`, NOT a hardcoded
 *     `~/.claude/workflows`.
 *   - Display ternary: `scope==="project" ? `.claude/workflows/${name}.js`
 *     : BP(path.join(tkt(), `${name}.js`))` where `BP` tilde-shortens.
 *
 * 2.1.206 (pre-fix) hardcoded the user-scope DISPLAY as the literal
 * `~/.claude/workflows/${name}.js`, ignoring `CLAUDE_CONFIG_DIR`.
 *
 * Self-contained (fs/path only) — no React/Ink — so it is unit-testable
 * without rendering. Kept here next to `workflowDiscovery.ts`.
 */
import { homedir } from 'os'
import { join, sep } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

export type WorkflowSaveScope = 'project' | 'user'

/**
 * The user-scope workflows directory, config-dir-aware. Equivalent to the
 * binary's `tkt()`. Honors `CLAUDE_CONFIG_DIR` (via getClaudeConfigHomeDir)
 * so a relocated config dir is used for both the display and the write.
 */
export function userWorkflowsDir(): string {
  return join(getClaudeConfigHomeDir(), 'workflows')
}

/**
 * Resolve the workflows directory for a save scope. Mirrors the binary's
 * `zab(scope, cwd)`: user scope → config-dir-aware `userWorkflowsDir()`;
 * project scope → `join(cwd, ".claude/workflows")`.
 */
export function resolveWorkflowsDir(
  scope: WorkflowSaveScope,
  cwd: string,
): string {
  if (scope === 'user') {
    return userWorkflowsDir()
  }
  return join(cwd, '.claude', 'workflows')
}

/**
 * Tilde-shorten an absolute path for display, matching the binary's `BP`:
 * replace the `homedir()` prefix with `~`; otherwise return unchanged.
 * A custom `CLAUDE_CONFIG_DIR` outside `homedir()` is shown verbatim (not
 * tilde-shortened) — exactly like the binary.
 */
export function tildeShortenPath(absPath: string): string {
  const home = homedir()
  if (absPath === home) return '~'
  if (absPath.startsWith(home + sep)) return '~' + absPath.slice(home.length)
  return absPath
}

/**
 * Compute the DISPLAY path shown in the save dialog subtitle. Mirrors the
 * 2.1.210 binary's ternary:
 *   - project → relative `.claude/workflows/<name>.js`
 *   - user    → tilde-shortened absolute path under the effective config
 *               dir's `workflows` subdir (NOT a hardcoded `~/.claude/...`).
 *
 * For user scope with a custom `CLAUDE_CONFIG_DIR`, the display reflects
 * the temp/custom dir verbatim — the 2.1.208 fix.
 */
export function displayWorkflowPath(
  scope: WorkflowSaveScope,
  name: string,
  cwd: string,
): string {
  if (scope === 'project') {
    return `.claude/workflows/${name}.js`
  }
  return tildeShortenPath(join(userWorkflowsDir(), `${name}.js`))
}

/**
 * Resolve the absolute file path the save action writes to. Mirrors the
 * binary's `cba`: `join(resolveWorkflowsDir(scope, cwd), `${name}.js`)`.
 */
export function resolveWorkflowFilePath(
  scope: WorkflowSaveScope,
  name: string,
  cwd: string,
): string {
  return join(resolveWorkflowsDir(scope, cwd), `${name}.js`)
}
