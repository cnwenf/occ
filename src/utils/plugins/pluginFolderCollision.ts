/**
 * Plugin install id-collision refusal (official Claude Code 2.1.285).
 *
 * Changelog: "Installing a plugin whose id differs from an installed plugin's
 * id only in `.`, `-`, `@` or (on macOS/Windows) capitals is now refused when
 * the two ids would share a cache folder or data directory."
 *
 * Ported byte-faithfully from the decompiled official 2.1.285 linux-x64 ELF
 * (refusal core @206522228 region; naming functions chunk-98a68crr.js):
 *
 *   official            here
 *   --------            ----
 *   `f1`                foldPathForComparison (platform case fold)
 *   `iC`                stripInvisibleAndFoldCase
 *   `A7t`               pathsCollide
 *   `I7t`               sharesFoldersWith
 *   `jst("",id)`        pluginCacheFolderName (relative cache path)
 *   `gF`                pluginDirectories.pluginDataDirPath (imported)
 *   `mze`               hasNoInstallations
 *   `O7t`               findFolderHolders
 *   `x7t`               detectFolderCollision
 *   `ear`               explainIdDifference
 *   `FPt`               PluginFolderHeldError
 *   `Ist`               buildFolderHeldMessage
 *   `gc`                marketplaceOf
 *   `tS`/`pl`/`h2`      runSuggestion/pluginCommandText/isShellSafePluginId
 *   `vt(x,200)`         pluginDisplayText.sanitizePluginMessageText
 *   `If`                pluginDisplayText.wrapInCurlyQuotes
 *   `U`                 uniq (Set spread)
 *   `G`                 countWhere (filter().length)
 *   `Hf`                bootstrap/state.getProjectRoot
 *
 * Known omissions (documented, not invented):
 * - The official `jst` has an npm-marketplace lane (`s===V_` → `N0r`
 *   hex-escaping, `V_="npm"`). OCC has no npm marketplace lane, so the
 *   sanitizer path is the only one that exists here.
 * - The official `f1` windows arm applies `bJe` before `iC`; `bJe` is the
 *   identity in the linux build, so both folding arms reduce to `iC`.
 * - `vt`/`If` internals (`u`/`i` regex aliases, `Zg`/`cr`/`iG`/`L7`) are the
 *   shared display-sanitize chain already ported as textSanitize.ts (`Kt`);
 *   the quote substitutions unique to `vt`/`If` are applied on top.
 * - CLI command suggestions use OCC's binary name (`occ`), matching the
 *   existing convention in src/services/plugins/pluginOperations.ts:491.
 */

import { join } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { sanitizeDetailText } from '../textSanitize.js'
import { pluginDataDirPath, sanitizePluginId } from './pluginDirectories.js'
import {
  sanitizePluginMessageText,
  wrapInCurlyQuotes,
} from './pluginDisplayText.js'
import { PRIMARY_PLUGIN_DIRECTORY_NAME } from './schemas.js'

/** What two colliding ids would share: the install cache folder or the data dir. */
export type FolderShareKind = 'folder' | 'data'

/** Where the refusal message is rendered — wording differs per surface. */
export type FolderCollisionSurface = 'cli' | 'ui' | 'notice'

/** One scope/project installation of a plugin id (registry entry shape). */
export interface PluginInstallationRef {
  readonly scope: string
  readonly projectPath?: string
}

/** `installed_plugins.json`-style map: plugin id → its installations. */
export type InstalledPluginsById = Readonly<
  Record<string, ReadonlyArray<PluginInstallationRef> | undefined>
>

/** An installed plugin id that holds a folder the requested id needs. */
export interface FolderHolder {
  readonly id: string
  readonly shares: FolderShareKind
  readonly installations: ReadonlyArray<{
    scope: string
    projectPath?: string
  }>
}

/** How two ids differ — drives the "differ only in …" clause (official `ear`). */
export interface IdDifference {
  readonly capitals: boolean
  readonly punctuation: boolean
  readonly atSign: boolean
}

/** Official `x7t` result: which candidate collided, and with what. */
export type FolderCollision =
  | {
      readonly sharedWith: 'installed'
      readonly pluginId: string
      readonly holders: ReadonlyArray<FolderHolder>
    }
  | {
      readonly sharedWith: 'same-install'
      readonly pluginId: string
      readonly twin: string
      readonly shares: FolderShareKind
    }

/** Official `Ist(e)` parameter object. */
export interface FolderHeldMessageParams {
  readonly refused: string
  readonly askedFor: string
  readonly surface: FolderCollisionSurface
  readonly rootKept?: boolean
  readonly sharedWith: 'installed' | 'same-install'
  readonly holders?: ReadonlyArray<FolderHolder>
  readonly twin?: string
  readonly shares?: FolderShareKind
}

