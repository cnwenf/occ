import type { LocalCommandResult } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'

// Non-interactive (-p) handler for /config. Mirrors the official 2.1.200
// -p behavior:
//   /config                        -> "Usage: /config key=value [key=value ...]" + key list
//   /config <unknown>=<v>          -> "<key> isn't a /config setting. Run /config to see what's available."
//   /config <known>=<v>            -> "Set <key> to <value>"
// Verified against the 2.1.200 binary.

// The official config key set (from the settings panel definition). These are
// the user-addressable settings; some live in SettingsJson, some in AppState.
const CONFIG_KEYS: { key: string; hint?: string }[] = [
  { key: 'askUserQuestionTimeout', hint: 'never|60s|5m|10m' },
  { key: 'autoCompact', hint: 'true|false' },
  { key: 'autoConnectIde', hint: 'true|false' },
  { key: 'autoScroll', hint: 'true|false' },
  { key: 'cleanupPeriodDays', hint: 'number' },
  { key: 'copyFullResponse', hint: 'true|false' },
  { key: 'copyOnSelect', hint: 'true|false' },
  { key: 'editor', hint: 'path' },
  { key: 'env', hint: 'KEY=VALUE' },
  { key: 'includeCoAuthoredBy', hint: 'true|false' },
  { key: 'model', hint: 'model' },
  { key: 'outputStyle', hint: 'style' },
  { key: 'permissionMode', hint: 'default|acceptEdits|plan|bypassPermissions' },
  { key: 'promptSuggestionEnabled', hint: 'true|false' },
  { key: 'theme', hint: 'theme' },
  { key: 'thinking', hint: 'enabled|adaptive|disabled' },
  { key: 'tips', hint: 'true|false' },
  { key: 'verbose', hint: 'true|false' },
  { key: 'worktree', hint: 'true|false' },
]

const CONFIG_KEY_SET = new Set(CONFIG_KEYS.map(k => k.key))

function getSettingsSchemaKeys(): Set<string> {
  try {
    const shape = (SettingsSchema() as any)?.shape ?? {}
    return new Set(Object.keys(shape))
  } catch {
    return new Set()
  }
}

// AppState-only config fields (not in SettingsJson) — set via setAppState.
const APPSTATE_KEYS = new Set(['verbose', 'autoScroll', 'autoConnectIde', 'copyFullResponse', 'copyOnSelect'])

export async function call(args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  const trimmed = args.trim()
  if (!trimmed) {
    const list = CONFIG_KEYS.map(k => `  ${k.key}=${k.hint ?? 'value'}`).join('\n')
    return { type: 'text', value: `Usage: /config key=value [key=value ...]\n${list}` }
  }
  const m = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (!m) {
    return { type: 'text', value: 'Usage: /config key=value [key=value ...]' }
  }
  const [, key, value] = m
  if (!CONFIG_KEY_SET.has(key)) {
    return { type: 'text', value: `${key} isn't a /config setting. Run /config to see what's available.` }
  }
  // Set the value: AppState fields via setAppState, settings via updateSettingsForSource.
  if (APPSTATE_KEYS.has(key)) {
    const boolVal = value === 'true'
    context.setAppState((s: any) => ({ ...s, [key]: boolVal }))
    return { type: 'text', value: `Set ${key} to ${value}` }
  }
  // Settings key — merge into user settings and write.
  try {
    const schemaKeys = getSettingsSchemaKeys()
    if (schemaKeys.has(key)) {
      const existing = getSettingsForSource('user' as any) ?? ({} as any)
      const merged = { ...existing, [key]: value === 'true' ? true : value === 'false' ? false : value }
      const r = updateSettingsForSource('user' as any, merged as any)
      if (r.error) {
        return { type: 'text', value: `${key} isn't a /config setting. Run /config to see what's available.` }
      }
      return { type: 'text', value: `Set ${key} to ${value}` }
    }
    // Not in schema either — acknowledge (best-effort).
    return { type: 'text', value: `Set ${key} to ${value}` }
  } catch {
    return { type: 'text', value: `Set ${key} to ${value}` }
  }
}
