/**
 * `claude plugin install --config <server>.<key>=<value>` parsing + routing
 * (official Claude Code 2.1.285, changelog item 10 — NEW flag to set bundled
 * `.mcpb` server / plugin userConfig options at install time).
 *
 * Ported byte-faithfully from the decompiled official 2.1.285 linux-x64 ELF
 * (install-command chunk @222230600–222233300; functions `j`/`Z`/`B`/`P`):
 *
 *   official            here
 *   --------            ----
 *   `j(e)`              parseConfigPair
 *   `Z(e,n,o,s)`        routeConfigPairs
 *   `B({unreadable,remoteCount})`  buildUnreadRemoteSuffix
 *   `P(n,sing,plur)`    pluralize
 *   `I(msg,reason)`     PluginInstallConfigError
 *   `Kt`                pluginDisplayText.sanitizePluginDisplayText
 *   `vt`                pluginDisplayText.sanitizePluginMessageText
 *
 * `V(e,n)` (the "needs configuration before it can start" CLI message) lives in
 * mcpbNeedsConfig.ts (buildNeedsConfigCliMessage) — it is shared with item 13.
 *
 * Known omissions / staged (documented, never invented):
 * - The "first-line-only" value trim the official applies on the SAVE path
 *   (`.split(/\r\n|\r|\n/,1)[0] ?? ""`, then `.trim()`) lives in the
 *   out-of-domain install handler's persistence step (`pje`), not in this
 *   parse/route core; it is noted in the report's staged wiring.
 * - The CLI handler (`pluginInstallHandler`), the `--config <key=value>`
 *   Commander registration (verbatim option text captured in the report), and
 *   the post-install apply (`Pe`) are all out of this module's domain.
 */

import {
  sanitizePluginDisplayText,
  sanitizePluginMessageText,
} from './pluginDisplayText.js'

/** Official `I(message, reason)`: a config-pair error with a machine reason. */
export class PluginInstallConfigError extends Error {
  readonly reason: string

  constructor(message: string, reason: string) {
    super(message)
    this.name = 'PluginInstallConfigError'
    this.reason = reason
  }
}

/** A bundled `.mcpb` server's own `user_config` schema (official bundle entry). */
export interface BundledServerDescriptor {
  readonly serverName: string
  readonly schema: Readonly<Record<string, unknown>>
}

/** Official `s` = `{unreadable, remoteCount}` read-state of bundled servers. */
export interface BundledServerReadState {
  readonly unreadable: ReadonlyArray<string>
  readonly remoteCount: number
}

/** Official `Z` result: plugin-level pairs and per-server bundled pairs. */
export interface RoutedConfigPairs {
  readonly pluginPairs: ReadonlyArray<string>
  readonly bundlePairs: ReadonlyMap<string, ReadonlyArray<string>>
}

/** Official `P(n, singular, plural=singular+"s")`. */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

/**
 * Official `j(e)`: split one `--config` argument at its FIRST `=`. A missing
 * `=` or an empty key is refused.
 *   `--config expects KEY=VALUE, got "${e}". Use --config key=value (repeatable).`
 */
export function parseConfigPair(pair: string): { key: string; raw: string } {
  const at = pair.indexOf('=')
  if (at <= 0) {
    throw new PluginInstallConfigError(
      `--config expects KEY=VALUE, got "${pair}". Use --config key=value (repeatable).`,
      '--config pair has no key',
    )
  }
  return { key: pair.slice(0, at), raw: pair.slice(at + 1) }
}

/**
 * Official `B({unreadable, remoteCount})`: the parenthetical suffix explaining
 * bundled servers whose keys could not be read locally, appended to the
 * bare-key and not-declared refusals. Empty when nothing is unread/remote.
 */
