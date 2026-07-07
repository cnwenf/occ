/**
 * K3 (2.1.154): dynamic workflow discovery.
 *
 * Workflows are self-contained scripts discovered from `.claude/workflows/`
 * (project) and `~/.claude/workflows/` (user). A workflow name resolves to
 * `<dir>/<name>.js`. The /workflows command lists them; the Workflow tool runs
 * them. Mirrors the 2.1.200 binary: `.claude/workflows/${L}.js` … "Resolves to
 * a self-contained script."
 *
 * Self-contained (fs/path only) to avoid TDZ / module-init cycles.
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Directory names (relative to project root / home).
export const PROJECT_WORKFLOWS_DIR = '.claude/workflows'
export const USER_WORKFLOWS_DIR = '.claude/workflows'

export type WorkflowSource = 'project' | 'user'

export interface DiscoveredWorkflow {
  name: string
  path: string
  source: WorkflowSource
}

/**
 * Runtime gate mirroring the binary's `CE()` (the /workflows command's
 * `isEnabled: () => CE()`). Default: enabled. Set
 * CLAUDE_CODE_WORKFLOWS_DISABLED=1 to turn the command + discovery off.
 */
export function isWorkflowsEnabled(): boolean {
  return process.env.CLAUDE_CODE_WORKFLOWS_DISABLED !== '1'
}

function projectWorkflowsDir(cwd: string): string {
  return join(cwd, PROJECT_WORKFLOWS_DIR)
}

function userWorkflowsDir(): string {
  return join(homedir(), USER_WORKFLOWS_DIR)
}

/**
 * List `.js`/`.mjs`/`.cjs` scripts in a workflows directory. Returns names
 * (filename without extension) with their absolute paths. Silently returns []
 * if the directory does not exist.
 */
function listScripts(dir: string, source: WorkflowSource): DiscoveredWorkflow[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: DiscoveredWorkflow[] = []
  for (const entry of entries) {
    if (!/\.(js|mjs|cjs)$/.test(entry)) continue
    const full = join(dir, entry)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push({
      name: entry.replace(/\.(js|mjs|cjs)$/, ''),
      path: full,
      source,
    })
  }
  return out
}

/**
 * Discover all available workflows (project dir first, then user dir). A name
 * present in both is returned once from the project source (project shadows
 * user, matching the binary's project-vs-user precedence).
 */
export function discoverWorkflows(
  cwd: string = process.cwd(),
): DiscoveredWorkflow[] {
  const project = listScripts(projectWorkflowsDir(cwd), 'project')
  const user = listScripts(userWorkflowsDir(), 'user')
  const seen = new Set(project.map(w => w.name))
  const merged = [...project, ...user.filter(w => !seen.has(w.name))]
  return merged.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a workflow name to a self-contained script path. `source` selects
 * the directory; when omitted, project is tried first then user (project
 * wins). Returns null if no matching script exists.
 *
 * Mirrors the binary: `.claude/workflows/${name}.js` / `~/.claude/workflows/${name}.js`.
 */
export function resolveWorkflowScript(
  name: string,
  source?: WorkflowSource,
  cwd: string = process.cwd(),
): string | null {
  const candidates: Array<[string, WorkflowSource]> =
    source === 'user'
      ? [[userWorkflowsDir(), 'user']]
      : source === 'project'
        ? [[projectWorkflowsDir(cwd), 'project']]
        : [
            [projectWorkflowsDir(cwd), 'project'],
            [userWorkflowsDir(), 'user'],
          ]
  for (const [dir] of candidates) {
    for (const ext of ['.js', '.mjs', '.cjs']) {
      const full = join(dir, `${name}${ext}`)
      if (existsSync(full)) {
        try {
          if (statSync(full).isFile()) return full
        } catch {
          continue
        }
      }
    }
  }
  return null
}
