/**
 * Option-key safety for plugin option tables (CC 2.1.295 security port).
 *
 * Changelog (2.1.295): "Fixed plugin options named `constructor` or
 * `prototype` always reading as their default and never reloading the plugin
 * when edited."
 *
 * Option tables (settings `pluginConfigs[id].options`, secureStorage
 * `pluginSecrets`, DXT `user_config` values/schemas) are plain objects. An
 * unguarded `table[key]` index read for a key like `constructor`/`prototype`/
 * `toString` hits the Object.prototype member instead of reporting "absent":
 * validation then sees a bogus inherited value, `${user_config.X}` substitution
 * can inject a function's source, and change detection misses the real own
 * value on edit. The official fix is own-property reads at every option-table
 * access plus a hard reject of `__proto__` keys (binary `pge(e){return
 * e!=="__proto__"}`) — assigning `obj[key] = value` with `key === "__proto__"`
 * on a plain object re-points the prototype (prototype pollution).
 */

/** Official `pge` — `__proto__` is never a storable/readable option key. */
export function isStorableOptionKey(key: string): boolean {
  return key !== '__proto__'
}

/**
 * Own-property read for an option table. Returns undefined — never an
 * Object.prototype member — when the table has no own `key`.
 */
export function readOwnOption<T>(
  table: Record<string, T> | null | undefined,
  key: string,
): T | undefined {
  if (table === null || table === undefined) {
    return undefined
  }
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * Copy of an option table with unsafe keys removed — for the LOAD path, where
 * stored JSON may carry a `__proto__` key as an own data property (JSON.parse
 * keeps it inert, but any downstream `obj[key] = value` assignment would
 * re-activate it as a prototype write).
 */
export function withoutUnsafeOptionKeys<T>(
  table: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(table).filter(([key]) => isStorableOptionKey(key)),
  )
}
