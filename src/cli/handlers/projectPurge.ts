/**
 * `claude project purge` subcommand handler.
 *
 * Deletes all Claude Code state for a project: the transcript directory
 * (~/.claude/projects/<sanitized-path>/) and the projects[<path>] config
 * entry. Mirrors the official 2.1.200 `purgeProjectHandler`.
 *
 * Dynamically imported only when `claude project purge` runs.
 */

import { join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getProjectsDir } from '../../utils/sessionStorage.js'
import { sanitizePath } from '../../utils/path.js'
import { getCwd } from '../../utils/cwd.js'
import { logEvent } from '../../services/analytics/index.js'

type PurgeItemKind = 'dir' | 'config-key'

/**
 * CC 2.1.288 #77 — `claude project purge` was renamed to `claude purge`; the
 * old name still works and prints a notice. All four strings below are verbatim
 * from the official 2.1.288 binary's CLI command-registration chunk
 * (@216868818): `dn` (rename prefix), `Mn` (command description), the legacy
 * notice `${dn}. The old name still works for now.`, and the legacy description
 * `${dn}. ${Mn}`.
 */
export const PROJECT_PURGE_RENAME_PREFIX =
  '`claude project purge` is now `claude purge`'
export const PURGE_COMMAND_DESCRIPTION =
  'Delete all Claude Code state for a project (transcripts, tasks, file history, config entry)'
export const PROJECT_PURGE_RENAME_NOTICE = `${PROJECT_PURGE_RENAME_PREFIX}. The old name still works for now.`
export const PROJECT_PURGE_LEGACY_DESCRIPTION = `${PROJECT_PURGE_RENAME_PREFIX}. ${PURGE_COMMAND_DESCRIPTION}`

/**
 * Emitted on the legacy `claude project purge` path before the purge runs.
 * Written to stderr so it never corrupts piped `--dry-run` stdout.
 */
export function emitProjectPurgeRenameNotice(): void {
  process.stderr.write(`${PROJECT_PURGE_RENAME_NOTICE}\n`)
}

export type PurgeItem = {
  kind: PurgeItemKind
  path: string
  // For config-key items, the project path key to remove from config.projects
  configKey?: string
}

export type PurgeOptions = {
  dryRun?: boolean
  all?: boolean
  interactive?: boolean
}

function resolveAbsolutePath(input: string | undefined): string {
  if (!input) {
    return getCwd()
  }
  // Allow relative paths; resolve against cwd
  const { resolve } = require('path') as typeof import('path')
  return resolve(input)
}

/**
 * Enumerate every project path known to Claude Code: the keys present in
 * config.projects plus any transcript directories under ~/.claude/projects/.
 */
async function discoverAllProjectPaths(): Promise<string[]> {
  const paths = new Set<string>()
  const config = getGlobalConfig()
  for (const key of Object.keys(config.projects ?? {})) {
    paths.add(key)
  }
  const fs = getFsImplementation()
  const projectsDir = getProjectsDir()
  try {
    const entries = await fs.readdir(projectsDir)
    for (const entry of entries) {
      // Transcript dirs are sanitized names; we cannot perfectly reverse them,
      // so we record the sanitized dir name and let the dir-purge handle it.
      paths.add(join(projectsDir, entry.name))
    }
  } catch {
    // projects dir may not exist yet
  }
  return [...paths]
}

/**
 * Build the list of purgeable items for a single project path.
 */
async function collectItemsForProject(
  projectPath: string,
): Promise<{ items: PurgeItem[]; warnings: string[] }> {
  const items: PurgeItem[] = []
  const warnings: string[] = []
  const fs = getFsImplementation()

  // 1. Transcript / file-history directory under ~/.claude/projects/
  const projectsDir = getProjectsDir()
  const transcriptDir = join(projectsDir, sanitizePath(projectPath))
  try {
    const stat = await fs.stat(transcriptDir)
    if (stat.isDirectory()) {
      items.push({ kind: 'dir', path: transcriptDir })
    }
  } catch {
    // No transcript dir for this project — that's fine
  }

  // 2. config.projects[<projectPath>] entry
  const config = getGlobalConfig()
  if (config.projects?.[projectPath] !== undefined) {
    items.push({
      kind: 'config-key',
      path: `config: projects["${projectPath}"]`,
      configKey: projectPath,
    })
  }

  return { items, warnings }
}

function describeItem(item: PurgeItem): string {
  return item.path
}

