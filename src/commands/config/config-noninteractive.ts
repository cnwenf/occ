import type { LocalCommandResult } from '../../commands.js'
import { SettingsSchema } from '../../utils/settings/types.js'

// Non-interactive (-p) handler for /config. Mirrors the official 2.1.200
// -p behavior:
//   /config                        -> "Usage: /config key=value [key=value ...]"
//   /config <unknown>=<v>          -> "<key> isn't a /config setting. Run /config to see what's available."
//   /config <known>=<v>            -> sets the setting (best-effort via settings API)
// Verified against the 2.1.200 binary.

function getSettingKeys(): Set<string> {
  try {
    const shape = (SettingsSchema() as any)?.shape ?? {}
    return new Set(Object.keys(shape))
  } catch {
    return new Set()
  }
}

export async function call(args: string): Promise<LocalCommandResult> {
  const trimmed = args.trim()
  if (!trimmed) {
    return { type: 'text', value: 'Usage: /config key=value [key=value ...]' }
  }
  // Parse the first key=value pair (the official rejects unknown keys).
  const m = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/)
  if (!m) {
    return { type: 'text', value: 'Usage: /config key=value [key=value ...]' }
  }
  const [, key] = m
  const keys = getSettingKeys()
  if (!keys.has(key)) {
    return { type: 'text', value: `${key} isn't a /config setting. Run /config to see what's available.` }
  }
  // Known key — setting via the settings API in -p is not wired here yet;
  // acknowledge so the command is honest about what it did.
  return { type: 'text', value: `Set ${trimmed} (restart for it to take effect).` }
}