// ---------------------------------------------------------------------------
// Display helpers (official tS/pl/h2 + `w` id-quoter — vt/If live in
// pluginDisplayText.ts, shared with the other plugin message builders)
// ---------------------------------------------------------------------------

/** Official `w=(St)=>`"${vt(St,200)}"`` inside `Ist`. */
function quoteId(id: string): string {
  return `"${sanitizePluginMessageText(id, 200)}"`
}

/** Official `h2`: ids safe to embed in a suggested shell command. */
function isShellSafePluginId(id: string): boolean {
  return /^\w[\w.@-]*$/.test(id)
}

/** Official `pl(e,n,t)` — with OCC's binary name (see file header). */
function pluginCommandText(
  command: string,
  id: string,
  extra?: string,
): string | null {
  if (!isShellSafePluginId(id)) return null
  return `occ ${command} ${id}${extra ? ` ${extra}` : ''}`
}

/** Official `tS(e,n,{extra,tail,fallback})`. */
function runSuggestion(
  command: string,
  id: string,
  options: { extra?: string; tail?: string; fallback: string },
): string {
  const text = pluginCommandText(command, id, options.extra)
  if (text === null) return options.fallback
  const tail = options.tail ?? ''
  return `run \`${text}\`${tail ? ` ${tail}` : ''}`
}

// ---------------------------------------------------------------------------
// Path model (official f1/iC/jst/gF)
// ---------------------------------------------------------------------------

/** Official `iC`: strip bidi/zero-width invisibles, then case-fold. */
function stripInvisibleAndFoldCase(path: string): string {
  return path
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '')
    .toUpperCase()
    .toLowerCase()
}

/**
 * Official `f1`: Windows and macOS filesystems are case-insensitive, so the
 * comparison folds case (and invisibles) there; Linux paths compare verbatim.
 * `platform` is injectable for tests — the official reads it at build time.
 */
export function foldPathForComparison(
  path: string,
  platform: string = process.platform,
): string {
  if (platform === 'win32' || platform === 'darwin') {
    return stripInvisibleAndFoldCase(path)
  }
  return path
}

/**
 * Official `jst("",id)`: the relative install-cache folder for a plugin id —
 * `cache/<sanitized marketplace|unknown>/<sanitized name|id>`. The id is split
 * at the LAST `@` (matching the official `gc`/`Bx` normalization; note OCC's
 * parsePluginIdentifier splits at the first `@` — marketplace names cannot
 * contain `@`, so the two agree on all well-formed ids).
 */
export function pluginCacheFolderName(pluginId: string): string {
  const at = pluginId.lastIndexOf('@')
  const marketplace = at >= 0 ? pluginId.slice(at + 1) : ''
  const name = at >= 0 ? pluginId.slice(0, at) : pluginId
  return join(
    'cache',
    sanitizePluginId(marketplace || 'unknown'),
    sanitizePluginId(name || pluginId),
  )
}

/** Official `A7t(e,n)`: paths equal under the platform's case folding. */
export function pathsCollide(
  a: string,
  b: string,
  platform: string = process.platform,
): boolean {
  return (
    foldPathForComparison(a, platform) === foldPathForComparison(b, platform)
  )
}

/**
 * Official `I7t(e,n)`: what two plugin ids would share on disk —
 * `"folder"` (install cache), `"data"` (persistent data dir), or null.
 */
export function sharesFoldersWith(
  a: string,
  b: string,
  platform: string = process.platform,
): FolderShareKind | null {
  if (
    pathsCollide(pluginCacheFolderName(a), pluginCacheFolderName(b), platform)
  ) {
    return 'folder'
  }
  if (pathsCollide(pluginDataDirPath(a), pluginDataDirPath(b), platform)) {
    return 'data'
  }
  return null
}

/** Official `gc`: marketplace of an id (after the last `@`), if any. */
export function marketplaceOf(pluginId: string): string | undefined {
  const at = pluginId.lastIndexOf('@')
  if (at < 0) return undefined
  const marketplace = pluginId.slice(at + 1)
  return marketplace === '' ? undefined : marketplace
}

// ---------------------------------------------------------------------------
// Collision detection (official mze/O7t/x7t/ear)
// ---------------------------------------------------------------------------

/**
 * Official `mze(e,n)`: an id is a refusal candidate only when it has NO
 * installations of its own and it isn't a primary-directory pseudo-plugin
 * (`@anthropic-plugin-directory` — official `Yf`).
 */
export function hasNoInstallations(
  registry: InstalledPluginsById,
  pluginId: string,
): boolean {
  return (
    !pluginId.endsWith(`@${PRIMARY_PLUGIN_DIRECTORY_NAME}`) &&
    (registry[pluginId]?.length ?? 0) === 0
  )
}