async function deleteItem(item: PurgeItem): Promise<string | null> {
  const fs = getFsImplementation()
  try {
    if (item.kind === 'dir') {
      await fs.rm(item.path, { recursive: true, force: true })
      return null
    }
    if (item.kind === 'config-key' && item.configKey) {
      saveGlobalConfig(current => {
        if (!current.projects?.[item.configKey!]) {
          return current
        }
        const nextProjects = { ...current.projects }
        delete nextProjects[item.configKey!]
        return { ...current, projects: nextProjects }
      })
      return null
    }
  } catch (err) {
    return item.path
  }
  return null
}

function printPlan(label: string, items: PurgeItem[], warnings: string[]): void {
  // eslint-disable-next-line no-console
  console.log(`Purge plan for ${label}`)
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log('  (nothing found)')
  }
  for (const item of items) {
    // eslint-disable-next-line no-console
    console.log(`  ${describeItem(item)}`)
  }
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.log(`  warning: ${warning}`)
  }
}

export async function purgeProjectHandler(
  target: string | undefined,
  options: PurgeOptions,
): Promise<void> {
  const { dryRun, all, interactive } = options

  // Mutual exclusion: -i/--interactive cannot be combined with --all
  if (all && interactive) {
    logEvent('cli_purge_project', { stage: 'invalid_interactive_all' })
    // eslint-disable-next-line no-console
    console.error('Cannot use -i/--interactive with --all.')
    process.exit(1)
  }

  const configHome = getClaudeConfigHomeDir()

  if (all) {
    // Gather items across every known project
    const allPaths = await discoverAllProjectPaths()
    const allItems: PurgeItem[] = []
    const allWarnings: string[] = []
    for (const p of allPaths) {
      const { items, warnings } = await collectItemsForProject(p)
      allItems.push(...items)
      allWarnings.push(...warnings)
    }

    if (allItems.length === 0) {
      logEvent('cli_purge_project', { stage: 'cli_purge_project_nothing_found' })
      // eslint-disable-next-line no-console
      console.log(`No Claude Code project state found under ${configHome}.`)
      return
    }

    printPlan('all projects', allItems, allWarnings)

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(`Dry run: ${allItems.length} item(s) would be deleted.`)
      return
    }

    await executeDeletion(allItems)
    return
  }

  // Single-project purge
  const projectPath = resolveAbsolutePath(target)
  const { items, warnings } = await collectItemsForProject(projectPath)

  if (items.length === 0) {
    logEvent('cli_purge_project', { stage: 'cli_purge_project_nothing_found' })
    // eslint-disable-next-line no-console
    console.log(
      `No Claude Code project state found for ${projectPath} under ${configHome}.`,
    )
    return
  }

  printPlan(projectPath, items, warnings)

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`Dry run: ${items.length} item(s) would be deleted.`)
    return
  }

  await executeDeletion(items)
}

export async function executeDeletion(items: PurgeItem[]): Promise<void> {
  const failures: string[] = []
  for (const item of items) {
    const failure = await deleteItem(item)
    if (failure) {
      failures.push(failure)
    }
  }
  if (failures.length > 0) {
    // CC 2.1.293 #33 — official `K` (@231701020): keep deleting, list the
    // failures, tell the user what is still on disk, then exit nonzero so
    // scripts/CI observe the failure. The failed-items line
    // (`N item(s) failed:\n  <paths>`) is byte-identical to the official, and
    // the trailing "\nWhat could not be deleted is still on disk: …" sentence
    // is verbatim from report §33 / the binary (single combined message, as the
    // official builds one string). The official gates that sentence on a
    // `delete_failed_` failure code; OCC's `deleteItem` returns a bare path
    // string with no code, so it is emitted for any failure (documented
    // divergence — every OCC failure is an on-disk delete or a config write).
    //
    // The official anti-hang path `Tt` (`Purge stopped before it finished: …`,
    // analytics `purgeStoppedByError` / `stopped_${code}`) is NOT ported:
    // OCC's `deleteItem` is non-interactive and swallows per-item errors, so a
    // purge can never hang mid-flight and that event is unreachable here
    // (report §33: "no `purgeStoppedByError` equivalent needed").
    logEvent('cli_purge_project', { stage: 'config_write_failed' })
    // eslint-disable-next-line no-console
    console.error(
      `${failures.length} item(s) failed:\n  ${failures.join('\n  ')}\nWhat could not be deleted is still on disk: fix the cause and run the command again, or delete those paths by hand.`,
    )
    process.exit(1)
  } else {
    logEvent('cli_purge_project', { stage: 'complete' })
    // eslint-disable-next-line no-console
    console.log(`Deleted ${items.length} item(s).`)
  }
}
