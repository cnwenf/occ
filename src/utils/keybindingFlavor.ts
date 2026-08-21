import { getInitialSettings } from './settings/settings.js'

/**
 * 2.1.238 `keybindingFlavor`: which conventions the prompt's editing keys
 * follow. `"readline"` matches Bash and other readline programs (Ctrl+W
 * deletes back to the previous whitespace); `"classic"` keeps Claude Code's
 * long-standing behavior (Ctrl+W deletes the previous word).
 *
 * Mirrors the official reader (binary `kKi`), which returns the merged
 * `settings.keybindingFlavor` and falls back to `"classic"` (binary `Arh`).
 * The schema declares `.optional().catch(undefined)`, so any absent or invalid
 * value resolves to the default.
 */
export type KeybindingFlavor = 'classic' | 'readline'

const DEFAULT_KEYBINDING_FLAVOR: KeybindingFlavor = 'classic'

export function getKeybindingFlavor(): KeybindingFlavor {
  // The schema declares `.optional().catch(undefined)`, so merged settings hold
  // `"classic"`, `"readline"`, or `undefined`. Mirror the official hook check
  // (`kKi() === "readline"`): only the exact `"readline"` value enables the
  // readline convention; anything else resolves to the classic default.
  return getInitialSettings().keybindingFlavor === 'readline'
    ? 'readline'
    : DEFAULT_KEYBINDING_FLAVOR
}

export function isReadlineKeybindingFlavor(): boolean {
  return getKeybindingFlavor() === 'readline'
}