/**
 * Official `O7t(e,n)`: installed ids that hold a folder the requested id
 * would need, with their installation scopes.
 */
export function findFolderHolders(
  registry: InstalledPluginsById,
  pluginId: string,
  platform: string = process.platform,
): FolderHolder[] {
  if (!hasNoInstallations(registry, pluginId)) return []
  return Object.entries(registry).flatMap(([otherId, installations]) => {
    const shares =
      otherId !== pluginId && installations !== undefined && installations.length > 0
        ? sharesFoldersWith(otherId, pluginId, platform)
        : null
    if (shares === null || installations === undefined) return []
    return [
      {
        id: otherId,
        shares,
        installations: installations.map(({ scope, projectPath }) => ({
          scope,
          ...(projectPath !== undefined && { projectPath }),
        })),
      },
    ]
  })
}

/**
 * Official `x7t(e,n,r)`: first colliding candidate — either against an
 * already-installed id (`sharedWith: "installed"`) or against a sibling the
 * same install would bring along (`sharedWith: "same-install"`).
 */
export function detectFolderCollision(
  candidates: ReadonlyArray<string>,
  siblingIds: ReadonlyArray<string>,
  registry: InstalledPluginsById,
  platform: string = process.platform,
): FolderCollision | null {
  for (const pluginId of candidates) {
    if (!hasNoInstallations(registry, pluginId)) continue
    const holders = findFolderHolders(registry, pluginId, platform)
    if (holders.length > 0) {
      return { pluginId, sharedWith: 'installed', holders }
    }
    for (const twin of siblingIds) {
      const shares =
        twin !== pluginId && hasNoInstallations(registry, twin)
          ? sharesFoldersWith(twin, pluginId, platform)
          : null
      if (shares !== null) {
        return { pluginId, sharedWith: 'same-install', twin, shares }
      }
    }
  }
  return null
}

/** Official `ear(e,n,r)`: how two colliding ids differ (message clause). */
export function explainIdDifference(
  a: string,
  b: string,
  shares: FolderShareKind,
): IdDifference {
  return {
    capitals:
      shares === 'folder'
        ? pluginCacheFolderName(a) !== pluginCacheFolderName(b)
        : pluginDataDirPath(a) !== pluginDataDirPath(b),
    punctuation: shares === 'folder' && a.toLowerCase() !== b.toLowerCase(),
    atSign: shares === 'data',
  }
}

// ---------------------------------------------------------------------------
// Error + message (official FPt/Ist)
// ---------------------------------------------------------------------------

/**
 * Official `FPt`: refusal error thrown by the install gates. The official
 * passes `"plugin not installed: another installed plugin has one of its
 * folders"` as a structured second argument to its base error class; OCC's
 * Error model has no such slot, so the user-facing message is the `Ist`
 * output and `pluginCommandErrorCategory` mirrors the official field.
 */
export class PluginFolderHeldError extends Error {
  readonly pluginCommandErrorCategory = 'validation'
  readonly holders: ReadonlyArray<FolderHolder>

  constructor(message: string, holders: ReadonlyArray<FolderHolder>) {
    super(message)
    this.name = 'PluginFolderHeldError'
    this.holders = holders
  }
}

function uniq<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)]
}

/**
 * Official `Ist`: the full refusal message, per surface (cli/ui/notice).
 * Strings are byte-identical to the official binary; only the suggested
 * command's binary name follows OCC's `occ` convention (file header).
 */
