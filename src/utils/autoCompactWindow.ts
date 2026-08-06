/**
 * Auto-compact window — ported from official Claude Code 2.1.221 (OCC-58).
 *
 * Official 2.1.221 SILENTLY added the `--autocompact <auto|tokens>` CLI flag
 * and the `autoCompactWindow` settings key (no changelog entry). Everything
 * below is recovered from the 2.1.223 linux-x64 ELF:
 *
 * - The flag argParser (`Jon`): trim + lowercase; "auto" passes through; an
 *   "m" suffix multiplies by 1e6; a "k" suffix by 1e3; a bare number N with
 *   100 <= N <= 1000 is shorthand for N*1000 ("200" -> 200000); anything
 *   else is taken as a raw token count. The value must be finite and within
 *   [100_000, 1_000_000] or the parse yields undefined (Commander then throws
 *   the byte-identical InvalidArgumentError from main.tsx).
 * - Precedence for the effective window (official `Fju` + `S3`): env
 *   CLAUDE_CODE_AUTO_COMPACT_WINDOW > CLI flag > settings `autoCompactWindow`
 *   > auto. The CLI value "auto" clears a settings override for the session
 *   (`Fju`: undefined -> settings value; "auto" -> undefined; number -> as-is).
 * - The resolved window is capped by the model's context window at the
 *   consumption site (official: `Auto-compact window set to N tokens (capped
 *   to model limit of M)`).
 *
 * The official additionally resolves server-driven windows ("experiment" /
 * "clientdata" sources via the bootstrap `auto_compact_windows` cache) and an
 * "unknown-model" default window — both are Anthropic-backend-bound and stay
 * staged (see docs/upstream-version-gap-occ58.md).
 */
import { getInitialSettings } from './settings/settings.js'

export const AUTO_COMPACT_WINDOW_MIN = 100_000
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000

export type AutoCompactWindowValue = 'auto' | number

// Official `ZHh` (byte-verified): exponent notation must parse to an INTEGER.
const EXPONENT_NOTATION_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/
// Official `W9l` shape (leading pattern byte-verified; grouped-thousands
// layout inferred): comma-separated thousands, e.g. "1,000,000".
const COMMA_SEPARATED_RE = /^[+-]?\d{1,3}(,\d{3})+$/

/**
 * Port of the official bare-number parser `xp` = `eRh(t) ?? parseInt(t, 10)`:
 * exponent notation must yield an integer; comma-grouped numbers are
 * stripped and parseInt'ed; everything else falls through to parseInt
 * (so "200.5" -> 200, matching the official leading-integer semantics).
 */
function parseBareNumber(raw: string): number {
  if (EXPONENT_NOTATION_RE.test(raw)) {
    const value = Number(raw)
    return Number.isInteger(value) ? value : NaN
  }
  if (COMMA_SEPARATED_RE.test(raw)) {
    return parseInt(raw.replace(/,/g, ''), 10)
  }
  return parseInt(raw, 10)
}

/**
 * Port of the official `Jon` argParser (byte-verified from the 2.1.223 ELF).
 * Returns 'auto', a rounded token count, or undefined when unparseable /
 * out of range.
 */
export function parseAutoCompactWindowInput(
  raw: string,
): AutoCompactWindowValue | undefined {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto') {
    return 'auto'
  }

  let tokens: number
  if (normalized.endsWith('m')) {
    tokens = parseFloat(normalized) * 1_000_000
  } else if (normalized.endsWith('k')) {
    tokens = parseFloat(normalized) * 1_000
  } else {
    const parsed = parseBareNumber(normalized)
    // Official shorthand: a bare value in [100, 1000] means thousands
    // ("200" -> 200000, "1000" -> 1000000); anything else is a raw count.
    tokens = parsed >= 100 && parsed <= 1000 ? parsed * 1000 : parsed
  }

  if (
    !Number.isFinite(tokens) ||
    tokens < AUTO_COMPACT_WINDOW_MIN ||
    tokens > AUTO_COMPACT_WINDOW_MAX
  ) {
    return undefined
  }
  return Math.round(tokens)
}

/**
 * Port of the official `Fju` merge: the CLI flag overrides the settings key;
 * the literal CLI value "auto" clears a settings override for this session.
 */
export function resolveAutoCompactWindowOverride(
  cliValue: AutoCompactWindowValue | undefined,
): number | undefined {
  if (cliValue === undefined) {
    const fromSettings = getInitialSettings().autoCompactWindow
    return typeof fromSettings === 'number' ? fromSettings : undefined
  }
  return cliValue === 'auto' ? undefined : cliValue
}

// Session-scoped resolved window (undefined = auto). Set once from main.tsx
// after CLI options are parsed; read by the compaction threshold math in
// services/compact/autoCompact.ts. Mirrors the official flow where the
// bootstrap computes `Fju(options.autocompact, settings.autoCompactWindow)`
// and threads it through the app state / query options.
let sessionAutoCompactWindow: number | undefined

export function setSessionAutoCompactWindow(
  window: number | undefined,
): void {
  sessionAutoCompactWindow = window
}

export function getSessionAutoCompactWindow(): number | undefined {
  return sessionAutoCompactWindow
}
