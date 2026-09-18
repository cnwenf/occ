// Parse plugin subcommand arguments into structured commands
export type ParsedCommand =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'install'; marketplace?: string; plugin?: string }
  | { type: 'install-from-source'; plugin: string; marketplaceSource: string }
  | { type: 'usage-error'; message: string }
  | { type: 'manage' }
  | { type: 'uninstall'; plugin?: string }
  | { type: 'enable'; plugin?: string }
  | { type: 'disable'; plugin?: string }
  | { type: 'validate'; path?: string }
  | {
      type: 'marketplace'
      action?: 'add' | 'remove' | 'update' | 'list'
      target?: string
    }

// Official 2.1.276 usage string (`p` in the parser chunk @208179468).
const INSTALL_FROM_SOURCE_USAGE =
  'Usage: /plugin install <plugin> --marketplace <source>'

export type MarketplaceFlagParseResult =
  | { type: 'install-from-source'; plugin: string; marketplaceSource: string }
  | { type: 'usage-error'; message: string }

/**
 * Port of official `o()`@208179468 (2.1.275 changelog: "/plugin install now
 * accepts --marketplace <source>, offering to add the marketplace first").
 * Scans the args AFTER the subcommand for `--marketplace <source>` or
 * `--marketplace=<source>`; returns undefined when the flag is absent.
 * Error strings are byte-exact with the official binary.
 */
export function parseMarketplaceFlag(
  parts: string[],
): MarketplaceFlagParseResult | undefined {
  const flagIndex = parts.findIndex(
    part => part === '--marketplace' || part.startsWith('--marketplace='),
  )
  if (flagIndex === -1) return undefined

  const flagToken = parts[flagIndex]!
  const isInlineForm = flagToken !== '--marketplace'
  // '--marketplace='.length === 14
  const marketplaceSource = isInlineForm
    ? flagToken.slice(14)
    : parts[flagIndex + 1]
  if (!marketplaceSource || marketplaceSource.startsWith('-')) {
    return {
      type: 'usage-error',
      message: `--marketplace needs a marketplace source (owner/repo or a URL). ${INSTALL_FROM_SOURCE_USAGE}`,
    }
  }

  const remaining = parts.filter(
    (_part, index) =>
      index !== flagIndex && (isInlineForm || index !== flagIndex + 1),
  )
  const plugin = remaining[0]
  if (remaining.length !== 1 || !plugin || plugin.startsWith('-')) {
    return {
      type: 'usage-error',
      message: `--marketplace needs exactly one plugin name. ${INSTALL_FROM_SOURCE_USAGE}`,
    }
  }

  if (plugin.lastIndexOf('@') > 0) {
    return {
      type: 'usage-error',
      message: `Name the marketplace once: <plugin>@<marketplace>, or ${INSTALL_FROM_SOURCE_USAGE.slice(7)}`,
    }
  }

  return {
    type: 'install-from-source',
    plugin,
    marketplaceSource,
  }
}

/**
 * Port of official `fEr`@208179468: canonical rendering of an
 * install-from-source command (used for deep links / re-dispatch).
 */
export function formatInstallFromSourceCommand({
  plugin,
  marketplaceSource,
}: {
  plugin: string
  marketplaceSource: string
}): string {
  return `/plugin install ${plugin} --marketplace ${marketplaceSource}`
}

export function parsePluginArgs(args?: string): ParsedCommand {
  if (!args) {
    return { type: 'menu' }
  }

  const parts = args.trim().split(/\s+/)
  const command = parts[0]?.toLowerCase()

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      return { type: 'help' }

    case 'install':
    case 'i': {
      // Official order (@208179468): --marketplace flag parsing first, then
      // plugin@marketplace, then marketplace-looking target, then plugin name.
      const flagResult = parseMarketplaceFlag(parts.slice(1))
      if (flagResult) {
        return flagResult
      }

      const target = parts[1]
      if (!target) {
        return { type: 'install' }
      }

      // Check if it's in format plugin@marketplace (official uses lastIndexOf
      // so scoped names like @org/plugin@market parse correctly)
      const atIndex = target.lastIndexOf('@')
      if (atIndex > 0) {
        return {
          type: 'install',
          plugin: target.slice(0, atIndex),
          marketplace: target.slice(atIndex + 1),
        }
      }

      // Check if the target looks like a marketplace (URL or path). Official
      // guard: a leading '@' means scoped package name, not a marketplace.
      const isMarketplace =
        !target.startsWith('@') &&
        (target.startsWith('http://') ||
          target.startsWith('https://') ||
          target.startsWith('file://') ||
          target.includes('/') ||
          target.includes('\\'))

      if (isMarketplace) {
        // This is a marketplace URL/path, no plugin specified
        return { type: 'install', marketplace: target }
      }

      // Otherwise treat it as a plugin name
      return { type: 'install', plugin: target }
    }

    case 'manage':
      return { type: 'manage' }

    case 'uninstall':
      return { type: 'uninstall', plugin: parts[1] }

    case 'enable':
      return { type: 'enable', plugin: parts[1] }

    case 'disable':
      return { type: 'disable', plugin: parts[1] }

    case 'validate': {
      const target = parts.slice(1).join(' ').trim()
      return { type: 'validate', path: target || undefined }
    }

    case 'marketplace':
    case 'market': {
      const action = parts[1]?.toLowerCase()
      const target = parts.slice(2).join(' ')

      switch (action) {
        case 'add':
          return { type: 'marketplace', action: 'add', target }
        case 'remove':
        case 'rm':
          return { type: 'marketplace', action: 'remove', target }
        case 'update':
          return { type: 'marketplace', action: 'update', target }
        case 'list':
          return { type: 'marketplace', action: 'list' }
        default:
          // No action specified, show marketplace menu
          return { type: 'marketplace' }
      }
    }

    default:
      // Unknown command, show menu
      return { type: 'menu' }
  }
}

export interface PluginArgCompletion {
  value: string
  description: string
}

/**
 * Port of the official `/plugin install <plugin> <TAB>` completion branch
 * (@208192104, 2.1.275): once exactly one plugin name has been completed for
 * `install`/`i`, offer the `--marketplace` flag. The completion entry is
 * byte-exact with the official binary.
 *
 * `completedParts` are the already-completed whitespace-separated tokens
 * starting with the subcommand (e.g. ['install', 'myplugin']); `currentToken`
 * is the token currently being typed. Returns [] when the official condition
 * does not hold.
 */
export function getPluginInstallCompletions(
  completedParts: string[],
  currentToken: string,
): PluginArgCompletion[] {
  const command = completedParts[0]?.toLowerCase()
  const parsed =
    currentToken !== '' &&
    completedParts.length === 2 &&
    (command === 'install' || command === 'i')
      ? parsePluginArgs(completedParts.join(' '))
      : undefined
  if (
    parsed?.type === 'install' &&
    parsed.plugin !== undefined &&
    parsed.marketplace === undefined
  ) {
    return [
      {
        value: '--marketplace',
        description: 'Install from a marketplace source, adding it first',
      },
    ]
  }
  return []
}

