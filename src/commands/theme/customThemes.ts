import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getTheme, type Theme, type ThemeName, THEME_NAMES } from '../../utils/theme.js'

/**
 * Custom named themes loaded from ~/.claude/themes/*.json.
 *
 * File format (matches the official 2.1.200 binary):
 *   { "name": "My Theme", "base": "dark", "overrides": { "claude": "rgb(...)", ... } }
 *
 * A custom theme is referenced in user config by the slug "custom:<name>",
 * where <name> is the JSON filename (minus extension). Selecting it resolves
 * to the base palette with per-key overrides applied.
 */

export const CUSTOM_THEME_PREFIX = 'custom:'

/** Sentinel Select value for the "New custom theme…" entry. */
export const NEW_CUSTOM_THEME_VALUE = '__new_custom_theme__'
export const NEW_CUSTOM_THEME_LABEL = 'New custom theme…'

/** Max theme file size; larger files are skipped (matches official 256KB cap). */
const MAX_THEME_FILE_BYTES = 262_144

export type CustomTheme = {
  /** Raw name (filename without .json). Used inside the "custom:" slug. */
  slug: string
  /** Display name (falls back to slug). */
  name: string
  /** Base palette to override. */
  base: ThemeName
  /** Validated per-key color overrides. */
  overrides: Partial<Theme>
  /** Where the theme came from ("user" for ~/.claude/themes). */
  source: string
}

export function getCustomThemesDir(): string {
  return join(getClaudeConfigHomeDir(), 'themes')
}

export function buildCustomThemeSlug(name: string): string {
  return `${CUSTOM_THEME_PREFIX}${name}`
}

/** Extract the raw name from a "custom:<name>" setting; null if not custom. */
export function parseCustomThemeSlug(slug: string): string | null {
  return slug.startsWith(CUSTOM_THEME_PREFIX) ? slug.slice(CUSTOM_THEME_PREFIX.length) : null
}

/** True if a stored theme setting refers to a custom theme. */
export function isCustomThemeSetting(slug: string): boolean {
  return slug.startsWith(CUSTOM_THEME_PREFIX)
}

function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEME_NAMES as readonly string[]).includes(v)
}

// Custom theme overrides may be rgb(...) strings or ansi: names, matching the
// two color string forms the built-in themes use.
function isColorString(v: unknown): boolean {
  return typeof v === 'string' && (v.startsWith('rgb(') || v.startsWith('ansi:'))
}

/**
 * Accept a user-entered color and normalize it to a form the theme system
 * stores: `rgb(r,g,b)` (from #hex or rgb()) or `ansi:name`. Returns null for
 * anything that isn't a recognizable color. Used by the "New custom theme"
 * creation flow so users can type `#1e1e1e` or `rgb(30,30,30)` interchangeably.
 */
export function normalizeColorInput(raw: string): string | null {
  const v = raw.trim()
  if (v === '') return null
  // ansi:name (16-color form)
  const ansiMatch = v.match(/^ansi:([a-zA-Z]+)$/)
  if (ansiMatch) return `ansi:${ansiMatch[1]!.toLowerCase()}`
  // rgb(r,g,b) — allow optional spaces; clamp 0-255
  const rgbMatch = v.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i)
  if (rgbMatch) {
    const parts = [rgbMatch[1]!, rgbMatch[2]!, rgbMatch[3]!].map(n => {
      const i = parseInt(n, 10)
      return Number.isNaN(i) ? 0 : Math.min(255, Math.max(0, i))
    })
    return `rgb(${parts[0]},${parts[1]},${parts[2]})`
  }
  // #rrggbb
  const hexMatch = v.match(/^#([0-9a-fA-F]{6})$/)
  if (hexMatch) {
    const n = parseInt(hexMatch[1]!, 16)
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
  }
  // #rgb (3-digit)
  const hex3Match = v.match(/^#([0-9a-fA-F]{3})$/)
  if (hex3Match) {
    const s = hex3Match[1]!
    const expand = (c: string) => parseInt(c + c, 16)
    return `rgb(${expand(s[0]!)},${expand(s[1]!)},${expand(s[2]!)})`
  }
  return null
}

/**
 * Parse one custom theme file's content into a {@link CustomTheme}.
 * Returns null for invalid JSON, non-object roots, or empty files. Overrides
 * are filtered to keys that exist on the base palette and look like colors.
 */
export function parseCustomThemeFile(
  name: string,
  content: string,
  source: string,
): CustomTheme | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as { base?: unknown; name?: unknown; overrides?: unknown }
  const base = isThemeName(obj.base) ? obj.base : 'dark'
  const displayName = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : name
  const overrides: Partial<Theme> = {}
  if (typeof obj.overrides === 'object' && obj.overrides !== null && !Array.isArray(obj.overrides)) {
    const baseTheme = getTheme(base)
    for (const [key, val] of Object.entries(obj.overrides)) {
      if (Object.hasOwn(baseTheme, key) && isColorString(val)) {
        ;(overrides as Record<string, string>)[key] = val
      }
    }
  }
  return { slug: name, name: displayName, base, overrides, source }
}

/**
 * Load every custom theme from ~/.claude/themes/*.json, sorted by display
 * name. Returns [] if the directory is missing or unreadable.
 */
export async function loadCustomThemes(): Promise<CustomTheme[]> {
  const dir = getCustomThemesDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const themes: CustomTheme[] = []
  for (const file of entries) {
    if (extname(file) !== '.json') continue
    const full = join(dir, file)
    try {
      if ((await stat(full)).size > MAX_THEME_FILE_BYTES) continue
      const content = await readFile(full, 'utf8')
      const ct = parseCustomThemeFile(basename(file, '.json'), content, 'user')
      if (ct) themes.push(ct)
    } catch {
      // skip unreadable file
    }
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a custom theme to a full palette: base palette + overrides. */
export function resolveCustomTheme(ct: CustomTheme): Theme {
  return { ...getTheme(ct.base), ...ct.overrides }
}

/** Look up a custom theme by its raw slug name. */
export function findCustomTheme(
  themes: readonly CustomTheme[],
  name: string,
): CustomTheme | undefined {
  return themes.find(t => t.slug === name)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
}

/**
 * Persist a custom theme to ~/.claude/themes/<slug>.json. Creates the
 * directory if needed. Used by the "New custom theme" creation flow.
 */
export async function saveCustomTheme(theme: {
  name: string
  base: ThemeName
  overrides: Partial<Theme>
}): Promise<CustomTheme> {
  const dir = getCustomThemesDir()
  await mkdir(dir, { recursive: true })
  const slug = slugify(theme.name)
  await writeFile(join(dir, `${slug}.json`), `${JSON.stringify({
    name: theme.name,
    base: theme.base,
    overrides: theme.overrides,
  }, null, 2)}\n`, 'utf8')
  return { slug, name: theme.name, base: theme.base, overrides: theme.overrides, source: 'user' }
}