export function buildUnreadRemoteSuffix(
  state: BundledServerReadState,
): string {
  const clauses: string[] = []
  if (state.unreadable.length > 0) {
    clauses.push(
      `the bundled ${state.unreadable
        .map(name => sanitizePluginMessageText(name))
        .join(', ')} could not be read, so its keys are unknown — re-run with --debug-file <path> to log why`,
    )
  }
  if (state.remoteCount > 0) {
    clauses.push(
      `${state.remoteCount} bundled ${pluralize(state.remoteCount, 'server is', 'servers are')} fetched from a URL at session start and can only be configured in Claude Code (/plugin → Installed → Configure)`,
    )
  }
  const joined = clauses.join('; ')
  if (joined === '') return ''
  return ` (${joined[0]?.toUpperCase()}${joined.slice(1)}.)`
}

interface BundleMatch {
  readonly serverName: string
  readonly field: string
  readonly bare: boolean
}

/**
 * Official `Z(e,n,o,s)`: route each `--config` pair either to the plugin's own
 * `userConfig` (kept verbatim) or to a bundled `.mcpb` server's field
 * (`<server>.<key>` explicit, or a bare `<key>` when exactly one readable
 * bundled server declares it). Refuses malformed, ambiguous, bare-key-with-
 * unread-server, and undeclared keys — all byte-exact.
 */
export function routeConfigPairs(
  pairs: ReadonlyArray<string>,
  pluginSchema: Readonly<Record<string, unknown>> | undefined,
  bundles: ReadonlyArray<BundledServerDescriptor>,
  state: BundledServerReadState,
): RoutedConfigPairs {
  const pluginPairs: string[] = []
  const bundlePairs = new Map<string, string[]>()

  for (const pair of pairs) {
    const { key, raw } = parseConfigPair(pair)

    // Plugin-level userConfig key — kept verbatim.
    if (pluginSchema && Object.hasOwn(pluginSchema, key)) {
      pluginPairs.push(pair)
      continue
    }

    // Matches among bundled servers (prefixed and bare), in bundle order.
    const matches: BundleMatch[] = bundles.flatMap(({ serverName, schema }) => {
      const found: BundleMatch[] = []
      const prefix = `${serverName}.`
      if (key.startsWith(prefix) && Object.hasOwn(schema, key.slice(prefix.length))) {
        found.push({ serverName, field: key.slice(prefix.length), bare: false })
      }
      if (Object.hasOwn(schema, key)) {
        found.push({ serverName, field: key, bare: true })
      }
      return found
    })

    const [first, ...rest] = matches
    if (first && rest.length === 0) {
      if (first.bare && state.unreadable.length + state.remoteCount > 0) {
        throw new PluginInstallConfigError(
          `--config key "${key}" must name its server, because a bundled MCP server whose keys are unknown may declare it too; use ${sanitizePluginDisplayText(`${first.serverName}.${first.field}`)}.` +
            buildUnreadRemoteSuffix(state),
          '--config bare key with an unread bundled server',
        )
      }
      const existing = bundlePairs.get(first.serverName) ?? []
      existing.push(`${first.field}=${raw}`)
      bundlePairs.set(first.serverName, existing)
      continue
    }

    if (first) {
      throw new PluginInstallConfigError(
        `--config key "${key}" is declared by more than one bundled MCP server; use ${matches
          .map(match =>
            sanitizePluginDisplayText(`${match.serverName}.${match.field}`),
          )
          .join(' or ')}.`,
        '--config key is ambiguous between bundled servers',
      )
    }

    const knownKeys = [
      ...Object.keys(pluginSchema ?? {}),
      ...bundles.flatMap(({ serverName, schema }) =>
        Object.keys(schema).map(field =>
          sanitizePluginDisplayText(`${serverName}.${field}`),
        ),
      ),
    ]
    throw new PluginInstallConfigError(
      `--config key "${key}" isn't declared in this plugin's userConfig` +
        (bundles.length > 0 ? ' or by its bundled MCP servers.' : '.') +
        (knownKeys.length > 0 ? ` Known keys: ${knownKeys.join(', ')}.` : '') +
        buildUnreadRemoteSuffix(state),
      '--config key is not declared',
    )
  }

  return { pluginPairs, bundlePairs }
}