export function buildFolderHeldMessage(
  params: FolderHeldMessageParams,
): string {
  const { refused, askedFor, surface, rootKept = false } = params
  const holders =
    params.sharedWith === 'installed' ? (params.holders ?? []) : []
  const others: ReadonlyArray<{ id: string; shares: FolderShareKind }> =
    params.sharedWith === 'installed'
      ? holders
      : [{ id: params.twin ?? '', shares: params.shares ?? 'folder' }]

  const diffs = others.map(other =>
    explainIdDifference(other.id, refused, other.shares),
  )
  const anyCapitals = diffs.some(diff => diff.capitals)
  const punctuation = diffs.some(diff => diff.punctuation) ? '"." and "-"' : ''
  const because = `because ${others.length > 1 ? 'their' : 'the two'} ids ${
    diffs.some(diff => diff.atSign)
      ? `are the same once "@" and "." are written as "-"${anyCapitals ? ' and capitals are ignored' : ''}`
      : anyCapitals || punctuation !== ''
        ? `differ only in ${anyCapitals ? `capitals${punctuation === '' ? '' : ', '}` : ''}${punctuation}`
        : 'give one folder name'
  }`
  const shareWhat = others.every(other => other.shares === 'folder')
    ? 'its folder'
    : others.every(other => other.shares === 'data')
      ? 'its saved data'
      : 'its folder or its saved data'

  const dependencyCase =
    refused !== askedFor &&
    (rootKept || holders.some(holder => holder.id === askedFor))
  const prefix = dependencyCase
    ? `${quoteId(refused)} was not installed: ${quoteId(askedFor)} needs it, but it`
    : refused === askedFor
      ? `${quoteId(refused)} was not installed: it`
      : `${quoteId(askedFor)} was not installed: it needs ${quoteId(refused)}, which`
  const suffix = dependencyCase
    ? ` ${quoteId(askedFor)} will not load without it.`
    : ''

  // Same-install / asked-for-is-a-holder branch
  if (
    params.sharedWith === 'same-install' ||
    holders.some(holder => holder.id === askedFor)
  ) {
    const other =
      params.sharedWith === 'same-install' ? (params.twin ?? '') : askedFor
    const maintainer =
      marketplaceOf(other) === marketplaceOf(refused)
        ? "Only the marketplace's maintainer can fix this, by renaming one of them."
        : 'Only a maintainer of one of the two marketplaces can fix this, by renaming one of them.'
    return `${prefix} would share ${shareWhat} with ${quoteId(other)}${other === askedFor ? '' : ', which the same install brings along'}, ${because}.${suffix} ${maintainer}`
  }

  // Installed-holders branch
  const installations = holders.flatMap(holder =>
    holder.installations.map(installation => ({
      id: holder.id,
      ...installation,
    })),
  )
  const isProjectScoped = (installation: { scope: string }) =>
    installation.scope === 'project' || installation.scope === 'local'
  const currentProject = installations.some(isProjectScoped)
    ? getProjectRoot()
    : null
  const inOtherProject = (installation: {
    scope: string
    projectPath?: string
  }) =>
    isProjectScoped(installation) &&
    (installation.projectPath === undefined ||
      installation.projectPath !== currentProject)
  const managedCount = installations.filter(
    installation => installation.scope === 'managed',
  ).length
  const isAre = holders.length > 1 ? 'are' : 'is'
  const installedBy =
    managedCount > 0 && managedCount === installations.length
      ? 'which your organization installed'
      : managedCount > 0
        ? `which ${isAre} installed, also by your organization`
        : installations.length > 0 && installations.every(inOtherProject)
          ? `which ${isAre} installed in ${uniq(installations.map(installation => installation.projectPath)).length > 1 ? 'other projects' : 'another project'}`
          : `which ${isAre} installed`
  const holderList = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    holders.map(holder => quoteId(holder.id)),
  )
  const core = `${prefix} would share ${shareWhat} with ${holderList}, ${installedBy}, ${because}.${suffix}${holders.length > 1 ? '' : ' Only one of the two can be installed.'}`

  if (managedCount > 0 || installations.length === 0) {
    return surface === 'notice' && managedCount > 0
      ? `Ask your administrator: ${core}`
      : `${core}${managedCount > 0 ? ' Ask your administrator.' : ''}`
  }

  const steps = uniq(
    installations.map(installation => {
      const fallback = `uninstall ${quoteId(installation.id)}`
      if (inOtherProject(installation) && installation.projectPath === undefined) {
        return `${fallback} in the project it is installed for`
      }
      const command =
        surface === 'cli'
          ? runSuggestion('plugin uninstall', installation.id, {
              extra:
                installation.scope === 'user'
                  ? undefined
                  : `--scope ${installation.scope}`,
              fallback,
            })
          : `${fallback}${installation.scope === 'user' || inOtherProject(installation) ? '' : ` at ${installation.scope} scope`}${surface === 'notice' && !inOtherProject(installation) ? ' in /plugin' : ''}`
      if (!inOtherProject(installation)) return command
      const where = wrapInCurlyQuotes(
        sanitizeDetailText(installation.projectPath ?? '', 200),
      )
      return `${command} in ${where === '' ? 'that project' : where}`
    }),
  )
  const target =
    refused === askedFor
      ? `${quoteId(refused)} instead`
      : dependencyCase
        ? `${quoteId(refused)} as well`
        : quoteId(askedFor)
  const deleteNote =
    surface === 'cli'
      ? 'Uninstalling a plugin also deletes its saved data.'
      : `${surface === 'ui' ? 'When it asks' : 'If /plugin asks'}, let it delete the plugin's saved data: the new plugin would otherwise start with it.`
  return surface === 'notice'
    ? `First ${steps.join('; ')}, to install ${target}. ${deleteNote} ${core}`
    : `${core} To install ${target}, first ${steps.length > 1 ? `do each of these: ${steps.join('; ')}` : steps[0]}. ${deleteNote}`
}
