import type { LocalCommandResult } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'

// Non-interactive (-p) handler for /config. Mirrors the official 2.1.200
// -p behavior:
//   /config                        -> "Usage: /config key=value [key=value ...]" + key list (sorted)
//   /config <unknown>=<v>          -> "<key> isn't a /config setting. Run /config to see what's available."
//   /config <known>=<v>            -> "Set <Label> to <parsed_value>"
//   /config <boolean_key>=<invalid> -> "<Label> takes true or false, not "<value>""
// Verified against the 2.1.200 binary.

// The official config key set (from the settings panel definition), sorted.
const CONFIG_KEYS: { key: string; hint?: string; label: string }[] = [
  { key: 'askUserQuestionTimeout', hint: 'never|60s|5m|10m', label: 'Ask User Question Timeout' },
  { key: 'autoCompact', hint: 'true|false', label: 'Auto-compact' },
  { key: 'autoConnectIde', hint: 'true|false', label: 'Auto-connect to IDE (external terminal)' },
  { key: 'autoScroll', hint: 'true|false', label: 'Auto-scroll' },
  { key: 'copyFullResponse', hint: 'true|false', label: 'Skip the /copy picker' },
  { key: 'copyOnSelect', hint: 'true|false', label: 'Copy on select' },
  { key: 'editor', hint: 'normal|vim', label: 'Editor mode' },
  { key: 'model', hint: 'model', label: 'Model' },
  { key: 'outputStyle', hint: 'style', label: 'Output style' },
  { key: 'permissionMode', hint: 'default|acceptEdits|plan|bypassPermissions', label: 'Default permission mode' },
  { key: 'promptSuggestionEnabled', hint: 'true|false', label: 'Prompt suggestions' },
  { key: 'reduceMotion', hint: 'true|false', label: 'Reduce motion' },
  { key: 'theme', hint: 'theme', label: 'Theme' },
  { key: 'thinking', hint: 'enabled|adaptive|disabled', label: 'Thinking mode' },
  { key: 'tips', hint: 'true|false', label: 'Show tips' },
  { key: 'verbose', hint: 'true|false', label: 'Verbose output' },
  { key: 'worktreeBaseRef', hint: 'fresh|head', label: 'Worktree base ref' },
  { key: 'terminalProgressBarEnabled', hint: 'true|false', label: 'Terminal progress bar' },
  { key: 'showTurnDuration', hint: 'true|false', label: 'Show turn duration' },
  { key: 'respectGitignore', hint: 'true|false', label: 'Respect .gitignore' },
  { key: 'language', hint: 'language', label: 'Language' },
].sort((a, b) => a.key.localeCompare(b.key))

const CONFIG_KEY_SET = new Set(CONFIG_KEYS.map(k => k.key))

function labelFor(key: string): string {
  return CONFIG_KEYS.find(k => k.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1)
}

// Boolean config keys — accept true/1/on/yes | false/0/off/no, reject others.
const BOOLEAN_KEYS = new Set([
  'autoCompact', 'autoConnectIde', 'autoScroll', 'copyFullResponse', 'copyOnSelect',
  'includeCoAuthoredBy', 'promptSuggestionEnabled', 'reduceMotion', 'tips', 'verbose',
])

// Enum config keys — accept only the listed values.
const ENUM_KEYS: Record<string, string[]> = {
  editor: ['normal', 'vim'],
  thinking: ['enabled', 'adaptive', 'disabled'],
  permissionMode: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  worktreeBaseRef: ['fresh', 'head'],
}

function getSettingsSchemaKeys(): Set<string> {
  try {
    const shape = (SettingsSchema() as any)?.shape ?? {}
    return new Set(Object.keys(shape))
  } catch {
    return new Set()
  }
}

// AppState-only config fields (not in SettingsJson) — set via setAppState.
const APPSTATE_KEYS = new Set(['verbose', 'autoScroll', 'autoConnectIde', 'copyFullResponse', 'copyOnSelect', 'reduceMotion', 'tips'])

function parseBoolean(value: string): { ok: true; val: boolean } | { ok: false; msg: string } {
  const v = value.toLowerCase()
  if (['true', '1', 'on', 'yes'].includes(v)) return { ok: true, val: true }
  if (['false', '0', 'off', 'no'].includes(v)) return { ok: true, val: false }
  return { ok: false, msg: `takes true or false, not "${value}"` }
}

export async function call(args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  const trimmed = args.trim()
  if (!trimmed) {
    // C8: settings list sorted (official does .sort())
    const list = CONFIG_KEYS.map(k => `  ${k.key}=${k.hint ?? 'value'}`).join('\n')
    return { type: 'text', value: `Usage: /config key=value [key=value ...]\n${list}` }
  }

  // C5: single-pair-with-spaces — official treats the last pair's value as
  // everything after the first `=` (spaces allowed in values). Multi-pair
  // only when there are multiple `key=` tokens.
  // Parse: find all key= positions, split there.
  const pairs: { key: string; value: string }[] = []
  const regex = /(\w+)=(?:(?!\w+=).)*/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(trimmed)) !== null) {
    const full = match[0]
    const eqIdx = full.indexOf('=')
    pairs.push({ key: full.slice(0, eqIdx), value: full.slice(eqIdx + 1).trim() })
  }

  if (pairs.length === 0) {
    return { type: 'text', value: `Expected key=value, got "${trimmed}". Run /config to see what's available.` }
  }

  const results: string[] = []
  for (const { key, value } of pairs) {
    if (!CONFIG_KEY_SET.has(key)) {
      return { type: 'text', value: `${key} isn't a /config setting. Run /config to see what's available.` }
    }

    const label = labelFor(key)

    // C2: boolean validation
    if (BOOLEAN_KEYS.has(key)) {
      const parsed = parseBoolean(value)
      if (!parsed.ok) {
        return { type: 'text', value: `${label} ${parsed.msg}` }
      }
      if (APPSTATE_KEYS.has(key)) {
        context.setAppState((s: any) => ({ ...s, [key]: parsed.val }))
      } else {
        try {
          const existing = getSettingsForSource('user' as any) ?? ({} as any)
          updateSettingsForSource('user' as any, { ...existing, [key]: parsed.val } as any)
        } catch {}
      }
      // C1: emit parsed value (true/false), not raw input
      results.push(`Set ${label} to ${parsed.val}`)
      continue
    }

    // C3: enum validation
    if (ENUM_KEYS[key]) {
      if (!ENUM_KEYS[key].includes(value)) {
        return { type: 'text', value: `${label} takes ${ENUM_KEYS[key].join('|')}, not "${value}"` }
      }
    }

    // Settings key — merge into user settings and write.
    try {
      const schemaKeys = getSettingsSchemaKeys()
      if (schemaKeys.has(key)) {
        const existing = getSettingsForSource('user' as any) ?? ({} as any)
        const r = updateSettingsForSource('user' as any, { ...existing, [key]: value } as any)
        if (r.error) {
          return { type: 'text', value: `Couldn't save ${label}: ${r.error.message}` }
        }
      } else if (APPSTATE_KEYS.has(key)) {
        context.setAppState((s: any) => ({ ...s, [key]: value }))
      }
    } catch {}
    // C1: emit the value as-is for non-boolean
    results.push(`Set ${label} to ${value}`)
  }
  return { type: 'text', value: results.join('\n') }
}
